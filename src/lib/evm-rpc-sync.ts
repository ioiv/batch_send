export class EvmRpcSyncPendingError extends Error {
  constructor() {
    super("RPC 尚未同步至交易确认区块，请稍后重试");
    this.name = "EvmRpcSyncPendingError";
  }
}

export function isEvmRpcSyncPendingError(error: unknown): error is EvmRpcSyncPendingError {
  return error instanceof EvmRpcSyncPendingError;
}

// Five reads over a 15-second backoff window. Only confirmed-block lag is retried.
const syncRetryDelays = [1_000, 2_000, 4_000, 8_000];

function waitForSyncRetry(delay: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function readWithEvmRpcSyncRetry<Value>({
  read,
  signal,
  onWaiting
}: {
  read: () => Promise<Value>;
  signal: AbortSignal;
  onWaiting: () => void;
}): Promise<Value> {
  for (let attempt = 0; ; attempt += 1) {
    signal.throwIfAborted();
    try {
      const value = await read();
      signal.throwIfAborted();
      return value;
    } catch (error) {
      signal.throwIfAborted();
      if (!isEvmRpcSyncPendingError(error) || attempt >= syncRetryDelays.length) throw error;
      onWaiting();
      await waitForSyncRetry(syncRetryDelays[attempt], signal);
    }
  }
}
