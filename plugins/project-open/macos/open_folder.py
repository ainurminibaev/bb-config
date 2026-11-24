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
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from urllib.parse import parse_qs, urlsplit, quote
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

BASE = Path.home() / 'Library/Application Support/BB Project Folder'
ALIAS = re.compile(r'[A-Za-z0-9_][A-Za-z0-9_.-]*')
NO_SSH = ' Файл можно открыть без диска: «Открыть на компьютере» (Open on Desktop).'


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
    profile = profile_for(host, path, settings)
    url = json.loads((BASE / 'State' / (profile['key'] + '.json')).read_text())['url']
    parts = (*within(PurePosixPath(path), PurePosixPath(profile['root'])).parts, name)
    with urlopen(Request(url + quote('/'.join(parts), safe='/'), method='PROPFIND', headers={'Depth': '0'}), timeout=10) as response:
        return response.status == 207


def selected_entry(host, target, path, name, settings):
    """The entry to select inside an already checked folder; None when it is not there.

    Only its presence is checked: reading the folder would make macOS ask for access.
    """
    entry = target / name
    try:
        if profile_for(host, str(path), settings).get('mode') == 'local':
            entry.lstat()
        elif not remote_file_exists(host, path, name, settings):
            return None
    except (OSError, ValueError, KeyError):
        return None
    return entry


class Unavailable(ValueError):
    """A refusal whose text is meant for the person."""


