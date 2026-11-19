# Project Catalog

Adds a **Проекты** tab and a `bb catalog` command: one central card per BB
project (description, the user's notes, category, tags, aliases, links,
status) and the state of the project's folders on every machine.

BB stores only a project's name, git remote and folders, and finds a project
by name. The catalog is kept in the plugin's storage on the BB server, so every
machine, agent and the tab read the same cards.

## What it does

- **Tab.** Search (a Russian spelling finds a Latin name), category chips,
  filters by machine and state, cards grouped by category, and a card page with
  inline editing, per-machine state and the list of differing files.
- **Categories.** A project can sit in up to four categories (comma-separated;
  the first is primary). Categories can be arranged into named groups, shown as
  separate blocks of the sidebar. A group heading filters the whole group.
  Resting the pointer on a category or group for a moment shows a pencil; it
  opens a small editor in place: rename a category and choose or create its
  group, or rename and delete a group (its categories stay, ungrouped).
- **Quick actions.** In a row, on hover, overlaid on its right edge without
  reserving width: recent threads of the project (hover or click), edit, new
  thread. Hidden on touch screens; the panel has the same actions.
- **Applied filters** show as chips under the search field, each with ×, plus
  **Сбросить фильтры**. In the panel: copy path, open the repository,
  check copies, describe with an agent, and one-click category and tag editing.
  **Показать в боковой панели** scrolls the app sidebar to the project's thread
  group and highlights it; it needs a thread list that marks project groups
  with `data-sidebar-project-id`.
- **Two searches.** The field above the list searches projects; while it is
  filled, every sidebar section shows how many matches it holds. The field in
  the sidebar filters the sections themselves.
- **Keyboard.** `/` search, `↑`/`↓` move through the list, `N` new thread in
  the open project, `Esc` closes the panel.
- **CLI for agents.** `bb catalog find|list|show|describe|set|unlock|categories|group|sync|pull|history`.
  Output is a few compact lines; `--json` is available. Commands and limits are
  documented in `skills/project-catalog/SKILL.md`.
- **Automatic description.** A thread working in a project with no card, or
  whose README/AGENTS.md/CLAUDE.md changed while the card is older than 14
  days, is asked once to run `bb catalog describe`. The plugin calls no model
  and runs nothing in the background for this.
- **Manual edits are kept.** A field edited in the tab or with `bb catalog set`
  is locked: automatic description skips it. Notes are never written
  automatically. A lock is removed in the card or with `bb catalog unlock`.
- **Copies on machines.** The host module's scan reports git state
  (uncommitted, unpushed, behind, stash) or, for folders without git, compares
  the contents of copies on two machines by hash. The scan never fetches,
  commits, copies or deletes. Scans run every three hours, when the tab opens with data
  older than 30 minutes, and on demand.

A git repository nested in a folder that is not a repository itself is judged
by its own git state and left out of the file comparison.

Copies that are separate on purpose (for example an experiment in its own
folder) can be marked in the card or with `bb catalog set <project>
--independent yes`; they are then not compared with each other. Sub-folders
that are meant to differ on every machine are listed in the card or with
`--local-paths "a,b"`; unsaved git work inside them is still reported.

- **Safe pull before work (0.4.0).** Every project thread gets the agent tool
  `project_sync` and a rule to call it once before its first edit. On the
  thread's own machine it runs `git fetch` and then only a fast-forward of a
  clean branch that has an upstream. Uncommitted edits, diverged branches, a
  task branch without upstream, no remote or no network change nothing; the
  agent is told why. It lists the incoming commits and the other machines'
  copies from the last scan. A folder without git has its nested repositories
  (two levels deep) handled one by one. `bb catalog pull [--check] [--thread <id>]`
  does the same from a shell.
- **Sync history.** The last 40 pulls and checks per project (machine, thread,
  result) are kept in plugin storage, shown in the card as «Синхронизация» and
  printed by `bb catalog history [project]`.

## Limits

- The plugin never merges, rebases, stashes, resets or pushes. Divergence is
  shown, and a person or agent resolves it deliberately.
- Plain folders are not synchronised; keep such a project on one machine or
  make it a git repository.
- An offline machine shows its last known state.
- "Behind" relies on the refs from the last `git fetch`.
- Folders are walked to depth 10 and 4000 files, skipping dependency and build
  directories; files over 2 MiB are compared by size.
- Project icons come from Machine Tabs when it is installed; otherwise a
  letter is shown.
- Cards live in BB's plugin storage on the server and are covered by BB's own
  backup, not by this repository.

## Install or update

```sh
cd plugins/project-catalog
npm ci
npm test
npm run check
bb plugin build .
bb plugin install . --yes
```

After changing an installed copy: `bb plugin build . && bb plugin reload project-catalog`.
Remove with `bb plugin uninstall project-catalog`; cards stay in BB storage.

Check: `bb catalog list` prints the projects, and the **Проекты** tab opens at
`/plugins/project-catalog/projects`.
