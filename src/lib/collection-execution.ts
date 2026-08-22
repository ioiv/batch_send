export type CollectionExecutionSettings = {
  concurrency: number;
  maximumDelayMs: number;
  minimumDelayMs: number;
};

export function normalizeCollectionExecutionSettings(
  settings: Partial<CollectionExecutionSettings> = {}
): CollectionExecutionSettings {
  const concurrency = Math.trunc(settings.concurrency ?? 1);
  const minimumDelayMs = Math.trunc(settings.minimumDelayMs ?? 0);
  const maximumDelayMs = Math.trunc(settings.maximumDelayMs ?? minimumDelayMs);
  if (!Number.isFinite(concurrency) || concurrency < 1 || concurrency > 20) {
    throw new RangeError("并发数需要是 1–20 的整数");
  }
  if (!Number.isFinite(minimumDelayMs) || !Number.isFinite(maximumDelayMs)
    || minimumDelayMs < 0 || maximumDelayMs < minimumDelayMs || maximumDelayMs > 300_000) {
    throw new RangeError("随机延迟需要是 0–300 秒的有效区间");
  }
  return { concurrency, maximumDelayMs, minimumDelayMs };
}

export async function waitForCollectionDelay(
  settings: Pick<CollectionExecutionSettings, "maximumDelayMs" | "minimumDelayMs">,
  random: () => number = Math.random
) {
  const { maximumDelayMs, minimumDelayMs } = settings;
  if (maximumDelayMs <= 0) return;
  const delay = minimumDelayMs + Math.floor(random() * (maximumDelayMs - minimumDelayMs + 1));
  await new Promise<void>((resolve) => globalThis.setTimeout(resolve, delay));
}

export async function mapWithCollectionConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
) {
  if (!items.length) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, Math.trunc(concurrency)), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}
