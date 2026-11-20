#!/usr/bin/env python3
"""Converge a BB installation to the declared bb-config set (config/bundle.json).

One install or one update runs `apply`: every declared component that is
missing is installed, every older one is updated, configuration hooks are
checked and repaired. It keeps what the user decided:

  - a component the user excluded (`exclude <id>`, or a refusal recorded in
    the update journal) is never installed;
  - a disabled plugin is updated but stays disabled;
  - a plugin installed from a different source (own fork, newer build) is
    kept and reported, never replaced;
  - settings, secrets and schedules stay with BB: install and update go
    through `bb plugin` only.

Personal authorization, settings and actions on other machines cannot be done
here: the report lists them under `attention`, and newly installed ones are
marked `new`.

  check     report; exit 0 when converged, 2 when something is left
  apply     converge, then report; exit 0 when converged, 1 otherwise
  exclude   remember that the user does not want a component
  include   forget such a decision

Run on the BB server machine (plugin path sources are read by the server).
Output is JSON. Procedure: docs/updates.md.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import platform_compat as compat  # noqa: E402
import updates  # noqa: E402
from plugin_scope import externally_managed  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
KINDS = {'local', 'git', 'catalog'}
SELECTION = 'selection.json'
DONE = {'ok', 'installed', 'updated', 'reinstalled', 'configured', 'kept-source', 'kept-newer', 'excluded'}


def load(root):
    """Declared components in install order, without separately managed products."""
    data = json.loads((root / 'config/bundle.json').read_text(encoding='utf-8'))
    problems = errors(data, root)
    if problems:
        raise updates.UpdateError('config/bundle.json: ' + '; '.join(problems))
    outside = externally_managed(root)
    data['components'] = [c for c in data['components'] if c['id'] not in outside]
    return data


def errors(data, root):
    if not isinstance(data, dict) or data.get('schemaVersion') != 1 or not isinstance(data.get('components'), list):
        return ['schemaVersion 1 with a components list is required']
    problems, seen = [], set()
    for component in data['components']:
        name = component.get('id')
        if not isinstance(name, str) or not updates.STEP_ID.match(name) or name in seen:
            problems.append(f'invalid or repeated id {name!r}')
            continue
        kind = component.get('kind')
        if kind not in KINDS:
            problems.append(f'{name}: kind must be one of {sorted(KINDS)}')
        if kind == 'local' and not (root / 'plugins' / name / 'package-lock.json').is_file():
            problems.append(f'{name}: plugins/{name} needs package.json and package-lock.json')
        if kind in {'git', 'catalog'}:
            if not str(component.get('source', '')).startswith('git:') or not component.get('install'):
                problems.append(f'{name}: {kind} needs source (git:<url>@) and install')
            if not updates.PLUGIN_VERSION.fullmatch(str(component.get('min', ''))):
                problems.append(f'{name}: min must be X.Y.Z')
        for dependency in component.get('requires', []):
            if dependency not in seen:
                problems.append(f'{name}: requires {dependency}, which must be declared before it')
        for hook in component.get('configure', []) + ([component['adopt']] if component.get('adopt') else []):
            if not all(isinstance(hook.get(k), list) and hook[k] for k in ('check', 'apply')):
                problems.append(f'{name}: hooks need check and apply argv lists')
        seen.add(name)
    return problems


# --- the user's choices ------------------------------------------------------

def selection_path(root):
    return updates.state_dir(root) / SELECTION


def read_selection(root):
    path = selection_path(root)
    data = json.loads(path.read_text(encoding='utf-8')) if path.is_file() else {}
    data.setdefault('excluded', {})
    return data


def write_selection(root, data):
    path = selection_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    os.replace(temporary, path)


def refusals(root):
    """Components the user declined when a release offered them (`record … not-applicable`)."""
    path = updates.state_dir(root) / 'journal.json'
    if not path.is_file():
        return {}
    entries = json.loads(path.read_text(encoding='utf-8')).get('entries', [])
    declined = {}
    for entry in entries:
        step = entry['step'].split('/', 1)[-1]
        if entry.get('how') == 'evidence' and entry.get('status') == 'not-applicable' and step.startswith('plugin-'):
            declined[step.removeprefix('plugin-')] = entry.get('detail') or 'declined during an update'
    return declined


def excluded(root, components, installed=None):
    """{id: reason}. An explicit exclusion always counts; a refusal recorded during
    an update only while the plugin is still absent (installing it later means
    the user changed their mind)."""
    ids = {c['id'] for c in components}
    chosen = {k: v.get('reason', '') for k, v in read_selection(root)['excluded'].items()}
    present = set(installed or ())
    found = {k: v for k, v in refusals(root).items() if k in ids and k not in present}
    return {**found, **chosen}


# --- observation -------------------------------------------------------------

def plugins():
    return updates.installed_plugins()


def run(argv, root):
    return updates.execute(argv, root)


def bb_command(*args):
    return [os.environ.get('BB_CLI') or 'bb', *args]


def local_state(component, root, installed, commit):
    """(state, detail) of a plugin built from this repository."""
    plugin = installed.get(component['id'])
    if not plugin:
        return 'missing', 'not installed'
    ours = (updates.same_plugin_source(updates.installation_root(root), component['id'], plugin)
            or updates.prepared_plugin_source(root, component['id'], plugin)
            or updates.same_plugin_source(root, component['id'], plugin))
    if not ours:
        return 'kept-source', f'{plugin.get("version")} from {plugin.get("source")} (another source; kept)'
    if commit is None and updates.prepared_plugin_source(root, component['id'], plugin):
        # Checked from a working tree: a build from a prepared release is ours.
        wanted = json.loads((root / 'plugins' / component['id'] / 'package.json').read_text())['version']
        if updates.version_tuple(plugin.get('version')) >= updates.version_tuple(wanted):
            return 'ok', f'{plugin.get("version")} from a prepared release'
        return 'outdated', f'installed {plugin.get("version")}, set has {wanted}'
    ok, detail = updates.plugin_state({'plugin': component['id']}, root, installed, commit)
    if ok:
        return ('kept-newer' if 'newer than release' in detail else 'ok'), detail
    return 'outdated', detail


def managed_state(component, installed):
    plugin = installed.get(component['id'])
    if not plugin:
        return 'missing', 'not installed'
    version = plugin.get('version') or ''
    if not plugin.get('source', '').startswith(component['source']):
        if component.get('adopt'):
            return 'adopt', f'{version} from another source; switching to {component["source"].rstrip("@")}'
        if updates.version_tuple(version) < updates.version_tuple(component['min']):
            return 'failed', f'{version} from another source is older than {component["min"]}; update it there'
        return 'kept-source', f'{version} from {plugin.get("source")} (another source; kept)'
    if updates.version_tuple(version) < updates.version_tuple(component['min']):
        return 'outdated', f'installed {version}; the set requires {component["min"]}+'
    return 'ok', version


# Installed and loaded, waiting for the user's own sign-in or settings: delivered,
# reported under attention, never filled in by the installer.
WAITING = 'needs-configuration'


def running(plugin):
    if not plugin:
        return 'not installed'
    if plugin.get('enabled') and plugin.get('status') not in ('running', WAITING):
        return f'status {plugin.get("status")}: {plugin.get("statusDetail") or ""}'.strip()
    return None


def assess(root, commit=None, installed=None, chosen=None):
    data = load(root)
    installed = plugins() if installed is None else installed
    chosen = excluded(root, data['components'], installed) if chosen is None else chosen
    rows = []
    for component in data['components']:
        row = {'id': component['id'], 'name': component['name'], 'kind': component['kind']}
        if component['id'] in chosen:
            present = installed.get(component['id'])
            row.update(state='excluded', detail=f'excluded by the user: {chosen[component["id"]]}'.rstrip(': '),
                       version=present and present.get('version'))
            rows.append(row)
            continue
        state, detail = (local_state(component, root, installed, commit) if component['kind'] == 'local'
                         else managed_state(component, installed))
        plugin = installed.get(component['id'])
        if state in DONE and (problem := running(plugin)):
            state, detail = 'failed', problem
        row.update(state=state, detail=detail, version=plugin and plugin.get('version'),
                   enabled=plugin and plugin.get('enabled'))
        if plugin and plugin.get('enabled') and plugin.get('status') == WAITING:
            row['waiting'] = plugin.get('statusDetail') or "the plugin waits for its settings"
        rows.append(row)
    return data, rows


def configure_rows(component, root, installed, fix):
    """Configuration hooks of an installed, enabled component."""
    plugin = installed.get(component['id'])
    results = []
    if not plugin or not plugin.get('enabled'):
        return results
    for hook in component.get('configure', []):
        code, output = run(hook['check'], root)
        how = 'ok'
        if code != 0 and fix:
            code, output = run(hook['apply'], root)
            if code == 0:
                code, output = run(hook['check'], root)
            how = 'configured'
        results.append({'hook': hook['name'], 'ok': code == 0, 'how': how if code == 0 else 'failed', 'detail': output[-300:]})
    return results


def attention(data, rows, fresh=()):
    by_id = {c['id']: c for c in data['components']}
    items = []
    for row in rows:
        if row['state'] == 'excluded':
            continue
        if row.get('waiting'):
            items.append({'component': row['id'], 'type': 'needs-configuration', 'text': row['waiting'],
                          'new': row['id'] in fresh})
        for note in by_id[row['id']].get('attention', []):
            items.append({'component': row['id'], 'type': note['type'], 'text': note['text'], 'new': row['id'] in fresh})
        for dependency in by_id[row['id']].get('requires', []):
            if next(r for r in rows if r['id'] == dependency)['state'] == 'excluded':
                items.append({'component': row['id'], 'type': 'dependency', 'new': False,
                              'text': f'{row["id"]} needs {dependency}, which the user excluded.'})
    for action in data.get('machineActions', []):
        items.append({'component': 'bb-config', 'type': 'machine', 'text': action['text'], 'new': bool(fresh)})
    return items


def summary(data, rows, hooks, fresh=()):
    left = [row['id'] for row in rows if row['state'] not in DONE]
    left += [f'{name}: {hook["hook"]}' for name, results in hooks.items() for hook in results if not hook['ok']]
    return {'converged': not left, 'left': left, 'components': rows, 'configuration': hooks,
            'attention': attention(data, rows, fresh)}


def check(root, commit=None, installed=None):
    data, rows = assess(root, commit, installed)
    installed = plugins() if installed is None else installed
    by_id = {c['id']: c for c in data['components']}
    hooks = {row['id']: results for row in rows if row['state'] in DONE and row['state'] != 'excluded'
             if (results := configure_rows(by_id[row['id']], root, installed, False))}
    result = summary(data, rows, hooks)
    if wants_project(data, rows) and not has_project(root):
        result['converged'] = False
        result['left'].append('config-updates: BB project for this checkout')
    return result


# --- convergence -------------------------------------------------------------

def install_local(component, root, installed):
    directory = root / 'plugins' / component['id']
    present = installed.get(component['id'])
    reload = present and updates.same_plugin_source(root, component['id'], present)
    for command in (['npm', '--prefix', str(directory), 'ci', '--include=dev', '--no-audit', '--no-fund'],
                    bb_command('plugin', 'build', str(directory)),
                    bb_command('plugin', 'reload', component['id']) if reload
                    else bb_command('plugin', 'install', f'path:{directory}', '--yes')):
        code, output = run(command, root)
        if code != 0:
            return f'{" ".join(Path(command[0]).name.split() + command[1:3])}: {output}'
    return None


def converge_one(component, row, root, installed):
    """Bring one component to the declared state. Returns an error text or None."""
    state = row['state']
    if state == 'missing' or state == 'outdated' and component['kind'] == 'local':
        if component['kind'] == 'local':
            return install_local(component, root, installed)
        code, output = run(bb_command('plugin', 'install', component['install'], '--yes'), root)
        return None if code == 0 else f'bb plugin install {component["install"]}: {output}'
    if state == 'adopt':
        code, output = run(component['adopt']['apply'], root)
        if code != 0:
            return f'switching source: {output}'
        return None
    if state == 'outdated':
        code, output = run(bb_command('plugin', 'update', component['id']), root)
        if code == 0 and managed_state(component, plugins())[0] == 'ok':
            return None
        # The saved range or ref cannot reach the required version (an exact
        # tag, an old range): BB changes the saved range in place, keeping the
        # plugin's settings, secrets and schedules.
        declared = component['install'].rpartition('@')[2] if component['kind'] == 'git' else f'>={component["min"]}'
        code, output = run(bb_command('plugin', 'update', component['id'], '--range', declared, '--yes'), root)
        if code != 0:
            return f'bb plugin update {component["id"]} --range {declared}: {output}'
        return None if managed_state(component, plugins())[0] == 'ok' else \
            f'{component["id"]} is still older than {component["min"]} after the update'
    if state == 'failed' and installed.get(component['id']) and component['kind'] == 'local':
        return install_local(component, root, installed)
    return None


def has_project(root):
    target = updates.installation_root(root).resolve()
    listing = json.loads(subprocess.run(compat.argv(bb_command('project', 'list', '--json')),
                                        capture_output=True, text=True, check=True).stdout)
    projects = listing if isinstance(listing, list) else listing.get('projects', [])
    return any(Path(source.get('path') or '').is_absolute() and Path(source['path']).resolve() == target
               for project in projects for source in project.get('sources', []))


def wants_project(data, rows):
    return any(r['id'] == 'config-updates' and r['state'] != 'excluded' for r in rows)


def ensure_project(root):
    """Config Updates opens its update thread in the BB project of this checkout."""
    target = updates.installation_root(root).resolve()
    if has_project(root):
        return None
    status = json.loads(subprocess.run(compat.argv(bb_command('status', '--json')),
                                       capture_output=True, text=True, check=True).stdout)
    host = (Path(status['dataDir']) / 'host-id').read_text(encoding='utf-8').strip()
    code, output = run(bb_command('project', 'create', '--name', 'bb-config', '--root', str(target),
                                  '--machine', host, '--json'), root)
    return 'created' if code == 0 else f'failed: {output}'


def apply(root, commit=None):
    data, rows = assess(root, commit)
    by_id = {c['id']: c for c in data['components']}
    before = plugins()
    fresh, errors_seen = [], {}
    for row in rows:
        component = by_id[row['id']]
        if row['state'] in {'ok', 'kept-source', 'kept-newer', 'excluded'}:
            continue
        installed = plugins()
        error = converge_one(component, row, root, installed)
        if error:
            errors_seen[row['id']] = error
            continue
        if row['state'] == 'adopt':
            # The source switch may leave an older release; one more pass updates it.
            current = plugins()
            state, _ = managed_state(component, current)
            if state == 'outdated':
                error = converge_one(component, {'state': 'outdated'}, root, current)
                if error:
                    errors_seen[row['id']] = error
                    continue
        if row['state'] == 'missing':
            fresh.append(row['id'])
        was = before.get(row['id'])
        now = plugins().get(row['id'])
        # A plugin the user disabled is updated but stays disabled.
        if was and not was.get('enabled') and now and now.get('enabled'):
            run(bb_command('plugin', 'disable', row['id']), root)
    project = None
    if wants_project(data, rows):
        try:
            project = ensure_project(root)
        except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
            project = f'failed: {error}'
    installed = plugins()
    _, after = assess(root, commit, installed)
    actions = {'missing': 'installed', 'outdated': 'updated', 'adopt': 'updated', 'failed': 'reinstalled'}
    for old, new in zip(rows, after):
        if new['id'] in errors_seen:
            new['state'], new['detail'] = 'failed', errors_seen[new['id']][-500:]
        elif new['state'] in {'ok', 'kept-newer'} and old['state'] in actions:
            new['state'] = actions[old['state']]
    hooks = {row['id']: results for row in after if row['state'] in DONE and row['state'] != 'excluded'
             if (results := configure_rows(by_id[row['id']], root, installed, True))}
    result = summary(data, after, hooks, fresh)
    if project:
        result['project'] = project
        if project.startswith('failed'):
            result['converged'] = False
            result['left'].append('config-updates: BB project for this checkout')
    return result


# --- CLI ---------------------------------------------------------------------

def head_commit(root):
    """The pinned commit when running from a prepared release, else None (working tree)."""
    return root.name if updates.release_location(root) else None


def main(argv=None, root=ROOT):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('check')
    sub.add_parser('apply')
    command = sub.add_parser('exclude')
    command.add_argument('component')
    command.add_argument('--reason', default='')
    sub.add_parser('include').add_argument('component')
    args = parser.parse_args(argv)
    try:
        if args.command in {'exclude', 'include'}:
            ids = {c['id'] for c in load(root)['components']}
            if args.component not in ids:
                raise updates.UpdateError(f'{args.component} is not in the declared set: {", ".join(sorted(ids))}')
            selection = read_selection(root)
            if args.command == 'exclude':
                selection['excluded'][args.component] = {'reason': args.reason, 'at': updates.now()}
            else:
                selection['excluded'].pop(args.component, None)
            write_selection(root, selection)
            print(json.dumps({'excluded': sorted(selection['excluded'])}, ensure_ascii=False, indent=1))
            return 0
        result = (apply if args.command == 'apply' else check)(root, head_commit(root))
        print(json.dumps(result, ensure_ascii=False, indent=1))
        return 0 if result['converged'] else (1 if args.command == 'apply' else 2)
    except (updates.UpdateError, OSError, ValueError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    compat.utf8_main()
    sys.exit(main())
