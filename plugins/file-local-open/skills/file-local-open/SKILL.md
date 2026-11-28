---
name: file-local-open
description: Open generated server files on an enrolled Mac or Windows PC, or save them to its Downloads.
---

# Open on Desktop

ID: `file-local-open`. One share-style icon beside supported file links in thread
messages, and right-click on the link, open the same menu: «Открыть на компьютере»
(in the app last chosen for that extension, else the system default), «Открыть с
помощью ▸» (the Mac's applications for the type, with icons), «Поделиться ▸» (copy
the file itself to the Mac clipboard to paste into Telegram/Mail/Finder; copy path;
copy name), «Сохранить в Загрузки». Right-click adds «Меню BB…», which hands over to
BB's own file menu (VS Code, Terminal, previews); Shift+right-click opens BB's menu
directly. BB's "Open in" list is core and cannot be extended by plugins (SDK 0.6.132).
Applications come from LaunchServices via in-process JXA `osascript` (no Apple
Events, no permission prompt); cache/Playwright/Puppeteer copies are dropped, one
entry per bundle, ordered by the type (web: browsers then editors; text: editors;
images/PDF/media: viewers; office: office apps), default first. Lists are cached on
the Mac on disk (refresh after 6 h) and prefetched when a file link appears.
Laptop downloads to `~/Downloads/BB Files/open-*/`. Download saves without launching
straight into `~/Downloads/` (Finder-style `name (2).ext` on collision; HTML with
assets goes into its own `~/Downloads/<name>/` folder) and reveals the file in Finder.
PDF links also offer “PDF — по ширине / на Mac”: page-width preview without thumbnails,
zoom selector, Open on Mac and Save to Downloads.

The target computer must be connected. `bb plugin config file-local-open set macHostId <host-id>`
selects it (macOS or Windows; the key keeps its first name). An empty setting selects the
single connected macOS host, or without a Mac the single connected Windows host.
Do not silently choose another computer when several are connected.
On Windows the file opens through the shell's default application for its type, HTML in the
default browser. When the file already is on the target computer, "open" starts the original
file and makes no copy; "save" still copies it to Downloads.

RPC `open` accepts `{path, source:{kind,threadId,environmentId,projectId,
experimental_hostId?}, action:"open"|"save"|"clipboard", app?: <application path from apps>|null}`.
RPC `apps` accepts `{extension}` and returns `{platform, apps:[{id,name,path,
isDefault,browser,icon(base64 PNG 64px)}]}` for the target desktop. Source follows the SDK file opener.
Use `bb plugin rpc inspect file-local-open open --json` for the current schema.
Use `bb plugin rpc call file-local-open open --input-file <file> --json` to execute.
Never put file contents in logs. Host RPC transfers bytes through BB, without SSH
configuration or a public file share. Each save gets a fresh directory; originals
and earlier local copies are preserved.

Supported: PDF, HTML, Office/OpenDocument, Markdown/text/CSV/JSON, common images,
audio/video and ZIP. Max 20 MiB and 300 files per operation. For HTML, relative
src/href/poster, CSS url() and @import, linked local pages, module imports of
scripts and quoted relative asset paths in scripts (fetch, Image, JSON, wasm) are
copied recursively. Broken links and paths or symlinks escaping the HTML directory
are skipped and never copied, as a browser would ignore them; past the limits the
page opens with what fits. A copied page opened in a browser is served from
`http://127.0.0.1:<random port>/<random secret>/…` by the plugin's host worker
on the Mac (files under `~/Downloads/BB Files` only, GET/HEAD, no-store), so ES
modules, fetch() and workers run; the server stops 4 h after the last request.
An editor (BBEdit, VS Code…) gets the file itself. A page already on the target
computer is opened as a file, not served. Root-absolute URLs (`/assets/x`) and
paths built at runtime are not bundled. All operations explicitly target the
configured enrolled Mac, even if clicked from a browser on another device.

Restore: `bb plugin build plugins/file-local-open`, then
`bb plugin install path:<absolute-checkout>/plugins/file-local-open --yes` on the
BB server host; restore macHostId for the new installation. To update a path
installation, build and `bb plugin reload file-local-open`. If an extension is
pinned to another viewer, select this viewer in Settings → File openers.

The thread's composer hosts the plugin bridge: in an archived thread (no composer)
the icon and right-click menu are not offered.

## Каскад подписок

Тред «Каскада подписок»: файл рабочей папки открывается с машины свежей копии (иначе с опорной) по общему пути из паспорта каскада. Явная машина и хранилище треда не меняются; каскад не ответил — как раньше.
