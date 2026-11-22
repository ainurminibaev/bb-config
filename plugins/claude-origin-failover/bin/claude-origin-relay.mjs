#!/usr/bin/env node
// claude-origin-relay — drop-in for the `claude` binary the stock BB Claude bridge launches.
//
//   BB_ORIGIN_REMOTE_HOST unset/empty -> exec the real local claude untouched (passive wrapper).
//   BB_ORIGIN_REMOTE_HOST=<machine>   -> run the turn on claude of that machine, with ZERO native
//                                        tools there; only SDK-MCP calls travel back to this host.
//
// Transport: BB terminals only (bb terminal create/send/output/close). No ssh, no tokens.
// Nothing from this host's environment is forwarded. Arguments and control messages are
// allow-listed; everything else is dropped and logged BY NAME ONLY.
//
// Optional env:
//   BB_ORIGIN_REAL_CLAUDE   path of the real local claude (default: first `claude` in PATH that is not this file)
//   BB_ORIGIN_REMOTE_CWD    isolated cwd on the remote machine (default /tmp/bb-origin-relay/<BB_THREAD_ID>)
//   BB_ORIGIN_RELAY_MCP     "0" = drop SDK MCP servers too (pure zero-tool smoke); default forwards them
//   BB_ORIGIN_RELAY_LOG     log file (default: $BB_THREAD_STORAGE/claude-origin-relay.log or /tmp/…)
//   BB_ORIGIN_RELAY_POLL_MS output poll interval (default 150)
import {gzipSync} from "node:zlib";
import { quotaWindow } from "./quota-window.mjs";
import { probeHistory } from "./probe-history.mjs";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, accessSync, appendFileSync, constants, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const SELF = realpathSync(fileURLToPath(import.meta.url));
const HOST = (process.env.BB_ORIGIN_REMOTE_HOST ?? "").trim();
const LOG = process.env.BB_ORIGIN_RELAY_LOG || join(process.env.BB_THREAD_STORAGE || "/tmp", "claude-origin-relay.log");
const log = (s) => { try { appendFileSync(LOG, `${new Date().toISOString()} [${process.pid}] ${s}\n`); } catch {} };

