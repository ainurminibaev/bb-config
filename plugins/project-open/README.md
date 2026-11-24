**English** · [Русский](README.ru.md)

# Project Open

Two folder/terminal icons on thread rows and thread headers. Sidebar controls
appear on hover or keyboard focus; header controls stay visible. Both buttons
show a custom tooltip after 100 ms with the action, machine name and full
thread environment path. Destination data comes from BB’s live sidebar and
is refreshed through the thread/environment/host SDK when the tooltip opens. Sidebar shortcuts reserve their measured width only while the native toolbar
is visible (hover, keyboard focus, or an open actions menu). The title truncates
before the native project link and child expander, which stay in normal layout.
A mouse click leaving focus on the expander does not keep empty space after
the pointer leaves. ResizeObserver keeps the reserve current when toolbar sizes
change; idle rows have no extra reserve. Header shortcuts keep their width to avoid shifts. The new icons precede native Open; native Open and the panel toggle
remain adjacent. BB’s sidebar renderer and menus are preserved.

The plugin setting `placement` chooses where the row shortcuts live. `row`
(default) keeps the hover icons described above. `menu` removes them from rows
and registers folder and terminal actions in the thread’s native **…** menu
instead; **Customize actions** there can pin them back to a row through BB’s
own `rowActions` preference (keys `project-open/open-folder` and
`project-open/open-terminal`). Header buttons are shown in both modes.
Switch with `bb plugin config project-open set placement menu`.

The terminal uses BB’s original New tab → Start terminal, scoped to the thread
pane or the selected project host. No separate terminal or SSH UI is implemented.

## Finder on macOS

The optional local `BB Project Folder.app` handles `bb-project-folder://` links.
A local project opens directly in Finder. A remote project is exposed by the
**already installed rclone**, using the existing OpenSSH profile, over WebDAV
on the loopback interface. macOS’s own `mount_webdav` connects the disk; Finder
opens the exact requested directory. No FUSE driver, remote network share,
SSH key copy or new server-side authentication is required. NFS is not used.

The handler accepts only configured host IDs and allowed project roots. The
link carries a host ID, path and request ID, without SSH addresses or credentials.
Configuration and runtime status stay under the client’s
`~/Library/Application Support/BB Project Folder/`, outside this repository.

Source: `macos/open_folder.py`, `macos/handler.applescript`, `macos/install.py`.
Create a private JSON config containing the installed `rclone` path and `hosts`:

```json
{
  "rclone": "/path/to/rclone",
  "hosts": {
    "<local-host-id>": {"mode": "local", "roots": ["/path/to/projects"]},
    "<remote-host-id>": {"mode": "sftp", "sshProfile": "existing-ssh-alias",
      "root": "/remote/projects", "label": "Remote projects", "readOnly": false}
  }
}
```

On the Mac, copy all three source files to one directory, then run:

```sh
python3 macos/install.py --config /private/path/client.json
```

The installer compiles/registers the native app in `~/Applications/`. After
verifying it, enable `finderHelper` in Project Open’s BB settings. BB may ask
for permission to open this application-link scheme on the first click; use
its normal approval UI. The helper is macOS-specific; it does not add a Finder
handler to Windows or phones. Without it the fallback requires BB to offer
Finder/File Manager in its native workspace chooser; unsupported remote folders
produce an explanation rather than silently leaving the neighbour’s menu open.

## Restore and verify

```sh
npm ci --include=dev
npm test
npm run typecheck
python3 -m unittest discover -s macos -p 'test_*.py'
bb plugin build .
bb plugin install . --yes
```

Sidebar controls use the row’s thread ID and resolve its environment at activation,
including its host and worktree. Project groups have no folder/terminal shortcuts.
Machine Tabs is not required for resolving a folder.
Header controls are mounted from the thread’s composer banner scope, then
portalled to its own header. They use the actual thread ID even in split panes.
DOM markers and accessible labels must be rechecked after BB UI updates.
Unmount removes portals/observers and aborts pending UI operations.

To disconnect the remote disk use Finder’s eject action or
`diskutil unmount <handler-support-dir>/Volumes/<label>`. Runtime logs/status
and cached files must not be committed or copied into the settings snapshot.
The handler’s private config must be restored separately; see the repository’s
private customization notes. Disabling the plugin removes the icons without
replacing BB’s original controls.

Connection lifecycle: the macOS helper starts rclone on demand, without a
LaunchAgent. Each configured remote host reuses its existing local server and
mount. After reboot the next activation creates the connection again; it does
not automatically restore Finder windows. Network/VPN interruptions have no
helper watchdog or guaranteed transparent recovery. An unreachable SSH target
requires restored connectivity and may require ejecting/reopening the disk.
The helper neither provides a VPN/proxy route nor maintains an offline project
copy. Every remote host needs an explicit private SSH/root mapping.

On touch clients no sidebar shortcuts are mounted: hidden controls must not
intercept row taps. Header folder shortcuts on iPhone/iPad/Android open BB’s
original New tab file search for that thread, never the macOS URL handler.
The macOS handler is used only on a Mac desktop; other desktop clients use
BB’s native Open behavior.

In KodaForge's Explorer (a build with the `kodaforge:explorer-menu` event) the plugin adds “Открыть в Finder”: a folder opens itself, a file its folder. It needs a Mac and `finderHelper` on.

With handler 0.3.0 and the `finderSelect` setting a file is selected in Finder. After a handler update macOS asks for access once more.
