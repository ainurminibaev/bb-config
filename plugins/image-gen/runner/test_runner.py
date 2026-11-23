"""Isolated tests of imagegen_runner.py with a fake Codex. No real generation, no network."""
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUNNER = HERE / "imagegen_runner.py"
FAKE = HERE / "fake_codex.py"


class RunnerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.job = self.tmp / "job"
        self.job.mkdir()
        self.home = self.tmp / "codex-home"
        self.calls = self.tmp / "calls.txt"
        (self.job / "request.json").write_text(json.dumps({"jobId": "img_test", "prompt": "a blue circle", "count": 1}))

    def run_runner(self, mode="ok", *extra):
        env = {**os.environ, "CODEX_HOME": str(self.home), "FAKE_CODEX_MODE": mode, "FAKE_CODEX_CALLS": str(self.calls)}
        return subprocess.run([sys.executable, "-I", str(RUNNER), "--job-dir", str(self.job),
                               "--codex", str(FAKE), "--timeout", "20", *extra],
                              env=env, capture_output=True, text=True, timeout=60)

    def result(self):
        return json.loads((self.job / "result.json").read_text())

    def ncalls(self):
        return len(self.calls.read_text().splitlines()) if self.calls.exists() else 0

    def test_completed_collects_verified_copy_and_cleans_original(self):
        p = self.run_runner("ok")
        self.assertEqual(p.returncode, 0, p.stderr)
        r = self.result()
        self.assertEqual(r["status"], "completed")
        self.assertEqual(len(r["images"]), 1)
        self.assertTrue(Path(r["images"][0]["path"]).is_file())
        self.assertEqual(r["provenance"]["jobId"], "img_test")
        self.assertEqual(list((self.home / "generated_images").iterdir()), [])

    def test_second_run_never_calls_codex_again(self):
        self.run_runner("ok")
        p = self.run_runner("ok")
        self.assertEqual(p.returncode, 0)
        self.assertEqual(self.ncalls(), 1)

    def test_crash_after_image_is_recovered_without_regeneration(self):
        p = self.run_runner("crash_after_image")
        self.assertEqual(p.returncode, 0, p.stderr)  # images exist -> collected despite crash
        self.assertEqual(self.result()["status"], "completed")
        self.assertEqual(self.ncalls(), 1)

    def test_unknown_outcome_is_not_retried_automatically(self):
        # Simulate a runner killed after Codex started: attempt.json without result.json.
        (self.job / "attempt.json").write_text(json.dumps({"startedAt": 1, "codexThreadId": "0000aaaa-dead"}))
        p = self.run_runner("ok")
        self.assertEqual(p.returncode, 3)
        self.assertEqual(self.result()["status"], "unknown")
        self.assertEqual(self.ncalls(), 0)
        p = self.run_runner("ok", "--allow-rerun")  # explicit user retry
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(self.ncalls(), 1)

    def test_lost_runner_recovers_images_from_codex_home(self):
        tid = "11112222-3333-4444-5555-666677778888"
        folder = self.home / "generated_images" / tid
        folder.mkdir(parents=True)
        (folder / "exec-x.png").write_bytes(b"\x89PNG\r\n\x1a\nfake")
        (self.job / "attempt.json").write_text(json.dumps({"startedAt": 1, "codexThreadId": tid}))
        p = self.run_runner("ok")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertTrue(self.result()["provenance"]["recovered"])
        self.assertEqual(self.ncalls(), 0)

    def test_limit_is_classified_with_reset_hint(self):
        p = self.run_runner("limit")
        self.assertEqual(p.returncode, 75)
        r = self.result()
        self.assertEqual(r["status"], "limited")
        self.assertIn("6:40 PM", r["resetHint"])

    def test_auth_failure(self):
        self.assertEqual(self.run_runner("auth").returncode, 77)
        self.assertEqual(self.result()["status"], "auth")

    def test_lease_loss_fences_attempt(self):
        lease = self.job / ".lease.json"
        lease.write_text(json.dumps({"token": "t", "expiresAt": int(time.time() * 1000) + 3000}))
        p = self.run_runner("hang", "--lease-file", str(lease), "--lease-token", "t")
        self.assertEqual(p.returncode, 4, p.stderr)
        self.assertEqual(self.result()["status"], "fenced")

    def test_references_are_attached_and_missing_reference_fails_fast(self):
        ref = self.tmp / "ref.png"
        ref.write_bytes(b"\x89PNG\r\n\x1a\n")
        (self.job / "request.json").write_text(json.dumps({"prompt": "x", "references": [str(ref)]}))
        self.run_runner("ok")
        argv = json.loads(self.calls.read_text().splitlines()[0])
        self.assertIn("-i", argv)
        self.assertIn(str(ref), argv)
        self.assertEqual(argv[-2], "--", "prompt must follow `--`, otherwise codex -i swallows it")
        job2 = self.tmp / "job2"
        job2.mkdir()
        (job2 / "request.json").write_text(json.dumps({"prompt": "x", "references": ["/nope.png"]}))
        self.job = job2
        self.assertEqual(self.run_runner("ok").returncode, 2)
        self.assertEqual(self.ncalls(), 1)


if __name__ == "__main__":
    unittest.main()
