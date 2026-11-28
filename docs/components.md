# Состав bb-config: компоненты, источники, зависимости

Заявленный набор описан в [`config/bundle.json`](../config/bundle.json): у каждого
компонента — описание и ссылка на код (их показывает окно выбора), у внешних —
проверенная версия `tested` (Handoff 0.8.2, Needs You 0.2.1, Tokenomics 0.2.2,
KodaForge 0.7.100, ChatGPT Realtime 0.1.0; более новая даёт предупреждение). Одна
установка и одно обновление сводят BB к этому набору
(`python3 scripts/updates.py apply`, см. [updates.md](updates.md)). Порядок в файле —
порядок установки: зависимости раньше зависимых.

## Набор

| Компонент | Вид | Источник | Нужен для / зависит от | Личное и другие машины |
| --- | --- | --- | --- | --- |
| `config-updates` | свой плагин | `plugins/config-updates` | канал обновлений | checkout — проект BB на машине сервера (установка создаёт его) |
| `voice-mode-keeper` | свой плагин | `plugins/voice-mode-keeper` | сохраняет исправления `inbox`, `tokenomics`, `kodaforge` | — |
| `codex-realtime` | каталог BB | `codex-realtime@bb-community` (gpambrozio/bb-plugins), от 0.1.0 | для `voice-mode` | личный вход Codex через ChatGPT на сервере |
| `voice-mode` | **собственный форк** | `git:…/ainurminibaev/bb-plugin-voice-mode@^0.2.0`, от 0.2.8 | зависит от `codex-realtime`; мост Codex Live (`scripts/voice_mode_bridge.py`) | подписка ChatGPT; микрофон в клиенте |
| `git-thread-provenance` | свой плагин | `plugins/git-thread-provenance` | связь Git-действий с тредом BB | — |
| `handoff` | каталог BB | `handoff@bb-community`, от 0.7.0 | для `handoff-button` | — |
| `handoff-button` | свой плагин | `plugins/handoff-button` | зависит от `handoff` | — |
| `inbox` (Needs You) | каталог BB | `inbox@bb-community`, от 0.2.0 | исправление `plugins/inbox-compat` накладывает Keeper | — |
| `tokenomics` | каталог BB | `tokenomics@bb-community`, от 0.2.0 | исправление `plugins/voice-mode-keeper/tokenomics_compat.py` накладывает Keeper | — |
| `kodaforge` | форк | `ainurminibaev/bb-plugin-kodaforge`, теги `own/`, от 0.7.100 | для `code-open`, `kodaforge-inspector`; перевод и возврат `scripts/plugin_fork.py` | — |
| `kodaforge-inspector` | свой плагин | `plugins/kodaforge-inspector` | зависит от `kodaforge` | — |
| `code-open` | свой плагин | `plugins/code-open` | зависит от `kodaforge` | — |
| `codex-project-trust` | **собственный репозиторий** | `git:…/ainurminibaev/bb-codex-project-trust@^1.0.0`, от 1.0.0 | — | — |
| `machine-tabs` | свой плагин | `plugins/machine-tabs` | для `project-logo`, `project-catalog` | — |
| `project-logo` | свой плагин | `plugins/project-logo` | зависит от `machine-tabs` | — |
| `project-catalog` | свой плагин | `plugins/project-catalog` | зависит от `machine-tabs` | — |
| `project-machine-setup` | свой плагин | `plugins/project-machine-setup` | — | — |
| `subthread-autocollapse` | свой плагин | `plugins/subthread-autocollapse` | — | — |
| `offline-quiet` | свой плагин | `plugins/offline-quiet` | — | — |
| `codex-goal-queue` | свой плагин | `plugins/codex-goal-queue` | — | — |
| `thread-account-usage` | свой плагин | `plugins/thread-account-usage` | источник usage для `menubar-status` | — |
| `thread-description` | свой плагин | `plugins/thread-description` | — | — |
| `menubar-status` | свой плагин | `plugins/menubar-status` | — | настройки `hostId`, `filePath`; установка на Mac/Windows |
| `project-open` | свой плагин | `plugins/project-open` | — | обработчик Finder на Mac |
| `file-local-open` | свой плагин | `plugins/file-local-open` | — | `macHostId` при нескольких компьютерах |
| `browser-page` | свой плагин | `plugins/browser-page` | — | — |
| `proxy-manager` | свой плагин | `plugins/proxy-manager` | — | прокси и маршруты вручную |
| `push-button` | свой плагин | `plugins/push-button` | — | — |
| `web-bb-button` | свой плагин | `plugins/web-bb-button` | — | публичный адрес BB (`webUrl`) |
| `local-transcribe` | свой плагин (резервная path-копия) | `plugins/local-transcribe`; рабочая установка может идти из собственного Git-репозитория — она сохраняется | — | исполнители `workerHosts`, Python и ffmpeg на них |
| `fresh-thread-hint` | свой плагин | `plugins/fresh-thread-hint` | подсказка продолжить большой давний тред в новом | — |
| `limit-guard` | свой плагин | `plugins/limit-guard` | режимы у порога лимита подписки | — |
| `pr-issues` | свой плагин | `plugins/pr-issues` | страница PR и issue на GitHub | `gh` с входом на сервере BB |
| `context-mode-rollout` | свой плагин | `plugins/context-mode-rollout` | context-mode во всех агентах на всех машинах | Node.js с npm на машинах (сейчас Node ≥ 24.15) |
| `agentcli-subscriptions-cascade` | свой плагин, **необязательный** | `plugins/agentcli-subscriptions-cascade` | экспериментальный провайдер «Каскад подписок»; паспорт треда читают `limit-guard`, `thread-account-usage`, `codex-delegation-watch`, `file-local-open`, `project-open`, `git-thread-provenance` | мастер «Настроить»: Mutagen, `/opt/bbfs`, SSH-доступ машин к серверу BB; свой вход CLI на каждой машине-ступени |

