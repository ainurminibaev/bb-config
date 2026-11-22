#!/usr/bin/env python3
"""Keep the BB age identity in macOS Keychain, never in logs or process arguments."""
import argparse
import csv
import ctypes
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

SERVICE = b'BB backup recovery key'
ACCOUNT = b'bb-config-age-v1'
ROOT = Path(__file__).resolve().parents[1]


class Keychain:
    def __init__(self):
        if sys.platform != 'darwin':
            raise RuntimeError('Keychain operations must run on the Mac')
        self.api = ctypes.CDLL('/System/Library/Frameworks/Security.framework/Security')
        self.api.SecKeychainFindGenericPassword.argtypes = [ctypes.c_void_p,
            ctypes.c_uint32, ctypes.c_char_p, ctypes.c_uint32, ctypes.c_char_p,
            ctypes.POINTER(ctypes.c_uint32), ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p]
        self.api.SecKeychainFindGenericPassword.restype = ctypes.c_int32
        self.api.SecKeychainAddGenericPassword.argtypes = [ctypes.c_void_p,
            ctypes.c_uint32, ctypes.c_char_p, ctypes.c_uint32, ctypes.c_char_p,
            ctypes.c_uint32, ctypes.c_void_p, ctypes.c_void_p]
        self.api.SecKeychainAddGenericPassword.restype = ctypes.c_int32
        self.api.SecKeychainItemFreeContent.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        self.api.SecKeychainItemFreeContent.restype = ctypes.c_int32

    def get(self):
        size = ctypes.c_uint32()
        data = ctypes.c_void_p()
        status = self.api.SecKeychainFindGenericPassword(None, len(SERVICE), SERVICE,
            len(ACCOUNT), ACCOUNT, ctypes.byref(size), ctypes.byref(data), None)
        if status == -25300:
            return None
        if status:
            raise RuntimeError('macOS Keychain lookup failed (OSStatus %s)' % status)
        try:
            return ctypes.string_at(data, size.value)
        finally:
            self.api.SecKeychainItemFreeContent(None, data)

    def add(self, identity):
        value = ctypes.create_string_buffer(identity)
        try:
            status = self.api.SecKeychainAddGenericPassword(None, len(SERVICE), SERVICE,
                len(ACCOUNT), ACCOUNT, len(identity), ctypes.cast(value, ctypes.c_void_p), None)
            if status:
                raise RuntimeError('macOS Keychain save failed (OSStatus %s)' % status)
        finally:
            ctypes.memset(value, 0, len(value))


def age_tool(name):
    executable = shutil.which(name)
    if not executable and Path('/opt/homebrew/bin', name).is_file():
        executable = str(Path('/opt/homebrew/bin', name))
    if not executable:
        raise RuntimeError('Install age first: brew install age')
    return executable


def recipient(identity):
    result = subprocess.run([age_tool('age-keygen'), '-y'], input=identity,
                            capture_output=True, check=True)
    return result.stdout.decode().strip()


def setup():
    keychain = Keychain()
    identity = keychain.get()
    config = ROOT / '.local/config/backup-encryption.json'
    config.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if identity is None:
        if config.exists():
            raise RuntimeError('Restore the existing key with import-clipboard; refusing to replace the recovery identity')
        generated = subprocess.run([age_tool('age-keygen')], capture_output=True, check=True)
        identity = next(line for line in generated.stdout.splitlines()
                        if line.startswith(b'AGE-SECRET-KEY-')) + b'\n'
        keychain.add(identity)
        if keychain.get() != identity:
            raise RuntimeError('Saved Keychain identity could not be verified')
    public = recipient(identity)
    if config.exists() and json.loads(config.read_text())['recipient'] != public:
        raise RuntimeError('Existing public key differs; explicit key rotation is required')
    config.write_text(json.dumps({'format': 'age', 'recipient': public,
        'keychainService': SERVICE.decode(), 'keychainAccount': ACCOUNT.decode(),
        'recoverySearch': 'bb-backups.invalid'}, indent=2) + '\n')
    print('Recovery key saved and verified in macOS Keychain: ' + SERVICE.decode())
    print('Public encryption settings saved: ' + str(config))


def chrome_import():
    identity = Keychain().get()
    if identity is None:
        raise RuntimeError('Run setup first')
    folder = ROOT / '.local/keys'
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    folder.chmod(0o700)
    if folder.is_symlink() or not folder.is_dir() or folder.stat().st_uid != os.getuid():
        raise RuntimeError(f'Unsafe key folder: {folder}')
    path = folder / 'chrome-import-BB-recovery.csv'
    # A fresh private file only: never follow or reuse something already at this path,
    # which could send the recovery key wherever a link points.
    if path.is_symlink() or path.exists():
        raise RuntimeError(f'{path} already exists: run cleanup-import first')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(fd, 'w', newline='') as stream:
        writer = csv.writer(stream)
        writer.writerow(['name', 'url', 'username', 'password', 'note'])
        writer.writerow(['BB — ключ восстановления бэкапов', 'https://bb-backups.invalid',
            'BB backup recovery key', identity.decode().strip(),
            'age recovery key for encrypted BB server backups. This is not a website login.'])
    print('Private Chrome import file created: ' + str(path))
    print('Import it into Google Password Manager, verify the bb-backups entry, then run cleanup-import.')


