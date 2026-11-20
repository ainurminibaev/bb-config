**English** · [Русский](README.ru.md)

# Needs You: BB interface compatibility

A small patch for the third-party Needs You plugin 0.2.1 (upstream
[notpritam/bb-plugin-inbox](https://github.com/notpritam/bb-plugin-inbox), MIT).

The plugin registered `experimental_sidebarAccessory`, which BB ignores since
SDK 0.6.53, so its popup listener and badge stopped mounting. The patch moves
the listener to `experimental_appOverlay` and the badge to
`experimental_useBadge`. It patches neither BB nor its thread list.

Plugin Keeper (`voice-mode-keeper`) applies it to the installed catalog copy
after every update and verifies it; settings, questions and history are kept and
the source stays the managed Git install. Only the diff is stored here.

Manual check: `python3 scripts/apply_inbox_compat.py`; apply:
`python3 scripts/apply_inbox_compat.py --apply` (SHA-256 checked, compare-before-write).
