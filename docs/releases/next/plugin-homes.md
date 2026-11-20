У каждого плагина BB теперь один «дом»: `config/plugin-homes.json` (и личный
`.local/config/plugin-homes.json`) сопоставляет ID плагина с `bb-config`,
`project` (плагин из репозитория проекта и команда его установки) или `ignore`.
Старый `config/externally-managed-plugins.json` читается как `ignore`.

Snapshot и restore не копируют код и настройки плагинов `project`/`ignore`;
restore ставит `project`-плагин командой из checkout'а его проекта или
пропускает с сообщением, если проекта на машине нет. `snapshot.py --check`
перечисляет установленные плагины без дома.

Шаг обновляет текст уже включённого напоминания «bb-config tracking»: агент
один раз спрашивает, где хранить новый плагин, и записывает ответ командой
`python3 scripts/plugin_scope.py set …`. Если напоминание не включено, шаг
ничего не меняет.

Проверка: `python3 scripts/setup_tracking.py --check`,
`python3 scripts/plugin_scope.py show`. Формат — docs/customizations.md,
раздел «Дома плагинов».
