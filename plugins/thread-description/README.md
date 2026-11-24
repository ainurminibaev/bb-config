**English** · [Русский](README.ru.md)

# Thread Description

A short description and a recap for every BB thread and subthread.

- **Icon next to the thread title** — what the thread is about. Hover or click: description, recap, refresh, edit.
- **Button by the composer** — a recap of where things stand, above the composer. Collapsed by default; the state is shared between devices; a dot means a new recap.

The description is written from the first task; when that has fewer than 15
words it is rewritten after the first agent reply; afterwards it is refreshed at
most once an hour, when the thread goes idle with new messages. A description
edited by hand is never overwritten.

A hidden BB worker thread writes the text on the source thread's machine, in an
empty personal workspace. Nothing enters your thread's context. The model comes
from settings (Claude Haiku), otherwise another one available on the machine.
Every generation is an ordinary provider request that uses its allowance, and
excerpts of the conversation go to that provider.

Model choice, settings and troubleshooting: `skills/thread-description/SKILL.md`.

```bash
npm ci && npm run typecheck && npm test
bb plugin build . && bb plugin install .
```
