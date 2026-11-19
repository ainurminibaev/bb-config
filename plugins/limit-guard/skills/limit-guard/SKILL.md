---
name: limit-guard
description: Check a thread's subscription limit and work mode (normal, economy, finish), list threads stuck on a limit with handoff suggestions, or diagnose the Limit Guard plugin, its thresholds, notifications and the rules it gives agents.
---

# Limit Guard

The plugin tells Claude Code and Codex agents how much of the subscription
limit their thread's account has used, and what to do about it. Other providers
get nothing (they do not report limits).

- Agent tool `limit_status` (optional `refresh`). Command for people and
  scripts: `bb limit status [--thread <id>] [--refresh] [--json]`.
- Data comes from BB's `sdk.system.usageLimits` for the machine the thread runs
  on and the thread's provider, cached in memory for one minute. Model-specific
  windows (for example "Fable") count only when the thread runs that model.
- The mode follows the fullest relevant window. Normal is below `economyPercent`
  (default 70), economy goes up to `finishPercent` (default 90), and finish is
  everything above. If nothing is known, the mode is unknown and the agent works
  in small saved steps.
- `bb plugin config limit-guard set economyPercent 60` changes a threshold.
  Rules reach a provider session when it is next started.

Every supported session gets short standing rules. Check the limit before large
work and after each finished step. In economy and finish modes, commit and push
the agent's own changes to the current branch after each step; this is a
standing permission from the user. Never force-push, never commit other threads'
files or secrets. In finish mode, start nothing new, save, and write "что
сделано / что дальше / как проверить". When a five-hour window is about to
reset, the tool says provider-retry will resume the thread.

When a turn fails on a subscription limit, the plugin waits up to a minute
for provider-retry's decision and checks the other provider's room on the same
machine. It sends one push notification per thread when the wait exceeds
`notifyAfterMinutes` (default 60) or no retry is queued. `bb limit stuck` lists
waiting threads with ready `bb handoff <id> --to <provider> --briefing` and
`bb provider-retry cancel <id>` commands. A thread leaves the list when it runs
again or is archived. Settings: `onLimit` (`suggest`/`off`),
`notifyAfterMinutes`, `timeZone` (empty means the server's zone). Never hand a
thread off on the user's behalf unless they ask.

Limits: an account pool or a per-thread auth override can make the numbers
belong to the machine's account rather than the thread's; the output says so
when a pool is enabled. The plugin never stops a turn and never switches the
provider itself.