// ---------- local passthrough ----------
function realClaude() {
  const explicit = (process.env.BB_ORIGIN_REAL_CLAUDE ?? "").trim();
  const candidates = explicit ? [explicit] : [...(process.env.PATH ?? "").split(delimiter).map((d) => join(d, "claude")), join(process.env.HOME ?? "/root", ".local/bin/claude")];
  for (const c of candidates) {
    try { accessSync(c, constants.X_OK); if (realpathSync(c) !== SELF) return c; } catch {}
  }
  return null;
}
// ---------- secret guard ----------
// Looks only at text that is about to be SENT. It never reads credentials from the environment or disk.
function secretGuard() {
  const patterns = [["anthropic-key", /sk-ant-[A-Za-z0-9_-]{16,}/], ["bearer", /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/], ["authorization-field", /"(authorization|x-api-key|access_token|refresh_token|accessToken|refreshToken)"\s*:\s*"[^"]{8,}"/i]];
  return (text) => {
    for (const [n, re] of patterns) if (re.test(text)) return `pattern ${n}`;
    return null;
  };
}

// ---------- argv allow-list ----------
// value: true = takes a value. Only these reach the remote claude.
const ARG_ALLOW = {
  "--output-format": true, "--input-format": true, "--verbose": false, "--model": true, "--fallback-model": true,
  "--effort": true, "--thinking": true, "--thinking-display": true, "--max-thinking-tokens": true, "--max-turns": true,
  "--permission-prompt-tool": true, "--permission-mode": true, "--resume": true, "--session-id": true,
  "--resume-session-at": true, "--fork-session": false, "--include-partial-messages": false,
  "--replay-user-messages": false, "--allowedTools": true, "--disallowedTools": true, "--betas": true,
  "--print": false, "-p": false,
};
// Known value-taking flags we deliberately DROP (local paths, local config, privilege).
const ARG_DROP_VALUE = new Set(["--system-prompt","--append-system-prompt","--settings", "--plugin-dir", "--add-dir", "--mcp-config", "--setting-sources", "--tools", "--agents", "--debug-file", "--debug-to-stderr", "--cwd", "--permission-prompt-tool-name", "--json-schema", "--workload"]);
function filterArgs(argv) {
  const kept = [], dropped = []; let sawPrint = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("-")) { dropped.push("<positional>"); continue; }
    const eq = a.indexOf("="); const name = eq > 0 ? a.slice(0, eq) : a; let value = eq > 0 ? a.slice(eq + 1) : undefined;
    const allowed = Object.hasOwn(ARG_ALLOW, name);
    const takesValue = allowed ? ARG_ALLOW[name] : (ARG_DROP_VALUE.has(name) || (value === undefined && i + 1 < argv.length && !argv[i + 1].startsWith("-")));
    if (takesValue && value === undefined) value = argv[++i];
    if (!allowed) { dropped.push(name); continue; }
    if (name === "--print" || name === "-p") sawPrint = true;
    if (name === "--permission-mode" && value === "bypassPermissions") { value = "default"; dropped.push("--permission-mode=bypassPermissions(->default)"); }
    if (name === "--allowedTools" || name === "--disallowedTools") {
      // native tool names mean nothing remotely; keep only MCP tools (served from the origin over the control channel)
      value = String(value).split(",").map((s) => s.trim()).filter((s) => s.startsWith("mcp__")).join(",");
      if (!value) continue;
    }
    kept.push(ARG_ALLOW[name] ? `${name}=${value}` : name);
  }
  // forced, non-negotiable: no native tools, no remote-machine settings/CLAUDE.md, no remote MCP configs, no memory
  kept.push("--tools=", "--setting-sources=", "--strict-mcp-config", `--settings=${JSON.stringify({ autoMemoryEnabled: false })}`);
  void sawPrint;
  return { kept, dropped };
}

// ---------- control-channel allow-list (origin bridge -> remote claude) ----------
const CONTROL_ALLOW = new Set(["initialize", "interrupt", "set_permission_mode", "set_model", "set_max_thinking_tokens", "mcp_message", "mcp_status", "get_status", "get_usage", "stop_task", "rename_session", "set_prompt_suggestions_paused"]);
const INIT_ALLOW = new Set(["subtype", "hooks", "sdkMcpServers", "sdkMcpServerConfigs", "sdkMcpServerManifests", "jsonSchema", "systemPrompt", "appendSystemPrompt", "planModeInstructions", "systemPromptSnapshot", "appendSystemPromptSnapshot", "promptSuggestions", "agentProgressSummaries"]);
const MCP_ON = process.env.BB_ORIGIN_RELAY_MCP !== "0";
// returns {forward: string|null, reply: string|null}
function filterInbound(line) {
  let m; try { m = JSON.parse(line); } catch { return { forward: null, reply: null, note: "non-json-dropped" }; }
  if (m.type === "control_request") {
    const sub = m.request?.subtype;
    if (!CONTROL_ALLOW.has(sub)) {
      return { forward: null, note: `control:${sub}:refused`, reply: JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: m.request_id, error: `claude-origin-relay: control request "${sub}" is not forwarded to a remote account` } }) };
    }
    if (sub === "initialize") {
      const droppedKeys = [];
      for (const k of Object.keys(m.request)) if (!INIT_ALLOW.has(k)) { droppedKeys.push(k); delete m.request[k]; }
      if (!MCP_ON) for (const k of ["sdkMcpServers", "sdkMcpServerConfigs", "sdkMcpServerManifests"]) delete m.request[k];
      return { forward: JSON.stringify(m), reply: null, note: `control:initialize keys=${Object.keys(m.request).join(",")} dropped=${droppedKeys.join(",") || "-"} mcpServers=${(m.request.sdkMcpServers ?? []).length}` };
    }
    if (sub === "set_permission_mode" && m.request.mode === "bypassPermissions") { m.request.mode = "default"; return { forward: JSON.stringify(m), reply: null, note: "control:set_permission_mode bypass->default" }; }
    return { forward: JSON.stringify(m), reply: null, note: sub === "mcp_message" ? null : `control:${sub}` };
  }
  const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));
  if (m.type === "user") return { forward: JSON.stringify({ ...pick(m, ["type", "parent_tool_use_id", "session_id", "uuid", "isSynthetic", "priority"]), message: pick(m.message, ["role", "content"]) }), reply: null, note: null };
  if (m.type === "control_response") return { forward: JSON.stringify({ type: m.type, response: pick(m.response, ["subtype", "request_id", "response", "error"]) }), reply: null, note: null };
  if (m.type === "control_cancel_request") return { forward: JSON.stringify(pick(m, ["type", "request_id"])), reply: null, note: null };
  if (m.type === "keep_alive") return { forward: JSON.stringify({ type: "keep_alive" }), reply: null, note: null };
  return { forward: null, reply: null, note: `type:${m.type}:dropped` };
}

