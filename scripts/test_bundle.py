"""Convergence to the declared set (bundle.py) against a fake BB."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import bundle
import updates

GIT = 'git:https://example.org/fork.git@'


class FakeBB:
    """Plugins by id; bb plugin commands change them like the real CLI would."""

    def __init__(self, root, plugins):
        self.root, self.plugins, self.commands = root, {p['id']: p for p in plugins}, []
        self.latest = {'fork': '0.3.0', 'catalog': '1.2.0'}

    def list(self):
        return {k: dict(v) for k, v in self.plugins.items()}

    def run(self, argv, root):
        argv = [str(part) for part in argv]
        self.commands.append(argv)
        name = Path(argv[0]).name
        if name == 'npm' or argv[1:3] == ['plugin', 'build']:
            return 0, ''
        if name == 'bb' and argv[1:3] == ['plugin', 'install']:
            source = argv[3]
            if source.startswith('path:'):
                directory = Path(source[5:])
                version = json.loads((directory / 'package.json').read_text())['version']
                plugin_id = directory.name
            else:
                plugin_id = 'fork' if source.startswith(GIT) else source.split('@')[0]
                version = self.latest[plugin_id]
                source = source if source.startswith('git:') else f'git:https://example.org/{plugin_id}.git@^1'
            old = self.plugins.get(plugin_id, {})
            self.plugins[plugin_id] = {'id': plugin_id, 'version': version, 'source': source, 'rootDir': source[5:],
                                       'enabled': True, 'status': self.status(plugin_id), 'statusDetail': 'Sign in'}
            if old and not old.get('enabled', True):
                self.plugins[plugin_id]['enabled'] = True  # BB enables on reinstall; bundle disables again
            return 0, 'installed'
        if name == 'bb' and argv[1:3] == ['plugin', 'update']:
            plugin = self.plugins[argv[3]]
            if '--range' in argv or '<' not in plugin['source']:
                plugin['version'] = self.latest[argv[3]]
                if '--range' in argv:
                    plugin['source'] = plugin['source'].rpartition('@')[0] + '@' + argv[argv.index('--range') + 1]
            return 0, 'updated'
        if name == 'bb' and argv[1:3] == ['plugin', 'reload']:
            plugin = self.plugins[argv[3]]
            plugin['version'] = json.loads((Path(plugin['rootDir']) / 'package.json').read_text())['version']
            return 0, ''
        if name == 'bb' and argv[1:3] == ['plugin', 'disable']:
            if argv[2] == 'disable':
                self.plugins[argv[3]]['enabled'] = False
                self.plugins[argv[3]]['status'] = 'disabled'
            return 0, ''
        if argv[1:3] == ['hook.py', 'check']:
            return (0, 'ok') if (root / 'hooked').exists() else (1, 'stale')
        if argv[1:3] == ['hook.py', 'apply']:
            (root / 'hooked').write_text('x')
            return 0, 'applied'
        raise AssertionError(f'unexpected command {argv}')

    def status(self, plugin_id):
        return 'needs-configuration' if plugin_id == 'catalog' else 'running'


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        (self.root / 'config').mkdir()
        for plugin_id, version in (('alpha', '1.1.0'), ('beta', '0.2.0')):
            folder = self.root / 'plugins' / plugin_id
            folder.mkdir(parents=True)
            (folder / 'package.json').write_text(json.dumps({'version': version}))
            (folder / 'package-lock.json').write_text('{}')
        self.declared = {'schemaVersion': 1, 'machineActions': [{'id': 'x', 'text': 'run on every machine'}], 'components': [
            {'id': 'catalog', 'kind': 'catalog', 'name': 'Catalog', 'description': 'catalog plugin', 'tested': '1.2.0',
             'repository': 'https://example.org/catalog', 'source': 'git:https://example.org/catalog.git@',
             'install': 'catalog@bb-community', 'min': '1.0.0',
             'attention': [{'type': 'auth', 'text': 'personal sign-in'}]},
            {'id': 'fork', 'kind': 'git', 'name': 'Fork', 'description': 'own fork', 'source': GIT, 'install': GIT + '^0.3.0', 'min': '0.3.0',
             'requires': ['catalog'],
             'configure': [{'name': 'bridge', 'check': ['{python}', 'hook.py', 'check'], 'apply': ['{python}', 'hook.py', 'apply']}]},
            {'id': 'alpha', 'kind': 'local', 'name': 'Alpha', 'description': 'own plugin'},
            {'id': 'beta', 'kind': 'local', 'name': 'Beta', 'description': 'own plugin', 'requires': ['catalog']},
        ], 'repository': 'https://example.org/bb-config'}
        (self.root / 'config/bundle.json').write_text(json.dumps(self.declared))

    def tearDown(self):
        self.directory.cleanup()

    def converge(self, plugins, command='apply'):
        fake = FakeBB(self.root, plugins)
        with patch.object(bundle, 'plugins', fake.list), patch.object(updates, 'installed_plugins', fake.list), \
                patch.object(bundle, 'run', lambda argv, root: fake.run([a.replace('{python}', 'python') for a in argv], root)), \
                patch.object(bundle, 'ensure_project', lambda root: None), patch.object(bundle, 'has_project', lambda root: True):
            result = bundle.apply(self.root) if command == 'apply' else bundle.check(self.root)
        return result, fake

    def local(self, plugin_id, version, enabled=True):
        return {'id': plugin_id, 'version': version, 'source': f'path:{self.root}/plugins/{plugin_id}',
                'rootDir': str(self.root / 'plugins' / plugin_id), 'enabled': enabled,
                'status': 'running' if enabled else 'disabled'}

    def states(self, result):
        return {row['id']: row['state'] for row in result['components']}

    def test_clean_install_delivers_the_whole_set_and_lists_personal_actions(self):
        result, fake = self.converge([])
        self.assertTrue(result['converged'], result['left'])
        self.assertEqual(self.states(result), {'catalog': 'installed', 'fork': 'installed', 'alpha': 'installed', 'beta': 'installed'})
        self.assertEqual(fake.plugins['fork']['version'], '0.3.0')
        self.assertTrue((self.root / 'hooked').exists(), 'configuration hook applied')
        kinds = {(item['component'], item['type']) for item in result['attention']}
        self.assertIn(('catalog', 'needs-configuration'), kinds)
        self.assertIn(('catalog', 'auth'), kinds)
        self.assertIn(('bb-config', 'machine'), kinds)
        self.assertTrue(all(item['new'] for item in result['attention'] if item['component'] == 'catalog'))

    def test_update_installs_missing_and_updates_old_without_touching_disabled_state(self):
        plugins = [self.local('alpha', '1.0.0', enabled=False),
                   {'id': 'fork', 'version': '0.2.5', 'source': GIT + '>=0.2.0 <0.2.6', 'rootDir': '/x',
                    'enabled': True, 'status': 'running'}]
        result, fake = self.converge(plugins)
        self.assertTrue(result['converged'], result['left'])
        self.assertEqual(self.states(result)['alpha'], 'updated')
        self.assertEqual(self.states(result)['fork'], 'updated')
        self.assertEqual(self.states(result)['beta'], 'installed')
        self.assertFalse(fake.plugins['alpha']['enabled'], 'disabled plugin stays disabled')
        self.assertEqual(fake.plugins['fork']['version'], '0.3.0')
        self.assertIn(['plugin', 'update', 'fork', '--range', '^0.3.0', '--yes'], [c[1:] for c in fake.commands])
        self.assertFalse(any(c[1:3] == ['plugin', 'remove'] for c in fake.commands), 'never removes (settings, secrets)')

    def test_exclusions_and_refusals_are_kept(self):
        bundle.write_selection(self.root, {'excluded': {'beta': {'reason': 'not needed'}}})
        journal = updates.state_dir(self.root) / 'journal.json'
        journal.write_text(json.dumps({'entries': [{'step': 'v1.0.0/plugin-alpha', 'machine': 'server', 'status': 'not-applicable',
                                                     'how': 'evidence', 'detail': 'user declined', 'mode': 'release'}]}))
        result, fake = self.converge([])
        self.assertEqual(self.states(result)['beta'], 'excluded')
        self.assertEqual(self.states(result)['alpha'], 'excluded')
        self.assertNotIn('beta', fake.plugins)
        self.assertTrue(result['converged'])
        # Installing a declined component later means the user changed their mind.
        result, _ = self.converge([self.local('alpha', '1.1.0')], 'check')
        self.assertEqual(self.states(result)['alpha'], 'ok')

    def test_foreign_sources_and_newer_builds_are_kept(self):
        plugins = [{'id': 'alpha', 'version': '9.0.0', 'source': 'git:https://example.org/own-alpha.git@^9', 'rootDir': '/own',
                    'enabled': True, 'status': 'running'}]
        result, fake = self.converge(plugins)
        self.assertEqual(self.states(result)['alpha'], 'kept-source')
        self.assertEqual(fake.plugins['alpha']['source'], 'git:https://example.org/own-alpha.git@^9')

    def test_check_reports_without_changing_and_repeat_is_a_no_op(self):
        result, fake = self.converge([], 'check')
        self.assertFalse(result['converged'])
        self.assertFalse(any(c[1:3] == ['plugin', 'install'] for c in fake.commands))
        first, fake = self.converge([])
        again, fake2 = self.converge(list(fake.plugins.values()))
        self.assertTrue(again['converged'])
        self.assertEqual(set(self.states(again).values()), {'ok'})
        self.assertFalse(any(c[1:3] in (['plugin', 'install'], ['plugin', 'update']) for c in fake2.commands))

    def test_failure_is_reported_and_a_rerun_finishes(self):
        fake_fail = {'on': True}
        original = FakeBB.run

        def flaky(self, argv, root):
            if fake_fail['on'] and argv[1:4] == ['plugin', 'install', 'catalog@bb-community']:
                return 1, 'network down'
            return original(self, argv, root)

        with patch.object(FakeBB, 'run', flaky):
            result, fake = self.converge([])
            self.assertFalse(result['converged'])
            self.assertEqual(self.states(result)['catalog'], 'failed')
            self.assertIn('network down', next(r['detail'] for r in result['components'] if r['id'] == 'catalog'))
            fake_fail['on'] = False
            result, _ = self.converge(list(fake.plugins.values()))
        self.assertTrue(result['converged'], result['left'])
        self.assertEqual(self.states(result)['catalog'], 'installed')

    def test_older_declared_set_without_descriptions_still_loads(self):
        for component in self.declared['components']:
            component.pop('description', None)
        (self.root / 'config/bundle.json').write_text(json.dumps(self.declared))
        self.assertEqual(bundle.load(self.root)['components'][0]['description'], 'Catalog')

    def test_plan_lists_new_components_and_choice_is_remembered(self):
        fake = FakeBB(self.root, [self.local('alpha', '1.1.0'),
                                  {'id': 'catalog', 'version': '1.3.0', 'source': 'git:https://example.org/catalog.git@^1',
                                   'rootDir': '/c', 'enabled': True, 'status': 'running'}])
        with patch.object(bundle, 'plugins', fake.list), patch.object(updates, 'installed_plugins', fake.list):
            result = bundle.plan(self.root)
            self.assertEqual(result['new'], ['fork', 'beta'])
            beta = next(item for item in result['components'] if item['id'] == 'beta')
            self.assertEqual(beta['link'], 'https://example.org/bb-config/tree/main/plugins/beta')
            self.assertEqual(result['untested'], [{'component': 'catalog', 'name': 'Catalog', 'installed': '1.3.0',
                                                    'tested': '1.2.0', 'needed': ['Fork', 'Beta']}])
            self.assertEqual(bundle.main(['choose', '--skip', 'beta'], self.root), 0)
            self.assertEqual(bundle.plan(self.root)['excluded'], ['beta'])
            self.assertEqual(bundle.main(['choose', '--take', 'beta'], self.root), 0)
            self.assertEqual(bundle.plan(self.root)['excluded'], [])
            self.assertEqual(bundle.main(['choose', '--skip', 'nope'], self.root), 1)
            _, rows = bundle.assess(self.root)
            texts = [item['text'] for item in bundle.attention(bundle.load(self.root), rows) if item['type'] == 'untested']
            self.assertTrue(texts and 'Beta' in texts[0] and '1.2.0' in texts[0])

    def test_declared_set_of_the_repository_is_valid(self):
        root = Path(__file__).resolve().parents[1]
        data = bundle.load(root)
        ids = [c['id'] for c in data['components']]
        self.assertEqual(len(ids), len(set(ids)))
        raw = json.loads((root / 'config/bundle.json').read_text())
        self.assertEqual([c['id'] for c in raw['components'] if not c.get('description')], [], 'every component has a description')
        local = {p.name for p in (root / 'plugins').iterdir() if (p / 'package.json').is_file()}
        self.assertEqual(local - set(ids), set(), 'every own plugin with package.json is in the declared set')


if __name__ == '__main__':
    unittest.main()
