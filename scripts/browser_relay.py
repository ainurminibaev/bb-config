#!/usr/bin/env python3
"""Browser Relay: one shared connection to the user's real Chrome for agents on every machine.

Runs on the BB server. The plugin itself (bb-plugin-browser-relay, separate repository)
installs and checks the macOS service on machines through `bb browser-relay`.

  --check   plugin installed and running; no machine still runs an earlier
            chrome-devtools-shared service; every machine with the service answers
  --apply   install/update the plugin from config/plugins.json, then move earlier
            services (bb-config chrome-devtools-shared, any label) to the plugin's
            service. Chrome asks "Allow" once per moved machine.

Does not install the service on a machine that never had one: choose it yourself with
`bb browser-relay service install --machine <Mac with Chrome>`.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLUGIN_ID = 'browser-relay'


def bb(*args: str, timeout: int = 120) -> subprocess.CompletedProcess:
    return subprocess.run(['bb', *args], text=True, capture_output=True, timeout=timeout)


def declared_source() -> str:
    for p in json.loads((ROOT / 'config' / 'plugins.json').read_text()):
        if p.get('id') == PLUGIN_ID:
            return p['source']
    sys.exit(f'{PLUGIN_ID}: нет записи в config/plugins.json')


def installed() -> dict | None:
    r = bb('plugin', 'list', '--json')
    if r.returncode != 0:
        sys.exit(f'bb plugin list: {r.stderr.strip()}')
    data = json.loads(r.stdout)
    for p in data.get('plugins', data) if isinstance(data, dict) else data:
        if p.get('id') == PLUGIN_ID:
            return p
    return None


def machines() -> list[dict]:
    r = bb('browser-relay', 'machines', '--json', timeout=180)
    if r.returncode != 0:
        sys.exit(f'bb browser-relay machines: {(r.stdout + r.stderr).strip()[:500]}')
    return json.loads(r.stdout)['machines']


def problems() -> list[str]:
    p = installed()
    if not p:
        return [f'плагин {PLUGIN_ID} не установлен']
    if not p.get('enabled', True):
        return [f'плагин {PLUGIN_ID} выключен']
    out = []
    for m in machines():
        s = m.get('status') or {}
        if s.get('legacyLabels'):
            out.append(f"{m['name']}: работает прежняя служба {', '.join(s['legacyLabels'])}")
        elif s.get('installed') and not s.get('serviceUp'):
            out.append(f"{m['name']}: служба Browser Relay установлена, но не отвечает")
    return out


def check() -> int:
    errs = problems()
    for e in errs:
        print(f'FAIL: {e}')
    if not errs:
        print('OK: Browser Relay установлен; прежних служб нет; установленные службы отвечают.')
    return 1 if errs else 0


def apply() -> int:
    src = declared_source()
    r = bb('plugin', 'install', src, '--yes', timeout=600)
    if r.returncode != 0:
        print((r.stdout + r.stderr).strip()[-1500:])
        return 1
    for m in machines():
        s = m.get('status') or {}
        if m.get('connected') and s.get('supported') and (s.get('legacyLabels') or (s.get('installed') and not s.get('serviceUp'))):
            print(f"{m['name']}: переношу службу (Chrome один раз спросит «Allow»)…")
            r = bb('browser-relay', 'service', 'install', '--machine', m['id'], timeout=1300)
            print((r.stdout + r.stderr).strip()[-1500:])
    return check()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument('--check', action='store_true')
    g.add_argument('--apply', action='store_true')
    a = ap.parse_args()
    return check() if a.check else apply()


if __name__ == '__main__':
    sys.exit(main())
