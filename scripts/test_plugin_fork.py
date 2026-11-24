import unittest
from unittest import mock

import plugin_fork as fork

DATA = {'id': 'demo', 'repository': 'https://example.test/fork.git', 'branch': 'own', 'tagPrefix': 'own/', 'range': '>=0.7.100 <1.0.0',
        'upstream': 'https://example.test/up.git', 'upstreamSource': 'git:https://example.test/up.git@', 'catalog': 'demo@catalog',
        'settings': {'separateTabs': True}}


class Versions(unittest.TestCase):
    def test_own_versions_never_look_like_upstream_ones(self):
        self.assertEqual(fork.next_own((0, 7, 0), []), (0, 7, 100))
        self.assertEqual(fork.next_own((0, 7, 0), [(0, 7, 100), (0, 7, 101)]), (0, 7, 102))
        self.assertEqual(fork.next_own((0, 7, 1), [(0, 7, 102)]), (0, 7, 200))
        self.assertEqual(fork.next_own((0, 8, 0), [(0, 7, 200)]), (0, 8, 100))
        self.assertEqual(fork.base_of((0, 7, 205)), (0, 7, 1))
        with self.assertRaises(fork.ForkError):
            fork.base_of((0, 7, 1))
        with self.assertRaises(fork.ForkError):
            fork.next_own((0, 7, 0), [(0, 7, 199)])

    def test_reads_only_stable_tags_with_the_prefix(self):
        listing = '\n'.join(f'x\trefs/tags/{name}' for name in ['v0.7.0', 'own/v0.7.100', 'own/v0.7.2-beta', 'v0.8.0-rc1'])
        with mock.patch.object(fork, 'run', return_value=listing):
            self.assertEqual(fork.remote_versions('u', 'own/'), [(0, 7, 100)])
            self.assertEqual(fork.remote_versions('u'), [(0, 7, 0)])

    def test_sync_without_a_newer_release_changes_nothing(self):
        with mock.patch.object(fork, 'remote_versions', side_effect=[[(0, 7, 101)], [(0, 7, 0)]]), \
                mock.patch.object(fork, 'run') as run:
            self.assertEqual(fork.sync('demo', DATA, True), 0)
            run.assert_not_called()


class Journal(unittest.TestCase):
    def test_path_is_private_state_of_this_checkout(self):
        with fork.tempfile.TemporaryDirectory() as directory, \
                mock.patch.object(fork.source, 'state_dir', side_effect=lambda root: fork.Path(directory)):
            path = fork.journal_path('demo')
            self.assertEqual(path, fork.Path(directory) / 'forks' / 'demo.json')
            self.assertTrue(path.parent.is_dir())


class Move(unittest.TestCase):
    def setUp(self):
        self.row = {'id': 'demo', 'source': DATA['upstreamSource'] + 'x', 'version': '0.7.0', 'enabled': True, 'status': 'running'}
        self.values = {'excluded': 'a', 'separateTabs': False}
        self.saved = {}
        patches = [
            mock.patch.object(fork.source, 'plugin', side_effect=lambda _: self.row),
            mock.patch.object(fork.source, 'settings', side_effect=lambda _: dict(self.values)),
            mock.patch.object(fork.source, 'bb', side_effect=self.bb),
            mock.patch.object(fork.source, 'save', side_effect=lambda path, record: self.saved.update(record)),
            mock.patch.object(fork, 'secrets_set', return_value=False),
            mock.patch.object(fork, 'remote_versions', return_value=[(0, 7, 100)]),
            mock.patch.object(fork, 'install', side_effect=self.install),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        journal = mock.patch.object(fork, 'journal_path').start()
        self.addCleanup(mock.patch.stopall)
        journal.return_value.exists.return_value = True
        journal.return_value.read_text.side_effect = lambda **_: fork.json.dumps(self.saved)
        self.fail_fork = False

    def bb(self, *args, **_):
        if args[:2] == ('plugin', 'config') and args[3] == 'set':
            value = args[5]
            self.values[args[4]] = {'true': True, 'false': False}.get(value, value)
        return {'jobs': []}

    def install(self, _id, desired, _previous, *options):
        # Removing a plugin drops its settings.
        self.values = {'excluded': 'default', 'separateTabs': False}
        fork_source = desired.startswith('git:' + DATA['repository'])
        self.options = options
        self.row = {**self.row, 'source': desired if fork_source else DATA['upstreamSource'] + 'x',
                    'status': 'error' if fork_source and self.fail_fork else 'running'}

    def test_keeps_settings_and_adds_the_fork_ones(self):
        self.assertEqual(fork.apply('demo', DATA), 0)
        self.assertEqual(self.values, {'excluded': 'a', 'separateTabs': True})
        self.assertEqual(self.options, ('--tag-prefix', 'own/'))
        self.assertEqual(self.saved['values'], {'excluded': 'a', 'separateTabs': False})

    def test_a_failed_move_returns_to_the_catalog_with_the_settings(self):
        self.fail_fork = True
        with self.assertRaises(fork.ForkError):
            fork.apply('demo', DATA)
        self.assertTrue(self.row['source'].startswith(DATA['upstreamSource']))
        self.assertEqual(self.values['excluded'], 'a')

    def test_refuses_unknown_sources_and_secrets(self):
        self.row = {**self.row, 'source': 'path:/somewhere'}
        with self.assertRaises(fork.ForkError):
            fork.apply('demo', DATA)
        self.row = {**self.row, 'source': DATA['upstreamSource'] + 'x'}
        fork.secrets_set.return_value = True
        with self.assertRaises(fork.ForkError):
            fork.apply('demo', DATA)
        self.assertEqual(self.values['excluded'], 'a')


if __name__ == '__main__':
    unittest.main()
