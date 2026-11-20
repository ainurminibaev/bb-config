# Subthread Autocollapse

Сворачивает раскрытый список подтредов в боковой панели BB через 5 минут
(настройка `minutes`). Считает время и после ручного раскрытия, и когда список
раскрылся сам из-за нового подтреда. Работает через штатное RPC плагина
Thread list (`listPreferences`/`setPreference`, ключ `collapsedThreads`).

Проверка: `npm ci && npm test && npm run typecheck`; сборка и установка:
`bb plugin build . && bb plugin install . --yes`. Состояние:
`bb subthread-autocollapse status`.
