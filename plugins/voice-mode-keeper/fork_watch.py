"""Warns when the author of a plugin we run from a fork has released a newer version.

Once a day one `git ls-remote` reads the author's tags; nothing is downloaded, merged or run.
The version is rebuilt from three numbers, so no text of the publisher reaches a thread.
"""
import json
import subprocess
import time

import plugin_fork
from upstream_retirement import write_state

CHECK_SECONDS = 24 * 3600
RETRY_SECONDS = 3600
STALE_SECONDS = 3 * 24 * 3600


def dotted(version):
    return '.'.join(map(str, version))


def policy_of(plugin_id, plugin):
    """The fork policy this installation follows, or None for any other source."""
    try:
        data = plugin_fork.policy(plugin_id)
    except (plugin_fork.ForkError, OSError, ValueError):
        return None
    return data if plugin_fork.on_fork(plugin, data) else None


def watch(plugin_id, data, plugin, status, state_dir, tell, thread, now=time.time):
    name, moment = status['name'], now()
    path = state_dir / f'{plugin_id}-fork.json'
    try:
        state = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
    except ValueError:
        state = {}
    state.setdefault('okAt', moment)
    due = moment - state.get('okAt', 0) >= CHECK_SECONDS or 'newest' not in state
    if due and moment - state.get('triedAt', 0) >= RETRY_SECONDS:
        state['triedAt'] = moment
        try:
            versions = plugin_fork.remote_versions(data['upstream'])
        except (plugin_fork.ForkError, OSError, subprocess.SubprocessError):
            versions = []
        if versions:
            state.update(newest=list(versions[-1]), okAt=moment)
        write_state(path, state)
    if moment - state['okAt'] >= STALE_SECONDS:
        return {**status, 'state': 'attention',
                'message': f'{name}: трое суток не удаётся проверить новые версии автора.'}
    own = plugin_fork.parse(status['version'])
    newest = tuple(state.get('newest', ()))
    if not own or not newest:
        return {**status, 'state': 'ready', 'message': f'{name} из форка; новые версии автора ещё не проверены.'}
    base = plugin_fork.base_of(own)
    if newest <= base:
        return {**status, 'state': 'ready', 'message': f'{name} из форка: у автора нет версии новее {dotted(base)}.'}
    if thread and state.get('noticed') != list(newest):
        # Reserved first: a lost response or a restart must not send the notice twice.
        state['noticed'] = list(newest)
        write_state(path, state)
        try:
            tell(thread, f'Сторож: у автора {name} вышла версия {dotted(newest)}, наш форк собран на {dotted(base)}. '
                         f'Сообщи владельцу. Проверить перенос: python3 scripts/plugin_fork.py sync {plugin_id}; '
                         f'выпустить после «да» владельца — то же с --push (на машине со сборкой плагинов BB).')
        except (OSError, RuntimeError):
            pass
    return {**status, 'state': 'attention',
            'message': f'У автора {name} вышла версия {dotted(newest)}, наш форк собран на {dotted(base)}. '
                       f'Работает прежняя; попросите агента перенести новую.'}
