"""Check immutable catalog source and persist the one-time rule transition."""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from urllib.parse import quote
from urllib.request import urlopen


def revision_and_repository(plugin, source):
    repo = re.fullmatch(r'git:https://github\.com/([\w.-]+/[\w.-]+)\.git@', source)
    if plugin.get('provenance') != 'catalog' or not repo:
        return None
    parts = Path(plugin['rootDir']).parts
    for i in range(len(parts) - 1, 2, -1):
        if re.fullmatch(r'[a-f0-9]{40}', parts[i]) and '/'.join(parts[i-2:i]).lower() == repo[1].lower():
            return parts[i], repo[1], parts[i+1:]
    return None


def upstream_files(repository, revision, prefix, files):
    result = {}
    for name in files:
        path = quote('/'.join((*prefix, name)), safe='/')
        url = f'https://raw.githubusercontent.com/{repository}/{revision}/{path}'
        with urlopen(url, timeout=6) as response:
            content = response.read(2_097_153)
        if len(content) > 2_097_152:
            raise OSError('Catalog source exceeded size limit')
        result[name] = content
    return result


def write_state(path, value):
    with tempfile.NamedTemporaryFile(dir=path.parent, mode='w', encoding='utf-8', delete=False) as fd:
        temp = Path(fd.name)
        try:
            json.dump(value, fd)
            fd.flush()
            os.fsync(fd.fileno())
            fd.close()
            temp.replace(path)
        finally:
            temp.unlink(missing_ok=True)


def retirement(plugin_id, spec, plugin, status, state_dir, contains_fix, tell, save, repo):
    if plugin_id in os.environ.get('BB_KEEPER_FORCE_RULES', '').replace(',', ' ').split():
        return None
    path = state_dir / f'{plugin_id}-upstream.json'
    state = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
    if 'retiredVersion' not in state:
        identity = revision_and_repository(plugin, spec['source'])
        if not identity:
            return None
        revision, repository, prefix = identity
        if state.get('checkedRevision') == revision:
            return None
        try:
            files = upstream_files(repository, revision, prefix, spec['files'])
        except OSError:
            # A network failure must not interfere with ordinary patching.
            return None
        state = {'checkedRevision': revision}
        if contains_fix(spec, files, plugin['version']):
            state['retiredVersion'] = plugin['version']
        write_state(path, state)

    version = state.get('retiredVersion')
    if version is None:
        return None
    change = spec.get('notice', spec['name'])
    # The version comes from the publisher's manifest and lands in an agent's thread: only a plain
    # semantic version is quoted, anything else is not passed on as text.
    shown = version if re.fullmatch(r'\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,40})?', str(version)) else '(нестандартная версия)'
    message = f'Сторож: правка {change} вошла в версию {shown} от автора — правило отключено автоматически.'
    if 'bbConfig' not in state:
        try:
            state['bbConfig'] = save(repo, state_dir, plugin_id, spec['name'], version, state['checkedRevision'])
        except (OSError, ValueError, subprocess.SubprocessError):
            state['bbConfig'] = ' Не удалось подготовить изменения bb-config.'
        write_state(path, state)
    message += state['bbConfig']
    thread = os.environ.get('BB_KEEPER_NOTICE_THREAD', '').strip()
    if thread and 'notice' not in state:
        # The CLI has no idempotency key. Reserve before calling it so a lost
        # response or a process restart cannot send a duplicate notification.
        state['notice'] = 'unconfirmed'
        write_state(path, state)
        try:
            tell(thread, message)
        except (OSError, RuntimeError):
            pass
        else:
            state['notice'] = 'sent'
            write_state(path, state)
    if state.get('notice') == 'unconfirmed':
        message += ' Доставка уведомления не подтверждена.'
    return {**status, 'state': 'retired', 'message': message}
