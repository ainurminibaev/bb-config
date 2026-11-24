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


if __name__ == '__main__':
    unittest.main()
