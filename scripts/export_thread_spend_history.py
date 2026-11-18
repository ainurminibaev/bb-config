#!/usr/bin/env python3
"""Preserve the outgoing statistics using the old plugin's read-only CLI."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

import platform_compat as compat

ROOT = Path(__file__).resolve().parents[1]
WINDOWS = (1, 7, 30)
LIMIT = 1000


def normalize(row):
    tokens = row['tokens']
    context = row.get('context') or {}
    timing = row.get('turnTime') or {}
    return {
        'threadId': row['threadId'],
        'title': ' '.join((row.get('title') or '').split())[:400],
        'providerId': row['provider'],
        'input': tokens['input'], 'cacheRead': tokens['cacheRead'],
        'output': tokens['output'], 'total': tokens['total'], 'turns': row['turns'],
        'contextLatest': context.get('latest'), 'contextPeak': context.get('peak'),
        'processingMs': timing.get('totalMs'),
    }


def capture():
    captured_at = int(time.time() * 1000)
    windows = {}
    for days in WINDOWS:
        command = compat.argv(['bb', 'tokenomics', 'threads', '--days', str(days), '--limit', str(LIMIT), '--json'])
        rows = json.loads(subprocess.run(command, capture_output=True, text=True, timeout=60, check=True).stdout)
        if not isinstance(rows, list) or len(rows) >= LIMIT:
            raise RuntimeError(f'The {days}-day source is invalid or reached its limit. Archive was not saved.')
        windows[str(days)] = [normalize(row) for row in rows]
    return {'version': 1, 'capturedAt': captured_at, 'windows': windows}


def save_snapshot(root=ROOT):
    outfile = root / '.local/docs/thread-spend-history.json'
    if outfile.exists():
        print('A pre-switch snapshot already exists.')
        return
    try:
        value = capture()
    except (RuntimeError, subprocess.SubprocessError, OSError, TypeError, ValueError, KeyError) as error:
        raise RuntimeError('Could not export the old plugin statistics: ' + type(error).__name__) from None
    outfile.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=outfile.parent, delete=False) as private:
        temporary = Path(private.name)
        try:
            json.dump(value, private, ensure_ascii=False)
            private.write('\n')
            private.close()
            os.chmod(temporary, 0o600)
            temporary.replace(outfile)
        finally:
            temporary.unlink(missing_ok=True)
    print('Private snapshot saved. ' + ', '.join(f'{days}d: {len(rows)}' for days, rows in value['windows'].items()))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', required=True, help='Save the fixed snapshot privately')
    parser.parse_args()
    try:
        save_snapshot()
    except (RuntimeError, OSError) as error:
        raise SystemExit(str(error)) from None


if __name__ == '__main__':
    compat.utf8_main()
    main()
