#!/usr/bin/env python3
"""Apply published bb-config releases step by step, with a local journal.

A release is a stable GitHub Release vX.Y.Z. Its steps are described by
docs/releases/vX.Y.Z.json (and .md for prose) inside the tagged commit.
Manifests are always read from the pinned commit, never from a branch head.
The journal (.local/updates/) is private to this installation: it records
which step was verified on which machine. A tag or a fresh checkout proves
nothing; only a passed verification marks a step as done.

Run on the BB server, in its bb-config checkout. Output is JSON.
Exit codes: 0 ok, 1 error, 2 steps remain, 3 a decision or evidence is needed.
Procedure: docs/updates.md.
"""
import argparse
import contextlib
import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

import platform_compat as compat

ROOT = Path(__file__).resolve().parents[1]
VERSION = re.compile(r'^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$')
STEP_ID = re.compile(r'^[a-z0-9][a-z0-9-]*$')
PLUGIN_VERSION = re.compile(r'^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$')
KINDS = {'local-plugin', 'command', 'manual', 'bundle'}
# The bundle step converges the installation to config/bundle.json; it runs
# first, before every other pending step up to the target release.
BUNDLE = 'bundle'
WHERE = {'server', 'executors'}
DONE = {'verified', 'not-applicable'}
SERVER = 'server'
# Steps written during development wait in docs/releases/next/<id>.json (+ .md),
# one pair per step, until `release` assembles them into a version.
NEXT = 'next'
LOCAL_STATE = ('config', 'plugin-patches')


class UpdateError(Exception):
    def __init__(self, message, code=1):
        super().__init__(message)
        self.code = code


def version_key(tag):
    match = VERSION.match(tag or '')
    if not match:
        raise UpdateError(f'Not a stable release tag (vX.Y.Z): {tag!r}')
    return tuple(int(part) for part in match.groups())


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def git(root, *args, check=True):
    result = subprocess.run(['git', '-C', str(root), *args], capture_output=True, text=True)
    if check and result.returncode != 0:
        raise UpdateError(f'git {" ".join(args)}: {result.stderr.strip() or result.returncode}')
    return result.stdout.strip() if check else result


def bb(*args):
    command = compat.argv([os.environ.get('BB_CLI') or 'bb', *args])
    try:
        return subprocess.run(command, capture_output=True, text=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError) as error:
        detail = getattr(error, 'stderr', '') or str(error)
        raise UpdateError(f'bb {" ".join(args)} failed: {detail.strip()[-300:]}')


def installed_plugins():
    # The plugin has the list already and may run without `bb` on PATH.
    supplied = os.environ.get('BB_CONFIG_PLUGINS_JSON')
    listing = json.loads(supplied if supplied else bb('plugin', 'list', '--json'))
    plugins = listing if isinstance(listing, list) else listing.get('plugins', [])
    return {plugin['id']: plugin for plugin in plugins}


# --- manifests ---------------------------------------------------------------

def manifest_errors(manifest, tag):
    """Structural problems of one release manifest; an empty list means valid."""
    errors = []
    if not isinstance(manifest, dict) or manifest.get('schemaVersion') != 1:
        return ['schemaVersion must be 1']
    if manifest.get('version') != tag:
        errors.append(f'version must equal the file name ({tag})')
    if not str(manifest.get('title') or '').strip():
        errors.append('title is required')
    steps = manifest.get('steps')
    if not isinstance(steps, list):
        return errors + ['steps must be a list']
    seen = set()
    for step in steps:
        name = step.get('id') if isinstance(step, dict) else None
        if not isinstance(name, str) or not STEP_ID.match(name):
            errors.append(f'step id must match {STEP_ID.pattern}: {name!r}')
            continue
        if name in seen:
            errors.append(f'duplicate step id: {name}')
        seen.add(name)
        for field in ('title', 'component', 'rerun', 'rollback'):
            if not str(step.get(field) or '').strip():
                errors.append(f'{name}: {field} is required')
        if step.get('where') not in WHERE:
            errors.append(f'{name}: where must be one of {sorted(WHERE)}')
        kind = step.get('kind')
        if kind not in KINDS:
            errors.append(f'{name}: kind must be one of {sorted(KINDS)}')
        if kind == 'local-plugin':
            plugin = step.get('plugin')
            if not isinstance(plugin, str) or not STEP_ID.match(plugin):
                errors.append(f'{name}: local-plugin needs "plugin" (directory under plugins/)')
            if step.get('where') != 'server':
                errors.append(f'{name}: plugins are installed on the BB server (where: server)')
        for field in ('apply', 'verify', 'applies'):
            argv = step.get(field)
            if argv is not None and not (isinstance(argv, list) and argv and all(isinstance(a, str) for a in argv)):
                errors.append(f'{name}: {field} must be a non-empty argv list')
        if kind == BUNDLE and (step.get('where') != SERVER or any(step.get(f) for f in ('apply', 'verify', 'plugin'))):
            errors.append(f'{name}: bundle steps run on the server and take no apply, verify or plugin')
        if kind == 'command' and not (step.get('apply') and step.get('verify')):
            errors.append(f'{name}: command steps need both apply and verify')
        if kind == 'manual' and step.get('apply'):
            errors.append(f'{name}: manual steps have no apply; describe them in the .md')
        after = step.get('after', [])
        if not isinstance(after, list) or not all(isinstance(dependency, str) for dependency in after):
            errors.append(f'{name}: after entries are step ids')
        requirements = step.get('requiresPlugins', [])
        if not isinstance(requirements, list):
            errors.append(f'{name}: requiresPlugins must be a list')
        elif requirements:
            if step.get('where') != SERVER or kind not in {'local-plugin', 'command'}:
                errors.append(f'{name}: requiresPlugins is supported for automatic server steps')
            ids = set()
            for requirement in requirements:
                if not valid_requirement(requirement):
                    errors.append(f'{name}: requiresPlugins needs id and version, min, or before (X.Y.Z)')
                    continue
                if requirement['id'] in ids or requirement['id'] == step.get('plugin'):
                    errors.append(f'{name}: invalid repeated or self dependency {requirement["id"]}')
                ids.add(requirement['id'])
    return errors


def valid_requirement(requirement):
    if not isinstance(requirement, dict) or not STEP_ID.fullmatch(str(requirement.get('id', ''))):
        return False
    bounds = set(requirement) - {'id'}
    if bounds not in ({'version'}, {'min'}, {'before'}, {'min', 'before'}):
        return False
    if not all(isinstance(requirement[field], str) and PLUGIN_VERSION.fullmatch(requirement[field]) for field in bounds):
        return False
    return 'min' not in bounds or 'before' not in bounds or version_tuple(requirement['min']) < version_tuple(requirement['before'])