def finder(*arguments, timeout):
    try:
        subprocess.run(['/usr/bin/open', *arguments], check=True, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise Unavailable('Finder не отвечает. Если он завис, перезапусти его (меню \uf8ff → «Завершить принудительно» → Finder) и повтори.')
    except subprocess.CalledProcessError:
        raise Unavailable('macOS не смог показать папку в Finder.')


def show(target, entry):
    """Select the file; when Finder cannot, show its folder."""
    if entry is not None:
        try:
            finder('-R', str(entry), timeout=8)
            return True
        except Unavailable:
            pass
    try:
        finder('-a', 'Finder', target.as_uri(), timeout=6)
    except Unavailable:
        # macOS may be asking the user for access (it asks again after an update of this
        # app). Showing the folder selected in its parent needs no access.
        finder('-R', str(target), timeout=6)
    return False


def mounted(path):
    """Whether something is mounted here, from the kernel's own table.

    os.path.ismount() would call into the volume itself and wait for a dead network disk.
    """
    table = subprocess.run(['/sbin/mount'], capture_output=True, text=True, timeout=5).stdout
    return any(' on ' + str(path) + ' (' in line for line in table.splitlines())


def within(path, root):
    try:
        return path.relative_to(root)
    except ValueError:
        raise ValueError('Эта папка не входит в разрешённые каталоги проекта.')


def load_settings(config_path=None):
    """The manual config.json, and the machines BB itself wrote next to it."""
    path = config_path or BASE / 'config.json'
    settings = json.loads(path.read_text()) if path.exists() else {}
    try:
        known = json.loads((BASE / 'machines.json').read_text())
        settings['bb'] = known if isinstance(known, dict) and isinstance(known.get('machines'), dict) else {}
    except (OSError, ValueError):
        settings['bb'] = {}
    return settings


def allowed_roots(machine):
    roots = []
    for root in machine.get('roots', []):
        if not isinstance(root, str) or not root.startswith('/') or any(ord(c) < 32 or ord(c) == 127 for c in root):
            continue
        root = PurePosixPath(root)
        if '..' not in root.parts and len(root.parts) > 1:
            roots.append(root)
    # A project inside another project needs no disk of its own.
    return [r for r in roots if not any(other != r and other in r.parents for other in roots)]


def profile_for(host, path, settings):
    """How to reach one folder. A manual record wins; otherwise what BB reported."""
    manual = settings.get('hosts', {}).get(host)
    if manual:
        return {**manual, 'key': host}
    bb = settings.get('bb', {})
    machine = bb.get('machines', {}).get(host)
    if not isinstance(machine, dict):
        raise Unavailable('BB ещё не сообщил этому Mac об этой машине. Повтори через несколько секунд.')
    root = next((r for r in allowed_roots(machine) if r == PurePosixPath(path) or r in PurePosixPath(path).parents), None)
    if root is None:
        raise ValueError('Эта папка не входит в проекты BB на этой машине.')
    if host == bb.get('self'):
        return {'mode': 'local', 'roots': [str(root)], 'key': host}
    keys = [k for k in machine.get('hostKeys', []) if isinstance(k, str) and re.fullmatch(r'[a-z0-9@.-]+ [A-Za-z0-9+/=]+', k)]
    if not keys:
        raise Unavailable('У этой машины нет SSH, который можно проверить.' + NO_SSH)
    alias = settings.get('bindings', {}).get(host) or pick_alias(keys)
    name = re.sub(r'[^\w .-]+', ' ', str(machine.get('name') or host)).strip(' .') or host
    label = (name[:40] + ' - ' + re.sub(r'[^\w .-]+', ' ', root.name))[:80].strip(' .')
    key = host + '-' + hashlib.sha256(str(root).encode()).hexdigest()[:10]
    return {'mode': 'sftp', 'sshProfile': alias, 'root': str(root), 'label': label, 'key': key, 'hostKeys': sorted(keys)}


def ssh_aliases(config):
    """Plain Host names of the user's SSH configuration, following Include."""
    names, seen = [], set()

    def read(path):
        if path in seen or not path.is_file():
            return
        seen.add(path)
        for line in path.read_text(errors='replace').splitlines():
            words = line.replace('=', ' ', 1).split('#')[0].split()
            if not words:
                continue
            if words[0].lower() == 'host':
                names.extend(w for w in words[1:] if ALIAS.fullmatch(w))
            elif words[0].lower() == 'include':
                for pattern in words[1:]:
                    pattern = os.path.expanduser(pattern.strip('"'))
                    base = Path(pattern) if os.path.isabs(pattern) else config.parent / pattern
                    for found in sorted(base.parent.glob(base.name)):
                        read(found)

    read(config)
    return list(dict.fromkeys(names))


def known_keys(options):
    """Host keys this user has already accepted for one SSH destination."""
    name = options.get('hostkeyalias') or options.get('hostname', '')
    if not options.get('hostkeyalias') and options.get('port', '22') != '22':
        name = '[' + name + ']:' + options['port']
    keys = set()
    for file in options.get('userknownhostsfile', '').split():
        file = os.path.expanduser(file)
        if not os.path.isfile(file):
            continue
        found = subprocess.run(['/usr/bin/ssh-keygen', '-F', name, '-f', file], capture_output=True, text=True, timeout=5).stdout
        for line in found.splitlines():
            words = line.split()
            if words and not words[0].startswith(('#', '@')) and len(words) >= 3:
                keys.add(words[1] + ' ' + words[2])
    return keys


def ssh_options(alias):
    out = subprocess.run(['/usr/bin/ssh', '-G', alias], capture_output=True, text=True, timeout=5, check=True).stdout
    return dict(line.split(' ', 1) for line in out.splitlines() if ' ' in line)


def pick_alias(keys, config=None):
    """The one SSH destination whose already accepted host key is the machine's own key.

    Nothing is connected to here, and names are not compared: only host keys are.
    """
    matches = {}
    for alias in ssh_aliases(config or Path.home() / '.ssh/config'):
        try:
            options = ssh_options(alias)
            if known_keys(options) & set(keys):
                way = tuple(options.get(k, '') for k in ('hostname', 'port', 'user', 'proxyjump', 'proxycommand'))
                matches.setdefault(way, alias)
        except (OSError, subprocess.SubprocessError, ValueError):
            continue
    if len(matches) == 1:
        return next(iter(matches.values()))
    if matches:
        raise Unavailable('К этой машине подходит несколько SSH-записей: ' + ', '.join(sorted(matches.values()))
                          + '. Укажи одну в «bindings» файла config.json.')
    raise Unavailable('На этом Mac нет SSH-входа на эту машину.' + NO_SSH)


def ssh_command(profile):
    """SSH that notices a dead link in seconds and, when the machine is pinned, accepts only its own key."""
    options = ['BatchMode=yes', 'ConnectTimeout=5', 'ServerAliveInterval=4', 'ServerAliveCountMax=2', 'ClearAllForwardings=yes']
    if profile.get('hostKeys'):
        pins = BASE / 'State' / (profile['key'] + '.known_hosts')
        pins.parent.mkdir(parents=True, exist_ok=True)
        pins.write_text(''.join('bb-machine ' + k + '\n' for k in profile['hostKeys']))
        pins.chmod(0o600)
        options += ['StrictHostKeyChecking=yes', 'HostKeyAlias=bb-machine', 'UserKnownHostsFile="' + str(pins) + '"',
                    'GlobalKnownHostsFile=/dev/null', 'ControlMaster=no', 'ControlPath=none', 'UpdateHostKeys=no']
    return ['/usr/bin/ssh', *('-o' + o for o in options), profile['sshProfile']]


def ssh_wrapper(profile):
    """A circuit breaker: after a failed connection the next ones fail at once for a while.

    Finder asks for many things in a row; without this each of them would wait for its own timeout.
    """
    script = BASE / 'State' / (profile['key'] + '.ssh.sh')
    down = shlex.quote(str(script.with_suffix('.down')))
    script.parent.mkdir(parents=True, exist_ok=True)
    script.write_text('#!/bin/sh\n'
                      'if [ $(($(date +%s) - $(cat ' + down + ' 2>/dev/null || echo 0))) -lt 15 ]; then exit 255; fi\n'
                      'started=$(date +%s)\n' + shlex.join(ssh_command(profile)) + ' "$@"\ncode=$?\n'
                      'if [ $code -eq 255 ] && [ $(($(date +%s) - started)) -le 12 ]; then date +%s > ' + down + '; fi\n'
                      'exit $code\n')
    script.chmod(0o700)
    return script


def find_rclone(settings):
    for candidate in (settings.get('rclone'), '/opt/homebrew/bin/rclone', '/usr/local/bin/rclone', shutil.which('rclone')):
        if candidate and os.access(candidate, os.X_OK) and Path(candidate).is_file():
            return candidate
    raise ValueError('Не найден установленный rclone.')


def server_command(rclone, profile, port, prefix):
    command = [str(rclone), 'serve', 'webdav', ':sftp:' + str(PurePosixPath(profile['root'])),
               '--config', '/dev/null', '--addr', '127.0.0.1:' + str(port), '--baseurl', prefix,
               '--sftp-ssh', shlex.join(['/bin/sh', str(ssh_wrapper(profile))]),
               '--sftp-disable-hashcheck', '--sftp-shell-type', 'unix', '--low-level-retries', '1',
               '--dir-cache-time', '15s', '--vfs-cache-mode', 'writes']
    return command + ['--read-only'] if profile.get('readOnly', False) else command


def ours(previous):
    """The earlier rclone is still that process, not a reused process number."""
    out = subprocess.run(['/bin/ps', '-o', 'command=', '-p', str(int(previous['pid']))], capture_output=True, text=True, timeout=5).stdout
    return 'rclone serve webdav' in out and urlsplit(previous['url']).path.strip('/') in out


def local_folder(path, profile):
    try:
        target = Path(path).resolve(strict=True)
    except OSError:
        raise ValueError('Рабочая папка не найдена.')
    roots = [Path(root).resolve() for root in profile.get('roots', [])]
    if not any(target == root or root in target.parents for root in roots):
        raise ValueError('Локальная папка не входит в настроенные проекты.')
    if not target.is_dir():
        raise ValueError('Это файл, а не папка. Для файла в ссылке нужен параметр select=1.')
    return target


def mounted_folder(host, path, settings):
    profile = profile_for(host, path, settings)
    if profile.get('mode') == 'local':
        return local_folder(path, profile)
    if profile.get('mode') != 'sftp':
        raise ValueError('Неизвестный способ подключения папки.')
    remote_root = PurePosixPath(profile['root'])
    if not remote_root.is_absolute() or '..' in remote_root.parts:
        raise ValueError('Некорректный корень подключения.')
    relative = within(PurePosixPath(path), remote_root)
    if not ALIAS.fullmatch(profile['sshProfile']):
        raise ValueError('Некорректное имя существующего SSH-профиля.')
    rclone = find_rclone(settings)
    key = profile['key']
    label = profile.get('label', host)
    if not re.fullmatch(r'[\w .-]{1,80}', label) or label in ('.', '..'):
        raise ValueError('Некорректное название диска.')
    mount = BASE / 'Volumes' / label if key == host else BASE / 'Volumes' / key / label
    live = mounted(mount)
    if not live:
        mount.mkdir(parents=True, exist_ok=True)
    metadata = BASE / 'State' / (key + '.json')
    own = {k: v for k, v in profile.items() if k != 'key'}
    fingerprint, earlier = (hashlib.sha256(json.dumps([own, version], sort_keys=True).encode()).hexdigest()
                            for version in ('webdav-v2', 'webdav-v1'))
    previous = json.loads(metadata.read_text()) if metadata.exists() else {}
    url = previous.get('url')

    def answers(address, seconds):
        with urlopen(Request(address, method='PROPFIND', headers={'Depth': '0'}), timeout=seconds) as response:
            return response.status == 207

    def attach(address):
        # nobrowse: Finder, Spotlight and the Dock do not look into the disk on their own.
        subprocess.run(['/sbin/mount_webdav', '-S', '-o', 'nobrowse', '-v', label, address, str(mount)],
                       check=True, capture_output=True, text=True, timeout=20)

    if live:
        # A disk connected by the previous version stays usable until it is ejected.
        if previous.get('fingerprint') not in (fingerprint, earlier):
            raise ValueError('Параметры диска изменились. Сначала отключи прежний диск в Finder.')
        if not url:
            raise ValueError('Для обновления обработчика отключи прежний диск и открой папку заново.')
    else:
        running = bool(url and previous.get('pid') and ours(previous))
        if running and previous.get('fingerprint') == fingerprint:
            # Eject/reopen reuses the one existing local server.
            try:
                if not answers(url, 12):
                    raise OSError('WebDAV unavailable')
                attach(url)
                live = True
            except (OSError, subprocess.SubprocessError):
                raise Unavailable('Машина сейчас недоступна по SSH. Проверь сеть или VPN и повтори.')
        elif running:
            # Unmounted server with other parameters. Unsent files stay in rclone's own cache.
            os.kill(previous['pid'], 15)
    if not live:
        if any(mount.iterdir()):
            raise ValueError('Каталог подключения не пуст. Его содержимое не изменено.')
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        prefix = secrets.token_urlsafe(24)
        url = 'http://127.0.0.1:' + str(port) + '/' + prefix + '/'
        command = server_command(rclone, profile, port, prefix)
        (BASE / 'State' / (key + '.ssh.down')).unlink(missing_ok=True)
        log_path = BASE / 'State' / (key + '.log')
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open('a') as log:
            process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                       start_new_session=True, close_fds=True)
        deadline = time.monotonic() + 15
        while True:
            if process.poll() is not None:
                raise Unavailable('Машина недоступна по SSH. Проверь сеть или VPN и повтори; подробности — в журнале BB Project Folder.')
            if time.monotonic() >= deadline:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                raise Unavailable('Машина не ответила по SSH за 15 секунд. Проверь сеть или VPN и повтори.')
            try:
                if answers(url, 12):
                    break
            except OSError:
                pass
            time.sleep(0.1)
        try:
            attach(url)
        except Exception:
            if not mounted(mount):
                process.terminate()
            raise Unavailable('macOS не смог подключить локальный WebDAV-диск.')
        write_json(metadata, {'fingerprint': fingerprint, 'pid': process.pid, 'transport': 'webdav', 'url': url})
    target = mount.joinpath(*relative.parts)
    target_url = url + quote('/'.join(relative.parts), safe='/') + ('/' if relative.parts else '')
    try:
        # Check the exact remote collection over WebDAV. Finder, rather than
        # a background helper, owns browsing the mounted network volume.
        with urlopen(Request(target_url, method='PROPFIND', headers={'Depth': '0'}), timeout=12) as response:
            content = ET.fromstring(response.read())
            if response.status != 207 or content.find('.//{DAV:}resourcetype/{DAV:}collection') is None:
                raise ValueError('Это файл, а не папка. Для файла в ссылке нужен параметр select=1.')
    except HTTPError as error:
        if error.code == 404:
            raise ValueError('Рабочая папка отсутствует на машине.')
        raise Unavailable('Машина сейчас недоступна по SSH. Проверь сеть или VPN и повтори.')
    except OSError:
        raise Unavailable('Машина сейчас недоступна по SSH. Проверь сеть или VPN и повтори.')
    return target


def lock_within(stream, seconds):
    deadline = time.monotonic() + seconds
    while True:
        try:
            return fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            if time.monotonic() >= deadline:
                raise Unavailable('Предыдущее открытие этой машины ещё выполняется. Повтори чуть позже.')
            time.sleep(0.2)


def open_folder(url, config_path=None):
    host, path, request, name = parse_request(url)
    settings = load_settings(config_path)
    status = BASE / 'Status' / (request + '.json')
    write_json(status, {'state': 'opening', 'host': host, 'path': path})
    lock_dir = BASE / 'State'
    lock_dir.mkdir(parents=True, exist_ok=True)
    try:
        # Repeated clicks share one mount; each opening still focuses Finder.
        with (lock_dir / (host + '.lock')).open('a') as lock:
            lock_within(lock, 20)
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
