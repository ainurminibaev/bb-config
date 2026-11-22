#!/usr/bin/env node
// bb-page: drive one tab of bb's built-in browser from the command line.
//
// For hosts where the Browser Automation plugin has no runtime (Windows). It
// uses only the documented `bb browser` commands for the tab, its control
// lease and the private connection, then speaks the DevTools protocol to that
// tab. No dependencies; needs Node 22+ (global WebSocket). Run it on the
// machine whose bb desktop window holds the browser.
//
//   node bb-page.mjs open <url>            create a hidden tab and take control
//   node bb-page.mjs goto <url>            navigate and wait for the page
//   node bb-page.mjs text [maxChars]       url, title and visible text
//   node bb-page.mjs snapshot              numbered list of what can be clicked or filled
//   node bb-page.mjs click <n>             click element n of the last snapshot
//   node bb-page.mjs type <n> <text...>    focus element n and insert the text
//   node bb-page.mjs key <Enter|Tab|...>   press a key in the focused element
//   node bb-page.mjs eval <js>             run JavaScript in the page, print the JSON result
//   node bb-page.mjs shot <file.jpg>       save a screenshot
//   node bb-page.mjs close                 release control and close the tab
//
// One tab per thread ($BB_THREAD_ID, or --thread <id>). --host <id> names the
// machine with the browser when bb has several; default: the only one that
// reports a desktop browser.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
function option(name) {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? undefined : argv.splice(at, 2)[1];
}
const threadId = option("thread") ?? process.env.BB_THREAD_ID;
const hostOption = option("host") ?? process.env.BB_PAGE_HOST;
const [command, ...rest] = argv;
const fail = (message) => { console.error(`bb-page: ${message}`); process.exit(1); };
if (!command || command === "--help" || command === "-h") {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((line) => line.startsWith("//")).map((line) => line.slice(3)).join("\n"));
  process.exit(0);
}
if (!threadId) fail("no thread: run inside a bb thread or pass --thread <id>");

// Per-user directory: on a shared Unix /tmp another account must not be able to plant the DevTools
// endpoint this script connects to, nor read the connection file the bb CLI writes here.
const uid = typeof process.getuid === "function" ? process.getuid() : null;
const stateDir = join(tmpdir(), uid === null ? "bb-page" : `bb-page-${uid}`);
const stateFile = join(stateDir, `${threadId}.json`);
function ownDir() {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (uid === null) return;
  const st = lstatSync(stateDir);
  if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o077) !== 0) fail(`unsafe state directory ${stateDir}: it must be a directory owned by you with mode 0700`);
}
const loadState = () => { if (!existsSync(stateFile)) return null; ownDir(); return JSON.parse(readFileSync(stateFile, "utf8")); };
const saveState = (state) => { ownDir(); writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 }); };

