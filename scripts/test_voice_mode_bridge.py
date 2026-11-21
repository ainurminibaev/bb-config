import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import voice_mode_bridge as bridge


class BridgeStateTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.plugin = self.dir / 'plugin'
        self.plugin.mkdir()
        (self.plugin / 'codex_voice.py').write_text('new')
        self.runtime = self.dir / 'runtime'
        mock.patch.object(bridge, 'RUNTIME', self.runtime).start()
        self.addCleanup(mock.patch.stopall)

    def listing(self, version='0.2.6', present=True):
        plugins = [{'id': 'voice-mode', 'version': version, 'rootDir': str(self.plugin)}] if present else []
        mock.patch.dict(os.environ, {'BB_CONFIG_PLUGINS_JSON': json.dumps({'plugins': plugins})}).start()

    def test_absent_plugin_is_nothing_to_do(self):
        self.listing(present=False)
        self.assertEqual(bridge.main(['--check']), 0)

    def test_unused_route_is_nothing_to_do(self):
        self.listing()
        self.assertEqual(bridge.state()[0], 'route-unused')
        self.assertEqual(bridge.main(['--check']), 0)

    def test_stale_copy_fails_check_and_apply_reinstalls(self):
        self.listing()
        self.runtime.mkdir()
        (self.runtime / 'codex_voice.py').write_text('old')
        self.assertEqual(bridge.main(['--check']), 1)

        def install(argv, **_):
            (self.runtime / 'codex_voice.py').write_text(Path(argv[1]).read_text())
        with mock.patch.object(bridge.subprocess, 'run', side_effect=install) as run:
            self.assertEqual(bridge.main(['--apply']), 0)
        self.assertEqual(run.call_args[0][0][-1], '--install')
        self.assertEqual(bridge.state()[0], 'current')

    def test_apply_refuses_before_plugin_update(self):
        self.listing(version='0.2.5')
        self.runtime.mkdir()
        (self.runtime / 'codex_voice.py').write_text('old')
        with mock.patch.object(bridge.subprocess, 'run') as run:
            self.assertEqual(bridge.main(['--apply']), 1)
        run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
