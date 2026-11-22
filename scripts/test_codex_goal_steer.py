import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts/apply_codex_goal_steer.py'
sys.path.insert(0, str(ROOT / 'scripts'))
import apply_codex_goal_steer as patcher  # noqa: E402


def sha256(data):
    return hashlib.sha256(data).hexdigest()


class CodexGoalSteerPatch(unittest.TestCase):
    def setUp(self):
        self.spec = json.loads(patcher.SPEC.read_text())
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name) / 'provider-codex'
        (self.root / 'dist').mkdir(parents=True)

    def provider(self, host):
        (self.root / 'dist/host.js').write_bytes(host)
        (self.root / 'dist/host.meta.json').write_text(
            json.dumps({'pluginId': 'provider-codex', 'artifactDigest': sha256(host)}))

    def run_script(self, *args):
        return subprocess.run(
            [sys.executable, str(SCRIPT), '--root', str(self.root),
             '--backup-dir', str(Path(self.folder.name) / 'backup'), *args],
            capture_output=True, text=True)

    def test_spec_names_one_build_and_a_distinct_result(self):
        self.assertRegex(self.spec['originalSha256'], r'^[0-9a-f]{64}$')
        self.assertRegex(self.spec['patchedSha256'], r'^[0-9a-f]{64}$')
        self.assertNotEqual(self.spec['originalSha256'], self.spec['patchedSha256'])

    def test_insert_goes_right_after_the_single_anchor(self):
        host = ('before;' + self.spec['anchor'] + 'after;').encode()
        fixed = patcher.patched_bytes(self.spec, host).decode()
        self.assertEqual(fixed, 'before;' + self.spec['anchor'] + self.spec['insert'] + 'after;')

    def test_ambiguous_or_missing_anchor_is_refused(self):
        for host in (b'no anchor here', (self.spec['anchor'] * 2).encode()):
            with self.assertRaises(RuntimeError):
                patcher.patched_bytes(self.spec, host)

    def test_another_build_is_reported_and_never_patched(self):
        host = ('x;' + self.spec['anchor'] + 'y;').encode()
        self.provider(host)
        self.assertEqual(self.run_script('--check').returncode, 3)
        self.assertEqual(self.run_script('--applies').returncode, 3)
        applied = self.run_script('--apply')
        self.assertEqual(applied.returncode, 1)
        self.assertIn('Another provider build', applied.stderr)
        self.assertEqual((self.root / 'dist/host.js').read_bytes(), host)

    def test_mismatched_metadata_is_an_error(self):
        self.provider(b'host')
        (self.root / 'dist/host.meta.json').write_text(json.dumps({'artifactDigest': 'stale'}))
        self.assertEqual(self.run_script('--check').returncode, 1)

    def test_restore_without_patch_changes_nothing(self):
        host = b'unrelated build'
        self.provider(host)
        restored = self.run_script('--restore')
        self.assertEqual(restored.returncode, 0)
        self.assertEqual((self.root / 'dist/host.js').read_bytes(), host)


if __name__ == '__main__':
    unittest.main()
