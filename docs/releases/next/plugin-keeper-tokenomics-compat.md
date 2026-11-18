Plugin Keeper 0.2.6 проверяет установленный Tokenomics и исправляет
`usage_limits` в проверенной версии 0.2.2. Скрипт использует уникальный якорь
и сверяет контрольные суммы. Для неизвестной версии Keeper покажет статус
внимания. Проверка на сервере BB

```sh
python3 scripts/apply_tokenomics_compat.py
bb plugin rpc call tokenomics usage_limits --json
```