def decrypt(archive, output):
    identity = Keychain().get()
    if identity is None:
        raise RuntimeError('Recovery key is missing from macOS Keychain')
    destination = Path(output)
    if destination.exists():
        raise RuntimeError('Refusing to overwrite existing decrypted output')
    private_output = tempfile.NamedTemporaryFile(prefix='.bb-decrypt-', suffix='.tar.gz',
                                                dir=destination.parent, delete=False)
    temporary = Path(private_output.name)
    read_fd, write_fd = os.pipe()
    process = None
    try:
        # The identity is passed only through an inherited pipe, never argv or disk.
        process = subprocess.Popen([age_tool('age'), '--decrypt', '--identity',
            '/dev/fd/%s' % read_fd, str(archive)],
            pass_fds=(read_fd,), stdout=private_output, stderr=subprocess.PIPE)
        private_output.close()
        os.close(read_fd)
        read_fd = None
        with os.fdopen(write_fd, 'wb') as pipe:
            write_fd = None
            pipe.write(identity)
        _, error = process.communicate(timeout=300)
        if process.returncode:
            raise RuntimeError('age decryption failed; ciphertext or recovery key does not match')
        import tarfile
        with tarfile.open(temporary, 'r|gz') as archive_stream:
            first = next(iter(archive_stream), None)
        if first is not None and first.name == 'manifest.json':
            from server_backup import validate_archive
            count = len(validate_archive(temporary)['entries'])
        else:
            from private_backup import validate_backup
            count = validate_backup(temporary)
        temporary.chmod(0o600)
        os.replace(temporary, destination)
        print('Decrypted archive verified (%s files): %s' % (count, destination))
    finally:
        private_output.close()
        if process is not None and process.poll() is None:
            process.kill()
            process.wait()
        if read_fd is not None:
            os.close(read_fd)
        if write_fd is not None:
            os.close(write_fd)
        temporary.unlink(missing_ok=True)


def migrate_legacy(roots, remove=False):
    """Keep the original until its encrypted replacement decrypts byte-for-byte."""
    from server_backup import encrypt_archive, validate_archive, digest
    identity = Keychain().get()
    if identity is None:
        raise RuntimeError('Recovery key is missing from macOS Keychain')
    public = recipient(identity)
    files = sorted({p for root in roots for p in Path(root).expanduser().rglob('*.tar.gz')})
    for original in files:
        validate_archive(original)
        encrypted = original.with_name(original.name + '.age')
        if not encrypted.exists():
            encrypt_archive(original, encrypted, public)
        with tempfile.TemporaryDirectory(prefix='.verify-age-', dir=original.parent) as folder:
            checked = Path(folder) / 'verified.tar.gz'
            decrypt(encrypted, checked)
            if digest(checked) != digest(original):
                raise RuntimeError('Encrypted replacement differs; original was retained')
        receipt = encrypted.with_suffix(encrypted.suffix + '.json')
        receipt.write_text(json.dumps({'sha256': digest(encrypted),
            'sizeBytes': encrypted.stat().st_size, 'encrypted': True}))
        receipt.chmod(0o600)
        if remove:
            original.unlink()
            original.with_suffix(original.suffix + '.json').unlink(missing_ok=True)
        print('Verified encrypted replacement: ' + str(encrypted))
    print('Legacy archives processed: %s; plaintext originals removed: %s' % (len(files), remove))


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('setup')
    commands.add_parser('chrome-import')
    commands.add_parser('cleanup-import')
    commands.add_parser('import-clipboard')
    legacy = commands.add_parser('migrate-legacy')
    legacy.add_argument('roots', nargs='+')
    legacy.add_argument('--remove-verified-originals', action='store_true')
    restore = commands.add_parser('decrypt')
    restore.add_argument('archive')
    restore.add_argument('--output', required=True)
    args = parser.parse_args()
    if args.command == 'setup':
        setup()
    elif args.command == 'chrome-import':
        chrome_import()
    elif args.command == 'cleanup-import':
        (ROOT / '.local/keys/chrome-import-BB-recovery.csv').unlink(missing_ok=True)
        print('Temporary Chrome import file removed.')
    elif args.command == 'import-clipboard':
        identity = subprocess.run(['pbpaste'], capture_output=True, check=True).stdout.strip() + b'\n'
        public = recipient(identity)
        config = ROOT / '.local/config/backup-encryption.json'
        if config.is_file() and json.loads(config.read_text())['recipient'] != public:
            raise RuntimeError('Clipboard key does not match the backup encryption recipient')
        store = Keychain()
        existing = store.get()
        if existing is None:
            store.add(identity)
        elif existing != identity:
            raise RuntimeError('A different identity already exists in Keychain')
        print('Recovery identity saved in macOS Keychain; its value was not printed.')
    elif args.command == 'migrate-legacy':
        migrate_legacy(args.roots, args.remove_verified_originals)
    else:
        decrypt(args.archive, args.output)


if __name__ == '__main__':
    main()
