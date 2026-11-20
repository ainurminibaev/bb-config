import json
from pathlib import Path
import tempfile
import unittest

import claude_md_guard as guard


class GuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def event(self, tool, **data):
        return {'tool_name': tool, 'tool_input': data}

    def test_write(self):
        path = str(self.root / 'CLAUDE.md')
        self.assertIsNone(guard.decide(self.event('Write', file_path=path, content='@AGENTS.md\n')))
        self.assertIsNone(guard.decide(self.event('Write', file_path=path, content='@AGENTS.md\n\n@docs/x.md')))
        self.assertIn('AGENTS.md', guard.decide(self.event('Write', file_path=path, content='# Rules\nuse tabs')))
        self.assertIsNone(guard.decide(self.event('Write', file_path=str(self.root / 'AGENTS.md'), content='# Rules')))

    def test_edit_checks_resulting_file(self):
        path = self.root / 'CLAUDE.md'
        path.write_text('# Old rules\n@AGENTS.md\n')
        self.assertIsNone(guard.decide(self.event('Edit', file_path=str(path), old_string='# Old rules\n', new_string='')))
        self.assertIsNotNone(guard.decide(self.event('Edit', file_path=str(path), old_string='@AGENTS.md', new_string='@AGENTS.md\nmore')))
        self.assertIsNone(guard.decide(self.event('MultiEdit', file_path=str(path),
                                                  edits=[{'old_string': '# Old rules', 'new_string': ''}])))

    def test_setup_is_idempotent_and_keeps_other_hooks(self):
        home = self.root / '.claude'
        home.mkdir()
        other = {'matcher': 'Bash', 'hooks': [{'type': 'command', 'command': 'other'}]}
        (home / 'settings.json').write_text(json.dumps({'theme': 'dark', 'hooks': {'PreToolUse': [other]}}))
        self.assertEqual(guard.setup('check', home), 1)
        guard.setup('apply', home)
        guard.setup('apply', home)
        settings = json.loads((home / 'settings.json').read_text())
        self.assertEqual(len(settings['hooks']['PreToolUse']), 2)
        self.assertEqual(settings['theme'], 'dark')
        self.assertTrue((home / 'hooks' / guard.NAME).is_file())
        self.assertEqual(guard.setup('check', home), 0)
        guard.setup('remove', home)
        self.assertEqual(json.loads((home / 'settings.json').read_text())['hooks']['PreToolUse'], [other])


if __name__ == '__main__':
    unittest.main()
