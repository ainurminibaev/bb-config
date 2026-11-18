#!/usr/bin/env python3
"""Check or repair the Tokenomics JSON limits response on the BB server."""
import argparse
from pathlib import Path
import sys

from tokenomics_compat import rewrite

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'plugins/voice-mode-keeper'))
import patch_keeper as keeper  # noqa: E402


def catalog_plugin(installed, spec):
    plugin = installed.get('tokenomics')
    if not plugin or plugin.get('provenance') != 'catalog' or not plugin['source'].startswith(spec['source']):
        raise SystemExit('Expected Tokenomics installed from the catalog')
    return plugin


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='Repair, build and reload; default checks only')
    args = parser.parse_args()
    spec = keeper.KEPT['tokenomics']
    if not args.apply:
        plugin = catalog_plugin(keeper.plugins(), spec)
        target = Path(plugin['rootDir']) / 'server.ts'
        if not target.is_file():
            raise SystemExit('Run on the BB server machine where the installed source exists')
        source = target.read_bytes()
        fixed = rewrite(source, plugin['version'])
        print('Compatibility fix present.' if fixed == source
              else 'Known affected source; run with --apply to repair the JSON limits response.')
        return
    keeper.STATE_DIR.mkdir(parents=True, exist_ok=True)
    with (keeper.STATE_DIR / 'keeper.lock').open('a') as lock:
        if not keeper.compat.try_lock(lock):
            raise SystemExit('Plugin Keeper is already running; try again after it finishes')
        installed = keeper.plugins()
        if not catalog_plugin(installed, spec)['enabled']:
            raise SystemExit('Enable Tokenomics before applying and reloading its compatibility fix')
        print(keeper.keep('tokenomics', spec, installed)['message'])



if __name__ == '__main__':
    keeper.compat.utf8_main()
    try:
        main()
    except (OSError, RuntimeError) as error:
        raise SystemExit(str(error)) from None