def load_manifests(root, commit=None):
    """{tag: manifest} from the pinned commit, or the working tree when commit is None."""
    manifests = {}
    if commit:
        names = git(root, 'ls-tree', '--name-only', commit, 'docs/releases/').splitlines()
        read = lambda name: git(root, 'show', f'{commit}:{name}')
    else:
        names = [f'docs/releases/{p.name}' for p in sorted((root / 'docs/releases').glob('*.json'))]
        read = lambda name: (root / name).read_text()
    for name in names:
        tag = Path(name).stem
        if not name.endswith('.json') or not VERSION.match(tag):
            continue
        try:
            manifest = json.loads(read(name))
        except ValueError as error:
            raise UpdateError(f'{name}: invalid JSON ({error})')
        errors = manifest_errors(manifest, tag)
        if errors:
            raise UpdateError(f'{name}: ' + '; '.join(errors))
        manifests[tag] = manifest
    ordered = dict(sorted(manifests.items(), key=lambda item: version_key(item[0])))
    known = set()
    for tag, manifest in ordered.items():
        remaining = list(manifest['steps'])
        unresolved_ids = {f'{tag}/{step["id"]}' for step in remaining}
        for step in remaining:
            for dependency in step.get('after', []):
                if full_id(tag, dependency) not in known | unresolved_ids:
                    raise UpdateError(f'{tag}/{step["id"]}: dependency {dependency} must be in this or an earlier release')
        ordered_steps = []
        while remaining:
            index = next((i for i, step in enumerate(remaining)
                          if all(full_id(tag, dependency) in known for dependency in step.get('after', []))), None)
            if index is None:
                raise UpdateError(f'{tag}: cyclic step dependencies ({", ".join(step["id"] for step in remaining)})')
            step = remaining.pop(index)
            ordered_steps.append(step)
            known.add(f'{tag}/{step["id"]}')
        manifest['steps'] = ordered_steps
    return ordered


def next_steps(root):
    """{id: step} of unreleased steps in the working tree."""
    steps = {}
    for path in sorted((root / 'docs/releases' / NEXT).glob('*.json')):
        try:
            step = json.loads(path.read_text())
        except ValueError as error:
            raise UpdateError(f'{path.name}: invalid JSON ({error})')
        errors = manifest_errors({'schemaVersion': 1, 'version': NEXT, 'title': NEXT, 'steps': [step]}, NEXT)
        if isinstance(step, dict) and step.get('id') != path.stem:
            errors.append('step id must equal the file name')
        if errors:
            raise UpdateError(f'docs/releases/{NEXT}/{path.name}: ' + '; '.join(errors))
        steps[step['id']] = step
    return steps


def version_tuple(version):
    return tuple(int(part) for part in re.findall(r'\d+', version or '')[:3])


def full_id(tag, step_id):
    return step_id if '/' in step_id else f'{tag}/{step_id}'


def validate(root, only=None):
    """Publishing check of the working tree: structure, prose, version bumps."""
    manifests = load_manifests(root)
    if only and only not in manifests:
        raise UpdateError(f'docs/releases/{only}.json is missing')
    problems = []
    required_components = set()
    tags = sorted(manifests, key=version_key)
    for index, tag in enumerate(tags):
        for step in manifests[tag]['steps']:
            component = step['component']
            if 'requiresPlugins' in step:
                if step['requiresPlugins']:
                    required_components.add(component)
                else:
                    required_components.discard(component)
            elif (component in required_components and step['where'] == SERVER
                    and step['kind'] in {'command', 'local-plugin'} and (not only or tag == only)):
                problems.append(f'{tag}/{step["id"]}: declare requiresPlugins for {component}; use [] if removed')
        if only and tag != only:
            continue
        prose = root / f'docs/releases/{tag}.md'
        text = prose.read_text() if prose.is_file() else ''
        if not text:
            problems.append(f'{tag}: docs/releases/{tag}.md is missing')
        previous = tags[index - 1] if index else None
        for step in manifests[tag]['steps']:
            if text and f'`{step["id"]}`' not in text:
                problems.append(f'{tag}: the .md does not describe step `{step["id"]}`')
            if step['kind'] != 'local-plugin':
                continue
            directory = f'plugins/{step["plugin"]}'
            package = root / directory / 'package.json'
            if not package.is_file() or not (root / directory / 'package-lock.json').is_file():
                problems.append(f'{tag}/{step["id"]}: {directory} needs package.json and package-lock.json')
                continue
            # Verification compares versions, so a changed plugin must bump its version.
            # A step for a plugin the release does not change delivers nothing:
            # usually its sources were left uncommitted.
            if previous and tag == tags[-1] and \
                    git(root, 'rev-parse', '-q', '--verify', f'{previous}^{{commit}}', check=False).returncode == 0 and \
                    git(root, 'diff', '--quiet', previous, 'HEAD', '--', directory, check=False).returncode == 0:
                problems.append(f'{tag}/{step["id"]}: {directory} is unchanged in HEAD since {previous}; '
                                'commit its changes or drop the step')
            if previous and git(root, 'rev-parse', '-q', '--verify', f'{previous}^{{commit}}', check=False).returncode == 0:
                old = git(root, 'show', f'{previous}:{directory}/package.json', check=False)
                changed = git(root, 'diff', '--quiet', previous, '--', directory, check=False).returncode != 0
                if old.returncode == 0 and changed and \
                        json.loads(old.stdout)['version'] == json.loads(package.read_text())['version']:
                    problems.append(f'{tag}/{step["id"]}: {directory} changed since {previous}; bump its version')
    return problems


# --- journal -----------------------------------------------------------------

def release_location(root):
    """A prepared release inherits the installation and journal that created it."""
    marker = root / '.git/bb-config-installation.json'
    if root.parent.name == 'releases' and re.fullmatch(r'[0-9a-f]{40}', root.name) and marker.is_file():
        return json.loads(marker.read_text(encoding='utf-8'))
    return None


def installation_root(root):
    location = release_location(root)
    return Path(location['root']) if location else root


def state_dir(root):
    return Path(os.environ.get('BB_CONFIG_UPDATES_DIR') or
                (root.parent.parent if release_location(root) else root / '.local/updates')).resolve()


def release_tree(root, commit):
    directory = state_dir(root) / 'releases' / commit
    location = release_location(directory)
    if not location or git(directory, 'rev-parse', 'HEAD') != commit:
        raise UpdateError('The pinned release is not prepared. Run `fetch` first.')
    if git(directory, 'status', '--porcelain'):
        raise UpdateError('The prepared release contains local changes. Use a clean release checkout.')
    if any((directory / '.local' / name).resolve() != (Path(location['root']) / '.local' / name).resolve()
           for name in LOCAL_STATE):
        raise UpdateError('The prepared release no longer points to the installation state.')
    return directory


def connect_local_state(checkout, root):
    """Historical release helpers keep reading and writing the installation's state."""
    local = checkout / '.local'
    local.mkdir()
    for name in LOCAL_STATE:
        target = (root / '.local' / name).resolve()
        target.mkdir(parents=True, exist_ok=True)
        compat.link_directory(local / name, target)


