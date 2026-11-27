---
name: git-thread-provenance
description: Link a new Git commit or pull request to its current BB thread, report a successful push, or look up a BB-Thread marker.
---

# Git Thread Provenance

Follow repository and user rules about what may be published. Use the shell's
`BB_THREAD_ID` only when it matches the current thread ID supplied in the
session instruction. If it is absent, invalid, mismatched, or forbidden by the
repository, omit the marker.

- **New commit you author.** Add one `BB-Thread: thr_…` line to the final Git
  trailer block. Use `git commit --trailer "BB-Thread: $BB_THREAD_ID"` or put
  the line in the commit message, once. Keep required trailers such as
  `Signed-off-by`. Inspect the new commit with
  `git show -s --format=%B HEAD | git interpret-trailers --parse`.
- **New PR you create.** After the human-readable reason, add a blank line
  and the same standalone line once. Keep the repository's template. Include
  only the thread ID in the marker.
- **Successful push you perform.** In the working BB thread record the
  destination repository, branch or ref, and the full SHA from the confirmed
  result. With multiple ref updates, report each successful one. For a deleted
  ref, state the deletion. Keep remote credentials out of the report.
- **Lookup.** Run `bb thread show <id>` with the reader's BB access, even if
  the thread is archived. In BB use `@thread:<id>` or a link copied from the
  app. Handoff leaves the marker pointing at the original thread.

Leave existing commits and PRs alone when the marker is the only change.
Git hooks, BB buttons, manual Git, and CI are outside this instruction.

## Каскад подписок

Правило действует и в тредах «Каскада подписок» (провайдер `subscriptions-cascade`): они идут нативным Claude Code или Codex.
