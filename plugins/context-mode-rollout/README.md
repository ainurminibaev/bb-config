# Context Mode Rollout

BB plugin that keeps [context-mode](https://github.com/mksglu/context-mode)
installed and set up in Claude Code and Codex CLI on every machine enrolled in
BB, including machines enrolled later.

- `host.ts` runs on each machine: finds `claude`/`codex` in the login-shell PATH,
  installs the pinned npm package if missing or older (no sudo, never
  downgrades), runs `context-mode setup --dry-run` and, when it reports work,
  `setup --yes` plus `doctor`.
- `server.ts` polls `hosts.list()` every 2 minutes (BB has no "machine
  connected" event) and runs the host check for a new or reconnected machine and
  once a day; CLI `bb context-mode-rollout status|check|apply`.
- `mcp-targets.ts` registers only the MCP server for agents context-mode's setup does not
  support: Antigravity CLI (`agy mcp add`), the Antigravity app and Cursor (their user
  `mcp.json`), verified with an MCP handshake.
- `logic.ts` holds the pure decisions, covered by `logic.test.ts`.

```sh
npm ci && npm run typecheck && npm test
bb plugin build && bb plugin install . --yes
```

Settings: `autoInstall` (default true), `version` (default `latest`: newest stable npm
release at least `minAgeDays` old, default 2; or a pinned `X.Y.Z`), `minAgeDays`.
A new target version rolls out to connected machines at once. Each machine installs the newest
allowed release its own Node satisfies (`engines.node`); a release that fails setup/doctor
after an upgrade is rolled back and not offered to that machine again.
