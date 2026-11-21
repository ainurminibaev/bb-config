**English** · [Русский](README.ru.md)

# Config Updates

A BB plugin that reports new stable releases of the bb-config repository and
installs them with one button.

- Checks published GitHub Releases `vX.Y.Z` every six hours and on request.
  Drafts, prereleases and `main` commits do not count; a network error is shown
  as a failed check, never as "no updates".
- **Update** opens a window with the release's new components — name, a link to
  the code, a description and a checkbox (on by default). An unticked component
  is not installed and is not offered again.
- The plugin then runs `scripts/updates.py apply` itself, without an agent: it
  installs missing components of the set, updates older ones (including forks
  and catalog plugins), keeps your settings, secrets and disabled plugins, and
  writes a local journal. The run survives a restart of the plugin.
- The result lists what was installed and updated and what you have to do
  yourself: personal sign-ins, plugin settings, actions on other machines.
- **Ask AI** appears only when something did not work: it opens BB's new-thread
  screen with the task prepared.
- External plugins newer than the version the release was tested with are shown
  as a warning, without blocking their updates.

## Install

Usually installed with the whole set: `python3 scripts/updates.py apply` in a
bb-config checkout on the BB server machine (see the repository README). Alone:
BB 0.49+, Node.js 22+, npm, Python 3.11+ and git on the server; the checkout
must be a BB project.

```sh
npm --prefix plugins/config-updates ci --include=dev
bb plugin build plugins/config-updates
bb plugin install path:"$PWD/plugins/config-updates"
bb config-updates check
```

The button needs the bb CLI path: `BB_CLI` of the server by default, otherwise
the plugin setting. Procedure: [docs/updates.md](../../docs/updates.md).
Checks: `npm test`, `npm run typecheck`.
