---
name: offline-quiet
description: Hide or bring back BB's "<machine> is offline" warning for chosen machines (Settings → Machines card and the sidebar link) with `bb offline-quiet`; explain why the warning is or is not shown.
---

# Offline Quiet

The plugin hides BB's offline warning for machines the user listed. The
machine stays in BB, its tab and its threads are unchanged; only the warning
is not shown.

## Commands

```bash
bb offline-quiet status            # the list and every machine with its status
bb offline-quiet add Windows       # stop warning about this machine (name or host ID)
bb offline-quiet remove Windows    # warn again
```

The same list is the plugin setting "Не предупреждать, что эти машины офлайн"
(Settings → Plugins → Offline Quiet): names or host IDs, comma or new line,
any case. Changes reach open windows within a minute, or when the tab becomes
visible again.

## What is hidden

- Settings → Machines: the orange "<machine> is offline" card. With several
  machines in the card only the listed ones disappear; the card goes when all
  of them are listed.
- Sidebar footer: the "<machine> is offline" link. A summary link ("Machines
  offline", "N machines need attention") is hidden only when every machine BB
  warns about is listed.
- "cleanup failed" warnings are never hidden: they need action.

## Limits

It recognizes BB 0.50 English labels and the card's `border-warning-text`
section. If BB changes them, the warning simply shows again; nothing breaks.
Machine Tabs still marks the machine "(offline)" in its tab; that is not a
warning.
