#!/usr/bin/env python3
"""Install this client's URL handler using macOS's own AppleScript tooling."""
import argparse
import json
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', type=Path, help='optional manual records; without it the existing config.json is kept')
    args = parser.parse_args()
    if sys.platform != 'darwin':
        raise SystemExit('This installer is for macOS.')
    config = json.loads(args.config.read_text()) if args.config else None
    if config is not None and (not isinstance(config.get('hosts', {}), dict)
                               or ('rclone' in config and not Path(config['rclone']).is_file())):
        raise SystemExit('Host records must be an object and rclone an existing executable.')
    source = Path(__file__).resolve().parent
    applications = Path.home() / 'Applications'
    applications.mkdir(exist_ok=True)
    destination = applications / 'BB Project Folder.app'
    if destination.exists():
        with (destination / 'Contents/Info.plist').open('rb') as stream:
            if plistlib.load(stream).get('CFBundleIdentifier') != 'app.getbb.project-folder':
                raise SystemExit('Refusing to replace an unrelated application.')
    with tempfile.TemporaryDirectory(prefix='.bb-folder-', dir=applications) as temporary:
        app = Path(temporary) / destination.name
        subprocess.run(['/usr/bin/osacompile', '-o', str(app), str(source / 'handler.applescript')], check=True)
        shutil.copy2(source / 'open_folder.py', app / 'Contents/Resources/open_folder.py')
        info = app / 'Contents/Info.plist'
        with info.open('rb') as stream:
            plist = plistlib.load(stream)
        plist.update(CFBundleIdentifier='app.getbb.project-folder', CFBundleName='BB Project Folder',
                     CFBundleShortVersionString='0.4.0', CFBundleVersion='4',
                     LSUIElement=True, CFBundleURLTypes=[{'CFBundleURLName': 'BB project folder',
                     'CFBundleURLSchemes': ['bb-project-folder'], 'CFBundleTypeRole': 'Viewer'}])
        folder_icon = Path('/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/GenericFolderIcon.icns')
        if folder_icon.is_file():
            shutil.copyfile(folder_icon, app / 'Contents/Resources/Folder.icns')
            plist['CFBundleIconFile'] = 'Folder.icns'
        with info.open('wb') as stream:
            plistlib.dump(plist, stream)
        # Seal the final resources and Info.plist, rather than leaving the
        # original osacompile signature invalid after adding the Python helper.
        subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', '--identifier',
                        'app.getbb.project-folder', str(app)], check=True)
        subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app)], check=True)
        if destination.exists():
            shutil.rmtree(destination)
        shutil.move(str(app), str(destination))
    support = Path.home() / 'Library/Application Support/BB Project Folder'
    support.mkdir(parents=True, exist_ok=True)
    private = support / 'config.json'
    if config is not None:
        private.write_text(json.dumps(config, ensure_ascii=False, indent=2) + '\n')
        private.chmod(0o600)
    subprocess.run(['/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
                    '-f', str(destination)], check=True)
    print('Installed:', destination)
    print('Private configuration:', private)


if __name__ == '__main__':
    main()