@contextlib.contextmanager
def journal(root, write=False):
    """The journal under a short file lock; saved atomically when write is set."""
    directory = state_dir(root)
    directory.mkdir(parents=True, exist_ok=True)
    with open(directory / 'journal.flock', 'w') as guard:
        compat.lock(guard)
        path = directory / 'journal.json'
        data = json.loads(path.read_text()) if path.is_file() else {}
        data.setdefault('schemaVersion', 1)
        data.setdefault('installed', None)
        data.setdefault('partial', None)
        data.setdefault('run', None)
        data.setdefault('lastRun', None)
        data.setdefault('entries', [])
        yield data
        if write:
            temporary = directory / 'journal.json.tmp'
            temporary.write_text(json.dumps(data, ensure_ascii=False, indent=1) + '\n')
            os.chmod(temporary, 0o600)
            os.replace(temporary, path)


def latest(data, step, machine, mode='release', commit=None):
    for entry in reversed(data['entries']):
        if (entry['step'] == step and entry['machine'] == machine and entry['mode'] == mode
                and (commit is None or entry.get('commit') == commit)):
            return entry
    return None


def add_entry(data, step, machine, status, how, detail, mode, commit, checks=None):
    entry = {'step': step, 'machine': machine, 'status': status, 'how': how,
             'detail': (detail or '')[-600:], 'mode': mode, 'commit': commit, 'at': now()}
    if checks:
        entry.update(checks)
    data['entries'].append(entry)
    return entry


def installed_version(data):
    return (data.get('installed') or {}).get('release')


def targets(step, machines):
    return [SERVER] if step['where'] == 'server' else list(machines)


def lead_step(manifests, data, target):
    """Full id of the bundle step that runs before everything else up to target, or None."""
    base = version_key(installed_version(data)) if installed_version(data) else (-1, -1, -1)
    for tag in sorted(manifests, key=version_key, reverse=True):
        if base < version_key(tag) <= version_key(target):
            for step in manifests[tag]['steps']:
                if step['kind'] == BUNDLE:
                    return f'{tag}/{step["id"]}'
    return None


def pending(manifests, data, target, machines, commit):
    """Steps of releases in (installed, target] that are not done, oldest first.

    The newest bundle step in range comes first: it installs and updates the
    whole set, then older steps are verified against that state.
    """
    base = version_key(installed_version(data)) if installed_version(data) else (-1, -1, -1)
    lead = lead_step(manifests, data, target)
    if lead:
        entry = latest(data, lead, SERVER, commit=commit)
        if not entry or entry['status'] not in DONE:
            rows = [{'step': lead, 'machine': SERVER, 'status': entry['status'] if entry else 'pending',
                     'detail': entry['detail'] if entry else ''}]
            return rows + [row for row in pending_plain(manifests, data, target, machines, commit, base) if row['step'] != lead]
    return pending_plain(manifests, data, target, machines, commit, base)


def pending_plain(manifests, data, target, machines, commit, base):
    rows = []
    for tag, manifest in manifests.items():
        if not base < version_key(tag) <= version_key(target):
            continue
        for step in manifest['steps']:
            for machine in targets(step, machines):
                entry = latest(data, f'{tag}/{step["id"]}', machine, commit=commit)
                if not entry or entry['status'] not in DONE:
                    rows.append({'step': f'{tag}/{step["id"]}', 'machine': machine,
                                 'status': entry['status'] if entry else 'pending',
                                 'detail': entry['detail'] if entry else ''})
    return rows


def find_step(manifests, step_id):
    tag, _, name = step_id.partition('/')
    for step in manifests.get(tag, {}).get('steps', []):
        if step['id'] == name:
            return tag, step
    raise UpdateError(f'Unknown step {step_id}; use the full id vX.Y.Z/<step>')


def require_run(data, owner, development):
    """Release-mode changes need the run lock taken by `begin` for this owner."""
    if development:
        return None
    run = data.get('run')
    if not run:
        raise UpdateError('No update run is open. Start with: updates.py begin <tag> --commit <sha>')
    if run['owner'] != owner:
        raise UpdateError(f'Another update run is open (owner {run["owner"]}, since {run["startedAt"]}). '
                          'Do not work in parallel; see docs/updates.md about stale runs.', 3)
    return run


# --- steps -------------------------------------------------------------------

def expand(argv, root):
    return [part.replace('{python}', sys.executable).replace('{root}', str(root)) for part in argv]


def execute(argv, root):
    result = subprocess.run(compat.argv(expand(argv, root)), cwd=root, capture_output=True, text=True)
    return result.returncode, (result.stdout + result.stderr).strip()[-600:]


def requirement_issue(requirement, plugin):
    plugin_id = requirement['id']
    if not plugin:
        return f'{plugin_id}: required plugin is missing'
    if not plugin.get('enabled') or plugin.get('status') != 'running':
        return f'{plugin_id}: required plugin is {plugin.get("status") or "disabled"}'
    actual = plugin.get('version') or ''
    version = version_tuple(actual)
    if (not PLUGIN_VERSION.fullmatch(actual)
            or 'version' in requirement and actual != requirement['version']
            or 'min' in requirement and version < version_tuple(requirement['min'])
            or 'before' in requirement and version >= version_tuple(requirement['before'])):
        wanted = ', '.join(f'{operator}{requirement[key]}' for key, operator in
                           (('version', '='), ('min', '>='), ('before', '<')) if key in requirement)
        return f'{plugin_id}: installed {actual or "unknown"}; requires {wanted}'
    return None


def require_dependencies(step, plugins=None):
    requirements = step.get('requiresPlugins', [])
    if requirements:
        if plugins is None:
            plugins = installed_plugins()
        issues = [issue for requirement in requirements
                  if (issue := requirement_issue(requirement, plugins.get(requirement['id']))) is not None]
        if issues:
            raise UpdateError('Plugin dependencies: ' + '; '.join(issues))


def observed_checks(step, plugins=None):
    requirements = step.get('requiresPlugins', [])
    ids = [requirement['id'] for requirement in requirements]
    if step.get('plugin'):
        ids.insert(0, step['plugin'])
    if not ids and 'requiresPlugins' not in step:
        return None
    if plugins is None:
        plugins = installed_plugins() if ids else {}
    require_dependencies(step, plugins)
    observed = {}
    for plugin_id in ids:
        plugin = plugins.get(plugin_id, {})
        source = re.sub(r'(://)[^/@\s]+@', r'\1', plugin.get('source') or '').split('?', 1)[0]
        observed[plugin_id] = {'version': plugin.get('version'), 'source': source,
                               'enabled': plugin.get('enabled'), 'status': plugin.get('status')}
    checks = {'pluginChecks': observed, 'component': step['component'], 'plugin': step.get('plugin')}
    if 'requiresPlugins' in step:
        checks['requiresPlugins'] = requirements
    return checks


