import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import plugin_git_source as migration


class GitSourceTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        self.plugin_id = 'subthread-autocollapse'
        release = root / 'releases' / ('a' * 40)
        marker = release / '.git' / 'bb-config-installation.json'
        marker.parent.mkdir(parents=True)
        marker.write_text(json.dumps({'root': str(root)}), encoding='utf-8')
        self.directory = release / 'plugins' / self.plugin_id
        self.directory.mkdir(parents=True)
        (self.directory / 'package.json').write_text('{"version":"0.1.0"}', encoding='utf-8')
        self.path = f'path:{self.directory}'
        self.target = migration.target('0.1.0')
        self.git = f'{migration.REPOSITORY}@semver:{self.plugin_id}/:^0.1.0'
        self.journal = root / 'migration.json'
        self.source = self.path
        self.version = '0.1.0'
        self.defaults = {'enabled': True, 'minutes': 5}
        self.initial = {'enabled': False, 'minutes': 37}
        self.values = self.initial.copy()
        self.schema = {'enabled': {'type': 'boolean'}, 'minutes': {'type': 'number'}}
        self.allow_replace = False
        self.abort_install = False
        self.commands = []
        self.output = io.StringIO()
        self.enterContext(contextlib.redirect_stdout(self.output))
        # The fake mirrors the BB list/source/config contracts and its refusal to
        # replace an install registered to another source.
        fake = patch.object(migration, 'bb', side_effect=self.bb)
        self.addCleanup(fake.stop)
        fake.start()

    def bb(self, group, command, *args, **options):
        self.assertEqual(group, 'plugin')
        self.commands.append((command, *args))
        if command == 'list':
            rows = [{'id': self.plugin_id, 'source': self.source, 'rootDir': str(self.directory),
                     'version': self.version, 'status': 'running'}] if self.source else []
            return {'plugins': rows}
        if command == 'source':
            return {'requested': self.git, 'range': '^0.1.0', 'tagPrefix': f'{self.plugin_id}/',
                    'subdirectory': f'plugins/{self.plugin_id}'}
        if command == 'config':
            if len(args) > 1:
                self.assertEqual(args[1], 'set')
                self.values[args[2]] = json.loads(args[3])
            return {'ok': True, 'values': self.values.copy(), 'schema': self.schema}
        if command == 'install-jobs':
            return {'jobs': []}
        if command == 'remove':
            self.assertEqual(args, (self.plugin_id,))
            self.source = None
            self.values = self.defaults.copy()
            return
        if command == 'install':
            if self.source and not self.allow_replace:
                raise migration.SourceConflict('source conflict')
            if self.abort_install and args[0] == self.target:
                raise migration.MigrationError('git build failed')
            self.source = self.git if args[0] == self.target else self.path
            self.version = '0.1.0'
            return
        self.fail(f'Unexpected BB command {command}')

    def record(self):
        return migration.read(self.journal, self.plugin_id)

    def apply(self, allow_remove=False):
        migration.apply(self.plugin_id, self.journal, self.record(), allow_remove)

    def test_conflict_without_consent_leaves_path_and_settings(self):
        with self.assertRaises(migration.SourceConflict):
            self.apply()
        self.assertEqual((self.source, self.values), (self.path, self.initial))
        self.assertEqual(self.record()['phase'], 'rolled-back')
        self.assertNotIn(('remove', self.plugin_id), self.commands)

    def test_removal_preserves_non_default_settings_and_retry_is_read_only(self):
        self.assertEqual(migration.check(self.plugin_id, self.journal), 1)
        self.apply(allow_remove=True)
        self.assertEqual((self.source, self.values), (self.git, self.initial))
        self.assertEqual(self.record()['phase'], 'migrated')
        self.assertIn(('remove', self.plugin_id), self.commands)
        self.commands.clear()
        self.apply(allow_remove=True)
        self.assertTrue(all(command[0] in {'list', 'source', 'config'} and len(command) < 3
                            for command in self.commands))
        self.assertEqual(migration.check(self.plugin_id, self.journal), 0)

    def test_retry_after_removal_uses_original_journal(self):
        with self.assertRaises(migration.SourceConflict):
            self.apply()
        original = self.record()
        original['phase'] = 'applying'
        migration.save(self.journal, original)
        self.bb('plugin', 'remove', self.plugin_id)
        self.assertEqual(migration.check(self.plugin_id, self.journal, applicable=True), 0)
        self.apply(allow_remove=True)
        self.assertEqual((self.source, self.values), (self.git, self.initial))

    def test_retry_after_install_finishes_settings_without_reinstall(self):
        self.apply(allow_remove=True)
        original = self.record()
        original['phase'] = 'applying'
        migration.save(self.journal, original)
        self.values = self.defaults.copy()
        self.commands.clear()
        self.apply(allow_remove=True)
        self.assertEqual(self.values, self.initial)
        self.assertNotIn('install', [command[0] for command in self.commands])

    def test_failed_git_build_restores_path_and_settings(self):
        self.abort_install = True
        with self.assertRaisesRegex(migration.MigrationError, 'git build failed'):
            self.apply(allow_remove=True)
        self.assertEqual((self.source, self.values), (self.path, self.initial))
        self.assertEqual(self.record()['phase'], 'rolled-back')

    def test_rollback_from_the_updated_git_version(self):
        self.apply(allow_remove=True)
        self.version = '0.1.1'
        migration.rollback(self.plugin_id, self.journal, self.record(), allow_remove=True)
        self.assertEqual((self.source, self.version, self.values), (self.path, '0.1.0', self.initial))
        self.assertEqual(self.record()['phase'], 'rolled-back')

    def test_secret_schema_stops_before_writing_journal(self):
        self.schema['secret'] = {'type': 'string', 'secret': True}
        with self.assertRaisesRegex(migration.MigrationError, 'Unsupported setting'):
            self.apply(allow_remove=True)
        self.assertIsNone(self.record())
        self.assertNotIn('install', [command[0] for command in self.commands])

    def test_missing_original_files_prevent_removal_on_rollback(self):
        self.apply(allow_remove=True)
        (self.directory / 'package.json').unlink()
        self.commands.clear()
        with self.assertRaises(FileNotFoundError):
            migration.rollback(self.plugin_id, self.journal, self.record(), allow_remove=True)
        self.assertEqual(self.source, self.git)
        self.assertNotIn(('remove', self.plugin_id), self.commands)


if __name__ == '__main__':
    unittest.main()
