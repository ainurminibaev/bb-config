#!/usr/bin/env python3
"""Keep a catalog plugin on our fork: move the installation there and back, take new upstream releases.

Policy: plugins/<compat folder>/fork.json. The fork's own line is a branch; its releases are
tagged <tagPrefix>vX.Y.Z with patch = (upstream patch + 1) * 100 + build, so they can never be
mistaken for upstream ones. Voice Mode has its own older script with the same behaviour.

  applicable | check | apply | rollback   the installation of this BB (settings are kept, see `move`)
  sync [--push]              merge the newest upstream release into the own line, run its tests
                             and build in a temporary clone; only with --push send branch and tag.
                             Nothing is sent when any step fails: the installed version keeps running.
"""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile

import plugin_git_source as source

ROOT = Path(__file__).resolve().parents[1]
STABLE = re.compile(r'v(\d+)\.(\d+)\.(\d+)')


class ForkError(RuntimeError):
    pass


def policy(plugin_id):
    for path in sorted((ROOT / 'plugins').glob('*/fork.json')):
        data = json.loads(path.read_text(encoding='utf-8'))
        if data.get('id') == plugin_id and data.get('tagPrefix'):
            return data
    raise ForkError(f'No fork policy for {plugin_id}')


# ---------- Versions ----------

def parse(version):
    match = STABLE.fullmatch(version if version.startswith('v') else 'v' + version)
    return tuple(int(part) for part in match.groups()) if match else None


def base_of(own):
    """The upstream version an own version was made from."""
    major, minor, patch = own
    if patch < 100:
        raise ForkError('Not a version of the own line: ' + '.'.join(map(str, own)))
    return major, minor, patch // 100 - 1


def next_own(base, existing):
    major, minor, patch = base
    builds = [own[2] for own in existing if own[2] >= 100 and base_of(own) == base]
    number = max(builds) + 1 if builds else (patch + 1) * 100
    if number // 100 - 1 != patch:
        raise ForkError('No build numbers left for this upstream version')
    return major, minor, number


def remote_versions(url, prefix=''):
    output = run(['git', 'ls-remote', '--tags', '--refs', url])
    names = (line.rpartition('refs/tags/')[2] for line in output.splitlines())
    return sorted(filter(None, (parse(name[len(prefix):]) if name.startswith(prefix) else None for name in names)))


def run(command, cwd=None):
    result = subprocess.run(command, cwd=cwd, capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=1800)
    if result.returncode:
        raise ForkError(f'{" ".join(command[:3])} failed: {(result.stdout + result.stderr)[-1500:]}')
    return result.stdout


# ---------- Installation ----------

def on_fork(row, data):
    return bool(row) and row['source'].startswith('git:' + data['repository'] + '@')


def journal_path(plugin_id):
    directory = source.state_dir() / 'forks'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    return directory / f'{plugin_id}.json'


def apply_settings(plugin_id, values):
    for key, value in values.items():
        encoded = value if isinstance(value, str) else json.dumps(value)
        source.bb('plugin', 'config', plugin_id, 'set', key, encoded)
    actual = source.settings(plugin_id)
    if any(actual.get(key) != value for key, value in values.items()):
        raise ForkError('Settings verification failed')


def secrets_set(plugin_id):
    config = source.bb('plugin', 'config', plugin_id)
    return any(field.get('secret') and source.is_set(config['values'].get(key)) for key, field in config['schema'].items())


def install(plugin_id, desired, previous, *options):
    source.wait_for_install()
    source.install(plugin_id, desired, previous, True, *options)
    source.wait_for_install()
    source.wait_running(plugin_id)


def check(plugin_id, data):
    row = source.plugin(plugin_id)
    if not on_fork(row, data):
        print(f'{plugin_id}: not installed from the fork')
        return 1
    if row.get('status') != 'running':
        print(f'{plugin_id}: installed from the fork, status {row.get("status")}')
        return 1
    values = source.settings(plugin_id)
    if any(values.get(key) != value for key, value in data.get('settings', {}).items()):
        print(f'{plugin_id}: fork settings differ')
        return 1
    print(f'{plugin_id}: {row["version"]} from the fork')
    return 0


def applicable(plugin_id, data):
    row = source.plugin(plugin_id)
    return 0 if row and (on_fork(row, data) or row['source'].startswith(data['upstreamSource'])) else 1


