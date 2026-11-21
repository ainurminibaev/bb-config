import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import plugin, { CHECK_VERSION } from "./server.ts";
import { imageType, MAX_BYTES } from "./policy.ts";

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M0 0L20 20"/></svg>';
function setup(options: { offline?: boolean; refreshFails?: boolean } = {}) {
  const files = new Map<string, string>([["/checkout/download.svg", svg]]);
  let writes = 0;
  const { bb, harness } = createFakePluginHost({ pluginId: "project-logo", agentSkillIds: ["project-logo"], sdk: {
    projects: { get: async () => ({ id: "p", name: "changan-update", kind: "standard", sources: [
      { type: "local_path", hostId: "remote-host", path: "/checkout", isDefault: true },
    ] }) },
    files: {
      list: async () => { if (options.offline) throw new Error("Host offline"); return { entries: [] }; },
      read: async (args: { hostId?: string; rootPath?: string; path: string }) => {
        assert.equal(args.hostId, "remote-host"); assert.equal(args.rootPath, "/checkout");
        const content = files.get(args.path);
        if (content === undefined) throw new Error("ENOENT");
        return { content, sizeBytes: Buffer.byteLength(content), contentEncoding: "utf8" };
      },
      write: async (args: { hostId?: string; path: string; content: string; expectedSha256?: string | null }) => {
        assert.equal(args.hostId, "remote-host"); assert.equal(args.expectedSha256, null);
        if (files.has(args.path)) throw new Error("File already exists");
        ++writes; files.set(args.path, Buffer.from(args.content, "base64").toString()); return { ok: true };
      },
    },
    environments: { get: async () => ({ hostId: "remote-host" }) },
    threads: { get: async () => ({ projectId: "p", environmentId: "env" }), updatePluginMetadata: async () => ({ metadata: { checked: true } }) },
    plugins: { callRpc: async () => { if (options.refreshFails) throw new Error("disabled"); return { icons: {} }; } },
  } as never });
  return { bb, harness, files, writes: () => writes };
}

test("passive SVG accepted; active content, external resources, malformed or oversized input rejected", () => {
  assert.equal(imageType(Buffer.from(svg)), "svg");
  for (const body of [svg.replace("<path", '<script/><path'), svg.replace("<path", '<path onclick="alert(1)"'),
    svg.replace("<path", '<use href="https://example.com/x"/><path'), svg.replace("<path", '<path fill="url(https://example.com/x)"'),
    '<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"/>', '<html/>', svg.slice(0, -3)]) {
    assert.throws(() => imageType(Buffer.from(body)));
  }
  assert.throws(() => imageType(Buffer.alloc(MAX_BYTES + 1)));
});

test("new standard thread gets both tools and context instructions; checked/personal threads skip", async () => {
  const { bb, harness } = setup(); await plugin(bb);
  const ctx = makePluginAgentConfigurationContext({ project: { kind: "standard", name: "changan-update" } });
  const config = await harness.behavior.resolveAgentConfiguration(ctx);
  assert.match(JSON.stringify(config), /FIRST user message/);
  assert.match(JSON.stringify(config), /project_logo_install/);
  const checked = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ pluginMetadata: { checked: true, checkVersion: 2 } }));
  assert.doesNotMatch(JSON.stringify(checked), /project_logo_status/);
  const personal = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ project: { kind: "personal" } }));
  assert.doesNotMatch(JSON.stringify(personal), /project_logo_status/);
  await harness.lifecycle.dispose();
});

test("concurrent installs write once to actual project source host, refresh sidebar, preserve original SVG", async () => {
  const s = setup(); await plugin(s.bb);
  const results = await Promise.all([1,2].map(() => s.harness.behavior.runCli(["install", "p", "download.svg", "project asset"])));
  assert.ok(results.every(r => r.exitCode === 0)); assert.equal(s.writes(), 1);
  assert.equal(s.files.get("/checkout/.bb/icon.svg"), svg);
  assert.equal(s.harness.inspection.sdk.callsTo("plugins.callRpc").length, 1);
  await s.harness.lifecycle.dispose();
});

test("an existing favicon wins and is never overwritten", async () => {
  const s = setup(); s.files.set("/checkout/favicon.svg", svg); await plugin(s.bb);
  const result = await s.harness.behavior.runCli(["install", "p", "download.svg", "project asset"]);
  assert.match(result.stdout ?? "", /existing/); assert.equal(s.writes(), 0);
  await s.harness.lifecycle.dispose();
});

test("offline source and directory escape cannot cause a write", async () => {
  for (const offline of [true, false]) {
    const s = setup({ offline }); await plugin(s.bb);
    const result = await s.harness.behavior.runCli(["install", "p", "../outside.svg", "project asset"]);
    assert.notEqual(result.exitCode, 0);
    assert.equal(s.writes(), 0); await s.harness.lifecycle.dispose();
  }
});

