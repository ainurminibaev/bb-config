# Синхронизация файлов (`sync/`)

Оркестрация Mutagen по тестам А и А2 (`research/test-a-mutagen.md`, `test-a2-mutagen.md`).

## Для исполнителя хода

```ts
const fileSync = registerSyncServer(bb, () => loadConfig());   // server.ts
const before = await fileSync.prepareTurn({ threadId, projectId }, { hostId });
if (!before.ok) { /* ход не идёт: before.reason, before.message, before.conflicts */ }
// CLI на hostId с cwd = before.cwd (/opt/bbfs/<папка>), окружение += before.env
const after = await fileSync.finishTurn({ threadId, projectId }, { hostId });
```

- `prepareTurn` / `finishTurn` можно повторять: свой незакрытый ход закрывается
  перед следующим, чужой живой ход того же проекта даёт `busy`.
- Отказы: `sync-off` (проект «Выключено», ход только на опоре), `busy`,
  `conflict` (ход не передаётся, пути в `conflicts`), `git-busy`,
  `unsupported` (нативный Windows), `not-configured` (нет SSH-цели), `error`.
- `timings` — замеры шагов для ленты; `lines.ts`: `timingLines` даёт
  «Mac → Tru: flush 0,3 с ✓», `summaryLine` — итог одной строкой. `notices` —
  карантин, снятый lock, решённый конфликт `.git/index`.
- Git-читатели на опоре во время хода другой машины — с `ANCHOR_GIT_ENV`
  (`GIT_OPTIONAL_LOCKS=0`).

## Как устроено

На пару «проект × исполнитель» две сессии в демоне исполнителя, alpha — опора по SSH:
`W` two-way-safe (только во время хода) и `R` one-way-replica опора → исполнитель.
Создаются на паузе с `--no-ignore-vcs --default-file-mode=0644
--default-directory-mode=0755 --symlink-mode=portable` и исключениями из
настроек; смена исключений или путей пересоздаёт сессии (метка `bbc-cfg`).

| Шаг | Начало хода на исполнителе | Конец хода |
|---|---|---|
| 1 | bind mount `/opt/bbfs/<папка>` на опоре | flush W |
| 2 | сессии W и R (новый корень: чужое — в карантин целиком) | `.git/**/*.lock`: без живого git — снять, flush; с живым — `git-busy` |
| 3 | «Ленивый»: stat-снимок → изменённое в `~/bbfs-quarantine/<папка>/<время>/` | `sync list` JSON; конфликт только `.git/index` — в пользу исполнителя |
| 4 | права `.env*` на опоре | любой другой конфликт или проблема — отказ, W не трогаем |
| 5 | R: resume, flush, проверка, pause (выравнивание по опоре) | 0600 файлам `.env*`, которые были 0600 |
| 6 | W: resume, flush, проверка | pause W, stat-снимок; «Тёплый» — resume R |

Критерий — JSON `mutagen sync list` (`status`, `paused`, `connected`,
`conflicts`, `scanProblems`, `transitionProblems`, `lastError`), а не код
flush. Переходный статус (`scanning` сразу после flush) перечитывается до 5 с.

Режимы: «Ленивый» (между ходами всё на паузе, карантин перед ходом),
«Тёплый» (R работает между ходами), «Выключено» (`off`: сессий нет, ход
только на опоре). `syncModeSchema` в `contract.ts` пока знает только
`lazy`/`warm`: `off` читается терпимо (`syncModeOf`), в схему его добавит
владелец профилей.

Состояние (кто пишет) — `bb.storage.kv` `sync:project:<id>`. SSH-цель опоры
с исполнителя — `sync:anchor-ssh:<hostId>` (RPC `syncSetAnchorSsh`), в схеме
машины поля нет.

## Файлы

| Файл | Что |
|---|---|
| `mutagen.ts` | имена, метки, аргументы, разбор `sync list`, критерий здоровья (чистый) |
| `orchestrator.ts` | `SyncOrchestrator`: prepareTurn/finishTurn/applyMode/teardown (чистый, команды через `SyncHostCall`) |
| `contract.ts`, `host-ops.ts`, `host-handlers.ts` | хост-RPC на машине: mutagen без оболочки, снимок и карантин, права, lock-файлы, bind mount |
| `service.ts` | обвязка сервера: контекст проекта из конфигурации и `projects.get`, kv, RPC `sync*` |
| `setup.ts` | шаги мастера «Настроить» для macOS/Linux/WSL (`wizard.ts` берёт их первыми) |
| `lines.ts` | строки для ленты |
| `fake-mutagen.ts`, `sync.test.ts` | юнит-тесты на фейковом Mutagen и временных папках |
| `integration.ts` | прогон Mac ↔ Tru на синтетической папке с уборкой |

Мастер: папка (на Mac — системное окно пароля), Mutagen 0.18.1 из архива
релиза с SHA-256 (без Homebrew: на macOS 26 он не ставит), ссылки и
`mutagen-agents.tar.gz` в `~/.local/bin` (root на Linux — `/usr/local/bin`),
проверка. На опоре Linux проверка требует root для bind mount; fstab не
меняется — монтирование делает `prepareTurn` и после перезагрузки повторит.

## Проверки

`node --test sync/sync.test.ts` — 24 теста.
Интеграция (вне песочницы, демон Mutagen): `node sync/integration.ts --anchor <hostId опоры> --ssh <ssh-цель>`.
Прогон 27.11.2026 Mac ↔ Tru: 32/32 проверки — мастер дважды (повтор безопасен),
первая синхронизация с `.git` и `.env`, права 0644/0755, снятый `index.lock`,
`git fsck`, возврат 0600, «старый писатель» (карантин, правка и удаление Tru
выжили), реальный конфликт → отказ и проход после разрешения, тёплый режим,
совпадение манифестов. Замеры (команды на опору шли через `bb terminal` +
node, это добавляет 1–3 с на вызов; хост-RPC быстрее): первая подготовка
15–20 с, конец хода 2,3–2,8 с, повторная подготовка 5–7 с, flush 0,2–0,6 с.

## Что синхронизируется

- **Всё, кроме исключений из настроек** («Файлы» → исключения; по умолчанию
  `node_modules` и артефакты сборки). `.gitignore` правилом синхронизации не
  считается (`--no-ignore-vcs`): игнорируемые git файлы — `.env`, `.local/`,
  локальные настройки, данные — нужны агенту на машине ступени так же, как на
  опоре. Тяжёлое и восстанавливаемое (зависимости, сборка) исключается явно.
- `.git` синхронизируется целиком; пишет строго одна машина.
- **Символические ссылки.** Все машины каскада POSIX (Linux, macOS, WSL) —
  сессии создаются с `--symlink-mode=posix-raw`: ссылки, в том числе
  абсолютные, переносятся как есть. Есть нативный Windows — `portable`
  (режим Mutagen по умолчанию) и предупреждение: абсолютные ссылки не
  переносятся. Смена режима меняет отпечаток сессии (`bbc-cfg`), и сессии
  прежних версий пересоздаются при следующем ходе.
- **Ошибки сканирования отдельных путей** (ссылка, права, недопустимое имя)
  ход не блокируют: такие пути не переносятся, остальное синхронизировано,
  а в строке синхронизации ленты видно «не синхронизировано путей — N (…)».
  Ход не передаётся только при конфликте, ошибке записи (`transitionProblems`),
  обрыве связи или `lastError` сессии.
