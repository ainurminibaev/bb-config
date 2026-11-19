---
name: project-catalog
description: Find a BB project by meaning (aliases, Russian names, tags, description), read or update its catalog card, check whether its copies on different machines are in sync, and safely pull the thread folder before work (project_sync, `bb catalog pull`, history), with `bb catalog`.
---

# Project Catalog

BB itself stores only a project's name, git remote and folders. This plugin
keeps one central card per project on the BB server: a short description, the
user's notes, category, tags, aliases, links and status, plus the last known
state of every folder of the project on every machine. The same data backs the
**Проекты** tab.

Use the CLI. It prints a few compact lines, so there is no need to load the
whole project list into context.

## Find a project

```sh
bb catalog find манибокс            # Russian spelling finds "Moneybox"
bb catalog find бот калории --limit 5
bb catalog list --category "Продукты"
bb catalog list --machine Tru --attention
bb catalog show <id|name|alias>     # full card; defaults to the current thread's project
bb catalog categories              # with the sidebar group of each
bb catalog group "Продукты" "Работа" # put a category into a group; omit the group to remove it
bb catalog rename-category "Старое" "Новое"   # in every card; the group follows
bb catalog rename-group "Работа" "Клиенты"   # omit the new name to delete the group
```

A project may have up to four categories: pass them comma-separated to
`--category`, the first is primary.

`find` matches names, aliases, tags, category, description, notes and folder
paths; every query word must match. Add `--json` for scripts. When the user
names a project loosely ("проект Манибокс"), run `find` first and use the
returned `proj_…` id with other `bb` commands.

## Describe a project (automatic)

```sh
bb catalog describe [project] --summary "1–2 предложения" --category "Категория" \
  --tags "a,b,c" --aliases "как называют вслух, русские написания" --links "Прод=https://…"
```

`describe` is the agent's write path. It never overwrites a field the user
edited by hand and reports which fields it kept. It never touches the user's
notes. Prefer a category that already exists (`bb catalog categories`).

A thread is asked to run `describe` once when its project has no card, or when
the project's README/AGENTS.md/CLAUDE.md changed and the card is older than 14
days. Nothing runs in the background and no model is called by the plugin.

## Edit on the user's behalf (manual)

```sh
bb catalog set <project> --notes "…" --status paused
bb catalog set <project> --summary "текст пользователя"   # locks summary against describe
bb catalog unlock <project> --fields summary,category      # let describe update them again
```

Use `set` only when the user dictates the text. Fields changed by `set` (or in
the tab) become locked; `--notes` and `--status` are always the user's.

## Copies on machines

```sh
bb catalog sync                 # every project that needs attention
bb catalog sync <project> --refresh
```

The periodic check is read-only: it never fetches, commits, copies or deletes.

- git folder: branch, HEAD, uncommitted and untracked files, unpushed commits,
  commits behind the last fetched upstream, stash.
- folder without git: file count; when the project has folders on two
  machines, their contents are compared by hash and differing files are listed
  with the side that is newer.

Levels: `Расходится` (copies on machines went apart and work could be lost),
`Нужно внимание` (uncommitted or unpushed work, a missing folder, different
commits), `Не проверено` (machine offline or never scanned). A folder without
git on a single machine is a normal state.

Limits: an offline machine shows its last known state with its age. "Behind"
uses the refs from the last `git fetch`. Folders are walked to depth 10 and
4000 files, skipping dependency and build directories; files over 2 MiB are
compared by size. Scans run every three hours, when the tab opens with data
older than 30 minutes, and on demand.

A git repository nested in a folder without git is reported by its own git
state (shown under the folder as `<path>/ — свой git …`) and is not hashed.

When copies on two machines are separate on purpose, the user can mark them
in the card, or run `bb catalog set <project> --independent yes`; they are then
not compared. When only some sub-folders are meant to differ on every machine,
run `bb catalog set <project> --local-paths "folder-a,folder-b"` (relative to
the project root; an empty string clears the list). Unsaved git work inside a
local folder is still reported. Do either only on the user's word.

## Pull before work

```sh
bb catalog pull                 # this thread's folder: git fetch + fast-forward if clean
bb catalog pull --check         # fetch and report only
bb catalog history [project]    # who pulled or checked, where, with what result
```

Agents get the same as the tool `project_sync` (`check_only` optional) and a
standing rule: call it once before the first edit in a project folder. It works
on the thread's own machine and folder (a worktree too). It fast-forwards only a
clean branch that has an upstream. It never merges, rebases, stashes, resets or
pushes. The answer lists incoming commits and the other machines' copies from
the last scan.

| Result | Meaning | What to do |
| --- | --- | --- |
| подтянуто N | fast-forwarded | read the listed commits |
| актуально | nothing new | — |
| не отправлены | local commits not on the server | push them when the work is saved |
| незакоммиченные правки | behind, but edits are present | work on; tell the user the folder is behind |
| разошлись | local and server both have new commits | do not resolve on your own; tell the user |
| нет пары на сервере | a task branch (worktree) | normal; nothing to pull |
| нет связи | fetch failed (network or auth) | tell the user; data may be stale |

A folder without git has its nested repositories handled one by one. A plain
folder itself is never synchronised. The last 40 events per project are kept
and shown in the card section «Синхронизация».

To reconcile a diverged project, read `bb catalog sync <project>`, agree the
direction with the user, and act with the usual git tools.

## Worktrees

```sh
bb catalog worktrees [project] [--no-sizes] [--json]
```

Lists worktree copies BB made for threads, problems first: `папки нет` (record
without folder), `живых тредов нет` (orphaned), `не трогали больше недели`
(idle), `в работе`, `BB скоро удалит`. Sizes come from `du` on each machine and
are cached for an hour. Never delete a worktree or archive threads on your own:
report and let the user decide. BB removes a worktree five minutes after its
last thread is archived; `bb environment cleanup <id>` removes one by hand.
