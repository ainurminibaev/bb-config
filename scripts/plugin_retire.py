#!/usr/bin/env python3
"""Remove a plugin bb-config no longer ships: config/retired-plugins.json lists them with the reason.

  applicable <id>   0 when the plugin is installed here (there is something to remove)
  check <id>        0 when it is not installed
  apply <id>        remove it with `bb plugin remove`; nothing else of the installation changes
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys

import plugin_git_source as source

ROOT = Path(__file__).resolve().parents[1]


def retired(plugin_id, path=ROOT / 'config/retired-plugins.json'):
    for row in json.loads(path.read_text(encoding='utf-8')):
        if row.get('id') == plugin_id:
            return row
    raise ValueError(f'{plugin_id} is not in config/retired-plugins.json')


def applicable(plugin_id):
    return 0 if source.plugin(plugin_id) else 1


def check(plugin_id):
    row = source.plugin(plugin_id)
    if row:
        print(f'{plugin_id}: still installed ({row.get("version")}, {row.get("source")})')
        return 1
    print(f'{plugin_id}: not installed')
    return 0


def apply(plugin_id):
    if source.plugin(plugin_id):
        source.wait_for_install()
        source.bb('plugin', 'remove', plugin_id, as_json=False, show=True)
    return check(plugin_id)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('action', choices=['applicable', 'check', 'apply'])
    parser.add_argument('id')
    args = parser.parse_args()
    try:
        retired(args.id)
        return {'applicable': applicable, 'check': check, 'apply': apply}[args.action](args.id)
    except (ValueError, source.MigrationError, subprocess.SubprocessError) as error:
        print(f'{args.id}: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
