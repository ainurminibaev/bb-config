"""Regression tests for the Tokenomics source transform with authored fixtures."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import tokenomics_compat

ORIGINAL = b'const result = {\n  sizeTokens: sizeOf(\n    exampleCount,\n  ),\n};\n'
FIXED = ORIGINAL.replace(b'  ),', b'  ) ?? null,')


class TokenomicsCompatibilityTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        recipe = Path(directory.name) / 'upstream.json'
        recipe.write_text(json.dumps({
            'version': '0.2.2',
            'originalSha256': hashlib.sha256(ORIGINAL).hexdigest(),
            'patchedSha256': hashlib.sha256(FIXED).hexdigest(),
        }))
        override = patch.object(tokenomics_compat, 'RECIPE', recipe)
        override.start()
        self.addCleanup(override.stop)

    def test_only_adds_the_fallback_and_can_rerun(self):
        self.assertEqual(tokenomics_compat.rewrite(ORIGINAL, '0.2.2'), FIXED)
        self.assertEqual(tokenomics_compat.rewrite(FIXED, '0.2.2'), FIXED)

    def test_keeps_windows_line_endings(self):
        self.assertEqual(
            tokenomics_compat.rewrite(ORIGINAL.replace(b'\n', b'\r\n'), '0.2.2'),
            FIXED.replace(b'\n', b'\r\n'),
        )

    def test_rejects_missing_and_ambiguous_anchors(self):
        for source in (b'other code', ORIGINAL * 2):
            with self.subTest(source=source), self.assertRaisesRegex(RuntimeError, 'expected one'):
                tokenomics_compat.rewrite(source, '0.2.2')

    def test_rejects_unverified_source_but_accepts_an_existing_fix(self):
        with self.assertRaisesRegex(RuntimeError, 'upstream changed'):
            tokenomics_compat.rewrite(ORIGINAL + b'\n', '0.2.2')
        self.assertEqual(tokenomics_compat.rewrite(FIXED, '0.2.3'), FIXED)


if __name__ == '__main__':
    unittest.main()
