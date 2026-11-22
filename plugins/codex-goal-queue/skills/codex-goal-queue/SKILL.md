---
name: codex-goal-queue
description: Explain or troubleshoot why /goal resume sent to a running Codex thread is queued, and why /goal pause or /goal clear is refused there.
---
# Codex Goal Queue

Codex's provider runs `/goal resume`, `/goal pause` and `/goal clear` only when
the message starts a turn. Joined to a running turn the text reaches the model,
which cannot resume a Goal, so the Goal keeps its status. A request in plain
words ("resume the goal") is never a command; it always goes to the model.

This plugin answers bb's `message.dispatch` hook for Codex threads only, and
only for a message a person sent that would join a running turn:

- `/goal resume` is queued. The card above the composer reads "Held by Codex
  Goal Queue · выполнится сам после текущего хода Codex". bb sends it by itself
  as soon as the thread settles; it then starts a turn and Codex makes the Goal
  active. Send-now on the card bypasses the plugin and passes the text to the
  model, so the Goal does not resume.
- A second `/goal resume` while one is held is refused: it is already queued.
- `/goal pause` is refused with a message: use Stop, which pauses an active Goal.
- `/goal clear` is refused with a message: send it when the thread is idle, or
  run `bb thread clear-goal <thread>`.

A message from another thread is left alone: bb prefixes it with a sender
note, so Codex never reads it as a command, running or idle.

Everything else proceeds unchanged, including other `/goal ...` text, messages
with attachments and every other provider. If the check fails the message is
sent unchanged and a warning is logged (`bb plugin logs codex-goal-queue`).

No settings and no commands. Inspect held messages with
`bb thread queue list <thread>`. Remove the plugin once bb's Codex provider
runs Goal commands during a turn itself; until then it must stay enabled for
the queueing to apply.
