**English** · [Русский](README.ru.md)

# KodaForge Inspector

Open a BB thread, then the editor button `</>` in its header. The first time
the editor opens in a project, the inspector offers two layouts: **Native**
(code in the middle, chat on the right) and **Chat in the centre**. Native is
preselected; until you choose (or after "Later") KodaForge stays native.
**Apply** saves the choice for this project; **Save for all** writes the
`layout` setting (`ask`, `native`, `center`) and clears per-project choices.
Change it later with **View…** in the tab row, in the plugin settings or with
`bb plugin config kodaforge-inspector set layout <ask|native|center>`.

In the centred layout the **AI chat** tab fills the middle; files are on the
left, the Git branch and Terminal in the bottom bar. Both panels stay mounted
when switching. Only the editor page of a thread is affected; ordinary BB chat
and KodaForge's own pages open as usual.

**Auto-open**: turn on `autoOpen` and set `autoOpenThread` (`thr_…`) to open
one chosen thread straight in KodaForge.

## Install

Part of the [bb-config](../../README.md) set: `python3 scripts/updates.py apply` from the repository root installs it with everything else. It needs KodaForge (`kodaforge@bb-community`, also in the set). Alone:

```sh
cd plugins/kodaforge-inspector
npm ci --include=dev && npm run typecheck && npm test
bb plugin build . && bb plugin install . --yes
bb kodaforge-inspector status
```
