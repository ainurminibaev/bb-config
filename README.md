**English** · [Русский](README.ru.md)

# Mission Control Kit for BB

BB turned into a workstation for developers and founders who run dozens of
agents and orchestrators across several machines. Formerly `bb-config`; the old
address still works.

A set of add-ons for [BB](https://getbb.app), the agentic IDE: machine tabs for
the thread list, a project catalog, proxy management, a voice mode, account
usage indicators and small buttons for existing BB features. The whole set
installs and updates with one command; any component can be left out. You do
not need the author's settings.

Full list with sources and dependencies: [docs/components.md](docs/components.md)
(in Russian).

| Plugin | What it adds | Setup after install |
| --- | --- | --- |
| [Machine Tabs](plugins/machine-tabs) | Machine tabs above the thread list, two-level grouping (project, machine, day), layout-independent search, topic and project filters, "Last 5", project icons | None. A project icon is `.bb/icon.svg` or `.bb/icon.png` in the project root, then `bb machine-tabs icons` |
| [Project Logo](plugins/project-logo) | Picks a shared project icon from its name and first message; keeps existing icons | None; icons are shown by Machine Tabs |
| [Project Catalog](plugins/project-catalog) | A "Projects" tab and `bb catalog`: one card per project and its folders on every machine | None |
| [Menubar Status](plugins/menubar-status) | Agent statuses and limit usage in the macOS menu bar or on the Windows taskbar, with a chat to answer agents | `hostId` and `filePath` in the plugin settings; `install.sh` on the Mac or `install.ps1` on Windows |
| [Proxy Manager](plugins/proxy-manager) | Named proxies, connectivity checks, native Codex routing | Add your own proxies |
| [Project Open](plugins/project-open) | Thread buttons: open the project folder in Finder and a BB terminal | For Finder, a local handler on the Mac |
| [Push Button](plugins/push-button) | A "ask the agent to push" button by the branch; runs no Git itself | None |
| [Thread Account Usage](plugins/thread-account-usage) | Account quota windows of the current thread, separate from token spend | None |
| [Handoff Button](plugins/handoff-button) | A composer button for the original Handoff panel | None (Handoff is in the set) |
| [Code Open](plugins/code-open), [KodaForge Inspector](plugins/kodaforge-inspector) | Open a project's or thread's code in KodaForge with the chat beside it | None (KodaForge is in the set) |
| [Web BB Button](plugins/web-bb-button) | A globe in the left rail that opens BB in the browser | Your public BB address |
| [Open on Desktop](plugins/file-local-open) | Open a file from chat on your Mac or Windows PC, or save it to Downloads; PDF fitted to width | `macHostId` with several desktops |
| [Browser Page](plugins/browser-page) | An agent skill for the built-in browser where Browser Automation does not run (Windows) | None |
| [Image Gen](plugins/image-gen) | Picture generation and editing for every agent: Codex draws itself, other agents call it through Codex on a suitable machine; paid OpenAI API optional | Codex CLI with `codex login` on executor machines |
| [Local Transcribe](plugins/local-transcribe) | Local transcription of recordings with speakers on a Mac GPU or Linux | Executor machines (`workerHosts`), Python and ffmpeg on them |
| [Subthread Autocollapse](plugins/subthread-autocollapse) | Folds expanded subthread lists after 5 minutes | None |
| [Project Machine Setup](plugins/project-machine-setup) | "Connect project" beside a blocked send button | None |
| [Config Updates](plugins/config-updates) | Reports new releases, offers new components to choose and installs the update with one button | The checkout is a BB project on the server (created by the installer) |
| [Plugin Keeper](plugins/voice-mode-keeper) | Keeps fixes for catalog plugins (Needs You, Tokenomics, KodaForge) across their updates; tests and rolls back | None |

Also in the set: the author's [Voice Mode fork](https://github.com/ainurminibaev/bb-plugin-voice-mode)
(voice chat with the thread's agent, Russian speech) with ChatGPT Realtime
Connection, [Codex Project Trust](https://github.com/ainurminibaev/bb-codex-project-trust),
and the catalog plugins the set builds on: Handoff, Needs You, Tokenomics, KodaForge.

## Install the whole set

On the BB server machine (BB 0.49+, Node.js 22+, npm, Python 3.11+, git):

```sh
git clone https://github.com/ainurminibaev/mission-control-kit.git bb-config
cd bb-config
python3 scripts/updates.py apply
```

The command takes the latest stable release, lists the components with a
description and a link to their code (press Enter for all, or give the numbers
to skip), installs them, creates a BB project for the checkout and writes a
local journal. At the end it lists what you have to do yourself (`attention`):
personal sign-ins (Codex for Voice Mode), plugin settings (such as the address
for Web BB Button) and actions on other machines (Menubar Status on the Mac).
Without a terminal prompt: `--yes` installs everything, `--skip id,id` leaves
components out. A repeated run is safe and finishes what a failure left.

## Install one plugin

```sh
git clone https://github.com/ainurminibaev/mission-control-kit.git bb-config
cd bb-config
npm --prefix plugins/machine-tabs ci --include=dev
bb plugin build plugins/machine-tabs
bb plugin install path:"$PWD/plugins/machine-tabs"
```

Replace `machine-tabs` with any plugin folder. The plugin's README lists its
settings and dependencies.

## Updates

Stable versions are published as [GitHub Releases](../../releases) `vX.Y.Z`;
`main` is development. [Config Updates](plugins/config-updates) shows a new
release and an **Update** button: a window with the release's new components
(name, link, description, checkbox), then the plugin applies the update itself
and lists what is left for you. **Ask AI** appears only if something failed. The
same by hand:

```sh
python3 scripts/updates.py apply vX.Y.Z --commit <sha> --repository ainurminibaev/mission-control-kit
```

An update installs missing components of the set and updates older ones,
including forks and catalog plugins. Your settings, secrets, disabled plugins
and excluded components are kept; plugins installed from another source are not
replaced. BB itself never applies plugin updates automatically; when an
external plugin is newer than the version a release was tested with, Config
Updates shows a warning. Leave a component out with
`python3 scripts/bundle.py exclude <id>`. Procedure: [docs/updates.md](docs/updates.md).

## Personal settings and restore

Sources and anonymised examples are in Git. Server addresses, proxies, machine
ids and personal instructions are kept only in the ignored `.local/config/`;
passwords and sign-ins never enter the snapshot (`scripts/snapshot.py`,
`scripts/private_backup.py`). Restoring the author's own installation with its
snapshot is `scripts/restore.py`; see [docs/customizations.md](docs/customizations.md).

## Development

```sh
python3 scripts/privacy_check.py
python3 scripts/privacy_check.py --history
python3 -m unittest discover -s scripts -p 'test_*.py'
```

## License

Own code is [MIT](LICENSE). Dependencies and third-party plugins keep their
licenses and are installed from their own sources.
