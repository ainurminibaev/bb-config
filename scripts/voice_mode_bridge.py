#!/usr/bin/env python3
"""Keep the Voice Mode Codex Live bridge in step with the installed plugin.

Voice Mode's Live 1.1 route (`codex-live-first`) runs `codex_voice.py` from a
private runtime folder that its own `--install` fills. A plugin update does not
refresh that copy, so the bridge and the browser can disagree.

  --check   exit 0 when the bridge is not installed (route unused) or matches
            the installed plugin; exit 1 otherwise
  --apply   rerun the plugin's own installer when the copy differs

Without Voice Mode installed both modes report nothing to do.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import platform_compat as compat  # noqa: E402

PLUGIN = 'voice-mode'
MIN_VERSION = (0, 2, 6)
RUNTIME = Path.home() / '.local/share/bb-voice-mode/codex-live'


def plugin():
    supplied = os.environ.get('BB_CONFIG_PLUGINS_JSON')
    if not supplied:
        command = compat.argv([os.environ.get('BB_CLI') or 'bb', 'plugin', 'list', '--json'])
        supplied = subprocess.run(command, check=True, capture_output=True, text=True).stdout
    listing = json.loads(supplied)
    plugins = listing if isinstance(listing, list) else listing.get('plugins', [])
    return next((p for p in plugins if p.get('id') == PLUGIN), None)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def state():
    found = plugin()
    if not found:
        return 'absent', None, None
    root = found.get('rootDir') or ''
    # Only the installed plugin's own folder: an empty or relative root would make the
    # current directory decide which installer runs.
    if not root or not Path(root).is_absolute():
        return 'no-bridge-in-plugin', found, None
    source = Path(root) / 'codex_voice.py'
    installed = RUNTIME / 'codex_voice.py'
    if not source.is_file():
        return 'no-bridge-in-plugin', found, source
    if not installed.is_file():
        return 'route-unused', found, source
    return ('current' if digest(source) == digest(installed) else 'stale'), found, source


def version(found):
    parts = [int(x) for x in (found.get('version') or '0').split('-')[0].split('.')[:3] if x.isdigit()]
    return tuple(parts + [0] * (3 - len(parts)))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--check', action='store_true')
    mode.add_argument('--apply', action='store_true')
    args = parser.parse_args(argv)
    status, found, source = state()
    if args.apply and status == 'stale':
        if version(found) < MIN_VERSION:
            print(f'{PLUGIN} {found.get("version")} is older than 0.2.6; update it in BB first '
                  f'(bb plugin update {PLUGIN})')
            return 1
        subprocess.run([sys.executable, str(source), '--install'], check=True,
                       stdout=subprocess.DEVNULL, cwd=str(source.parent))
        status, found, source = state()
    print(json.dumps({'plugin': PLUGIN, 'version': found and found.get('version'), 'bridge': status}))
    return 0 if status in ('absent', 'no-bridge-in-plugin', 'route-unused', 'current') else 1


if __name__ == '__main__':
    sys.exit(main())
