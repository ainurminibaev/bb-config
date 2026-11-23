#!/usr/bin/env python3
"""Observe BB queues across projects; alert only, never send/retry/stop turns.

One `bb thread queue list` per run; schedule it every 5 minutes, not every minute.
"""
import json
import os
from pathlib import Path
import subprocess
import time


def bb(*args):
    p = subprocess.run([os.environ.get('BB_CLI') or 'bb', *args, '--json'],
                       capture_output=True, text=True, timeout=30)
    if p.returncode:
        raise RuntimeError('BB CLI failed: ' + ' '.join(args[:3]))
    return json.loads(p.stdout)


def suspicion(row, now):
    if row.get('sendAt') or row.get('state') == 'claimed':
        return None
    reason = (row.get('waitingOn') or {}).get('kind')
    age = now - row['createdAt']
    if reason in ('interaction', 'time', 'superseded', 'plugin', 'provisioning', 'host-offline'):
        return None
    if row.get('state') == 'failed_exhausted' and age >= 120000:
        return 'failed_exhausted'
    if reason == 'turn-starting' and age >= 300000:
        return 'turn-starting'
    if reason == 'thread-busy' and age >= 900000:
        return 'thread-busy'
    return None


def main():
    directory = Path(os.environ['MONITOR_STORAGE'])
    directory.mkdir(parents=True, exist_ok=True)
    state_path = directory / 'state.json'
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    now = int(time.time() * 1000)
    rows = bb('thread', 'queue', 'list')
    grouped = {}
    for row in rows:
        grouped.setdefault(row['threadId'], []).append(row)
    records = []
    for thread_id, queue in grouped.items():
        # Queue rows alone decide whether anything looks stuck. `bb thread show`
        # starts a whole CLI process, so it runs only for a thread that is about
        # to be reported, never for every thread on every run.
        # Drop message text, attachment paths, titles and failure text entirely.
        metadata = [{'id': q['id'], 'createdAt': q['createdAt'], 'state': q.get('state'),
                     'waitingOn': (q.get('waitingOn') or {}).get('kind'),
                     'scheduled': bool(q.get('sendAt'))} for q in queue]
        previous = state.get(thread_id, {})
        snapshot = {'queue': metadata}
        if snapshot != previous.get('snapshot') or now - previous.get('recordedAt', 0) >= 900000:
            records.append({'at': now, 'thread': thread_id, **snapshot})
            previous.update(snapshot=snapshot, recordedAt=now)
        suspects = [(q, suspicion(q, now)) for q in queue]
        suspects = [(q, why) for q, why in suspects if why]
        if suspects and now - previous.get('notifiedAt', 0) >= 1800000:
            thread = bb('thread', 'show', thread_id)['thread']
            if thread.get('archivedAt') or thread.get('deletedAt'):
                state[thread_id] = previous
                continue
            status = thread['status']
            row, why = min(suspects, key=lambda pair: pair[0]['createdAt'])
            minutes = (now - row['createdAt']) // 60000
            body = f'Сообщение ждёт {minutes} мин; причина: {why}, статус: {status}. Проверка без перезапуска.'
            result = bb('push-notifications', 'send', '--title', 'BB: проверь очередь треда',
                        '--body', body, '--thread', thread_id)
            previous['notifiedAt'] = now
            records.append({'at': now, 'thread': thread_id, 'alert': why, 'status': status,
                            'ageMinutes': minutes, 'channels': result.get('channels', [])})
            print(json.dumps({'thread': thread_id, 'alert': why, 'ageMinutes': minutes}))
        state[thread_id] = previous
    # Preserve only compact metadata for the last 7 days.
    state = {k: v for k, v in state.items() if now - v.get('recordedAt', 0) < 7*86400000}
    for key, value in state.items():
        if key not in grouped and value.get('snapshot', {}).get('queue'):
            records.append({'at': now, 'thread': key, 'queueCleared': True})
            value['snapshot']['queue'] = []
    log = directory / 'observations.jsonl'
    if log.exists() and log.stat().st_size > 2_000_000:
        log.replace(directory / 'observations.previous.jsonl')
    if records:
        with log.open('a') as stream:
            for record in records:
                stream.write(json.dumps(record) + '\n')
    temporary = state_path.with_suffix('.tmp')
    temporary.write_text(json.dumps(state))
    temporary.replace(state_path)


if __name__ == '__main__':
    main()
