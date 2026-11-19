import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin, { io, samePath, type UpdateStatus } from "./server.ts";
import { buildPrompt, newerThan, parseRepository, stableReleases, type LocalStatus } from "./releases.ts";

const SHA = "a".repeat(40);
const release = (tag: string, extra: object = {}) => ({ tag_name: tag, name: `Release ${tag}`, body: `notes ${tag}`, draft: false,
  prerelease: false, html_url: `https://github.com/acme/config/releases/tag/${tag}`, published_at: "2026-11-01T00:00:00Z", ...extra });

function setup(options: { releases?: unknown; installed?: string | null; offline?: boolean; local?: Partial<LocalStatus>; sources?: object[] } = {}) {
  const state = { offline: options.offline ?? false, releases: options.releases ?? [release("v1.0.0"), release("v1.1.0")],
    spawned: [] as Record<string, any>[], archived: false, network: 0,
    archivedIds: [] as string[], acceptCalls: [] as string[], acceptable: false, how: undefined as string | undefined,
    local: options.local ?? {} as Partial<LocalStatus>, installed: options.installed ?? null };
  io.root = () => "/srv/config";
  io.projectRoot = (root) => root;
  io.origin = async () => "https://github.com/acme/config.git\n";
  io.local = async () => ({ installed: state.installed ? { release: state.installed, commit: SHA, how: state.how } : null, partial: null, run: null, ...state.local });
  io.releases = async () => { state.network += 1; if (state.offline) throw new Error("GitHub недоступен: timeout"); return state.releases; };
  io.commit = async () => SHA;
  io.accept = async (_root, tag) => {
    state.acceptCalls.push(tag);
    if (!state.acceptable) return { accepted: false, reason: "v/x has to be applied" };
    state.installed = tag; state.how = "auto-accept";
    return { accepted: true };
  };
  const { bb, harness } = createFakePluginHost({ pluginId: "config-updates", sdk: {
    projects: { list: async () => [{ id: "proj", name: "config", kind: "standard", sources: options.sources ?? [
      { type: "local_path", hostId: "host_mac", path: "/work/other/config", isDefault: true },
      { type: "local_path", hostId: "host_server", path: "/srv/config/", isDefault: false }] }] },
    system: { config: async () => ({ primaryHostId: "host_server" }) },
    plugins: { list: async () => ({ plugins: [] }) },
    threads: {
      spawn: async (args: Record<string, any>) => { state.spawned.push(args); return { id: `thr_${state.spawned.length}` }; },
      get: async ({ threadId }: { threadId: string }) => ({ id: threadId, archivedAt: state.archived ? 1 : null }),
      archive: async ({ threadId }: { threadId: string }) => { state.archivedIds.push(threadId); return {}; },
    },
  } as never });
  const rpc = (method: string) => harness.behavior.callRpc(method, null) as Promise<any>;
  return { bb, harness, state, rpc };
}

/** The CLI path spawns directly; the result line ends with the thread id. */
async function cliStart(s: ReturnType<typeof setup>) {
  const result = await s.harness.behavior.runCli(["start"]);
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  const threadId = result.stdout.trim().split(" ").at(-1)!;
  return { threadId, existing: /уже выполняется/.test(result.stdout), tag: /до (v[\d.]+\d)/.exec(result.stdout)![1]! };
}

test("only published stable vX.Y.Z releases count; malformed answers are errors", () => {
  const tags = stableReleases([release("v1.2.0"), release("v1.10.0"), release("v2.0.0", { draft: true }),
    release("v1.11.0", { prerelease: true }), release("v1.12.0-rc.1"), release("nightly"), release("v1.9.0")]).map((r) => r.tag);
  assert.deepEqual(tags, ["v1.2.0", "v1.9.0", "v1.10.0"]);
  assert.deepEqual(newerThan(stableReleases([release("v1.2.0"), release("v1.10.0")]), "v1.2.0").map((r) => r.tag), ["v1.10.0"]);
  assert.throws(() => stableReleases({ message: "rate limited" }));
  assert.throws(() => stableReleases([{ tag_name: "v1.0.0" }]));
  assert.equal(parseRepository("git@github.com:acme/bb-config.git"), "acme/bb-config");
  assert.equal(parseRepository("https://token@github.com/acme/bb-config"), "acme/bb-config");
  assert.equal(parseRepository("https://example.org/acme/bb-config.git"), null);
});

test("check lists missed releases, pins the target commit and installs nothing", async () => {
  const s = setup({ installed: "v0.9.0" }); await plugin(s.bb);
  const status: UpdateStatus = await s.rpc("check");
  assert.deepEqual(status.pending.map((r) => r.tag), ["v1.0.0", "v1.1.0"]);
  assert.equal(status.commit, SHA); assert.equal(status.error, null); assert.equal(status.repository, "acme/config");
  assert.equal(s.state.spawned.length, 0);
  const upToDate = setup({ installed: "v1.1.0" }); await plugin(upToDate.bb);
  assert.deepEqual((await upToDate.rpc("check")).pending, []);
  await s.harness.lifecycle.dispose(); await upToDate.harness.lifecycle.dispose();
});

