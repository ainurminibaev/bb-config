**English** · [Русский](README.ru.md)

# Handoff Button

A composer button that opens the **original Handoff panel on the right**.
Closing, choosing the machine and agent, Preview and the handoff itself belong
to the original [Handoff](https://getbb.app/marketplace/handoff) plugin; there
is no extra popup.

`handoff` stays installed from the BB catalog and keeps receiving its updates.
This folder holds only a small UI button. It presses BB's own controls: Show
right panel → New tab → the `plugin-action:handoff:handoff` action. It does not
read or change React state, send the draft, start a handoff or keep history, and
copies no code or data of Handoff.

The BB SDK lets a plugin open only its own panels, so the button is a UI bridge
checked against BB's markup (`data-panel-new-tab`, `data-panel-new-tab-item`,
Handoff's action id). It supports the in-thread and the detached panel. If BB
changes the markup, the button shows an error and Handoff stays available from
the right panel. On narrow screens, where BB hides composer actions, use the
original panel.

## Install

Part of the [bb-config](../../README.md) set: `python3 scripts/updates.py apply` from the repository root installs it with everything else. It needs `handoff` (also in the set). Alone:

```sh
bb plugin install handoff
npm --prefix plugins/handoff-button ci
bb plugin build plugins/handoff-button
bb plugin install path:"$PWD/plugins/handoff-button"
```
