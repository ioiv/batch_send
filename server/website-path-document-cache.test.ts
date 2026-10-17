import { describe, expect, it, vi } from "vitest";
import { WebsitePathDocumentCache } from "./website-path-document-cache";
import type { PublicDocumentResult } from "./network-scan";

const document = (text = "body", statusCode = 200): PublicDocumentResult => ({
  url: "https://example.com/app.js", body: Buffer.from(text), statusCode, truncated: false
});

describe("scan document reads", () => {
  it("shares the same download across owners but isolates different scan rounds", async () => {
    const cache = new WebsitePathDocumentCache();
    const loader = vi.fn(async () => document());
    const signal = new AbortController().signal;
    const [first, second] = await Promise.all([cache.read("round:script", loader, signal), cache.read("round:script", loader, signal)]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect((await cache.read("round:script", loader, signal)).cacheHit).toBe(true);
    await cache.read("another-round:script", loader, signal);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("detaches a cancelled owner while the sibling completes", async () => {
    const cache = new WebsitePathDocumentCache();
    let finish!: (value: PublicDocumentResult) => void;
    let shared!: AbortSignal;
    const loader = vi.fn((signal: AbortSignal) => { shared = signal; return new Promise<PublicDocumentResult>(resolve => { finish = resolve; }); });
    const firstOwner = new AbortController();
    const first = cache.read("round:script", loader, firstOwner.signal);
    const second = cache.read("round:script", loader, new AbortController().signal);
    await Promise.resolve();
    firstOwner.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(shared.aborted).toBe(false);
    finish(document());
    await expect(second).resolves.toMatchObject({ cacheHit: true });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("cancels an abandoned transport and lets a later attempt retry", async () => {
    const cache = new WebsitePathDocumentCache();
    const owner = new AbortController();
    let shared!: AbortSignal;
    const pending = cache.read("round:script", signal => {
      shared = signal;
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }, owner.signal);
    await Promise.resolve();
    owner.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(shared.aborted).toBe(true);
    expect((await cache.read("round:script", async () => document(), new AbortController().signal)).cacheHit).toBe(false);
  });

  it("does not retain failed reads or upstream failure responses", async () => {
    const cache = new WebsitePathDocumentCache();
    const signal = new AbortController().signal;
    const loader = vi.fn().mockRejectedValueOnce(new Error("connection lost")).mockResolvedValueOnce(document("unavailable", 503)).mockResolvedValue(document());
    await expect(cache.read("round:script", loader, signal)).rejects.toThrow("connection lost");
    expect((await cache.read("round:script", loader, signal)).document.statusCode).toBe(503);
    expect((await cache.read("round:script", loader, signal)).cacheHit).toBe(false);
    expect(loader).toHaveBeenCalledTimes(3);
  });

  it("bounds retained response bytes and entry count", async () => {
    const cache = new WebsitePathDocumentCache({ entries: 2, bytes: 8, ttlMs: 10000 });
    const signal = new AbortController().signal;
    const loader = vi.fn(async () => document());
    await cache.read("a", loader, signal);
    await cache.read("b", loader, signal);
    await cache.read("c", loader, signal);
    expect((await cache.read("a", loader, signal)).cacheHit).toBe(false);
    const oversized = vi.fn(async () => document("more than eight bytes"));
    await cache.read("large", oversized, signal);
    expect((await cache.read("large", oversized, signal)).cacheHit).toBe(false);
  });
});
