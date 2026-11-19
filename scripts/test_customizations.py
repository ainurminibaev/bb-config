import contextlib
import copy
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import restore
import setup_tracking
import snapshot


class SnapshotTests(unittest.TestCase):
    def test_secret_fields_are_excluded_even_when_they_have_values(self):
        self.assertEqual(snapshot.public_settings({
            'schema': {'telegramBotToken': {'secret': True}, 'toastEnabled': {'type': 'boolean'}},
            'values': {'telegramBotToken': 'must-not-export', 'toastEnabled': True, 'unknown': 'private'},
        }), {'toastEnabled': True})

    def test_manifest_records_catalog_identity_and_portable_local_path(self):
        self.assertEqual(snapshot.plugin_record({
            'id': 'inbox', 'name': 'Needs You', 'version': '0.2.1', 'enabled': True,
            'source': 'git:https://example.org/inbox@semver:^0.2.0',
            'catalogEntryId': 'inbox', 'catalogMarketplaceName': 'bb-community',
        })['installSource'], 'inbox@bb-community')
        self.assertEqual(snapshot.plugin_record({
            'id': 'mine', 'version': '1', 'enabled': True, 'source': 'path:/root/private/mine',
        })['source'], 'path:plugins/mine')

    def test_drift_check_does_not_write_and_detects_removed_plugin_config(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old = root / '.local/config/plugins/removed.json'
            old.parent.mkdir(parents=True)
            old.write_text('{}')
            expected = {'plugins': [], 'plugins/inbox': {'toastEnabled': True}}
            before = {p: p.read_bytes() for p in root.rglob('*.json')}
            self.assertEqual(len(snapshot.changed_files(expected, root)), 3)
            self.assertEqual({p: p.read_bytes() for p in root.rglob('*.json')}, before)
            snapshot.write_snapshot(expected, root)
            self.assertFalse(old.exists())
            self.assertEqual(snapshot.changed_files(expected, root), [])
    def test_snapshot_keeps_public_defaults_untouched(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            public = root / 'config/general.json'
            public.parent.mkdir()
            public.write_text('{"shared": true}')
            snapshot.write_snapshot({'general': {'private': 'installation value'}}, root)
            self.assertEqual(public.read_text(), '{"shared": true}')
            private = root / '.local/config/general.json'
            self.assertEqual(json.loads(private.read_text()), {'private': 'installation value'})
            if os.name != 'nt':  # NTFS has no POSIX mode bits; access follows the folder ACL
                self.assertEqual(private.stat().st_mode & 0o777, 0o600)

    def test_failed_read_never_starts_writes_or_source_copy(self):
        with patch.object(snapshot, 'collect', side_effect=RuntimeError('unavailable')), \
                patch.object(snapshot, 'write_snapshot') as write, \
                patch.object(snapshot, 'copy_sources') as copy_sources, \
                patch('sys.argv', ['snapshot.py']), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(snapshot.main(), 2)
            write.assert_not_called()
            copy_sources.assert_not_called()

    def test_full_snapshot_keeps_development_sources_when_a_release_is_running(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            checkout = root / '.local/updates/releases' / ('a' * 40)
            (checkout / '.git').mkdir(parents=True)
            (checkout / '.git/bb-config-installation.json').write_text(json.dumps({'root': str(root)}))
            installed = checkout / 'plugins/demo'
            installed.mkdir(parents=True)
            (installed / 'index.ts').write_text('stable release')
            working = root / 'plugins/demo'
            working.mkdir(parents=True)
            (working / 'index.ts').write_text('committed development')
            with patch.object(snapshot, 'ROOT', root):
                snapshot.copy_sources([{'id': 'demo', 'source': 'path:' + str(installed), 'rootDir': str(installed)}])
            self.assertEqual((working / 'index.ts').read_text(), 'committed development')


class RestoreTests(unittest.TestCase):
    def test_voice_patch_settings_wait_until_the_patch_is_installed(self):
        original = restore.read

        def read(name, root=restore.ROOT):
            if name == 'plugins/voice-mode':
                return {'connection': 'plugin', 'voice': 'marin', 'vadThreshold': 0.7,
                        'silenceDurationMs': 900, 'noiseReduction': 'far_field'}
            return original(name, root)

        with patch.object(restore, 'read', side_effect=read):
            commands = restore.plan()
        voice = [c for c in commands if c[:4] == ['bb', 'plugin', 'config', 'voice-mode']]
        self.assertTrue(any(c[5] == 'connection' for c in voice))
        self.assertFalse(any(c[5] in restore.MANUAL_PLUGIN_KEYS['voice-mode'] for c in voice))

    def test_private_dictionary_overrides_defaults_and_lists_replace(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ('config', '.local/config'):
                (root / name).mkdir(parents=True)
            (root / 'config/general.json').write_text('{"a":1,"b":2}')
            (root / '.local/config/general.json').write_text('{"b":3,"c":4}')
            self.assertEqual(restore.read('general', root), {'a': 1, 'b': 3, 'c': 4})
            (root / 'config/plugins.json').write_text('[1,2]')
            (root / '.local/config/plugins.json').write_text('[]')
            self.assertEqual(restore.read('plugins', root), [])
            (root / '.local/config/only-private.json').write_text('{"x":1}')
            self.assertEqual(restore.read('only-private', root), {'x': 1})
    def test_plan_installs_named_catalog_entries_and_keeps_routes_manual(self):
        commands = restore.plan(True)
        self.assertIn(['bb', 'plugin', 'install', 'inbox@bb-community', '--yes'], commands)
        self.assertIn(['bb', 'plugin', 'install', 'handoff@bb-community', '--yes'], commands)
        self.assertIn(['bb', 'plugin', 'install', 'path:' + str(restore.ROOT / 'plugins/handoff-button'), '--yes'], commands)
        for command in commands:
            self.assertNotEqual(command[:2], ['bb', 'proxy-manager'])
            if command[:3] == ['bb', 'plugin', 'config']:
                self.assertNotIn(command[3], restore.MANUAL_SETTINGS)
            if command[:3] in (['bb', 'plugin', 'enable'], ['bb', 'plugin', 'disable']):
                self.assertNotIn(command[3], restore.MANUAL_STATES)
        self.assertTrue(any(c[:3] == ['bb', 'plugin', 'disable'] for c in commands))

    def test_saved_strings_remain_single_arguments(self):
        original = restore.read
        dangerous_text = 'literal $(touch /tmp/not-executed); `id`\nsecond line'
        def read(name, root=restore.ROOT):
            data = copy.deepcopy(original(name, root))
            if name == 'general':
                data['managedBranchPrefix'] = dangerous_text
            return data
        with patch.object(restore, 'read', side_effect=read):
            commands = restore.plan()
        self.assertIn(['bb', 'settings', 'general', 'managedBranchPrefix', dangerous_text], commands)

    def test_voice_fork_survives_stale_catalog_metadata(self):
        policy = json.loads((restore.ROOT / 'plugins/voice-mode/fork.json').read_text())
        target = 'git:' + policy['repository'] + '@' + policy['range']
        public = json.loads((restore.ROOT / 'config/plugins.json').read_text())
        voice = next(p for p in public if p['id'] == 'voice-mode')
        self.assertEqual(restore.install_source(voice), target)
        stale = dict(voice, installSource='voice-mode@bb-community')
        self.assertEqual(restore.install_source(stale), target)
        metadata = dict(voice, catalogEntryId='voice-mode', catalogMarketplaceName='bb-community')
        self.assertNotIn('installSource', snapshot.plugin_record(metadata))
        metadata['source'] = 'git:https://example.org/upstream.git@^1.0'
        self.assertEqual(snapshot.plugin_record(metadata)['installSource'], stale['installSource'])

    def test_internal_semver_source_is_converted_for_cli(self):
        self.assertEqual(restore.install_source({'source': 'git:https://example.org/p.git@semver:^1.0'}),
                         'git:https://example.org/p.git@^1.0')

    def test_builtin_catalog_metadata_does_not_trigger_reinstall(self):
        self.assertEqual(restore.install_source({
            'source': 'builtin:browser-automation', 'installSource': 'browser-automation@bb-official',
        }), 'builtin:browser-automation')
        self.assertFalse(any(c[:3] == ['bb', 'plugin', 'install'] and 'browser-automation' in c[3]
                             for c in restore.plan(True)))

    def test_local_source_takes_precedence_over_old_catalog_metadata(self):
        self.assertEqual(restore.install_source({
            'source': 'path:plugins/handoff-button', 'installSource': 'handoff@bb-community',
        }), 'path:plugins/handoff-button')


class InstructionTests(unittest.TestCase):
    def test_rule_update_is_idempotent_and_preserves_other_instructions(self):
        rule = '[bb-config tracking]\nremember\n[/bb-config tracking]'
        merged = setup_tracking.merge_instructions('other private rules', rule)
        self.assertEqual(setup_tracking.merge_instructions(merged, rule), merged)
        newer = rule.replace('remember', 'remember again')
        self.assertEqual(setup_tracking.merge_instructions(merged, newer),
                         'other private rules\n\n' + newer)

    @unittest.skipIf(os.name == 'nt', 'Git for Windows checks the symlink out as a text file without Developer Mode')
    def test_bb_and_native_providers_share_one_instruction_source(self):
        root = Path(__file__).resolve().parents[1]
        self.assertTrue((root / '.bb/AGENTS.md').is_symlink())
        self.assertEqual((root / '.bb/AGENTS.md').resolve(), root / 'AGENTS.md')
        self.assertEqual((root / 'CLAUDE.md').read_text().strip(), '@AGENTS.md')


if __name__ == '__main__':
    unittest.main()