test("a network failure is a failed check that keeps the last known update", async () => {
  const s = setup({ installed: "v1.0.0" }); await plugin(s.bb);
  await s.rpc("check");
  s.state.offline = true;
  const failed: UpdateStatus = await s.rpc("check");
  assert.match(failed.error ?? "", /GitHub недоступен/);
  assert.deepEqual(failed.pending.map((r) => r.tag), ["v1.1.0"]);
  assert.ok(failed.checkedAt >= failed.okAt);
  const cli = await s.harness.behavior.runCli(["status"]);
  assert.equal(cli.exitCode, 1); assert.match(cli.stdout, /ОШИБКА ПРОВЕРКИ/); assert.doesNotMatch(cli.stdout, /релизов нет/);
  await assert.rejects(cliStart(s), /не запущено/);
  assert.equal(s.state.spawned.length, 0);
  const never = setup({ offline: true }); await plugin(never.bb);
  assert.doesNotMatch((await never.harness.behavior.runCli(["check"])).stdout, /релизов нет/);
  await s.harness.lifecycle.dispose(); await never.harness.lifecycle.dispose();
});

test("a failed check after an up-to-date result reports an error in both CLI commands", async () => {
  const s = setup({ installed: "v1.1.0" });
  await plugin(s.bb);
  try {
    const success = await s.harness.behavior.runCli(["check"]);
    assert.equal(success.exitCode, 0);
    assert.match(success.stdout, /Новых стабильных релизов нет/);

    s.state.offline = true;
    for (const command of ["check", "status"]) {
      const result = await s.harness.behavior.runCli([command]);
      assert.equal(result.exitCode, 1);
      assert.match(result.stdout, /ОШИБКА ПРОВЕРКИ/);
      assert.doesNotMatch(result.stdout, /Новых стабильных релизов нет/);
    }
  } finally {
    await s.harness.lifecycle.dispose();
  }
});

test("start spawns one agent thread on the server checkout with the pinned release", async () => {
  const s = setup({ installed: "v1.0.0" }); await plugin(s.bb);
  const [a, b] = await Promise.all([cliStart(s), cliStart(s)]);
  assert.equal(s.state.spawned.length, 1); assert.deepEqual(a, b);
  const spawn = s.state.spawned[0]!;
  assert.equal(spawn.projectId, "proj");
  assert.deepEqual(spawn.environment, { type: "host", hostId: "host_server", workspace: { type: "unmanaged", path: "/srv/config" } });
  assert.match(spawn.prompt, new RegExp(`fetch v1\\.1\\.0 --commit ${SHA}`));
  assert.doesNotMatch(spawn.prompt, /origin\/main|git pull/);
  assert.deepEqual(await cliStart(s), { threadId: "thr_1", existing: true, tag: "v1.1.0" });
  s.state.local = { partial: { release: "v1.1.0", remaining: [{ step: "v1.1.0/x", machine: "server" }] },
    lastRun: { owner: "thr_1", release: "v1.1.0", complete: false, at: "x" } };
  assert.equal((await s.rpc("compose")).threadId, "thr_1"); // the thread that left steps unfinished continues
  s.state.local = {};
  s.state.archived = true; // the old thread is gone: a new one may start
  assert.equal((await cliStart(s)).threadId, "thr_2");
  await s.harness.lifecycle.dispose();
});

test("an open run of another thread is joined, and a missing project is explained", async () => {
  const s = setup({ installed: "v1.0.0", local: { run: { release: "v1.1.0", owner: "thr_other", startedAt: "x" } } }); await plugin(s.bb);
  assert.deepEqual(await cliStart(s), { threadId: "thr_other", existing: true, tag: "v1.1.0" });
  const none = setup({ installed: "v1.0.0", sources: [] }); await plugin(none.bb);
  await assert.rejects(none.rpc("compose"), /как проект BB/);
  const current = setup({ installed: "v1.1.0" }); await plugin(current.bb);
  await assert.rejects(current.rpc("compose"), /релизов нет/);
  for (const each of [s, none, current]) await each.harness.lifecycle.dispose();
});

test("a release-installed updater keeps the original project and reports changed dependencies", async () => {
  const issue = "integration: addon: installed 2.0.0; requires <2.0.0";
  const s = setup({ installed: "v1.0.0", local: { dependencyIssues: [issue] } });
  const runner = `/srv/config/.local/updates/releases/${SHA}`;
  io.root = () => runner;
  io.projectRoot = (root) => { assert.equal(root, runner); return "/srv/config"; };
  await plugin(s.bb);
  try {
    const checked = await s.rpc("check");
    assert.deepEqual(checked.dependencyIssues, [issue]);
    await cliStart(s);
    const spawn = s.state.spawned[0]!;
    assert.equal(spawn.environment.workspace.path, "/srv/config");
    assert.ok(spawn.prompt.includes(runner));
    assert.match(spawn.prompt, /--repository acme\/config/);
  } finally {
    await s.harness.lifecycle.dispose();
  }
});

