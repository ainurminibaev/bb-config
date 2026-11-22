**English** · [Русский](README.ru.md)

# Open on Desktop (id `file-local-open`)

A small companion plugin for BB: compact laptop and download icons beside
file links in chat. The first copies a server file to the Downloads of your
Mac or Windows PC and opens it. One icon beside the link, or right-click on it,
opens a menu: open, "Open with" (the Mac's apps for the type with their icons,
ordered by type), share (copy the file to the Mac clipboard, path, name) and save. HTML opened in a browser is
served from a local 127.0.0.1 server on the Mac, so its scripts, modules and
fetch() work. The download icon only saves. A file that already is on that computer,
as when bb runs on a single PC, is opened in place without a copy.
Includes a PDF preview fitted to panel width, without the thumbnail sidebar.

Sources remain on their owning machine. Save writes straight to `~/Downloads/`
(`name (2).ext` on collision; HTML with assets in its own folder) and reveals it in
Finder; Open uses fresh directories under `~/Downloads/BB Files/`. SHA-256 verifies bytes. No fork of BB or a bundled plugin.
Uses the supported content-script, composer, file-opener and host RPC APIs.

See [usage and restoration](skills/file-local-open/SKILL.md) for limits and commands.

Validation: `npm ci`, `npm run typecheck`,
`node --experimental-strip-types --test files.test.mjs`, `bb plugin build .`.
