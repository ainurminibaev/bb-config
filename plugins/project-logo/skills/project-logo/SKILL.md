---
name: project-logo
description: Добавить, поставить или заменить логотип/иконку проекта, сессии или треда в боковой панели BB; automatically select or create a shared contextual project icon using the project name and first user message.
---
# Project Logo
At the start of each unchecked standard-project thread, call `project_logo_status`.
Use BOTH the project name and the FIRST user message, plus README when useful,
to infer the project purpose. Existing icons win. If absent, choose project-owned
artwork or an authentic official emblem for a clearly identified brand.
For original projects or when no suitable authentic asset exists, CREATE an
original simple SVG symbol based on this context. Do not ask the user to choose
an icon. Use bold monochrome shapes, no text, a transparent background and a
compact composition readable at 20px. Do not approximate existing brand marks.
Author vectors directly; a separate image-generation service is unnecessary.
Call `project_logo_install` with exactly one of:
- `svg`: complete passive self-contained SVG, `sourceUrl`: `generated from project context`.
- `filePath`: relative image path inside the resolved source checkout, `sourceUrl`: source page URL or `project asset`.
PNG and SVG are supported, maximum 256 KiB. The plugin writes via SDK to the
project source host/root returned by status; the agent need not write outside
its workspace. For downloads use a temporary file in that source checkout and
remove only that temporary file afterwards. Active SVG/external references fail
validation. Existing icons are never overwritten; concurrent installs serialize.
Machine Tabs refreshes immediately and displays the shared project image grey.
This image applies to the project and all its chats. A new conversation does
not replace an existing project image; separate per-thread images are unsupported.
Respect explicit instructions to avoid changes. If a host/tool is unavailable,
report the limitation briefly and continue the main task. Missing status does
not mark the thread complete, so a subsequent provider session can retry.
Successful installation or existing-image status completes the current policy
version; old checked-only metadata gets rechecked once after the upgrade.
Instructions arrive at provider-session construction, not through an independent
background AI worker. Already-running sessions may need a runtime restart after
their active turn finishes. No extra threads, account changes, commits or pushes.
Source selection (0.2.1): agent tools and CLI invoked within a thread resolve
its environment through the SDK and select a project source on that machine.
The default source on another machine is not contacted. If there is no source
on the thread machine, the operation fails without writing. The shared icon
lives in the project source root, not a temporary thread worktree. CLI without
a matching project thread keeps the project's default source selection.
## Explicit user request (any time, also after the automatic check)
- «Логотип треду/сессии/проекту», «иконка рядом с названием» mean the shared
  project icon in the sidebar (Machine Tabs) for the project and all its
  threads. A single thread has no own icon; if that is what the user wants,
  clarify the desired behaviour.
- Resolve project, root and machine through BB (`bb status --json`,
  `bb project show <id> --json`: `sources[].path`, `hostId`); never guess a
  home directory or use another project's cwd.
- Source: the user's file or the project's own mark; for an original project a
  simple original SVG without text. Never invent or imitate a third-party brand.
  Prefer a mark without lettering for the small icon; keep SVG vector.
- The `project_logo_*` tools exist only in an unchecked thread; otherwise use
  the CLI below. It never replaces an existing icon: to replace one, write
  `.bb/icon.svg` or `.bb/icon.png` (max 256 KiB) in the source root on that
  machine (`bb file`/`bb terminal` with explicit `--host`/`--machine`), keeping
  higher-priority files unless removal is needed.
- Verify with `bb machine-tabs icons` (project marked `*`); if Machine Tabs is
  not installed, report it instead of installing. Check `git diff`; commit or
  push only on request.

Manual CLI:
```sh
bb project-logo status <project-id>
bb project-logo install <project-id> <relative-image-path> <source-page-url>
bb project-logo create <project-id> '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">...</svg>'
bb machine-tabs icons
```
Files checked in order: `.bb/icon.png`, `.bb/icon.svg`, `favicon.png`,
`favicon.svg`, `favicon.ico`. Images belong in the source project's own backup;
bb-config stores the plugin and recovery instructions, not other project artwork.
