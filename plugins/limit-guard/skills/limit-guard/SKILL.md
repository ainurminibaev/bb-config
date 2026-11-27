---
name: limit-guard
description: Check a thread's subscription limit and work mode, understand [limit-guard] messages, list or restore snapshots of unfinished work (refs/wip/bb/*, shadow repositories), list threads stuck on a limit, or diagnose the Limit Guard plugin and its settings.
---

# Limit Guard

The plugin keeps unfinished work from being lost when a subscription limit
cuts a turn. **The plugin saves, not the model**: a cut turn cannot save
anything itself.

## For an agent

- A `[limit-guard] …` message during your turn means the mode changed.
  - Economy: work in short finished steps.
  - Finish: start nothing new, bring the current step to a working state,
    and write «что сделано / что дальше / как проверить».
- Do not commit because of the limit. Commit only finished steps and only
  your own files by name (not `git add -A`). Push as the project's rules say.
  In a shared folder do not switch branches or run stash, reset, pull or
  rebase.
- `limit_status` (or `bb limit status`) shows the windows, the pace («до
  упора ~N мин») and the mode.
- Continuing someone's unfinished work: `bb limit snapshots`, then
  `bb limit restore --from <environmentId>`. It works only on a clean folder
  at the snapshot's base and never moves branches.

## How it works

- Snapshots: a commit of the folder state under `refs/wip/bb/<environmentId>`,
  built through a temporary index. Files, branch and index are untouched.
  - Contents: changed and untracked files; ignored files, files over 20 MB and
    dependency folders are left out. The previous snapshot is the first
    parent. A folder matching its branch drops the local ref.
  - Folders without git get a shadow bare repository in the plugin data
    directory on that machine, with ref `refs/heads/snapshots`.
  - Triggers: any failed turn, entering finish, an idle thread with changes
    (at most every 10 minutes per folder), and archiving a worktree thread.
  - Local by default. With `push-private`, push only to a remote GitHub
    confirms as private (`gh api`) and only when nothing leaving looks like a
    secret: the current files and every file version in all commits not yet on
    origin (earlier snapshots, unpushed commits) are scanned from git objects.
    A secret left in an earlier local snapshot makes the push use a snapshot
    without that chain; a dropped snapshot drops its server ref too.
  - Shadow snapshots refuse home folders, disk roots and BB data, stop at
    200 MB and skip secret-like files; nested repositories get `<ref>--<dir>`.
  - A clean folder drops the old snapshot only when its work is in the branch.
- Thresholds:
  - five-hour window: economy 75%, finish 90%, or by pace when the window
    would be full within 40 / 10 minutes;
  - weekly and model windows: 90% / 97%.

  A poll every 2 minutes sends one note per window and reset into a running
  turn (`steer-if-active`). If the turn has ended before delivery, the plugin's
  own dispatch hook parks the queued note and deletes it (0.9.2), so it never
  starts a new turn and never stays as a failed row with bb's error glyph; only
  if the delete fails is it refused: "ход уже закончился — напоминание о лимите
  не понадобилось".
- Stuck threads:
  - after a rate-limit failure, the plugin waits up to a minute for
    provider-retry's decision;
  - it notifies once when the wait is longer than `notifyAfterMinutes` or no
    retry is queued; an unknown decision with a short wait stays quiet;
  - it suggests another model when only a model window is full, or another
    provider with room;
  - `bb limit stuck` lists these threads;
  - a handoff of a stuck thread (a thread from the `handoff` plugin whose
    first message names it) removes the source's queued retry row.

## Resume after a reset

In finish mode, if work on the task remains, call `limit_resume_after_reset`
(optional `next`: what to do next). It queues a real row «продолжай с того
места» in this thread, scheduled for the reset of the most pressing window
(+30 s); the plugin's hook holds it until then. Do not stop without finishing
the current step. `bb limit resume` does the same from a shell; `bb limit stuck`
lists scheduled resumes.

## Low-priority threads

`bb limit priority normal|low|background [--thread <id>]`; the composer chip and
the '+' menu row «Приоритет треда…» do the same. New turns of a low-priority
thread (and its subthreads) wait while a watched window is above a threshold
that rises from right-after-reset to near-reset; a fully used window holds until
its reset. Change a thread's mode only when the user asks.

## Per-account thresholds

Setting `accountRules`: `<plan or part of the e-mail>: <5-hour>/<weekly>`, several
separated by `;`. Default `$200: 80/85`: on $200 subscriptions (Claude Max 20x,
ChatGPT Pro) economy and the pace check start no earlier than 80% of the 5-hour
window and 85% of the weekly and model windows, and low-priority threads do not
wait below that. Rules only raise thresholds; a thread's own thresholds win.
The Claude plan comes from the machine's `~/.claude.json` (BB's label can be
stale). `bb limit status` names the rule that applied. Empty value — one set of
thresholds for every account.

## Switches

- `.bb/hands-off` in a folder: no snapshots and no pulls there.
- `bb plugin config limit-guard set snapshots local|push-private|off` (local by default).
- Also `steer`, `onLimit`, the six threshold settings, `notifyAfterMinutes`
  `timeZone` and `accountRules`.
- `bb plugin disable limit-guard` turns everything off.

Never hand a thread off, delete snapshot refs or change these settings on the
user's behalf unless they ask.

## Каскад подписок

Тред «Каскада подписок» (`providerId` `agentcli-subscriptions-cascade`): лимиты берутся по текущей ступени из паспорта каскада (RPC `agentcli-subscriptions-cascade.threadStatus`), «финиш» смягчается до экономного режима, потому что каскад сам переходит на другую подписку между ходами. У ступени через шлюз режима нет. Каскад не установлен или не ответил — тред пропускается, как раньше. Код: `cascade-passport.ts`, `cascade-logic.ts`.
