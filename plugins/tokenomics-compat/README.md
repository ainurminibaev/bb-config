**English** · [Русский](README.ru.md)

# Tokenomics: compatibility fix

A fix for the third-party Tokenomics plugin 0.2.2 (upstream
[danielbachhuber/bb-plugins](https://github.com/danielbachhuber/bb-plugins/tree/main/tokenomics)):
its limits endpoint answers with valid JSON. `upstream.json` pins the reviewed
revision and the original and fixed SHA-256 of `server.ts`.

Plugin Keeper (`voice-mode-keeper`) applies the fix to the installed catalog
copy after every update, builds and reloads it, and restores the original if
the fix does not fit. Manual check: `python3 scripts/apply_tokenomics_compat.py`;
apply: `--apply`.
