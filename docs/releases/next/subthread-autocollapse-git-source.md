### Subthread Autocollapse из Git

Шаг `subthread-autocollapse-git-source` выполняется на сервере BB. Он переводит
Subthread Autocollapse, установленный из папки выпуска bb-config, на Git-теги
`subthread-autocollapse/vX.Y.Z`. Требуется BB 0.50 или новее. Доступные версии
показывает `bb plugin outdated`, а обновление ставит
`bb plugin update subthread-autocollapse`.

Шаг проверяет исходный каталог и сохраняет значения настроек в приватном
журнале `.local/updates/plugin-git-source/`. Если BB требует удалить старую
установку, плагин временно исчезает из списка, а таймеры раскрытых подтредов
начинаются заново. BB удаляет сохранённые расписания и секреты при удалении
плагина. Subthread Autocollapse использует службу `poll` и хранит таймеры
в памяти. После установки скрипт
проверяет источник, состояние `running` и совпадение настроек. Повторный
запуск продолжает прерванную операцию по журналу.

Проверка вручную:
`python3 scripts/plugin_git_source.py --check subthread-autocollapse`.
Откат с восстановлением настроек:
`python3 scripts/plugin_git_source.py --rollback subthread-autocollapse --allow-remove`.
Для отката нужна сохранённая папка прежнего выпуска.
