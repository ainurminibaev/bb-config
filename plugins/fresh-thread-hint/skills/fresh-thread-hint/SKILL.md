---
name: fresh-thread-hint
description: Explain, tune, or troubleshoot the line above the composer that suggests continuing a large, long-idle Claude thread in a new one.
---

# Fresh Thread Hint

A line appears above the composer of a thread when all of these hold:

- the provider is Claude Code and the thread is idle;
- its context is at least `minTokens` (default 150000);
- at least `idleMinutes` (default 60, the Claude prompt cache lifetime) passed
  since the last `turn/completed` or `thread/tokenUsage/updated` event.

The line says: same task, stay; new task, continue in a new thread. The button
opens the original Handoff panel (plugin `handoff` must be enabled); it does
not hand off by itself. `?` shows why it matters and an estimate; `×` hides the
line until the thread is used again (stored in the browser's localStorage).

The plugin never sends messages, keeps no cache warm, and stores nothing on
the server. The check runs when a thread is shown and every 30 seconds.

## Settings

```bash
bb plugin config fresh-thread-hint                      # show
bb plugin config fresh-thread-hint set minTokens 200000
bb plugin config fresh-thread-hint set idleMinutes 60
```

## Troubleshooting

- No line: check the three conditions with `bb thread show <id>` and
  `bb thread context <id>`; then check that it was not hidden with `×`.
- The button reports that the panel launcher is unavailable: open Hand off
  from the right panel's `+` menu and check that `handoff` is enabled.
- The estimate ("as 20 ordinary messages") is the ratio of Claude API prices
  for a one-hour cache write (2.0) and a cache read (0.1). How a subscription
  counts cache reads is not published, so treat it as an estimate.
- "N% cheaper in a new thread" is `1 − 30000 / context size`: 30000 tokens is
  the assumed size of a thread right after a handoff (`FRESH_THREAD_TOKENS` in
  `logic.ts`). The share of the weekly limit is not shown: the limit's size in
  tokens is not published.
