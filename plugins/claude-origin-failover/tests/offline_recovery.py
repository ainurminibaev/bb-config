"""Offline crash/retry experiment. No BB backend, credentials or network."""
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path


class InterruptedTool(Exception):
    pass


class Stand:
    def __init__(self, folder):
        self.log = folder / 'effects'
        self.db = sqlite3.connect(folder / 'state.sqlite')
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS quotas(account TEXT PRIMARY KEY, reset INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS actions(thread TEXT, call TEXT, payload TEXT NOT NULL,
          result TEXT, PRIMARY KEY(thread,call));
        """)

    def limit(self, account, reset):
        with self.db:
            self.db.execute("""INSERT INTO quotas VALUES (?,?)
              ON CONFLICT(account) DO UPDATE SET reset=max(reset, excluded.reset)""",
                            (account, reset))

    def route(self, members, now):
        held = {r[0] for r in self.db.execute('SELECT account FROM quotas WHERE reset > ?', (now,))}
        return next((host for host, account in members if account not in held), None)

    def append(self, thread, call, line, *, allowed, crash=False):
        if not allowed:
            raise PermissionError
        payload = json.dumps(['append', line])
        with self.db:
            created = self.db.execute('INSERT OR IGNORE INTO actions VALUES (?,?,?,NULL)',
                                      (thread, call, payload)).rowcount
        if not created:
            old, result = self.db.execute('SELECT payload,result FROM actions WHERE thread=? AND call=?',
                                          (thread, call)).fetchone()
            if old != payload:
                raise ValueError('tool call id reused with different input')
            if result is None:
                raise InterruptedTool('effect unknown; inspect origin before resuming')
            return result
        with self.log.open('a') as f:
            f.write(line + '\n')
        if crash:
            raise InterruptedTool
        with self.db:
            self.db.execute('UPDATE actions SET result=? WHERE thread=? AND call=?',
                            ('appended', thread, call))
        return 'appended'


class Recovery(unittest.TestCase):
    def test_restart(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            a = Stand(root)
            members = [('origin', 'a'), ('alias', 'a'), ('remote', 'b')]
            self.assertEqual(a.route(members, 0), 'origin')
            a.append('t', '1', 'first', allowed=True)
            a.limit('a', 10)
            a.db.close()
            b = Stand(root)
            self.assertEqual(b.route(members, 1), 'remote')
            self.assertEqual(b.append('t', '1', 'first', allowed=True), 'appended')
            with self.assertRaises(ValueError):
                b.append('t', '1', 'changed', allowed=True)
            with self.assertRaises(PermissionError):
                b.append('t', '2', 'denied', allowed=False)
            with self.assertRaises(InterruptedTool):
                b.append('t', '3', 'second', allowed=True, crash=True)
            b.limit('b', 20)
            self.assertIsNone(b.route(members, 9))
            b.db.close()
            c = Stand(root)
            self.assertEqual(c.route(members, 10), 'origin')
            with self.assertRaises(InterruptedTool):
                c.append('t', '3', 'second', allowed=True)
            self.assertEqual(c.log.read_text().splitlines(), ['first', 'second'])
            c.db.close()


if __name__ == '__main__':
    unittest.main()
