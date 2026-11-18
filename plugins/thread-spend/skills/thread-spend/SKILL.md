---
name: thread-spend
description: Read local BB per-thread token counts, recent turns and timings, compare threads, or inspect official account quota windows separately.
---

Run `bb thread-spend threads --days 7 --limit 25 --sort tokens --json`. Use `--provider <id>` to filter and `--active` to keep starting or active threads. For turn-level data, use `bb thread-spend thread <id> --days 1 --json`. Omit the ID in the current BB thread. Valid periods are 1–30 days. Sort by `tokens`, `time` or `context`.

Check `turnsWithTokens`, `lowerBoundTurns`, `readLimited` and `listLimited` before interpreting totals. BB can prune historical snapshots, and `null` denotes unavailable measurement. Turn duration is elapsed time between recorded start and finish. `bb thread-spend commands --json` explains why shell timing is unavailable.

The header's «Тред / 24ч» opens turn metrics. Use `bb thread-spend usage-limits --json` for BB's separately reported account quota windows.
