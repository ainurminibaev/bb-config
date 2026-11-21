---
name: bb-config-tracking
description: Сохранить изменение BB в bb-config после установки, удаления, обновления или доработки плагина и после изменения настроек BB; решить, где «дом» плагина (bb-config, проект или не отслеживать).
---
# Учёт кастомизаций BB в bb-config

1. Скажи пользователю: «BB кастомизирован — сохраняю изменение в bb-config».
2. Найди checkout bb-config на нужной машине через BB (`bb project list`,
   `bb project show <id> --json`), прочитай его AGENTS.md — он главнее этого навыка.
3. Дом плагина: `python3 scripts/plugin_scope.py show <id>`.
   - `project` или `ignore` — плагин принадлежит проекту или не отслеживается:
     его код и настройки в bb-config не копируй, снимок ради него не делай.
   - Дома нет — один раз спроси пользователя: хранить в bb-config, в проекте
     (каком, откуда и какой командой ставится) или не отслеживать. Запиши ответ:
     `plugin_scope.py set <id> bb-config|ignore` или
     `plugin_scope.py set <id> project --project <имя> --source <путь|URL> --install "<команда>"`
     (личное — с `--private`). Больше об этом плагине не спрашивай.
4. Для дома bb-config: `python3 scripts/snapshot.py --settings-only`; свои
   исходники — в `plugins/<id>/`; что изменено и как восстановить — в
   `docs/customizations.md`; проверь `python3 scripts/snapshot.py --check`.
5. Нет checkout — прямо скажи, что изменение ещё не сохранено. Не утверждай,
   что оно в Git, пока нет коммита.

Нельзя: сохранять секреты, авторизации, базы, переписку; перенастраивать
маршруты или аккаунты ради снимка; делать commit/push без поручения.
