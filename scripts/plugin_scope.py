#!/usr/bin/env python3
"""Plugin homes: which repository owns each BB plugin.

config/plugin-homes.json (public) and .local/config/plugin-homes.json (private,
wins per plugin ID) map a plugin ID to its single home:

  bb-config  sources/settings are snapshotted and restored here (default for
             plugins already in the bb-config manifest);
  project    the plugin belongs to a project repository and is installed from
             there; bb-config keeps no code or settings for it;
  ignore     not tracked by bb-config at all.

The legacy config/externally-managed-plugins.json list is still read; its IDs
are treated as `ignore` unless plugin-homes.json says otherwise.

CLI:  plugin_scope.py show [ID]       print homes (or one) and unknown plugins
      plugin_scope.py set ID bb-config|ignore [--note TEXT] [--private]
      plugin_scope.py set ID project --project NAME --install CMD
                          [--source PATH_OR_REPO] [--note TEXT] [--private]
"""
import argparse
import json
from pathlib import Path
import shlex
import subprocess

ROOT = Path(__file__).resolve().parents[1]
HOMES = ('bb-config', 'project', 'ignore')
PUBLIC = 'config/plugin-homes.json'
PRIVATE = '.local/config/plugin-homes.json'
LEGACY = 'config/externally-managed-plugins.json'


def _legacy(root):
    path = root / LEGACY
    if not path.exists():
        return set()
    data = json.loads(path.read_text())
    if not isinstance(data, list) or any(not isinstance(x, str) or not x for x in data):
        raise ValueError('externally-managed-plugins.json must contain plugin IDs')
    return set(data)


def validate(plugin_id, record):
    if not isinstance(record, dict) or record.get('home') not in HOMES:
        raise ValueError(f'plugin-homes.json: {plugin_id}: home must be one of {", ".join(HOMES)}')
    for key in ('note', 'source', 'project', 'install'):
        if key in record and (not isinstance(record[key], str) or not record[key].strip()):
            raise ValueError(f'plugin-homes.json: {plugin_id}: {key} must be a non-empty string')
    if record['home'] == 'project':
        if 'project' not in record or 'install' not in record:
            raise ValueError(f'plugin-homes.json: {plugin_id}: project home needs project and install')
        argv = shlex.split(record['install'])
        script = Path(argv[1] if len(argv) > 1 else argv[0]) if argv else Path('/')
        if script.is_absolute() or '..' in script.parts:
            raise ValueError(f'plugin-homes.json: {plugin_id}: install must run a path relative to the project')
    return record


def _read(path):
    if not path.exists():
        return {}
    data = json.loads(path.read_text())
    if not isinstance(data, dict):
        raise ValueError(str(path.name) + ' must map plugin IDs to homes')
    return data


def homes(root=ROOT):
    """Explicit homes: legacy list (ignore) < public file < private file."""
    result = {plugin_id: {'home': 'ignore', 'note': 'legacy externally-managed list'}
              for plugin_id in _legacy(root)}
    result.update(_read(root / PUBLIC))
    result.update(_read(root / PRIVATE))
    return {plugin_id: validate(plugin_id, record) for plugin_id, record in result.items()}


def outside(root=ROOT):
    """IDs whose code and settings bb-config must not copy or restore."""
    return {plugin_id for plugin_id, record in homes(root).items() if record['home'] != 'bb-config'}


def externally_managed(root=ROOT):
    """Backward-compatible name used by older callers."""
    return outside(root)


def project_homes(root=ROOT):
    return {plugin_id: record for plugin_id, record in homes(root).items() if record['home'] == 'project'}


def manifest_ids(root=ROOT):
    ids = set()
    for name in ('config/plugins.json', '.local/config/plugins.json'):
        path = root / name
        if path.exists():
            ids.update(p['id'] for p in json.loads(path.read_text()))
    return ids


def unknown(installed_ids, root=ROOT):
    """Installed plugins that have no home yet: neither recorded nor in the manifest."""
    known = set(homes(root)) | manifest_ids(root)
    return sorted(set(installed_ids) - known)


def project_roots(name):
    """Local checkouts of a BB project on this machine (via the bb CLI)."""
    try:
        listing = json.loads(subprocess.check_output(['bb', 'project', 'list', '--json'], text=True,
                                                     stderr=subprocess.DEVNULL))
        projects = listing if isinstance(listing, list) else listing.get('projects', [])
        roots = []
        for project in projects:
            if project.get('name') != name:
                continue
            shown = json.loads(subprocess.check_output(['bb', 'project', 'show', project['id'], '--json'],
                                                       text=True, stderr=subprocess.DEVNULL))
            roots += [Path(s['path']) for s in shown.get('sources', []) if s.get('path')]
        return [root for root in roots if root.is_dir()]
    except (OSError, subprocess.CalledProcessError, ValueError, KeyError):
        return []


def write_home(plugin_id, record, private=False, root=ROOT):
    path = root / (PRIVATE if private else PUBLIC)
    data = _read(path)
    data[plugin_id] = validate(plugin_id, record)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(dict(sorted(data.items())), ensure_ascii=False, indent=2) + '\n')
    return path


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    show = sub.add_parser('show')
    show.add_argument('id', nargs='?')
    put = sub.add_parser('set')
    put.add_argument('id')
    put.add_argument('home', choices=HOMES)
    for option in ('--project', '--install', '--source', '--note'):
        put.add_argument(option)
    put.add_argument('--private', action='store_true', help='Write to .local/config (not in Git)')
    args = parser.parse_args(argv)
    if args.command == 'set':
        record = {'home': args.home}
        for key in ('project', 'source', 'install', 'note'):
            if getattr(args, key):
                record[key] = getattr(args, key)
        path = write_home(args.id, record, args.private, ROOT)
        print(f'{args.id}: {args.home} -> {path.relative_to(ROOT)}')
        return 0
    data = homes(ROOT)
    if args.id:
        manifest = args.id in manifest_ids(ROOT)
        record = data.get(args.id) or ({'home': 'bb-config', 'note': 'in bb-config manifest'} if manifest else None)
        print(json.dumps(record, ensure_ascii=False) if record else f'{args.id}: no home yet (ask the user)')
        return 0 if record else 1
    print(json.dumps(data, ensure_ascii=False, indent=2))
    try:
        listing = json.loads(subprocess.check_output(['bb', 'plugin', 'list', '--json'], text=True,
                                                     stderr=subprocess.DEVNULL))
        missing = unknown((p['id'] for p in listing.get('plugins', [])), ROOT)
        if missing:
            print('Installed plugins without a home: ' + ', '.join(missing))
    except (OSError, subprocess.CalledProcessError, ValueError):
        print('BB is unreachable: installed plugins were not checked.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
