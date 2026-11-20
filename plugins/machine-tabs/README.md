**English** · [Русский](README.ru.md)

# Machine Tabs (id `machine-tabs`)

BB's own sidebar thread list with a row of machine tabs above it: pick a machine
to see only its threads, with BB's grouping, sorting and menus unchanged.

- **Machine tabs** with thread counts; the selected tab is stored on the server
  and synced to every window.
- **Two-level grouping**: Group by / Then by (Project, Machine, Day, None) and
  sort (Last updated, Created, Name). Project groups follow their latest activity.
- **Search** over thread titles and group headers, ignoring case, a wrong RU/EN
  keyboard layout and the alphabet (`маруся` finds `marusya`).
- **Filters** by topic and project with counts ("7 of 24"), combined with the
  tab and the search.
- **Last 5**: the five most recently updated threads on top; parent/child rows,
  expanders and activity indicators keep working.
- **Project marks**: the project's icon or two letters before a title. A project
  icon is `.bb/icon.svg` or `.bb/icon.png` in the project root, then
  `bb machine-tabs icons`.

Enable it in Settings → Appearance → Sidebar: "Thread list + machine tabs".
CLI: `bb machine-tabs list`, `bb machine-tabs select <machine-id|all>`,
`bb machine-tabs icons`. The mark before titles is the `rowMark` setting
(`ask`, `project`, `topic`). Agent instructions: `skills/machine-tabs/SKILL.md`.

The plugin wraps BB's built-in thread list and depends on its markup; after a
BB update it may need an update too.

## Install

Part of the bb-config set: `python3 scripts/updates.py apply` from the
repository root installs it with everything else. Alone:

```sh
npm --prefix plugins/machine-tabs ci --include=dev
bb plugin build plugins/machine-tabs
bb plugin install path:"$PWD/plugins/machine-tabs"
```

Checks: `npm run typecheck`, `npm test`.
