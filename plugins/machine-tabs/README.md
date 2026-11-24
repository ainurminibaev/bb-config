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

## Other plugins' row marks (0.2.4)

Rows draw the marks other plugins register with `experimental_threadRowMetadata`
(for example Limit Guard's low-priority arrow, or its pause mark while work
waits), through the SDK's `experimental_ThreadRowMetadata`, at the right end of
the title next to bb's own status. Nothing changes on rows without marks.

## Marks on a thread's icon from other plugins (0.2.10)

Another plugin can put a small monochrome mark on a thread's icon: over the
project mark (or bb's own icon), larger than the provider glyph, which stays in
its corner. Machine Tabs does not know what a mark means.

- RPC, called through `bb.sdk.plugins.callRpc` (the caller plugin, known from
  `experimental_caller`, owns its marks; app and CLI calls are refused):
  `thread_mark_set { threadId, glyph, tone?, label? }`,
  `thread_mark_clear { threadId }`, `thread_marks_replace { marks: [...] }`
  (all marks of the caller at once). `glyph` is one of a closed set
  (`crown`, `bot`, `link`, `telegram`; extend in `lib/thread-marks.ts`), `tone` is
  `neutral` | `accent` (one calm gold) | `muted`; plugins cannot pass colours.
- 0.2.11: `place` — `corner` (bottom right, the default and the 0.2.10 look) or
  `top` (centred over the icon like a crown on a head; the project mark shrinks a
  little so the pair keeps the icon's place and the row's height); `size` —
  `normal` | `large`. One plugin may set up to two marks per thread, one per place;
  `thread_mark_clear` takes an optional `place`. Calls without these fields work
  as before.
- Marks of a disabled or removed plugin are not drawn; stored data is read
  tolerantly. Tests: `tests/thread-marks.test.mjs`.

Project groups show active Agent Roster threads first (agents, then orchestrators,
newest activity first in each category). All roles fit on the first page, even
when there are more than five. Other threads retain BB's ordering. Last 5 uses
its usual activity order. On desktop its hover-only chevron shares the count's space.
