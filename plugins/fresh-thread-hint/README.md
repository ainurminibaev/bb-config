# Fresh Thread Hint

Shows one line above the composer of a large Claude Code thread that has been
idle longer than the prompt cache lives: stay for the same task, continue in a
new thread for a new one. The button opens the original Handoff panel; `?`
explains the cost; `×` hides the line until the thread is used again.

No messages are sent, no cache is kept warm, nothing is stored on the server.
Conditions, settings and troubleshooting: `skills/fresh-thread-hint/SKILL.md`.

```bash
npm ci && npm run typecheck && npm test
bb plugin build && bb plugin install .
```
