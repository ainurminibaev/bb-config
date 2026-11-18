---
name: voice-mode-keeper
description: Inspect how customizations of catalog plugins (Voice Mode edits, Needs You and KodaForge fixes) are kept across their updates, or diagnose a compatibility warning.
---

Voice Mode Keeper supports the catalog installation and a reviewed fork. For the catalog it checks after
updates, stages exact source edits, runs upstream regression tests, typechecks
and builds before activation. It never enables a disabled Voice Mode or changes
credentials, subscriptions, API billing or routes.

Inspect: `bb plugin rpc call voice-mode-keeper status --json` and
`bb plugin logs voice-mode-keeper`. An attention state means the catalog plugin
remains available without unverified customizations. Do not claim all future
versions are compatible. Every new release is attempted (anchors may move or be
reformatted but must be unique); failed validation keeps the release unmodified
and requires adapting the patch. The status also lists `kept`: Needs You and
KodaForge fixes checked and applied by `patch_keeper.py` with a staged build
and rollback. Test with `python3 plugins/voice-mode-keeper/test_patch_keeper.py`.

Source and recovery: `plugins/voice-mode/auto_update.py`, `changes.json` and
the keeper plugin in the bb-config checkout. The worker uses pinned packages
from the keeper's node_modules, no network install during upgrades. Keep those
packages installed with npm ci when restoring. Test using
`python3 -m unittest discover -s plugins/voice-mode -p test_auto_update.py`.

Do not log or snapshot credential files, audio or conversations. The keeper
stores only a fixed allowlist of nonsecret preferences and compatibility status.
Its recovery journal and source/build backups are private ignored files.

Voice waiting policy: after send_to_agent succeeds, acknowledge once and wait for
its result. Pending work is not evidence of missing context. Presence stays local;
status uses get_agent_status, whose active/starting result excludes old output.
Check the installed patch with `python3 plugins/voice-mode/apply.py --check`.
Apply with `python3 plugins/voice-mode/auto_update.py` (staged tests/build, then reload;
ends the current voice session). The model's spoken wording still needs a live check.

The personal fork uses native BB release updates: its repository and compatible
range are in `plugins/voice-mode/fork.json`. Keeper skips source patching for that
channel and accepts newer stable versions in range. It does not pin file hashes.
Other kept plugins continue normally. Use `switch_to_fork.py --check` / `--apply`
for the one-time migration; configured Voice Mode secrets cause a safe refusal.
Subsequent fork updates use BB's Plugins updates or `bb plugin update voice-mode`.

KodaForge workspace tab actions are staged after the base catalog fixes.
Verify the live source with `python3 scripts/kodaforge_workspace_tabs.py --check`.
Right-click a workspace tab to keep only that tab or close all workspaces.
Close all appears only in the tab context menu.
