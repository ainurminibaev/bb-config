Устанавливает на сервере BB новый плагин Context Mode Rollout 0.1.0. Штатный
шаг `local-plugin` собирает и ставит плагин из `plugins/context-mode-rollout`
и проверяет источник и версию.

Плагин держит расширение context-mode (npm-пакет 2.2.0) в Claude Code и Codex
CLI на каждой подключённой машине BB: новую машину проверяет сразу после
подключения, остальные — раз в сутки. Нет пакета — ставит его через npm без
sudo, затем запускает `context-mode setup` только для найденных CLI и
проверяет `context-mode doctor`. Если context-mode уже настроен, ничего не
меняет. Выключить: `bb plugin config context-mode-rollout set autoInstall false`.

Проверка: `bb context-mode-rollout status` — у каждой подключённой машины с
Claude Code или Codex состояние `ok` или `installed`; `bb context-mode-rollout
check` — сухой прогон без изменений.
