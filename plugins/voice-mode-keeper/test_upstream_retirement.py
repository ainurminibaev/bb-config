"""Exercise the update path with pristine catalog sources and a local edit."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import patch_keeper as keeper
import upstream_retirement as upstream
from test_patch_keeper import ORIGINAL, PATCH
from test_tokenomics_compat import FIXED, SOURCE


class RetirementTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.state = self.root / 'state'
        self.state.mkdir()
        self.addCleanup(mock.patch.stopall)
        mock.patch.object(keeper, 'STATE_DIR', self.state).start()
        mock.patch.dict(upstream.os.environ, {
            'BB_KEEPER_FORCE_RULES': '',
            'BB_KEEPER_NOTICE_THREAD': 'thr_fixture',
        }).start()
        self.fetch = mock.patch.object(upstream, 'upstream_files').start()
        self.tell = mock.patch.object(keeper, 'send_retirement').start()
        self.build = mock.patch.object(keeper, 'run').start()

    def plugin(self, plugin_id, revision, version, files):
        spec = keeper.KEPT[plugin_id]
        repository = spec['source'].removeprefix('git:https://github.com/').removesuffix('.git@')
        path = self.root / repository / revision
        if plugin_id == 'tokenomics':
            path /= 'bb-plugin-tokenomics'
        for name, data in files.items():
            file = path / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(data)
        return {'enabled': True, 'version': version, 'provenance': 'catalog',
                'source': spec['source'] + 'fixture', 'rootDir': str(path)}

    def check_rule(self, plugin_id, plugin):
        return keeper.keep(plugin_id, keeper.KEPT[plugin_id], {plugin_id: plugin})

    def test_local_edit_does_not_retire_rule_but_new_catalog_release_does(self):
        old = self.plugin('tokenomics', 'a' * 40, '0.2.2', {'server.ts': FIXED})
        self.fetch.return_value = {'server.ts': SOURCE}
        self.assertEqual(self.check_rule('tokenomics', old)['state'], 'ready')
        self.assertEqual(self.check_rule('tokenomics', old)['state'], 'ready')
        self.fetch.assert_called_once_with(
            'danielbachhuber/bb-plugins', 'a' * 40, ('bb-plugin-tokenomics',), ['server.ts'],
        )
        self.tell.assert_not_called()

        new = self.plugin('tokenomics', 'b' * 40, '0.2.3', {'server.ts': FIXED})
        self.fetch.return_value = {'server.ts': FIXED}
        self.assertEqual(self.check_rule('tokenomics', new)['state'], 'retired')
        self.assertEqual(self.check_rule('tokenomics', new)['state'], 'retired')
        self.tell.assert_called_once_with(
            'thr_fixture',
            'Сторож: правка Tokenomics ?? null вошла в версию 0.2.3 от автора — правило отключено автоматически.',
        )
        self.assertEqual(json.loads((self.state / 'tokenomics-upstream.json').read_text())['notice'], 'sent')

        with mock.patch.dict(upstream.os.environ, {'BB_KEEPER_FORCE_RULES': 'inbox,tokenomics'}):
            self.assertEqual(self.check_rule('tokenomics', new)['state'], 'ready')
        self.assertEqual(self.check_rule('tokenomics', new)['state'], 'retired')
        self.assertEqual(self.fetch.call_count, 2)
        self.tell.assert_called_once()
        self.build.assert_not_called()

    def test_other_catalog_rule_uses_same_transition(self):
        files = {'app.tsx': b'const slot = "experimental_appOverlay";\n'}
        plugin = self.plugin('inbox', 'c' * 40, '0.3.0', files)
        self.fetch.return_value = files
        self.assertEqual(self.check_rule('inbox', plugin)['state'], 'retired')
        self.assertEqual(self.check_rule('inbox', plugin)['state'], 'retired')
        self.tell.assert_called_once()
        self.build.assert_not_called()

    def test_rule_with_multiple_patches_requires_the_complete_fix(self):
        base = self.root / 'base.patch'
        base.write_text(PATCH)
        overlay = self.root / 'overlay.patch'
        overlay.write_text(PATCH.replace('-);', '-) ?? null;').replace('+) ?? null;', '+) ?? 0;'))
        spec = {'patches': [base], 'overlays': [overlay]}
        partial = ORIGINAL.replace('  samples,\n);', '  samples,\n) ?? null;').encode()
        complete = partial.replace(b') ?? null;', b') ?? 0;')
        self.assertFalse(keeper.upstream_contains_fix(spec, {'server.ts': partial}, '0.3.0'))
        self.assertTrue(keeper.upstream_contains_fix(spec, {'server.ts': complete}, '0.3.0'))

    def test_network_error_does_not_retire_a_locally_fixed_release(self):
        plugin = self.plugin('tokenomics', 'd' * 40, '0.2.2', {'server.ts': FIXED})
        self.fetch.side_effect = OSError('network unavailable')
        self.assertEqual(self.check_rule('tokenomics', plugin)['state'], 'ready')
        self.assertFalse((self.state / 'tokenomics-upstream.json').exists())
        self.tell.assert_not_called()

    def test_ambiguous_delivery_does_not_repeat_the_notification(self):
        plugin = self.plugin('tokenomics', 'e' * 40, '0.2.3', {'server.ts': FIXED})
        self.fetch.return_value = {'server.ts': FIXED}
        self.tell.side_effect = RuntimeError('response lost')
        for _ in range(2):
            self.assertIn('Доставка уведомления не подтверждена.', self.check_rule('tokenomics', plugin)['message'])
        self.tell.assert_called_once()
