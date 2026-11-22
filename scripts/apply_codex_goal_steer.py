#!/usr/bin/env python3
"""Make Codex /goal resume, pause and clear work while a turn is running.

The Codex provider bundled with BB 0.49.0 runs these commands only when they
start a turn. Sent into a running turn they reach the model as plain text and
the Goal keeps its status. This script patches that one known provider build
on the BB server machine: the command is run instead of being steered.

Default is a check. Exit codes: 0 patched, 1 error, 2 known affected build,
3 another build (review: a newer BB may already contain the fix).
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / 'patches/provider-codex-goal-steer/patch.json'
PLUGIN = 'provider-codex'


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def bb_json(*args):
    return json.loads(subprocess.check_output(['bb', *args, '--json']))


def installed_root():
    plugin = next((p for p in bb_json('plugin', 'list')['plugins'] if p['id'] == PLUGIN), None)
    if plugin is None:
        raise RuntimeError('The Codex provider is not installed in this BB')
    if plugin.get('provenance') != 'builtin':
        raise RuntimeError('Expected the Codex provider bundled with BB')
    return Path(plugin['rootDir'])


def patched_bytes(spec, original):
    text = original.decode()
    if text.count(spec['anchor']) != 1:
        raise RuntimeError('Patch anchor not found exactly once')
    index = text.index(spec['anchor']) + len(spec['anchor'])
    return (text[:index] + spec['insert'] + text[index:]).encode()


def state(spec, root):
    target = root / spec['file']
    if not target.is_file():
        raise RuntimeError(f'{target} is missing; run on the BB server machine')
    current = sha256(target.read_bytes())
    declared = json.loads((root / 'dist/host.meta.json').read_text()).get('artifactDigest')
    if declared != current:
        raise RuntimeError('dist/host.meta.json does not match dist/host.js; restore the provider first')
    if current == spec['patchedSha256']:
        return 'patched'
    if current == spec['originalSha256']:
        return 'affected'
    return 'other'


def write_atomic(path, data):
    temporary = path.with_name(path.name + '.bb-config-tmp')
    temporary.write_bytes(data)
    os.replace(temporary, path)


def install(root, host, digest):
    meta_path = root / 'dist/host.meta.json'
    meta = json.loads(meta_path.read_text())
    meta['artifactDigest'] = digest
    write_atomic(root / 'dist/host.js', host)
    write_atomic(meta_path, (json.dumps(meta, indent=2) + '\n').encode())


def running_codex_threads():
    return [t['id'] for t in bb_json('thread', 'list')
            if t.get('providerId') == 'codex' and t.get('status') == 'active']


def require_idle(allow_active):
    active = [] if allow_active else running_codex_threads()
    if active:
        raise RuntimeError(
            'Codex threads are running: ' + ', '.join(active) + '. Nothing was changed; repeat when '
            'they are idle, or pass --allow-active.')


def reload_provider():
    subprocess.run(['bb', 'plugin', 'reload', PLUGIN], check=True)
    plugin = next(p for p in bb_json('plugin', 'list')['plugins'] if p['id'] == PLUGIN)
    if plugin.get('status') != 'running':
        raise RuntimeError(f'Codex provider is {plugin.get("status")} after reload: {plugin.get("statusDetail")}')


def switch(root, host, digest, previous, live):
    """Install a build and load it; a failed reload puts the previous build back."""
    install(root, host, digest)
    if not live:
        return
    try:
        reload_provider()
    except (RuntimeError, subprocess.CalledProcessError):
        install(root, previous, sha256(previous))
        subprocess.run(['bb', 'plugin', 'reload', PLUGIN], check=False)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--check', action='store_true', help='Report the state (default)')
    mode.add_argument('--applies', action='store_true', help='Exit 0 only for the known affected or patched build')
    mode.add_argument('--apply', action='store_true', help='Patch the known build and reload the provider')
    mode.add_argument('--restore', action='store_true', help='Put the original build back and reload the provider')
    parser.add_argument('--root', type=Path, help='Provider directory to work on instead of the installed one; never reloads')
    parser.add_argument('--backup-dir', type=Path, default=ROOT / '.local/plugin-patches/provider-codex')
    parser.add_argument('--allow-active', action='store_true', help='Change the provider even while Codex threads are running')
    args = parser.parse_args()

    spec = json.loads(SPEC.read_text())
    root = args.root or installed_root()
    current = state(spec, root)
    if args.applies:
        return 0 if current in ('affected', 'patched') else 3
    live = args.root is None
    if args.restore:
        if current != 'patched':
            print('Nothing to restore: the patch is not installed.')
            return 0
        backup = args.backup_dir / spec['originalSha256']
        original = (backup / 'host.js').read_bytes()
        if sha256(original) != spec['originalSha256']:
            raise RuntimeError(f'Backup in {backup} is not the original build')
        if live:
            require_idle(args.allow_active)
        switch(root, original, spec['originalSha256'], (root / spec['file']).read_bytes(), live)
        print('Original Codex provider build restored.')
        return 0
    if not args.apply:
        print({'patched': 'Patched: /goal commands work during a running turn.',
               'affected': 'Known affected build; run with --apply.',
               'other': 'Another provider build; review before patching (a newer BB may contain the fix).'}[current])
        return {'patched': 0, 'affected': 2, 'other': 3}[current]
    if current == 'other':
        raise RuntimeError('Another provider build; this patch is only for the build named in patch.json')
    if current == 'patched':
        print('Already patched.')
        return 0
    original = (root / spec['file']).read_bytes()
    fixed = patched_bytes(spec, original)
    if sha256(fixed) != spec['patchedSha256']:
        raise RuntimeError('Patched build checksum mismatch')
    if live:
        require_idle(args.allow_active)
    backup = args.backup_dir / spec['originalSha256']
    backup.mkdir(parents=True, exist_ok=True)
    (backup / 'host.js').write_bytes(original)
    shutil.copyfile(root / 'dist/host.meta.json', backup / 'host.meta.json')
    switch(root, fixed, spec['patchedSha256'], original, live)
    print('Codex provider patched and reloaded.' if live else 'Codex provider patched.')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (RuntimeError, OSError, subprocess.CalledProcessError, json.JSONDecodeError) as error:
        print(f'error: {error}', file=sys.stderr)
        sys.exit(1)
