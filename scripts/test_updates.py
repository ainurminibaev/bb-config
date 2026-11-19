import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import updates

MARK = [sys.executable, '-c', 'import pathlib,sys; pathlib.Path(sys.argv[1]).write_text("x")']
HAS = [sys.executable, '-c', 'import pathlib,sys; sys.exit(0 if pathlib.Path(sys.argv[1]).exists() else 1)']


def step(name, **extra):
    base = {'id': name, 'title': name, 'component': 'scripts', 'where': 'server', 'kind': 'command',
            'apply': MARK + [f'{{root}}/{name}.done'], 'verify': HAS + [f'{{root}}/{name}.done'],
            'rerun': 'safe', 'rollback': 'delete the marker'}
    return base | extra


class Repo:
    """A checkout cloned from a bare origin; release() commits a manifest and tags it."""

    def __init__(self, directory):
        self.origin = Path(directory) / 'origin.git'
        self.root = Path(directory) / 'checkout'
        self.author = Path(directory) / 'author'
        subprocess.run(['git', 'init', '-q', '--bare', '-b', 'main', str(self.origin)], check=True)
        subprocess.run(['git', 'clone', '-q', str(self.origin), str(self.author)], check=True, stderr=subprocess.DEVNULL)
        self.git(self.author, 'config', 'user.email', 'test@example.org')
        self.git(self.author, 'config', 'user.name', 'Test')
        (self.author / '.gitignore').write_text('.local/\n*.done\n')
        self.commit('initial')
        subprocess.run(['git', 'clone', '-q', str(self.origin), str(self.root)], check=True)

    def git(self, root, *args):
        return subprocess.run(['git', '-C', str(root), *args], check=True, capture_output=True, text=True).stdout.strip()

    def commit(self, message):
        self.git(self.author, 'add', '-A')
        self.git(self.author, 'commit', '-q', '-m', message)
        self.git(self.author, 'push', '-q', 'origin', 'HEAD:main')
        return self.git(self.author, 'rev-parse', 'HEAD')

    def release(self, tag, steps):
        releases = self.author / 'docs/releases'
        releases.mkdir(parents=True, exist_ok=True)
        (releases / f'{tag}.json').write_text(json.dumps({'schemaVersion': 1, 'version': tag, 'title': tag, 'steps': steps}))
        (releases / f'{tag}.md').write_text(''.join(f'`{s["id"]}`\n' for s in steps) or 'none\n')
        sha = self.commit(tag)
        self.git(self.author, 'tag', tag)
        self.git(self.author, 'push', '-q', 'origin', tag)
        return sha


class UpdatesTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.repo = Repo(self.directory.name)
        patcher = patch.dict(os.environ, {'BB_THREAD_ID': 'thr_a'})
        patcher.start()
        self.addCleanup(patcher.stop)
        os.environ.pop('BB_CONFIG_UPDATES_DIR', None)

    def call(self, *argv, root=None):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = updates.main(list(argv), root or self.repo.root)
        return code, (json.loads(out.getvalue()) if code == 0 else err.getvalue())

    def test_missed_releases_apply_in_order_and_only_verified_steps_complete(self):
        original = self.repo.git(self.repo.root, 'rev-parse', 'HEAD')
        self.repo.release('v1.0.0', [step('one')])
        second = self.repo.release('v1.1.0', [step('two', after=['v1.0.0/one']), step('broken', verify=HAS + ['/nonexistent'])])
        self.assertEqual(self.call('status')[1]['installed'], None)
        self.assertEqual(self.call('fetch', 'v1.1.0', '--commit', second)[1]['result'], 'prepared')
        self.assertEqual(self.call('fetch', 'v1.1.0', '--commit', second)[1]['result'], 'already-prepared')
        code, begun = self.call('begin', 'v1.1.0', '--commit', second)
        self.assertEqual([row['step'] for row in begun['pending']], ['v1.0.0/one', 'v1.1.0/two', 'v1.1.0/broken'])
        self.assertEqual(self.call('run', 'v1.1.0/two')[0], 2)  # dependency from the skipped release
        self.assertEqual(self.call('run', 'v1.0.0/one')[1]['how'], 'applied')
        self.assertEqual(self.call('run', 'v1.0.0/one')[1]['how'], 'existing')  # rerun verifies, never reapplies
        self.assertEqual(self.call('run', 'v1.1.0/two')[1]['status'], 'verified')
        self.assertEqual(self.call('run', 'v1.1.0/broken')[0], 1)
        code, message = self.call('finish')
        self.assertEqual(code, 2)
        result = json.loads(message)
        self.assertEqual(result['installed']['release'], 'v1.0.0')  # the partial release is not installed
        self.assertEqual([row['step'] for row in result['partial']['remaining']], ['v1.1.0/broken'])
        self.assertIsNone(self.call('status')[1]['run'])
        self.assertEqual(self.repo.git(self.repo.root, 'rev-parse', 'HEAD'), original)
        checkout = updates.release_tree(self.repo.root, second)
        self.assertEqual(self.repo.git(checkout, 'tag'), 'v1.1.0')

    def test_parallel_run_is_refused_and_same_owner_resumes(self):
        sha = self.repo.release('v1.0.0', [step('one')])
        self.call('fetch', 'v1.0.0', '--commit', sha)
        self.assertEqual(self.call('begin', 'v1.0.0', '--commit', sha)[0], 0)
        self.assertTrue(self.call('begin', 'v1.0.0', '--commit', sha)[1]['resumed'])
        with patch.dict(os.environ, {'BB_THREAD_ID': 'thr_b'}):
            self.assertEqual(self.call('begin', 'v1.0.0', '--commit', sha)[0], 3)
            self.assertEqual(self.call('run', 'v1.0.0/one')[0], 3)
            self.assertFalse((self.repo.root / 'one.done').exists())
            self.assertEqual(self.call('begin', 'v1.0.0', '--commit', sha, '--takeover')[0], 0)
        self.assertEqual(self.call('run', 'v1.0.0/one')[0], 3)
        self.assertEqual(self.call('run', 'v1.0.0/nope', '--development')[0], 1)

    def test_plan_orders_dependencies_and_keeps_the_active_pin(self):
        first = self.repo.release('v1.0.0', [step('addon', after=['base']), step('base'), step('last')])
        second = self.repo.release('v1.0.1', [step('next')])
        self.call('fetch', 'v1.0.0', '--commit', first)
        self.call('fetch', 'v1.0.1', '--commit', second)
        run = self.call('begin', 'v1.0.0', '--commit', first)[1]
        self.assertEqual([item['step'] for item in run['pending']], ['v1.0.0/base', 'v1.0.0/addon', 'v1.0.0/last'])
        self.assertIn('before changing the pinned release', self.call('begin', 'v1.0.1', '--commit', second)[1])
        self.assertEqual(self.call('status')[1]['run']['commit'], first)

    def test_historical_helpers_keep_the_installation_state(self):
        marker = '{root}/.local/plugin-patches/demo.done'
        sha = self.repo.release('v1.0.0', [step('legacy', apply=MARK + [marker], verify=HAS + [marker])])
        checkout = Path(self.call('fetch', 'v1.0.0', '--commit', sha)[1]['checkout'])
        self.assertEqual((checkout / '.local/config').resolve(), self.repo.root / '.local/config')
        self.call('begin', 'v1.0.0', '--commit', sha)
        self.assertEqual(self.call('run', 'v1.0.0/legacy', root=checkout)[1]['how'], 'applied')
        self.assertTrue((self.repo.root / '.local/plugin-patches/demo.done').is_file())
        self.assertEqual(self.call('finish')[0], 0)

    def test_prepares_a_release_without_touching_dirty_or_diverged_checkout(self):
        sha = self.repo.release('v1.0.0', [step('one')])
        self.assertIn('moved', self.call('fetch', 'v1.0.0', '--commit', '0' * 40)[1])
        tracked = self.repo.root / '.gitignore'
        tracked.write_text('local edit\n')
        self.assertEqual(self.call('begin', 'v1.0.0', '--commit', sha)[0], 1)
        self.assertEqual(self.call('fetch', 'v1.0.0', '--commit', sha)[0], 0)
        self.assertEqual(tracked.read_text(), 'local edit\n')
        self.repo.git(self.repo.root, '-c', 'user.email=a@example.org', '-c', 'user.name=a', 'commit', '-qam', 'local')
        revision = self.repo.git(self.repo.root, 'rev-parse', 'HEAD')
        prepared = self.call('fetch', 'v1.0.0', '--commit', sha)[1]
        self.assertEqual(prepared['result'], 'already-prepared')
        self.assertEqual(self.call('begin', 'v1.0.0', '--commit', sha)[0], 0)
        self.assertEqual(self.repo.git(self.repo.root, 'rev-parse', 'HEAD'), revision)
        release_root = Path(prepared['checkout'])
        self.assertEqual(self.call('status', root=release_root)[1]['run']['commit'], sha)
        (release_root / '.gitignore').write_text('changed release\n')
        self.assertIn('contains local changes', self.call('run', 'v1.0.0/one')[1])
        new_commit = self.repo.git(self.repo.author, 'rev-parse', 'HEAD^')
        self.repo.git(self.repo.author, 'tag', '-f', 'v1.0.0', new_commit)
        self.repo.git(self.repo.author, 'push', '-qf', 'origin', 'v1.0.0')
        self.assertIn('moved', self.call('fetch', 'v1.0.0', '--commit', sha)[1])

    def test_executor_steps_are_tracked_per_machine_and_stay_pending_for_an_absent_one(self):
        sha = self.repo.release('v1.0.0', [step('cli', where='executors')])
        self.call('fetch', 'v1.0.0', '--commit', sha)
        self.call('begin', 'v1.0.0', '--commit', sha, '--machines', 'host_a,host_b')
        self.assertEqual(self.call('run', 'v1.0.0/cli')[0], 1)  # needs --machine
        self.assertEqual(self.call('run', 'v1.0.0/cli', '--machine', 'host_a')[1]['machine'], 'host_a')
        self.assertEqual(self.call('record', 'v1.0.0/cli', '--machine', 'host_b', '--status', 'verified', '--evidence', ' ')[0], 1)
        self.assertEqual(self.call('finish')[0], 2)
        self.assertIsNone(self.call('status')[1]['installed'])
        begun = self.call('begin', 'v1.0.0', '--commit', sha, '--machines', 'host_a')[1]  # host_b cannot be dropped silently
        self.assertEqual(begun['pending'], [{'step': 'v1.0.0/cli', 'machine': 'host_b', 'status': 'pending', 'detail': ''}])
        self.call('record', 'v1.0.0/cli', '--machine', 'host_b', '--status', 'verified', '--evidence', 'ran verify there: exit 0')
        self.assertEqual(self.call('finish')[1]['installed']['release'], 'v1.0.0')

    def test_development_check_does_not_count_as_release_and_baseline_skips_old_steps(self):
        self.repo.release('v1.0.0', [step('one')])
        sha = self.repo.release('v1.1.0', [step('two'), step('note', kind='manual', apply=None, verify=None)])
        self.call('fetch', 'v1.1.0', '--commit', sha)
        release_root = updates.release_tree(self.repo.root, sha)
        self.assertEqual(self.call('run', 'v1.1.0/two', '--development', root=release_root)[1]['mode'], 'development')
        self.assertEqual(self.call('baseline', 'v1.0.0', '--commit', sha)[0], 0)
        begun = self.call('begin', 'v1.1.0', '--commit', sha)[1]
        self.assertEqual([row['step'] for row in begun['pending']], ['v1.1.0/two', 'v1.1.0/note'])
        self.assertEqual(self.call('run', 'v1.1.0/two')[1]['how'], 'existing')  # verified, not reapplied
        self.assertEqual(self.call('record', 'v1.1.0/two', '--machine', 'server', '--status', 'verified', '--evidence', 'x')[0], 1)
        self.assertEqual(self.call('run', 'v1.1.0/note')[0], 3)
        self.call('record', 'v1.1.0/note', '--machine', 'server', '--status', 'not-applicable', '--evidence', 'user declined')
        self.assertEqual(self.call('finish')[1], {'installed': self.call('status')[1]['installed'], 'partial': None})

    def test_local_plugin_keeps_user_selection_and_verifies_running_version(self):
        plugin = self.repo.author / 'plugins/demo'
        plugin.mkdir(parents=True)
        (plugin / 'package.json').write_text('{"version": "1.2.0"}')
        (plugin / 'package-lock.json').write_text('{}')
        base = {'component': 'demo', 'kind': 'local-plugin', 'plugin': 'demo', 'apply': None, 'verify': None}
        sha = self.repo.release('v1.0.0', [step('demo', **base), step('fresh', **base, introduces=True)])
        self.call('fetch', 'v1.0.0', '--commit', sha)
        self.call('begin', 'v1.0.0', '--commit', sha)
        commands = []
        installed = {}
        def execute(argv, root):
            commands.append(argv[:3])
            if argv[1:3] == ['plugin', 'install']:
                installed['demo'].update(version='1.2.0', rootDir=argv[3].removeprefix('path:'), source=argv[3])
            return 0, ''
        with patch.object(updates, 'installed_plugins', lambda: installed), patch.object(updates, 'execute', execute):
            self.assertEqual(self.call('run', 'v1.0.0/demo')[1]['status'], 'not-applicable')  # not chosen by the user
            self.assertEqual(self.call('run', 'v1.0.0/fresh')[0], 3)  # new component: ask first
            self.assertEqual(commands, [])
            installed['demo'] = {'version': '1.1.0', 'rootDir': str(self.repo.root / 'plugins/demo'), 'enabled': True, 'status': 'running'}
            legacy = self.repo.root / 'plugins/demo'
            legacy.mkdir(parents=True)
            local_file = legacy / 'package.json'
            local_file.write_text('{"version": "9.9.9"}')
            result = self.call('run', 'v1.0.0/demo')[1]
            self.assertEqual(result['how'], 'applied')
            self.assertEqual(result['pluginChecks']['demo']['version'], '1.2.0')
            self.assertTrue(result['pluginChecks']['demo']['source'].endswith(f'{sha}/plugins/demo'))
            self.assertEqual(commands[-1][-1], 'install')
            self.assertEqual(local_file.read_text(), '{"version": "9.9.9"}')
            count = len(commands)
            self.assertEqual(self.call('run', 'v1.0.0/demo')[1]['how'], 'existing')
            self.assertEqual(len(commands), count)
            installed['demo']['version'] = '1.3.0'  # the author's later build: nothing to apply from this release
            self.assertIn('newer than release 1.2.0', self.call('run', 'v1.0.0/demo')[1]['detail'])
            installed['demo']['rootDir'] = '/elsewhere'
            self.assertEqual(self.call('run', 'v1.0.0/demo')[0], 1)  # another source is never replaced
            self.assertEqual(len(commands), count)

    def test_dependency_versions_are_checked_at_run_finish_and_after_external_updates(self):
        requirement = {'id': 'catalog-addon', 'min': '1.4.0', 'before': '2.0.0'}
        sha = self.repo.release('v1.0.0', [step('integration', requiresPlugins=[requirement])])
        self.call('fetch', 'v1.0.0', '--commit', sha)
        self.call('begin', 'v1.0.0', '--commit', sha)
        installed = {}
        with patch.object(updates, 'installed_plugins', lambda: installed):
            self.assertIn('required plugin is missing', self.call('run', 'v1.0.0/integration')[1])
            fake_userinfo = 'user:private'
            addon = {'version': '1.3.0', 'enabled': True, 'status': 'running',
                     'source': f'git:https://{fake_userinfo}@repo.example/addon'}
            installed['catalog-addon'] = addon
            self.assertIn('requires >=1.4.0, <2.0.0', self.call('run', 'v1.0.0/integration')[1])
            addon['version'] = '1.4.0'
            entry = self.call('run', 'v1.0.0/integration')[1]
            self.assertEqual(entry['pluginChecks']['catalog-addon']['version'], '1.4.0')
            self.assertEqual(entry['pluginChecks']['catalog-addon']['source'], 'git:https://repo.example/addon')
            addon['version'] = '2.0.0'
            code, output = self.call('finish')
            self.assertEqual(code, 2)
            self.assertIsNone(json.loads(output)['installed'])
            addon['version'] = '1.5.0'
            self.call('begin', 'v1.0.0', '--commit', sha)
            self.assertEqual(self.call('run', 'v1.0.0/integration')[1]['how'], 'existing')
            self.assertEqual(self.call('finish')[0], 0)
            self.assertEqual(self.call('status', '--dependencies')[1]['dependencyIssues'], [])
            addon['version'] = '2.0.0'
            status = self.call('status', '--dependencies')[1]
            self.assertEqual(status['installed']['release'], 'v1.0.0')
            self.assertIn('installed 2.0.0', status['dependencyIssues'][0])

    def test_validate_requires_prose_for_every_step_and_a_version_bump(self):
        plugin = self.repo.author / 'plugins/demo'
        plugin.mkdir(parents=True)
        (plugin / 'package.json').write_text('{"version": "1.0.0"}')
        (plugin / 'package-lock.json').write_text('{}')
        base = {'component': 'demo', 'kind': 'local-plugin', 'plugin': 'demo', 'apply': None, 'verify': None}
        self.repo.release('v1.0.0', [step('demo', **base)])
        self.assertEqual(self.call('validate', root=self.repo.author)[0], 0)
        (plugin / 'index.ts').write_text('changed')
        self.repo.release('v1.0.1', [step('demo', **base)])
        self.assertIn('bump its version', self.call('validate', 'v1.0.1', root=self.repo.author)[1])
        (self.repo.author / 'docs/releases/v1.0.1.md').write_text('nothing')
        self.assertIn('does not describe step `demo`', self.call('validate', root=self.repo.author)[1])
        self.assertTrue(updates.manifest_errors({'schemaVersion': 1, 'version': 'v9.9.9', 'title': 't', 'steps': [
            {'id': 'Bad id'}, step('x', where='moon'), step('y', kind='command', apply=None)]}, 'v1.0.0'))


    def test_release_assembles_only_committed_waiting_steps(self):
        author = self.repo.author
        plugin = author / 'plugins/demo'
        plugin.mkdir(parents=True)
        (plugin / 'package.json').write_text('{"version": "1.0.0"}')
        (plugin / 'package-lock.json').write_text('{}')
        base = {'component': 'demo', 'kind': 'local-plugin', 'plugin': 'demo', 'apply': None, 'verify': None}
        self.repo.release('v1.0.0', [step('demo', **base)])
        waiting = author / 'docs/releases/next'
        waiting.mkdir()
        for name, extra in (('demo-two', base), ('script', {'after': ['next/demo-two']}), ('later', {})):
            (waiting / f'{name}.json').write_text(json.dumps(step(name, **extra)))
            (waiting / f'{name}.md').write_text(f'How `{name}` works.\n')
        (plugin / 'package.json').write_text('{"version": "1.1.0"}')
        self.assertEqual(self.call('run', 'next/script', '--development', root=author)[0], 2)  # dependency first
        self.assertIn('uncommitted', self.call('release', 'v1.1.0', '--title', 'T', '--steps', 'demo-two,script', root=author)[1])
        self.assertIn('not in this release', self.call('release', 'v1.1.0', '--title', 'T', '--steps', 'script', root=author)[1])
        self.repo.commit('demo 1.1.0')
        self.assertIn('not newer', self.call('release', 'v1.0.0', '--title', 'T', root=author)[1])
        code, result = self.call('release', 'v1.1.0', '--title', 'T', '--steps', 'demo-two,script', root=author)
        self.assertEqual((code, result['left'], result['problems']), (0, ['later'], []))
        manifest = json.loads((author / 'docs/releases/v1.1.0.json').read_text())
        self.assertEqual([(s['id'], s.get('after')) for s in manifest['steps']], [('demo-two', None), ('script', ['demo-two'])])
        self.assertIn('How `script` works.', (author / 'docs/releases/v1.1.0.md').read_text())
        self.assertEqual(sorted(p.name for p in waiting.iterdir()), ['later.json', 'later.md'])
        self.assertEqual(self.call('validate', root=author)[1]['waiting'], ['later'])

    def test_a_step_for_a_plugin_the_release_does_not_change_is_rejected(self):
        plugin = self.repo.author / 'plugins/demo'
        plugin.mkdir(parents=True)
        (plugin / 'package.json').write_text('{"version": "1.0.0"}')
        (plugin / 'package-lock.json').write_text('{}')
        base = {'component': 'demo', 'kind': 'local-plugin', 'plugin': 'demo', 'apply': None, 'verify': None}
        self.repo.release('v1.0.0', [step('demo', **base)])
        self.repo.release('v1.0.1', [step('demo', **base)])
        (plugin / 'package.json').write_text('{"version": "2.0.0"}')  # changed, but never committed
        self.assertIn('unchanged in HEAD since v1.0.0', self.call('validate', root=self.repo.author)[1])

    def test_accept_marks_a_release_installed_only_when_nothing_has_to_be_applied(self):
        first = self.repo.release('v1.0.0', [step('one')])
        refused = self.call('accept', 'v1.0.0', '--commit', first)[1]
        self.assertEqual((refused['accepted'], 'has to be applied' in refused['reason']), (False, True))
        self.assertFalse((self.repo.root / 'one.done').exists())  # accept never applies
        self.assertIsNone(self.call('status')[1]['installed'])
        (updates.release_tree(self.repo.root, first) / 'one.done').write_text('x')  # already in place by other means
        accepted = self.call('accept', 'v1.0.0', '--commit', first)[1]
        self.assertEqual((accepted['accepted'], accepted['installed']['how'], accepted['steps']), (True, 'auto-accept', ['v1.0.0/one']))
        second = self.repo.release('v1.1.0', [step('cli', where='executors')])
        self.assertIn('executor machines', self.call('accept', 'v1.1.0', '--commit', second)[1]['reason'])
        third = self.repo.release('v1.2.0', [])
        self.assertIn('executor machines', self.call('accept', 'v1.2.0', '--commit', third)[1]['reason'])  # the skipped one still blocks
        self.call('begin', 'v1.2.0', '--commit', third, '--machines', 'host_a')
        self.assertIn('run is open', self.call('accept', 'v1.2.0', '--commit', third)[1]['reason'])
        (self.repo.root / '.gitignore').write_text('local edit\n')
        self.assertEqual(self.call('status')[1]['installed']['release'], 'v1.0.0')

    def test_finish_remembers_the_thread_that_ran_the_update(self):
        sha = self.repo.release('v1.0.0', [step('one')])
        self.call('fetch', 'v1.0.0', '--commit', sha)
        self.call('begin', 'v1.0.0', '--commit', sha)
        self.call('run', 'v1.0.0/one')
        self.call('finish')
        last = self.call('status')[1]['lastRun']
        self.assertEqual((last['owner'], last['release'], last['complete']), ('thr_a', 'v1.0.0', True))


if __name__ == '__main__':
    unittest.main()
