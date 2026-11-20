#!/usr/bin/env python3
"""Enable the shared BB reminder and repository hook; default is a preview."""
import argparse
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BLOCK = re.compile(r'\[bb-config tracking\].*?\[/bb-config tracking\]', re.S)
# Public rule blocks this repository owns in Custom instructions (others stay personal).
RULE_FILES = ('config/tracking-instructions.txt', 'config/agent-compat-instructions.txt')


def block(rule):
    name = re.match(r'\s*\[([^\]/]+)\]', rule).group(1)
    return re.compile(r'\[' + re.escape(name) + r'\].*?\[/' + re.escape(name) + r'\]', re.S)


def merge_instructions(current, rule):
    pattern = block(rule)
    if pattern.search(current):
        return pattern.sub(lambda match: rule.strip(), current)
    return '\n\n'.join(part for part in (current.strip(), rule.strip()) if part)


def merge_all(current, rules):
    for rule in rules:
        current = merge_instructions(current, rule)
    return current


def rules():
    return [(ROOT / name).read_text() for name in RULE_FILES if (ROOT / name).exists()]


def current_instructions():
    config = json.loads(subprocess.check_output(
        ['bb', 'plugin', 'config', 'custom-instructions', '--json'], text=True))
    return config['values'].get('instructions', '')


def stale(current, rule):
    """An enabled block whose text differs from this checkout's rule."""
    found = block(rule).search(current)
    return bool(found) and found.group(0).strip() != rule.strip()


def outdated(current, all_rules):
    """Blocks to refresh: changed ones, and new blocks once tracking is enabled."""
    enabled = BLOCK.search(current)
    return [r for r in all_rules if stale(current, r) or (enabled and not block(r).search(current))]


LIMIT = 4096


def set_instructions(text):
    if len(text) > LIMIT:
        raise SystemExit(f'Custom instructions would be {len(text)} characters (limit {LIMIT}); '
                         'shorten personal blocks first. Nothing was changed.')
    subprocess.run(['bb', 'plugin', 'config', 'custom-instructions', 'set', 'instructions', text],
                   check=True, stdout=subprocess.DEVNULL)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--check', action='store_true',
                        help='Exit 1 if an enabled reminder is older than this checkout')
    parser.add_argument('--refresh', action='store_true',
                        help='Update an already enabled reminder only; never enable it or touch Git hooks')
    args = parser.parse_args()
    all_rules = rules()
    if args.check or args.refresh:
        current = current_instructions()
        if args.refresh and outdated(current, all_rules):
            set_instructions(merge_all(current, outdated(current, all_rules)))
            current = current_instructions()
        if outdated(current, all_rules):
            raise SystemExit('bb-config blocks in Custom instructions are outdated or missing.')
        print('bb-config blocks in Custom instructions are current (or the reminder is not enabled).')
        return
    print('BB: append/update the bb-config blocks in Custom instructions (all providers/projects).')
    print('Git: set core.hooksPath=.githooks for this repository.')
    if not args.apply:
        print('Preview only. Run with --apply to enable, then snapshot.py --settings-only.')
        return
    current = subprocess.run(['git', 'config', '--get', 'core.hooksPath'], cwd=ROOT,
                             text=True, capture_output=True).stdout.strip()
    if current and current != '.githooks':
        raise SystemExit('Existing hooksPath was preserved: ' + current + '. Chain .githooks/pre-commit manually.')
    # Preserve unrelated global instructions; only replace our marked block.
    set_instructions(merge_all(current_instructions(), all_rules))
    subprocess.run(['bb', 'plugin', 'enable', 'custom-instructions'], check=True, stdout=subprocess.DEVNULL)
    (ROOT / '.githooks/pre-commit').chmod(0o755)
    if current != '.githooks':
        subprocess.run(['git', 'config', 'core.hooksPath', '.githooks'], cwd=ROOT, check=True)
    print('Enabled. The hook checks live BB before commits; it never writes a snapshot or commits automatically.')


if __name__ == '__main__':
    main()
