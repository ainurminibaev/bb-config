[English](README.md) · **Русский**

# Menubar Status

Статусы агентов и расход лимитов вашего BB в строке меню macOS или полоской на
панели задач Windows.

- Плагин ведёт небольшой файл статуса на одной машине: работающие, ждущие и
  завершённые агенты с текущим шагом и расход аккаунтов (из Thread Account Usage).
- Значок на Mac (`macos/`) показывает компактный значок BB со счётчиками; панель
  по наведению — аккаунты с расходом 5ч/неделя, агентов и чат сбоку, где можно
  ответить агенту. Виджет Windows (`windows/`) показывает то же на панели задач.

## Настройка

1. Задайте в настройках плагина `hostId` (машина со строкой меню) и `filePath`
   (абсолютный путь файла статуса); до этого плагин показывает «Требуется настройка».
2. На Mac: `zsh install.sh` в `plugins/menubar-status/macos` (нужен
   `xcode-select --install`). На Windows: `install.ps1` в
   `plugins/menubar-status/windows`.

Входит в набор [bb-config](../../README.ru.md): `python3 scripts/updates.py apply` из корня репозитория ставит его вместе с остальным. Инструкция для агентов — `skills/menubar-status/SKILL.md`
(`bb menubar-status`). Проверки: `npm test`, `npm run typecheck`.
