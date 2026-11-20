**English** · [Русский](README.ru.md)

# Subthread Autocollapse

Collapses an expanded list of subthreads in the BB sidebar after 5 minutes
(setting `minutes`), whether you expanded it or it opened by itself for a new
subthread. Uses the Thread list plugin's own RPC (`listPreferences` /
`setPreference`, key `collapsedThreads`).

Part of the [bb-config](../../README.md) set: `python3 scripts/updates.py apply` from the repository root installs it with everything else. Alone: `npm ci && npm test && npm run typecheck`, then
`bb plugin build . && bb plugin install . --yes`. Status:
`bb subthread-autocollapse status`.
