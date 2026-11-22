import test from 'node:test';
import assert from 'node:assert/strict';
import register from '../dist/server.js';

function fixture(){
  const kv = new Map(), methods={}, events={};
  const settings={pilotOrigin:'host_tru',pilotBackup:'host_ua',testThread:'',quotaProbe:'',testRemoteHost:''};
  const state={originReset:0,backupReset:0,connected:true,stopFails:false,status:'idle',stops:0};
  let resolve;
  register({
    settings:{define:()=>({get:async()=>settings})},storage:{kv},
    events:{on:(name,fn)=>events[name]=fn},
    rpc:{experimental_invalidate:()=>{},register:(_,handlers)=>Object.assign(methods,handlers)},
    providers:{experimental_contributeEnv:(_,fn)=>resolve=fn},
    sdk:{files:{write:async()=>{},read:async({path})=>({content:JSON.stringify({resetAt:path.endsWith('.backup')?state.backupReset:state.originReset})})},hosts:{get:async()=>({threadStorageRootPath:'/storage',status:state.connected?'connected':'offline'})},
      environments:{get:async()=>({hostId:'host_tru'})},
      threads:{queuedMessages:{list:async()=>state.queue??[],send:async({queuedMessageId})=>{state.sent=queuedMessageId;}},
        retry:async()=>{throw Error('HTTP 409: Turn original already has a retry waiting on thread test.');},
        get:async({threadId:id})=>({id,environmentId:'env',providerId:'claude-code',status:state.status}),
        stop:async()=>{state.stops++; if(state.stopFails)throw Error('busy');}}}
  });
  return {state,methods,events,resolve:(threadId,hostId='host_tru')=>resolve({threadId,hostId})};
}

test('thread opt-in is isolated, idempotent, persists through its retry, and turns off', async()=>{
  const {state,methods,events,resolve}=fixture();
  const input={threadId:'test',enabled:true};
  await methods.setRetryPreference(input);
  await methods.setRetryPreference(input);
  assert.equal(state.stops,1);
  assert.deepEqual(await resolve('other'),[]);
  assert.deepEqual(await resolve('test','host_elsewhere'),[]);
  assert.ok((await resolve('test')).some(x=>x.name==='BB_ORIGIN_PROBE_ID'));
  const available=methods['provider-retry.v1.availability'];
  const request={threadId:'test',requestId:'creq_123'};
  state.originReset=Date.now()+120000;
  state.connected=false;
  assert.equal((await available(request)).kind,'not-routed');
  state.connected=true;
  assert.equal((await available(request)).kind,'ready');
  assert.equal((await available({...request,requestId:'different'})).kind,'not-routed');
  await events['thread.idle']({thread:{id:'test'},lastAssistantText:'backup answer'});
  const stage=async()=>(await resolve('test')).find(x=>x.name==='BB_ORIGIN_PROBE_STAGE').value;
  assert.equal(await stage(),'backup');
  state.backupReset=Date.now()+60000;
  assert.equal((await available(request)).kind,'blocked');
  state.originReset=0;
  assert.equal(await stage(),'origin');
  await methods.setRetryPreference({...input,enabled:false});
  assert.ok((await resolve('test')).some(x=>x.value.endsWith('/probe-return.mjs')));
  await events['thread.idle']({thread:{id:'test'},lastAssistantText:'restored'});
  assert.deepEqual(await resolve('test'),[]);
});

test('active turn and failed runtime stop preserve the old preference',async()=>{
  const {state,methods,resolve}=fixture();
  const input={threadId:'test',enabled:true};
  state.status='active';
  await assert.rejects(methods.setRetryPreference(input));
  assert.equal(state.stops,0);
  state.status='idle';state.stopFails=true;
  await assert.rejects(methods.setRetryPreference(input));
  assert.deepEqual(await resolve('test'),[]);
});

test('quota on a later retry dispatches the existing original queue entry',async()=>{
  const {state,methods,events}=fixture();
  state.status='error';
  state.queue=[{id:'unrelated',payload:{kind:'retry',retryOfTurnRequestId:'other'}},
    {id:'scheduled',payload:{kind:'retry',retryOfTurnRequestId:'original'}}];
  await events['turn.failed']({threadId:'test',turnId:'turn2',requestId:'second',
    errorInfo:{category:'rate-limit'},rateLimits:{kind:'subscription-window',status:'blocked',
    windows:[{status:'blocked',resetsAtMs:Date.now()+60000}]}});
  await methods.setRetryPreference({threadId:'test',enabled:true});
  assert.equal(state.sent,'scheduled');
});
