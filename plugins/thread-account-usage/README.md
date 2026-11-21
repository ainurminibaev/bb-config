**English** · [Русский](README.ru.md)

# Thread Account Usage

Shows subscription limits of the thread's account separately from the thread's
token spend.

- **Thread header**: two nested rings with the provider logo, the account and
  machine beside them, and one column per limit window (5h first, then week):
  percent on top, time to reset with `↻` below; exact time on hover. The
  Tokenomics chart "Thread / 24h" stays next to it.
- **Sidebar footer**: two rings and the average use of the 5h and weekly
  windows; `+N` marks pending resets. A red dot means a confirmed exhausted 5h or
  weekly window, never model-specific limits or stale data.
- **Card** on hover (click to pin): every account with short bars for 5h / week /
  model, labels and reset times; machines listed.

The data comes from BB's own account usage; the plugin stores no credentials.
It is also the usage source of Menubar Status. To return to the previous
indicator, disable `thread-account-usage` and enable `usage-tracker`.

Part of the [bb-config](../../README.md) set: `python3 scripts/updates.py apply` from the repository root installs it with everything else. Alone: `npm ci --prefix plugins/thread-account-usage`,
`bb plugin build plugins/thread-account-usage`,
`bb plugin install ./plugins/thread-account-usage --yes`.
Checks: TypeScript and `node --test plugins/thread-account-usage/logic.test.ts`.
