import { test } from "node:test";
import assert from "node:assert/strict";
import { appliesTo } from "./server.ts";

test("без каскада всё как раньше: Codex и Claude Code получают правило, прочие нет", () => {
  assert.equal(appliesTo("codex"), true);
  assert.equal(appliesTo("claude-code"), true);
  assert.equal(appliesTo("acp-gemini"), false);
});

test("тред каскада получает то же правило", () => {
  assert.equal(appliesTo("agentcli-subscriptions-cascade"), true);
});
