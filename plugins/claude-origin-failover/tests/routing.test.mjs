import assert from 'node:assert/strict';
import test from 'node:test';
import { nextRoute, recordQuota } from '../routing.mjs';

test('two threads share quota state; tool execution keeps its original machine', () => {
  const holds = new Map();
  const hosts = [{host:'Tru', account:'A'}, {host:'copy', account:'A'}, {host:'UA', account:'B'}];
  const select = (originHost, now, previous) => nextRoute({originHost, previous, now, hosts, holds});
  const first = select('Tru', 0);
  const second = select('UA', 0);
  const quota = {category:'rate-limit', providerCode:'rate_limit_event', httpStatusCode:429};
  recordQuota(holds, first, quota, 30, 1);
  assert.deepEqual(select('Tru', 2, first), {originHost:'Tru', executionHost:'UA', account:'B'});
  assert.deepEqual(select('UA', 2, second), second);
  recordQuota(holds, second, quota, 60, 3);
  assert.deepEqual(select('Tru', 3), {originHost:'Tru', waitUntil:30});
  assert.deepEqual(select('UA', 30), {originHost:'UA', executionHost:'Tru', account:'A'});
});

test('late quota event after re-login is attributed to the original login', () => {
  const holds = new Map();
  const previous = {originHost:'one',executionHost:'one',account:'old'};
  const hosts = [{host:'one',account:'new'}];
  recordQuota(holds, previous, {category:'rate-limit'}, 30, 1);
  recordQuota(holds, previous, {category:'rate-limit'}, 20, 2);
  assert.equal(holds.get('old'), 30);
  const current = nextRoute({originHost:'one',previous,hosts,holds,now:3});
  assert.equal(current.account,'new');
  recordQuota(holds,current,{category:'auth'},90,4);
  assert.equal(holds.has('new'),false);
  assert.deepEqual(nextRoute({originHost:'one',previous,hosts:[],holds,now:5}),{originHost:'one',waitUntil:null});
});

test('rotate after the last account and return to origin on the next turn after reset', () => {
  const hosts = ['A','B','C','D'].map(host => ({host,account:host}));
  const holds = new Map([['A', 30], ['C', 20]]);
  const route = (previous, now) => nextRoute({originHost:'A',hosts,holds,now,
    previous:{executionHost:previous,account:previous}}).executionHost;
  assert.equal(route('C', 5), 'D');
  holds.set('D', 25);
  assert.equal(route('D', 5), 'B');
  assert.equal(route('B', 25), 'B');
  assert.equal(route('B', 30), 'A');
});
