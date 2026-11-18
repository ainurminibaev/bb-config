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
These are account quotas, separate from the adjacent Tokenomics thread spend.

`+N` means confirmed available reset credits. Codex credits are read through
its existing CLI and matched by email. Claude reset counts are currently unknown;
a missing badge is not proof of zero. Do not invent a credit count or consume
credits to inspect it. Full details open on hover or click.

Inspect live installation with `bb plugin list --json`. Source, refresh behavior,
identity limitations, DOM anchors and restoration are described in the plugin
README.md. After changing source, run TypeScript, `node --test logic.test.ts`,
`bb plugin build .`, then `bb plugin reload thread-account-usage` from the
installed plugin directory. Build alone does not update the running bundle.

The provider logo is centered inside the quota rings. Reset credits occupy a separate inline badge in both the header and the footer.
