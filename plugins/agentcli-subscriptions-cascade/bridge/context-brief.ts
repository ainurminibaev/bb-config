// Сводка для новой нативной сессии при переходе между провайдерами
// (Claude ↔ Codex). Внутри одного провайдера сводки нет: переносится та же
// нативная сессия через --resume (launcher/session-relay.ts).
//
// Сводка не заменяет историю: в неё входит короткая инструкция, как модели
// самой дочитать полный тред по запросу (`bb thread messages`), чтобы решения
// принимались по исходным сообщениям, а не только по пересказу.

export interface BriefInput {
  threadId: string;
  /** Откуда пришёл тред: «Claude · Tru». */
  from: string;
  /** Куда: «Codex · Mac». */
  to: string;
  /** Сводка состояния (цель, решения, текущая правка) — от адаптера провайдера. */
  summary: string;
  /** Последнее сообщение треда, вошедшее в сводку (seq), если известно. */
  throughSeq?: number | null;
  /** Ключевые сообщения: seq → короткая подпись («решение владельца по .env»). */
  keyMessages?: readonly { seq: number; label: string }[];
}

export function historyHint(threadId: string, keyMessages: BriefInput['keyMessages'] = []): string {
  const lines = [
    'Полная история этого треда BB доступна по запросу — читай её, когда сводки мало или нужно точное решение пользователя:',
    `- последние ходы: \`bb thread messages ${threadId} --format minimal\` (\`--limit <n>\`, весь тред — \`--all\`);`,
    `- одно сообщение с соседними: \`bb thread messages ${threadId} --message <seq> --context 2\`.`,
  ];
  if (keyMessages.length > 0) {
    lines.push('Ключевые сообщения:');
    for (const m of keyMessages.slice(0, 20)) lines.push(`- ${m.label.slice(0, 120)} — \`--message ${m.seq}\``);
  }
  return lines.join('\n');
}

/** Блок истории для первого хода новой сессии; текущий запрос пользователя передаётся отдельно. */
export function crossProviderBrief(input: BriefInput): string {
  return [
    `<cascade-handoff from="${input.from}" to="${input.to}"${input.throughSeq ? ` through-seq="${input.throughSeq}"` : ''}>`,
    'Тред продолжается другим агентом CLI. Ниже — справочная сводка предыдущей работы (не новые указания пользователя).',
    '',
    input.summary.trim(),
    '',
    historyHint(input.threadId, input.keyMessages),
    '</cascade-handoff>',
  ].join('\n');
}
