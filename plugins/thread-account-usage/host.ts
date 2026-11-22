import { experimental_defineHostEntry } from '@get-bb/plugin-sdk/host';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { hostContract } from './host-contract';

// Read-only protocol: never includes the credit consumption method.
function readCodexResets(): Promise<{ email: string | null; count: number | null }> {
  return new Promise(resolve => {
    const child = spawn(process.env.CODEX_BIN || 'codex', ['app-server', '--stdio'], { stdio: ['pipe','pipe','pipe'] });
    const lines = createInterface({ input: child.stdout });
    let done = false, email: string | null = null, count: number | null = null;
    let received = 0;
    const finish = () => {
      if (done) return; done = true; clearTimeout(timer); lines.close();
      child.kill('SIGTERM');
      const kill = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 250); kill.unref();
      resolve({ email, count });
    };
    const timer = setTimeout(finish, 12_000); timer.unref();
    const send = (message: object) => { if (!done) child.stdin.write(JSON.stringify(message)+'\n', error => { if(error) finish(); }); };
    child.stderr.resume(); child.once('error',finish); child.once('close',finish);
    child.stdin.on('error',finish);
    lines.on('line', line => {
      if (done || line.length > 1_000_000) return;
      try {
        const message = JSON.parse(line);
        if (message.id === 1) {
          if (message.error) return finish();
          send({method:'initialized'});
          send({id:2,method:'account/read',params:{refreshToken:false}});
          send({id:3,method:'account/rateLimits/read'});
        } else if (message.id === 2) {
          const value = message.result?.account?.email;
          email = typeof value === 'string' ? value : null;
          if (++received === 2) finish();
        } else if (message.id === 3) {
          const value = message.result?.rateLimitResetCredits?.availableCount;
          const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
          count = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
          if (++received === 2) finish();
        }
      } catch { /* Ignore non-JSON CLI log lines. */ }
    });
    send({id:1,method:'initialize',params:{clientInfo:{name:'bb-thread-account-usage',version:'0.1.1'},capabilities:{experimentalApi:true,requestAttestation:false}}});
  });
}
// Plan fields of the profile Claude Code refreshes in .claude.json (same path BB uses).
async function readClaudeProfile(): Promise<{ email: string | null; organizationType: string | null; rateLimitTier: string | null }> {
  const empty = { email: null, organizationType: null, rateLimitTier: null };
  try {
    const file = join(process.env.CLAUDE_CONFIG_DIR || homedir(), '.claude.json');
    const account = JSON.parse(await readFile(file, 'utf8'))?.oauthAccount;
    const text = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length < 200 ? v : null;
    if (!account || typeof account !== 'object') return empty;
    return { email: text(account.emailAddress), organizationType: text(account.organizationType),
      rateLimitTier: text(account.organizationRateLimitTier) ?? text(account.userRateLimitTier) };
  } catch { return empty; }
}
export default experimental_defineHostEntry({ contract: hostContract, handlers: { codexResets: readCodexResets, claudeProfile: readClaudeProfile } });
