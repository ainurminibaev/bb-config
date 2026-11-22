---
name: menubar-status
description: Inspect or resync the agent status feed behind the macOS menu bar item and its hover panel (`bb menubar-status`), or diagnose the panel's chat and usage.
---

# Menubar Status

The Menubar Status plugin writes a small JSON summary of the agents (who needs
the user, who is running and their current step, the last reply of each) to
`status.json` on one machine. Subagents are folded into their top-level thread.
On that Mac, `bb Status.app` shows a count per state and a usage ring in the
menu bar, and a panel on hover: usage per account, the agents, and a chat
column (hover a thread to read it and reply; click it to open it in bb).

The menu item is visible only while BB Desktop (`dev.bb.desktop`) is running.
Quitting BB hides the item and closes its panel; launching BB restores it.
Closing a BB window does not quit BB. The LaunchAgent remains enabled at login
to observe launches, including when BB was not running at login. Workspace
notifications update visibility immediately, with a two-second polling fallback.

If both BB Desktop and the LaunchAgent are running and the feed is fresh,
check menu bar space: macOS can hide a status item when it overlaps the
active app menu. The widget caps its image at 180 points, leaving room for
AppKit margins. It compacts usage labels first and preserves the agent counts
if the usage bars still cannot fit. The hover panel has the usage details.

On a Windows PC the counterpart is `bb Status.exe` (`windows/install.ps1`): a
strip at the left end of the taskbar laid out like the menu bar title (bb, a
symbol and count per agent state, per agent its mark and per account a thick
5-hour and a thin weekly bar over the machines' initials, one reset timer), and
the same panel above it on hover, in a WebView2 window of its own. Pointing does
not take the keyboard; a click in the panel does, so a reply can be typed.
`install.ps1 -Ui tray` gives a notification-area icon instead. `filePath` is then
a Windows path such as `C:/Users/example/AppData/Local/bb-menubar/status.json`.
A limit bb has no figure for (a missing 5-hour window) gets no bar and shows as
"нет данных" in the panel: check `bb settings usage --refresh --json` before
looking for a fault in the client. `windows/test-render.ps1` draws the strip for
made-up data, `windows/test-hover.ps1` checks hover and focus with the real pointer.

- `bb menubar-status show` — print the feed the menu bar would get.
- `bb menubar-status sync` — write the file now.
- `bb plugin rpc call menubar-status chat --input-file <json>` with
  `{"threadId": "..."}` — the conversation the panel shows.
- `send` with `{"threadId", "text"}` — what the reply field does
  (`threads.send`, mode `auto`).
- Settings (`bb plugin config menubar-status set <key> <value>`): `hostId`
  (Mac with the menu bar item), `filePath` (absolute path of `status.json`
  there), `webUrl`, `maxItems`.

The Mac never calls bb. The plugin writes everything to the folder of
`filePath` on that machine: `status.json`, `chats/<thread>.json` (the listed
threads' conversations, rewritten when a thread changes), `usage.json` (every
two minutes), and polls `outbox/` every 1.5 s for the panel's replies and
"open in bb" requests (failures go to `errors.json`). Since 0.3.3 a panel
request is carried out only for a thread the panel currently lists; any other
thread id is refused into `errors.json`. The local helper
(`macos/server.py`, LaunchAgent `dev.bb.menubar`, 127.0.0.1:47615,
token-protected) only reads those files and queues requests; the app is
LaunchAgent `dev.bb.status`. A reply that never shows up: check the plugin log
(`bb plugin logs menubar-status`) and `errors.json`. Install or update the Mac
side with `zsh install.sh` in `macos/` (needs `swiftc`).
