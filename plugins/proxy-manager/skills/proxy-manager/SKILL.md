---
name: proxy-manager
description: Inspect named proxies, machine connectivity and native Codex routing; apply a machine's Codex route using standard BB stops and native CLI configuration.
---

Use `bb proxy-manager list` for redacted settings and route state.
`bb proxy-manager check <host-id> <proxy-id|direct>` checks that machine's egress
and OpenAI endpoint reachability without account tokens. Green is connectivity only.

`bb proxy-manager apply <host-id> <proxy-id|direct>` stops BB Codex runtimes on that
machine and updates its user's CODEX_HOME/.env and config.toml. Sessions remain saved.
The next message resumes. Affects all Codex sessions sharing that home, not an
individual account. Already-running external Codex processes are not stopped.
Do not apply to Claude; the current implementation never changes its routing.

If applying to the machine running this thread, prepare and verify all work first;
use `arm <thread-id> <host-id> <proxy-id|direct>` as the last action to apply after
this answer ends. Otherwise apply would interrupt this thread too.

Routing disables system_proxy_fallback and respect_system_proxy. Host-inherited
proxy overrides or unsupported config layouts are refused. Backups are private
under CODEX_HOME/.bb-proxy-backups. A failed switch holds new Codex messages; fix
and reapply. A changed routing fingerprint also holds messages. Do not bypass
these waits or claim OS-level enforcement based on a connectivity check.

Credentials live in BB secret settings and the private native .env; never print
secrets or dump those files. No app artifacts are patched and no custom API gateway
is used. Version updates require native routing behavior to be revalidated.

Claude route observation is read-only and runs from the composer badge: every
5 seconds while a turn runs in the thread, every 30 seconds when it is idle or
for a new thread, never while the browser tab is hidden (at once when shown
again). The server announces turn start/end on the `thread-activity` realtime
channel and returns `busy` in `route_context`; it reuses a thread's provider,
environment and folder for 60 seconds and the machine's name/status for 10. It uses the actual thread's host/directory, Linux /proc or macOS
ps/lsof. A confirmed direct/proxy label requires a matching established
process socket. Missing/ambiguous processes or unsupported/custom routes
remain unconfirmed. Green means observed route, not API health or absence
of system VPN/TUN. It never changes Claude routing, restarts Claude or sends
authenticated requests. Codex route checks are never displayed as Claude checks.


## Маршрут моделей только в BB (0.3.0)

В «Подключения → Маршрут моделей BB» для Codex и Claude Code на каждой машине
можно выбрать «Напрямую» или «Через OpenCodex». Этот выбор не изменяет системный
VPN, HTTP_PROXY/HTTPS_PROXY, обычные файлы конфигурации и внешние процессы CLI.
Это отдельный механизм от старого выбора сетевого прокси ниже на странице.
Модели доступны в пределах авторизации выбранного провайдера; маршрутизатор не
предоставляет доступ к моделям другого провайдера.

Команды: `bb proxy-manager model-route` (список) и
`bb proxy-manager model-route <host-id> <codex|claude-code> <direct|opencodex|inherit>`.

Режим `inherit` («Как в CLI») удаляет выбор: BB перестаёт подставлять маршрут и
агент работает с собственными настройками CLI. Если тред не удалось остановить
при смене маршрута, выбор всё равно сохраняется, а тред перезапускается после
завершения ответа. Сообщение, задержанное из-за недоступной машины или шлюза,
повторяется автоматически через 30 секунд.
До первого выбора настройки провайдера не переопределяются.
Idle-процессы выбранного провайдера BB освобождаются; активные ответы сначала
завершаются. Список моделей может оставаться кэшированным до обновления BB.

Для Codex прямой режим использует CODEX_HOME в приватном host-data плагина.
Config берётся из обычного профиля, но локальный endpoint и каталог OpenCodex
заменяются штатным OpenAI-маршрутом. Авторизация общая с обычным профилем: `auth.json` профиля BB —
ссылка на обычный файл, а где ссылку создать нельзя или CLI заменил её своим
файлом, при следующей подготовке более свежий файл переносится на обе стороны.
Файлы `.env` (сетевые настройки прокси), `hooks.json` и `AGENTS.md` повторяют
обычный профиль, включая удаление. История, skills, plugins, rules и
вложения доступны через ссылки на обычные каталоги. Базы индексов и кэши нового
профиля отдельные. MCP с привязкой авторизации к CODEX_HOME может потребовать
повторного входа. Возврат через OpenCodex выбирает исходный CODEX_HOME.
Для Claude меняется только ANTHROPIC_BASE_URL процесса BB; авторизация остаётся
штатной. Адрес OpenCodex для Claude определяется по конфигурации шлюза (см. ниже).

Выбор маршрута не доказывает доступность API. Внешние custom endpoints,
проектные переопределения и особые способы авторизации требуют отдельной проверки.
При ошибке подготовки отправка сообщения задерживается; история не очищается.
Публичные RPC возвращают лишь режим, путь профиля и описание; токены не возвращаются.

## Проверка OpenCodex (0.3.1)

Прямой маршрут доступен независимо от OpenCodex. Для каждого провайдера на каждой
машине пункт «Через OpenCodex» остаётся видимым, но недоступен до успешной проверки.
Показываются состояния: пока не проверен, не настроен, настроен, но не запущен или
недоступен, доступен; для отключённой машины — «Машина офлайн».

Host читает `$OPENCODEX_HOME/config.json` (по умолчанию `~/.opencodex/config.json`):
нужны явный `port` и запись `providers.openai` для Codex либо `providers.anthropic`
для Claude. Отключённая запись не считается настройкой. Для Codex обычный профиль
также должен указывать на этот порт через localhost/127.0.0.1 и `/v1`. Затем
read-only запрос `/healthz` должен вернуть `service: opencodex`, `status: ok`.
Другой локальный прокси не считается OpenCodex. Поддерживается локальный HTTP-шлюз;
неизвестные схемы конфигурации считаются ненастроенными. Проверка не запускает шлюз,
не читает токены, не вызывает модели и не меняет исходные настройки.

Таймаут — 1,5 секунды, кэш — 30 секунд. «Проверить OpenCodex» обновляет состояние;
сохранение opencodex всегда выполняет новую host-проверку, прежде чем менять KV.
Подготовка runtime использует кэш. Claude получает адрес с портом из конфигурации,
без фиксированного 10100. Доступность шлюза не гарантирует права аккаунта на модели.
Режим direct и системный VPN автоматически не переключаются.

Установка/восстановление: `bb plugin build plugins/proxy-manager`, затем
`bb plugin reload proxy-manager`; выбранные режимы сохраняются. При откате вернуть
исходники предыдущей версии и повторить build/reload; старый выпуск не проверял шлюз.
Проверки: TypeScript, тесты отсутствующей настройки, остановленного и чужого сервиса,
нестандартного порта, независимости direct, кэша и повторной серверной проверки.
