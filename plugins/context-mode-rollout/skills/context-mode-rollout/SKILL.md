---
name: context-mode-rollout
description: "Check, dry-run or force the install of the context-mode extension in Claude Code and Codex CLI on BB machines (bb context-mode-rollout status/check/apply); explain how new machines get it automatically."
---

# Context Mode на всех машинах BB

Плагин `context-mode-rollout` держит npm-пакет `context-mode` (закреплённая
версия, по умолчанию 2.2.0) и его настройку в Claude Code и Codex CLI на каждой
подключённой машине BB.

## Как работает

- Серверная часть раз в 2 минуты смотрит список машин. Машину, которую ещё не
  проверяли или которая снова подключилась (не чаще раза в 30 минут), а также
  каждую машину раз в сутки она проверяет через host-часть плагина. После
  ошибки — повтор через час.
- Host-часть работает на самой машине от пользователя, который запускает CLI:
  берёт PATH из login shell (на macOS добавляет Homebrew), находит `claude` и
  `codex`. Нет ни одного — ничего не делает (`no-cli`).
- Пакет отсутствует или старее закреплённого → `npm install -g context-mode@X`
  (без sudo; если глобальный каталог npm не доступен на запись — ошибка в
  статусе, ручная установка). Более новую версию (после `ctx_upgrade`) не
  откатывает.
- Затем `context-mode setup --dry-run`; если есть изменения или агент не PASS —
  `context-mode setup --yes --agents <найденные>` и `context-mode doctor`.
  Setup context-mode пишет MCP только в пользовательский профиль (Claude Code —
  плагин user-scope, Codex — `~/.codex/config.toml`), откатывает агента при
  неудачной проверке, инструкции (CLAUDE.md, AGENTS.md) не трогает.
- Уже открытые сессии CLI изменения не видят: нужна новая сессия.

## Команды

```sh
bb context-mode-rollout status            # последний результат по машинам
bb context-mode-rollout check [--machine <id|имя>] [--verify]  # сухой прогон
bb context-mode-rollout apply [--machine <id|имя>]             # поставить/починить и doctor
bb plugin config context-mode-rollout set autoInstall false    # выключить автоустановку
bb plugin config context-mode-rollout set version 2.3.0        # сменить закреплённую версию
```

Состояния: `ok` — всё настроено; `installed` — только что поставлено;
`planned` — сухой прогон нашёл работу; `no-cli` — нет Claude Code и Codex;
`error` — смотри сообщение (npm без прав, doctor не PASS, машина недоступна).

Windows поддерживается по возможности (команды через shell), не проверялся.