def dependency_issues(data):
    installed = installed_version(data)
    if not installed:
        return []
    current = {}
    for entry in data['entries']:
        if entry['mode'] != 'release' or entry['status'] != 'verified' or 'requiresPlugins' not in entry:
            continue
        tag = version_key(entry['step'].split('/', 1)[0])
        component = entry['component']
        if tag <= version_key(installed) and (component not in current or tag >= current[component][0]):
            current[component] = (tag, entry)
    if not any(entry['requiresPlugins'] for _, entry in current.values()):
        return []
    plugins = installed_plugins()
    return [f'{component}: {issue}' for component, (_, entry) in current.items()
            if not entry.get('plugin') or plugins.get(entry['plugin'], {}).get('enabled')
            for requirement in entry['requiresPlugins']
            if (issue := requirement_issue(requirement, plugins.get(requirement['id']))) is not None]


def same_plugin_source(root, plugin_id, plugin):
    path = Path(plugin.get('rootDir') or '').resolve()
    return path == (root / 'plugins' / plugin_id).resolve()


def prepared_plugin_source(root, plugin_id, plugin):
    path = Path(plugin.get('rootDir') or '').resolve()
    if path.name != plugin_id or path.parent.name != 'plugins':
        return None
    directory = path.parent.parent
    if directory.parent != state_dir(root) / 'releases' or not release_location(directory):
        return None
    return directory


def plugin_state(step, root, plugins, commit=None):
    """(ok, detail) — the running plugin is this checkout's build of the release version.

    The wanted version comes from the pinned commit, not from the working tree:
    uncommitted local work must not pass as release content.
    """
    directory = root / 'plugins' / step['plugin']
    package = git(root, 'show', f'{commit}:plugins/{step["plugin"]}/package.json') if commit \
        else (directory / 'package.json').read_text()
    wanted = json.loads(package)['version']
    plugin = plugins.get(step['plugin'])
    if not plugin:
        return False, 'not installed'
    newer = commit and version_tuple(plugin.get('version')) > version_tuple(wanted)
    prepared = prepared_plugin_source(root, step['plugin'], plugin) if commit else None
    legacy = same_plugin_source(installation_root(root), step['plugin'], plugin)
    if commit and prepared and not newer:
        relative = f'plugins/{step["plugin"]}'
        wanted_tree = git(root, 'rev-parse', f'{commit}:{relative}')
        state = git(prepared, 'rev-parse', f'{prepared.name}:{relative}', check=False)
        if (state.returncode or state.stdout.strip() != wanted_tree
                or git(prepared, 'status', '--porcelain', '--', relative)
                or git(prepared, 'rev-parse', 'HEAD') != prepared.name):
            return False, 'installed plugin source differs from the pinned release'
    elif not (legacy and (not commit or newer) or prepared and newer):
        return False, 'the pinned release build is not installed'
    if plugin.get('version') != wanted and not newer:
        return False, f'installed {plugin.get("version")}, release has {wanted}'
    if plugin.get('enabled') and plugin.get('status') not in ('running', 'needs-configuration'):
        return False, f'status {plugin.get("status")}: {plugin.get("statusDetail")}'
    which = f'{plugin.get("version")} (newer than release {wanted}; a later build is installed)' if newer else wanted
    source = f'release {prepared.name}' if prepared else 'the existing installation'
    waiting = (" (waits for the user's settings: " + (plugin.get('statusDetail') or '')[:160] + ')'
               if plugin.get('enabled') and plugin.get('status') == 'needs-configuration' else '')
    return True, f'{step["plugin"]} {which} from {source}' + ('' if plugin.get('enabled') else ' (disabled by the user, kept)') + waiting


def bundle_module():
    import bundle
    return bundle


def bundle_record(report):
    """Compact, factual journal form of a bundle report."""
    groups = {}
    for row in report['components']:
        groups.setdefault(row['state'], []).append(row['id'])
    order = ('installed', 'updated', 'reinstalled', 'failed', 'missing', 'outdated', 'adopt', 'excluded', 'kept-source', 'kept-newer')
    parts = [('converged' if report['converged'] else 'not converged')]
    parts += [f'{state}: {", ".join(groups[state])}' for state in order if groups.get(state)]
    configured = [f'{name} ({hook["hook"]})' for name, hooks in report['configuration'].items()
                  for hook in hooks if hook['how'] == 'configured']
    if configured:
        parts.append('configured: ' + ', '.join(configured))
    if report['attention']:
        parts.append(f'attention: {len(report["attention"])} (personal sign-in, settings, other machines)')
    detail = '; '.join(parts)
    checks = {'bundle': {'components': {row['id']: {'state': row['state'], 'version': row.get('version')}
                                        for row in report['components']},
                         'left': report['left'], 'attention': report['attention'],
                         'problems': {row['id']: str(row.get('detail'))[-300:] for row in report['components']
                                      if row['state'] not in ('ok', 'installed', 'updated', 'reinstalled', 'excluded',
                                                              'kept-source', 'kept-newer')}}}
    return detail, checks


def excluded_plugin(root, plugin_id):
    try:
        bundle = bundle_module()
        return plugin_id in bundle.read_selection(root)['excluded']
    except (OSError, ValueError):
        return False


def settled(root, step, commit=None):
    """(status, how, detail) when the step needs no action here, else None. Changes nothing."""
    if step['kind'] == BUNDLE:
        report = bundle_module().check(root, commit)
        return ('verified', 'existing', *bundle_record(report)) if report['converged'] else None
    if step['kind'] == 'local-plugin':
        plugins = installed_plugins()
        if step['plugin'] not in plugins and excluded_plugin(root, step['plugin']):
            return 'not-applicable', 'excluded', 'the user excluded this component (bundle.py exclude)'
        if step['plugin'] not in plugins and not step.get('introduces'):
            return 'not-applicable', 'not-selected', 'plugin is not installed here; the user did not choose it'
        if step['plugin'] in plugins:
            require_dependencies(step, plugins)
        ok, detail = plugin_state(step, root, plugins, commit)
        if ok:
            return 'verified', 'existing', detail
        return None
    if step.get('applies'):
        code, output = execute(step['applies'], root)
        if code != 0:
            return 'not-applicable', 'applies-check', output
    require_dependencies(step)
    if not step.get('verify'):
        return None
    code, output = execute(step['verify'], root)
    return ('verified', 'existing', output) if code == 0 else None


