import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchTurn } from '../dispatch.mjs';

const hosts = ['Tru', 'UA'].map(host => ({host, account: host}));
const quota = {status:'rejected-before-execution', errorInfo:{category:'rate-limit'}, reset:30};

test('one simulated refusal, same turn on UA, next turn back on Tru with UA reply', async () => {
  const attempts = [];
  const journal = [];
  let now = 0;
  let previous;
  const holds = new Map();
  async function submit(id) {
    const turn = {id, threadId:'isolated', history:[...journal]};
    const result = await dispatchTurn({turn, originHost:'Tru', previous, inventory:async () => hosts,
      clock:() => now, holds, send:async (route, input) => {
        assert.equal(input, turn);
        attempts.push([input.id,route.executionHost]);
        if (id === 2 && route.executionHost === 'Tru') return quota;
        if (id === 3) assert.deepEqual(input.history, ['Tru/1','UA/2']);
        return {status:'done', text:route.executionHost + '/' + id};
      }});
    assert.equal(result.status,'done');
    previous = result.route;
    journal.push(result.text);
  }
  await submit(1);
  await submit(2);
  now = 30;
  await submit(3);
  assert.deepEqual(attempts, [[1,'Tru'],[2,'Tru'],[2,'UA'],[3,'Tru']]);
  assert.deepEqual(journal, ['Tru/1','UA/2','Tru/3']);
});

test('quota after a possible side effect does not replay the turn', async () => {
  let attempts = 0;
  const result = await dispatchTurn({turn:{id:1}, originHost:'Tru', inventory:async () => hosts,
    clock:()=>0, holds:new Map(), send:async () => {
      attempts++;
      return {...quota, status:'interrupted'};
    }});
  assert.equal(result.status,'interrupted');
  assert.equal(attempts,1);
});
