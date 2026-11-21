**English** · [Русский](README.ru.md)

# Browser Page (id `browser-page`)

bb's Browser Automation plugin drives pages through DevBrowser, which has no
Windows build: on a Windows host `bb browser-automation open` answers
"DevBrowser has no runtime for win32-x64". This plugin gives agents a way to
look at and operate a web page there anyway.

It is a skill plus one dependency-free script, `skills/browser-page/bb-page.mjs`.
The script uses only bb's documented core commands (`bb browser create`,
`acquire`, `connection`, `release`, `close`) to get a hidden tab of the built-in
browser and a private DevTools connection to it, then navigates, reads text,
lists and clicks elements, types, evaluates JavaScript and saves screenshots.
The tab uses bb's browser profile, so pages see the user's signed-in cookies.

Limits: one tab per thread; it must run on the machine whose bb desktop window
holds the browser; a control lease lasts thirty minutes and is renewed by the
next command; no file uploads, downloads or multi-tab flows. Where Browser
Automation works (macOS, Linux), prefer it.

Install: `npm ci --prefix plugins/browser-page --include=dev`, then
`bb plugin install path:<checkout>/plugins/browser-page --yes`.
Check: `node skills/browser-page/bb-page.mjs open https://example.com`,
`… text`, `… close` inside a bb thread.