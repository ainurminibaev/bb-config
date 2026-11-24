---
name: project-open
description: Diagnose Project Open’s Finder folder buttons and original BB terminal shortcuts.
---

Project Open adds hover/focus folder and terminal icons on individual thread
rows on desktop and always-visible icons in thread headers. Touch clients
have no injected sidebar buttons. Desktop rows reserve measured toolbar width only
on hover, visible keyboard focus, or an open native menu. Native child expanders
and project links stay in normal layout; never translate them over the title.
Plain focus after a mouse click must not retain the reserve once the pointer
leaves. ResizeObserver tracks toolbar/trailing widths and is disposed on reload. On mobile the folder button opens BB’s
original New tab file search; never dispatch the macOS app URL there. Both buttons have fast custom
tooltips with the machine name and full environment path. Do not replace BB’s sidebar, menus or terminal.
The setting `placement` (`row` by default, or `menu`) decides where row shortcuts
live: `menu` unmounts the injected row icons and shows the registered actions
`project-open/open-folder` and `project-open/open-terminal` in BB’s native thread
menu, where Customize actions / `rowActions` can pin them. In `row` mode those
actions return no menu item. Change it with
`bb plugin config project-open set placement <row|menu>`; never edit `rowActions` for the user unasked.
Resolve host/path from the selected thread’s environment, never a project source.
Header scope comes from the real thread composer; never infer a thread from
only the URL when split panes are open.

With `finderHelper` enabled, folders use the local macOS `BB Project Folder.app`
application-link handler. It opens local paths directly and mounts configured
remote roots through existing rclone/OpenSSH and native WebDAV, bound to loopback.
It does not use Cyberduck or NFS, and does not click the adjacent Open chooser.
Windows/phones need their own opener; the macOS handler must not be reported as
working on those platforms.

Read README.md and macos/ sources before changing the handler. Keep machine
mappings in private config. Never save keys, credentials, runtime status, caches
or application-link authorization state in public source.

A passing test requires one actual activation, the correct host/path in the
handler status, and verification that Finder shows that mounted path. A menu
opening or a successful mount/stat alone does not prove the folder opened.
Check repeated clicks and native menu state; do not report a stale failed request
as the outcome of a newer successful one.

In KodaForge's Explorer the plugin adds “Открыть в Finder” through that plugin's
`kodaforge:explorer-menu` window event (contract version 1, see its
docs/explorer-menu.md). It shows only on a desktop Mac with `finderHelper` on; a file
opens its folder. The link is built by `finderFolderUrl`; keep that logic in one place.
Without KodaForge nothing changes; if the item is missing, check that KodaForge is the
fork (`bb plugin source kodaforge`) and that `finderHelper` is on.

Selecting the file itself (`open -R`) needs handler 0.3.0 on every Mac and
`bb plugin config project-open set finderSelect true`; older handlers reject the
`select=1` parameter. After a handler update macOS asks again for access to Documents
and network volumes for “BB Project Folder”; until it is answered a folder is shown
selected in its parent after six seconds.
