import type { PublicDocumentResult } from "./network-scan.js";

interface Entry {
  controller: AbortController;
  promise: Promise<PublicDocumentResult>;
  consumers: number;
  expiresAt: number;
  document?: PublicDocumentResult;
}

/** Share bounded public document reads within a scan; cancelling one owner never cancels another. */
export class WebsitePathDocumentCache {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;

  constructor(private readonly limits = { entries: 128, bytes: 64 * 1024 * 1024, ttlMs: 120_000 }) {}

  async read(key: string, loader: (signal: AbortSignal) => Promise<PublicDocumentResult>, signal: AbortSignal) {
    signal.throwIfAborted();
    this.prune();
    let entry = this.entries.get(key);
    const cacheHit = Boolean(entry);
    if (!entry && this.entries.size >= this.limits.entries && ![...this.entries.values()].some(value => value.document)) {
      return { document: await loader(signal), cacheHit: false };
    }
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    } else {
      const controller = new AbortController();
      entry = { controller, consumers: 0, expiresAt: Date.now() + this.limits.ttlMs, promise: undefined! };
      const created = entry;
      this.entries.set(key, created);
      created.promise = Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return loader(controller.signal);
      }).then(document => {
        if (this.entries.get(key) === created) {
          // A retry must fetch again after an upstream rejection or failure status.
          if (document.statusCode < 200 || document.statusCode >= 400 || document.body.length > this.limits.bytes) this.remove(key, created);
          else {
            created.document = document;
            created.expiresAt = Date.now() + this.limits.ttlMs;
            this.bytes += document.body.length;
            this.prune();
          }
        }
        return document;
      }, error => {
        this.remove(key, created);
        throw error;
      });
      void created.promise.catch(() => {});
      this.prune();
    }
    const selected = entry;
    selected.consumers++;
    let stop!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      stop = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", stop, { once: true });
    });
    try {
      signal.throwIfAborted();
      return { document: await Promise.race([selected.promise, cancelled]), cacheHit };
    } finally {
      signal.removeEventListener("abort", stop);
      selected.consumers--;
      if (!selected.consumers && !selected.document) {
        this.remove(key, selected);
        selected.controller.abort();
      }
    }
  }

  private remove(key: string, entry: Entry) {
    if (this.entries.get(key) !== entry) return;
    this.entries.delete(key);
    if (entry.document) this.bytes -= entry.document.body.length;
  }

  private prune() {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.document && (entry.expiresAt <= now || this.bytes > this.limits.bytes || this.entries.size > this.limits.entries)) this.remove(key, entry);
    }
  }
}

export const websitePathDocumentCache = new WebsitePathDocumentCache();
