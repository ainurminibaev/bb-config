**English** · [Русский](README.ru.md)

# Proxy Manager

Named HTTP/HTTPS proxies, per-machine connectivity checks, and native Codex routing.

Choose a proxy or Direct for Codex on a connected machine. This stops that machine's
BB Codex runtimes with the SDK, preserves sessions, and updates the machine user's
`CODEX_HOME/.env` and `config.toml`. The next message resumes using the new settings.
All Codex sessions sharing this home are affected, including future external CLI
launches; already-running external CLI processes are not controlled by BB.
This is not per-account isolation. Claude settings and runtimes are not changed.

Native configuration sets both proxy variable casings and disables
`features.system_proxy_fallback` and `features.respect_system_proxy`. Direct mode
sets empty proxy variables and NO_PROXY=*. Native configuration is backed up under
`CODEX_HOME/.bb-proxy-backups/<id>/original.json` (private permissions).
Unrelated config values/comments are preserved; unsupported TOML layouts are refused.
Existing nonempty proxy variables inherited by the BB host worker are refused because
they can take precedence over Codex's dotenv. Default/home-based Codex execution is
supported; separate account-specific CODEX_HOME overrides are not provisioned here.

During switching, the standard BB dispatch hook holds Codex messages. An unconfirmed
stop or failed write leaves requests waiting, with an error; reapply in settings.
Changing managed routing values outside the plugin also holds later submissions until
reapplication. Other model settings can still change normally. Core owns retry and
queue behavior; this plugin does not resend prompts or proxy model APIs.

The composer always shows the connection entry, including new threads, unresolved selections and other agents. With no selected proxy its label is `Доступ без прокси`; configured Codex connections show the proxy name. The gear opens settings with the selected host, and stays visible on hover/focus (always on touch screens). For other CLI providers the tooltip states that their native settings were not checked and their routing is not managed. Delayed responses for a previous composer selection cannot display the old route. Motion respects reduced-motion settings.
A server-side monitor checks each applied Codex connection every 30 seconds, without model credentials. After the initial/full manual check, heartbeat checks only OpenAI reachability; IP metadata is refreshed by a full manual check. Concurrent checks for the same host/route share one request. The monitor stops with the plugin.
The settings page leads with machine connections, hides unused CLI controls, and adds proxies through a dialog.
Hover/focus labels carry details. Green means a recent connectivity check, not proof
of account authentication or OS-level isolation. No BB application files are patched.
CLI routing was tested with Codex 0.167.2; future CLI/BB versions need revalidation.

Commands:
- `bb proxy-manager list`
- `bb proxy-manager import <name> <absolute-file>` (Host/Port/Username/Password)
- `bb proxy-manager check <host-id> <proxy-id|direct>`
- `bb proxy-manager prepare <host-id> <proxy-id|direct>` (read-only preflight)
- `bb proxy-manager apply <host-id> <proxy-id|direct>` (stops Codex threads)
- `bb proxy-manager arm <thread-id> <host-id> <proxy-id|direct>` (initial activation after that thread becomes idle)
- `bb proxy-manager remove <proxy-id>`

Build: `npm run check`, `npm test`, `bb plugin build`.
See TEST_RESULTS.md for the original integration correction and subsequent native tests.
## Mobile composer footer

At widths up to 640 px the existing controls remain in the host's 32 px footer
line. Labels use 14 px text; controls do not shrink into unreadable fragments.
The line scrolls horizontally, without increasing the composer's reserved
height or putting controls behind the input when the keyboard opens. Original
controls, handlers and agent routes remain unchanged. Wider windows retain
their existing layout.

After building, `tests/footer-layout.html` loads the compiled stylesheet and
checks the footer together with the input and the
host's fixed footer height. `window.checkFooterLayout()` verifies no overlap,
no page overflow, readable labels and access to the last control by scrolling.
Checked in Chrome at widths 320/390/430/1024 px and heights 844/500/420 px;
reduced heights represent the area available above a keyboard. The fixture
includes the host compact-label rules and asserts labels have visible boxes.
This does not
replace a real iOS keyboard test. Refresh the app to load rebuilt styles.

Full names and machine controls override the host compact rules in the same CSS
base layer. The native machine label is preserved, including its read-only form;
no second machine label is added beside the route. Touch events preserve horizontal scrolling.

## Claude route observation

The composer checks Claude every 5 seconds while its badge is mounted. A host
entry reads Linux `/proc` or macOS `ps`/`lsof` for the Claude CLI or BB Claude
worker in the thread's actual directory. Multiple candidates, unreadable
settings, custom/cloud gateways and missing live sockets stay unconfirmed.
A green direct route requires an established process socket to a currently
resolved api.anthropic.com IP on 443. A green proxy route requires a socket
to the configured proxy. Neither proves application health or excludes an OS
VPN/TUN. The tooltip states the evidence and scope. No authenticated probes,
prompts, restarts, credential changes or routing writes are performed.

No process shows “Claude не запущен”; ambiguous or unavailable evidence shows
“Маршрут не проверен”. Offline hosts stay red. Results are not persisted;
credentials, proxy URLs, process environment and peer addresses are never
returned to the app. Codex check results are not reused for Claude.
macOS parsing has fixtures; the live host check was performed on Linux.


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
