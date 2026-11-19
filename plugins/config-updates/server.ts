import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { buildPrompt, newerThan, parseRepository, stableReleases, type LocalStatus, type Release } from "./releases.ts";

const run = promisify(execFile);
const ReleaseSchema = z.object({ tag: z.string(), title: z.string(), notes: z.string(), url: z.string(), publishedAt: z.string() });
const StatusSchema = z.object({
  /** Last attempt, successful or not (ms). 0 = never checked. */
  checkedAt: z.number(),
  /** Last attempt that reached GitHub and read the journal (ms). */
  okAt: z.number(),
  /** Why the last attempt failed. A failed check says nothing about updates. */
  error: z.string().nullable(),
  repository: z.string(),
  installed: z.string().nullable(),
  /** When the installed version was recorded in the journal (ISO), if known. */
  installedAt: z.string().nullable().default(null),
  /** The installed release was accepted without an agent: nothing had to be applied. */
  installedAuto: z.boolean().default(false),
  /** Unfinished steps of a previous run; the update stays available. */
  remaining: z.number(),
  dependencyIssues: z.array(z.string()).default([]),
  /** Thread owning an open update run, if any. */
  runOwner: z.string().nullable(),
  /** Release the open run is applying. */
  runRelease: z.string().nullable().default(null),
  /** Releases newer than the installed one, oldest first; the last is the target. */
  pending: z.array(ReleaseSchema),
  /** Commit the target tag pointed at when checked. */
  commit: z.string().nullable(),
  threadId: z.string().nullable(),
  /** When that thread was started from the CLI (ms). */
  threadAt: z.number().default(0),
  /** Thread that ran the last finished update, from the journal. */
  lastRunOwner: z.string().nullable().default(null),
});
export type UpdateStatus = z.infer<typeof StatusSchema>;
const StartSchema = z.object({ threadId: z.string(), existing: z.boolean(), tag: z.string() });
/** Either the thread already applying the update, or what to put on the new-thread screen. */
const ComposeSchema = z.object({ tag: z.string(), threadId: z.string().nullable(), projectId: z.string().nullable(),
  hostId: z.string().nullable(), prompt: z.string().nullable() });
export const rpcContract = defineRpcContract({
  status: { input: z.null(), output: StatusSchema },
  check: { input: z.null(), output: StatusSchema },
  compose: { input: z.null(), output: ComposeSchema },
});

const EMPTY: UpdateStatus = { checkedAt: 0, okAt: 0, error: null, repository: "", installed: null, installedAt: null, installedAuto: false, remaining: 0, dependencyIssues: [],
  runOwner: null, runRelease: null, pending: [], commit: null, threadId: null, threadAt: 0, lastRunOwner: null };
const STALE_MS = 6 * 3_600_000;
const SHA = /^[0-9a-f]{40}$/;
const NOTES_FOR = 5;
const START_WINDOW_MS = 15 * 60_000;
/** bb's key of this plugin's sidebar footer item (`plugin:<plugin id>/<item id>`). */
const FOOTER_KEY = "plugin:config-updates/updates";

/** Checkout root: the plugin runs from <checkout>/plugins/config-updates (or its dist/). */
function findRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 4; depth += 1, directory = dirname(directory)) {
    if (existsSync(resolve(directory, "scripts/updates.py")) && existsSync(resolve(directory, ".git"))) return realpathSync(directory);
  }
  throw new Error("Рядом с плагином нет checkout с scripts/updates.py. Из постоянной рабочей копии bb-config соберите plugins/config-updates и выполните bb plugin install path:\"$PWD/plugins/config-updates\".");
}

const WINDOWS = process.platform === "win32";
/** Set from the plugin setting before each use; empty means the default interpreter name. */
export const runtime = { python: "" };

/**
 * scripts/updates.py under Python. Windows has no `python3` unless one was put
 * on PATH, so the interpreter can be named in the settings. UTF-8 mode there:
 * the repository files are UTF-8, the Windows default is the ANSI code page.
 * The console window of the child stays hidden.
 */
