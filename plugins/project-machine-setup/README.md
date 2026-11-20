**English** · [Русский](README.ru.md)

# Project Machine Setup

Adds **Подключить проект** immediately before the disabled Enter/send button when a new-thread composer reports **Select an environment.** It opens BB's existing **Environment → Set up on <selected machine>…** flow. The native form offers cloning the project remote or choosing an existing checkout. The button does not submit the draft, change machines, copy uncommitted files, or clone anything by itself.

Works with expanded and compact new-thread composers. No settings, backend, credentials, or data store. There is no fork of BB's forms. The companion uses host DOM markers (`data-app-composer`, `data-new-thread-footer`, `data-promptbox-submit-action`) and English host accessibility labels in BB 0.49. If those contracts change, the shortcut fails closed; native Environment setup remains available. A click waits at most 8 seconds for the selected machine's native setup option. An existing source alone does not guarantee a valid provider/environment; if the native menu has no setup action, it remains open for the user.

## Install or update

```sh
cd plugins/project-machine-setup
npm ci
npm test
npm run typecheck
bb plugin build .
bb plugin install .
```

To update an already installed local copy, build and run `bb plugin reload project-machine-setup`. Remove with `bb plugin uninstall project-machine-setup`.

When cloning on a machine, review the native destination. Git only transfers committed files; local changes, ignored documents, independent nested repositories, and external agent sessions require a separate transfer.
