#!/usr/bin/env python3
"""Keeps small source fixes on catalog plugins across their updates.

For each kept plugin (Needs You, Tokenomics, KodaForge), on every run:

- the fix is already in the installed source → nothing to do;
- the author has shipped the fix (our pull request merged, or their own) →
  nothing to do, and the status says so: the patch is no longer needed;
- otherwise the fix is applied to a copy of the installed source using a
  source rewrite or a patch with fuzz. The copy is built before the files
  are put in place and the plugin is reloaded.
  A failed reload restores the original files and bundle.

Nothing is applied when the patch does not fit: the plugin keeps running as
its author released it and the status asks for attention. Catalog sources,
settings and data are never touched; no network access, no npm install.
Prints one JSON status line per plugin.
"""
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
STATE_DIR = REPO / '.local/plugin-patches/kept'
sys.path.insert(0, str(REPO / 'scripts'))
import platform_compat as compat  # noqa: E402
import tokenomics_compat  # noqa: E402

KEPT = {
    'inbox': {
        'name': 'Needs You',
        'source': 'git:https://github.com/notpritam/bb-plugin-inbox.git@',
        'patches': ['plugins/inbox-compat/app.patch'],
        'files': ['app.tsx'],
        # Shipped upstream when the listener no longer uses the ignored slot.
        'shipped': lambda text: 'experimental_sidebarAccessory' not in text['app.tsx']
                                and 'experimental_appOverlay' in text['app.tsx'],
    },
    'tokenomics': {
        'name': 'Tokenomics',
        'source': 'git:https://github.com/danielbachhuber/bb-plugins.git@',
        'files': ['server.ts'],
        'rewrite': tokenomics_compat.rewrite,
    },
    'kodaforge': {
        'name': 'KodaForge',
        'source': 'git:https://github.com/Kodaks94/bb-plugin-kodaforge.git@',
        'patches': ['plugins/kodaforge-compat/editor.patch', 'plugins/kodaforge-compat/terminal.patch',
                    'plugins/kodaforge-compat/tabs.patch'],
        'overlays': ['plugins/kodaforge-compat/workspace-close.patch',
                     'plugins/kodaforge-compat/workspace-close-menu.patch'],
        'files': ['components/EditorGroup.tsx', 'components/TerminalPanel.tsx', 'app.tsx', 'server.ts'],
        # Shipped when the editor sets its own unicode highlighting, the terminal
        # no longer waits on the idle poll interval, and tabs can be closed at once.
        'shipped': lambda text: 'unicodeHighlight' in text['components/EditorGroup.tsx']
                                and 'nextPollDelay' not in text['components/TerminalPanel.tsx']
                                and 'Close all' in text['app.tsx'],
    },
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def plugins():
    return {p['id']: p for p in json.loads(subprocess.check_output(compat.argv(['bb', 'plugin', 'list', '--json'])))['plugins']}


def run(command, cwd=None, data=None):
    # Bytes in and out: text mode on Windows would turn the patch's LF into CRLF.
    result = subprocess.run(compat.argv(command), cwd=cwd, input=None if data is None else data.encode(),
                            capture_output=True, timeout=180)
    result.stdout, result.stderr = (stream.decode(errors='replace') for stream in (result.stdout, result.stderr))
    if result.returncode:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        log = STATE_DIR / 'last-validation.log'
        log.write_text((result.stdout + result.stderr)[-32_768:])
        log.chmod(0o600)
        raise RuntimeError('failed: ' + ' '.join(Path(command[0]).name.split()[:1] + command[1:3]))
    return result.stdout


def patch_text(spec):
    return ''.join((REPO / name).read_text() for name in spec['patches'])


def unix_lines(data):
    return data.replace(b'\r\n', b'\n')


def applied(folder, spec):
    """True when reversing the patch would succeed, i.e. it is already in place."""
    # git apply never guesses a direction, unlike patch in batch mode. It runs on
    # LF copies: Git for Windows may have checked the plugin out with CRLF.
    with tempfile.TemporaryDirectory(prefix='kept-check-') as directory:
        for name in spec['files']:
            copy = Path(directory) / name
            copy.parent.mkdir(parents=True, exist_ok=True)
            copy.write_bytes(unix_lines((Path(folder) / name).read_bytes()))
        result = subprocess.run(['git', 'apply', '--check', '--reverse', '-p1', '-'],
                                cwd=directory, input=patch_text(spec).encode(), capture_output=True)
    return result.returncode == 0


def missing_base(root, spec, text):
    if spec['shipped'](text):
        return []
    return [name for name in spec['patches'] if not applied(root, {**spec, 'patches': [name]})]


def pending_patches(root, spec, text):
    """Unwind installed overlays before checking their prerequisites."""
    overlays = spec.get('overlays', [])
    if not overlays:
        return missing_base(root, spec, text)

    with tempfile.TemporaryDirectory(prefix='kept-overlays-') as directory:
        base = Path(directory)
        for name in spec['files']:
            copy = base / name
            copy.parent.mkdir(parents=True, exist_ok=True)
            copy.write_bytes(unix_lines((root / name).read_bytes()))
        missing = []
        for overlay in reversed(overlays):
            if applied(base, {**spec, 'patches': [overlay]}):
                run(['git', 'apply', '--reverse', '-'], cwd=base, data=(REPO / overlay).read_text())
            else:
                missing.append(overlay)
        original = {name: (base / name).read_text() for name in spec['files']}
        return missing_base(base, spec, original) + list(reversed(missing))


def keep(plugin_id, spec, installed):
    plugin = installed.get(plugin_id)
    status = {'plugin': plugin_id, 'name': spec['name'], 'version': (plugin or {}).get('version', '')}
    if not plugin or not plugin.get('enabled'):
        return {**status, 'state': 'idle', 'message': f"{spec['name']} выключен или не установлен."}
    if not plugin['source'].startswith(spec['source']):
        return {**status, 'state': 'idle', 'message': f"{spec['name']} установлен не из каталога: исправление не нужно."}
    root = Path(plugin['rootDir'])
    before = {name: (root / name).read_bytes() for name in spec['files']}
    rewrite = spec.get('rewrite')
    if rewrite:
        fixed = rewrite(before['server.ts'], plugin['version'])
        if fixed == before['server.ts']:
            return {**status, 'state': 'ready', 'message': f"Исправление {spec['name']} на месте."}
    else:
        receipt_path = STATE_DIR / f'{plugin_id}-receipt.json'
        hashes = {name: digest(data) for name, data in before.items()}
        # Applied by us earlier, possibly with fuzz: the exact result is recorded.
        overlays = spec.get('overlays', [])
        patch_digest = digest(patch_text({'patches': spec['patches'] + overlays}).encode())
        receipt = json.loads(receipt_path.read_text()) if receipt_path.exists() else {}
        if receipt.get('hashes') == hashes and receipt.get('patchDigest') == patch_digest:
            return {**status, 'state': 'ready', 'message': f"Исправление {spec['name']} на месте."}
        text = {name: unix_lines(data).decode() for name, data in before.items()}
        pending = pending_patches(root, spec, text)
        if not pending:
            upstream = not overlays and spec['shipped'](text) and not applied(root, spec)
            message = (f"Исправление уже есть у автора {spec['name']}: патч больше не нужен." if upstream
                       else f"Исправление {spec['name']} на месте.")
            return {**status, 'state': 'ready', 'message': message}

    with tempfile.TemporaryDirectory(prefix=f'kept-{plugin_id}-') as directory:
        stage = Path(directory) / 'plugin'
        shutil.copytree(root, stage, ignore=shutil.ignore_patterns('node_modules', 'dist', '.git'))
        # The copy builds against the installed dependencies (next to the
        # source, or above it in a monorepo checkout).
        modules = next((folder / 'node_modules' for folder in (root, *root.parents)
                        if (folder / 'node_modules').is_dir()), None)
        if modules:
            compat.link_directory(stage / 'node_modules', modules)
        try:
            if rewrite:
                (stage / 'server.ts').write_bytes(fixed)
            else:
                # Normalize for patch; restore the checkout's line endings afterward.
                crlf = [name for name in spec['files'] if b'\r\n' in before[name]]
                for name in crlf:
                    (stage / name).write_bytes(unix_lines(before[name]))
                run(['patch', '--batch', '--silent', '--forward', '--no-backup-if-mismatch', '-p1', '--fuzz=2'],
                    cwd=stage, data=patch_text({'patches': pending}))
            run(['bb', 'plugin', 'build', str(stage)])
            if not rewrite:
                for name in crlf:
                    (stage / name).write_bytes(unix_lines((stage / name).read_bytes()).replace(b'\n', b'\r\n'))
        finally:
            # Before the temporary copy is deleted: the link leads to the installed dependencies.
            compat.unlink_directory(stage / 'node_modules')
        current = plugins().get(plugin_id)
        if not current or current['rootDir'] != str(root):
            raise RuntimeError(f"{spec['name']} changed again during validation; retrying later")
        if any(digest((root / name).read_bytes()) != digest(data) for name, data in before.items()):
            raise RuntimeError(f"{spec['name']} source changed during validation")
        backup = Path(tempfile.mkdtemp(prefix=f'{plugin_id}-backup-', dir=STATE_DIR))
        if (root / 'dist').exists():
            shutil.copytree(root / 'dist', backup / 'dist')
        try:
            for name in spec['files']:
                shutil.copy2(stage / name, root / name)
            shutil.copytree(stage / 'dist', root / 'dist', dirs_exist_ok=True)
            run(['bb', 'plugin', 'reload', plugin_id])
            active = plugins().get(plugin_id)
            if not active or active['rootDir'] != str(root) or active.get('status') != 'running':
                raise RuntimeError(f"{spec['name']} did not start with the fix")
        except BaseException:
            for name, data in before.items():
                (root / name).write_bytes(data)
            if (backup / 'dist').exists():
                shutil.copytree(backup / 'dist', root / 'dist', dirs_exist_ok=True)
            run(['bb', 'plugin', 'reload', plugin_id])
            raise
        finally:
            shutil.rmtree(backup, ignore_errors=True)
    if not rewrite:
        receipt_path.write_text(json.dumps({
            'hashes': {name: digest((root / name).read_bytes()) for name in spec['files']},
            'version': plugin.get('version', ''), 'patchDigest': patch_digest,
        }))
    return {**status, 'state': 'ready', 'message': f"Исправление {spec['name']} восстановлено после обновления."}


def main():
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    only = sys.argv[1:] or list(KEPT)
    with (STATE_DIR / 'keeper.lock').open('w') as lock:
        if not compat.try_lock(lock):
            return
        installed = plugins()
        for plugin_id in only:
            spec = KEPT[plugin_id]
            try:
                result = keep(plugin_id, spec, installed)
            except Exception as error:  # noqa: BLE001 - report, never break the plugin
                (STATE_DIR / f'{plugin_id}-error.txt').write_text(type(error).__name__ + ': ' + str(error)[:1000])
                result = {'plugin': plugin_id, 'name': spec['name'], 'version': installed.get(plugin_id, {}).get('version', ''),
                          'state': 'attention',
                          'message': f"Новая версия {spec['name']} работает как у автора: исправление не подошло к её коду."}
            print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    compat.utf8_main()
    main()
