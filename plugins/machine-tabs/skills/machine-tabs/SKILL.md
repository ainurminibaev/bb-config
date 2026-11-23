---
name: machine-tabs
description: Switch the sidebar's machine tab (filter bb's thread list to one machine, or all) with `bb machine-tabs`.
---

# Machine tabs

The Machine Tabs plugin is a sidebar thread list (Settings → Appearance →
Sidebar: "Thread list + machine tabs"). It renders bb's own thread list and
adds, above it:

- Machine tabs: a tab filters the list to that machine's threads. The selected
  tab is stored on the server and synced to every window.
- A layers button: Group by / Then by (Project, Machine, Day, None) and Sort
  (Last updated, Created, Name). One level is bb's own grouping; with two
  levels the plugin draws the first and repeats bb's list inside each group.
  Day sections are the plugin's, not bb sections.
- A filter field: matches thread titles and group headers (project, machine,
  day), ignoring case and a wrong RU/EN keyboard layout.
- A "Last 5" block: the five most recently updated threads, which also stay
  in their own groups. Parent/child links are preserved, so BB’s original
  expand/collapse controls, child rows and activity indicators also work here.

Project groups automatically sort by their latest visible thread's `updatedAt`
(newest first), including nested projects and projects used as the outer group.
New activity recomputes the order. Saved manual project positions do not override
this automatic order in Machine Tabs; their stored preferences remain intact.
Pinned/Threads placement and other preference events remain native.
Empty projects remain at the bottom; ties
keep BB's existing project order. This does not change thread row sorting or
the order of machine/day groups. Last 5 stays above the main list.

Threads in a project show its two-letter badge before the title, except when
the list is grouped by project.

The funnel button in the search field opens a row with two filters, topic and
project. They combine with the machine tab and the search (archive and message
results included) and also narrow Last 5. A topic is guessed locally from
Russian or English words in the thread title; a title with no match is
"Обсуждение". While a filter or a search is active the row shows "7 из 24":
threads shown out of the tab's total; ancestors kept for a matching child count
as shown. Filters last for the page session and are not a stored preference.
Each filter is a chip with its own list (no system select): choices are sorted
by the threads they would leave, each with its count, and a search field
appears when there are eight or more. The funnel is hidden until the search
field is hovered or focused, and stays visible while a filter is on.
Thread search, archive title search and the filter lists also match across
alphabets by transliteration ("маруся" finds `marusya`); message-text search
is BB's own and does not.

The plugin setting `rowMark` chooses the mark before a thread title: `project`
(the project's image or letters), `topic` (the guessed topic's icon) or `ask`
(default: project marks, plus a chooser with previews once per page load when the
list first shows marked rows, and when the filter row is opened). Project group headers always show the project mark. Change it
with `bb plugin config machine-tabs set rowMark <ask|project|topic>`; do not
pick it for the user unasked.

- `bb machine-tabs list` — machines; `*` marks the active tab.
- `bb machine-tabs select <machine-id|all>` — switch the tab.

Switch back to bb's plain list with
`bb settings ui set sidebar.threadListProvider '"thread-list/thread-list"'`.

The `Classic | Custom` text buttons beside New thread switch the actual
`sidebar.threadListProvider`: Classic selects the installed built-in
`thread-list/thread-list`; Custom restores `machine-tabs/machine-tabs`.
The control stays available in both views. It preserves Machine Tabs settings
and follows BB's server-synced selection in every window. Classic uses the
current BB version, including future updates, with existing native list
preferences and other plugins still active. It does not freeze an old version
or disable all customizations. If the header anchor changes after a BB update,
use Settings → Appearance → Sidebar or the CLI command above.

During BB startup, Custom waits for the built-in Thread List automatically.
The waiting message clears when the list is ready. If BB reports Thread List
is disabled or failed, check it in Settings → Plugins.

## Project menu

A folder button inside the "Поиск тредов" field, beside the funnel, appears on
hover. Hovering it opens a compact project list (search, quick filters by thread
state, projects ordered by latest thread activity with state counts, bb's own status icons). Clicking a
project scrolls the sidebar to its group and flashes it; the arrow on a row, or a
long rest on it, shows the project's threads, and clicking one opens it and flashes its row. There is no
CLI or setting for it. If a click does not scroll, the list is not grouped by
project (rows need `data-sidebar-project-id`); the menu then opens the project.

Subthreads (0.2.8): chips count threads of all levels (tooltip: top-level vs
subthreads, number of projects); a project row counts top-level threads and marks
a state present only in subthreads with "↳". In a project's thread list a running
thread shows its current turn's duration, and the subthread fold button carries the
descendants' top state and count. In the sidebar a parent with unfinished
subthreads gets a quiet "↳⟳1"/"↳✕2" mark. A subthread is never counted as unread
(0.2.9): bb marks unread only on top-level threads, so an unread child would draw
"↳●1" with no matching row mark. A thread in error always shows ✕ (0.2.16): bb's own
row draws a read error with no mark and an error with a queued message as a clock, so
the thread list shows ✕ instead and the sidebar row gets an extra ✕ at its right edge;
otherwise the project's "Ошибки" count would have no visible match. Turn start comes from RPC
`turn_started` (`bb plugin rpc call machine-tabs turn_started` with
`{"threadIds":[...]}`), cached 30 s, only for running threads while the menu is open.

The search row stays pinned at the top of the sidebar while the list scrolls.

## Project images

A thread row and a project header show the project's mark: two letters, or
the project's own image when its root holds one of `.bb/icon.png`,
`.bb/icon.svg`, `favicon.png`, `favicon.svg`, `favicon.ico` (first found, up
to 256 KB). Since 0.2.18 every image is drawn as a one-colour silhouette in
the theme's muted text colour, so all marks share one tone whatever the
file's colours (`currentColor`, black, a coloured plate); a plate keeps its
shape and its contrasting lines are cut out. An image that cannot be read is
drawn grey as before. They are re-read every five minutes;
`bb machine-tabs icons` re-reads them now and lists the projects that have one.


### Cross-project child views

In project grouping, a child owned by another project also appears in its own
project section. The original parent tree remains intact. Both occurrences use
the same thread ID, native row actions, navigation and collapse state. No
threads are copied or reparented. Supplemental rows are non-sortable to avoid
ambiguous drag operations; drag the original tree occurrence when needed.
Supplemental rows follow the project's sort and count toward its pager.
A pinned thread and its children are shown the same way: under Pinned and
also in the thread's own project section, so a project whose only threads are
pinned is not treated as empty.
The adapter matches semantic native renderer props and must be verified after
BB updates. Verified with Show empty projects enabled (the current default);
when disabled, BB can omit a section before this renderer is reached.

Rows also show other plugins' row marks (`experimental_threadRowMetadata`), such as
Limit Guard's arrow for a low-priority thread, at the right end of the title.

## Marks on thread icons from other plugins (0.2.10)

Plugins put a monochrome mark on a thread's icon through Machine Tabs' RPC
(`thread_mark_set`, `thread_mark_clear`, `thread_marks_replace`; glyph from a
closed set incl. `telegram`, tone `neutral` | `accent` | `muted`, place `corner` |
`top`, size `normal` | `large`; up to two marks per thread per plugin, one per
place). `top` sits over the project mark like a crown; `corner` bottom right. The
provider glyph keeps its corner. Marks of disabled plugins are not drawn.
