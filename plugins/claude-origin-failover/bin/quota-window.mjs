// Native rate-limit events use Unix time. A later human-readable error can omit it.
export function quotaWindow(message, now) {
  const info = message?.rate_limit_info;
  if (message?.type === 'rate_limit_event' && info?.status === 'rejected' &&
      ['five_hour', 'seven_day'].includes(info.rateLimitType)) {
    const value = info.resetsAt;
    const resetAt = value < 1e12 ? value * 1000 : value;
    return {kind:info.rateLimitType, resetAt:Number.isSafeInteger(value) && resetAt > now ? resetAt : null};
  }
  if (message?.type !== 'assistant' || message.error !== 'rate_limit' || !Array.isArray(message.message?.content)) return null;
  const text = message.message.content.find(block => block.type === 'text' && /hit your (5-hour|weekly) limit/i.test(block.text))?.text;
  if (!text) return null;
  const kind = /5-hour/i.test(text) ? 'five_hour' : 'seven_day';
  const clock = /resets\s+(1[0-2]|[1-9]):([0-5]\d)(am|pm)\s*\(UTC\)/i.exec(text);
  if (kind !== 'five_hour' || !clock) return {kind, resetAt:null};
  const reset = new Date(now);
  reset.setUTCHours(Number(clock[1]) % 12 + (clock[3].toLowerCase() === 'pm' ? 12 : 0), Number(clock[2]), 0, 0);
  if (reset.getTime() < now) reset.setUTCDate(reset.getUTCDate()+1);
  return {kind, resetAt:reset.getTime()-now <= 5*3600000 ? reset.getTime() : null};
}
