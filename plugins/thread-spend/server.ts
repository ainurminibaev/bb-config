import { resolve } from "node:path";
import { cliCommand, defineCli, PluginCliError, type BbPluginApi } from "@get-bb/plugin-sdk";
import { readHistory } from "./history.ts";
import { metricArchive } from "./archive.ts";
import { contract, detailInput, listInput, sorts } from "./contract.ts";
import { limiter, readService } from "./reads.ts";

const json = { type: "boolean", description: "Emit JSON" } as const;
const days = { type: "integer", min: 1, max: 30, description: "Rolling period in days (1–30)" } as const;
const limit = { type: "integer", min: 1, max: 100, description: "Maximum rows (1–100)" } as const;
const sort = { type: "enum", values: sorts, description: "Sort descending by tokens, processing time or context" } as const;
const bounded = (signal?: AbortSignal) => AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(45_000)]);
const tokenCount = new Intl.NumberFormat("en-US");
const display = (value: number | null | undefined) => value == null ? "—" : tokenCount.format(value);

function output(value: unknown, human: string, machine: boolean | undefined) {
  return { exitCode: 0, stdout: (machine ? JSON.stringify(value) : human) + "\n" };
}

const optionError = () => new PluginCliError("Use an integer from 1–30 for --days and from 1–100 for --limit.", {
  code: "invalid_range",
});

export function registerCommands(bb: Pick<BbPluginApi, "cli">, reads: ReturnType<typeof readService>) {
  bb.cli.register(defineCli({
    name: "thread-spend",
    summary: "Read local BB thread usage and timing",
    commands: {
      threads: cliCommand({
        summary: "List threads ranked by usage",
        options: { days, limit, sort, json, active: { type: "boolean", description: "Include only starting or active threads" },
          provider: { type: "string", description: "Filter by provider ID" } },
        async run({ options }, { signal }) {
          const parsed = listInput.safeParse({
            days: options.days, limit: options.limit, sort: options.sort, active: options.active, provider: options.provider,
          });
          if (!parsed.success) throw optionError();
          const result = await reads.threads(parsed.data, bounded(signal));
          const header = `${result.matched} matching, ${result.scanned} scanned, ${result.failed} failed${result.listLimited ? " (list limit reached)" : ""}.`;
          const lines = result.rows.map(row => [
            row.id, row.providerId, display(row.tokens?.total),
            display(row.processingMs), display(row.context?.used),
            `${row.turnsWithTokens}/${row.turns}`, row.title.replace(/[\u0000-\u001f\u007f]/g, " "),
          ].join("\t"));
          return output(result, [header, "Thread\tProvider\tTokens\tTime (ms)\tContext\tCoverage\tTitle", ...lines].join("\n"), options.json);
        },
      }),
      thread: cliCommand({
        summary: "Show one thread and its recorded turns",
        positionals: [{ name: "id", description: "BB thread ID (defaults to the current thread)" }],
        options: { days, limit, sort, json },
        async run({ options, positionals }, { signal, threadId }) {
          const id = positionals.id ?? threadId;
          if (!id) throw new PluginCliError("Pass a thread ID.", { code: "thread_required" });
          const parsed = detailInput.safeParse({ threadId: id, days: options.days, limit: options.limit, sort: options.sort });
          if (!parsed.success) throw optionError();
          const result = await reads.detail(parsed.data, bounded(signal));
          const { row } = result;
          const totals = `Tokens: ${display(row.tokens?.total)} · turns with tokens: ${row.turnsWithTokens}/${row.turns} · lower bounds: ${row.lowerBoundTurns}${row.readLimited ? " · read limit reached" : ""}`;
          const lines = result.turns.map(turn => [
            new Date(turn.at).toISOString(), turn.id, display(turn.tokens?.total),
            display(turn.durationMs), display(turn.context?.used), turn.tokenQuality,
          ].join("\t"));
          return output(result, [totals, "Time\tTurn\tTokens\tTime (ms)\tContext\tQuality", ...lines].join("\n"), options.json);
        },
      }),
      commands: cliCommand({
        summary: "Show the availability of shell timing",
        options: { json },
        async run({ options }) {
          const reason = "BB has no content-free command timing endpoint. Turn elapsed time is available via thread.";
          return output({ available: false, reason }, reason, options.json);
        },
      }),
      "usage-limits": cliCommand({
        summary: "Show BB provider account quota windows",
        options: { json },
        async run({ options }, { signal }) {
          const result = await reads.usageLimits(bounded(signal));
          const lines = Object.entries(result).flatMap(([provider, usage]) => usage.windows.length
            ? usage.windows.map(window => `${provider}\t${window.label}\t${window.usedPercent}%\t${window.resetsAt ?? "—"}`)
            : [`${provider}\t${usage.status}`]);
          return output(result, lines.length ? lines.join("\n") : "No provider quotas reported.", options.json);
        },
      }),
    },
  }));
}

export default function threadSpend(bb: BbPluginApi) {
  const sdkRead = limiter(4);
  const archive = metricArchive(bb, sdkRead);
  const reads = readService(bb.sdk, archive, sdkRead);

  bb.rpc.register(contract, {
    health: () => ({ ok: true as const }),
    archived: async ({ days }) => {
      const { plugins } = await bb.sdk.plugins.list();
      const source = plugins.find(plugin => plugin.id === bb.pluginId && plugin.source.startsWith("path:"));
      return source ? readHistory(days, resolve(source.rootDir, "../../.local/docs/thread-spend-history.json")) : null;
    },
    summary: ({ threadId }, ctx) => reads.summary(threadId, bounded(ctx.experimental_signal)),
    threads: (input, ctx) => reads.threads(input, bounded(ctx.experimental_signal)),
    thread: (input, ctx) => reads.detail(input, bounded(ctx.experimental_signal)),
    usage_limits: (_input, ctx) => reads.usageLimits(bounded(ctx.experimental_signal)),
  }, { experimental_discoverable: true, experimental_description: "Local BB thread token and turn metrics" });

  registerCommands(bb, reads);
}
