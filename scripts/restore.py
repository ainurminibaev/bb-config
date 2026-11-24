#!/usr/bin/env python3
"""Preview restoration; --plugins --apply installs plugins and restores preferences."""
import argparse
import json
import re
from voice_source import is_voice_fork
from pathlib import Path
from plugin_scope import outside, project_homes, project_roots
import shlex
import subprocess
import sys

import platform_compat as compat

ROOT = Path(__file__).resolve().parents[1]
# These may change connectivity or provider routing. Preserve for explicit setup.
MANUAL_SETTINGS = {'connect', 'proxy-manager', 'provider-acp'}
MANUAL_STATES = {'connect', 'bb--connect-next', 'account-pool'}
# Added by the reviewed managed-source patch, absent from the catalog release.
# plugins/voice-mode/apply.py restores these after building the patched plugin.
MANUAL_PLUGIN_KEYS = {'voice-mode': {'vadThreshold', 'silenceDurationMs', 'noiseReduction'}}


def read(name, root=ROOT):
    """Private dictionaries override public defaults; lists are replaced whole."""
    public = root / 'config' / f'{name}.json'
    private = root / '.local/config' / f'{name}.json'
    shared = json.loads(public.read_text()) if public.exists() else {}
    if not private.exists():
        return shared
    local = json.loads(private.read_text())
    if isinstance(shared, dict) and isinstance(local, dict):
        return shared | local
    return local


def value(data):
    return data if isinstance(data, str) else json.dumps(data, separators=(',', ':'))


def tag_prefix(plugin):
    """Options for releases tagged <prefix>vX.Y.Z; BB records them as @semver:<prefix>:<range>."""
    match = re.search(r'@semver:([^:\s]+/):', plugin['source'])
    return ['--tag-prefix', match[1]] if match else []


def install_source(plugin):
    if plugin['source'].startswith(('builtin:', 'path:')):
        return plugin['source']
    if plugin.get('installSource') and not is_voice_fork(plugin):
        return plugin['installSource']
    # BB records a normalized internal range; the install CLI takes @<range>.
    return re.sub(r'@semver:([^:\s]+/:)?', '@', plugin['source'])


def installed_ids():
    """Plugin ids the connected BB already has, or None when it cannot be asked."""
    try:
        listing = json.loads(subprocess.check_output(compat.argv(['bb', 'plugin', 'list', '--json']), text=True,
                                                     stderr=subprocess.DEVNULL))
    except (OSError, subprocess.CalledProcessError, ValueError):
        return None
    plugins = listing if isinstance(listing, list) else listing.get('plugins', [])
    return {plugin['id'] for plugin in plugins}


class InProject(list):
    """argv run with the plugin's project checkout as working directory."""
    cwd = None


def project_plan(root=ROOT, installed=None, find_roots=project_roots):
    """Plugins whose home is a project: install from the project, never from here."""
    commands, notes = [], []
    for plugin_id, home in sorted(project_homes(root).items()):
        if installed is not None and plugin_id in installed:
            continue
        source = home.get('source', '')
        roots = [r for r in find_roots(home['project'])
                 if not source or '://' in source or (r / source).exists()]
        if not roots:
            notes.append(f'{plugin_id}: belongs to project {home["project"]}, which is not on this machine; '
                         f'install it from that project: {home["install"]}')
            continue
        command = InProject(shlex.split(home['install']))
        command.cwd = str(roots[0])
        commands.append(command)
    return commands, notes