function updates(root: string, args: string[], options: { timeout: number; env?: NodeJS.ProcessEnv }) {
  return run(runtime.python || (WINDOWS ? "python" : "python3"), [...(WINDOWS ? ["-X", "utf8"] : []), resolve(root, "scripts/updates.py"), ...args],
    { ...options, windowsHide: true });
}

/** Same directory however it is written: Windows ignores case and accepts both slashes. */
export function samePath(a: string, b: string): boolean {
  const normal = (path: string) => (WINDOWS ? path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() : path.replace(/\/+$/, ""));
  return normal(a) === normal(b);
}

async function github(path: string, accept: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`https://api.github.com${path}`, {
      headers: { Accept: accept, "User-Agent": "bb-config-updates", "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new Error(`GitHub недоступен: ${(error as Error).message}`);
  }
  if (!response.ok) {
    const limited = response.status === 403 || response.status === 429;
    throw new Error(limited ? "GitHub временно ограничил запросы; повторите позже." : `GitHub ответил ${response.status} на ${path}`);
  }
  return response;
}

/** Everything that touches the outside world; tests replace these. */
export const io = {
  root: findRoot,
  projectRoot(root: string): string {
    const marker = resolve(root, ".git/bb-config-installation.json");
    if (!SHA.test(basename(root)) || basename(dirname(root)) !== "releases" || !existsSync(marker)) return root;
    const location = z.object({ root: z.string().refine(isAbsolute) }).parse(JSON.parse(readFileSync(marker, "utf8")));
    return location.root;
  },
  async origin(root: string): Promise<string> {
    return (await run("git", ["-C", root, "remote", "get-url", "origin"], { windowsHide: true })).stdout;
  },
  async local(root: string, plugins?: string): Promise<LocalStatus> {
    const { stdout } = await updates(root, plugins ? ["status", "--dependencies"] : ["status"],
      { timeout: 30_000, env: plugins ? { ...process.env, BB_CONFIG_PLUGINS_JSON: plugins } : undefined });
    return JSON.parse(stdout) as LocalStatus;
  },
  async accept(root: string, tag: string, commit: string, plugins: string, repository: string): Promise<{ accepted: boolean; reason?: string }> {
    const { stdout } = await updates(root, ["accept", tag, "--commit", commit, "--repository", repository],
      { timeout: 120_000, env: { ...process.env, BB_CONFIG_PLUGINS_JSON: plugins } });
    return JSON.parse(stdout) as { accepted: boolean; reason?: string };
  },
  async releases(repository: string): Promise<unknown> {
    return (await github(`/repos/${repository}/releases?per_page=100`, "application/vnd.github+json")).json();
  },
  async commit(repository: string, tag: string): Promise<string> {
    return (await (await github(`/repos/${repository}/commits/${encodeURIComponent(tag)}`, "application/vnd.github.sha")).text()).trim();
  },
};

export default async function configUpdates(bb: BbPluginApi) {
  const settings = bb.settings.define({
    repository: { type: "string", label: "Репозиторий GitHub (owner/repo)", default: "",
      description: "Откуда брать стабильные релизы. Пусто — remote origin этого checkout." },
    autoAccept: { type: "boolean", label: "Принимать релиз без агента, если устанавливать нечего", default: true,
      description: "Когда все шаги релиза уже выполнены или неприменимы, версия отмечается установленной сразу при проверке. Ничего не собирается и не устанавливается." },
    iconOnlyWhenNeeded: { type: "boolean", label: "Показывать значок в нижнем ряду только при обновлении", default: true,
      description: "Без доступных обновлений значок убирается в меню «…» нижнего ряда боковой панели." },
    pythonPath: { type: "string", label: "Интерпретатор Python (3.11+)", default: "",
      description: "Чем запускать scripts/updates.py. Пусто — python3 из PATH сервера BB (на Windows — python). На Windows укажите полный путь, если python в PATH — заглушка Microsoft Store." },
    archiveWhenDone: { type: "boolean", label: "Архивировать тред после успешного обновления", default: true,
      description: "Тред обновления уходит в архив, когда релиз применён полностью и агент закончил ответ. При остатке или ошибке тред остаётся." },
  });
  let status: UpdateStatus = { ...EMPTY, ...((await bb.storage.kv.get<UpdateStatus>("status")) ?? {}) };
  let local: LocalStatus = { installed: null, partial: null, run: null, lastRun: null };
  let root = "";
  let checking: Promise<UpdateStatus> | null = null;
  let starting: Promise<z.infer<typeof StartSchema>> | null = null;

  const publish = async (next: UpdateStatus) => {
    status = next;
    await bb.storage.kv.set("status", status);
    bb.realtime.publish("status", {});
    return status;
  };

  /**
   * Keep the sidebar footer icon on the row only while there is something to
   * act on; otherwise it moves into the footer's More menu. Uses bb's own
   * preference for footer items, so the user can still override it there.
   */
  async function syncFooter() {
    try {
      if (!(await settings.get()).iconOnlyWhenNeeded) return;
      const wanted = status.pending.length === 0 && status.remaining === 0 && status.dependencyIssues.length === 0 && !status.runOwner;
      const { preferences } = await bb.sdk.system.uiPreferences.list();
      const current = preferences["sidebar.hiddenFooterItems"];
      if (current.value.includes(FOOTER_KEY) === wanted) return;
      await bb.sdk.system.uiPreferences.set({ key: "sidebar.hiddenFooterItems", expectedRevision: current.revision,
        value: wanted ? [...current.value, FOOTER_KEY] : current.value.filter((key) => key !== FOOTER_KEY) });
    } catch (error) {
      bb.log.warn(`Sidebar footer icon was not updated: ${String(error)}`);
    }
  }

  async function checkOnce(): Promise<UpdateStatus> {
    const checkedAt = Date.now();
    try {
      root = io.root();
      runtime.python = (await settings.get()).pythonPath.trim();
      const configured = (await settings.get()).repository.trim();
      const repository = configured || parseRepository(await io.origin(root));
      if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
        throw new Error("Не удалось определить репозиторий GitHub: укажите owner/repo в настройках плагина.");
      }
      const { plugins } = await bb.sdk.plugins.list();
      const installedPlugins = JSON.stringify(plugins.map((plugin) => ({
        id: plugin.id, version: plugin.version, rootDir: plugin.rootDir, source: plugin.source,
        enabled: plugin.enabled, status: plugin.status, statusDetail: plugin.statusDetail })));
      local = await io.local(root, installedPlugins);
      const all = stableReleases(await io.releases(repository));
      let pending = newerThan(all, local.installed?.release ?? null);
      let target = pending.at(-1);
      let commit = target ? await io.commit(repository, target.tag) : null;
      if (commit !== null && !SHA.test(commit)) throw new Error(`GitHub не вернул коммит релиза ${target!.tag}.`);
      // A release that needs no action here is accepted without an agent:
      // the script only fetches the pinned commit and records what it verified.
      if (target && commit && !local.run && (await settings.get()).autoAccept) {
        const accepted = await io.accept(root, target.tag, commit, installedPlugins, repository);
        if (accepted.accepted) {
          local = await io.local(root, installedPlugins);
          pending = newerThan(all, local.installed?.release ?? null);
          target = pending.at(-1);
          commit = target ? await io.commit(repository, target.tag) : null;
        } else {
          bb.log.info(`Release ${target.tag} needs an agent: ${accepted.reason ?? "unknown reason"}`);
        }
      }
      // Stored status must stay small: full notes only for the newest releases.
      pending = pending.map((release, index, list) => (index < list.length - NOTES_FOR ? { ...release, notes: "" } : release));
      const next = await publish({ checkedAt, okAt: checkedAt, error: null, repository, installed: local.installed?.release ?? null, pending, commit,
        installedAt: local.installed?.at ?? null, installedAuto: local.installed?.how === "auto-accept",
        remaining: local.partial?.remaining.length ?? 0, dependencyIssues: local.dependencyIssues ?? [],
        runOwner: local.run?.owner ?? null, runRelease: local.run?.release ?? null,
        threadId: status.threadId, threadAt: status.threadAt, lastRunOwner: local.lastRun?.owner ?? null });
      await syncFooter();
      return next;
    } catch (error) {
      // Keep the last known answer; never turn a failed check into "up to date".
      return await publish({ ...status, checkedAt, error: (error as Error).message.slice(0, 300) });
    }
  }
  const check = () => (checking ??= checkOnce().finally(() => { checking = null; }));

  /** The update thread started earlier, while it still exists and is not archived. */
  async function liveThread(threadId: string | null): Promise<string | null> {
    if (!threadId) return null;
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      return thread.archivedAt ? null : thread.id;
    } catch {
      return null;
    }
  }

  /** Where an update thread runs: the BB project of this checkout on the server machine. */
  async function prepare() {
    const fresh = await check();
    if (fresh.error) throw new Error(`Проверка не удалась, обновление не запущено: ${fresh.error}`);
    const target = fresh.pending.at(-1);
    if (!target || !fresh.commit) throw new Error("Новых опубликованных релизов нет.");
    // One update at a time: reuse the thread that already works on it.
    // The journal knows who works on it: the open run, or the thread that left
    // steps unfinished. A thread just started from the CLI has not reached
    // `begin` yet, so it is remembered for a short while.
    const unfinished = local.partial && local.lastRun && !local.lastRun.complete ? local.lastRun.owner : null;
    const justStarted = Date.now() - fresh.threadAt < START_WINDOW_MS ? fresh.threadId : null;
    const candidates = [fresh.runOwner, unfinished, justStarted].filter((id): id is string => !!id && id.startsWith("thr_"));
    for (const id of candidates) {
      const existing = await liveThread(id);
      if (existing) return { target, existing };
    }
    const projects = await bb.sdk.projects.list();
    const { primaryHostId } = await bb.sdk.system.config();
    const projectRoot = io.projectRoot(root);
    const sources = projects.flatMap((project) => project.sources.map((source) => ({ project, source })))
      .filter(({ source }) => samePath(source.path, projectRoot))
      .sort((a, b) => Number(b.source.hostId === primaryHostId) - Number(a.source.hostId === primaryHostId));
    const match = sources[0];
    if (!match) throw new Error(`Добавьте каталог ${projectRoot} на машине сервера BB как проект BB, затем повторите.`);
    return { target, existing: null, projectId: match.project.id, hostId: match.source.hostId, projectRoot,
      prompt: buildPrompt({ repository: fresh.repository, root, target, commit: fresh.commit, pending: fresh.pending, local }) };
  }

  /**
   * The interface path: hand the prepared task to bb's own new-thread screen,
   * where the user sees and picks the provider, model and permissions.
   */
  async function compose(): Promise<z.infer<typeof ComposeSchema>> {
    const plan = await prepare();
    if (plan.existing) return { tag: plan.target.tag, threadId: plan.existing, projectId: null, hostId: null, prompt: null };
    return { tag: plan.target.tag, threadId: null, projectId: plan.projectId!, hostId: plan.hostId!, prompt: plan.prompt! };
  }

  /** The CLI path: start the thread directly with the project's default provider and model. */
  async function startOnce(): Promise<z.infer<typeof StartSchema>> {
    const plan = await prepare();
    if (plan.existing) return { threadId: plan.existing, existing: true, tag: plan.target.tag };
    const thread = await bb.sdk.threads.spawn({
      projectId: plan.projectId!,
      environment: { type: "host", hostId: plan.hostId!, workspace: { type: "unmanaged", path: plan.projectRoot! } },
      title: `Обновление доработок BB до ${plan.target.tag}`,
      prompt: plan.prompt!,
    });
    await publish({ ...status, threadId: thread.id, threadAt: Date.now() });
    return { threadId: thread.id, existing: false, tag: plan.target.tag };
  }
  const start = () => (starting ??= startOnce().finally(() => { starting = null; }));

  /**
   * A thread finished a turn. If the journal names it as the thread that ran
   * the last update and that update is complete, archive it once. A partial
   * or failed update keeps its thread so the user sees what is left. The
   * journal, not this plugin, knows the thread: it may have been started from
   * the new-thread screen.
   */
  bb.events.on("thread.idle", async ({ thread }) => {
    if (thread.id !== status.lastRunOwner && thread.id !== status.runOwner && thread.id !== status.threadId) return;
    try {
      runtime.python = (await settings.get()).pythonPath.trim();
      const journal = await io.local(root || io.root());
      const last = journal.lastRun;
      if (journal.run || journal.partial || !last?.complete || last.owner !== thread.id) return;
      const mark = `${last.owner}:${last.at}`;
      if ((await bb.storage.kv.get<string>("archived-run")) === mark) return;
      await bb.storage.kv.set("archived-run", mark);
      if ((await settings.get()).archiveWhenDone) await bb.sdk.threads.archive({ threadId: thread.id });
      await publish({ ...status, threadId: null });
      await check();
    } catch (error) {
      bb.log.warn(`Update thread was not archived: ${String(error)}`);
    }
  });

  bb.rpc.register(rpcContract, { status: () => status, check, compose });
  bb.background.schedule("check-releases", "17 */6 * * *", async () => { await check(); });
  bb.background.service("initial-check", {
    async start(signal) {
      if (Date.now() - status.checkedAt > STALE_MS) await check();
      await new Promise<void>((done) => signal.addEventListener("abort", () => done(), { once: true }));
    },
  });
  bb.cli.register({
    name: "config-updates", summary: "Проверка релизов доработок BB и запуск обновления агентом",
    commands: [
      { name: "status", summary: "Последний результат проверки, без обращения к сети", usage: "status [--json]" },
      { name: "check", summary: "Проверить опубликованные стабильные релизы сейчас", usage: "check [--json]" },
      { name: "start", summary: "Запустить тред агента с провайдером и моделью проекта по умолчанию", usage: "start" },
    ],
    async run(argv) {
      const [command, flag] = argv;
      if (command === "start") {
        const started = await start();
        return { exitCode: 0, stdout: `${started.existing ? "Обновление уже выполняется" : "Запущено обновление"} до ${started.tag}: ${started.threadId}\n` };
      }
      if (command !== "status" && command !== "check") {
        return { exitCode: 2, stderr: "Usage: bb config-updates status|check [--json] | start\n" };
      }
      const result = command === "check" ? await check() : status;
      if (flag === "--json") return { exitCode: result.error ? 1 : 0, stdout: JSON.stringify(result, null, 2) + "\n" };
      const target = result.pending.at(-1);
      const lines = [
        `Установлено: ${result.installed ? `${result.installed}${result.installedAt ? ` (с ${result.installedAt.slice(0, 10)})` : ""}` : "не определено"}${result.remaining ? ` (не завершено шагов: ${result.remaining})` : ""}`,
        result.checkedAt ? `Проверено: ${new Date(result.checkedAt).toISOString()}` : "Проверка ещё не выполнялась.",
        ...(result.error ? [`ОШИБКА ПРОВЕРКИ: ${result.error}`, "Это не означает отсутствие обновлений."] : []),
        ...(result.runRelease ? [`Сейчас идёт обновление до ${result.runRelease} (тред ${result.runOwner}).`] : []),
        ...result.dependencyIssues.map((issue) => `Несовместимая зависимость — ${issue}`),
        target ? `Доступно: ${target.tag}${target.title === target.tag ? "" : ` — ${target.title}`}, опубликован ${target.publishedAt.slice(0, 10)} (${result.commit?.slice(0, 12)}); к применению: ${result.pending.map((r) => r.tag).join(", ")}`
          : result.okAt && !result.error ? "Новых стабильных релизов нет." : "",
      ].filter(Boolean);
      return { exitCode: result.error ? 1 : 0, stdout: lines.join("\n") + "\n" };
    },
  });
}
