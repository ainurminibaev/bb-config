**English** · [Русский](README.ru.md)

# Plugin Keeper (id `voice-mode-keeper`)

Automatically preserves the managed Voice Mode catalog installation's personal
customizations. It does not create a fork or supply a voice model.

Every 30 seconds and after startup it detects a changed installed release,
waits for BB's update job to finish, validates the exact source edits in an
isolated copy, runs regression tests and TypeScript, builds, then reloads.
No network package installation happens during validation. The original
catalog release is left untouched if compatibility checks fail. Failed
activation restores the original source/bundle; a journal handles interrupted
activation on the next check. A visible notification and the plugin settings
page report incompatible releases.

The voice, connection mode and other explicitly allowlisted nonsecret
preferences are preserved across releases. Credentials are never accessed or
copied. Same-install preferences changed by the user take precedence over the
cached values. Disabled Voice Mode is not re-enabled.
After successful preservation it updates the private bb-config snapshot.

Any new release is attempted: each edit's source anchor may move or be
reformatted (line breaks and indentation are ignored when matching) but must
still occur exactly once. Whether the result works is decided by upstream
tests, the added regression tests, TypeScript and build in staging; on any
failure the release keeps running unmodified and a notice explains why. This
is a tested compatibility layer, not a guarantee about every future version.

It also checks three catalog plugins with `patch_keeper.py` after startup,
after an update and every 10 minutes. Needs You and KodaForge can use patch
files with `patch --fuzz=2`. Tokenomics uses a single source anchor and version
and checksum checks on the installed catalog copy. A fixed release needs no
changes. The keeper builds the staged copy against installed dependencies
before reloading it. A failed start restores the previous files and bundle.
Tests: `python3 plugins/voice-mode-keeper/test_patch_keeper.py`.
KodaForge shows Close all only in the workspace tab context menu.

Restore from bb-config with `python3 scripts/restore.py --plugins --apply`.
The sibling `plugins/voice-mode` patch directory must remain alongside this
plugin. `npm ci` installs the pinned validation toolchain. No manual reapply
is needed for compatible updates. Inspect `bb plugin rpc call
voice-mode-keeper status --json` and the settings page for the current state.

On a different server, configure the path to its official CLI once:
`bb plugin config voice-mode-keeper set cliPath "$(command -v bb)"`.
The current server's path is stored only in the private settings snapshot.
This is needed because a BB service's PATH need not include the CLI. It is
unrelated to the voice provider's authorization; no credentials are accessed.
