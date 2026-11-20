import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, resolve } from "node:path";
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
const AttentionSchema = z.object({ component: z.string(), type: z.string(), text: z.string() });
const UntestedSchema = z.object({ component: z.string(), name: z.string(), installed: z.string(), tested: z.string(),
  needed: z.array(z.string()) });
/** The update run started from the button, without an agent. */
const JobSchema = z.object({
  state: z.enum(["running", "done", "failed"]), tag: z.string(), startedAt: z.number(), finishedAt: z.number().nullable(),
  /** Exit code of updates.py apply: 0 done, 2 steps left, 3 a decision is needed, other — error. */
  code: z.number().nullable(),
  steps: z.object({ applied: z.number(), existing: z.number(), other: z.number() }),
  installed: z.array(z.string()), updated: z.array(z.string()),
  attention: z.array(AttentionSchema), remaining: z.number(), error: z.string().nullable(),
});
export type UpdateJob = z.infer<typeof JobSchema>;
const ComponentSchema = z.object({ id: z.string(), name: z.string(), description: z.string(), link: z.string(),
  kind: z.string(), state: z.string(), version: z.string().nullable(), new: z.boolean(), excluded: z.boolean() });
const PlanSchema = z.object({ tag: z.string(), components: z.array(ComponentSchema), untested: z.array(UntestedSchema) });
export type UpdatePlan = z.infer<typeof PlanSchema>;
export type UpdateStatus = z.infer<typeof StatusSchema> & { job: UpdateJob | null; untested: z.infer<typeof UntestedSchema>[] };
const StartSchema = z.object({ threadId: z.string(), existing: z.boolean(), tag: z.string() });
/** Either the thread already applying the update, or what to put on the new-thread screen. */
const ComposeSchema = z.object({ tag: z.string(), threadId: z.string().nullable(), projectId: z.string().nullable(),
  hostId: z.string().nullable(), prompt: z.string().nullable() });
const FullStatusSchema = StatusSchema.extend({ job: JobSchema.nullable().default(null), untested: z.array(UntestedSchema).default([]) });
export const rpcContract = defineRpcContract({
  status: { input: z.null(), output: FullStatusSchema },
  check: { input: z.null(), output: FullStatusSchema },
  compose: { input: z.null(), output: ComposeSchema },
  /** What the update would install: new components to choose from, plugins newer than tested. */
  plan: { input: z.null(), output: PlanSchema },
  /** Run the update now, without an agent; `skip` are new components the user unticked. */
  update: { input: z.object({ skip: z.array(z.string()) }), output: FullStatusSchema },
});

const EMPTY: UpdateStatus = { checkedAt: 0, okAt: 0, error: null, repository: "", installed: null, installedAt: null, installedAuto: false, remaining: 0, dependencyIssues: [],
  runOwner: null, runRelease: null, pending: [], commit: null, threadId: null, threadAt: 0, lastRunOwner: null, job: null, untested: [] };
const STALE_MS = 6 * 3_600_000;
const SHA = /^[0-9a-f]{40}$/;
const NOTES_FOR = 5;
const START_WINDOW_MS = 15 * 60_000;

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