test("missing status remains retryable; saved image survives unavailable Machine Tabs", async () => {
  const s = setup({ refreshFails: true }); await plugin(s.bb);
  await s.harness.behavior.callAgentTool("project_logo_status", {}, { threadId: "t", projectId: "p" });
  assert.equal(s.harness.inspection.sdk.callsTo("threads.updatePluginMetadata").length, 0);
  const result = await s.harness.behavior.runCli(["install", "p", "download.svg", "project asset"]);
  assert.match(result.stdout ?? "", /installed/); assert.equal(s.writes(), 1);
  await s.harness.lifecycle.dispose();
});


test("legacy checked threads retry contextual generation", async () => {
  const s = setup(); await plugin(s.bb);
  const config = await s.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({
    project: { kind: "standard" }, pluginMetadata: { checked: true },
  }));
  assert.match(JSON.stringify(config), /CREATE/);
  assert.match(JSON.stringify(config), /project_logo_install/);
  await s.harness.behavior.callAgentTool("project_logo_install", { svg, sourceUrl: "generated from project context" }, { threadId: "t", projectId: "p" });
  assert.equal(s.files.get("/checkout/.bb/icon.svg"), svg);
  assert.equal(s.harness.inspection.sdk.callsTo("threads.updatePluginMetadata").length, 1);
  await s.harness.lifecycle.dispose();
});

test("the skill stays available after the automatic check, without tools", async () => {
  const s = setup(); await plugin(s.bb);
  const checked = await s.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({
    project: { kind: "standard" }, pluginMetadata: { checked: true, checkVersion: CHECK_VERSION },
  }));
  assert.deepEqual(checked, { tools: [], skills: ["project-logo"], instructions: null });
  const fresh = await s.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({
    project: { kind: "standard" }, pluginMetadata: {},
  }));
  assert.deepEqual(fresh.skills, ["project-logo"]);
  assert.match(JSON.stringify(fresh.tools), /project_logo_install/);
  await s.harness.lifecycle.dispose();
});

test("generated icons reject active SVG and ambiguous inputs without completing setup", async () => {
  for (const input of [{ svg: '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>' },
    { svg, filePath: "download.svg" }, {}]) {
    const s = setup(); await plugin(s.bb);
    await assert.rejects(() => s.harness.behavior.callAgentTool("project_logo_install", { ...input, sourceUrl: "generated" }, { threadId: "t", projectId: "p" }));
    assert.equal(s.writes(), 0);
    assert.equal(s.harness.inspection.sdk.callsTo("threads.updatePluginMetadata").length, 0);
    await s.harness.lifecycle.dispose();
  }
});

test("existing icon completes current-version status and create preserves it", async () => {
  const s = setup(); s.files.set("/checkout/favicon.svg", svg); await plugin(s.bb);
  await s.harness.behavior.callAgentTool("project_logo_status", {}, { threadId: "t", projectId: "p" });
  assert.equal(s.harness.inspection.sdk.callsTo("threads.updatePluginMetadata").length, 1);
  const result = await s.harness.behavior.runCli(["create", "p", svg]);
  assert.match(result.stdout ?? "", /existing/); assert.equal(s.writes(), 0);
  await s.harness.lifecycle.dispose();
});

test("thread host wins over offline default for status and install", async () => {
  const s = setup();
  s.harness.sdk.stub("projects.get", async () => ({ id: "p", name: "project", kind: "standard", sources: [
    { type: "local_path", hostId: "offline-default", path: "/mac", isDefault: true },
    { type: "local_path", hostId: "remote-host", path: "/checkout", isDefault: false },
  ] }) as never);
  s.harness.sdk.stub("files.list", async (args: { hostId?: string }) => {
    assert.equal(args.hostId, "remote-host");
    return { entries: [] } as never;
  });
  await plugin(s.bb);
  const result = await s.harness.behavior.callAgentTool("project_logo_status", {}, { threadId: "t", projectId: "p" });
  assert.match(JSON.stringify(result), /remote-host/);
  await s.harness.behavior.callAgentTool("project_logo_install", { svg, sourceUrl: "generated" }, { threadId: "t", projectId: "p" });
  assert.equal(s.files.get("/checkout/.bb/icon.svg"), svg);
  assert.equal(s.writes(), 1);
  await s.harness.lifecycle.dispose();
});

test("missing source on thread machine never falls back to another machine", async () => {
  const s = setup();
  s.harness.sdk.stub("environments.get", async () => ({ hostId: "other-host" }) as never);
  await plugin(s.bb);
  for (const name of ["project_logo_status", "project_logo_install"]) {
    await assert.rejects(() => s.harness.behavior.callAgentTool(name, name.endsWith("install") ? { svg, sourceUrl: "generated" } : {}, { threadId: "t", projectId: "p" }), /No project source checkout on current thread host/);
  }
  assert.equal(s.harness.inspection.sdk.callsTo("files.list").length, 0);
  assert.equal(s.writes(), 0);
  await s.harness.lifecycle.dispose();
});
