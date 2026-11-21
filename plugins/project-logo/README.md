**English** · [Русский](README.ru.md)

# Project Logo

Gives every BB project a compact icon in the sidebar automatically. At the start
of a thread the agent checks the project's icon; when there is none it picks one
from the project name and the first message: a project-owned mark, an
authentic official emblem when the project is clearly about that brand, or an
original simple monochrome SVG drawn for the project. Existing icons are never
replaced.

The icon is saved as `.bb/icon.svg` or `.bb/icon.png` (up to 256 KB) in the
project root on the machine that holds the project's source, and Machine Tabs is
refreshed. It is shared by the project and all its threads. Nothing is committed
or pushed. Tools for agents: `project_logo_status`, `project_logo_install`.

Displaying icons needs [Machine Tabs](../machine-tabs). Part of the [bb-config](../../README.md) set: `python3 scripts/updates.py apply` from the repository root installs it with everything else.
Checks: `npm test`, `npm run typecheck`.