def run_step(root, step, install=False, commit=None):
    """Verify first; apply only when needed; verify again. Returns (status, how, detail)."""
    done = settled(root, step, commit)
    if done:
        return done
    if step['kind'] == BUNDLE:
        report = bundle_module().apply(root, commit)
        detail, checks = bundle_record(report)
        return ('verified' if report['converged'] else 'failed', 'applied' if report['converged'] else 'apply', detail, checks)
    if step['kind'] == 'local-plugin':
        plugins = installed_plugins()
        detail = plugin_state(step, root, plugins, commit)[1]
        directory = root / 'plugins' / step['plugin']
        present = step['plugin'] in plugins
        if not present and not step.get('introduces'):
            return 'not-applicable', 'not-selected', 'plugin is not installed here; the user did not choose it'
        if not present and not install:
            raise UpdateError(f'{step["plugin"]} is a new component. Ask the user; if they want it, rerun with --install. '
                              'Otherwise record not-applicable.', 3)
        if not present:
            require_dependencies(step, plugins)
        if present:
            plugin = plugins[step['plugin']]
            if not (same_plugin_source(installation_root(root), step['plugin'], plugin)
                    or prepared_plugin_source(root, step['plugin'], plugin)):
                return 'failed', 'apply', f'{detail}; the installed plugin comes from another source'
            wanted = json.loads((directory / 'package.json').read_text(encoding='utf-8'))['version']
            if commit and version_tuple(plugin.get('version')) > version_tuple(wanted):
                return 'failed', 'apply', f'{detail}; the installed newer plugin was kept'
        reload = present and same_plugin_source(root, step['plugin'], plugins[step['plugin']])
        for command in (['npm', '--prefix', str(directory), 'ci', '--include=dev'], ['bb', 'plugin', 'build', str(directory)],
                        ['bb', 'plugin', 'reload', step['plugin']] if reload
                        else ['bb', 'plugin', 'install', f'path:{directory}', '--yes']):
            if command[0] == 'bb':
                command[0] = os.environ.get('BB_CLI') or 'bb'
            code, output = execute(command, root)
            if code != 0:
                return 'failed', 'apply', f'{" ".join(command[:3])}: {output}'
        ok, detail = plugin_state(step, root, installed_plugins(), commit)
        return ('verified', 'applied', detail) if ok else ('failed', 'verify', detail)
    if not step.get('verify'):
        raise UpdateError('This step has no automatic check. Follow the release .md, then use `record` with evidence.', 3)
    if step['kind'] == 'manual':
        raise UpdateError('Check failed. Follow the release .md, then run this step again.', 3)
    code, output = execute(step['apply'], root)
    if code != 0:
        return 'failed', 'apply', output
    code, output = execute(step['verify'], root)
    return ('verified', 'applied', output) if code == 0 else ('failed', 'verify', output)


# --- commands ----------------------------------------------------------------

def command_fetch(args, root):
    """Download the pinned release to the installation's private release directory."""
    version_key(args.release)
    repository = getattr(args, 'repository', None)
    origin = f'https://github.com/{repository}.git' if repository else git(root, 'remote', 'get-url', 'origin')
    tag = f'refs/tags/{args.release}'
    releases = state_dir(root) / 'releases'
    checkout = releases / args.commit
    if checkout.exists():
        refs = {name: sha for sha, name in (line.split('\t', 1) for line in
                git(root, 'ls-remote', '--', origin, tag, f'{tag}^{{}}').splitlines())}
        actual = refs.get(f'{tag}^{{}}', refs.get(tag))
        if actual != args.commit:
            raise UpdateError(f'Tag {args.release} points at {actual}, expected {args.commit}. The tag was moved or removed.')
        release_tree(root, args.commit)
        return {'result': 'already-prepared', 'checkout': str(checkout), 'commit': args.commit}
    releases.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.fetch-', dir=releases) as work:
        staged = Path(work) / 'release'
        staged.mkdir()
        git(staged, 'init', '--quiet')
        git(staged, 'remote', 'add', 'origin', origin)
        git(staged, 'fetch', '--depth=1', '--no-tags', 'origin', f'{tag}:{tag}')
        actual = git(staged, 'rev-parse', f'{tag}^{{commit}}')
        if actual != args.commit:
            raise UpdateError(f'Tag {args.release} points at {actual}, expected {args.commit}. The tag was moved; stop.')
        git(staged, 'checkout', '--detach', '--quiet', args.commit)
        original = installation_root(root).resolve()
        connect_local_state(staged, original)
        (staged / '.git/bb-config-installation.json').write_text(
            json.dumps({'root': str(original)}), encoding='utf-8')
        try:
            staged.rename(checkout)
        except OSError:
            if not checkout.is_dir():
                raise
            release_tree(root, args.commit)
    return {'result': 'prepared', 'checkout': str(checkout), 'commit': args.commit}


def command_status(args, root):
    with journal(root) as data:
        result = {'installed': data['installed'], 'partial': data['partial'], 'run': data['run'],
                  'lastRun': data['lastRun'], 'journal': str(state_dir(root) / 'journal.json')}
    if args.dependencies:
        result['dependencyIssues'] = dependency_issues(data)
    return result


def command_baseline(args, root):
    version_key(args.release)
    with journal(root, write=True) as data:
        if data['run']:
            raise UpdateError('An update run is open; finish it first.')
        current = installed_version(data)
        if current and version_key(current) > version_key(args.release) and not args.force:
            raise UpdateError(f'Installed version {current} is newer; pass --force to lower the baseline.')
        data['installed'] = {'release': args.release, 'commit': args.commit, 'how': 'baseline',
                             'note': args.note, 'at': now()}
        data['partial'] = None
        return {'installed': data['installed']}


def command_begin(args, root):
    version_key(args.release)
    checkout = release_tree(root, args.commit)
    manifests = load_manifests(checkout, args.commit)
    if args.release not in manifests:
        raise UpdateError(f'{args.release} has no docs/releases manifest in {args.commit[:12]}.')
    machines = [m for m in (args.machines or '').split(',') if m]
    with journal(root, write=True) as data:
        run = data['run']
        if run and run['owner'] != args.owner and not args.takeover:
            raise UpdateError(f'Another update run is open (owner {run["owner"]}, since {run["startedAt"]}). '
                              'Check that thread first; --takeover only when it is certainly stopped.', 3)
        if run and (run['release'], run['commit']) != (args.release, args.commit):
            raise UpdateError(f'Finish the open run for {run["release"]} before changing the pinned release.', 3)
        # A machine that still owes steps stays in scope until it is done or
        # explicitly recorded as not-applicable; omitting it must not hide it.
        for row in (data['partial'] or {}).get('remaining', []):
            if row['machine'] != SERVER and row['machine'] not in machines:
                machines.append(row['machine'])
        resumed = bool(run and run['owner'] == args.owner and run['commit'] == args.commit)
        data['run'] = {'release': args.release, 'commit': args.commit, 'owner': args.owner,
                       'machines': machines, 'startedAt': run['startedAt'] if resumed else now()}
        remaining = pending(manifests, data, args.release, machines, args.commit)
        active = {row['step'] for row in remaining}
        return {'run': data['run'], 'resumed': resumed, 'installed': data['installed'],
                'pending': remaining,
                'steps': {f'{tag}/{s["id"]}': s for tag, m in manifests.items() for s in m['steps']
                          if f'{tag}/{s["id"]}' in active}}


def dependencies_done(manifests, data, tag, step, machine, mode, commit, target=None):
    base = version_key(installed_version(data)) if installed_version(data) else (-1, -1, -1)
    lead = lead_step(manifests, data, target) if mode == 'release' and target else None
    if lead and lead != f'{tag}/{step["id"]}':
        entry = latest(data, lead, SERVER, mode, commit)
        if not entry or entry['status'] not in DONE:
            raise UpdateError(f'{lead} must be done first: it installs and updates the whole set.', 2)
    for dependency in step.get('after', []):
        name = full_id(tag, dependency)
        other_tag, other = find_step(manifests, name)
        if mode == 'release' and version_key(other_tag) <= base:
            continue
        entry = latest(data, name, SERVER if other['where'] == 'server' else machine, mode, commit)
        if not entry or entry['status'] not in DONE:
            raise UpdateError(f'{name} must be done first.', 2)


