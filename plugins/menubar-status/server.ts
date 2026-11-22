// bb-plugin-menubar-status — backend only.
//
// Writes a small JSON summary of the agents (who needs you, who is running,
// last reply), their conversations and the account usage to files on one
// machine, and picks up the replies the panel there leaves in an outbox. The
// menu bar app and panel only read local files: no network call and no
// credentials on that machine, so they are instant.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { buildFeed, chatFromEvents, describeActivity, oneLine, sameContent, statusFile, type Feed, type FeedThread } from "./feed.ts";

const message = z.object({ role: z.enum(["user", "agent", "thread"]), text: z.string(), at: z.number() });
// The same data the panel reads from files, for the CLI and diagnostics.
export const rpcContract = defineRpcContract({
  chat: {
    input: z.object({ threadId: z.string().min(1).max(100) }),
    output: z.object({
      title: z.string(), status: z.string(), activity: z.string(),
      pending: z.boolean(),
      /** The thread (this one or a subagent) whose question or approval waits. */
      pendingThreadId: z.string().nullable(),
      messages: z.array(message),
    }),
  },
  send: {
    input: z.object({ threadId: z.string().min(1).max(100), text: z.string().min(1).max(20_000) }),
    output: z.object({ delivery: z.string() }),
  },
});

const SNIPPETS_KEY = "snippets-v3";
const DEBOUNCE_MS = 1200;
/** Rewrites an unchanged feed this often, so the widget can tell it is alive. */
const HEARTBEAT_MS = 60_000;
const POLL_MS = 20_000;
const ACTIVE_POLL_MS = 4_000;
const OUTBOX_MS = 1_500;

/**
 * As Thread Account Usage classifies them: a per-model limit (e.g. "Fable",
 * reported as a weekly window) is not the account's weekly limit.
 */
export function windowKind(label: string, kind?: string): "five-hour" | "weekly" | "model" | "other" {
  if (/fable|opus|sonnet|haiku|mythos/i.test(label)) return "model";
  if (kind === "five-hour" || /5.?hour|five.?hour|current session/i.test(label)) return "five-hour";
  if (kind === "weekly" || /week|7.?day|seven.?day/i.test(label)) return "weekly";
  return "other";
}
const USAGE_MS = 120_000;

