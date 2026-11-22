#!/usr/bin/env node
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {routeState} from './route-state.mjs';

const env=process.env;
const run=env.BB_ORIGIN_PROBE_ID;
if(!/^auto-[a-f0-9-]+$/.test(run??'') || !env.BB_THREAD_STORAGE) process.exit(64);
const receipt=join(env.BB_THREAD_STORAGE,'quota-probe-'+run);
function read(path) {
  try { return readFileSync(path,'utf8'); } catch(error) { if(error.code!=='ENOENT') throw error; return ''; }
}
const route=routeState(read(receipt),read(receipt+'.backup'));
if(route.stage==='waiting') {
  process.stderr.write('Claude quota windows reset at '+new Date(route.resetAt).toISOString()+'\n');
  process.exit(75);
}
const args=process.argv.slice(2);
const resumeIndex=args.indexOf('--resume');
const session=resumeIndex>=0?args[resumeIndex+1]:args.find(arg=>arg.startsWith('--resume='))?.slice(9);
const slug=process.cwd().replace(/[^a-zA-Z0-9]/g,'-');
const missingLocalSession=session && /^[a-f0-9-]{36}$/i.test(session) &&
  !existsSync(join(env.CLAUDE_CONFIG_DIR||join(env.HOME,'.claude'),'projects',slug,session+'.jsonl'));
const restore=existsSync(receipt+'.return') || missingLocalSession;
const target=route.stage==='backup'?'claude-origin-relay.mjs':restore?'probe-return.mjs':'live-quota.mjs';
const child=spawn(process.execPath,[fileURLToPath(new URL(target,import.meta.url)),...process.argv.slice(2)],{
  stdio:'inherit',env:{...env,BB_ORIGIN_PROBE_RECEIPT:receipt}
});
for(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.on(signal,()=>child.kill(signal));
child.on('error',()=>{process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