def command_run(args, root):
    mode = 'development' if args.development else 'release'
    with journal(root) as data:
        run = require_run(data, args.owner, args.development)
    commit = run['commit'] if run else None
    checkout = release_tree(root, commit) if commit else root
    manifests = load_manifests(checkout, commit)
    if args.development:
        manifests[NEXT] = {'steps': list(next_steps(root).values())}
    tag, step = find_step(manifests, args.step)
    machine = args.machine or SERVER
    if (step['where'] == 'server') != (machine == SERVER):
        raise UpdateError(f'{args.step} runs on {step["where"]}; pass a matching --machine.')
    with journal(root) as data:
        dependencies_done(manifests, data, tag, step, machine, mode, commit, run and run['release'])
    try:
        status, how, detail, *extra = run_step(checkout, step, args.install, commit)
        checks = extra[0] if extra else observed_checks(step) if status == 'verified' else None
    except UpdateError as error:
        if error.code != 3:
            with journal(root, write=True) as data:
                add_entry(data, args.step, machine, 'failed', 'error', str(error), mode, commit)
        raise
    with journal(root, write=True) as data:
        require_run(data, args.owner, args.development)
        entry = add_entry(data, args.step, machine, status, how, detail, mode, commit, checks)
    if status == 'failed':
        raise UpdateError(json.dumps(entry, ensure_ascii=False))
    return entry


def command_record(args, root):
    mode = 'development' if args.development else 'release'
    if not args.evidence.strip():
        raise UpdateError('--evidence is required: what was checked and what it showed.')
    with journal(root, write=True) as data:
        run = require_run(data, args.owner, args.development)
        commit = run['commit'] if run else None
        manifests = load_manifests(release_tree(root, commit) if commit else root, commit)
        if args.development:
            manifests[NEXT] = {'steps': list(next_steps(root).values())}
        tag, step = find_step(manifests, args.step)
        if (step['where'] == 'server') != (args.machine == SERVER):
            raise UpdateError(f'{args.step} runs on {step["where"]}; pass a matching --machine.')
        automatic = step['kind'] in {'local-plugin', BUNDLE} or bool(step.get('verify'))
        if args.status == 'verified' and args.machine == SERVER and automatic:
            raise UpdateError('This step has an automatic check on the server; use `run`, not `record`.')
        if args.status == 'verified':
            dependencies_done(manifests, data, tag, step, args.machine, mode, commit, run and run['release'])
        return add_entry(data, args.step, args.machine, args.status, 'evidence', args.evidence, mode, commit)


def command_finish(args, root):
    with journal(root, write=True) as data:
        run = require_run(data, args.owner, False)
        manifests = load_manifests(release_tree(root, run['commit']), run['commit'])
        base = version_key(installed_version(data)) if installed_version(data) else (-1, -1, -1)
        for tag, manifest in manifests.items():
            if not base < version_key(tag) <= version_key(run['release']):
                continue
            for step in manifest['steps']:
                name = f'{tag}/{step["id"]}'
                entry = latest(data, name, SERVER, commit=run['commit'])
                if not step.get('requiresPlugins') or not entry or entry['status'] != 'verified':
                    continue
                try:
                    require_dependencies(step)
                except UpdateError as error:
                    add_entry(data, name, SERVER, 'failed', 'verify', str(error), 'release', run['commit'])
        done = None
        for tag in manifests:
            if not base < version_key(tag) <= version_key(run['release']):
                continue
            if pending(manifests, data, tag, run['machines'], run['commit']):
                break
            done = tag
        if done:
            data['installed'] = {'release': done, 'commit': run['commit'] if done == run['release'] else None,
                                 'appliedFrom': run['commit'], 'how': 'release', 'at': now()}
        remaining = pending(manifests, data, run['release'], run['machines'], run['commit'])
        data['partial'] = {'release': run['release'], 'commit': run['commit'], 'remaining': remaining,
                           'at': now()} if remaining else None
        # The thread that ran the update, for the plugin (archiving, reuse).
        data['lastRun'] = {'owner': run['owner'], 'release': run['release'], 'complete': not remaining, 'at': now()}
        data['run'] = None
        result = {'installed': data['installed'], 'partial': data['partial']}
    if result['partial']:
        raise UpdateError(json.dumps(result, ensure_ascii=False), 2)
    return result


BUNDLE_STEP = {
    'id': 'bundle', 'title': 'Полный набор компонентов bb-config', 'component': 'bb-config',
    'where': 'server', 'kind': 'bundle',
    'rerun': 'Безопасно: установленное и актуальное только проверяется; повтор доделывает остаток после сбоя.',
    'rollback': 'Компонент, который не нужен, исключите командой python3 scripts/bundle.py exclude <id> и удалите '
                'штатно (bb plugin remove <id>); прежнюю версию собственного плагина ставит предыдущий релиз.',
}
BUNDLE_PROSE = (
    'Выполняется первым. Сводит установку к заявленному набору `config/bundle.json` этого релиза: '
    'ставит отсутствующие компоненты, обновляет устаревшие (собственные плагины — из закреплённого '
    'коммита, форки и каталоговые — штатным `bb plugin install`/`update`), проверяет и чинит их '
    'настройку (например, мост Voice Mode). Исключённые пользователем компоненты не ставятся, '
    'отключённые остаются отключёнными, плагины из другого источника не заменяются. Личные входы, '
    'настройки и действия на других машинах перечисляются в отчёте (`attention`). Затем шаги '
    'пропущенных релизов проверяются по уже сведённому состоянию.')


