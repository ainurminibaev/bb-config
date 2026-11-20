**English** · [Русский](README.ru.md)

# Menubar Status

Agent statuses and limit usage of your BB in the macOS menu bar or as a strip on
the Windows taskbar.

- The plugin keeps a small status file on one machine: running, waiting and
  finished agents with their current step, plus account usage (from Thread
  Account Usage).
- The macOS item (`macos/`) shows a compact BB icon with counters; its hover
  panel lists accounts with 5h/week usage, agents and a chat on the side where
  you can answer an agent. The Windows widget (`windows/`) shows the same on the
  taskbar.

## Setup

1. Set `hostId` (the machine with the menu bar) and `filePath` (an absolute path
   for the status file) in the plugin settings; until then the plugin reports
   "needs configuration".
2. On the Mac: `zsh install.sh` in `plugins/menubar-status/macos` (needs
   `xcode-select --install`). On Windows: `install.ps1` in
   `plugins/menubar-status/windows`.

Part of the [bb-config](../../README.md) set: `python3 scripts/updates.py apply` from the repository root installs it with everything else. Agent instructions: `skills/menubar-status/SKILL.md`
(`bb menubar-status`). Checks: `npm test`, `npm run typecheck`.
