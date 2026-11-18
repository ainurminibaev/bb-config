#!/usr/bin/env python3
"""Switch from the catalog statistics plugin after Thread Spend has started."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile

import platform_compat as compat
from export_thread_spend_history import save_snapshot


def plugin_states():
    command = compat.argv(['bb', 'plugin', 'list', '--json'])
    result = json.loads(subprocess.check_output(command, text=True))
    return {plugin['id']: plugin for plugin in result['plugins']}


def check_rpc():
    command = compat.argv(['bb', 'plugin', 'rpc', 'call', 'thread-spend', 'health', '--json'])
    if json.loads(subprocess.check_output(command, text=True)) != {'ok': True}:
        raise RuntimeError('Thread Spend did not pass its health check.')


def check_archive():
    with tempfile.TemporaryDirectory(prefix='thread-spend-check-') as temporary:
        request = Path(temporary) / 'request.json'
        request.write_text('{"days":7}', encoding='utf-8')
        command = ['bb', 'plugin', 'rpc', 'call', 'thread-spend', 'archived',
                   '--input-file', str(request), '--json']
        value = json.loads(subprocess.check_output(compat.argv(command), text=True))
        if not isinstance(value, dict) or not isinstance(value.get('rows'), list):
            raise RuntimeError('Thread Spend cannot read the pre-switch snapshot.')


def switch(apply=False):
    states = plugin_states()
    replacement = states.get('thread-spend', {})
    if not replacement.get('enabled') or replacement.get('status') != 'running':
        raise RuntimeError('Thread Spend is not running; Tokenomics was left unchanged.')
    check_rpc()
    if states.get('tokenomics', {}).get('enabled'):
        if not apply:
            raise RuntimeError('Thread Spend is running, but Tokenomics is still enabled.')
        save_snapshot()
        check_archive()
        subprocess.run(compat.argv(['bb', 'plugin', 'disable', 'tokenomics']), check=True)
        try:
            switch()
        except (RuntimeError, OSError, ValueError, subprocess.CalledProcessError):
            subprocess.run(compat.argv(['bb', 'plugin', 'enable', 'tokenomics']), check=True)
            raise RuntimeError('Could not confirm the switch; Tokenomics was re-enabled.') from None
        return
    print('Thread Spend is running; Tokenomics is disabled or absent.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--apply', action='store_true', help='Disable Tokenomics if Thread Spend is running')
    mode.add_argument('--check', action='store_true', help='Check the switch without changing any plugins')
    try:
        switch(apply=parser.parse_args().apply)
    except (RuntimeError, OSError, ValueError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error)) from None


if __name__ == '__main__':
    compat.utf8_main()
    main()
