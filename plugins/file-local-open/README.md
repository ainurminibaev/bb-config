**English** · [Русский](README.ru.md)

# Open on Desktop (id `file-local-open`)

A small companion plugin for BB: compact laptop and download icons beside
file links in chat. The first copies a server file to the Downloads of your
Mac or Windows PC and opens its default app (on a Mac, HTML explicitly uses
Chrome); the second only saves it. A file that already is on that computer,
as when bb runs on a single PC, is opened in place without a copy.
Includes a PDF preview fitted to panel width, without the thumbnail sidebar.

Sources remain on their owning machine. Save writes straight to `~/Downloads/`
(`name (2).ext` on collision; HTML with assets in its own folder) and reveals it in
Finder; Open uses fresh directories under `~/Downloads/BB Files/`. SHA-256 verifies bytes. No fork of BB or a bundled plugin.
Uses the supported content-script, composer, file-opener and host RPC APIs.

See [usage and restoration](skills/file-local-open/SKILL.md) for limits and commands.

Validation: `npm ci`, `npm run typecheck`,
`node --experimental-strip-types --test files.test.mjs`, `bb plugin build .`.
