import json
from pathlib import Path
import unittest
from unittest import mock

import plugin_retire as retire

ROOT = Path(__file__).resolve().parents[1]


class Retire(unittest.TestCase):
    def test_retired_plugins_are_not_shipped(self):
        ids = {row['id'] for row in json.loads((ROOT / 'config/retired-plugins.json').read_text())}
        shipped = {row['id'] for row in json.loads((ROOT / 'config/plugins.json').read_text())}
        bundle = json.loads((ROOT / 'config/bundle.json').read_text())
        bundled = {row['id'] for row in (bundle.get('components', bundle) if isinstance(bundle, dict) else bundle)
                   if isinstance(row, dict)}
        self.assertFalse(ids & shipped)
        self.assertFalse(ids & bundled)
        self.assertFalse([plugin for plugin in ids if (ROOT / 'plugins' / plugin).exists()])

    def test_unknown_plugin_is_refused(self):
        with self.assertRaises(ValueError):
            retire.retired('machine-tabs')

    def test_apply_removes_only_when_installed(self):
        rows = [{'id': 'demo', 'version': '0.1.0', 'source': 'path:x'}, None]
        with mock.patch.object(retire.source, 'plugin', side_effect=lambda _: rows.pop(0) if rows else None), \
                mock.patch.object(retire.source, 'wait_for_install'), \
                mock.patch.object(retire.source, 'bb') as bb:
            self.assertEqual(retire.apply('demo'), 0)
        bb.assert_called_once_with('plugin', 'remove', 'demo', as_json=False, show=True)
        with mock.patch.object(retire.source, 'plugin', return_value=None), \
                mock.patch.object(retire.source, 'bb') as bb:
            self.assertEqual(retire.apply('demo'), 0)
        bb.assert_not_called()

    def test_kept_until_the_replacement_is_new_enough(self):
        row = {'id': 'demo', 'replacedBy': {'id': 'tabs', 'minVersion': '0.2.16'}}
        def installed(rows):
            return lambda plugin_id: rows.get(plugin_id)
        cases = [({}, False), ({'tabs': {'enabled': True, 'version': '0.2.8'}}, False),
                 ({'tabs': {'enabled': False, 'version': '0.2.21'}}, False),
                 ({'tabs': {'enabled': True, 'version': '0.2.16'}}, True),
                 ({'tabs': {'enabled': True, 'version': '0.10.0'}}, True)]
        for rows, expected in cases:
            with mock.patch.object(retire.source, 'plugin', side_effect=installed(rows)):
                self.assertEqual(retire.replaced(row), expected, rows)


if __name__ == '__main__':
    unittest.main()
