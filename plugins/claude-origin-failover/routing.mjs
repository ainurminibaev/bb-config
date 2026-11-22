// Pure routing decisions. The caller supplies one authoritative inventory
// snapshot and durable per-account quota holds, shared by all threads.
export function nextRoute({ originHost, previous, hosts, holds, now }) {
  const available = ({account}) => account && !(holds.get(account) > now);
  const asRoute = ({host, account}) => ({originHost, executionHost: host, account});
  const origin = hosts.find(entry => entry.host === originHost && available(entry));
  if (origin) return asRoute(origin);

  const cursor = hosts.findIndex(entry =>
    entry.host === previous?.executionHost && entry.account === previous.account);
  if (cursor >= 0 && available(hosts[cursor])) return asRoute(hosts[cursor]);
  for (let offset = 1; offset <= hosts.length; offset++) {
    const candidate = hosts[(cursor + offset) % hosts.length];
    if (available(candidate)) return asRoute(candidate);
  }
  let nextReset = Infinity;
  for (const {account} of hosts) {
    const reset = holds.get(account);
    if (account && reset > now) nextReset = Math.min(nextReset, reset);
  }
  return {originHost, waitUntil: Number.isFinite(nextReset) ? nextReset : null};
}

// The caller associates an accepted failure with the account recorded at
// dispatch, even if the machine has since signed in to a different account.
export function recordQuota(holds, dispatched, errorInfo, reset, now) {
  if (errorInfo?.category !== 'rate-limit' || !Number.isSafeInteger(reset) || reset <= now) return;
  holds.set(dispatched.account, Math.max(holds.get(dispatched.account) ?? 0, reset));
}
