**English** · [Русский](README.ru.md)

# Web BB Button

A globe button "Open BB in the browser" in the left navigation rail, before "More".

It needs your public BB address: set **Публичный адрес BB** (`webUrl`) in the
plugin settings. With an empty `webUrl`, `BB_APP_URL` of the server is used.
Without a valid address the plugin reports BB's standard "needs configuration"
status with instructions. There is no default destination.

Addresses with a login, password or a scheme other than HTTP(S) are refused. The
button uses a server-side redirect to the saved address; personal values stay
in BB settings. Disabling or reloading the plugin removes its observer and link.
After BB updates check the `data-nav-rail-item` selector.

Part of the [bb-config](../../README.md) set: `python3 scripts/updates.py apply` from the repository root installs it with everything else. Check: `node --test plugins/web-bb-button/*.test.ts`.
