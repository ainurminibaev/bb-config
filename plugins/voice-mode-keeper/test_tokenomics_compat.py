"""Exercise a fresh installation, a moved anchor, and an unsupported release."""
import unittest

from tokenomics_compat import AnchorMismatch, rewrite


SOURCE = b'const row = {\n  sizeTokens: sizeOf(\n    fixture,\n  ),\n};\n'
FIXED = SOURCE.replace(b'  ),', b'  ) ?? null,')


class CompatibilityTests(unittest.TestCase):
    def test_unpatched_release_and_already_fixed_release(self):
        self.assertEqual(rewrite(SOURCE, '0.2.2'), FIXED)
        self.assertEqual(rewrite(FIXED, '0.2.3'), FIXED)

    def test_new_release_after_update_uses_anchor_again(self):
        updated = b'// Updated independently\n' + SOURCE.replace(b'fixture', b'newFixture')
        fixed = b'// Updated independently\n' + FIXED.replace(b'fixture', b'newFixture')
        self.assertEqual(rewrite(updated, '0.2.3'), fixed)

    def test_leaves_line_endings_intact(self):
        self.assertEqual(rewrite(SOURCE.replace(b'\n', b'\r\n'), '0.2.2'), FIXED.replace(b'\n', b'\r\n'))

    def test_requires_one_anchor(self):
        for source in (b'unrelated', SOURCE*2):
            with self.subTest(source=source), self.assertRaisesRegex(AnchorMismatch, 'найдено:'):
                rewrite(source, '0.2.3')


if __name__ == '__main__':
    unittest.main()
