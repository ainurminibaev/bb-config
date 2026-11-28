---
name: thread-account-usage
description: Inspect or troubleshoot the account quota rings and reset-credit badge in the BB thread header and sidebar.
---

# Thread account usage

The header groups account and machine into one two-line column. Each reported
quota window has its own column: label and used percentage above, time until
reset (↻) below. Keep five-hour before weekly in both columns and rings,
regardless of used percentage; model/other windows follow as fallbacks.
Only reported windows appear; a provider may report one or two.
When Claude's usage endpoint is rate limited, BB returns only the five-hour
and weekly windows; the plugin keeps the last known per-model window (Fable)
of the same login until its reset time.
These are account quotas, separate from the adjacent Tokenomics thread spend.

`+N` means confirmed available reset credits. Codex credits are read through
its existing CLI and matched by email. Claude reset counts are currently unknown;
a missing badge is not proof of zero. Do not invent a credit count or consume
credits to inspect it. Full details open on hover or click.

Agent logos (Claude, Codex) are BB's monochrome `currentColor` SVGs painted
as a CSS mask in the theme text colour (`.tau-agent-logo`); if a logo is
invisible on a dark theme, check that class rather than the image URL.

The machine under VClaude in «Все аккаунты» is not where its quota is read
(the BB server reads it) but where Claude Code is routed to VClaude: each
machine's host entry `claudeRoute` returns only the host of `ANTHROPIC_BASE_URL`
from `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`, then the
process env), and the server lists machines where it is `vclaude.ru` under
BB's current host name. No machine shown: that machine runs an older bundle or
has no such route. There is no separate VClaude provider — pick Claude Code on
that machine.

VClaude packages run as a queue: a bought package waits until the running one
runs out of limit or term, then its own term starts. The row's date is the end
of the whole queue (latest possible), its tick measures from the running
package's start; the tooltip and the VClaude tab list the queue. Do not read
`nearest_expiry` as the end of the paid term.

Inspect live installation with `bb plugin list --json`. Source, refresh behavior,
identity limitations, DOM anchors and restoration are described in the plugin
README.md. After changing source, run TypeScript, `node --test logic.test.ts`,
`bb plugin build .`, then `bb plugin reload thread-account-usage` from the
installed plugin directory. Build alone does not update the running bundle.

## Каскад подписок

Тред «Каскада подписок»: кольцо показывает квоту текущей ступени (провайдер, машина, аккаунт из паспорта каскада, у шлюза vclaude — пакет VClaude), в снимке есть поле `cascade`. Каскад не ответил — как раньше. Код: `cascade-passport.ts`, `cascade-step.ts`.
