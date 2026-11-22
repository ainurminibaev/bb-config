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
    for key, field in config['schema'].items():
        if field.get('secret') or field['type'] not in {'boolean', 'number', 'string'}:
            raise MigrationError(f'Unsupported setting for migration: {key}')
    values = config['values']
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
            or not release_location(release)):
        raise NotApplicable(f'Expected a path installed from a bb-config release, got {source}')
    return source


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


def restore_settings(plugin_id, expected):
    current = settings(plugin_id)
    for key in current.keys() - expected.keys():
        bb('plugin', 'config', plugin_id, 'unset', key)
    for key, value in expected.items():
        if key not in current or current[key] != value:
            encoded = value if isinstance(value, str) else json.dumps(value)
            bb('plugin', 'config', plugin_id, 'set', key, encoded)
    if settings(plugin_id) != expected:
        raise MigrationError('Settings verification failed')
    verify_running(plugin(plugin_id))


def wait_for_install():
    # The server finishes queued installs even if the invoking CLI disconnects.
    deadline = time.monotonic() + 300
    while any((job.get('state') or job.get('status')) in ACTIVE_JOB
              for job in bb('plugin', 'install-jobs')['jobs']):
        if time.monotonic() >= deadline:
            raise MigrationError('BB still has a queued or running install; retry later')
        time.sleep(1)


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
    verify_running(row)
    if row['source'] != record['path'] or row['version'] != record['version']:
        raise MigrationError('The original path/version was not restored')
    restore_settings(plugin_id, record['settings'])
    record['phase'] = 'rolled-back'
    save(journal, record)
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
                verify_running(row)
                restore_settings(plugin_id, record['settings'])
            except MigrationError:
                rollback(plugin_id, journal, record, allow_remove)
                raise
            record['phase'] = 'migrated'
            save(journal, record)
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

    try:
        install(plugin_id, record['target'], record['path'], allow_remove,
                '--subdirectory', f'plugins/{plugin_id}', '--tag-prefix', f'{plugin_id}/')
        row = plugin(plugin_id)
        verify_running(row)
        if not is_git(plugin_id, row['source'], record['target']):
            raise MigrationError('BB did not record the expected Git source, range and tag prefix')
        restore_settings(plugin_id, record['settings'])
    except MigrationError:
        wait_for_install()
        rollback(plugin_id, journal, record, allow_remove)
        raise

    record['phase'] = 'migrated'
    save(journal, record)
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    for action in ('applicable', 'check', 'apply', 'rollback'):
        mode.add_argument(f'--{action}', dest='action', action='store_const', const=action)
    parser.add_argument('--allow-remove', action='store_true',
                        help='allow BB to remove this plugin if a direct source change is refused')
    parser.add_argument('id')
    args = parser.parse_args()
    if not PLUGIN_ID.fullmatch(args.id):
        parser.error('expected a BB plugin id')
    journal = state_dir(ROOT) / 'plugin-git-source' / f'{args.id}.json'
    try:
        if args.action in {'applicable', 'check'}:
            return check(args.id, journal, applicable=args.action == 'applicable')
        journal.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with journal.with_suffix('.lock').open('a') as lock:
            compat.lock(lock)
            wait_for_install()
            record = read(journal, args.id)
            if args.action == 'apply':
                apply(args.id, journal, record, args.allow_remove)
            elif record:
                rollback(args.id, journal, record, args.allow_remove)
            else:
                raise MigrationError('No recorded original source and settings')
        return 0
    except NotApplicable as error:
        print(error, file=sys.stderr)
        return 1 if args.action == 'applicable' else 2
    except SourceConflict as error:
        print(f'{args.id}: {error}. Rerun with --allow-remove only if removal is authorized.', file=sys.stderr)
        return 3
    except (MigrationError, OSError, ValueError, KeyError) as error:
        print(f'{args.id}: {error}', file=sys.stderr)
        # The release runner interprets a nonzero applicability check as
        # "skip". Surface a real error from --apply instead of skipping it.
        return 0 if args.action == 'applicable' else 2


if __name__ == '__main__':
    compat.utf8_main()
    sys.exit(main())
