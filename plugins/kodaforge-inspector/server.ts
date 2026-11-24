import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { LAYOUTS, followsReleases, effectiveLayout, layoutOf } from "./inspector";
const report = z.object({
  state: z.enum(["compatible", "incompatible", "waiting"]),
  reason: z.string().max(300),
});
const layout = z.enum(LAYOUTS);
export const rpcContract = defineRpcContract({
  config: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({ layout }),
  },
  choose: {
    input: z.object({
      threadId: z.string().min(1),
      layout: z.enum(["native", "center"]),
      scope: z.enum(["project", "all"]),
    }),
    output: z.object({ layout }),
  },
  report: { input: report, output: z.object({ ok: z.boolean() }) },
});
export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    layout: {
      type: "select",
      label: "Вид редактора диалога в KodaForge для всех проектов",
      description:
        "Действует в проектах без собственного выбора. «Спросить» показывает выбор с примерами при первом открытии редактора в каждом проекте; до выбора вид штатный. Кнопка «Сохранить для всех» в окне выбора записывает значение сюда и сбрасывает выбор отдельных проектов.",
      options: [...LAYOUTS],
      experimental_optionLabels: {
        ask: "Спросить при открытии",
        native: "Штатный: код по центру, чат справа",
        center: "Чат по центру, код по вкладке",
      },
      default: "ask",
    },
    autoOpen: {
      type: "boolean",
      label: "Открывать выбранный диалог сразу в KodaForge",
      default: false,
    },
    autoOpenThread: {
      type: "string",
      label: "ID диалога для автооткрытия (thr_… из адреса диалога BB)",
      default: "",
    },
  });
  const PROJECT_KEY = "project-layout:";
  async function resolve(threadId: string) {
    const { projectId } = await bb.sdk.threads.get({ threadId });
    return effectiveLayout(
      await bb.storage.kv.get(PROJECT_KEY + projectId),
      (await settings.get()).layout,
    );
  }
  bb.rpc.register(rpcContract, {
    config: async ({ threadId }) => ({ layout: await resolve(threadId) }),
    choose: async (value) => {
      if (value.scope === "all") {
        // For all: one stored value, and no project keeps an older choice of its own.
        for (const key of await bb.storage.kv.list(PROJECT_KEY))
          await bb.storage.kv.delete(key);
        await settings.experimental_set({ layout: value.layout });
      } else {
        const { projectId } = await bb.sdk.threads.get({ threadId: value.threadId });
        await bb.storage.kv.set(PROJECT_KEY + projectId, value.layout);
      }
      bb.realtime.publish("layout", {});
      return { layout: await resolve(value.threadId) };
    },
    report: async (value) => {
      await bb.storage.kv.set("last-inspection", {
        ...value,
        at: new Date().toISOString(),
      });
      return { ok: true };
    },
  });
  settings.onChange(() => bb.realtime.publish("layout", {}));
  bb.cli.register({
    name: "kodaforge-inspector",
    summary: "Проверка источника обновлений и независимого слоя интерфейса",
    commands: [
      {
        name: "status",
        summary: "Источник KodaForge и последняя проверка браузера",
        usage: "bb kodaforge-inspector status",
      },
    ],
    async run(argv) {
      if (argv.length && argv[0] !== "status")
        return {
          exitCode: 1,
          stderr: "Команда: bb kodaforge-inspector status",
        };
      let source: unknown;
      let tracking = false;
      try {
        const result = await promisify(execFile)(
          process.env.BB_CLI || "bb",
          ["plugin", "source", "kodaforge", "--json"],
          { timeout: 15000, maxBuffer: 64000 },
        );
        source = JSON.parse(result.stdout);
        tracking = followsReleases((source as { requested?: string }).requested);
      } catch (e) {
        source = { error: e instanceof Error ? e.message : String(e) };
      }
      const config = await settings.get();
      const result = {
        layout: layoutOf(config.layout),
        autoOpen: config.autoOpen,
        autoOpenThread: config.autoOpenThread,
        projectChoices: (await bb.storage.kv.list(PROJECT_KEY)).length,
        upstreamTracking: tracking,
        source,
        browser: await bb.storage.kv.get("last-inspection"),
        update:
          "BB проверяет обновления; установка — кнопкой Update или bb plugin update kodaforge --yes. Инспектор применяется при загрузке совместимого интерфейса.",
        restore: "bb plugin config kodaforge-inspector set layout native",
      };
      return {
        exitCode: tracking ? 0 : 1,
        stdout: JSON.stringify(result, null, 2),
      };
    },
  });
}
