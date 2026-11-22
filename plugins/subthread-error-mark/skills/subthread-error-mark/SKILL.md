---
name: subthread-error-mark
description: Explain or troubleshoot the red error mark on subthread rows in the BB sidebar, or find which subthreads stand behind a parent's `↳ ⊗ N` error count.
---

# Subthread Error Mark

bb's thread list draws its red error glyph only on unread top-level threads.
A parent row still counts every child whose status is `error` (`↳ ⊗ N`), so
the failing children could not be told apart from healthy ones. This plugin
adds a red ⊗ to the row of each non-archived subthread in status `error`
through the `experimental_threadRowMetadata` slot. It is frontend-only: it
reads the thread the list already passes to the row and makes no requests.

The mark disappears when the subthread leaves `error` (a new turn starts) or is
archived; the parent's count follows the same rule.

Find the failing children from the CLI:

```sh
bb thread list --parent-thread <parent-id> --json | jq -r '.[] | select(.status=="error") | "\(.id) \(.title)"'
```

Then `bb thread messages <id> --limit 3` shows the error (provider limit,
killed process, and so on).

If no mark appears: check `bb plugin list --json` shows `subthread-error-mark`
enabled, and that the row is actually a subthread in `error` (`bb thread show
<id>`). A thread list update that drops or renames the row metadata slot only
hides the mark; the list itself keeps working.
