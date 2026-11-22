#!/usr/bin/env python3
"""Conservative BB queue watchdog; stores IDs/timestamps, never conversation text."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time


def bb(*args):
    result = subprocess.run([os.environ.get('BB_CLI') or 'bb', *args, '--json'],
                            capture_output=True, text=True, timeout=45)
    if result.returncode:
        raise RuntimeError(f'bb command failed: {args[0:3]} (exit {result.returncode})')
    return json.loads(result.stdout)


def choose_action(thread, queue, state, now):
    if thread.get('archivedAt') or thread.get('deletedAt') or state.get('manual_stop'):
        return None
    if state.get('pending_interactions') or thread.get('status') in ('pending', 'starting', 'stopping'):
        return None
    if state.get('attempts', 0) >= 3 or now - state.get('last_attempt', 0) < 180000:
        return None
    eligible = [q for q in queue if q.get('initiator') == 'user'
                and not q.get('sendAt') and not q.get('systemNotice')
                and q.get('state') != 'claimed'
                and (q.get('waitingOn') or {}).get('kind') in
                ('turn-starting', 'thread-busy', None)]
    if thread.get('status') == 'error':
        # Retry only errors explicitly diagnosed by BB, never a user stop,
        # auth/quota failure, arbitrary tool error, or a merely slow active turn.
        if state.get('error_code') in ('provider_turn_start_deadline', 'provider_turn_start_timeout'):
            return ('retry', None)
        return None
    if thread.get('status') == 'idle' and eligible:
        return ('send', eligible[0]['id'])
    for q in eligible:
        if ((q.get('waitingOn') or {}).get('kind') == 'turn-starting'
                and now - q['createdAt'] >= 180000
                and q['id'] not in state.get('nudged', [])):
            return ('send', q['id'])
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--thread', default=os.environ.get('WATCHDOG_THREAD'))
    parser.add_argument('--state', default=os.environ.get('WATCHDOG_STATE'))
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    if not args.thread or not args.state:
        parser.error('--thread and --state (or WATCHDOG_THREAD / WATCHDOG_STATE) required')
    path = Path(args.state)
    state = json.loads(path.read_text()) if path.exists() else {}
    now = int(time.time() * 1000)
    # First run scans history once. Later ticks fetch only the new bounded pages.
    incomplete = False
    if 'seq' not in state:
        events = bb('thread', 'log', args.thread, '--format', 'json', '--all')
    else:
        events = []
        cursor = state['seq']
        for _ in range(30):
            page = bb('thread', 'log', args.thread, '--format', 'json',
                      '--after-seq', str(cursor), '--limit', '100')
            if not page:
                break
            events.extend(page)
            cursor = max(e['seq'] for e in page)
            if len(page) < 100:
                break
        else:
            # More is waiting: read what was fetched (a manual stop in it must count),
            # but take no recovery action on an incomplete view; the next tick continues.
            incomplete = True
    for event in events:
        kind, data = event['type'], event.get('data', {})
        state['seq'] = max(state.get('seq', 0), event['seq'])
        if kind == 'client/turn/requested' and data.get('initiator') == 'user':
            state.update(manual_stop=False, attempts=0, error_code=None,
                         last_user=event['createdAt'])
        elif kind == 'system/error':
            state['error_code'] = data.get('code')
        elif kind == 'system/thread/interrupted':
            state['manual_stop'] = data.get('reason') != 'provider-turn-idle'
            state['stopped_at'] = event['createdAt']
    if incomplete:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(state))
        return
    thread = bb('thread', 'show', args.thread)['thread']
    queue = bb('thread', 'queue', 'list', args.thread)
    newest = max((q['createdAt'] for q in queue if q.get('initiator') == 'user'), default=0)
    if newest > max(state.get('last_user', 0), state.get('stopped_at', 0)):
        state.update(last_user=newest, manual_stop=False, attempts=0)
    interactions = bb('thread', 'interactions', 'list', args.thread)
    state['pending_interactions'] = any(i.get('status') == 'pending' for i in interactions)
    action = choose_action(thread, queue, state, now)
    if action:
        if args.dry_run:
            print(json.dumps({'dryRun': True, 'action': action, 'status': thread['status']}))
            return
        # Re-read immediately before mutation: don't act on a changed snapshot.
        fresh = bb('thread', 'show', args.thread)['thread']
        if fresh['status'] != thread['status']:
            return
        if action[0] == 'retry':
            retries = bb('provider-retry', 'status', args.thread).get('retries', [])
            if retries:
                return
            result = bb('thread', 'retry', args.thread, '--reason', 'Watchdog: provider turn failed to start')
        else:
            result = bb('thread', 'queue', 'send', args.thread, action[1], '--mode', 'steer')
            state['nudged'] = (state.get('nudged', []) + [action[1]])[-100:]
        state['attempts'] = state.get('attempts', 0) + 1
        state['last_attempt'] = now
        print(json.dumps({'thread': args.thread, 'action': action[0],
                          'delivery': result.get('delivery', 'requested')}))
    stuck = [q for q in queue if (q.get('waitingOn') or {}).get('kind') == 'turn-starting'
             and now - q['createdAt'] >= 300000]
    if stuck and now - state.get('last_warning', 0) >= 1800000:
        print(json.dumps({'thread': args.thread, 'warning': 'queue waiting for turn start >5m; no forced stop',
                          'queued': len(stuck)}))
        state['last_warning'] = now
    if not args.dry_run:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix('.tmp')
        temporary.write_text(json.dumps(state))
        temporary.replace(path)


if __name__ == '__main__':
    main()
