#!/usr/bin/env python3
"""Local URL handler: OpenSSH + rclone WebDAV + native macOS disk + Finder."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shlex
import socket
import subprocess
import sys
import tempfile
import time
from urllib.parse import parse_qs, urlsplit, quote
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

BASE = Path.home() / 'Library/Application Support/BB Project Folder'


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile('w', dir=path.parent, prefix=path.name, delete=False) as stream:
        stream.write(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
        temporary = Path(stream.name)
    temporary.chmod(0o600)
    temporary.replace(path)


def parse_request(url):
    parsed = urlsplit(url)
    if parsed.scheme != 'bb-project-folder' or parsed.netloc != 'open' or parsed.path not in ('', '/') or parsed.fragment:
        raise ValueError('Некорректная ссылка открытия папки.')
    values = parse_qs(parsed.query, keep_blank_values=True, strict_parsing=True)
    # Links of earlier versions have no "select" and mean a folder.
    select = values.pop('select', None)
    if set(values) != {'host', 'path', 'request'} or any(len(v) != 1 for v in values.values()) or select not in (None, ['1']):
        raise ValueError('Некорректные параметры открытия папки.')
    host, path, request = (values[key][0] for key in ('host', 'path', 'request'))
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', host) or not re.fullmatch(r'[A-Za-z0-9-]{1,80}', request):
        raise ValueError('Некорректный идентификатор открытия папки.')
    if not path.startswith('/') or '..' in PurePosixPath(path).parts or any(ord(c) < 32 or ord(c) == 127 for c in path):
        raise ValueError('Некорректный абсолютный путь папки.')
    path = PurePosixPath(path)
    if select and not path.name:
        raise ValueError('Не указан файл.')
    return (host, str(path.parent), request, path.name) if select else (host, str(path), request, None)


def remote_file_exists(host, path, name, settings):
    """The exact file, over the same local WebDAV server as the folder check."""
    url = json.loads((BASE / 'State' / (host + '.json')).read_text())['url']
    parts = (*within(PurePosixPath(path), PurePosixPath(settings['hosts'][host]['root'])).parts, name)
    with urlopen(Request(url + quote('/'.join(parts), safe='/'), method='PROPFIND', headers={'Depth': '0'}), timeout=10) as response:
        return response.status == 207


def selected_entry(host, target, path, name, settings):
    """The entry to select inside an already checked folder; None when it is not there.

    Only its presence is checked: reading the folder would make macOS ask for access.
    """
    entry = target / name
    try:
        if settings['hosts'][host].get('mode') == 'local':
            entry.lstat()
        elif not remote_file_exists(host, path, name, settings):
            return None
    except (OSError, ValueError, KeyError):
        return None
    return entry


def show(target, entry):
    """Select the file; when Finder cannot, show its folder."""
    if entry is not None:
        try:
            subprocess.run(['/usr/bin/open', '-R', str(entry)], check=True, capture_output=True, timeout=15)
            return True
        except (OSError, subprocess.SubprocessError):
            pass
    try:
        subprocess.run(['/usr/bin/open', '-a', 'Finder', target.as_uri()], check=True, timeout=6)
    except subprocess.TimeoutExpired:
        # macOS is asking the user for access (after an update of this app it asks again).
        # Showing the folder selected in its parent needs no access.
        subprocess.run(['/usr/bin/open', '-R', str(target)], check=True, timeout=15)
    return False


def within(path, root):
    try:
        return path.relative_to(root)
    except ValueError:
        raise ValueError('Эта папка не входит в разрешённые каталоги проекта.')


def mounted_folder(host, path, settings):
    profile = settings.get('hosts', {}).get(host)
    if not profile:
        raise ValueError('Эта машина не настроена в BB Project Folder на данном Mac.')
    if profile.get('mode') == 'local':
        target = Path(path).resolve(strict=True)
        roots = [Path(root).resolve(strict=True) for root in profile.get('roots', [])]
        if not any(target == root or root in target.parents for root in roots):
            raise ValueError('Локальная папка не входит в настроенные проекты.')
        if not target.is_dir():
            raise ValueError('Рабочая папка не найдена.')
        return target
    if profile.get('mode') != 'sftp':
        raise ValueError('Неизвестный способ подключения папки.')
    remote_root = PurePosixPath(profile['root'])
    if not remote_root.is_absolute() or '..' in remote_root.parts:
        raise ValueError('Некорректный корень подключения.')
    relative = within(PurePosixPath(path), remote_root)
    alias = profile['sshProfile']
    if not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]*', alias):
        raise ValueError('Некорректное имя существующего SSH-профиля.')
    rclone = Path(settings['rclone'])
    if not rclone.is_file() or not os.access(rclone, os.X_OK):
        raise ValueError('Не найден установленный rclone.')
    label = profile.get('label', host)
    if not re.fullmatch(r'[\w .-]{1,80}', label) or label in ('.', '..'):
        raise ValueError('Некорректное название диска.')
    mount = BASE / 'Volumes' / label
    mount.mkdir(parents=True, exist_ok=True)
    metadata = BASE / 'State' / (host + '.json')
    fingerprint = hashlib.sha256(json.dumps([profile, 'webdav-v1'], sort_keys=True).encode()).hexdigest()
    previous = json.loads(metadata.read_text()) if metadata.exists() else {}
    if not os.path.ismount(mount) and previous.get('fingerprint') == fingerprint and previous.get('url'):
        # Eject/reopen reuses the one existing local server rather than leaving
        # another rclone process behind on every mount.
        try:
            os.kill(previous['pid'], 0)
        except (ProcessLookupError, KeyError):
            pass
        else:
            try:
                with urlopen(Request(previous['url'], method='PROPFIND', headers={'Depth': '0'}), timeout=5) as response:
                    if response.status != 207:
                        raise OSError('WebDAV unavailable')
                subprocess.run(['/sbin/mount_webdav', '-S', '-v', label, previous['url'], str(mount)],
                               check=True, capture_output=True, text=True, timeout=20)
            except (OSError, subprocess.SubprocessError):
                raise RuntimeError('Существующее подключение диска пока недоступно. Проверь SSH и повтори открытие.')
    if os.path.ismount(mount):
        if previous.get('fingerprint') != fingerprint:
            raise ValueError('Параметры диска изменились. Сначала отключи прежний диск в Finder.')
        url = previous.get('url')
        if not url:
            raise ValueError('Для обновления обработчика отключи прежний диск и открой папку заново.')
    else:
        if any(mount.iterdir()):
            raise ValueError('Каталог подключения не пуст. Его содержимое не изменено.')
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        prefix = secrets.token_urlsafe(24)
        url = 'http://127.0.0.1:' + str(port) + '/' + prefix + '/'
        command = [str(rclone), 'serve', 'webdav', ':sftp:' + str(remote_root),
                   '--config', '/dev/null', '--addr', '127.0.0.1:' + str(port), '--baseurl', prefix,
                   '--sftp-ssh', shlex.join(['/usr/bin/ssh', '-oBatchMode=yes', '-oConnectTimeout=8', alias]),
                   '--sftp-disable-hashcheck', '--sftp-shell-type', 'unix',
                   '--dir-cache-time', '5s', '--vfs-cache-mode', 'writes']
        if profile.get('readOnly', False):
            command.append('--read-only')
        log_path = BASE / 'State' / (host + '.log')
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open('a') as log:
            process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                       start_new_session=True, close_fds=True)
        deadline = time.monotonic() + 25
        while True:
            if process.poll() is not None:
                raise RuntimeError('Rclone не смог подключить диск. Подробности в локальном журнале BB Project Folder.')
            if time.monotonic() >= deadline:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                raise RuntimeError('Истекло время подключения удалённого диска. Проверь SSH-подключение.')
            try:
                with urlopen(Request(url, method='PROPFIND', headers={'Depth': '0'}), timeout=2) as response:
                    if response.status == 207:
                        break
            except OSError:
                pass
            time.sleep(0.1)
        try:
            subprocess.run(['/sbin/mount_webdav', '-S', '-v', label, url, str(mount)],
                           check=True, capture_output=True, text=True, timeout=20)
        except Exception:
            if not os.path.ismount(mount):
                process.terminate()
            raise RuntimeError('macOS не смог подключить локальный WebDAV-диск.')
        write_json(metadata, {'fingerprint': fingerprint, 'pid': process.pid, 'transport': 'webdav', 'url': url})
    target = mount.joinpath(*relative.parts)
    target_url = url + quote('/'.join(relative.parts), safe='/') + ('/' if relative.parts else '')
    try:
        # Check the exact remote collection over WebDAV. Finder, rather than
        # a background helper, owns browsing the mounted network volume.
        with urlopen(Request(target_url, method='PROPFIND', headers={'Depth': '0'}), timeout=10) as response:
            content = ET.fromstring(response.read())
            if response.status != 207 or content.find('.//{DAV:}resourcetype/{DAV:}collection') is None:
                raise ValueError('Рабочая папка отсутствует на сервере.')
    except OSError:
        raise RuntimeError('Не удалось проверить рабочую папку на сервере.')
    return target


def open_folder(url, config_path=None):
    host, path, request, name = parse_request(url)
    settings = json.loads((config_path or BASE / 'config.json').read_text())
    status = BASE / 'Status' / (request + '.json')
    write_json(status, {'state': 'opening', 'host': host, 'path': path})
    lock_dir = BASE / 'State'
    lock_dir.mkdir(parents=True, exist_ok=True)
    try:
        # Repeated clicks share one mount; each opening still focuses Finder.
        with (lock_dir / (host + '.lock')).open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            target = mounted_folder(host, path, settings)
            entry = selected_entry(host, target, path, name, settings) if name else None
            selected = show(target, entry)
        result = {'state': 'opened', 'host': host, 'path': path, 'finderPath': str(entry if selected else target)}
        if name:
            result['selected'] = selected
        write_json(status, result)
        return result
    except Exception as error:
        write_json(status, {'state': 'error', 'host': host, 'path': path, 'message': str(error)})
        raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', required=True)
    parser.add_argument('--config', type=Path)
    parser.add_argument('--no-alert', action='store_true')
    args = parser.parse_args()
    try:
        print(json.dumps(open_folder(args.url, args.config), ensure_ascii=False))
    except Exception as error:
        print(str(error), file=sys.stderr)
        if not args.no_alert:
            subprocess.run(['/usr/bin/osascript', '-e', 'on run argv\ndisplay notification (item 1 of argv) with title "Не удалось открыть папку BB"\nend run', str(error)], timeout=10)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
