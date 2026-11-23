# Codex Goal Queue

Holds `/goal resume` sent to a running Codex thread until the turn ends, and
refuses `/goal pause` and `/goal clear` there with what to do instead. Without
it BB passes these commands to the model as text and the Goal does not change.

- `/goal resume` mid-turn waits in the thread queue and runs by itself after the turn.
- A second `/goal resume` while one is held is refused: it is already queued.
- `/goal pause` mid-turn is refused: press Stop, which pauses an active Goal.
- `/goal clear` mid-turn is refused: send it when the thread is idle, or run
  `bb thread clear-goal <thread>`.

Only Codex threads and only messages a person typed are affected. On any
internal error the message is sent unchanged.

**Setting:** `language` — `en` (default) or `ru`, the language of the queue
card and refusal notes:

```sh
bb plugin config codex-goal-queue set language ru
```

Behaviour and limits for agents: `skills/codex-goal-queue/SKILL.md`.

## Install

From the BB plugin store (Codex Goal Queue), or directly:

```sh
bb plugin install git:https://github.com/ainurminibaev/bb-config.git@^0.2.0 --subdirectory plugins/codex-goal-queue --tag-prefix codex-goal-queue/ --yes
```

Requires BB 0.49 or newer.

## Develop

```sh
npm ci --include=dev
npm test && npm run typecheck
bb plugin build .
bb plugin install path:"$PWD"   # first time
bb plugin reload codex-goal-queue
```

License: MIT.
