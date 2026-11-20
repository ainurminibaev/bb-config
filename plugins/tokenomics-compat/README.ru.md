[English](README.md) · **Русский**

# Tokenomics: исправление совместимости

Исправление стороннего плагина Tokenomics 0.2.2 (upstream
[danielbachhuber/bb-plugins](https://github.com/danielbachhuber/bb-plugins/tree/main/tokenomics)):
ответ о лимитах становится корректным JSON. `upstream.json` закрепляет
проверенную ревизию и SHA-256 исходного и исправленного `server.ts`.

Plugin Keeper (`voice-mode-keeper`) накладывает исправление на установленную
копию из каталога после каждого обновления, собирает и перезагружает её, а
если исправление не подходит — возвращает оригинал. Ручная проверка:
`python3 scripts/apply_tokenomics_compat.py`; применение: `--apply`.