export default async function menubarStatus(bb: BbPluginApi) {
  const settings = bb.settings.define({
    hostId: { type: "string", label: "Machine that shows the menu bar or tray widget (host ID)", default: "" },
    filePath: { type: "string", label: "Absolute path of the status file on that machine (/… or C:\\…)", default: "" },
    webUrl: { type: "string", label: "Public BB address for links (optional)", default: "" },
    maxItems: { type: "string", label: "How many agents to list", default: "12" },
  });

  let snippets: Record<string, string> =
    (await bb.storage.kv.get<Record<string, string>>(SNIPPETS_KEY)) ?? {};
  let last: Feed | null = null;
  let lastWriteAt = 0;
  let madeDirFor = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let again = false;

  async function listThreads(args: Record<string, unknown>): Promise<FeedThread[]> {
    const result = (await bb.sdk.threads.list({ archived: false, limit: 200, ...args } as never)) as unknown;
    const rows = Array.isArray(result) ? result : ((result as { threads?: unknown[] }).threads ?? []);
    return rows as FeedThread[];
  }

  async function activityOf(threadId: string): Promise<string> {
    try {
      const events = (await bb.sdk.threads.events.list({
        threadId, types: ["item/started"], order: "desc", limit: "1",
      })) as unknown as { data: { item?: unknown } }[];
      return describeActivity(events[0]?.data.item as never);
    } catch {
      return "";
    }
  }
  async function compute(): Promise<Feed> {
    const { webUrl, maxItems } = await settings.get();
    const [threads, projects, hosts] = await Promise.all([
      listThreads({}),
      bb.sdk.projects.list({ includePersonal: true } as never),
      bb.sdk.hosts.list(),
    ]);
    const machineNames = new Map<string, string>();
    await Promise.all(
      hosts
        .filter((host) => host.type === "persistent")
        .map(async (host) => {
          for (const thread of await listThreads({ hostId: host.id })) {
            machineNames.set(thread.id, host.name);
          }
        }),
    );
    const activities: Record<string, string> = {};
    await Promise.all(
      threads
        .filter((thread) => thread.status === "active" && !thread.hasPendingInteraction)
        .map(async (thread) => {
          activities[thread.id] = await activityOf(thread.id);
        }),
    );
    const alive = new Set(threads.map((thread) => thread.id));
    for (const id of Object.keys(snippets)) if (!alive.has(id)) delete snippets[id];
    const build = () =>
      buildFeed({
      threads,
      projectNames: new Map(
        (projects as { id: string; name: string; kind?: string }[]).map((project) => [
          project.id,
          project.kind === "personal" ? "" : project.name,
        ]),
      ),
      machineNames,
      snippets,
      activities,
      webUrl,
      maxItems: Math.min(20, Math.max(1, Number.parseInt(maxItems, 10) || 12)),
        now: Date.now(),
      });
    // Replies from before this plugin was installed: read them once.
    const missing = build().items.filter(
      (item) => !item.snippet && item.state !== "running" && !(item.id in snippets),
    );
    if (missing.length > 0) {
      await Promise.all(
        missing.map(async (item) => {
          try {
            const { output } = await bb.sdk.threads.output({ threadId: item.id });
            snippets[item.id] = oneLine(output);
          } catch {
            snippets[item.id] = "";
          }
        }),
      );
      void bb.storage.kv.set(SNIPPETS_KEY, snippets);
    }
    return build();
  }

  async function publish(): Promise<void> {
    const { hostId, filePath: configured } = await settings.get();
    const filePath = statusFile(configured);
    if (!hostId || !filePath) {
      bb.status.needsConfiguration(
        "Set the machine (host ID) and an absolute status file path in Menubar Status settings.",
      );
      return;
    }
    const feed = await compute();
    if (sameContent(last, feed) && Date.now() - lastWriteAt < HEARTBEAT_MS) return;
    const dir = filePath.slice(0, filePath.lastIndexOf("/"));
    if (madeDirFor !== `${hostId}:${dir}`) {
      await bb.sdk.files.mkdir({ hostId, path: dir, recursive: true });
      madeDirFor = `${hostId}:${dir}`;
    }
    await bb.sdk.files.write({ hostId, path: filePath, content: `${JSON.stringify(feed)}\n` });
    last = feed;
    lastWriteAt = Date.now();
  }

  /**
   * Everything the Mac panel needs is written there by this plugin, and what
   * it asks for is read back from there: the Mac never calls bb. (Its CLI
   * may not be allowed to reach the server, and a call per hover is slow.)
   *
   * - chats/<thread>.json: the conversation of each listed thread, rewritten
   *   when that thread changes, so hovering a thread shows it instantly;
   * - usage.json: account limits, every two minutes;
   * - outbox/*.json: replies and "open in bb" requests from the panel.
   */
  const chatSignatures = new Map<string, string>();
  // Threads the panel currently shows: the only ones a panel request may reach.
  let panelThreads = new Set<string>();
  async function syncChats(feed: Feed, hostId: string, dir: string): Promise<void> {
    if (madeDirFor !== `${hostId}:${dir}:chats`) {
      await bb.sdk.files.mkdir({ hostId, path: `${dir}/chats`, recursive: true });
      await bb.sdk.files.mkdir({ hostId, path: `${dir}/outbox`, recursive: true });
      madeDirFor = `${hostId}:${dir}:chats`;
    }
    const listed = new Set(feed.items.map((item) => item.id));
    panelThreads = listed;
    await Promise.all(feed.items.map(async (item) => {
      const signature = `${item.updatedAt}|${item.state}|${item.activity}`;
      if (chatSignatures.get(item.id) === signature) return;
      try {
        const chat = await chatOf(item.id);
        await bb.sdk.files.write({ hostId, path: `${dir}/chats/${item.id}.json`, content: JSON.stringify(chat) });
        chatSignatures.set(item.id, signature);
      } catch (error) {
        bb.log.warn(`chat ${item.id} not written: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
    for (const id of [...chatSignatures.keys()]) {
      if (listed.has(id)) continue;
      chatSignatures.delete(id);
      void bb.sdk.files.remove({ hostId, path: `${dir}/chats/${id}.json` } as never).catch(() => {});
    }
  }

  async function target(): Promise<{ hostId: string; dir: string } | null> {
    const settled = await settings.get();
    const filePath = statusFile(settled.filePath);
    if (!settled.hostId || !filePath) return null;
    return { hostId: settled.hostId, dir: filePath.slice(0, filePath.lastIndexOf("/")) };
  }

  let outboxBusy = false;
  async function processOutbox(): Promise<void> {
    const where = await target();
    if (!where || outboxBusy || madeDirFor !== `${where.hostId}:${where.dir}:chats`) return;
    outboxBusy = true;
    try {
      const listing = (await bb.sdk.files.list({ hostId: where.hostId, path: `${where.dir}/outbox`, limit: 50 })) as unknown as
        { files?: { path: string }[] };
      for (const file of (listing.files ?? []).filter((f) => f.path.endsWith(".json"))) {
        const path = `${where.dir}/outbox/${file.path.split(/[\\/]/).at(-1)}`;
        let request: { action?: string; thread?: string; text?: string } = {};
        try {
          const read = (await bb.sdk.files.read({ hostId: where.hostId, path } as never)) as { content?: string };
          request = JSON.parse(read.content ?? "{}");
        } catch {
          // Half-written or unreadable: drop it below.
        }
        // Remove first: a request must never run twice.
        await bb.sdk.files.remove({ hostId: where.hostId, path } as never).catch(() => {});
        const threadId = String(request.thread ?? "");
        if (!/^thr_[A-Za-z0-9]{4,40}$/.test(threadId)) continue;
        try {
          // The token holder (the panel) acts only on the threads it was shown, never on any thread id.
          if (!panelThreads.has(threadId)) throw new Error("тред больше не показан в панели — откройте его в BB");
          if (request.action === "send" && request.text?.trim()) {
            await sendTo(threadId, request.text.trim().slice(0, 20_000));
          } else if (request.action === "open") {
            await bb.sdk.threads.open({ threadId, file: null } as never);
          }
        } catch (error) {
          bb.log.warn(`panel request failed: ${error instanceof Error ? error.message : String(error)}`);
          await bb.sdk.files.write({
            hostId: where.hostId, path: `${where.dir}/errors.json`,
            content: JSON.stringify({ thread: threadId, action: request.action, at: Date.now(),
              error: error instanceof Error ? error.message : String(error) }),
          }).catch(() => {});
        }
      }
    } catch {
      // The machine may be offline; the next tick retries.
    } finally {
      outboxBusy = false;
    }
  }

  /**
   * Account limits, one entry per account (no e-mails written). Taken from
   * Thread Account Usage when it runs, so the panel matches bb's own
   * indicators, including the plan and Codex's available limit resets;
   * otherwise read directly from each machine.
   */
  async function syncUsage(): Promise<void> {
    const where = await target();
    if (!where) return;
    type Row = { provider: string; hosts: string[]; plan: string | null; status: string; resets: number | null;
      windows: { label: string; kind: string; usedPercent: number; resetsAt: string | null }[] };
    let rows: Row[] | null = null;
    try {
      const result = await bb.sdk.plugins.callRpc({
        pluginId: "thread-account-usage", method: "accounts", input: { refresh: false },
        outputSchema: z.object({ accounts: z.array(z.object({
          providerId: z.string(), hostNames: z.array(z.string()), plan: z.string().nullable(), status: z.string(),
          resetCount: z.number().nullable().optional(),
          windows: z.array(z.object({ label: z.string(), kind: z.string(), usedPercent: z.number(), resetsAt: z.string().nullable() })),
        }).passthrough()) }).passthrough(),
        signal: AbortSignal.timeout(30_000),
      } as never) as { accounts: { providerId: string; hostNames: string[]; plan: string | null; status: string;
        resetCount?: number | null; windows: Row["windows"] }[] };
      rows = result.accounts.filter((a) => a.windows.length).map((a) => ({
        provider: a.providerId, hosts: a.hostNames, plan: a.plan, status: a.status, resets: a.resetCount ?? null,
        windows: a.windows.map((w) => ({ ...w, kind: windowKind(w.label, w.kind) })),
      }));
    } catch {
      // Not installed or not answering: read the machines directly.
    }
    if (!rows) rows = await usageFromHosts();
    await bb.sdk.files.write({
      hostId: where.hostId, path: `${where.dir}/usage.json`,
      content: JSON.stringify({ accounts: rows, available: true, at: Date.now() }),
    });
  }

  async function usageFromHosts() {
    const hosts = (await bb.sdk.hosts.list()).filter((host) => host.type === "persistent");
    const accounts = new Map<string, { provider: string; hosts: string[]; plan: string | null; status: string;
      resets: number | null; windows: { label: string; kind: string; usedPercent: number; resetsAt: string | null }[] }>();
    await Promise.all(hosts.map(async (host) => {
      try {
        const raw = (await bb.sdk.system.usageLimits({ hostId: host.id, signal: AbortSignal.timeout(20_000) })) as unknown as
          Record<string, { status?: string; accountEmail?: string; planLabel?: string;
            windows?: { label?: string; kind?: string; usedPercent?: number; resetsAt?: string }[] }>;
        for (const provider of ["claude-code", "codex"]) {
          const usage = raw[provider];
          if (!usage || usage.status !== "ok" || !usage.windows?.length) continue;
          const key = `${provider}:${usage.accountEmail ?? host.id}`;
          const known = accounts.get(key);
          if (known) { known.hosts.push(host.name); continue; }
          accounts.set(key, {
            provider, hosts: [host.name], plan: usage.planLabel ?? null, status: "ok", resets: null,
            windows: usage.windows.flatMap((w) => typeof w.usedPercent === "number" && w.label ? [{
              label: w.label,
              kind: windowKind(w.label, w.kind),
              usedPercent: w.usedPercent, resetsAt: w.resetsAt ?? null,
            }] : []),
          });
        }
      } catch {
        // An offline machine just has no row.
      }
    }));
    return [...accounts.values()];
  }


  function run(): void {
    if (running) {
      again = true;
      return;
    }
    running = publish()
      .then(async () => {
        const where = await target();
        if (last && where) await syncChats(last, where.hostId, where.dir);
      })
      .catch((error) => {
        // The machine may be asleep or offline: the next event or poll retries.
        bb.log.warn(`status file not written: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        running = null;
        if (again) {
          again = false;
          schedule();
        }
      });
  }

  function schedule(): void {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      run();
    }, DEBOUNCE_MS);
  }

  for (const event of [
    "thread.created",
    "thread.active",
    "thread.failed",
    "thread.archived",
    "thread.unarchived",
    "thread.deleted",
    "interaction.pending",
    "experimental_thread.read",
  ] as const) {
    bb.events.on(event as never, schedule as never);
  }
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    const text = oneLine(lastAssistantText);
    if (text) {
      snippets[thread.id] = text;
      void bb.storage.kv.set(SNIPPETS_KEY, snippets);
    }
    schedule();
  });
  settings.onChange(() => {
    last = null;
    madeDirFor = "";
    chatSignatures.clear();
    schedule();
  });

  let lastPollAt = 0;
  // Resolved interactions and renames have no event of their own. While an
  // agent works, poll faster so its current step stays fresh.
  const poll = setInterval(() => {
    if (Date.now() - lastPollAt >= (last?.counts.running ? ACTIVE_POLL_MS : POLL_MS)) {
      lastPollAt = Date.now();
      schedule();
    }
  }, ACTIVE_POLL_MS);
  const outbox = setInterval(() => void processOutbox(), OUTBOX_MS);
  const usageTimer = setInterval(() => void syncUsage().catch(() => {}), USAGE_MS);
  setTimeout(() => void syncUsage().catch(() => {}), 5_000);
  // Earlier versions ran the helper in a bb terminal on the Mac.
  const oldHelper = await bb.storage.kv.get<string>("helper-terminal");
  if (oldHelper) {
    void bb.sdk.terminals.close({ terminalId: oldHelper, mode: "force" } as never).catch(() => {});
    void bb.storage.kv.set("helper-terminal", null as never);
  }
  bb.onDispose(() => {
    clearInterval(poll);
    clearInterval(outbox);
    clearInterval(usageTimer);
    if (timer) clearTimeout(timer);
  });

  async function chatOf(threadId: string) {
      const thread = (await bb.sdk.threads.get({ threadId })) as unknown as FeedThread;
      // Newest first, a page at a time (bb caps a page at 100), until enough
      // conversation is collected; tool steps make up most events.
      type Row = { seq: number | string; type: string; createdAt: number; data: Record<string, unknown> };
      const events: Row[] = [];
      let before: string | undefined;
      for (let page = 0; page < 8; page += 1) {
        const rows = (await bb.sdk.threads.events.list({
          threadId, types: ["client/turn/requested", "item/completed"], order: "desc", limit: "100",
          ...(before ? { beforeSeq: before } : {}),
        })) as unknown as Row[];
        events.push(...rows);
        if (rows.length < 100 || chatFromEvents([...events].reverse()).length >= 30) break;
        before = String(rows.at(-1)!.seq);
      }
      // Subagents count as the thread's own state, as in the list.
      const subagents: FeedThread[] = [];
      let level = [threadId];
      for (let depth = 0; depth < 3 && level.length; depth += 1) {
        const children = (await Promise.all(level.map((parentThreadId) => listThreads({ parentThreadId })))).flat();
        subagents.push(...children);
        level = children.map((child) => child.id);
      }
      const waiting = thread.hasPendingInteraction ? thread : subagents.find((child) => child.hasPendingInteraction);
      const working = thread.status === "active" ? null : subagents.find((child) => child.status === "active");
      const status = thread.status === "active" || working ? "active" : thread.status;
      const activity = thread.status === "active"
        ? await activityOf(threadId)
        : working ? `Субагент: ${await activityOf(working.id)}` : "";
      return {
        title: oneLine(thread.title, 80) || oneLine(thread.titleFallback, 80) || "Без названия",
        status,
        activity,
        pending: Boolean(waiting),
        pendingThreadId: waiting?.id ?? null,
        messages: chatFromEvents([...events].reverse()),
      };
    }
  async function sendTo(threadId: string, text: string) {
    // "auto": steer a live turn, otherwise start one, as bb's own composer does.
    const result = (await bb.sdk.threads.send({
      threadId, mode: "auto", input: [{ type: "text", text, mentions: [] }],
    } as never)) as { delivery?: string };
    schedule();
    return { delivery: result.delivery ?? "sent" };
  }
  bb.rpc.register(rpcContract, {
    chat: ({ threadId }) => chatOf(threadId),
    send: ({ threadId, text }) => sendTo(threadId, text),
  });
  bb.cli.register({
    name: bb.pluginId,
    summary: "Agent status file for the menu bar widget",
    commands: [
      { name: "show", summary: "Print the current status feed", usage: "show" },
      { name: "sync", summary: "Write the status file now", usage: "sync" },
    ],
    async run(argv) {
      const [command] = argv;
      if (command === "sync") {
        last = null;
        await publish();
        const { hostId, filePath } = await settings.get();
        return { exitCode: 0, stdout: last ? `Written to ${hostId}:${filePath}\n` : "Not configured\n" };
      }
      if (command === "show" || command === undefined) {
        return { exitCode: 0, stdout: `${JSON.stringify(await compute(), null, 2)}\n` };
      }
      return { exitCode: 2, stderr: `Usage: bb ${bb.pluginId} show | sync\n` };
    },
  });

  schedule();
}
