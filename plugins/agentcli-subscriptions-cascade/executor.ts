// Исполнитель хода (этап 2, путь B «свой провайдер»). Код разложен по слоям:
//
//   bridge/wrapper.ts        мост провайдера: импортированные штатные мосты Claude Code / Codex,
//                            подмена CLI запускателем, строки ленты из сокета запускателя;
//   bridge/native.ts         поиск артефакта штатного моста, sha256 и проверка формы экспорта;
//   bridge/digests.ts        ожидаемый digest = sha256(<rootDir>/dist/host.js) на сервере BB;
//   bridge/route-service.ts  решение движка перед ходом, sync/ до и после хода, паспорт треда;
//   bridge/server-register.ts RPC routeTurn/finishTurn/threadStatus, CLI status/adopt;
//   bridge/feed.ts           RouteNote → строки timeline/;
//   launcher/main.ts         запускатель CLI: спрашивает сервер, запускает здесь или на машине ступени;
//   launcher/remote.ts       канал до машины ступени — терминал BB (REST), восстановление по seq;
//   launcher/agent-source.ts агент на машине ступени (node), запускает нативный CLI.
//
// Режим исполнения задаёт policies.executionMode: off — ходы каскада
// отклоняются с подсказкой; provider — работает этот исполнитель; relay
// (путь A, подмена CLI штатных провайдеров) не реализован.
export type ExecutionMode = 'off' | 'relay' | 'provider';
