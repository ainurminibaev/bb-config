import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path[:0] = [str(Path(__file__).parent), str(Path(__file__).resolve().parents[2] / 'scripts')]
import fork_watch
import plugin_fork

DATA = {'id': 'demo', 'repository': 'https://example.test/fork.git', 'tagPrefix': 'own/', 'upstream': 'https://example.test/up.git'}
DAY = 24 * 3600


class WatchTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.state = Path(directory.name)
        self.told = []
        self.calls = 0
        self.versions = [(0, 7, 0)]
        patch = mock.patch.object(plugin_fork, 'remote_versions', side_effect=self.remote)
        patch.start()
        self.addCleanup(patch.stop)

    def remote(self, _url, _prefix=''):
        self.calls += 1
        if self.versions is None:
            raise plugin_fork.ForkError('offline')
        return self.versions

    def run_at(self, moment, version='0.7.100', thread='thread'):
        status = {'plugin': 'demo', 'name': 'Demo', 'version': version}
        return fork_watch.watch('demo', DATA, {}, status, self.state, lambda t, m: self.told.append((t, m)), thread, lambda: moment)

    def test_checks_once_a_day(self):
        self.assertEqual(self.run_at(DAY)['state'], 'ready')
        for minutes in range(1, 100):
            self.run_at(DAY + minutes * 600)
        self.assertEqual(self.calls, 1)
        self.run_at(2 * DAY + 1)
        self.assertEqual(self.calls, 2)

    def test_warns_and_tells_the_thread_once_per_version(self):
        self.versions = [(0, 7, 0), (0, 7, 1)]
        for moment in (DAY, DAY + 600, 3 * DAY):
            self.assertEqual(self.run_at(moment)['state'], 'attention')
        self.assertEqual(len(self.told), 1)
        self.assertIn('0.7.1', self.told[0][1])
        self.versions = [(0, 8, 0)]
        self.run_at(5 * DAY)
        self.assertEqual(len(self.told), 2)
        self.assertEqual(self.run_at(5 * DAY + 600, '0.8.100')['state'], 'ready')

    def test_a_failed_check_is_retried_hourly_and_reported_after_three_days(self):
        self.run_at(DAY)
        self.versions = None
        self.assertEqual(self.run_at(2 * DAY + 1)['state'], 'ready')
        self.run_at(2 * DAY + 601)
        self.assertEqual(self.calls, 2)
        self.run_at(2 * DAY + 3700)
        self.assertEqual(self.calls, 3)
        self.assertEqual(self.run_at(5 * DAY)['state'], 'attention')

    def test_a_first_check_that_fails_is_not_taken_for_no_updates(self):
        self.versions = None
        self.assertIn('ещё не проверены', self.run_at(DAY)['message'])

    def test_damaged_state_and_no_thread(self):
        (self.state / 'demo-fork.json').write_text('{')
        self.versions = [(0, 9, 0)]
        self.assertEqual(self.run_at(DAY, thread='')['state'], 'attention')
        self.assertEqual(self.told, [])
        self.assertEqual(json.loads((self.state / 'demo-fork.json').read_text())['newest'], [0, 9, 0])

    def test_only_a_fork_installation_is_watched(self):
        self.assertIsNone(fork_watch.policy_of('kodaforge', {'source': 'git:https://github.com/Kodaks94/bb-plugin-kodaforge.git@x'}))
        self.assertIsNone(fork_watch.policy_of('inbox', {'source': 'git:x@'}))
        self.assertEqual(fork_watch.policy_of('kodaforge', {'source': 'git:https://github.com/ainurminibaev/bb-plugin-kodaforge.git@semver:own/:>=0.7.100 <1.0.0'})['id'], 'kodaforge')


if __name__ == '__main__':
    unittest.main()