test("the schedule checks, and the prompt carries missed releases and a partial run", async () => {
  const s = setup({ installed: "v1.0.0" }); await plugin(s.bb);
  const before = s.state.network;
  await s.harness.behavior.runSchedule("check-releases");
  assert.equal(s.state.network, before + 1);
  const pending = stableReleases([release("v1.0.0"), release("v1.1.0")]);
  const prompt = buildPrompt({ repository: "acme/config", root: "/srv/config", target: pending[1]!, commit: SHA, pending,
    local: { installed: null, run: null, partial: { release: "v1.1.0", remaining: [{ step: "v1.1.0/x", machine: "host_b" }] } } });
  assert.match(prompt, /v1\.0\.0, v1\.1\.0/); assert.match(prompt, /частичным/); assert.match(prompt, /не определена/);
  assert.match(prompt, /restore\.py/);
  await s.harness.lifecycle.dispose();
});

test("the button hands the task to the new-thread screen and spawns nothing", async () => {
  const s = setup({ installed: "v1.0.0" }); await plugin(s.bb);
  const plan = await s.rpc("compose");
  assert.equal(s.state.spawned.length, 0);
  assert.deepEqual([plan.tag, plan.threadId, plan.projectId, plan.hostId], ["v1.1.0", null, "proj", "host_server"]);
  assert.match(plan.prompt, new RegExp(`begin v1\\.1\\.0 --commit ${SHA}`));
  s.state.local = { run: { release: "v1.1.0", owner: "thr_running", startedAt: "x" } };
  assert.deepEqual(await s.rpc("compose"), { tag: "v1.1.0", threadId: "thr_running", projectId: null, hostId: null, prompt: null });
  await s.harness.lifecycle.dispose();
});

test("the thread named by the journal is archived once, only after a complete update", async () => {
  const s = setup({ installed: "v1.0.0" }); await plugin(s.bb);
  const idle = (id: string) => s.harness.behavior.emitThreadEvent("thread.idle", { thread: { id } } as never);
  const finished = (complete: boolean) => ({ lastRun: { owner: "thr_user", release: "v1.1.0", complete, at: "2026-11-16T00:00:00Z" } });
  s.state.local = { run: { release: "v1.1.0", owner: "thr_user", startedAt: "x" } };
  await s.rpc("check"); await idle("thr_user"); // run still open
  s.state.installed = "v1.1.0";
  s.state.local = { ...finished(false), partial: { release: "v1.1.0", remaining: [{ step: "v1.1.0/x", machine: "host_b" }] } };
  await s.rpc("check"); await idle("thr_user"); // partial result keeps the thread
  await idle("thr_unrelated");
  assert.deepEqual(s.state.archivedIds, []);
  s.state.local = finished(true);
  await s.rpc("check"); await idle("thr_unrelated"); await idle("thr_user");
  assert.deepEqual(s.state.archivedIds, ["thr_user"]);
  await idle("thr_user"); // unarchived by the user later: left alone
  assert.equal(s.state.archivedIds.length, 1);
  const status: UpdateStatus = await s.rpc("status");
  assert.equal(status.installed, "v1.1.0"); assert.deepEqual(status.pending, []);
  await s.harness.lifecycle.dispose();
});

test("a release with nothing to apply is accepted at check time and clears the available release", async () => {
  const s = setup({ installed: "v1.0.0" }); await plugin(s.bb);
  let status: UpdateStatus = await s.rpc("check");
  assert.deepEqual(s.state.acceptCalls, ["v1.1.0"]);
  assert.deepEqual(status.pending.map((r) => r.tag), ["v1.1.0"]); // has to be applied: the agent path stays
  s.state.acceptable = true;
  status = await s.rpc("check");
  assert.equal(status.installed, "v1.1.0"); assert.equal(status.installedAuto, true); assert.deepEqual(status.pending, []);
  assert.equal(s.state.spawned.length, 0);
  s.state.releases = [release("v1.2.0")]; s.state.acceptable = false;
  status = await s.rpc("check");
  assert.deepEqual(status.pending.map((r) => r.tag), ["v1.2.0"]);
  await s.harness.lifecycle.dispose();
});

test("an open run is never auto-accepted over", async () => {
  const s = setup({ installed: "v1.0.0", local: { run: { release: "v1.1.0", owner: "thr_x", startedAt: "x" } } }); await plugin(s.bb);
  await s.rpc("check");
  assert.deepEqual(s.state.acceptCalls, []);
  await s.harness.lifecycle.dispose();
});

test("the checkout matches its project source however the path is written", () => {
  assert.equal(samePath("/srv/config/", "/srv/config"), true);
  assert.equal(samePath("/srv/config", "/srv/other"), false);
  // Windows: bb may store forward slashes or another case than realpath returns.
  assert.equal(samePath("d:/Work/BB-Config/", "D:\\Work\\bb-config"), process.platform === "win32");
});
