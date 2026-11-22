export function heldUntil(raw, now) {
  if (!raw) return 0;
  try {
    const value = JSON.parse(raw);
    return Number.isSafeInteger(value.resetAt) && value.resetAt > now ? value.resetAt : 0;
  } catch { return 0; }
}

export function routeState(origin, backup, now = Date.now()) {
  const originReset = heldUntil(origin, now);
  const backupReset = heldUntil(backup, now);
  if (!originReset) return {stage:'origin', resetAt:0};
  if (!backupReset) return {stage:'backup', resetAt:originReset};
  return {stage:'waiting', resetAt:Math.min(originReset, backupReset)};
}
