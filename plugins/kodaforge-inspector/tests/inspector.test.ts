import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  headerSlot, autoOpenWorkspace, belongsTo, followsReleases, inspect, attachLayout, effectiveLayout, layoutOf, threadInWorkspace } from "../inspector";
function fixture() {
  const dom = new JSDOM(
    `<div class="kf-root"><nav aria-label="Views"></nav><div data-panel id="main"><div data-panel id="editors"><div id="original"><input value="unsaved draft"></div></div></div><footer><button title="Switch branch"></button><button title="Toggle Terminal (⌃&#96;)"></button></footer></div>`,
  );
  return dom.window.document;
}
test("compatible upstream and safe restoration retain original nodes and draft", () => {
  const doc = fixture();
  const found = inspect(doc, () => true);
  assert.equal(found.state, "compatible");
  const original = found.original!;
  original.inert = false;
  const input = original.querySelector("input");
  const layer = attachLayout(found.editors!, original);
  assert.equal(original.inert, true);
  assert.equal(inspect(doc, () => true).original, original);
  layer.mode("code");
  assert.equal(original.inert, false);
  layer.dispose();
  layer.dispose();
  assert.equal(doc.querySelectorAll("[data-kfi-owned]").length, 0);
  assert.equal(original.querySelector("input"), input);
  assert.equal(input?.value, "unsaved draft");
  assert.equal(found.editors!.hasAttribute("data-kfi-layout"), false);
});
test("missing contract fails closed without modifying upstream DOM", () => {
  const doc = fixture();
  doc.querySelector("footer")!.remove();
  const before = doc.body.innerHTML;
  assert.equal(inspect(doc, () => true).state, "incompatible");
  assert.equal(doc.body.innerHTML, before);
});
test("retained hidden workspaces ignored, ambiguous visible workspaces rejected", () => {
  const doc = fixture();
  doc.body.append(doc.querySelector(".kf-root")!.cloneNode(true));
  assert.equal(inspect(doc, () => true).state, "incompatible");
  assert.equal(
    inspect(doc, (e) => e === doc.body.firstElementChild).state,
    "compatible",
  );
  assert.equal(inspect(doc, () => false).state, "waiting");
});
test("restoration preserves preexisting inert state", () => {
  const doc = fixture();
  const found = inspect(doc, () => true);
  found.original!.inert = true;
  const layer = attachLayout(found.editors!, found.original!);
  layer.mode("code");
  layer.dispose();
  assert.equal(found.original!.inert, true);
});

test("only a manually opened KodaForge thread workspace supplies a conversation", () => {
  const id = "thr_" + "example";
  const path = "/plugins/kodaforge/forge/thread/" + id;
  assert.equal(threadInWorkspace(path), id);
  assert.equal(threadInWorkspace(path + "/"), id);
  for (const outside of [
    "/projects/demo/threads/" + id,
    "/plugins/kodaforge/forge",
    "/plugins/kodaforge/forge/project/demo",
    path + "/file",
    path + "%2Fother",
    "",
  ]) {
    assert.equal(threadInWorkspace(outside), null);
  }
});

test("unexpected extra native content leaves the editor untouched", () => {
  const doc = fixture();
  doc.querySelector("#editors")!.append(doc.createElement("section"));
  assert.equal(inspect(doc, () => true).state, "incompatible");
  assert.equal(doc.querySelector("[data-kfi-layout]"), null);
});

test("only a stored explicit choice changes the layout", () => {
  assert.equal(layoutOf("center"), "center");
  assert.equal(layoutOf("native"), "native");
  for (const unset of ["ask", "", undefined, null, true, "sidebar"]) {
    assert.equal(layoutOf(unset), "ask");
  }
});

test("a project's own choice wins over the one saved for all", () => {
  assert.equal(effectiveLayout(undefined, "ask"), "ask");
  assert.equal(effectiveLayout(undefined, "center"), "center");
  assert.equal(effectiveLayout("native", "center"), "native");
  assert.equal(effectiveLayout("center", "native"), "center");
  assert.equal(effectiveLayout("garbage", "native"), "native");
});

test("only the selected dialog's plain page is redirected, and only when switched on", () => {
  const id = "thr_" + "example";
  const page = "/projects/demo/threads/" + id;
  assert.equal(autoOpenWorkspace(page, true, id), "/plugins/kodaforge/forge/thread/" + id);
  assert.equal(autoOpenWorkspace(page + "/", true, " " + id + " "), "/plugins/kodaforge/forge/thread/" + id);
  for (const [route, on, selected] of [
    [page, false, id],
    [page, true, ""],
    [page, true, undefined],
    [page, true, "thr_other"],
    [page + "#msg=4", true, id],
    [page + "?file=a", true, id],
    ["/plugins/kodaforge/forge/thread/" + id, true, id],
  ] as const) {
    assert.equal(autoOpenWorkspace(route, on, selected), null);
  }
});

test("follows releases from the catalog and from the owner's fork, nothing else", async () => {
  const policy = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("../../kodaforge-compat/fork.json", import.meta.url), "utf8"));
  assert.ok(followsReleases(`git:${policy.repository}@semver:${policy.tagPrefix}:${policy.range}`));
  assert.ok(followsReleases("git:https://github.com/Kodaks94/bb-plugin-kodaforge.git@semver:>=0.7.0 <1.0.0"));
  assert.equal(followsReleases("path:/srv/kodaforge"), false);
  assert.equal(followsReleases(undefined), false);
});

test("the editor's switches in BB's title bar count as part of it", () => {
  const { document } = new JSDOM('<header><div data-kodaforge-header><button id="a"></button></div><button id="b"></button></header><div class="kf-root"><button id="c"></button></div>').window;
  const root = document.querySelector(".kf-root")!;
  assert.deepEqual(["a", "b", "c"].map((id) => belongsTo(root, document.getElementById(id)!)), [true, false, true]);
});
test("the view button uses the only visible title bar slot, or none", () => {
  const doc = new JSDOM(`<header><div data-kodaforge-header id="a"></div></header><header hidden><div data-kodaforge-header id="b"></div></header>`).window.document;
  const shown = (element: HTMLElement) => !element.closest("[hidden]");
  assert.equal(headerSlot(doc, shown)?.id, "a");
  assert.equal(headerSlot(doc, () => true), null);
  assert.equal(headerSlot(doc, () => false), null);
});