def command_release(args, root):
    """Assemble docs/releases/vX.Y.Z.json and .md from the waiting steps in docs/releases/next/."""
    key = version_key(args.release)
    manifests = load_manifests(root)
    if any(version_key(tag) >= key for tag in manifests):
        raise UpdateError(f'{args.release} is not newer than {max(manifests, key=version_key)}')
    waiting = next_steps(root)
    chosen = [name for name in args.steps.split(',') if name] if args.steps else list(waiting)
    problems = [f'no waiting step {name}' for name in chosen if name not in waiting]
    if not chosen and not (root / 'config/bundle.json').is_file():
        problems.append(f'docs/releases/{NEXT}/ has no steps')
    directory = root / 'docs/releases' / NEXT
    for name in chosen:
        step = waiting.get(name)
        if not step:
            continue
        if not (directory / f'{name}.md').is_file():
            problems.append(f'{name}: {NEXT}/{name}.md is missing')
        if step['kind'] == 'local-plugin' and git(root, 'status', '--porcelain', '--', f'plugins/{step["plugin"]}'):
            problems.append(f'{name}: plugins/{step["plugin"]} has uncommitted changes; a release ships committed sources only')
        for dependency in step.get('after', []):
            if dependency.startswith(f'{NEXT}/') and dependency.split('/', 1)[1] not in chosen:
                problems.append(f'{name}: depends on {dependency}, which is not in this release')
    if problems:
        raise UpdateError('\n'.join(problems))
    steps, prose = [], []
    if (root / 'config/bundle.json').is_file():
        # Every release converges the installation to its declared set first.
        steps.append(dict(BUNDLE_STEP))
        prose.append(f'### `{BUNDLE_STEP["id"]}` — {BUNDLE_STEP["title"]}\n\n{BUNDLE_PROSE}\n')
    for name in chosen:
        step = dict(waiting[name])
        after = [d.split('/', 1)[1] if d.startswith(f'{NEXT}/') else d for d in step.get('after', [])]
        step.pop('after', None)
        if after:
            step['after'] = after
        steps.append(step)
        prose.append(f'### `{name}` — {step["title"]}\n\n{(directory / f"{name}.md").read_text().strip()}\n')
    target = root / 'docs/releases'
    (target / f'{args.release}.json').write_text(json.dumps(
        {'schemaVersion': 1, 'version': args.release, 'title': args.title, 'steps': steps}, ensure_ascii=False, indent=2) + '\n')
    (target / f'{args.release}.md').write_text(
        f'# {args.release} — {args.title}\n\nОбщий порядок — [docs/updates.md](../updates.md).\n\n## Шаги\n\n'
        + '\n'.join(prose) + '\n## Проверка релиза\n\n- Заполняется при публикации.\n')
    for name in chosen:
        (directory / f'{name}.json').unlink()
        (directory / f'{name}.md').unlink()
    return {'release': args.release, 'steps': chosen, 'left': [name for name in waiting if name not in chosen],
            'problems': validate(root, args.release)}


def command_accept(args, root):
    """Mark a release installed without an agent when none of its steps needs any action.

    Nothing is built, installed or configured: the pinned commit is prepared
    separately and every pending step must already be settled by the
    actual state. Otherwise nothing is recorded and the answer says why.
    """
    version_key(args.release)

    def refuse(reason):
        return {'accepted': False, 'reason': reason}

    with journal(root) as data:
        if data['run']:
            return refuse(f'an update run is open (owner {data["run"]["owner"]})')
    try:
        command_fetch(args, root)
        checkout = release_tree(root, args.commit)
        manifests = load_manifests(checkout, args.commit)
    except UpdateError as error:
        return refuse(str(error))
    if args.release not in manifests:
        return refuse(f'{args.release} has no manifest in the pinned commit')
    with journal(root) as data:
        base = version_key(installed_version(data)) if installed_version(data) else (-1, -1, -1)
        rows = pending(manifests, data, args.release, [], args.commit)
    for tag, manifest in manifests.items():
        if base < version_key(tag) <= version_key(args.release) and \
                any(step['where'] != 'server' for step in manifest['steps']):
            return refuse(f'{tag} has steps for executor machines')
    results = []
    for row in rows:
        step = find_step(manifests, row['step'])[1]
        try:
            done = settled(checkout, step, args.commit)
            checks = (done[3] if done and len(done) > 3 else
                      observed_checks(step) if done and done[0] == 'verified' else None)
            done = done[:3] if done else done
        except UpdateError as error:
            return refuse(f'{row["step"]}: {error}')
        if not done:
            return refuse(f'{row["step"]} has to be applied')
        results.append((row['step'], *done, checks))
    with journal(root, write=True) as data:
        if data['run']:
            return refuse('an update run was opened meanwhile')
        if data['installed'] and version_key(data['installed']['release']) >= version_key(args.release):
            return refuse('this release is already recorded or superseded')
        for name, status, how, detail, checks in results:
            add_entry(data, name, SERVER, status, how, detail, 'release', args.commit, checks)
        data['installed'] = {'release': args.release, 'commit': args.commit, 'how': 'auto-accept', 'at': now()}
        data['partial'] = None
        return {'accepted': True, 'installed': data['installed'], 'steps': [name for name, *_ in results]}


def latest_release(repository):
    """(tag, commit) of the newest stable GitHub Release. A failure is an error, never 'nothing new'."""
    import urllib.request
    request = urllib.request.Request(f'https://api.github.com/repos/{repository}/releases/latest',
                                     headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'bb-config-updates'})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            tag = json.loads(response.read().decode())['tag_name']
    except (OSError, ValueError, KeyError) as error:
        raise UpdateError(f'Could not read the latest release of {repository}: {error}')
    version_key(tag)
    refs = dict(reversed(line.split('\t', 1)) for line in git(
        ROOT, 'ls-remote', '--', f'https://github.com/{repository}.git', f'refs/tags/{tag}', f'refs/tags/{tag}^{{}}').splitlines())
    commit = refs.get(f'refs/tags/{tag}^{{}}') or refs.get(f'refs/tags/{tag}')
    if not commit or not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise UpdateError(f'Tag {tag} of {repository} was not found.')
    return tag, commit


def origin_repository(root):
    url = git(root, 'remote', 'get-url', 'origin', check=False)
    match = re.search(r'github\.com[/:]([\w-]+/[\w.-]+?)(?:\.git)?/?$', url.stdout.strip()) if url.returncode == 0 else None
    return match.group(1) if match else None


def command_apply(args, root):
    """Install or update in one action: fetch the pinned release and converge to it.

    Without a tag the newest stable release is used. The work itself runs from
    the fetched release (`pinned`), so the procedure of that release applies.
    """
    if not args.release:
        repository = args.repository or origin_repository(root)
        if not repository:
            raise UpdateError('Pass vX.Y.Z --commit <sha>, or --repository owner/repo to use the latest release.')
        args.release, args.commit = latest_release(repository)
        args.repository = repository
    elif not args.commit:
        raise UpdateError('--commit is required with a release tag.')
    checkout = Path(command_fetch(args, root)['checkout'])
    script = checkout / 'scripts/updates.py'
    command = [sys.executable, str(script), 'pinned', args.release, '--commit', args.commit, '--owner', args.owner]
    if args.machines:
        command += ['--machines', args.machines]
    result = subprocess.run(compat.argv(command), cwd=checkout, capture_output=True, text=True)
    if result.returncode != 0 and 'invalid choice' in result.stderr:
        raise UpdateError(f'{args.release} predates one-step updates; follow docs/updates.md step by step.')
    try:
        answer = json.loads(result.stdout if result.returncode == 0 else result.stderr)
    except ValueError:
        raise UpdateError((result.stdout + result.stderr).strip()[-800:] or 'pinned run failed', result.returncode or 1)
    if result.returncode:
        raise UpdateError(json.dumps(answer, ensure_ascii=False, indent=1), result.returncode)
    return answer


