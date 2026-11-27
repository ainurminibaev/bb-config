# Лента треда «Каскада»

Правило «без лишнего»:

- **Обычный ход** не добавляет строк в ленту. Ступень видна тихой меткой «⇄ Mac · Opus»
  в ряду контекста над полем ввода (`threadContextSegment`). Когда BB показывает
  карточку контекста, метка становится её строкой (`threadContextCardRow`).
  По клику открывается схема «i» (`CascadeDiagram` на плане движка).
  Внутри шапки треда SDK маленьких значков не даёт:
  `threadHeaderRow` занимает всю ширину, `threadHeaderTitle` заменяет заголовок у всех тредов.
- **Переход и возврат** — одна строка веса «Thought 8s»: «Tru исчерпан → Mac · Opus · 3,5 с»,
  «Max свободен → Tru · 0,7 с». Подготовка, синхронизация, flush и сверка — шаги
  этой строки, они видны по клику.
- **Заметны только две вещи**, обе — карточкой над полем ввода. Пока на карточку
  не ответили, ход ждёт:
  - `confirm-step` — подтверждение ступени (Да / Ждать, срок «на этот ход / в треде до сброса / всегда»);
  - `decide` — сбой, при котором нужно решение владельца.
  Хост красит `presentation.tint` только значок строки, поэтому строка ленты
  не может быть заметной.

Макеты — `preview/`: `node timeline/preview/build.mjs <папка>` с `ASC_PREVIEW_DEPS`
(папка с react, react-dom@19 и esbuild).

## API для исполнителя (`emitter.ts`)

```ts
const tl = createRouteTimeline({ sink, ask, turnId, timeZone, warn });
// sink(delta): item.open / item.progress / item.close / extension.state — в thread/delta моста.
// ask: путь B — bridgeAskPort(send interaction/request); путь A — serverAskPort(bb.ui, threadId).

const sw = tl.emitSwitch({ reason: 'limit', window: 'Max', from, to, resetAt, handoff, stepId });
sw.step('пауза Tru', 110);
const sync = tl.emitSync({ from: 'Tru', to: 'Mac', files: 12, sample });  // шаг строки перехода
sync.progress(6, etaMs); sync.done({ ms, bytes });                          // или sync.fail(error)
tl.emitFlush({ from: 'Tru', to: 'Mac', ms, verify: 'ok' });                 // внутри перехода — шаг
sw.done();                                                                   // или sw.fail(error, mismatches)

const run = tl.emitRun(stage, { stepId, profileId }); run.end();             // строк нет, только метка
tl.emitFlush({ from: 'Mac', to: 'Tru', ms, verify });                        // после хода: ok — тихо, mismatch — запись
tl.emitWaiting({ cause: 'reset' | 'offline' | 'recheck', ... }).resolve('лимит вернулся');
tl.emitFailure({ message, stage });                                          // тихая запись о сбое

await tl.requestConfirmation({ stepId, continuing, from, to, reason, handoff, threadUntil, preview });
// → go{scope} | skip | wait | cancel | superseded | dismissed | invalid
consentFromDecision(decision, consentCtx, resetAt);                         // → Consent для consent.ts
await tl.requestDecision({ title, message, stage, actions: [{ id: 'retry', label }] });
// → retry | skip | wait | cancel | superseded | dismissed | invalid
```

Одновременно показывается одна карточка: новая заменяет старую, старая получает `superseded`.
Ответ проверяется по `proposalId` и `revision` и принимается один раз.

Сервер: `registerTimelineServer(bb).provideScheme(threadId => …)` отдаёт схему треда
(`explainProfile` с состоянием треда и лимитами). Без источника метка показывает
цепочку «откуда → куда».

`status-lines.ts` в корне — прежний черновик текстов, его заменяет `presentation.ts`.
`extensionKinds` (`route`: item + state) регистрируется в `server.ts`, значки —
в `package.json` → `bb.branding.experimental_icons`.
