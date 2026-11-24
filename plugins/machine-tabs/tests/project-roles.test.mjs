import assert from "node:assert/strict";
import test from "node:test";
import { activeRoles, projectRolesFirst } from "../lib/project-roles.ts";

test("every active role fits on page one and ordinary roots retain native order", () => {
  const items = Array.from({length: 10}, (_, i) => ({kind: "thread", node: {thread: {id: String(i), updatedAt: i}}}));
  const ranks = activeRoles(items.slice(2, 9).map(({node}, i) => ({
    kind: i % 2 ? "agent" : "orchestrator", active: {kind: "thread", threadId: node.thread.id}
  })));
  const result = projectRolesFirst(items, ranks);
  assert.deepEqual(result.items.map(i => i.node.thread.updatedAt), [7,5,3,8,6,4,2,0,1,9]);
  assert.equal(result.firstPage, 7);
  assert.equal(projectRolesFirst(items, activeRoles([null, {}, {kind:"external"}])).items, items);
});
