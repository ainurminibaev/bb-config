## What you get

- **`/goal resume` waits for the turn to end.** Sent to a Codex thread that is running, it is held in the thread queue and runs on its own after the current turn. Sending it twice does not queue it twice.
- **`/goal pause` and `/goal clear` mid-turn are refused**, with a short note: press Stop to pause now, or send `clear` when the thread is idle.
- **Idle threads are not touched.** The plugin only acts while a turn is running.

## Why

While a Codex turn is running, BB passes these commands to the model as ordinary text. The model reads them, the Goal does not change, and the command is gone.

## Requirements

BB 0.49 or newer and threads on the Codex provider. One setting: the language of the notes, English or Russian. No stored data: removing the plugin returns BB to its default behavior.
