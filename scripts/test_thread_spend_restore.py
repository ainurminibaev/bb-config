"""Checks migration from old public and private plugin lists."""
import contextlib
import io
import json
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import restore
import switch_thread_spend
from export_thread_spend_history import normalize

NEW = {'id': 'thread-spend', 'enabled': True, 'source': 'path:plugins/thread-spend'}
OLD = {'id': 'tokenomics', 'enabled': True, 'source': 'git:https://example.test/old'}


class RestoreTests(unittest.TestCase):
    def setUp(self):
        for dependency in ('check_rpc', 'check_archive', 'save_snapshot'):
            mocked = patch.object(switch_thread_spend, dependency)
            mocked.start()
            self.addCleanup(mocked.stop)
        fixture = tempfile.TemporaryDirectory()
        self.addCleanup(fixture.cleanup)
        self.root = Path(fixture.name)
        for path in ('config/plugins', '.local/config/plugins', 'plugins/thread-spend'):
            (self.root / path).mkdir(parents=True)
        (self.root / 'config/plugins.json').write_text(json.dumps([NEW]))
        (self.root / 'config/appearance.json').write_text('{"customCss": ""}')
        (self.root / 'plugins/thread-spend/package.json').write_text('{}')

    def write_legacy(self, old):
        (self.root / '.local/config/plugins.json').write_text(json.dumps([old]))
        (self.root / '.local/config/plugins/tokenomics.json').write_text('{"marker": "ignored"}')

    def test_migrates_legacy_snapshot_after_starting_replacement(self):
        self.write_legacy(OLD)
        commands = restore.plan(True, self.root, {'tokenomics'})
        enable = ['bb', 'plugin', 'enable', 'thread-spend']
        switch = [sys.executable, str(self.root / 'scripts/switch_thread_spend.py'), '--apply']
        self.assertIn(['bb', 'plugin', 'install', f'path:{self.root}/plugins/thread-spend', '--yes'], commands)
        self.assertLess(commands.index(enable), commands.index(switch))
        self.assertTrue(all('tokenomics' not in command and 'ignored' not in command for command in commands))

    def test_fresh_restore_needs_no_legacy_switch(self):
        commands = restore.plan(True, self.root, set())
        self.assertIn(['bb', 'plugin', 'enable', 'thread-spend'], commands)
        self.assertFalse(any('switch_thread_spend.py' in ' '.join(c) for c in commands))

    def test_retains_user_opt_out(self):
        self.write_legacy({**OLD, 'enabled': False})
        commands = restore.plan(True, self.root, {'tokenomics'})
        self.assertIn(['bb', 'plugin', 'disable', 'thread-spend'], commands)
        self.assertFalse(any('switch_thread_spend.py' in ' '.join(c) for c in commands))

    @patch.object(switch_thread_spend.subprocess, 'run')
    @patch.object(switch_thread_spend, 'plugin_states', return_value={'tokenomics': {'enabled': True}})
    def test_switch_does_not_disable_legacy_if_replacement_missing(self, states, run):
        with self.assertRaisesRegex(RuntimeError, 'Thread Spend is not running'):
            switch_thread_spend.switch(apply=True)
        run.assert_not_called()

    @patch.object(switch_thread_spend.subprocess, 'run')
    @patch.object(switch_thread_spend, 'plugin_states', side_effect=[
        {'thread-spend': {'enabled': True, 'status': 'running'}, 'tokenomics': {'enabled': True}},
        {'thread-spend': {'enabled': True, 'status': 'running'}, 'tokenomics': {'enabled': False}},
    ])
    def test_switch_checks_after_disabling(self, states, run):
        with contextlib.redirect_stdout(io.StringIO()):
            switch_thread_spend.switch(apply=True)
        run.assert_called_once_with(['bb', 'plugin', 'disable', 'tokenomics'], check=True)
        self.assertEqual(states.call_count, 2)

    @patch.object(switch_thread_spend.subprocess, 'run')
    @patch.object(switch_thread_spend, 'plugin_states', side_effect=[
        {'thread-spend': {'enabled': True, 'status': 'running'}, 'tokenomics': {'enabled': True}},
        {'thread-spend': {'enabled': True, 'status': 'error'}, 'tokenomics': {'enabled': False}},
    ])
    def test_failed_post_switch_check_reenables_old_plugin(self, states, run):
        with self.assertRaisesRegex(RuntimeError, 'Tokenomics was re-enabled'):
            switch_thread_spend.switch(apply=True)
        self.assertEqual([call.args[0] for call in run.call_args_list], [
            ['bb', 'plugin', 'disable', 'tokenomics'],
            ['bb', 'plugin', 'enable', 'tokenomics'],
        ])

    def test_export_preserves_counts_and_drops_raw_command_details(self):
        original = {'threadId': 'example', 'title': 'Example', 'provider': 'codex',
                    'turns': 1, 'tokens': {'input': 1, 'cacheRead': 2, 'output': 4, 'total': 7},
                    'slowestCommands': [{'command': 'example command'}]}
        saved = normalize(original)
        self.assertEqual(saved['total'], 7)
        self.assertEqual(saved['cacheRead'], 2)
        self.assertIsNone(saved['processingMs'])
        self.assertNotIn('slowestCommands', saved)


if __name__ == '__main__':
    unittest.main()