/** One argument for a cmd.exe command line. Quotes and %VAR% cannot be made literal there. */
function cmdQuote(value) {
  const text = String(value);
  if (/["\r\n]/.test(text) || /%[^%\s]+%/.test(text)) throw new Error("Аргумент нельзя безопасно передать bb.cmd: уберите кавычки и %ИМЯ%.");
  return `"${text}"`;
}

/** Runs the bb CLI and returns its parsed --json output. */
function bb(...args) {
  const cli = process.env.BB_CLI;
  const direct = cli && existsSync(cli) && !/\.(cmd|bat)$/i.test(cli);
  const result = direct ? spawnSync(process.execPath, [cli, ...args, "--json"], { encoding: "utf8" })
    : process.platform === "win32"
      // A .cmd launcher needs cmd.exe. Every argument is quoted, so & | < > ^ in a URL stay text;
      // an argument that cannot be quoted safely is refused instead of being interpreted.
      ? spawnSync([cli && existsSync(cli) ? cli : "bb", ...args, "--json"].map(cmdQuote).join(" "), { encoding: "utf8", shell: true, windowsVerbatimArguments: true })
      : spawnSync("bb", [...args, "--json"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`bb ${args.slice(0, 2).join(" ")}: ${(result.stderr || result.stdout || "").trim().split("\n").at(-1)}`);
  return JSON.parse(result.stdout);
}
const where = (state) => ["--host", state.hostId, "--instance", state.instanceId, "--generation", state.generation, "--thread", threadId];

function findBrowser() {
  const machines = bb("machine", "list");
  const hosts = hostOption ? [hostOption] : (Array.isArray(machines) ? machines : machines.machines ?? []).filter((m) => m.status === "connected").map((m) => m.id);
  const found = [];
  for (const hostId of hosts) {
    try { for (const instance of bb("browser", "instances", "--host", hostId).instances ?? []) found.push({ ...instance, hostId: instance.hostId ?? hostId }); } catch { /* no desktop there */ }
  }
  if (found.length === 0) fail("no bb desktop window with a browser was found; open the bb app on that machine");
  if (found.length > 1) fail(`several browser windows: ${found.map((f) => `${f.hostId}/${f.instanceId}`).join(", ")}; pass --host <id>`);
  return { hostId: found[0].hostId, instanceId: found[0].instanceId, generation: found[0].generation };
}

/** A control lease lasts at most thirty minutes; take a new one when it is about to end. */
function ensureLease(state) {
  if (state.wsEndpoint && state.expiresAt - Date.now() > 60_000) return state;
  if (state.leaseId) { try { bb("browser", "release", state.leaseId, ...where(state)); } catch { /* already gone */ } }
  const lease = bb("browser", "acquire", state.tabId, ...where(state), "--controller", "bb-page", "--ttl-ms", "1800000");
  const file = join(stateDir, `${threadId}.connection-${Date.now()}.json`);
  ownDir();
  try {
    bb("browser", "connection", lease.leaseId, ...where(state), "--output", file);
    const { wsEndpoint, expiresAt } = JSON.parse(readFileSync(file, "utf8"));
    Object.assign(state, { leaseId: lease.leaseId, wsEndpoint, expiresAt: expiresAt ?? lease.expiresAt });
  } finally { rmSync(file, { force: true }); }
  saveState(state);
  return state;
}

/** One DevTools session with the controlled tab. */
async function connect(state) {
  const socket = new WebSocket(state.wsEndpoint);
  let next = 0;
  const waiting = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const entry = waiting.get(message.id);
    if (!entry) return;
    waiting.delete(message.id);
    if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`)); else entry.resolve(message.result);
  });
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve); socket.addEventListener("error", () => reject(new Error("cannot reach the browser tab; run `open` again"))); });
  const raw = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++next;
    waiting.set(id, { resolve, reject, method });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  let sessionId;
  try {
    // A browser-level endpoint lists targets; a page-level one takes commands directly.
    const pages = (await raw("Target.getTargets")).targetInfos.filter((target) => target.type === "page");
    if (pages.length) ({ sessionId } = await raw("Target.attachToTarget", { targetId: pages[0].targetId, flatten: true }));
  } catch { sessionId = undefined; }
  const send = (method, params) => raw(method, params, sessionId);
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  return { send, evaluate, close: () => socket.close() };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function settled(page, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  await sleep(300);
  while (Date.now() < until) {
    try { if (await page.evaluate("return document.readyState") === "complete") return; } catch { /* navigating */ }
    await sleep(250);
  }
}
const describe = (page) => page.evaluate("return { url: location.href, title: document.title }");

const SNAPSHOT = `
  const visible = (node) => { const r = node.getBoundingClientRect(); const s = getComputedStyle(node); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  document.querySelectorAll("[data-bb-page]").forEach((node) => node.removeAttribute("data-bb-page"));
  const nodes = [...document.querySelectorAll('a[href], button, input, select, textarea, [role=button], [role=link], [role=tab], [role=menuitem], [contenteditable=true]')].filter(visible).slice(0, 200);
  return nodes.map((node, index) => {
    node.setAttribute("data-bb-page", String(index + 1));
    const label = (node.getAttribute("aria-label") || node.getAttribute("title") || node.getAttribute("placeholder") || node.innerText || (/^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName) ? node.getAttribute("name") || node.type : node.value) || "").trim().replace(/\\s+/g, " ").slice(0, 80);
    const kind = node.tagName.toLowerCase() + (node.type ? ":" + node.type : "");
    return "[" + (index + 1) + "] " + kind + " " + JSON.stringify(label) + (node.href ? " -> " + node.href.slice(0, 120) : "");
  });`;
const centre = (n) => `
  const node = document.querySelector('[data-bb-page="${Number(n)}"]');
  if (!node) return null;
  node.scrollIntoView({ block: "center", inline: "center" });
  const r = node.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`;

try {
  if (command === "open") {
    const url = rest[0] ?? "about:blank";
    const previous = loadState();
    if (previous) { try { bb("browser", "close", previous.tabId, ...where(previous)); } catch { /* gone */ } }
    const state = findBrowser();
    state.tabId = bb("browser", "create", ...where(state), "--url", url).tab.tabId;
    saveState(state);
    const page = await connect(ensureLease(state));
    await settled(page);
    console.log(JSON.stringify(await describe(page)));
    page.close();
  } else if (command === "close") {
    const state = loadState();
    if (state) {
      try { if (state.leaseId) bb("browser", "release", state.leaseId, ...where(state)); } catch { /* gone */ }
      try { bb("browser", "close", state.tabId, ...where(state)); } catch { /* gone */ }
      rmSync(stateFile, { force: true });
    }
    console.log("closed");
  } else {
    const state = loadState() ?? fail("no open tab for this thread; run `open <url>` first");
    const page = await connect(ensureLease(state));
    if (command === "goto") {
      if (!rest[0]) fail("goto needs a URL");
      await page.send("Page.navigate", { url: rest[0] });
      await settled(page);
      console.log(JSON.stringify(await describe(page)));
    } else if (command === "text") {
      const limit = Number(rest[0]) || 6000;
      const info = await describe(page);
      const text = await page.evaluate("return (document.body?.innerText ?? '').replace(/\\n{3,}/g, '\\n\\n')");
      console.log(`${info.url}\n${info.title}\n\n${text.slice(0, limit)}${text.length > limit ? `\n… (${text.length - limit} more characters)` : ""}`);
    } else if (command === "snapshot") {
      console.log((await page.evaluate(SNAPSHOT)).join("\n") || "(nothing to click or fill)");
    } else if (command === "click") {
      const point = await page.evaluate(centre(rest[0])) ?? fail(`no element ${rest[0]}; take a fresh snapshot`);
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 });
      await settled(page, 5000);
      console.log(JSON.stringify(await describe(page)));
    } else if (command === "type") {
      const focused = await page.evaluate(`const node = document.querySelector('[data-bb-page="${Number(rest[0])}"]'); if (!node) return false; node.focus(); return true;`);
      if (!focused) fail(`no element ${rest[0]}; take a fresh snapshot`);
      await page.send("Input.insertText", { text: rest.slice(1).join(" ") });
      console.log("typed");
    } else if (command === "key") {
      const key = rest[0] ?? fail("key needs a key name, e.g. Enter");
      const codes = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, ArrowDown: 40, ArrowUp: 38 };
      for (const type of ["keyDown", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, key, code: key, windowsVirtualKeyCode: codes[key] ?? 0, ...(key === "Enter" && type === "keyDown" ? { text: "\r" } : {}) });
      await settled(page, 5000);
      console.log(JSON.stringify(await describe(page)));
    } else if (command === "eval") {
      console.log(JSON.stringify(await page.evaluate(rest.join(" ")), null, 1));
    } else if (command === "shot") {
      const file = rest[0] ?? fail("shot needs an output file, e.g. page.jpg");
      const { data } = await page.send("Page.captureScreenshot", { format: "jpeg", quality: 70 });
      writeFileSync(file, Buffer.from(data, "base64"));
      console.log(file);
    } else fail(`unknown command ${command}; run with --help`);
    page.close();
  }
} catch (error) {
  fail(error.message);
}
