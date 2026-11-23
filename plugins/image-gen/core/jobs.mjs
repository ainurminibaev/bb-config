// Pure decision logic of the image-gen plugin. No BB SDK imports: tested with node --test.

export const ACTIVE = new Set(['queued', 'starting', 'running', 'returning']);
export const TERMINAL = new Set(['completed', 'failed', 'limited', 'unknown', 'cancelled', 'return_failed']);

/**
 * Executor cascade. An executor is (machine, backend, account):
 *   {id, hostId, name, backend: 'codex'|'api:<name>', accountGroup, tier, ready, busy}
 * tier 0 = Codex built-in image_gen on a ChatGPT subscription (no extra cost),
 * tier 1+ = opt-in paid/API backends; they are used only when enabled in settings.
 * Order: requested executor -> caller's own machine -> other ready machines of the
 * same tier (non-busy first) -> next tier. Executors whose account is known to be
 * limited (excludeAccounts) are skipped: another machine on the same account shares the limit.
 */
export function candidates(executors, { callerHostId, preferred, excludeAccounts = [], maxTier = 0 } = {}) {
  const usable = executors.filter(e => e.ready && (e.tier ?? 0) <= maxTier && !excludeAccounts.includes(e.accountGroup ?? 'default'));
  const rank = e => [e.tier ?? 0, (preferred && (e.id === preferred || e.hostId === preferred || e.name === preferred)) ? 0 : 1,
    e.hostId === callerHostId ? 0 : 1, e.busy ? 1 : 0];
  const cmp = (a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
  return [...usable].sort(cmp).map(e => e.id);
}

/**
 * Next step after an attempt on job.attemptHost finished with runner result `result`.
 * Never moves to another machine once Codex may have generated (unknown/fenced):
 * that would risk a duplicate generation and a second quota spend.
 */
export function afterAttempt(job, result, services) {
  const tried = new Set([...(job.attempts ?? []).map(a => a.executorId), job.executorId]);
  const group = services.find(s => s.id === job.executorId)?.accountGroup ?? 'default';
  const next = (filter = () => true) => job.plan.find(id => !tried.has(id) && filter(services.find(s => s.id === id)));
  switch (result.status) {
    case 'completed': return { state: 'returning' };
    case 'unknown':
    case 'fenced': return { state: 'unknown', error: result.error ?? 'Outcome unknown; not regenerating automatically' };
    case 'limited': {
      // Same ChatGPT account on another machine shares the limit: only switch account groups.
      const host = next(s => (s?.accountGroup ?? 'default') !== group);
      return host ? { state: 'queued', executorId: host, limitedAccount: group } : { state: 'limited', error: result.error, resetHint: result.resetHint ?? null };
    }
    case 'auth':
    case 'not_started': {
      const host = next();
      return host ? { state: 'queued', executorId: host } : { state: 'failed', error: result.error };
    }
    default: return { state: 'failed', error: result.error ?? 'Generation failed' };
  }
}

/** Idempotency key: the same caller request (thread + client key) maps to one job. */
export function requestKey({ threadId, clientKey, prompt, references = [], count = 1, mode = 'generate', outputDir }) {
  return JSON.stringify([threadId ?? null, clientKey ?? null, clientKey ? null : [prompt, references, mode, outputDir], count]);
}

/** Human explanation when nothing can generate (e.g. nobody has Codex). */
export function missingHint(executors) {
  const lines = executors.map(e => `${e.name}: ${(e.missing ?? []).join('; ') || 'занят'}`);
  return 'Нет готового исполнителя для генерации. ' + lines.join(' | ') +
    '. Варианты: (1) установить Codex CLI и выполнить `codex login` с подпиской ChatGPT хотя бы на одной машине BB; ' +
    '(2) владелец BB задаёт ключ OpenAI API в настройках плагина и maxTier=1 (платно за картинку).';
}

export function retentionExpired(job, now, { keepDays = 30 } = {}) {
  return TERMINAL.has(job.state) && now - (job.updatedAt ?? job.createdAt) > keepDays * 86400000;
}

/** Text appended to every thread's instructions. Different for Codex and others. */
export function instructionsFor(providerId, { codexDirect = true } = {}) {
  const common = 'Генерация изображений в BB: плагин image-gen. Не генерируй картинку кодом (SVG/PIL), если просят именно изображение.';
  const codex = 'Ты Codex со встроенным image_gen: генерируй сам через навык imagegen (встроенный инструмент, не CLI/API fallback), ' +
    'затем скопируй выбранный файл из $CODEX_HOME/generated_images в рабочую папку проекта. Не создавай треды для генерации. ' +
    'Каскад: если image_gen недоступен в этой сессии или вернул лимит/ошибку доступа — один раз вызови image_generate с reason=codex_unavailable|codex_limited ' +
    '(при лимите передай excludeCurrentAccount=true), не повторяй встроенный вызов в цикле.';
  const other = 'Своего генератора у тебя нет: для новой картинки вызови image_generate, для правки существующей — image_edit (CLI: bb image-gen generate|edit). Он выполнит генерацию Codex на подходящей машине ' +
    'без новых тредов и положит файлы в указанную папку. Если вернулся jobId без результата — заверши ход: уведомление придёт один раз. ' +
    'Не повторяй вызов при неизвестном исходе; повтор только по явной просьбе пользователя (image_retry).';
  if (providerId === 'codex' && codexDirect) return `${common} ${codex}`;
  if (providerId) return `${common} ${other}`;
  return `${common} Если ты Codex со встроенным image_gen — ${codex} Иначе — ${other}`;
}

/** Completion notice with a stable marker so a restart never sends it twice. */
export function noticeText(job) {
  const marker = `[image-gen:${job.id}:${job.state}]`;
  const body = job.state === 'completed'
    ? `Готово изображений: ${job.returned?.length ?? 0}. Файлы: ${(job.returned ?? []).map(r => r.path).join(', ')}. Прочитай image_status один раз и продолжи исходное поручение.`
    : job.state === 'limited'
      ? `Лимит генерации Codex${job.resetHint ? `, сброс: ${job.resetHint}` : ''}. Сообщи пользователю; не повторяй автоматически.`
      : job.state === 'unknown'
        ? 'Исход неизвестен (связь с исполнителем потеряна). Генерацию не повторяем автоматически; сообщи пользователю, повтор — только по его просьбе.'
        : `Ошибка: ${job.error ?? job.state}. Сообщи пользователю.`;
  return { marker, text: `${marker}\nГенерация изображения (${job.id}): ${job.state}. ${body} Служебное уведомление, подтверждать не нужно.` };
}

/** Send at most one notice per job state; recover ambiguous sends from BB history. */
export async function notifyJob({ kv, threads, job, alreadyAccepted, now = Date.now() }) {
  if (!job.notify || !job.threadId || !TERMINAL.has(job.state)) return 'skip';
  const key = `notice:${job.id}:${job.state}`;
  let notice = await kv.get(key);
  if (['sent', 'suppressed'].includes(notice?.status) || notice?.retryAt > now) return notice?.status ?? 'wait';
  if (!job.deliveredInline && job.inlineWaitUntil > now) return 'wait'; // caller may still receive it inline
  if (job.state === 'cancelled' || job.deliveredInline) {
    await kv.set(key, { status: 'suppressed', at: now }); return 'suppressed';
  }
  const { marker, text } = noticeText(job);
  if (notice?.status === 'sending' && await alreadyAccepted(threads, job.threadId, marker)) {
    await kv.set(key, { ...notice, status: 'sent', recovered: true }); return 'sent';
  }
  await kv.set(key, { status: 'sending', marker, attemptedAt: now, retryAt: now + 60000 });
  try {
    const receipt = await threads.send({ threadId: job.threadId, mode: 'queue-if-active', input: [{ type: 'text', text }] });
    if (!receipt?.ok) throw new Error('not accepted');
    await kv.set(key, { status: 'sent', marker, sentAt: now }); return 'sent';
  } catch (error) {
    await kv.set(key, { status: 'sending', marker, attemptedAt: now, retryAt: now + 60000, error: String(error) });
    return 'error';
  }
}
