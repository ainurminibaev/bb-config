import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startVisibleInterval } from '../lib/visible-interval.ts';

function fakePage() {
  const listeners = new Set<() => void>();
  return {
    visibilityState: 'visible',
    addEventListener: (_: string, fn: () => void) => { listeners.add(fn); },
    removeEventListener: (_: string, fn: () => void) => { listeners.delete(fn); },
    fire() { for (const fn of listeners) fn(); },
    listeners,
  };
}

test('polls while shown, not while hidden, and at once when shown again', () => {
  const page = fakePage();
  let tick: () => void = () => undefined; let cleared = false;
  let runs = 0;
  const stop = startVisibleInterval(() => { runs++; }, 5000, page, { set: (fn) => { tick = fn; return 1; }, clear: () => { cleared = true; } });
  tick(); assert.equal(runs, 1);
  page.visibilityState = 'hidden'; page.fire(); tick(); tick(); assert.equal(runs, 1);
  page.visibilityState = 'visible'; page.fire(); assert.equal(runs, 2);
  stop(); assert.equal(cleared, true); assert.equal(page.listeners.size, 0);
});
