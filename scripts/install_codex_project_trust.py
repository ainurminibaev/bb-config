#!/usr/bin/env python3
"""Install or verify the managed Codex Project Trust plugin on the BB server."""
import argparse
import json
import os
import re
import subprocess

from compat import utf8_main

PLUGIN = 'codex-project-trust'
REPOSITORY = 'git:https://github.com/ainurminibaev/bb-codex-project-trust.git'
SOURCE = f'{REPOSITORY}@^1.0.0'


def bb(*args):
    return subprocess.run(
        [os.environ.get('BB_CLI') or 'bb', *args],
        capture_output=True, text=True, check=True,
    ).stdout


def installed():
    data = json.loads(bb('plugin', 'list', '--json'))
    rows = data if isinstance(data, list) else data['plugins']
    return next((plugin for plugin in rows if plugin['id'] == PLUGIN), None)


def check(plugin):
    if plugin is None:
        print('Codex Project Trust is absent.')
        return False
    source = plugin.get('source', '')
    if not source.startswith(f'{REPOSITORY}@semver:'):
        print('Codex Project Trust is already installed from a different source.')
        return False
    if not re.fullmatch(r'1\.\d+\.\d+', plugin.get('version', '')):
        print('Codex Project Trust needs a compatible stable v1 release.')
        return False
    if not plugin['enabled']:
        print('Codex Project Trust is installed and disabled by choice.')
        return True
    if plugin.get('status') != 'running':
        print(f'Codex Project Trust is installed but {plugin.get("status", "inactive")}.')
        return False
    print(f'Codex Project Trust {plugin["version"]} is running from its managed Git source.')
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--check', action='store_true')
    mode.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    try:
        plugin = installed()
        if args.apply and plugin is None:
            bb('plugin', 'install', SOURCE, '--yes')
            plugin = installed()
        return 0 if check(plugin) else 1
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        detail = error.stderr.strip() if isinstance(error, subprocess.CalledProcessError) else str(error)
        print(f'Could not verify or install Codex Project Trust: {detail}')
        return 2


if __name__ == '__main__':
    utf8_main()
    raise SystemExit(main())
