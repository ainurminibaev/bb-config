---
name: code-open
description: Diagnose or change the Code Open buttons that open the KodaForge editor for a project or thread with chat on the right.
---

Code Open adds a `</>` button in three places: every project header in the
sidebar (next to New thread), every thread row, and the header of the open thread.

How each is rendered (keep it this way):

- thread row: BB's own thread action (`app.slots.experimental_threadAction`,
  key `code-open/open-code-menu`). BB draws it in the row's quick actions and in
  the thread menus; the plugin does no DOM work for it. It is a quick action only
  while the key is listed in the thread-list preference `rowActions` (max 3 keys):
  `bb thread-list prefs set rowActions '[...]'`.
- open thread header: an injected always-visible icon. BB's `placement: "header"`
  was tried and dropped: it folds into the thread menu in narrow panes.
- project header: injected; BB has no slot there. It contains no editor. A click builds a KodaForge deep link
(`/plugins/kodaforge/forge/<kind>/<id>`), sets KodaForge's own "chat panel open"
localStorage key for that workspace, and navigates there through the history API,
because BB has no cross-plugin navigation call.

Targets:

- thread button: `thread/<threadId>`, so the editor opens that thread's
  workspace on its machine and the right-hand chat is that thread;
- project button: `project/<projectId>`. KodaForge resolves the default
  source's checkout and machine (first source if none is marked default).

While the editor is open the plugin collapses BB's thread list (windows 900 px
and wider) and expands it again when the route leaves KodaForge. It only
restores a sidebar it collapsed itself.

BB can load a new copy of the app bundle without unmounting the old one
(reinstall, reload). Each copy claims `window.__codeOpenOwner`; a copy that is no
longer the owner removes its buttons and stops observing, and a new copy deletes
leftover `[data-code-open]` nodes before mounting. Scans are throttled to one per
200 ms and ignore mutations inside the editor. Version 0.1.0 had neither guard:
stacked copies produced several `</>` buttons per row and slowed the whole UI
until the page was reloaded. Keep both guards, and after reinstalling during
development reload the page before judging the result.

Editor settings: do not override KodaForge's editor settings from here.
Versions 0.3.0-0.3.2 did (smooth scrolling, minimap, sticky scroll) while chasing
a vertical scroll stutter; the cause was `:has()` rules in machine-tabs CSS, found
by measuring frames in the user's own window, not by guessing. 0.4.0 removes the
three stored values once per browser (flag
`code-open:kodaforge-settings-restored:v3`). When something feels slow, measure
in the user's window first (PerformanceObserver `long-animation-frame` plus rAF
intervals, reported through a plugin RPC); a headless browser on the server did
not reproduce it and a background tab on the Mac is throttled.

Requires the `kodaforge` catalog plugin. If KodaForge renames its route, its
scope kinds or its `kodaforge:side:<kind>:<id>:open` key, update `target.ts`
and its tests. Anchors depend on BB's sidebar markup
(`data-sidebar-project-id`, `data-sidebar-row-controls`,
`data-thread-header-pane-actions`); after a BB update verify all three places
in a browser. Project Open still injects its folder and terminal buttons into the same row toolbar.

Build and install: `NODE_PATH=/usr/lib/node_modules bb plugin build .` then
`bb plugin install path:<repo>/plugins/code-open --yes`. Checks:
`npx tsc --noEmit`, `npx vitest run`.