Вне плагинов: на каждой машине с Codex — `python3 scripts/codex_defaults.py --apply --verify`.
Это действие на других машинах; установка показывает его в `attention`.

Патчи сторонних плагинов (`plugins/inbox-compat`, `plugins/kodaforge-compat`,
Tokenomics — внутри `plugins/voice-mode-keeper`) и правки Voice Mode (`plugins/voice-mode`) — не
отдельные плагины: их применяют Keeper, форк и шаги релизов.

## Вне набора

- Встроенные плагины BB (`builtin:*`): приходят с BB; их состояние — личная
  настройка, её восстанавливает `scripts/restore.py`, а не обновление.
- Личный выбор автора из каталога (`usage`, `usage-tracker`, `limits`) есть в
  `config/plugins.json` для восстановления установки автора, но в набор не входит.
- Продукты из `config/externally-managed-plugins.json` устанавливаются отдельно.

## Как набор обрабатывает установку

| Состояние у пользователя | Что делает `apply` |
| --- | --- |
| компонента нет | ставит (свой — сборкой из закреплённого коммита, остальные — `bb plugin install`) |
| старая версия | свой — пересборка из релиза; форк/каталог — `bb plugin update`, при упоре в сохранённый диапазон — `bb plugin update --range` (настройки и секреты остаются) |
| отключён пользователем | обновляет, оставляет отключённым |
| исключён (`scripts/bundle.py exclude <id>` или отказ, записанный в журнале) | не ставит |
| необязательный компонент (`"optional": true`, например экспериментальный «Каскад подписок») ещё не стоит | не ставит, пока пользователь не выбрал его (`scripts/bundle.py choose --take <id>` или `include <id>`); уже установленный обновляет как обычно |
| стоит из другого источника или более новая сборка | оставляет как есть, сообщает |
| форк Voice Mode стоит из каталожного оригинала | переводит на форк проверенной миграцией (без секретов; с секретом — останавливается) |
| закреплён на точном теге | `bb plugin update --range` невозможен: ошибка с пояснением, удаление не выполняется |
| плагин ждёт личной настройки (`needs-configuration`) | считается доставленным, попадает в `attention` |

## Найденные пропуски прежних релизов (до v1.4.0)

Шаги релизов касались только изменённых компонентов и только у тех, у кого они
уже были. Отсюда:

- v1.2.8 и v1.3.1: при отсутствии Voice Mode шаг моста получал `not-applicable`,
  релиз считался установленным без Voice Mode; при старом Voice Mode шаг падал
  на `requiresPlugins` и требовал отдельного `bb plugin update`.
- v1.2.2: исправления KodaForge при отсутствии KodaForge пропускались; Code Open и
  KodaForge Inspector оставались без него.
- v1.0.x–v1.2.x: шаги `local-plugin` без `introduces` не ставили отсутствующие свои
  плагины (Menubar Status, Proxy Manager, Open on Desktop и др.); новые компоненты
  (`project-catalog`, `project-machine-setup`, `browser-page`,
  `kodaforge-inspector`, `subthread-autocollapse`) требовали отдельного согласия
  на каждый.
- `local-transcribe` не входил ни в один релиз.
- Зависимости своих плагинов из каталога (`handoff`, `inbox`, `tokenomics`,
  `kodaforge`, `codex-realtime`) обновлением не ставились.
- Чистая установка не имела одного действия: только поштучно или
  `scripts/restore.py` со снимком автора.

С v1.4.0 первым шагом каждого релиза идёт `bundle`: он закрывает эти случаи для
любого прежнего состояния, а шаги старых релизов проверяются уже по сведённой
установке.
