# Codex Goal Queue

Holds `/goal resume` sent to a running Codex thread until the turn ends, and
refuses `/goal pause` and `/goal clear` there with what to do instead. Without
it bb passes these commands to the model as text and the Goal does not change.

Behaviour and limits: `skills/codex-goal-queue/SKILL.md`.

```
npm ci --include=dev
npm test && npm run typecheck
bb plugin build .
bb plugin install .        # first time
bb plugin reload codex-goal-queue
```