def plan(install_plugins=False, root=ROOT, installed=None, notes=None, find_roots=project_roots):
    """Commands are argv arrays; saved text is never interpreted by a shell.

    `installed` is the set of plugin ids BB already has, so a second run is
    safe: installed catalog plugins are left to their own updates, local ones
    are rebuilt and reloaded. Some bundled plugins are not registered on a
    fresh BB; those missing are installed before they are enabled. None
    (BB unreachable) plans a full install and skips bundled plugins.
    """
    commands = []
    if (root / 'config/codex.json').is_file():
        commands.append([sys.executable, str(root / 'scripts/codex_defaults.py'),
                         '--defaults', str(root / 'config/codex.json'), '--apply'])
    excluded = outside(root)
    manifest = [p for p in read('plugins', root) if p['id'] not in excluded]
    if install_plugins:
        for plugin in manifest:
            source = install_source(plugin)
            if source.startswith('builtin:'):
                if installed is not None and plugin['id'] not in installed:
                    commands.append(['bb', 'plugin', 'install', source, '--yes'])
                continue
            if source.startswith('path:'):
                relative = Path(source.removeprefix('path:'))
                if relative.is_absolute() or '..' in relative.parts:
                    raise ValueError('Local plugin source must be relative to this repository')
                directory = root / relative
                if not (directory / 'package.json').is_file():
                    raise ValueError('Missing plugin sources: ' + str(relative))
                already = installed is not None and plugin['id'] in installed
                commands.extend([
                    ['npm', '--prefix', str(directory), 'ci'],
                    ['bb', 'plugin', 'build', str(directory)],
                    ['bb', 'plugin', 'reload', plugin['id']] if already
                    else ['bb', 'plugin', 'install', 'path:' + str(directory), '--yes'],
                ])
            elif installed is None or plugin['id'] not in installed:
                # Already installed catalog plugins keep their own updates.
                subdirectory = ['--subdirectory', plugin['subdirectory']] if plugin.get('subdirectory') else []
                commands.append(['bb', 'plugin', 'install', source, *subdirectory, *tag_prefix(plugin), '--yes'])
        project_commands, project_notes = project_plan(root, installed, find_roots)
        commands.extend(project_commands)
        if notes is not None:
            notes.extend(project_notes)
    # Make commands contributed by bundled plugins available before their prefs.
    if install_plugins:
        for plugin in manifest:
            if plugin['enabled'] and plugin['id'] not in MANUAL_STATES:
                commands.append(['bb', 'plugin', 'enable', plugin['id']])
    for key, data in read('general', root).items():
        if key == 'providerCompletedTurnDisplay':
            for provider, mode in data.items():
                commands.append(['bb', 'settings', 'completed-turns', provider, mode])
        else:
            commands.append(['bb', 'settings', 'general', key, value(data)])
    for key, data in read('experiments', root).items():
        commands.append(['bb', 'settings', 'experiment', key, value(data)])
    appearance = read('appearance', root)
    if appearance['customCss'] is None:
        commands.append(['bb', 'theme', 'set', appearance['themeId'], '--favicon-color', appearance['faviconColor']])
    names = {p.stem for directory in ('config/plugins', '.local/config/plugins')
             for p in (root / directory).glob('*.json')}
    for name in sorted(names):
        if name in MANUAL_SETTINGS or name in excluded:
            continue
        for key, data in read('plugins/' + name, root).items():
            if key in MANUAL_PLUGIN_KEYS.get(name, set()):
                continue
            commands.append(['bb', 'plugin', 'config', name, 'set', key, value(data)])
    for key, data in read('ui', root).items():
        commands.append(['bb', 'settings', 'ui', 'set', key, value(data)])
    for key, data in read('thread-list', root).items():
        # Old machine/project/thread ids cannot be reused on a fresh installation.
        if key in {'hiddenGroups', 'collapsedProjects', 'collapsedThreads', 'collapsedEnvironments',
                   'collapsedThreadSections', 'collapsedMachines'} and data:
            continue
        commands.append(['bb', 'thread-list', 'prefs', 'set', key, value(data)])
    for task, selection in read('ai-services', root).items():
        mode = selection['mode']
        if mode in {'automatic', 'off'}:
            commands.append(['bb', 'settings', 'ai-services', 'set', task, mode])
    if install_plugins:
        # Disabling a provider or command owner comes last.
        for plugin in manifest:
            if not plugin['enabled'] and plugin['id'] not in MANUAL_STATES:
                commands.append(['bb', 'plugin', 'disable', plugin['id']])
    return commands


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='Execute the plan (default: print only)')
    parser.add_argument('--plugins', action='store_true', help='Also install plugins and restore enabled/disabled state')
    args = parser.parse_args()
    notes = []
    commands = plan(args.plugins, installed=installed_ids() if args.plugins else None, notes=notes)
    if args.apply and args.plugins:
        # path: sources are read by the BB server. Refuse a remote-server path
        # mismatch before running even npm ci or changing any preferences.
        status = json.loads(subprocess.check_output(compat.argv(['bb', 'status', '--json']), text=True))
        if not Path(status['dataDir']).is_dir():
            raise SystemExit('Run --plugins --apply on the BB server machine, in its bb-config checkout. '
                             'Local plugin paths are server-side; this CLI is connected remotely.')
    skipped = []
    for command in commands:
        # All saved settings may contain personal text; previews show keys only.
        has_value = command[:3] in ([ 'bb', 'settings', 'general' ],
            ['bb', 'settings', 'experiment']) or command[:4] in (
            ['bb', 'settings', 'ui', 'set'], ['bb', 'thread-list', 'prefs', 'set']) or command[:3] == ['bb', 'plugin', 'config']
        shown = shlex.join(command[:-1] + ['<saved value>'] if has_value else command)
        if getattr(command, 'cwd', None):
            shown = f'(in {command.cwd}) ' + shown
        print(shown, flush=True)
        if not args.apply:
            continue
        if command[:2] == ['bb', 'settings'] or command[:2] == ['bb', 'thread-list'] or command[:3] == ['bb', 'plugin', 'config']:
            # A saved preference this BB version no longer accepts must not
            # abort the rest; plugin installs and builds stay fatal.
            result = subprocess.run(compat.argv(command), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
            if result.returncode != 0:
                reason = (result.stderr.strip().splitlines() or ['failed'])[-1][:160]
                print(f'  skipped: {reason}', flush=True)
                skipped.append(shown)
        else:
            subprocess.run(compat.argv(list(command)), check=True, stdout=subprocess.DEVNULL,
                           cwd=getattr(command, 'cwd', None))
    for note in notes:
        print('skipped project plugin: ' + note)
    if skipped:
        print(f'\n{len(skipped)} saved preference(s) were not accepted by this BB version and were skipped:')
        for shown in skipped:
            print('  ' + shown)
    print('\nManual steps: docs/customizations.md (credentials, routes, machine IDs, keyboard/custom CSS).')
    print('Finish with: python3 scripts/setup_tracking.py --apply')


if __name__ == '__main__':
    compat.utf8_main()
    main()
