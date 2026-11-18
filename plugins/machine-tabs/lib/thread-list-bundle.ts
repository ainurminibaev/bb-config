interface Bundle {
  compatible: boolean;
}

interface Plugin<T extends Bundle> {
  id: string;
  enabled: boolean;
  status: string;
  app: { bundle: T | null };
}

function waitForRetry(signal: AbortSignal, delayMs: number) {
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export async function waitForThreadListBundle<T extends Bundle>(
  listPlugins: () => Promise<{ plugins: Plugin<T>[] }>,
  signal: AbortSignal,
  retryMs = 1_000,
): Promise<T> {
  let delayMs = retryMs;
  while (!signal.aborted) {
    const { plugins } = await listPlugins();
    signal.throwIfAborted();
    const threadList = plugins.find((plugin) => plugin.id === "thread-list");
    if (threadList?.status === "disabled") {
      throw new Error("Enable bb’s Thread list plugin in Settings → Plugins.");
    }
    if (threadList?.status === "error" || threadList?.status === "missing") {
      throw new Error("Check bb’s Thread list plugin in Settings → Plugins.");
    }
    const bundle = threadList?.app.bundle;
    if (threadList?.status === "incompatible" ||
        (threadList?.status !== "starting" && bundle?.compatible === false)) {
      throw new Error("This version of bb’s Thread list plugin is incompatible.");
    }
    if (bundle && threadList?.enabled && threadList.status !== "starting") {
      return bundle;
    }
    await waitForRetry(signal, delayMs);
    delayMs = Math.min(delayMs * 2, 5_000);
  }
  throw signal.reason;
}
