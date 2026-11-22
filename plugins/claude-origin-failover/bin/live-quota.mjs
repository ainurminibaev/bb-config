// Pass the origin CLI stream through unchanged. Arm exactly one backup send only
// when the real CLI emits its rejected subscription window for this experiment.
import {quotaWindow} from './quota-window.mjs';
import {spawn} from 'node:child_process';
import {writeFileSync,renameSync} from 'node:fs';
import {createInterface} from 'node:readline';
const receipt=process.env.BB_ORIGIN_PROBE_RECEIPT;
const child=spawn('claude',process.argv.slice(2),{stdio:['inherit','pipe','inherit']});
for(const signal of ['SIGTERM','SIGINT','SIGHUP']) process.on(signal,()=>child.kill(signal));
let rejected=null;
const lines=createInterface({input:child.stdout});
lines.on('line',line=>{
  let msg;
  try { msg=JSON.parse(line); } catch {}
  const window=quotaWindow(msg,Date.now());
  if (window) {
    if (!rejected || (window.resetAt ?? 0) > (rejected.resetAt ?? 0)) {
      rejected=window;
      const tmp=receipt+'.'+process.pid+'.tmp';
      writeFileSync(tmp,JSON.stringify(window),{mode:0o600});
      renameSync(tmp,receipt);
    }
  }
  process.stdout.write(line+'\n');
  if (rejected && msg?.type==='result') setTimeout(()=>child.kill('SIGTERM'),300).unref();
});
child.on('error',()=>{process.exitCode=1});
child.on('exit',code=>{process.exitCode=code??1});
