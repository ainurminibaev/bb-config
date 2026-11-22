import { nextRoute, recordQuota } from './routing.mjs';

// A retry is allowed only when the adapter confirms rejection before execution.
// The adapter owns session restoration and supplies an authoritative inventory.
export async function dispatchTurn({ turn, originHost, previous, inventory, holds, clock, send }) {
  const tried = new Set();
  while (true) {
    const now = clock();
    const route = nextRoute({ originHost, previous, hosts: await inventory(), holds, now });
    if (!route.account) return { status: 'waiting', route };
    if (tried.has(route.account)) return { status: 'retry-later', route };
    tried.add(route.account);
    const result = await send(route, turn);
    if (result.status !== 'rejected-before-execution' ||
        result.errorInfo?.category !== 'rate-limit' ||
        !Number.isSafeInteger(result.reset) || result.reset <= clock()) {
      return { ...result, route };
    }
    recordQuota(holds, route, result.errorInfo, result.reset, clock());
    previous = route;
  }
}