// ---------- remote agent (runs under node on the remote machine, inside a BB terminal) ----------
// Framing is base64 lines so the PTY cannot mangle JSON:  @I <b64 chunk> / @M <sha1-12> (end of one stdin line) / @C (close stdin)
//   out:  @R <json> ready | @O <b64 chunk of claude stdout> | @X <exit code> | @F <fatal reason>
const AGENT = String.raw`
const {spawn}=require("node:child_process"),fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto");
const spec=JSON.parse(require("node:zlib").gunzipSync(Buffer.from(process.argv[1],"base64")).toString());
const out=(s)=>process.stdout.write(s+"\n");
try{fs.mkdirSync(spec.cwd,{recursive:true,mode:0o700});}catch(e){out("@F cwd "+e.code);process.exit(2);}
const cfg=process.env.CLAUDE_CONFIG_DIR||path.join(os.homedir(),".claude");
const slug=spec.cwd.replace(/[^a-zA-Z0-9]/g,"-");
if(spec.resume&&!fs.existsSync(path.join(cfg,"projects",slug,spec.resume+".jsonl"))){out("@F no-history "+slug);process.exit(3);}
const env={...process.env};for(const k of Object.keys(env))if(/^(BB_|CLAUDECODE$|CLAUDE_CODE_ENTRYPOINT$)/.test(k))delete env[k];
// Resolve BB locally on UA for the fixed probe MCP process only.
let workspaceConfig;
for(let i=0;i<spec.args.length;i++) if(spec.args[i].startsWith("--mcp-config=")){
  const config=JSON.parse(spec.args[i].slice("--mcp-config=".length));
  const server=config.mcpServers?.origin ?? config.mcpServers?.workspace;
  if(server){
    const clientEnv={};
    if(process.env.BB_CLI?.startsWith("/")) clientEnv.BB_CLI=process.env.BB_CLI;
    if(/^\d+$/.test(process.env.BB_HOST_DAEMON_PORT||"")) clientEnv.BB_HOST_DAEMON_PORT=process.env.BB_HOST_DAEMON_PORT;
    if(process.env.BB_SERVER_URL){const u=new URL(process.env.BB_SERVER_URL);if(!u.username&&!u.password&&!u.search)clientEnv.BB_SERVER_URL=u.origin;}
    server.env=clientEnv;
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),"bb-claude-tools-"));
    process.on("exit",()=>{try{fs.rmSync(dir,{recursive:true,force:true});}catch{}});
    const entry=path.join(dir,"server.cjs");
    if(config.mcpServers.workspace){ fs.writeFileSync(entry,server.args[1],{mode:0o600}); server.args=[entry,...server.args.slice(2)]; }
    const manifest=path.join(dir,"mcp.json");
    fs.writeFileSync(manifest,JSON.stringify(config),{mode:0o600});
    spec.args[i]="--mcp-config="+manifest;
    if(config.mcpServers.workspace)workspaceConfig=config.mcpServers;
  }
}
const c=spawn("claude",spec.args,{cwd:spec.cwd,env,stdio:["pipe","pipe","pipe"]});
// A local bridge can be killed between terminal creation and receiving its ID.
let lastOriginSignal=Date.now();
const watchdog=setInterval(()=>{
  if(Date.now()-lastOriginSignal<45000)return;
  clearInterval(watchdog);
  c.kill("SIGTERM");
  setTimeout(()=>{c.kill("SIGKILL");process.exit(75);},2000).unref();
},5000);
watchdog.unref();
let errBytes=0;c.stderr.on("data",(d)=>{errBytes+=d.length;});
c.on("error",(e)=>{out("@F spawn "+e.code);process.exit(4);});
const configureId=crypto.randomUUID(), statusId=crypto.randomUUID();
let deferred=null,deadline;
function forwardOutput(d){for(let i=0;i<d.length;i+=720)out("@O "+d.subarray(i,i+720).toString("base64"));}
function control(request_id,request){c.stdin.write(JSON.stringify({type:"control_request",request_id,request})+"\n");}
function failConfig(reason){out("@F workspace "+reason);c.kill();process.exit(7);}
if(workspaceConfig)require("node:readline").createInterface({input:c.stdout}).on("line",line=>{
  let msg;try{msg=JSON.parse(line);}catch{}
  const response=msg?.type==="control_response"?msg.response:null;
  if(response?.request_id===configureId){
    if(response.subtype!=="success" || Object.keys(response.response?.errors||{}).length) return failConfig("registration failed");
    control(statusId,{subtype:"mcp_status"});return;
  }
  if(response?.request_id===statusId){
    const servers=response.response?.mcpServers||[];
    const server=servers.find(s=>s.name==="workspace");
    if(server?.status!=="connected")return failConfig("server "+(server?.status||"missing"));
    clearTimeout(deadline);
    c.stdin.write(deferred);c.stdin.write("\n");deferred=null;workspaceConfig=null;return;
  }
  forwardOutput(Buffer.from(line+"\n"));
});
else c.stdout.on("data",forwardOutput);
c.on("exit",(code,sig)=>{setTimeout(()=>{out("@E "+errBytes);out("@X "+(code??(sig?143:1)));process.exit(0);},150);});
let parts=[],buf="";
process.stdin.on("data",(d)=>{lastOriginSignal=Date.now();buf+=d.toString("latin1");let i;while((i=buf.indexOf("\n"))>=0){const l=buf.slice(0,i).replace(/\r/g,"");buf=buf.slice(i+1);
 if(l.startsWith("@I "))parts.push(l.slice(3));
 else if(l.startsWith("@M ") || l.startsWith("@Z ")){const packed=Buffer.from(parts.join(""),"base64");parts=[];
  const b=l.startsWith("@Z ")?require("node:zlib").gunzipSync(packed):packed;
  if(crypto.createHash("sha1").update(b).digest("hex").slice(0,12)!==l.slice(3).trim()){out("@F checksum");c.kill();process.exit(5);}
  if(workspaceConfig && JSON.parse(b).type==="user"){
    if(deferred)return failConfig("concurrent input");
    deferred=b;deadline=setTimeout(()=>failConfig("startup timeout"),25000);
    control(configureId,{subtype:"mcp_set_servers",servers:workspaceConfig});
  }else {c.stdin.write(b);c.stdin.write("\n");}}
 else if(l.startsWith("@C"))c.stdin.end();}});
process.stdin.on("end",()=>c.kill());process.on("SIGHUP",()=>c.kill());process.on("SIGTERM",()=>c.kill());
out("@R "+JSON.stringify({slug,node:process.version}));
`;