def command_pinned(args, root):
    """Inside a fetched release: begin, run every server step in order, finish."""
    if not release_location(root) or root.name != args.commit:
        raise UpdateError('pinned runs inside the prepared release; use `apply`.')
    opened = command_begin(argparse.Namespace(release=args.release, commit=args.commit, owner=args.owner,
                                              machines=args.machines, takeover=False), root)
    outcomes, attention, report = [], [], None
    steps = opened['steps']
    lead = lead_step(load_manifests(root, args.commit), {'installed': opened['installed']}, args.release)
    for row in opened['pending']:
        if row['machine'] != SERVER:
            continue
        if lead and outcomes and outcomes[0]['step'] == lead and outcomes[0]['status'] != 'verified':
            outcomes.append({'step': row['step'], 'status': 'blocked', 'detail': f'waits for {lead}'})
            continue
        try:
            entry = command_run(argparse.Namespace(step=row['step'], machine=None, install=False,
                                                   development=False, owner=args.owner), root)
            outcomes.append({'step': row['step'], 'status': entry['status'], 'how': entry['how'], 'detail': entry['detail']})
            if entry.get('bundle'):
                report = entry['bundle']
        except UpdateError as error:
            text = str(error)
            try:
                failed = json.loads(text)
                outcomes.append({'step': row['step'], 'status': 'failed', 'how': failed.get('how'), 'detail': failed.get('detail')})
                report = failed.get('bundle') or report
            except ValueError:
                outcomes.append({'step': row['step'], 'status': {2: 'blocked', 3: 'needs-decision'}.get(error.code, 'failed'),
                                 'detail': text[-400:]})
    if report:
        attention = report.get('attention', [])
    elsewhere = [row for row in opened['pending'] if row['machine'] != SERVER]
    try:
        finished = command_finish(argparse.Namespace(owner=args.owner), root)
        code = 0
    except UpdateError as error:
        finished = json.loads(str(error)) if str(error).startswith('{') else {'error': str(error)}
        code = error.code
    result = {'release': args.release, 'commit': args.commit, 'steps': outcomes, 'attention': attention,
              'otherMachines': [{**row, 'title': steps.get(row['step'], {}).get('title')} for row in elsewhere],
              'installed': finished.get('installed'), 'remaining': (finished.get('partial') or {}).get('remaining', [])}
    if code:
        decisions = any(item['status'] == 'needs-decision' for item in outcomes)
        raise UpdateError(json.dumps(result, ensure_ascii=False, indent=1), 3 if decisions else code)
    return result


def command_validate(args, root):
    problems = validate(root, args.release)
    if problems:
        raise UpdateError('\n'.join(problems))
    return {'valid': sorted(load_manifests(root), key=version_key), 'waiting': sorted(next_steps(root))}


def command_require_plugin(args, root):
    """Helper for verify/applies argv: exit 0 when the plugin is installed (and new enough)."""
    plugin = installed_plugins().get(args.plugin)
    if not plugin:
        raise UpdateError(f'{args.plugin} is not installed')
    if args.min and tuple(map(int, re.findall(r'\d+', plugin['version'])[:3])) < version_key('v' + args.min):
        raise UpdateError(f'{args.plugin} {plugin["version"]} is older than {args.min}')
    return {'plugin': args.plugin, 'version': plugin['version'], 'enabled': plugin['enabled']}


def main(argv=None, root=ROOT):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--installation', type=Path, help='existing bb-config checkout when bootstrapping a new runner')
    sub = parser.add_subparsers(dest='command', required=True)
    owner = os.environ.get('BB_THREAD_ID') or f'pid-{os.getppid()}'

    def add(name, function, release=False, commit=False, run=False):
        command = sub.add_parser(name, help=(function.__doc__ or '').strip().split('\n')[0])
        command.set_defaults(function=function)
        if release:
            command.add_argument('release', help='release tag vX.Y.Z')
        if commit:
            command.add_argument('--commit', required=True, help='pinned 40-character commit of the release')
        if run:
            command.add_argument('--owner', default=owner, help='run owner (default: $BB_THREAD_ID)')
        return command

    add('status', command_status).add_argument('--dependencies', action='store_true', help='check dependencies of recorded releases')
    add('fetch', command_fetch, release=True, commit=True).add_argument('--repository', help='GitHub owner/repository (default: origin)')
    command = add('baseline', command_baseline, release=True, commit=True)
    command.add_argument('--note', default='')
    command.add_argument('--force', action='store_true')
    command = add('begin', command_begin, release=True, commit=True, run=True)
    command.add_argument('--machines', help='comma-separated BB machine ids for executor steps')
    command.add_argument('--takeover', action='store_true', help='replace a certainly stopped run')
    command = add('run', command_run, run=True)
    command.add_argument('step', help='vX.Y.Z/<step id>, or next/<step id> with --development')
    command.add_argument('--machine', help='BB machine id for an executor step run on this machine')
    command.add_argument('--install', action='store_true', help='the user agreed to install a new component')
    command.add_argument('--development', action='store_true', help='author check before publishing; no run lock')
    command = add('record', command_record, run=True)
    command.add_argument('step')
    command.add_argument('--machine', required=True, help=f'"{SERVER}" or a BB machine id')
    command.add_argument('--status', required=True, choices=['verified', 'not-applicable', 'failed'])
    command.add_argument('--evidence', required=True)
    command.add_argument('--development', action='store_true')
    add('finish', command_finish, run=True)
    command = add('apply', command_apply, run=True)
    command.add_argument('release', nargs='?', help='release tag vX.Y.Z (default: the newest stable release)')
    command.add_argument('--commit', help='pinned 40-character commit of the release')
    command.add_argument('--repository', help='GitHub owner/repository (default: origin)')
    command.add_argument('--machines', help='comma-separated BB machine ids for executor steps')
    command = add('pinned', command_pinned, release=True, commit=True, run=True)
    command.add_argument('--machines', help=argparse.SUPPRESS)
    add('accept', command_accept, release=True, commit=True).add_argument('--repository', help='GitHub owner/repository (default: origin)')
    command = add('release', command_release, release=True)
    command.add_argument('--title', required=True)
    command.add_argument('--steps', help='comma-separated ids from docs/releases/next/ (default: all)')
    command = add('validate', command_validate)
    command.add_argument('release', nargs='?')
    command = add('require-plugin', command_require_plugin)
    command.add_argument('plugin')
    command.add_argument('--min')
    args = parser.parse_args(argv)
    if getattr(args, 'commit', None) and not re.fullmatch(r'[0-9a-f]{40}', args.commit):
        parser.error('--commit must be a full 40-character SHA')
    if getattr(args, 'repository', None) and not re.fullmatch(r'[\w-]+/[\w.-]+', args.repository, re.ASCII):
        parser.error('--repository must be a GitHub owner/repository')
    if args.installation:
        root = args.installation.resolve()
        if not (root / '.git').exists() or not (root / 'scripts/updates.py').is_file():
            parser.error('--installation must point to the existing bb-config checkout')
    try:
        print(json.dumps(args.function(args, root), ensure_ascii=False, indent=1))
        return 0
    except UpdateError as error:
        print(str(error), file=sys.stderr)
        return error.code


if __name__ == '__main__':
    compat.utf8_main()
    sys.exit(main())
