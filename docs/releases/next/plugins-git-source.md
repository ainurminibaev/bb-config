### Обновления плагинов — штатно через BB

Шаг `plugins-git-source` выполняется на сервере BB. Он переводит 12 плагинов
bb-config без секретов и расписаний (Subthread Autocollapse, Web BB Button,
Handoff Button, Project Machine Setup, Shared Guides, Git Thread Provenance,
Codex Goal Queue, Fresh Thread Hint, Project Open, Code Open, Thread Account
Usage, Push Button) с папки выпуска bb-config на Git-теги `<id>/vX.Y.Z`
публичного репозитория. После шага их новые версии показывает сам BB
(Settings → Updates, `bb plugin outdated`) и ставит `bb plugin update`;
Config Updates для них больше не нужен. Требуется BB 0.50 или новее.

Для каждого плагина по очереди: проверяется, что версия по тегу собирается
только с рабочими зависимостями (как при установке из Git); настройки
сохраняются в приватном журнале `.local/updates/plugin-git-source/`; BB 0.50
не меняет источник поверх установки, поэтому плагин удаляется и ставится из
Git (перерыв 4–13 секунд); настройки возвращаются и сверяются; проверяется
состояние `running`. Если у плагина появилась секретная настройка, которую
нельзя сохранить и вернуть, шаг останавливается и просит спросить владельца
установки. Плагины, которых нет или которые стоят не из папки выпуска
bb-config, не трогаются. Сбой — откат плагина на прежнюю папку выпуска с
прежними настройками и остановка.

Проверка: `python3 scripts/plugin_git_source.py --check <id> …`.
Откат одного плагина: `python3 scripts/plugin_git_source.py --rollback
--allow-remove <id>` (нужна сохранённая папка прежнего выпуска).
