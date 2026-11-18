#!/usr/bin/env python3
"""Snapshot BB through its CLI; --check reports drift without writing files."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from voice_source import is_voice_fork
import shutil
import subprocess
from pathlib import Path
from plugin_scope import externally_managed, RETIRED_PLUGINS

import platform_compat as compat

ROOT = Path(__file__).resolve().parents[1]


def bb(*args):
    result = subprocess.run(compat.argv(['bb', *args, '--json']), text=True, capture_output=True, timeout=90)
    if result.returncode:
        # Never echo settings arguments or command output: they may contain secrets.
        raise RuntimeError(f'BB command failed: {args[0]} {args[1] if len(args) > 1 else ""}')
    return json.loads(result.stdout)


def plugin_record(plugin):
    row = {key: plugin[key] for key in ('id', 'version', 'enabled')}
    row['name'] = plugin.get('name', plugin['id'])
    source = plugin['source']
    row['source'] = f'path:plugins/{plugin["id"]}' if source.startswith('path:') else source
    if plugin.get('catalogEntryId') and not source.startswith('path:') and not is_voice_fork(plugin):
        row['installSource'] = plugin['catalogEntryId'] + '@' + plugin['catalogMarketplaceName']
    return row


def public_settings(config):
    return {key: config['values'][key] for key, field in config['schema'].items()
            if not field.get('secret') and key in config['values']}


def collect():
    """Finish all reads before modifying the repo. No transcripts or auth files."""
    excluded = externally_managed(ROOT) | RETIRED_PLUGINS
    plugins = [p for p in bb('plugin', 'list')['plugins'] if p['id'] not in excluded]
    calls = {
        'settings': ('settings', 'show'),
        'ui': ('settings', 'ui', 'list'),
        'thread-list': ('thread-list', 'prefs', 'list'),
        'ai-services': ('settings', 'ai-services'),
        'machine-tabs': ('plugin', 'rpc', 'call', 'machine-tabs', 'tabs_state'),
        'concurrency': ('concurrency-limit', 'status'),
        'proxy-routing': ('proxy-manager', 'list'),
    }
    enabled = {p['id'] for p in plugins if p['enabled']}
    for name, required in [('thread-list', 'thread-list'), ('machine-tabs', 'machine-tabs'),
                           ('concurrency', 'concurrency-limit'), ('proxy-routing', 'proxy-manager')]:
        if required not in enabled:
            calls.pop(name)
    for plugin in plugins:
        if plugin.get('hasSettings'):
            calls['plugins/' + plugin['id']] = ('plugin', 'config', plugin['id'])
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {key: pool.submit(bb, *args) for key, args in calls.items()}
        results = {key: future.result() for key, future in futures.items()}
    settings = results.pop('settings')
    values = {
        'plugins': sorted(map(plugin_record, plugins), key=lambda p: p['id']),
        'general': {k: v for k, v in settings['generalSettings'].items() if k not in {
            'machineServerUrl', 'machineGitCredentialsEnabled', 'defaultMachineAccess', 'onboardingCompletedAt'}},
        'experiments': settings['experiments'],
        'appearance': {k: settings['appearance'][k] for k in ('themeId', 'customCss', 'faviconColor')},
        'keyboard': settings['keybindingOverrides'],
        'ui': {k: v['value'] for k, v in results.pop('ui')['preferences'].items()},
        'ai-services': results.pop('ai-services')['selections'],
    }
    for key, result in results.items():
        if key.startswith('plugins/'):
            values[key] = public_settings(result)
        elif key == 'machine-tabs':
            values[key] = {k: result[k] for k in ('selectedId', 'byDay', 'outer')}
        elif key == 'concurrency':
            values[key] = {k: result[k] for k in ('globalLimit', 'hostOverrides')}
        elif key == 'proxy-routing':
            values[key] = {
                'proxies': [{k: p[k] for k in ('id', 'name', 'protocol', 'host', 'port', 'authenticated') if k in p}
                            for p in result['proxies']],
                'bindings': result['bindings'],
            }
        else:
            values[key] = result
    return values, plugins


def changed_files(values, root=ROOT):
    changed = []
    for name, data in values.items():
        path = root / '.local/config' / (name + '.json')
        try:
            same = json.loads(path.read_text()) == data
        except (FileNotFoundError, json.JSONDecodeError):
            same = False
        if not same:
            changed.append(path)
    active_configs = {name for name in values if name.startswith('plugins/')}
    changed.extend(p for p in sorted((root / '.local/config/plugins').glob('*.json'))
                   if 'plugins/' + p.stem not in active_configs)
    return changed


def write_snapshot(values, root=ROOT):
    for name, data in values.items():
        path = root / '.local/config' / (name + '.json')
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        tmp = path.with_suffix('.json.tmp')
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
        tmp.chmod(0o600)
        tmp.replace(path)
    for path in (root / '.local/config/plugins').glob('*.json'):
        if 'plugins/' + path.stem not in values:
            path.unlink()


def copy_sources(plugins):
    sources = [p for p in plugins if p['source'].startswith('path:')]
    missing = [p['id'] for p in sources if not Path(p['rootDir']).is_dir()]
    if missing:
        raise RuntimeError('Plugin sources are on another machine: ' + ', '.join(missing) +
                           '. Use --settings-only; no files were changed.')
    dirty = subprocess.check_output(['git', 'status', '--porcelain', '--', 'plugins'], cwd=ROOT, text=True)
    if dirty.strip():
        raise RuntimeError('Uncommitted plugin changes: use --settings-only; no files were changed.')
    for plugin in sources:
        src, dst = Path(plugin['rootDir']), ROOT / 'plugins' / plugin['id']
        if src.resolve() == dst.resolve():
            continue
        if dst.exists():
            shutil.rmtree(dst)
        shutil.copytree(src, dst, ignore=shutil.ignore_patterns(
            'node_modules', 'dist', '.git', '.DS_Store', '.env', '.env.*', '*.log',
            '.retry-audit-*', '__pycache__'), symlinks=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--settings-only', action='store_true', help='Do not copy installed plugin sources')
    parser.add_argument('--check', action='store_true', help='Read-only drift check; exit 1 if snapshot is stale')
    args = parser.parse_args()
    try:
        values, plugins = collect()
        changed = changed_files(values)
        if args.check:
            if changed:
                print('BB customised: save these settings in bb-config:')
                for path in changed:
                    print('  ' + str(path.relative_to(ROOT)))
                print('Run: python3 scripts/snapshot.py --settings-only (private .local/config/).')
                return 1
            print('BB settings and installed plugins match the private .local/config/ snapshot.')
            return 0
        if not args.settings_only:
            copy_sources(plugins)
        write_snapshot(values)
        print('Private snapshot updated in .local/config/. Public config/ was not changed; secrets are excluded.')
        return 0
    except (RuntimeError, subprocess.SubprocessError, OSError, ValueError) as error:
        print(f'Snapshot failed: {error}')
        return 2


if __name__ == '__main__':
    compat.utf8_main()
    raise SystemExit(main())
