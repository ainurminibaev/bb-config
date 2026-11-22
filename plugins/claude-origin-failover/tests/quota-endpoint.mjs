#!/usr/bin/env node
// Local provider fixture for exercising the installed Claude CLI's quota error protocol.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const config = await mkdtemp(join(tmpdir(), 'claude-quota-fixture-'));
const reset = Math.floor(Date.now() / 1000) + 90;
const endpoint = createServer((req, res) => {
  req.resume();
  if (process.env.BB_ORIGIN_PROBE_RECEIPT && req.method === "POST" && req.url.startsWith("/v1/messages")) writeFileSync(process.env.BB_ORIGIN_PROBE_RECEIPT,"429",{mode:0o600});
  res.writeHead(429, {
    'content-type': 'application/json',
    'retry-after': '90',
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-reset': String(reset),
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    'anthropic-ratelimit-unified-5h-reset': String(reset),
  });
  res.end(JSON.stringify({type:'error',error:{type:'rate_limit_error',message:'Synthetic five-hour quota exhausted'}}));
});
await new Promise(resolve => endpoint.listen(0, '127.0.0.1', resolve));
try {
  const env = {
    PATH:process.env.PATH, HOME:config, CLAUDE_CONFIG_DIR:config,
    ANTHROPIC_API_KEY:'local-fixture', ANTHROPIC_BASE_URL:'http://127.0.0.1:'+endpoint.address().port,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1', CLAUDE_CODE_MAX_RETRIES:'0',
  };
  const args = process.argv.slice(2);
  // The fixture uses a fresh configuration directory and has no real session to resume.
  const filtered = [];
  for (let i=0; i<args.length; i++) {
    if (args[i]==='--resume' || args[i]==='--resume-session-at') { i++; continue; }
    if (/^--resume(?:-session-at)?=/.test(args[i])) continue;
    filtered.push(args[i]);
  }
  const child = spawn('claude',filtered,{env,stdio:['inherit','pipe','inherit']});
  // The BB bridge can keep a CLI alive across turns. Finish this fixture after one result.
  let partial = '';
  child.stdout.on('data',chunk=>{
    process.stdout.write(chunk);
    partial += chunk.toString();
    const lines=partial.split('\n');
    partial=lines.pop();
    for(const line of lines) {
      try {
        if(JSON.parse(line).type==='result') setTimeout(()=>child.kill('SIGTERM'),300).unref();
      } catch {}
    }
  });
  for (const sig of ['SIGTERM','SIGINT']) process.once(sig,()=>child.kill(sig));
  const code = await new Promise((resolve,reject)=>{
    child.once('error',reject);
    child.once('exit',code=>resolve(code ?? 1));
  });
  process.exitCode=code;
} finally {
  endpoint.closeAllConnections();
  await new Promise(resolve=>endpoint.close(resolve));
  await rm(config,{recursive:true,force:true});
}
