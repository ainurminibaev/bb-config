import test from 'node:test';
import assert from 'node:assert/strict';
import {dispatchTurn} from '../dispatch.mjs';

test('inventory removal, new account and duplicate login while the same turn retries', async () => {
  const inventories = [
    [['Tru','A'],['alias','A'],['UA','B']],
    [['alias','A'],['UA','B']],
    [['alias','A'],['new','C']],
  ];
  const attempts = [];
  const turn = {id:'one'};
  const holds = new Map();
  const result=await dispatchTurn({
    originHost:'Tru',turn,holds,clock:()=>10,
    inventory:async()=>inventories.shift().map(([host,account])=>({host,account})),
    send:async(route,input)=>{
      assert.equal(input,turn);
      attempts.push(route.account);
      return route.account==='C'?{status:'done'}:
        {status:'rejected-before-execution',errorInfo:{category:'rate-limit'},reset:20};
    },
  });
  assert.equal(result.route.executionHost,'new');
  assert.deepEqual(attempts,['A','B','C']);
});

for (const [title,hosts,earliest] of [
  ['empty pool',[],null],['all accounts held',[{host:'one',account:'A'},{host:'two',account:'B'}],20],
]) test(title,async()=>{
  const result=await dispatchTurn({originHost:'Tru',turn:{},inventory:async()=>hosts,
    holds:new Map([['A',40],['B',20]]),clock:()=>10,send:async()=>assert.fail('unexpected send')});
  assert.equal(result.status,'waiting');
  assert.equal(result.route.waitUntil,earliest);
});
