export interface CacheableSubdomainSourceResult {
  source: string;
  status: "success" | "partial" | "error";
  domains: string[];
  message?: string;
}

const MAX_CACHE_ENTRIES = 128;
const RESULT_TTL_MS = 10 * 60 * 1000;
const ERROR_TTL_MS = 30 * 1000;

type CacheEntry<TResult> = { result: TResult; expiresAt: number };

function copyResult<TResult extends CacheableSubdomainSourceResult>(result: TResult): TResult {
  return { ...result, domains: [...result.domains] };
}

/** Stores completed public-source responses only; each caller owns its own returned array. */
export class SubdomainSourceCache<TResult extends CacheableSubdomainSourceResult> {
  private readonly entries = new Map<string, CacheEntry<TResult>>();
  private readonly clock: () => number;

  constructor(options: { clock?: () => number } = {}) {
    this.clock = options.clock ?? Date.now;
  }

  read(key: string): TResult | undefined {
    this.removeExpired(this.clock());
    const entry = this.entries.get(key);
    return entry ? copyResult(entry.result) : undefined;
  }

  write(key: string, result: TResult): void {
    const now = this.clock();
    this.removeExpired(now);
    // Replacing a completed response refreshes both its TTL and eviction order.
    this.entries.delete(key);
    while (this.entries.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    this.entries.set(key, {
      result: copyResult(result),
      expiresAt: now + (result.status === "error" ? ERROR_TTL_MS : RESULT_TTL_MS)
    });
  }

  clear(): void {
    this.entries.clear();
  }

  private removeExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}
