#!/usr/bin/env node
// First local turn after a synthetic remote retry. Restore the isolated BB conversation.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { probeHistory } from './probe-history.mjs';
const history = probeHistory(process.env.BB_ORIGIN_PROBE_THREAD);
const args=[];
const input=process.argv.slice(2);
for(let i=0;i<input.length;i++) {
  if (['--resume','--session-id','--resume-session-at'].includes(input[i])) { i++; continue; }
  if (!/^--(?:resume|session-id|resume-session-at)=/.test(input[i])) args.push(input[i]);
}
const persistent=process.env.BB_ORIGIN_PROBE_ID?.startsWith('auto-');
if(persistent) args.unshift(new URL('./live-quota.mjs',import.meta.url).pathname);
const child=spawn(persistent?process.execPath:'claude',args,{stdio:['pipe','inherit','inherit']});
for(const sig of ['SIGTERM','SIGINT','SIGHUP']) process.on(sig,()=>child.kill(sig));
child.on('exit',code=>{process.exitCode=code??1;lines.close();});
let restored=false;
const lines=createInterface({input:process.stdin});
for await (const line of lines) {
  const packet=JSON.parse(line);
  if (!restored && packet.type==='user' && packet.message?.role==='user') {
    const blocks=packet.message.content;
    packet.message.content=[...history,
      ...(Array.isArray(blocks)?blocks:[{type:'text',text:blocks}])];
    restored=true;
  }
  child.stdin.write(JSON.stringify(packet)+'\n');
}
child.stdin.end();