async function remote() {
  const guard = secretGuard();
  const bb = (args, input) => new Promise((res, rej) => {
    const p = execFile(process.env.BB_CLI || "bb", args, { maxBuffer: 256e6 }, (e, o, stderr) => {
      if (!e) return res(o);
      let reason="";
      try { reason=JSON.parse(o).error?.message??""; } catch {}
      const detail=(reason || stderr || "").split("\n")[0].replace(/[A-Za-z0-9_+/=-]{40,}/g,"[omitted]").slice(0,180);
      rej(new Error("bb "+args.slice(0,2).join(" ")+" failed ("+e.code+"): "+(guard(detail)?"":detail)));
    });
    p.stdin.end(input ?? "");
  });
  const fatal = (why, code = 1) => { log(`FATAL ${why}`); process.stderr.write(`claude-origin-relay: ${why}\n`); return cleanup(code); };

  const { kept, dropped } = filterArgs(process.argv.slice(2));
  const probeThread = process.env.BB_ORIGIN_PROBE_THREAD;
  let history = probeThread ? probeHistory(probeThread) : null;
  if (history) {
    // Each isolated probe starts a fresh native session on the remote machine.
    for (let i = kept.length - 1; i >= 0; i--)
      if (/^--(?:resume|resume-session-at|session-id)=/.test(kept[i])) kept.splice(i,1);
  }
  const probeId = process.env.BB_ORIGIN_PROBE_ID ?? "";
  if (probeThread && /^origin-tools-[a-zA-Z0-9]+$/.test(probeId)) {
    const source = readFileSync(new URL("../tests/origin-tools.cjs", import.meta.url), "utf8");
    const config = {mcpServers:{origin:{command:"node",args:["-e",source,process.env.BB_ORIGIN_SOURCE_HOST,"/tmp/"+probeId]}}};
    kept.push("--mcp-config=" + JSON.stringify(config), "--allowedTools=mcp__origin__read_marker,mcp__origin__record_marker,mcp__origin__inspect_services");
  }
  if(probeId.startsWith("auto-") && process.env.BB_ORIGIN_WORKSPACE?.startsWith("/")){
    const source=readFileSync(new URL("./workspace-tools.cjs",import.meta.url),"utf8");
    const config={mcpServers:{workspace:{command:"node",args:["-e",source,process.env.BB_ORIGIN_SOURCE_HOST,process.env.BB_ORIGIN_WORKSPACE,probeThread]}}};
    kept.push("--mcp-config="+JSON.stringify(config),"--allowedTools=mcp__workspace__read_file,mcp__workspace__git_status");
  }
  const resume = kept.find((a) => a.startsWith("--resume="))?.slice(9) ?? null;
  const cwd = (process.env.BB_ORIGIN_REMOTE_CWD ?? "").trim() || `/tmp/bb-origin-relay/${(process.env.BB_THREAD_ID || "default").replace(/[^A-Za-z0-9_-]/g, "_")}`;
  log(`START host=${HOST} remoteCwd=${cwd} resume=${resume ? "yes" : "no"} mcp=${MCP_ON}`);
  log(`ARGS kept=${kept.map((a) => a.split("=")[0]).join(" ")}`);
  log(`ARGS dropped=${dropped.join(" ") || "-"}`);
  let termId = null, done = false, sendChain = Promise.resolve(), inBytes = 0, outBytes = 0, exitCode = null;
  async function cleanup(code) {
    if (done) return; done = true;
    try { await Promise.race([sendChain, new Promise((r) => setTimeout(r, 3000))]); } catch {}
    if (termId) { try { await bb(["terminal", "close", termId]); } catch (e) { log(`CLOSE-ERR ${e.message}`); } }
    log(`END code=${code} in=${inBytes} out=${outBytes} term=${termId}`);
    process.exit(code);
  }
  const argHit = guard(kept.join("\n"));
  if (argHit) return fatal(`refusing to start: an argument contains a secret (${argHit})`, 78);

  const spec = gzipSync(JSON.stringify({args:kept,cwd,resume})).toString("base64");
  const agent = gzipSync(AGENT).toString("base64");
  const command = `stty raw -echo 2>/dev/null; exec node -e 'eval(require("node:zlib").gunzipSync(Buffer.from("${agent}","base64")).toString())' ${spec}`;
  log("LAUNCH commandBytes="+Buffer.byteLength(command));
  try {
    const created = JSON.parse(await bb(["terminal", "create", "--machine", HOST, "--cwd", "/tmp", "--title", "claude-origin-relay", "--json", "--command", command]));
    termId = created.id;
  } catch (e) { return fatal(`cannot start remote terminal on ${HOST}: ${e.message}`, 69); }
  log(`TERM ${termId}`);

  // origin -> remote
  let ready = false; const queue = [];
  const sendLine = (line) => {
    const b = Buffer.from(line, "utf8"); const compressed = b.length>=8192; const b64 = (compressed?gzipSync(b):b).toString("base64"); const sum = createHash("sha1").update(b).digest("hex").slice(0, 12);
    const frames = []; for (let i = 0; i < b64.length; i += 900) frames.push(`@I ${b64.slice(i, i + 900)}\n`);
    frames.push(`${compressed?"@Z":"@M"} ${sum}\n`);
    // batches small enough for the PTY input queue
    let batch = ""; const batches = [];
    for (const f of frames) { if (batch.length + f.length > 3000) { batches.push(batch); batch = ""; } batch += f; }
    if (batch) batches.push(batch);
    inBytes += b.length;
    for (const part of batches) sendChain = sendChain.then(() => bb(["terminal", "send", termId, "--stdin"], part)).catch((e) => { log(`SEND-ERR ${e.message}`); });
  };
  const pump = () => { while (ready && queue.length) sendLine(queue.shift()); };
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (done || !line.trim()) return;
    const f = filterInbound(line);
    if (f.note) log(`IN ${f.note}`);
    if (f.reply) process.stdout.write(f.reply + "\n");
    if (f.forward === null) return;
    if (probeId.startsWith("live-once-") && JSON.parse(f.forward).type === "user") {
      try {
        writeFileSync(process.env.BB_ORIGIN_PROBE_RECEIPT + ".sent", "one", {flag:"wx",mode:0o600});
      } catch { void fatal("Live probe has already dispatched its one backup message", 75); return; }
    }
    if (history) {
      const m = JSON.parse(f.forward);
      if (m.type === "user" && m.message?.role === "user") {
        m.message.content = [...history,...(Array.isArray(m.message.content) ? m.message.content : [{type:"text",text:m.message.content}])];
        f.forward = JSON.stringify(m);
        history = null;
      }
    }
    const hit = guard(f.forward);
    if (hit) { void fatal(`refusing to forward a message containing a secret (${hit})`, 78); return; }
    queue.push(f.forward); pump();
  });
  rl.on("close", () => { log("STDIN-CLOSED"); if (termId && !done) { sendChain = sendChain.then(() => bb(["terminal", "send", termId, "--stdin"], "@C\n")).catch(() => {}); setTimeout(() => void cleanup(exitCode ?? 0), 5000); } });
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => { log(`SIGNAL ${sig}`); void cleanup(143); });

  // remote -> origin (streamed; partial JSON chunks are written as they arrive)
  const poll = Math.max(50, Number(process.env.BB_ORIGIN_RELAY_POLL_MS) || 150);
  let lastHeartbeat = 0;
  let resultBuffer = "";
  let seq = 0, text = "", readyDeadline = Date.now() + 30000;
  while (!done) {
    let o;
    // A single failed poll (for example an HTTP 504 from the BB server) is not a lost terminal:
    // the remote command keeps running and its output stays readable from the same sequence.
    let pollError;
    for (let attempt = 0; attempt < 6; attempt++) {
      try { o = JSON.parse(await bb(["terminal", "output", termId, "--since-seq", String(seq), "--json"])); pollError = undefined; break; }
      catch (e) { pollError = e; log(`terminal poll failed (attempt ${attempt + 1}): ${e.message}`); await new Promise(r => setTimeout(r, Math.min(30000, 1000 * 2 ** attempt))); }
    }
    if (pollError) return fatal(`lost remote terminal: ${pollError.message}`, 69);
    if (o.truncated) return fatal("remote output was truncated by terminal scrollback; aborting instead of delivering a corrupt stream", 74);
    for (const c of o.chunks ?? []) text += Buffer.from(c.dataBase64, "base64").toString("latin1");
    seq = o.nextSeq ?? seq;
    let i;
    while ((i = text.indexOf("\n")) >= 0) {
      const l = text.slice(0, i).replace(/\r/g, ""); text = text.slice(i + 1);
      if (l.startsWith("@O ")) { const b = Buffer.from(l.slice(3), "base64"); outBytes += b.length;
        if (probeThread && process.env.BB_ORIGIN_PROBE_RECEIPT) {
          resultBuffer += b.toString("latin1");
          const lines = resultBuffer.split("\n"); resultBuffer = lines.pop();
          for(const line of lines) {
            let event; try { event=JSON.parse(line); } catch { continue; }
            if(probeId.startsWith("auto-")) {
              if(event.type==="system" && event.subtype==="init") log("WORKSPACE "+JSON.stringify({tools:event.tools?.filter(t=>t.startsWith("mcp__workspace")),status:event.mcp_servers?.map(s=>[s.name,s.status])}));
              const rejected=quotaWindow(event,Date.now());
              if(rejected?.resetAt) writeFileSync(process.env.BB_ORIGIN_PROBE_RECEIPT+".backup",JSON.stringify(rejected),{mode:0o600});
            }
            if(event.type==="result" && !event.is_error) writeFileSync(process.env.BB_ORIGIN_PROBE_RECEIPT+".return","done",{mode:0o600});
          }
        }
        process.stdout.write(b); }
      else if (l.startsWith("@R ")) { ready = true; log(`READY ${l.slice(3)}`); pump(); }
      else if (l.startsWith("@E ")) log(`REMOTE-STDERR-BYTES ${l.slice(3)}`);
      else if (l.startsWith("@X ")) { exitCode = Number(l.slice(3)) || 0; log(`REMOTE-EXIT ${exitCode}`); return cleanup(exitCode); }
      else if (l.startsWith("@F ")) return fatal(`remote agent: ${l.slice(3)}`, 70);
    }
    if(ready && Date.now()-lastHeartbeat >= 8000) {
      lastHeartbeat=Date.now();
      sendChain=sendChain.then(()=>bb(["terminal","send",termId,"--stdin"],"@H\n")).catch(()=>{});
    }
    if (!ready && Date.now() > readyDeadline) return fatal("remote agent did not become ready in 30s", 69);
    if (o.status === "exited") return fatal(`remote terminal exited (code ${o.exitCode}) without a result`, 70);
    await new Promise((r) => setTimeout(r, poll));
  }
}

// ---------- dispatch ----------
if (!HOST) {
  const bin = realClaude();
  if (!bin) { process.stderr.write("claude-origin-relay: real claude not found (set BB_ORIGIN_REAL_CLAUDE)\n"); process.exit(127); }
  const env = { ...process.env }; delete env.BB_CLAUDE_CODE_EXECUTABLE;
  const child = spawn(bin, process.argv.slice(2), { stdio: "inherit", env });
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => child.kill(sig));
  child.on("exit", (code, sig) => process.exit(code ?? (sig ? 143 : 1)));
  child.on("error", (e) => { process.stderr.write(`claude-origin-relay: ${e.message}\n`); process.exit(127); });
} else {
  await remote();
}
