#!/usr/bin/env python3
"""Keep CLAUDE.md an import of AGENTS.md: a Claude Code PreToolUse hook.

Hook mode (stdin = hook JSON): a Write/Edit/MultiEdit that would leave a
CLAUDE.md with anything except blank lines and `@path` imports is refused
(exit 2) with a hint to put the rules into AGENTS.md.

Setup:  claude_md_guard.py --check   exit 1 if the hook is not installed
        claude_md_guard.py --apply   copy this script to ~/.claude/hooks/ and
                                     register it in ~/.claude/settings.json
        claude_md_guard.py --remove  unregister it (the copied script stays)
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import sys

MATCHER = 'Write|Edit|MultiEdit'
NAME = 'claude_md_guard.py'
HINT = ('CLAUDE.md must contain only imports such as `@AGENTS.md`. Put project rules '
        'into AGENTS.md (read by every agent) and keep CLAUDE.md as the single line @AGENTS.md.')


def only_imports(text):
    return all(not line.strip() or line.strip().startswith('@') for line in text.splitlines())


def resulting_text(tool, data):
    path = Path(data.get('file_path', ''))
    if tool == 'Write':
        return data.get('content', '')
    try:
        text = path.read_text()
    except OSError:
        text = ''
    edits = data.get('edits') if tool == 'MultiEdit' else [data]
    for edit in edits or []:
        old, new = edit.get('old_string', ''), edit.get('new_string', '')
        text = text.replace(old, new) if edit.get('replace_all') else text.replace(old, new, 1)
    return text


def decide(event):
    """Return a refusal message, or None to allow."""
    tool, data = event.get('tool_name'), event.get('tool_input') or {}
    if tool not in MATCHER.split('|') or Path(data.get('file_path', '')).name != 'CLAUDE.md':
        return None
    return None if only_imports(resulting_text(tool, data)) else HINT


def claude_home():
    return Path(os.environ.get('CLAUDE_CONFIG_DIR') or Path.home() / '.claude')


def entry(home):
    return {'matcher': MATCHER, 'hooks': [{'type': 'command',
            'command': f'python3 {home / "hooks" / NAME}'}]}


def ours(group):
    return any(NAME in h.get('command', '') for h in group.get('hooks', []))


def setup(action, home=None):
    home = home or claude_home()
    settings_path = home / 'settings.json'
    settings = json.loads(settings_path.read_text()) if settings_path.exists() else {}
    groups = settings.setdefault('hooks', {}).setdefault('PreToolUse', [])
    installed = any(ours(g) for g in groups) and (home / 'hooks' / NAME).is_file()
    if action == 'check':
        print('CLAUDE.md guard: ' + ('installed' if installed else 'not installed'))
        return 0 if installed else 1
    groups[:] = [g for g in groups if not ours(g)]
    if action == 'apply':
        (home / 'hooks').mkdir(parents=True, exist_ok=True)
        shutil.copyfile(__file__, home / 'hooks' / NAME)
        groups.append(entry(home))
    if not groups:
        settings['hooks'].pop('PreToolUse')
    if not settings['hooks']:
        settings.pop('hooks')
    settings_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = settings_path.with_suffix('.json.tmp')
    tmp.write_text(json.dumps(settings, ensure_ascii=False, indent=2) + '\n')
    tmp.replace(settings_path)
    print(f'CLAUDE.md guard: {action} done in {settings_path}')
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    group = parser.add_mutually_exclusive_group()
    for flag in ('--check', '--apply', '--remove'):
        group.add_argument(flag, action='store_true')
    args = parser.parse_args(argv)
    for action in ('check', 'apply', 'remove'):
        if getattr(args, action):
            return setup(action)
    try:
        message = decide(json.load(sys.stdin))
    except (ValueError, OSError):
        return 0  # Never block an edit because the hook itself failed.
    if message:
        print(message, file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
