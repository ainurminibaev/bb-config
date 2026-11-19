"""Record a retired rule in bb-config without using the user's Git index."""
from difflib import unified_diff
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile


RULES = 'plugins/voice-mode-keeper/rule-retirements.json'
DOCS = 'docs/customizations.md'
TARGETS = (RULES, DOCS)
START = '<!-- keeper-retirements:start -->\n'
END = '<!-- keeper-retirements:end -->'
GIT_ID = (
    '-c', 'user.name=Plugin Keeper',
    '-c', 'user.email=plugin-keeper@users.noreply.github.com',
)


def command(directory, *args):
    return subprocess.check_output(args, cwd=directory, stderr=subprocess.PIPE, timeout=90)


def git(directory, *args):
    return command(directory, 'git', *args)


def docs_with_retirements(original, rules):
    before, start, rest = original.partition(START)
    _, end, after = rest.partition(END)
    if not start or not end:
        raise ValueError('Retirement section missing')
    rows = [
        '| Правило | Статус |',
        '| --- | --- |',
        *(f"| {rule['name']} | Выключено, вошло в апстрим версии {rule['upstreamVersion']} |"
          for rule in rules.values()),
    ]
    return before + start + '\n'.join(rows) + '\n' + end + after


def changes(repo, head, plugin, name, version, revision):
    if not re.fullmatch(r'[0-9][0-9A-Za-z.+-]{0,63}', version) or not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise ValueError('Unexpected catalog version or revision')
    original = {path: git(repo, 'show', f'{head}:{path}').decode('utf-8') for path in TARGETS}
    rules = json.loads(original[RULES])
    rules[plugin] = {'status': 'retired', 'name': name, 'upstreamVersion': version, 'upstreamRevision': revision}
    rules = dict(sorted(rules.items()))
    desired = {
        RULES: json.dumps(rules, ensure_ascii=False, indent=2) + '\n',
        DOCS: docs_with_retirements(original[DOCS], rules),
    }
    return ''.join(line for path in TARGETS for line in unified_diff(
        original[path].splitlines(keepends=True), desired[path].splitlines(keepends=True),
        fromfile=f'a/{path}', tofile=f'b/{path}',
    ))


def snapshot(repo):
    script = str(repo / 'scripts/snapshot.py')
    try:
        for flag in ('--settings-only', '--check'):
            command(repo, sys.executable, script, flag)
    except (OSError, subprocess.SubprocessError):
        return False
    return True


def commit_patch(repo, head, branch, patch, plugin, version):
    with tempfile.TemporaryDirectory(prefix='keeper-git-') as temporary:
        worktree = Path(temporary) / 'checkout'
        git(repo, 'worktree', 'add', '--detach', '--quiet', str(worktree), head)
        try:
            git(worktree, 'apply', '--index', str(patch))
            command(worktree, sys.executable, str(worktree / 'scripts/privacy_check.py'), '--staged')
            git(worktree, *GIT_ID, 'commit', '-m', f'Retire {plugin} compatibility rule after upstream {version}')
            commit = git(worktree, 'rev-parse', 'HEAD').decode().strip()
            if (git(repo, 'rev-parse', 'HEAD').decode().strip() != head
                    or git(repo, 'symbolic-ref', 'HEAD') != branch
                    or git(repo, 'status', '--porcelain=v1', '--', *TARGETS)):
                raise RuntimeError('bb-config changed during preparation')
            git(repo, *GIT_ID, 'merge', '--ff-only', '--no-autostash', '--no-overwrite-ignore', commit)
            return commit[:12]
        finally:
            # The detached tree belongs to this operation, even if validation failed.
            try:
                git(repo, 'worktree', 'remove', '--force', str(worktree))
            except (OSError, subprocess.SubprocessError):
                pass


def save_retirement(repo, state_dir, plugin, name, version, revision):
    head = git(repo, 'rev-parse', 'HEAD').decode().strip()
    diff = changes(repo, head, plugin, name, version, revision)
    patch = state_dir / f'{plugin}-retirement.patch'
    if diff:
        patch.write_bytes(diff.encode('utf-8'))
    if not snapshot(repo):
        pending = f' Патч подготовлен в `{patch.relative_to(repo).as_posix()}`.' if diff else ''
        return f' Снимок bb-config не прошёл проверку.{pending}'
    if not diff:
        commit = git(repo, 'log', '-1', '--format=%h', '-S', revision, head, '--', RULES).decode().strip()
        patch.unlink(missing_ok=True)
        label = f' Коммит `{commit}` уже есть в локальной истории.' if commit else ''
        return f' Запись bb-config уже сохранена, снимок проверен.{label}'
    artifact = f' Снимок проверен. Патч подготовлен в `{patch.relative_to(repo).as_posix()}`.'
    if git(repo, 'status', '--porcelain=v1', '--', *TARGETS):
        return f' В файлах bb-config есть незакоммиченные правки, автокоммит отложен.{artifact}'
    try:
        branch = git(repo, 'symbolic-ref', 'HEAD')
        commit = commit_patch(repo, head, branch, patch, plugin, version)
    except (OSError, RuntimeError, subprocess.SubprocessError):
        return f' Автокоммит bb-config не удалось завершить.{artifact}'
    patch.unlink(missing_ok=True)
    return f' bb-config обновлён, снимок проверен. Локальный коммит `{commit}` ждёт отправки.'
