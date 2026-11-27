import { test } from "node:test";
import assert from "node:assert/strict";
import { runsCodex, shouldEnroll } from "./policy.ts";
import { CASCADE_PROVIDER_ID } from "./cascade-passport.ts";

const T0 = 1_000;
const base = { providerId: "codex", parentThreadId: "thr_p", visibility: "visible", createdAt: T0 + 1, archivedAt: null };

test("без каскада всё как раньше: Codex подключается, Claude нет; ступень игнорируется", () => {
  assert.equal(shouldEnroll(base, T0), true);
  assert.equal(shouldEnroll({ ...base, providerId: "claude-code" }, T0), false);
  assert.equal(shouldEnroll({ ...base, providerId: "claude-code" }, T0, "codex"), false);
  assert.equal(runsCodex({ providerId: "codex" }), true);
});

test("тред каскада: под надзор — только на ступени Codex", () => {
  const cascade = { ...base, providerId: CASCADE_PROVIDER_ID };
  assert.equal(shouldEnroll(cascade, T0, "codex"), true);
  assert.equal(shouldEnroll(cascade, T0, "claude-code"), false);
  // Каскад не ответил — ступень неизвестна.
  assert.equal(shouldEnroll(cascade, T0, null), false);
  assert.equal(shouldEnroll(cascade, T0), false);
});