def apply(plugin_id, data):
    row = source.plugin(plugin_id)
    if on_fork(row, data):
        apply_settings(plugin_id, {**data.get('settings', {})})
        return check(plugin_id, data)
    if not row or not row.get('enabled') or row.get('status') != 'running':
        raise ForkError(f'{plugin_id} is not running; nothing to move')
    if not row['source'].startswith(data['upstreamSource']):
        raise ForkError('Unexpected source; refusing to replace it')
    if secrets_set(plugin_id):
        raise ForkError('A secret setting is configured; removal would lose it. Ask the owner first')
    if not remote_versions(data['repository'], data['tagPrefix']):
        raise ForkError('The fork has no release')
    values = source.settings(plugin_id)
    journal = journal_path(plugin_id)
    source.save(journal, {'id': plugin_id, 'source': row['source'], 'version': row['version'], 'values': values})
    try:
        install(plugin_id, f'git:{data["repository"]}@{data["range"]}', row['source'], '--tag-prefix', data['tagPrefix'])
        apply_settings(plugin_id, {**values, **data.get('settings', {})})
        if check(plugin_id, data):
            raise ForkError('Fork verification failed')
    except BaseException:
        # Back to the catalog release with the same settings, whatever was left in between.
        print(f'{plugin_id}: moving back to the catalog release', flush=True)
        # A fresh install has default settings: only the saved ones count here.
        rollback(plugin_id, data, keep_current=False)
        raise
    return 0


def rollback(plugin_id, data, keep_current=True):
    values = {}
    journal = journal_path(plugin_id)
    if journal.exists():
        values = json.loads(journal.read_text(encoding='utf-8'))['values']
    source.wait_for_install()
    row = source.plugin(plugin_id)
    if row and row['source'].startswith(data['upstreamSource']):
        pass
    elif row and not on_fork(row, data):
        raise ForkError('Unexpected source; refusing to replace it')
    else:
        if row and keep_current:
            # Settings changed on the fork since the move matter more than the saved ones.
            values = {**values, **source.settings(plugin_id)}
        install(plugin_id, data['catalog'], row['source'] if row else None)
    known = source.settings(plugin_id).keys()
    apply_settings(plugin_id, {key: value for key, value in values.items() if key in known})
    print(f'{plugin_id}: catalog release restored')
    return 0


# ---------- Upstream releases ----------

def set_version(folder, version):
    run(['npm', 'version', version, '--no-git-tag-version', '--allow-same-version', '--ignore-scripts'], folder)


def sync(plugin_id, data, push):
    own = remote_versions(data['repository'], data['tagPrefix'])
    upstream = remote_versions(data['upstream'])
    if not own or not upstream:
        raise ForkError('No releases found')
    base, newest = base_of(own[-1]), upstream[-1]
    if newest <= base:
        print(f'{plugin_id}: own {".".join(map(str, own[-1]))} already has upstream {".".join(map(str, base))}')
        return 0
    tag = 'v' + '.'.join(map(str, newest))
    version = '.'.join(map(str, next_own(newest, own)))
    with tempfile.TemporaryDirectory(prefix=f'fork-{plugin_id}-') as directory:
        folder = Path(directory) / 'plugin'
        run(['git', 'clone', '-q', '-b', data['branch'], data['repository'], str(folder)])
        # Both sides change the version; take upstream's side of it and number the result after.
        set_version(folder, '.'.join(map(str, base)))
        git = ['git', '-c', 'user.name=plugin-fork', '-c', 'user.email=plugin-fork@users.noreply.github.com']
        if run(['git', 'status', '--porcelain'], folder).strip():
            run([*git, 'commit', '-qam', 'Prepare to merge ' + tag], folder)
        run(['git', 'fetch', '-q', data['upstream'], f'refs/tags/{tag}'], folder)
        try:
            run([*git, 'merge', '--no-ff', '-q', '-m', f'Merge upstream {tag}', 'FETCH_HEAD'], folder)
        except ForkError:
            files = run(['git', 'diff', '--name-only', '--diff-filter=U'], folder).split()
            raise ForkError(f'Upstream {tag} conflicts with our changes in: {", ".join(files) or "the merge"}. '
                            f'The installed version keeps working; resolve in a thread') from None
        set_version(folder, version)
        run([*git, 'commit', '-qam', f'Own line {version}: upstream {tag} with our changes'], folder)
        run(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], folder)
        run(['npm', 'run', 'typecheck'], folder)
        run(['npm', 'test'], folder)
        run(source.compat.argv(['bb', 'plugin', 'build', str(folder)]))
        if not push:
            print(f'{plugin_id}: upstream {tag} merges, tests and build pass; {version} is ready for --push')
            return 0
        run(['git', 'tag', f'{data["tagPrefix"]}v{version}'], folder)
        run(['git', 'push', '-q', '--atomic', 'origin', f'HEAD:refs/heads/{data["branch"]}', f'refs/tags/{data["tagPrefix"]}v{version}'], folder)
    print(f'{plugin_id}: released own {version} with upstream {tag}; BB offers it as an update')
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('action', choices=['applicable', 'check', 'apply', 'rollback', 'sync'])
    parser.add_argument('id')
    parser.add_argument('--push', action='store_true')
    args = parser.parse_args()
    try:
        data = policy(args.id)
        if args.action == 'sync':
            return sync(args.id, data, args.push)
        return {'applicable': applicable, 'check': check, 'apply': apply, 'rollback': rollback}[args.action](args.id, data)
    except (ForkError, source.MigrationError, subprocess.SubprocessError) as error:
        print(f'{args.id}: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
