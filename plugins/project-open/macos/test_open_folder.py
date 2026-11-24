import json
import subprocess
import tempfile
from pathlib import Path, PurePosixPath
import unittest
from unittest import mock
from urllib.parse import urlencode

import open_folder as handler
from open_folder import mounted_folder, parse_request, within


class FolderRequests(unittest.TestCase):
    def test_exact_path_and_host(self):
        url = 'bb-project-folder://open?' + urlencode({'host': 'host-1', 'path': '/srv/Проект #1', 'request': 'req-1'})
        self.assertEqual(parse_request(url), ('host-1', '/srv/Проект #1', 'req-1', None))
        self.assertEqual(parse_request(url + '&select=1'), ('host-1', '/srv', 'req-1', 'Проект #1'))

    def test_invalid_requests(self):
        for url in ['https://open?host=h&path=/srv&request=r',
                    'bb-project-folder://open?host=h&path=/srv/../secret&request=r',
                    'bb-project-folder://open?host=h&path=/srv&request=r&host=other',
                    'bb-project-folder://open?host=h&path=relative&request=r',
                    'bb-project-folder://open?host=h&path=/srv&request=r&select=yes',
                    'bb-project-folder://open?host=h&path=/srv&request=r&select=1&select=1',
                    'bb-project-folder://open?host=h&path=/&request=r&select=1',
                    'bb-project-folder://open?host=h&path=/srv&request=r&command=anything']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                parse_request(url)

    def test_sftp_root_is_confined(self):
        self.assertEqual(within(PurePosixPath('/srv/projects/app'), PurePosixPath('/srv/projects')), PurePosixPath('app'))
        with self.assertRaises(ValueError):
            within(PurePosixPath('/srv/private'), PurePosixPath('/srv/projects'))

    def test_local_symlinks_cannot_escape_projects(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / 'projects'; root.mkdir()
            outside = base / 'outside'; outside.mkdir()
            (root / 'link').symlink_to(outside, target_is_directory=True)
            settings = {'hosts': {'local': {'mode': 'local', 'roots': [str(root)]}}}
            self.assertEqual(mounted_folder('local', str(root), settings), root)
            with self.assertRaises(ValueError):
                mounted_folder('local', str(root / 'link'), settings)
            with self.assertRaises(ValueError):
                mounted_folder('unknown', str(root), settings)

    def test_ssh_options_cannot_be_supplied_as_a_profile(self):
        settings = {'hosts': {'server': {'mode': 'sftp', 'root': '/srv/projects', 'sshProfile': '-oProxyCommand=anything'}}}
        with self.assertRaises(ValueError):
            mounted_folder('server', '/srv/projects/app', settings)


class SelectedFile(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.base = Path(directory.name).resolve()
        self.folder = self.base / 'projects' / 'Отчёты за май'
        self.folder.mkdir(parents=True)
        self.file = self.folder / 'Договор аренды.docx'
        self.file.write_text('x')
        self.config = self.base / 'config.json'
        self.config.write_text(json.dumps({'hosts': {'local': {'mode': 'local', 'roots': [str(self.base / 'projects')]}}}))
        self.commands = []
        self.refuse = False
        self.asking = False
        for patch in (mock.patch.object(handler, 'BASE', self.base / 'support'),
                      mock.patch.object(handler.subprocess, 'run', side_effect=self.run_command)):
            patch.start()
            self.addCleanup(patch.stop)

    def run_command(self, command, **_):
        self.commands.append(command)
        if self.refuse and '-R' in command:
            raise subprocess.CalledProcessError(1, command)
        if self.asking and '-a' in command:
            raise subprocess.TimeoutExpired(command, 6)

    def open(self, path, select=True):
        query = {'host': 'local', 'path': str(path), 'request': 'r-1', **({'select': '1'} if select else {})}
        return handler.open_folder('bb-project-folder://open?' + urlencode(query), self.config)

    def test_selects_the_file(self):
        self.assertTrue(self.open(self.file)['selected'])
        self.assertEqual(self.commands, [['/usr/bin/open', '-R', str(self.file)]])

    def test_an_earlier_link_opens_the_folder_as_before(self):
        self.assertNotIn('selected', self.open(self.folder, select=False))
        self.assertEqual(self.commands, [['/usr/bin/open', '-a', 'Finder', self.folder.as_uri()]])

    def test_a_missing_file_or_a_refusal_of_finder_opens_the_folder(self):
        self.assertFalse(self.open(self.folder / 'нет такого.txt')['selected'])
        self.refuse = True
        result = self.open(self.file)
        self.assertEqual((result['selected'], result['finderPath']), (False, str(self.folder)))
        self.assertEqual(self.commands[-1], ['/usr/bin/open', '-a', 'Finder', self.folder.as_uri()])

    def test_a_folder_is_shown_while_macos_waits_for_an_answer(self):
        self.asking = True
        self.assertEqual(self.open(self.folder, select=False)['state'], 'opened')
        self.assertEqual(self.commands[-1], ['/usr/bin/open', '-R', str(self.folder)])

    def test_files_outside_the_roots_stay_refused(self):
        (self.base / 'projects' / 'link').symlink_to('/etc', target_is_directory=True)
        for path in (self.config, '/etc/passwd', self.base / 'projects/link/passwd'):
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.open(path)
        self.assertEqual(self.commands, [])

    def test_a_remote_file_is_asked_for_exactly(self):
        state = self.base / 'support' / 'State'
        state.mkdir(parents=True)
        (state / 'server.json').write_text(json.dumps({'url': 'http://127.0.0.1:1/p/'}))
        settings = {'hosts': {'server': {'mode': 'sftp', 'root': '/srv/projects'}}}
        answer = mock.MagicMock()
        answer.__enter__.return_value.status = 207
        with mock.patch.object(handler, 'urlopen', return_value=answer) as ask:
            entry = handler.selected_entry('server', Path('/Volumes/x/app'), '/srv/projects/app', 'a b#1.docx', settings)
        self.assertEqual(entry, Path('/Volumes/x/app/a b#1.docx'))
        self.assertEqual(ask.call_args[0][0].full_url, 'http://127.0.0.1:1/p/app/a%20b%231.docx')
        with mock.patch.object(handler, 'urlopen', side_effect=OSError):
            self.assertIsNone(handler.selected_entry('server', Path('/Volumes/x/app'), '/srv/projects/app', 'a', settings))


class AutomaticMachines(unittest.TestCase):
    KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB0000000000000000000000000000000000000000000'

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.base = Path(directory.name).resolve()
        patch = mock.patch.object(handler, 'BASE', self.base)
        patch.start(); self.addCleanup(patch.stop)

    def settings(self, **extra):
        return {'bb': {'self': 'mac', 'machines': {
            'mac': {'name': 'Mac', 'roots': [str(self.base)]},
            'srv': {'name': 'Сервер — (1)', 'roots': ['/srv/a', '/srv/a/nested', '/', '/srv/../etc'], 'hostKeys': [self.KEY]},
            'bare': {'name': 'x', 'roots': ['/srv/a'], 'hostKeys': []}}}, **extra}

    def test_roots_come_only_from_bb(self):
        with mock.patch.object(handler, 'pick_alias', return_value='srv-alias'):
            profile = handler.profile_for('srv', '/srv/a/nested/deep', self.settings())
        self.assertEqual((profile['root'], profile['sshProfile'], profile['hostKeys']), ('/srv/a', 'srv-alias', [self.KEY]))
        self.assertRegex(profile['label'], r'^[\w .-]{1,80}$')
        for path in ('/etc', '/srv', '/srv/ab'):
            with self.subTest(path=path), self.assertRaises(ValueError):
                handler.profile_for('srv', path, self.settings())
        with self.assertRaises(ValueError):
            handler.profile_for('missing', '/srv/a', self.settings())
        with self.assertRaisesRegex(ValueError, 'Open on Desktop'):
            handler.profile_for('bare', '/srv/a', self.settings())

    def test_this_mac_and_manual_records(self):
        self.assertEqual(mounted_folder('mac', str(self.base), self.settings()), self.base)
        manual = {'mode': 'sftp', 'sshProfile': 'mine', 'root': '/srv', 'label': 'Mine'}
        profile = handler.profile_for('srv', '/srv/a', self.settings(hosts={'srv': manual}))
        self.assertEqual(profile, {**manual, 'key': 'srv'})
        bound = handler.profile_for('srv', '/srv/a', self.settings(bindings={'srv': 'chosen'}))
        self.assertEqual((bound['sshProfile'], bound['hostKeys']), ('chosen', [self.KEY]))

    def test_alias_is_matched_by_host_key_not_by_name(self):
        config = self.base / 'config'
        (self.base / 'known').write_text('10.0.0.1 ' + self.KEY + '\n10.0.0.2 ' + self.KEY[:-1] + '1\n[10.0.0.3]:2222 ' + self.KEY + '\n')
        (self.base / 'more.conf').write_text('Host other srv\n')
        config.write_text('Host one\nHost same\nInclude more.conf\nHost *.wild !no\n')
        self.assertEqual(handler.ssh_aliases(config), ['one', 'same', 'other', 'srv'])
        hosts = {'one': ('10.0.0.1', '22'), 'same': ('10.0.0.1', '22'), 'other': ('10.0.0.2', '22'), 'srv': ('10.0.0.2', '22')}
        options = lambda alias: {'hostname': hosts[alias][0], 'port': hosts[alias][1], 'user': 'u', 'userknownhostsfile': str(self.base / 'known')}
        with mock.patch.object(handler, 'ssh_options', side_effect=options):
            self.assertEqual(handler.pick_alias([self.KEY], config), 'one')
            hosts['other'] = ('10.0.0.3', '2222')
            with self.assertRaisesRegex(ValueError, 'bindings'):
                handler.pick_alias([self.KEY], config)
            with self.assertRaisesRegex(ValueError, 'нет SSH'):
                handler.pick_alias(['ssh-ed25519 AAAAnone'], config)

    def test_pinned_connection_and_breaker(self):
        profile = {'key': 'srv-1', 'sshProfile': 'a', 'hostKeys': [self.KEY], 'root': '/srv/a'}
        command = handler.ssh_command(profile)
        self.assertIn('-oStrictHostKeyChecking=yes', command)
        self.assertIn('-oServerAliveInterval=4', command)
        self.assertEqual((self.base / 'State/srv-1.known_hosts').read_text(), 'bb-machine ' + self.KEY + '\n')
        fake = self.base / 'ssh'
        fake.write_text('#!/bin/sh\necho run >> ' + str(self.base / 'runs') + '\nexit 255\n'); fake.chmod(0o700)
        with mock.patch.object(handler, 'ssh_command', return_value=[str(fake)]):
            script = handler.ssh_wrapper(profile)
        for _ in range(3):
            self.assertEqual(subprocess.run(['/bin/sh', str(script), '-s', 'sftp']).returncode, 255)
        self.assertEqual((self.base / 'runs').read_text().count('run'), 1)

    def test_files_and_busy_machine_are_explained(self):
        file = self.base / 'a.txt'; file.write_text('x')
        with self.assertRaisesRegex(ValueError, 'файл'):
            mounted_folder('mac', str(file), self.settings())
        import fcntl
        with (self.base / 'lock').open('a') as one, (self.base / 'lock').open('a') as two:
            fcntl.flock(one, fcntl.LOCK_EX)
            with self.assertRaisesRegex(ValueError, 'ещё выполняется'):
                handler.lock_within(two, 0.3)

    def test_finder_that_does_not_answer_is_refused(self):
        with mock.patch.object(handler.subprocess, 'run', side_effect=subprocess.TimeoutExpired('open', 1)):
            with self.assertRaisesRegex(ValueError, 'Finder не отвечает'):
                handler.show(Path('/tmp'), None)


if __name__ == '__main__':
    unittest.main()
