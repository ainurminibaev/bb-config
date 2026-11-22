import test from 'node:test';
import assert from 'node:assert/strict';
import {quotaWindow} from '../bin/quota-window.mjs';
import {nextRoute,recordQuota} from '../routing.mjs';
test('Tru 04:20 UTC reset keeps subsequent turns on UA until the reported time',()=>{
  const now=Date.UTC(2026,10,19,1,16);
  const msg={type:'assistant',error:'rate_limit',message:{content:[{type:'text',text:"You've hit your 5-hour limit · resets 4:20am (UTC)"}]}};
  const {resetAt}=quotaWindow(msg,now);
  assert.equal(resetAt,Date.UTC(2026,10,19,4,20));
  const holds=new Map(), hosts=['Tru','UA'].map(host=>({host,account:host}));
  recordQuota(holds,{account:'Tru'},{category:'rate-limit'},resetAt,now);
  const route=time=>nextRoute({originHost:'Tru',hosts,holds,now:time}).executionHost;
  assert.deepEqual([now,now+60000,resetAt-1,resetAt].map(route),['UA','UA','UA','Tru']);
});
test('unsupported time zones leave the reset unknown and structured Unix seconds are normalized',()=>{
  const now=Date.UTC(2026,10,19,1);
  const error={type:'assistant',error:'rate_limit',message:{content:[{type:'text',text:"You've hit your 5-hour limit · resets 4:20am (EST)"}]}};
  assert.equal(quotaWindow(error,now).resetAt,null);
  const resetAt=now+60000;
  assert.equal(quotaWindow({type:'rate_limit_event',rate_limit_info:{status:'rejected',rateLimitType:'five_hour',resetsAt:resetAt/1000}},now).resetAt,resetAt);
});
