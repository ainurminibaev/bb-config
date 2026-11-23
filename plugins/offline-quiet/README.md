# Offline Quiet

Hides BB's "<machine> is offline" warning (Settings → Machines card and the
sidebar link) for the machines you list. The machine itself stays in BB.

```bash
bb offline-quiet add Windows
bb offline-quiet status
```

Behaviour and limits: `skills/offline-quiet/SKILL.md`.

```bash
npm ci && npm run typecheck && npm test
bb plugin build && bb plugin install .
```
