# Каскад подписок (agentcli-subscriptions-cascade)

Экспериментальный плагин BB. Один тред работает на первой ступени каскада
«машина × CLI × аккаунт», у которой есть лимит: Claude Max на Tru → Claude на
Mac через шлюз vclaude → Claude Pro на UA → Codex с подтверждением. Порядок
задаётся свободно, правила выбора — профилями.

Версия 0.1.0 — каркас:

- экран настроек;
- таблица моделей по машинам;
- провайдер «Каскад подписок»: список моделей — профили каскада («Авто»,
  «Авто · без Codex», «Opus → Авто», «Fable → Авто», «Только Opus 5.5», «Только Fable 5.2»);
- движок выбора ступени по профилю и схема «i»;
- тестовый источник квоты для приёмочных сценариев;
- модуль лимитов (usageLimits BB и пакет vclaude из `thread-account-usage`);
- мастер «Настроить» (папка `/opt/bbfs`, Mutagen, проверка).

Исполнитель хода не подключён.

- Архитектура и этапы: [ARCHITECTURE.md](ARCHITECTURE.md)
- Навык: [skills/subscriptions-cascade/SKILL.md](skills/subscriptions-cascade/SKILL.md)

```sh
npm ci && npm test && npm run typecheck && bb plugin build .
```

Ставится только вручную: `bb plugin install ./plugins/agentcli-subscriptions-cascade --yes`.