/** Any Python script of a checkout (bundle.py of a prepared release). */
function python(script: string, args: string[], options: { timeout: number; env?: NodeJS.ProcessEnv; cwd?: string }) {
  return run(runtime.python || (WINDOWS ? "python" : "python3"), [...(WINDOWS ? ["-X", "utf8"] : []), script, ...args],
    { ...options, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
}

/** JSON printed by a script, from stdout on success or stderr on a non-zero exit. */
export function scriptAnswer(error: unknown): { code: number; answer: unknown } {
  const failure = error as { code?: number; stdout?: string; stderr?: string };
  for (const text of [failure.stderr ?? "", failure.stdout ?? ""]) {
    const start = text.indexOf("{");
    if (start < 0) continue;
    try { return { code: typeof failure.code === "number" ? failure.code : 1, answer: JSON.parse(text.slice(start)) }; } catch { /* next */ }
  }
  return { code: typeof failure.code === "number" ? failure.code : 1, answer: null };
}

/** The job summary from the JSON of `updates.py apply`. */
export function summarize(tag: string, startedAt: number, code: number, answer: unknown, error: string | null): UpdateJob {
  const result = (answer ?? {}) as { steps?: { status: string; how?: string; detail?: string; step: string }[];
    attention?: { component: string; type: string; text: string }[]; remaining?: unknown[] };
  const steps = result.steps ?? [];
  const bundle = steps.find((step) => step.step.endsWith("/bundle"))?.detail ?? "";
  const listed = (state: string) => (new RegExp(`(?:^|; )${state}: ([^;]+)`).exec(bundle)?.[1] ?? "").split(", ").filter(Boolean);
  return {
    state: code === 0 ? "done" : "failed", tag, startedAt, finishedAt: Date.now(), code,
    steps: { applied: steps.filter((s) => s.how === "applied").length, existing: steps.filter((s) => s.how === "existing").length,
      other: steps.filter((s) => s.status !== "verified").length },
    installed: listed("installed"), updated: listed("updated"),
    attention: (result.attention ?? []).map(({ component, type, text }) => ({ component, type, text })),
    remaining: result.remaining?.length ?? 0, error: error ?? (answer ? null : "updates.py apply не вернул результат"),
  };
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
    pythonPath: { type: "string", label: "Интерпретатор Python (3.11+)", default: "",
      description: "Чем запускать scripts/updates.py. Пусто — python3 из PATH сервера BB (на Windows — python). На Windows укажите полный путь, если python в PATH — заглушка Microsoft Store." },
    cliPath: { type: "string", label: "BB CLI (путь к исполняемому файлу)", default: process.env.BB_CLI ?? "",
      description: "Нужен кнопке «Обновить»: установка плагинов идёт через bb plugin. Пусто — значение BB_CLI сервера." },
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
      const untested = await untestedPlugins(installedPlugins);
      const next = await publish({ checkedAt, okAt: checkedAt, error: null, repository, installed: local.installed?.release ?? null, pending, commit,
        job: status.job, untested,
        installedAt: local.installed?.at ?? null, installedAuto: local.installed?.how === "auto-accept",
        remaining: local.partial?.remaining.length ?? 0, dependencyIssues: local.dependencyIssues ?? [],
        runOwner: local.run?.owner ?? null, runRelease: local.run?.release ?? null,
        threadId: status.threadId, threadAt: status.threadAt, lastRunOwner: local.lastRun?.owner ?? null });
      return next;
    } catch (error) {
      // Keep the last known answer; never turn a failed check into "up to date".
      return await publish({ ...status, checkedAt, error: (error as Error).message.slice(0, 300) });
    }
  }
  const check = () => (checking ??= checkOnce().finally(() => { checking = null; }));

  /** External plugins newer than the version the installed release was tested with. */
  async function untestedPlugins(plugins: string) {
    const script = resolve(root, "scripts/bundle.py");
    if (!existsSync(script)) return [];
    try {
      const { stdout } = await python(script, ["plan"], { timeout: 60_000, cwd: root, env: { ...process.env, BB_CONFIG_PLUGINS_JSON: plugins } });
      return PlanSchema.shape.untested.parse(JSON.parse(stdout).untested);
    } catch (error) {
      bb.log.warn(`Untested-version check failed: ${String(error).slice(0, 300)}`);
      return status.untested;
    }
  }

  /** Environment for scripts that install plugins: the bb CLI first on PATH, this server. */
  async function cliEnvironment(): Promise<NodeJS.ProcessEnv> {
    const cli = (await settings.get()).cliPath.trim() || process.env.BB_CLI || "";
    if (!cli || !existsSync(cli)) throw new Error("Не найден bb CLI: укажите путь в настройках плагина или используйте «Разобраться с ИИ».");
    return { ...process.env, BB_CLI: cli, PATH: `${dirname(cli)}${delimiter}${process.env.PATH ?? ""}`,
      BB_SERVER_URL: bb.server.loopbackBaseUrl, BB_THREAD_ID: "plugin-config-updates" };
  }

  /** Prepare the pinned release and ask its own bundle.py what the update brings. */
  async function plan(): Promise<UpdatePlan> {
    const fresh = await check();
    const target = fresh.pending.at(-1);
    if (fresh.error || !target || !fresh.commit) throw new Error(fresh.error ?? "Новых опубликованных релизов нет.");
    const env = await cliEnvironment();
    const { stdout } = await updates(root, ["fetch", target.tag, "--commit", fresh.commit, "--repository", fresh.repository], { timeout: 300_000, env });
    const checkout = z.object({ checkout: z.string() }).parse(JSON.parse(stdout)).checkout;
    const script = resolve(checkout, "scripts/bundle.py");
    if (!existsSync(script)) return { tag: target.tag, components: [], untested: fresh.untested };
    const answer = JSON.parse((await python(script, ["plan"], { timeout: 120_000, cwd: checkout, env })).stdout);
    return PlanSchema.parse({ tag: target.tag, components: answer.components, untested: answer.untested });
  }

  /**
   * The run outlives this plugin: the bundle step reinstalls Config Updates
   * itself, which restarts this process. A detached Python wrapper runs
   * `updates.py apply` and writes {code, stdout, stderr} to a file that the
   * plugin reads after any restart.
   */
  const resultFile = () => resolve(io.projectRoot(root || io.root()), ".local/updates/button-run.json");
  const WRAPPER = "import json,subprocess,sys\nr=subprocess.run(sys.argv[2:],capture_output=True,text=True)\n" +
    "open(sys.argv[1]+'.tmp','w').write(json.dumps({'code':r.returncode,'stdout':r.stdout,'stderr':r.stderr}))\n" +
    "import os\nos.replace(sys.argv[1]+'.tmp',sys.argv[1])\n";

  /** A finished detached run turns into the job result. */
  async function collect(): Promise<void> {
    const job = status.job;
    if (job?.state !== "running") return;
    const file = resultFile();
    if (!existsSync(file)) {
      if (Date.now() - job.startedAt > 60 * 60_000) {
        await publish({ ...status, job: { ...job, state: "failed", finishedAt: Date.now(), error: "Обновление не завершилось за час. Повторите: сделанное только проверится." } });
      }
      return;
    }
    const { code, stdout, stderr } = JSON.parse(readFileSync(file, "utf8")) as { code: number; stdout: string; stderr: string };
    rmSync(file, { force: true });
    const parsed = code === 0 ? { code, answer: JSON.parse(stdout) } : scriptAnswer({ code, stdout, stderr });
    await publish({ ...status, job: summarize(job.tag, job.startedAt, parsed.code, parsed.answer,
      parsed.answer ? null : (stderr || stdout).trim().slice(-400) || "updates.py apply завершился с ошибкой") });
    await check();
  }

  /** Start `updates.py apply` detached; the job and its result live in the status. */
  async function update({ skip }: { skip: string[] }): Promise<UpdateStatus> {
    if (status.job?.state === "running") return status;
    const target = status.pending.at(-1);
    if (!target || !status.commit) throw new Error("Новых опубликованных релизов нет.");
    if (status.runOwner) throw new Error("Обновление уже ведёт тред агента: откройте его.");
    const env = await cliEnvironment();
    const startedAt = Date.now();
    const args = ["apply", target.tag, "--commit", status.commit, "--repository", status.repository, "--yes",
      ...(skip.length ? ["--skip", skip.join(",")] : [])];
    await publish({ ...status, job: { state: "running", tag: target.tag, startedAt, finishedAt: null, code: null,
      steps: { applied: 0, existing: 0, other: 0 }, installed: [], updated: [], attention: [], remaining: 0, error: null } });
    const file = resultFile();
    mkdirSync(dirname(file), { recursive: true });
    rmSync(file, { force: true });
    const interpreter = runtime.python || (WINDOWS ? "python" : "python3");
    const child = spawn(interpreter, ["-c", WRAPPER, file, interpreter, ...(WINDOWS ? ["-X", "utf8"] : []),
      resolve(root, "scripts/updates.py"), ...args], { cwd: root, env, detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    return status;
  }

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

  bb.rpc.register(rpcContract, { status: () => status, check, compose, plan, update });
  bb.background.schedule("check-releases", "17 */6 * * *", async () => { await check(); });
  bb.background.service("update-job", {
    async start(signal) {
      while (!signal.aborted) {
        try { await collect(); } catch (error) { bb.log.warn(`Update result not read: ${String(error)}`); }
        await new Promise<void>((done) => { const timer = setTimeout(done, 5_000); signal.addEventListener("abort", () => { clearTimeout(timer); done(); }, { once: true }); });
      }
    },
  });
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
        ...result.untested.map((item) => `Не проверено: ${item.name} ${item.installed} новее проверенной ${item.tested}${item.needed.length ? ` (${item.needed.join(", ")} может работать неправильно)` : ""}`),
        ...(result.job ? [result.job.state === "running" ? `Идёт обновление до ${result.job.tag} кнопкой.`
          : `Последнее обновление кнопкой до ${result.job.tag}: ${result.job.state === "done" ? "готово" : `не завершено — ${result.job.error ?? `осталось шагов ${result.job.remaining}`}`}.`] : []),
        target ? `Доступно: ${target.tag}${target.title === target.tag ? "" : ` — ${target.title}`}, опубликован ${target.publishedAt.slice(0, 10)} (${result.commit?.slice(0, 12)}); к применению: ${result.pending.map((r) => r.tag).join(", ")}`
          : result.okAt && !result.error ? "Новых стабильных релизов нет." : "",
      ].filter(Boolean);
      return { exitCode: result.error ? 1 : 0, stdout: lines.join("\n") + "\n" };
    },
  });
}
