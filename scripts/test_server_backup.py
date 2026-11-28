import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('backup', Path(__file__).with_name('server_backup.py'))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


def archive(path, corrupt=False):
    body = b'fixture: no real credentials or databases'
    manifest = {'format': 'bb-server-archive', 'version': 2, 'entries': [
        {'path': 'fixture.txt', 'size': len(body),
         'sha256': hashlib.sha256(body if not corrupt else b'wrong').hexdigest()}]}
    with tarfile.open(path, 'w:gz') as out:
        for name, data in [('manifest.json', json.dumps(manifest).encode()), ('files/fixture.txt', body)]:
            member = tarfile.TarInfo(name)
            member.size = len(data)
            out.addfile(member, io.BytesIO(data))


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def finalize(self, corrupt=False, wrong_digest=False):
        for n in range(3):
            archive(self.root / ('bb-server-2026010%d.tar.gz' % (n + 1)))
        incoming = self.root / '.incoming-test'
        incoming.mkdir()
        src = incoming / 'source.tar.gz'
        archive(src, corrupt)
        (incoming / 'part-00000000').write_bytes(base64.b64encode(src.read_bytes()))
        expected = '0' * 64 if wrong_digest else backup.digest(src)
        destination = self.root / 'bb-server-20260104.tar.gz'
        completed = subprocess.run([sys.executable, '-c', backup.FINALIZE,
                                    str(incoming), str(destination), expected, '3'],
                                   capture_output=True)
        return completed, destination

    def test_delivery_verifies_then_keeps_three_newest(self):
        completed, destination = self.finalize()
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertTrue(destination.exists())
        self.assertEqual(destination.stat().st_mode & 0o777, 0o600)
        self.assertEqual(len(list(self.root.glob('bb-server-*.tar.gz'))), 3)
        self.assertFalse((self.root / 'bb-server-20260101.tar.gz').exists())
        backup.validate_archive(destination)

    def test_corrupt_contents_keep_all_old_backups(self):
        completed, destination = self.finalize(corrupt=True)
        self.assertNotEqual(completed.returncode, 0)
        self.assertFalse(destination.exists())
        self.assertEqual(len(list(self.root.glob('bb-server-*.tar.gz'))), 3)

    def test_incomplete_delivery_keeps_all_old_backups(self):
        completed, destination = self.finalize(wrong_digest=True)
        self.assertNotEqual(completed.returncode, 0)
        self.assertFalse(destination.exists())
        self.assertEqual(len(list(self.root.glob('bb-server-*.tar.gz'))), 3)

    def test_validator_rejects_bad_manifest_member(self):
        path = self.root / 'invalid.tar.gz'
        archive(path, corrupt=True)
        with self.assertRaises(ValueError):
            backup.validate_archive(path)
    def test_streaming_validator_rejects_missing_or_duplicate_members(self):
        body = b'fixture'
        manifest = {'format': 'bb-server-archive', 'version': 2, 'entries': [
            {'path': 'fixture', 'size': len(body), 'sha256': hashlib.sha256(body).hexdigest()}]}
        for copies in (0, 2):
            path = self.root / ('invalid-%d.tar.gz' % copies)
            with tarfile.open(path, 'w:gz') as out:
                items = [('manifest.json', json.dumps(manifest).encode())]
                items.extend([('files/fixture', body)] * copies)
                for name, data in items:
                    member = tarfile.TarInfo(name)
                    member.size = len(data)
                    out.addfile(member, io.BytesIO(data))
            with self.assertRaises(ValueError):
                backup.validate_archive(path)
    def test_weekly_export_and_five_am_boundary(self):
        import datetime as dt
        self.assertFalse(backup.export_due({'day': '2026-11-15'}, '2026-11-21', 7))
        self.assertTrue(backup.export_due({'day': '2026-11-15'}, '2026-11-22', 7))
        self.assertTrue(backup.export_due({}, '2026-11-22', 7))
        self.assertEqual(backup.backup_day(dt.datetime(2026, 11, 16, 1, 59, tzinfo=dt.timezone.utc)), '2026-11-15')
        self.assertEqual(backup.backup_day(dt.datetime(2026, 11, 16, 2, 0, tzinfo=dt.timezone.utc)), '2026-11-16')
    def test_config_retention_does_not_delete_weekly_server_backups(self):
        incoming = self.root / '.incoming-config'
        incoming.mkdir()
        data = b'age-encryption.org/v1\nfixture ciphertext'
        (incoming / 'part-00000000').write_bytes(base64.b64encode(data))
        server = self.root / 'bb-server-20260101.tar.gz.age'
        server.write_bytes(data)
        old = self.root / 'private-config-20260101.tar.gz.age'
        old.write_bytes(data)
        destination = self.root / 'private-config-20260102.tar.gz.age'
        completed = subprocess.run([sys.executable, '-c', backup.FINALIZE, str(incoming),
                                   str(destination), hashlib.sha256(data).hexdigest(), '1'], capture_output=True)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertFalse(old.exists())
        self.assertTrue(destination.exists())
        self.assertTrue(server.exists())
    def test_http_preload_changes_actual_fetch_header_deadline(self):
        import shutil
        if not shutil.which('node'):
            self.skipTest('Node required')
        undici = next((p / 'npm/node_modules/undici' for p in Path(backup.Cli().path).parents
                       if (p / 'npm/node_modules/undici/package.json').is_file()), None)
        if undici is None:
            self.skipTest('Bundled undici required')
        preload = self.root / 'export.cjs'
        preload.write_text(backup.EXPORT_HTTP_PRELOAD)
        # Built-in fetch normally waits five minutes. A deliberately short
        # injected deadline must fail, while a longer one must accept the response.
        code = """
const http = require('node:http');
const server = http.createServer((req, res) => setTimeout(() => res.end('ok'), 1200));
server.listen(0, '127.0.0.1', async () => {
  let ok = false;
  try { ok = await (await fetch(`http://127.0.0.1:${server.address().port}`)).text() === 'ok'; }
  catch {}
  process.exit(ok ? 0 : 1);
});
"""
        for deadline, expected in [('100', 1), ('5000', 0)]:
            result = subprocess.run(['node', '--require', str(preload), '-e', code],
                       env={**os.environ, 'BB_EXPORT_UNDICI': str(undici),
                            'BB_EXPORT_HEADERS_TIMEOUT_MS': deadline}, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, expected, result.stderr)
    def test_export_timeout_keeps_previous_backup_and_removes_plaintext(self):
        previous = self.root / 'bb-server-previous.tar.gz.age'
        previous.write_bytes(b'previous encrypted backup')
        state = {'day': '2000-01-01', 'archive': previous.name, 'delivered': True}
        backup.save_json(self.root / 'state.json', state)
        def failed_export(*args, **kwargs):
            Path(args[3]).write_bytes(b'incomplete plaintext export')
            raise subprocess.TimeoutExpired('bb server export', kwargs['timeout'])
        args = SimpleNamespace(source_dir=str(self.root), recipient='public-recipient',
                               force=False, keep=3)
        with patch.object(backup.Cli, 'call', side_effect=failed_export):
            with self.assertRaises(subprocess.TimeoutExpired):
                backup.tick(args)
        self.assertEqual(previous.read_bytes(), b'previous encrypted backup')
        self.assertEqual(backup.read_json(self.root / 'state.json'), state)
        self.assertEqual(list(self.root.glob('.export-*')), [])
    def test_stored_script_accepts_delivery_environment_without_checkout_config(self):
        with patch.dict(os.environ, {'BB_BACKUP_DESTINATION_HOST': 'fixture-host',
                                     'BB_BACKUP_DESTINATION_DIR': '/fixture/backups',
                                     'BB_BACKUP_RECIPIENT': 'public-recipient'}):
            with patch.object(backup, 'read_json', return_value={}), \
                 patch.object(sys, 'argv', ['server_backup.py']), \
                 patch.object(backup, 'tick') as tick:
                backup.main()
        args = tick.call_args.args[0]
        self.assertEqual(args.destination_host, 'fixture-host')
        self.assertEqual(args.destination_dir, '/fixture/backups')

    def test_desktop_launcher_uses_native_cli_without_reexec_loop(self):
        package = self.root / 'bb-app'
        native = package / 'host-daemon/dist/bb'
        native.parent.mkdir(parents=True)
        native.touch()
        launcher = package / 'dist/bb.js'
        with patch.dict(os.environ, {'BB_CLI': str(launcher)}):
            cli = backup.Cli()
            # macOS: /var is a link to /private/var; Cli resolves the real path.
            self.assertEqual(cli.path, str(native.resolve()))
            with patch.object(backup.subprocess, 'run') as run:
                run.return_value.returncode = 0
                run.return_value.stdout = '{}'
                cli.call('status', '--json')
                self.assertEqual(run.call_args.kwargs['env']['BB_CLI'], str(native.resolve()))

    def test_installed_shell_launcher_resolves_its_native_cli(self):
        package = self.root / 'bb-app'
        native = package / 'host-daemon/dist/bb'
        native.parent.mkdir(parents=True)
        native.touch()
        launcher = self.root / 'bb'
        launcher.write_text("#!/bin/sh\n# Written by bb: installed CLI\nentry='" + str(package / 'dist/bb.js') + "'\n")
        with patch.dict(os.environ, {'BB_CLI': str(launcher)}):
            self.assertEqual(backup.Cli().path, str(native))


if __name__ == '__main__':
    unittest.main()
