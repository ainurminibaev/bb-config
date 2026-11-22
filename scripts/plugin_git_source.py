#!/usr/bin/env python3
"""Move a running bb-config release plugin to its versioned Git source."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

import platform_compat as compat
from updates import release_location, state_dir

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = 'git:https://github.com/ainurminibaev/bb-config.git'
PLUGIN_ID = re.compile(r'[a-z0-9]+(?:-[a-z0-9]+)*')
VERSION = re.compile(r'(\d+)\.(\d+)\.\d+')
ACTIVE_JOB = {'queued', 'running', 'pending'}


class MigrationError(RuntimeError):
    pass


class SourceConflict(MigrationError):
    pass


class NotApplicable(MigrationError):
    pass


class SecretSetting(MigrationError):
    """BB does not hand secret values out, so a removal would lose them."""


def bb(*args, as_json=True, show=False):
    if show:
        print(f'$ bb {" ".join(args)}', flush=True)
    result = subprocess.run(
        compat.argv(['bb', *args, *(['--json'] if as_json else [])]),
        capture_output=True, text=True, stdin=subprocess.DEVNULL,
    )
    if show:
        for output in (result.stdout, result.stderr):
            if output.strip():
                print(output.strip(), flush=True)
    if result.returncode:
        if args[:2] == ('plugin', 'install') and re.search(
            r'plugin id "[^"]+" is already installed from .+; remove it first',
            result.stdout + result.stderr,
        ):
            raise SourceConflict('BB requires removal before changing the source')
        # Settings commands may include values. Never echo the command or its output.
        raise MigrationError(f'bb {" ".join(args[:2])}: exit {result.returncode}')
    return json.loads(result.stdout) if as_json else None


def plugin(plugin_id):
    return next((row for row in bb('plugin', 'list')['plugins'] if row['id'] == plugin_id), None)


def settings(plugin_id):
    config = bb('plugin', 'config', plugin_id)
    if not config.get('ok'):
        raise MigrationError('BB did not return the settings schema')
    secret = {key for key, field in config['schema'].items() if field.get('secret')}
    for key, field in config['schema'].items():
        if key not in secret and field['type'] not in {'boolean', 'number', 'string', 'select'}:
            raise MigrationError(f'Unsupported setting for migration: {key}')
    # Secret values never leave BB through `config`; they are carried separately.
    values = {key: value for key, value in config['values'].items() if key not in secret}
    if values.keys() - config['schema'].keys() or any(type(value) not in (bool, int, float, str)
                                                       for value in values.values()):
        raise MigrationError('BB returned settings that cannot be restored safely')
    return values


def save(path, record):
    # NamedTemporaryFile limits access to the creating user on POSIX. Replacing
    # a complete file keeps the prior journal usable if the process is interrupted.
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, delete=False) as file:
        temporary = Path(file.name)
        json.dump(record, file, indent=2)
        file.write('\n')
        file.flush()
        os.fsync(file.fileno())
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def read(path, plugin_id):
    if not path.exists():
        return None
    record = json.loads(path.read_text(encoding='utf-8'))
    if (record['id'] != plugin_id or record['target'] != target(record['version'])
            or not record['path'].startswith('path:')
            or record['phase'] not in {'applying', 'migrated', 'rolling-back', 'rolled-back'}):
        raise MigrationError('Unexpected migration journal contents')
    return record


def target(version):
    match = VERSION.fullmatch(version)
    if not match:
        raise MigrationError(f'Expected a stable plugin version, got {version!r}')
    return f'{REPOSITORY}@^{match[1]}.{match[2]}.0'


def is_git(plugin_id, source, expected=None):
    if not source or not source.startswith(f'{REPOSITORY}@'):
        return False
    spec = bb('plugin', 'source', plugin_id)
    version_range = spec.get('range', '')
    if not re.fullmatch(r'\^\d+\.\d+\.0', version_range):
        return False
    prefix = f'{plugin_id}/'
    if expected and expected != f'{REPOSITORY}@{version_range}':
        return False
    return (spec['requested'] in {f'{REPOSITORY}@{version_range}', f'{REPOSITORY}@semver:{prefix}:{version_range}'}
            and spec.get('tagPrefix') == prefix and spec.get('subdirectory') == f'plugins/{plugin_id}')


def release_path(plugin_id, row):
    root = Path(row['rootDir'])
    source = row['source']
    release = root.parent.parent
    if (source != f'path:{root}' or root.name != plugin_id or root.parent.name != 'plugins'
            or not (release_location(release) or is_checkout(release))):
        raise NotApplicable(f'Expected a path installed from a bb-config release or checkout, got {source}')
    return source


def is_checkout(directory):
    """A bb-config working copy (the author's install runs some plugins from one)."""
    return ((directory / 'scripts' / 'plugin_git_source.py').is_file()
            and (directory / '.git').exists() and (directory / 'config' / 'bundle.json').is_file())


def verify_rollback_source(record):
    root = Path(record['path'].removeprefix('path:'))
    release_path(record['id'], {'rootDir': str(root), 'source': record['path']})
    manifest = json.loads((root / 'package.json').read_text(encoding='utf-8'))
    if manifest['version'] != record['version']:
        raise MigrationError('The original path no longer contains the original version')


def verify_running(row):
    if not row or row['status'] != 'running':
        status = row['status'] if row else 'missing'
        raise MigrationError(f'Plugin is {status}; expected running')


def verify_present(row):
    # A plugin with a required setting is "needs-configuration" until its settings are back.
    if not row:
        raise MigrationError('Plugin is missing after installation')


def wait_running(plugin_id, seconds=60):
    deadline = time.monotonic() + seconds
    row = plugin(plugin_id)
    while (not row or row['status'] != 'running') and time.monotonic() < deadline:
        time.sleep(1)
        row = plugin(plugin_id)
    verify_running(row)
    return row


# ---------- Secret settings: BB 0.50 drops them on remove, so they are carried ----------

def is_set(value):
    return value is True or (isinstance(value, dict) and value.get('set') is True) or (isinstance(value, str) and bool(value))


def set_secrets(plugin_id):
    config = bb('plugin', 'config', plugin_id)
    return [key for key, field in config['schema'].items()
            if field.get('secret') and is_set(config['values'].get(key))]


def carry_path(plugin_id):
    """A private file outside Git and outside the update journal, removed after success."""
    base = Path(os.environ.get('BB_CONFIG_SECRET_CARRY') or Path.home() / '.cache' / 'bb-config-secret-carry')
    return base / f'{plugin_id}.json'


def bb_data_dir():
    explicit = os.environ.get('BB_DATA_DIR')
    if explicit:
        return Path(explicit)
    out = subprocess.run([os.environ.get('BB_CLI') or 'bb', 'status'], capture_output=True, text=True, timeout=60)
    for line in out.stdout.splitlines():
        if line.startswith('Data dir:'):
            return Path(line.split(':', 1)[1].strip())
    raise SecretSetting('cannot find the BB data folder to carry secret settings; ask the owner first')


def carry_save(plugin_id):
    """Copy the plugin's set secret settings from BB's store before anything is removed.
    A secret that cannot be read stops the migration here."""
    path = carry_path(plugin_id)
    keys = set_secrets(plugin_id)
    if path.exists():
        return  # an interrupted migration: the saved copy is the original one
    if not keys:
        return
    store = bb_data_dir() / 'plugins' / plugin_id / 'secrets'
    values = {}
    for key in keys:
        source = store / key
        if not source.is_file():
            raise SecretSetting(f'secret setting {key!r} cannot be saved and returned; ask the owner first')
        values[key] = source.read_text(encoding='utf-8')
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as handle:
        json.dump(values, handle)
    print(f'{plugin_id}: saved {len(values)} secret setting(s) to a private file ({", ".join(values)})', flush=True)


def carry_restore(plugin_id):
    path = carry_path(plugin_id)
    if not path.exists():
        return
    values = json.loads(path.read_text(encoding='utf-8'))
    for key, value in values.items():
        bb('plugin', 'config', plugin_id, 'set', key, value)
    missing = [key for key in values if key not in set_secrets(plugin_id)]
    if missing:
        raise MigrationError(f'BB does not report {", ".join(missing)} as set after the restore')
    print(f'{plugin_id}: restored {len(values)} secret setting(s)', flush=True)


def carry_forget(plugin_id):
    path = carry_path(plugin_id)
    if path.exists():
        size = path.stat().st_size
        with path.open('r+b') as handle:
            handle.write(b'\0' * size)
            handle.flush()
            os.fsync(handle.fileno())
        path.unlink()
        print(f'{plugin_id}: private file with secret settings deleted', flush=True)


def restore_settings(plugin_id, expected):
    carry_restore(plugin_id)
    current = settings(plugin_id)
    for key in current.keys() - expected.keys():
        bb('plugin', 'config', plugin_id, 'unset', key)
    for key, value in expected.items():
        if key not in current or current[key] != value:
            encoded = value if isinstance(value, str) else json.dumps(value)
            bb('plugin', 'config', plugin_id, 'set', key, encoded)
    if settings(plugin_id) != expected:
        raise MigrationError('Settings verification failed')
    wait_running(plugin_id)


def wait_for_install():
    # The server finishes queued installs even if the invoking CLI disconnects.
    deadline = time.monotonic() + 300
    while any((job.get('state') or job.get('status')) in ACTIVE_JOB
              for job in bb('plugin', 'install-jobs')['jobs']):
        if time.monotonic() >= deadline:
            raise MigrationError('BB still has a queued or running install; retry later')
        time.sleep(1)


def newest_tag(plugin_id, version_range):
    """Highest `<id>/vX.Y.Z` tag inside a caret range `^X.Y.0`, as BB would pick it."""
    major, minor = (int(n) for n in re.fullmatch(r'\^(\d+)\.(\d+)\.0', version_range).groups())
    url = REPOSITORY.removeprefix('git:')
    out = subprocess.run(['git', 'ls-remote', '--tags', url, f'refs/tags/{plugin_id}/v*'],
                         capture_output=True, text=True, timeout=60)
    if out.returncode != 0:
        raise MigrationError(f'Cannot list tags: {out.stderr.strip()[:200]}')
    best = None
    for line in out.stdout.splitlines():
        m = re.search(rf'refs/tags/{re.escape(plugin_id)}/v(\d+)\.(\d+)\.(\d+)$', line)
        if not m:
            continue
        v = tuple(int(n) for n in m.groups())
        ok = v[0] == major and (v[1] > minor or v[1] == minor) if major > 0 else (v[0] == 0 and v[1] == minor)
        if ok and (best is None or v > best):
            best = v
    if best is None:
        raise MigrationError(f'No tag {plugin_id}/v* matches {version_range}')
    return f'{plugin_id}/v{best[0]}.{best[1]}.{best[2]}'


def prebuild(plugin_id, version_range):
    """Build the tagged plugin with production dependencies only, as a Git install does,
    before the running copy is removed: a plugin that would not build stays untouched."""
    tag = newest_tag(plugin_id, version_range)
    url = REPOSITORY.removeprefix('git:')
    with tempfile.TemporaryDirectory() as tmp:
        steps = [
            ['git', 'clone', '-q', '--depth', '1', '--branch', tag, '--filter=blob:none', '--sparse', url, tmp],
            ['git', '-C', tmp, 'sparse-checkout', 'set', f'plugins/{plugin_id}'],
        ]
        for cmd in steps:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
            if r.returncode != 0:
                raise MigrationError(f'Cannot fetch {tag}: {r.stderr.strip()[:200]}')
        root = Path(tmp) / 'plugins' / plugin_id
        if (root / 'package-lock.json').exists():
            r = subprocess.run(['npm', 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
                               cwd=root, capture_output=True, text=True, timeout=600)
            if r.returncode != 0:
                raise MigrationError(f'{tag}: npm ci failed: {r.stderr.strip()[-200:]}')
        r = subprocess.run(['bb', 'plugin', 'build', '.'], cwd=root, capture_output=True, text=True, timeout=600)
        if r.returncode != 0:
            err = next((l for l in (r.stdout + r.stderr).splitlines() if 'ERROR' in l), r.stderr.strip()[-200:])
            raise NotApplicable(f'{tag} does not build from Git with production dependencies: {err.strip()[:200]}')
    print(f'{plugin_id}: {tag} builds with production dependencies', flush=True)


def install(plugin_id, desired, previous, allow_remove, *options):
    start = time.monotonic()
    try:
        try:
            bb('plugin', 'install', desired, *options, '--yes', as_json=False, show=True)
        except SourceConflict:
            if not allow_remove:
                raise
            row = plugin(plugin_id)
            if not row or row['source'] != previous:
                raise MigrationError('The installed source changed before removal')
            print(f'{plugin_id}: removal authorized; the plugin will stop until it is installed again', flush=True)
            interrupted_at = time.monotonic()
            bb('plugin', 'remove', plugin_id, as_json=False, show=True)
            try:
                bb('plugin', 'install', desired, *options, '--yes', as_json=False, show=True)
            finally:
                print(f'{plugin_id}: remove/install commands took {time.monotonic() - interrupted_at:.1f} s',
                      flush=True)
    finally:
        print(f'{plugin_id}: installation attempt took {time.monotonic() - start:.1f} s', flush=True)


def rollback(plugin_id, journal, record, allow_remove):
    verify_rollback_source(record)
    record['phase'] = 'rolling-back'
    save(journal, record)
    row = plugin(plugin_id)
    if row and row['source'] != record['path'] and not is_git(plugin_id, row['source'], record['target']):
        raise MigrationError(f'Cannot roll back an unexpected source: {row["source"]}')
    if not row or row['source'] != record['path']:
        install(plugin_id, record['path'], row['source'] if row else None, allow_remove)
        row = plugin(plugin_id)
    verify_present(row)
    if row['source'] != record['path'] or row['version'] != record['version']:
        raise MigrationError('The original path/version was not restored')
    restore_settings(plugin_id, record['settings'])
    record['phase'] = 'rolled-back'
    save(journal, record)
    carry_forget(plugin_id)
    print(f'{plugin_id}: {row["source"]}, {row["version"]}, running; original settings verified')


def apply(plugin_id, journal, record, allow_remove):
    row = plugin(plugin_id)
    if record and record['phase'] == 'rolling-back':
        rollback(plugin_id, journal, record, allow_remove)
        raise MigrationError('An interrupted rollback finished; run --apply again to retry the migration')
    if record and record['phase'] == 'rolled-back':
        record = None
    if row and is_git(plugin_id, row['source'], record['target'] if record else None):
        if record and record['phase'] == 'applying':
            try:
                restore_settings(plugin_id, record['settings'])
            except MigrationError:
                rollback(plugin_id, journal, record, allow_remove)
                raise
            record['phase'] = 'migrated'
            save(journal, record)
            carry_forget(plugin_id)
            print(f'{plugin_id}: {row["version"]}, running; original settings verified')
        else:
            verify_running(row)
            if record and settings(plugin_id) != record['settings']:
                raise MigrationError('Already on Git, but settings differ from the migration journal')
            print(f'{plugin_id}: already on Git, {row["version"]}, running')
        return

    new_record = record is None
    if new_record:
        verify_running(row)
        record = {'id': plugin_id, 'path': release_path(plugin_id, row),
                  'version': row['version'], 'target': target(row['version']),
                  'settings': settings(plugin_id), 'phase': 'applying'}
    if row and row['source'] != record['path']:
        raise MigrationError(f'Unexpected source during migration: {row["source"]}')
    verify_rollback_source(record)
    if new_record:
        save(journal, record)
        print(f'{plugin_id}: saved the original source and settings in {journal}', flush=True)
    prebuild(plugin_id, record['target'].rsplit('@', 1)[1])
    carry_save(plugin_id)

    try:
        install(plugin_id, record['target'], record['path'], allow_remove,
                '--subdirectory', f'plugins/{plugin_id}', '--tag-prefix', f'{plugin_id}/')
        row = plugin(plugin_id)
        verify_present(row)
        if not is_git(plugin_id, row['source'], record['target']):
            raise MigrationError('BB did not record the expected Git source, range and tag prefix')
        restore_settings(plugin_id, record['settings'])
    except MigrationError:
        wait_for_install()
        rollback(plugin_id, journal, record, allow_remove)
        raise

    record['phase'] = 'migrated'
    save(journal, record)
    carry_forget(plugin_id)
    print(f'{plugin_id}: {row["source"]}, {row["version"]}, running; original settings verified')


def check(plugin_id, journal, applicable=False):
    row = plugin(plugin_id)
    record = read(journal, plugin_id)
    if not row:
        if record and record['phase'] in {'applying', 'rolling-back'}:
            print(f'{plugin_id}: interrupted migration ({record["phase"]})')
            return 0 if applicable else 1
        raise NotApplicable(f'{plugin_id}: not installed')
    print(f'{plugin_id}: {row["source"]}, {row["version"]}, {row["status"]}')
    if is_git(plugin_id, row['source'], record['target'] if record else None):
        if applicable:
            return 0
        verify_running(row)
        if record and (record['phase'] != 'migrated' or settings(plugin_id) != record['settings']):
            print(f'{plugin_id}: Git source present, but migration verification is incomplete')
            return 1
        print(f'{plugin_id}: Git migration verified')
        return 0
    release_path(plugin_id, row)
    print(f'{plugin_id}: migration needed ({target(row["version"])})')
    return 0 if applicable else 1


def run_one(action, plugin_id, allow_remove):
    journal = state_dir(ROOT) / 'plugin-git-source' / f'{plugin_id}.json'
    try:
        if action in {'applicable', 'check'}:
            return check(plugin_id, journal, applicable=action == 'applicable')
        journal.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with journal.with_suffix('.lock').open('a') as lock:
            compat.lock(lock)
            wait_for_install()
            record = read(journal, plugin_id)
            if action == 'apply':
                apply(plugin_id, journal, record, allow_remove)
            elif record:
                rollback(plugin_id, journal, record, allow_remove)
            else:
                raise MigrationError('No recorded original source and settings')
        return 0
    except SecretSetting as error:
        print(f'{plugin_id}: {error}', file=sys.stderr)
        return 1 if action == 'applicable' else 4
    except NotApplicable as error:
        print(error, file=sys.stderr)
        return 1 if action == 'applicable' else 2
    except SourceConflict as error:
        print(f'{plugin_id}: {error}. Rerun with --allow-remove only if removal is authorized.', file=sys.stderr)
        return 3
    except (MigrationError, OSError, ValueError, KeyError) as error:
        print(f'{plugin_id}: {error}', file=sys.stderr)
        # The release runner interprets a nonzero applicability check as
        # "skip". Surface a real error from --apply instead of skipping it.
        return 0 if action == 'applicable' else 2


def skipped(plugin_id):
    """A plugin this step leaves alone: not installed (excluded by the user) or
    installed from a source the user chose (not a bb-config release folder)."""
    row = plugin(plugin_id)
    if row is None:
        return read(state_dir(ROOT) / 'plugin-git-source' / f'{plugin_id}.json', plugin_id) is None
    if row['source'].startswith(f'{REPOSITORY}@'):
        return False
    try:
        release_path(plugin_id, row)
        return False
    except NotApplicable:
        return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    for action in ('applicable', 'check', 'apply', 'rollback'):
        mode.add_argument(f'--{action}', dest='action', action='store_const', const=action)
    parser.add_argument('--allow-remove', action='store_true',
                        help='allow BB to remove a plugin if a direct source change is refused')
    parser.add_argument('ids', nargs='+', metavar='id')
    args = parser.parse_args()
    for plugin_id in args.ids:
        if not PLUGIN_ID.fullmatch(plugin_id):
            parser.error(f'expected a BB plugin id, got {plugin_id!r}')
    if len(args.ids) == 1:
        return run_one(args.action, args.ids[0], args.allow_remove)
    # Several plugins: one at a time, in order; stop at the first failure so a
    # problem is looked at before the next plugin is removed.
    codes = []
    for plugin_id in args.ids:
        if skipped(plugin_id):
            print(f'{plugin_id}: not installed from a bb-config release — left as is')
            continue
        code = run_one(args.action, plugin_id, args.allow_remove)
        codes.append(code)
        if args.action == 'applicable' and code == 0:
            return 0
        if args.action in {'apply', 'rollback'} and code != 0:
            if code == 4:
                print('Остановлено: у плагина есть секретная настройка, которую шаг не может вернуть. '
                      'Спросите владельца установки, прежде чем переводить этот плагин.', file=sys.stderr)
            return code
    if args.action == 'applicable':
        return 1
    return max(codes, default=0)


if __name__ == '__main__':
    compat.utf8_main()
    sys.exit(main())
