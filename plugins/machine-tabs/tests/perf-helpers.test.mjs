import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadToken } from '../lib/load-token.ts';
import { mayMoveControl } from '../lib/sidebar-view.ts';

test('load token is stable for one bundle URL and differs between builds', () => {
  const a = loadToken('http://x/api/v1/plugin-app-assets/aaaa/app.js');
  assert.equal(a, loadToken('http://x/api/v1/plugin-app-assets/aaaa/app.js'));
  assert.notEqual(a, loadToken('http://x/api/v1/plugin-app-assets/bbbb/app.js'));
  assert.match(a, /^u[0-9a-z]+$/);
});

test('load token falls back to the time without a module URL', () => {
  assert.equal(loadToken(undefined, () => 36 ** 3), '1000');
  assert.equal(loadToken('', () => 35), 'z');
});

// Minimal DOM stand-ins: an element knows whether it is, is inside, or holds navigation.
const el = ({ nav = false, inside = false, holds = false } = {}) => ({
  nodeType: 1,
  matches: () => nav,
  closest: () => (nav || inside ? {} : null),
  querySelector: () => (holds ? {} : null),
});
const text = { nodeType: 3 };
const header = el({ nav: true });
const placed = { isConnected: true, previousSibling: header };
const rec = (target, added = [], removed = []) => ({ target, addedNodes: added, removedNodes: removed });

test('chat output elsewhere does not move the control', () => {
  assert.equal(mayMoveControl([rec(el(), [el(), text]), rec(el(), [], [el()])], placed), false);
});

test('a detached or misplaced control is placed again', () => {
  assert.equal(mayMoveControl([rec(el())], { isConnected: false, previousSibling: header }), true);
  assert.equal(mayMoveControl([rec(el())], { isConnected: true, previousSibling: el() }), true);
  assert.equal(mayMoveControl([rec(el())], { isConnected: true, previousSibling: null }), true);
});

test('changes in or around navigation headers are looked at', () => {
  assert.equal(mayMoveControl([rec(el({ inside: true }))], placed), true);
  assert.equal(mayMoveControl([rec(el(), [el({ holds: true })])], placed), true);
  assert.equal(mayMoveControl([rec(el(), [], [el({ nav: true })])], placed), true);
});
