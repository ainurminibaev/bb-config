#!/usr/bin/env python3
"""Shared chrome-devtools-mcp service for macOS executors.

One long-lived chrome-devtools-mcp (--autoConnect) keeps a single DevTools
connection to the user's main Chrome profile and is served to every local
agent through mcp-proxy (MCP Streamable HTTP on 127.0.0.1). Chrome 144+ asks
"Allow remote debugging?" for each new connection, so agents no longer trigger
the dialog per session: one "Allow" per Chrome launch or service restart.

  --check   verify installed state (does not touch Chrome, no dialog)
  --apply   install/update service and point Codex at it (idempotent)
  --remove  stop service, restore the previous Codex entry

Runs as the user who launches Codex, on the Mac itself. Sources and templates:
services/chrome-devtools-shared/. See docs/customizations.md.
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import plistlib
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "services" / "chrome-devtools-shared"
LABEL = "dev.bb-config.chrome-devtools-mcp-shared"
PORT = 8766
MCP_PROXY_VERSION = "0.15.0"
MIN_NODE = (20, 19)
HOME = Path.home()
INSTALL_DIR = HOME / ".local" / "share" / "chrome-devtools-mcp-shared"
PLIST = HOME / "Library" / "LaunchAgents" / f"{LABEL}.plist"
LOG = HOME / "Library" / "Logs" / "chrome-devtools-mcp-shared.log"
CODEX_CONFIG = Path(os.environ.get("CODEX_HOME", HOME / ".codex")) / "config.toml"
BACKUP_DIR = INSTALL_DIR / "backup"
PREV_CODEX_ENTRY = BACKUP_DIR / "codex-chrome-devtools.previous.toml"
TABLE_RE = re.compile(r"^\[mcp_servers\.chrome-devtools\][^\n]*\n(?:(?!\[)[^\n]*\n?)*", re.M)


def log(msg: str) -> None:
    print(msg, flush=True)


def run(cmd: list[str], check: bool = True, **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=check, text=True, capture_output=True, **kw)


def uid() -> int:
    return os.getuid()


# ---------- discovery ----------

def node_version(node: Path) -> tuple[int, ...] | None:
    try:
        out = run([str(node), "--version"]).stdout.strip().lstrip("v")
        return tuple(int(x) for x in out.split(".")[:2])
    except Exception:
        return None


def find_node_dir() -> Path:
    cands: list[Path] = []
    w = shutil.which("node")
    if w:
        cands.append(Path(w).resolve())
    nvm = HOME / ".nvm" / "versions" / "node"
    if nvm.is_dir():
        cands += sorted(nvm.glob("v*/bin/node"), reverse=True)
    cands += [Path("/opt/homebrew/bin/node"), Path("/usr/local/bin/node")]
    for c in cands:
        v = node_version(c) if c.exists() else None
        if v and v >= MIN_NODE:
            return c.parent
    sys.exit(f"Нужен Node.js >= {MIN_NODE[0]}.{MIN_NODE[1]}; не найден.")


def mcp_proxy_path() -> Path:
    return HOME / ".local" / "bin" / "mcp-proxy"


def render(name: str, **values: str) -> str:
    text = (SRC / name).read_text()
    for k, v in values.items():
        text = text.replace(f"@{k}@", v)
    return text


def legacy_plists() -> list[Path]:
    """LaunchAgents with another label that run the same run.sh."""
    out = []
    target = str(INSTALL_DIR / "run.sh")
    for p in (HOME / "Library" / "LaunchAgents").glob("*.plist"):
        if p == PLIST:
            continue
        try:
            d = plistlib.loads(p.read_bytes())
        except Exception:
            continue
        if target in (d.get("ProgramArguments") or []):
            out.append(p)
    return out


def label_running(label: str) -> bool:
    r = run(["launchctl", "print", f"gui/{uid()}/{label}"], check=False)
    return r.returncode == 0 and "state = running" in r.stdout


def probe() -> str | None:
    """MCP initialize over HTTP. Does not connect to Chrome."""
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-03-26", "capabilities": {},
        "clientInfo": {"name": "bb-config-check", "version": "1"}}}).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}/mcp", data=body, method="POST", headers={
        "Content-Type": "application/json", "Accept": "application/json, text/event-stream"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            text = r.read(65536).decode("utf-8", "replace")
    except Exception as e:
        return f"нет ответа MCP на 127.0.0.1:{PORT}: {e}"
    return None if "serverInfo" in text else "ответ MCP без serverInfo"


def codex_entry() -> str | None:
    if not CODEX_CONFIG.exists():
        return None
    m = TABLE_RE.search(CODEX_CONFIG.read_text())
    return m.group(0) if m else None


def codex_points_here(entry: str | None) -> bool:
    return bool(entry) and f'url = "http://127.0.0.1:{PORT}/mcp"' in entry


# ---------- actions ----------

def check() -> int:
    if platform.system() != "Darwin":
        log("Неприменимо: служба нужна только на macOS-машинах с Chrome.")
        return 0
    problems = []
    legacy = legacy_plists()
    if PLIST.exists():
        if not label_running(LABEL):
            problems.append(f"служба {LABEL} не запущена")
    elif legacy:
        running = [p.stem for p in legacy if label_running(p.stem)]
        log(f"Служба работает под прежней меткой {', '.join(running) or legacy[0].stem}; "
            "--apply перенесёт её (потребуется одно новое «Allow» в Chrome).")
        if not running:
            problems.append("прежняя служба не запущена")
    else:
        problems.append(f"нет {PLIST}")
    if not (INSTALL_DIR / "node_modules" / ".bin" / "chrome-devtools-mcp").exists():
        problems.append("chrome-devtools-mcp не установлен в каталоге службы")
    if not mcp_proxy_path().exists():
        problems.append("нет mcp-proxy (uv tool install)")
    err = probe()
    if err:
        problems.append(err)
    if not codex_points_here(codex_entry()):
        problems.append(f"{CODEX_CONFIG}: [mcp_servers.chrome-devtools] не указывает на общую службу")
    if problems:
        for p in problems:
            log(f"FAIL: {p}")
        return 1
    log(f"OK: общая служба chrome-devtools-mcp отвечает на 127.0.0.1:{PORT}, Codex подключён к ней.")
    return 0


def write_if_changed(path: Path, text: str, mode: int | None = None) -> bool:
    if path.exists() and path.read_text() == text:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    if mode is not None:
        path.chmod(mode)
    return True


def apply() -> int:
    if platform.system() != "Darwin":
        log("Неприменимо: не macOS, ничего не меняю.")
        return 0
    INSTALL_DIR.mkdir(parents=True, exist_ok=True)
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    node_dir = find_node_dir()
    env = dict(os.environ, PATH=f"{node_dir}:{os.environ.get('PATH', '')}")

    changed = False
    for name in ("package.json", "package-lock.json"):
        changed |= write_if_changed(INSTALL_DIR / name, (SRC / name).read_text())
    if changed or not (INSTALL_DIR / "node_modules" / ".bin" / "chrome-devtools-mcp").exists():
        log("npm ci (chrome-devtools-mcp, закреплённая версия)…")
        run([str(node_dir / "npm"), "ci", "--omit=dev", "--no-audit", "--no-fund"], cwd=INSTALL_DIR, env=env)

    uv = shutil.which("uv")
    want = f"mcp-proxy {MCP_PROXY_VERSION}"
    have = run([str(mcp_proxy_path()), "--version"], check=False).stdout.strip() if mcp_proxy_path().exists() else ""
    if have != want:
        if not uv:
            sys.exit("Нужен uv (https://docs.astral.sh/uv/) для установки mcp-proxy.")
        log(f"uv tool install mcp-proxy=={MCP_PROXY_VERSION}…")
        run([uv, "tool", "install", "--force", f"mcp-proxy=={MCP_PROXY_VERSION}"])
        changed = True

    vals = dict(NODE_BIN_DIR=str(node_dir), MCP_PROXY=str(mcp_proxy_path()), PORT=str(PORT),
                INSTALL_DIR=str(INSTALL_DIR), LABEL=LABEL, LOG=str(LOG))
    changed |= write_if_changed(INSTALL_DIR / "run.sh", render("run.sh.template", **vals), 0o755)

    # migrate a manually created agent that runs the same run.sh under another label
    for old in legacy_plists():
        log(f"Переношу прежнюю службу {old.stem} → {LABEL}")
        run(["launchctl", "bootout", f"gui/{uid()}/{old.stem}"], check=False)
        shutil.move(str(old), str(BACKUP_DIR / f"{old.name}.{int(time.time())}"))
        changed = True

    plist_changed = write_if_changed(PLIST, render("launchd.plist.template", **vals))
    if plist_changed:
        run(["launchctl", "bootout", f"gui/{uid()}/{LABEL}"], check=False)
    if plist_changed or not label_running(LABEL):
        run(["launchctl", "bootstrap", f"gui/{uid()}", str(PLIST)], check=False)
    elif changed:
        run(["launchctl", "kickstart", "-k", f"gui/{uid()}/{LABEL}"], check=False)

    # Codex: replace only the [mcp_servers.chrome-devtools] table, keep the rest
    entry = codex_entry()
    if not codex_points_here(entry):
        text = CODEX_CONFIG.read_text() if CODEX_CONFIG.exists() else ""
        ts = time.strftime("%Y%m%d-%H%M%S")
        if CODEX_CONFIG.exists():
            shutil.copy2(CODEX_CONFIG, BACKUP_DIR / f"codex-config.toml.{ts}")
        if entry and not PREV_CODEX_ENTRY.exists():
            PREV_CODEX_ENTRY.write_text(entry)
        new = render("codex.toml.template", PORT=str(PORT))
        if entry:
            text = text.replace(entry, new + ("\n" if entry.endswith("\n\n") else ""), 1)
        else:
            text = text.rstrip("\n") + ("\n\n" if text else "") + new
        CODEX_CONFIG.parent.mkdir(parents=True, exist_ok=True)
        CODEX_CONFIG.write_text(text)
        log(f"Codex: chrome-devtools → общая служба (бэкап в {BACKUP_DIR}). "
            "Уже открытые сессии Codex подхватят её после перезапуска.")

    for _ in range(20):
        if probe() is None:
            break
        time.sleep(0.5)
    return check()


def remove() -> int:
    if platform.system() != "Darwin":
        log("Неприменимо: не macOS.")
        return 0
    run(["launchctl", "bootout", f"gui/{uid()}/{LABEL}"], check=False)
    if PLIST.exists():
        PLIST.unlink()
    entry = codex_entry()
    if codex_points_here(entry):
        text = CODEX_CONFIG.read_text()
        shutil.copy2(CODEX_CONFIG, BACKUP_DIR / f"codex-config.toml.{time.strftime('%Y%m%d-%H%M%S')}")
        prev = PREV_CODEX_ENTRY.read_text() if PREV_CODEX_ENTRY.exists() else ""
        CODEX_CONFIG.write_text(text.replace(entry, prev, 1))
        log("Codex: восстановлена прежняя запись chrome-devtools." if prev else
            "Codex: запись chrome-devtools удалена (прежней не было).")
    log(f"Служба удалена. Каталог {INSTALL_DIR} и mcp-proxy оставлены; их можно удалить вручную.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--check", action="store_true")
    g.add_argument("--apply", action="store_true")
    g.add_argument("--remove", action="store_true")
    a = ap.parse_args()
    return check() if a.check else apply() if a.apply else remove()


if __name__ == "__main__":
    sys.exit(main())
