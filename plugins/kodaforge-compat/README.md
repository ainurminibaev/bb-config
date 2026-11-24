**English** · [Русский](README.ru.md)

# KodaForge: fixes on top of the catalog release

Three fixes for KodaForge (`kodaforge@bb-community`) that Plugin Keeper
(`plugins/voice-mode-keeper/patch_keeper.py`) keeps across its updates. No
plugin sources are copied and there is no fork.

- `editor.patch` — the editor no longer boxes letters that look Latin
  (`unicodeHighlight.ambiguousCharacters`), which marked almost every word of
  Russian text.
- `terminal.patch` — a key press wakes the terminal output poll and keeps it at
  30 ms for 1.5 s, so the echo no longer waits up to 400 ms.
- `tabs.patch`, `workspace-close*.patch` — tabs and the project list show the
  project and machine, **Close all** in the tab context menu, an empty page
  after the last tab is closed.

Check: `python3 scripts/kodaforge_workspace_tabs.py --check`.

The owner's installation uses the fork in `fork.json` (`scripts/plugin_fork.py`); these patches apply only to the catalog release, for example after `rollback`.
