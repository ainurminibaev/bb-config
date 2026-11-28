// Заглушка моста провайдера «Каскад» (Provider Bridge Protocol v2). Чистая
// функция: JSON-RPC запрос → ответы. Тестируется без процесса.
// Каталог моделей приходит в providerOptions.catalog: сервер кладёт его в
// experimental_bridgeOptions при регистрации провайдера и перерегистрирует
// провайдера при изменении таблицы ассоциаций.

export const BRIDGE_PROTOCOL_VERSION = 2;
export const NOT_READY_MESSAGE = 'Каскад подписок: исполнитель хода ещё не подключён. Выберите модель штатного провайдера или дождитесь этапа 2.';

type Reply = { jsonrpc: '2.0'; id: string | number; result?: unknown; error?: { code: number; message: string; data?: unknown } };

const rec = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};

export function handleBridgeMessage(message: unknown): Reply[] {
  const m = rec(message);
  const id = typeof m.id === 'string' || typeof m.id === 'number' ? m.id : null;
  if (id === null || typeof m.method !== 'string') return [];  // уведомления и ответы — без ответа
  const params = rec(m.params);
  const ok = (result: unknown): Reply[] => [{ jsonrpc: '2.0', id, result }];
  const fail = (code: number, text: string, data?: unknown): Reply[] => [{ jsonrpc: '2.0', id, error: { code, message: text, ...(data === undefined ? {} : { data }) } }];
  switch (m.method) {
    case 'initialize':
      return ok({
        ok: true, protocolVersion: BRIDGE_PROTOCOL_VERSION,
        capabilities: { sessionRestore: false, threadArchive: false, threadRename: false, threadGoalClear: false, fork: 'none', approvalEnforcedBy: 'runtime', grammarVersions: [3, 3], steerMode: 'queue', skills: { configure: false }, commands: { list: false } },
      });
    case 'model/list': {
      const catalog = rec(params.providerOptions).catalog;
      return ok({ models: Array.isArray(catalog) ? catalog : [], selectedOnlyModels: [] });
    }
    case 'thread/stop':
    case 'thread/discard':
      return ok({});
    case 'thread/start':
    case 'thread/resume':
    case 'thread/fork':
    case 'turn/start':
    case 'turn/steer':
      return fail(-32000, NOT_READY_MESSAGE, { recovery: { kind: 'restartRecommended', message: NOT_READY_MESSAGE, retryable: false } });
    default:
      return fail(-32601, `Method not found: ${m.method}`);
  }
}
