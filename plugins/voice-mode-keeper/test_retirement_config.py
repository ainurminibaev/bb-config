"""Verify automatic retirement commits against disposable Git repositories."""
import json
from pathlib import Path
import tempfile
import unittest

from retirement_config import DOCS, END, GIT_ID, RULES, START, git, save_retirement


REVISION = 'a' * 40


class SaveRetirementTests(unittest.TestCase):
    def setUp(self):
        work = tempfile.TemporaryDirectory()
        self.addCleanup(work.cleanup)
        self.repo = Path(work.name)
        self.state = self.repo / '.local/plugin-patches/kept'
        self.state.mkdir(parents=True)
        self.snapshot_log = self.repo / '.local/snapshots'
        self.write('.gitignore', '.local/\n')
        self.write(RULES, '{}\n')
        self.write(DOCS, '# Customizations\n\n' + START + 'Empty.\n' + END + '\n')
        self.write('unrelated.txt', 'initial\n')
        self.write('scripts/privacy_check.py', 'import sys\nassert sys.argv[1:] == ["--staged"]\n')
        self.write('scripts/snapshot.py', """import sys
from pathlib import Path
with Path('.local/snapshots').open('a') as log:
    log.write(sys.argv[1] + '\\n')
""")
        git(self.repo, 'init', '-q', '-b', 'main')
        git(self.repo, 'add', '.')
        git(self.repo, *GIT_ID, 'commit', '-m', 'Fixture')
        self.head = git(self.repo, 'rev-parse', 'HEAD')
        self.patch = self.state / 'tokenomics-retirement.patch'

    def write(self, name, text):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')

    def save(self):
        return save_retirement(self.repo, self.state, 'tokenomics', 'Tokenomics', '0.2.3', REVISION)

    def test_commits_only_retirement_and_runs_both_snapshots(self):
        self.write('unrelated.txt', 'staged changes\n')
        git(self.repo, 'add', 'unrelated.txt')
        unrelated_index = git(self.repo, 'diff', '--cached')
        self.write('unrelated.txt', 'keep my unstaged changes too\n')
        result = self.save()
        self.assertIn('bb-config обновлён', result)
        self.assertIn('ждёт отправки', result)
        self.assertEqual(self.snapshot_log.read_text(), '--settings-only\n--check\n')
        actual = json.loads((self.repo / RULES).read_text())['tokenomics']
        self.assertEqual(actual, {'name': 'Tokenomics', 'status': 'retired', 'upstreamVersion': '0.2.3',
                                  'upstreamRevision': REVISION})
        self.assertIn('Выключено, вошло в апстрим версии 0.2.3', (self.repo / DOCS).read_text())
        self.assertEqual(set(git(self.repo, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD')
                             .decode().splitlines()), {RULES, DOCS})
        self.assertEqual(git(self.repo, 'status', '--porcelain'), b'MM unrelated.txt\n')
        self.assertEqual(git(self.repo, 'diff', '--cached'), unrelated_index)
        self.assertEqual((self.repo / 'unrelated.txt').read_text(), 'keep my unstaged changes too\n')
        self.assertFalse(self.patch.exists())
        head = git(self.repo, 'rev-parse', 'HEAD')
        self.assertIn('уже сохранена', self.save())
        self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), head)

    def test_dirty_target_keeps_staged_and_unstaged_edits_and_prepares_patch(self):
        self.write(RULES, '{"user":"staged"}\n')
        git(self.repo, 'add', RULES)
        self.write(DOCS, 'User edit outside the index.\n')
        original_index = git(self.repo, 'diff', '--cached')
        self.assertIn('автокоммит отложен', self.save())
        self.assertEqual(self.snapshot_log.read_text(), '--settings-only\n--check\n')
        self.assertEqual((self.repo / DOCS).read_text(), 'User edit outside the index.\n')
        self.assertEqual(git(self.repo, 'diff', '--cached'), original_index)
        self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), self.head)
        self.assertTrue(self.patch.is_file())
        git(self.repo, 'restore', '--source=HEAD', '--staged', '--worktree', '--', RULES, DOCS)
        git(self.repo, 'apply', '--check', str(self.patch))

    def test_failed_snapshot_leaves_prepared_patch(self):
        self.write('scripts/snapshot.py', """import sys
sys.exit(sys.argv[1] == '--check')
""")
        self.assertIn('Снимок bb-config не прошёл проверку', self.save())
        self.assertTrue(self.patch.is_file())
        self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), self.head)
