---
name: subthread-autocollapse
description: Inspect or tune automatic collapsing of expanded subthread lists in the BB sidebar (`bb subthread-autocollapse`), or explain why a parent thread folded by itself.
---

# Subthread Autocollapse

The server plugin polls every 20 seconds. A parent thread with at least one
active subthread counts as expanded while it is absent from the Thread list
preference `collapsedThreads`. That covers both a manual click and a list that
opened because an agent created a subthread. Its clock starts the first time it
is seen expanded; after the configured delay (default 5 minutes) the plugin adds
it back to `collapsedThreads` through the thread-list `setPreference` RPC, with
`origin: "subthread-autocollapse"`. Collapsing by hand resets the clock.

```sh
bb subthread-autocollapse status   # expanded parents and seconds left
bb subthread-autocollapse run      # check now
bb plugin settings subthread-autocollapse   # enabled, minutes
```

Limits: precision is the poll interval (about 20 s); the timer lives in memory,
so a plugin reload restarts it. Opening a subthread reveals its parent only in
that window (Thread list behaviour) without changing the preference, so such a
reveal is not timed.
