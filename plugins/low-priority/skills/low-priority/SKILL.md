---
name: low-priority
description: Mark a BB thread low priority so new turns in it and its subthreads wait while the subscription limit is above a threshold; inspect or change the mark with `bb low-priority`.
---

# Low Priority

A marked thread, and every thread below it in the parent chain, does not start
a new turn while the watched limit window of its provider is at or above the
thread's percent. The message waits in the thread's queue with the reason
shown, is asked again every 5 minutes and right after the window resets, and
goes out by itself. A steer into a running turn is never held. If limit data is
unavailable, nothing is held.

```bash
bb low-priority on                       # this thread, defaults from settings (60%, 5-hour window)
bb low-priority on --at 50 --window week # 5h | week | any
bb low-priority off                      # held messages go out
bb low-priority status [--thread <id>]
bb low-priority list
```

When the user says "this thread is low priority at N%", run `on --at N` in that
thread. In the UI the same toggle is the row "Неприоритетный тред: вкл/выкл" in
the composer's `+` menu; it uses the defaults.

Defaults: `bb plugin config low-priority set percent 60`, `... set scope
five-hour|weekly|any`. Per-model windows (Fable, Opus) are not watched.

The plugin registers a thread row metadata badge ("низкий · 60%" / "ждёт ·
60%"). bb's own sidebar list shows it when row metadata is on; a custom list
shows it only if it renders `experimental_ThreadRowMetadata`.

Marks are stored in the plugin's kv storage under `low:<threadId>` and are
removed when the thread is deleted.
