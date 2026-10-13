import { describe, expect, it, vi } from "vitest";
import { createStreamingScanQueue } from "./streaming-scan-queue";

describe("incremental scan consumers", () => {
  it("prioritizes new public paths and promotes queued probes without duplicate requests", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const order: string[] = [];
    const queue = createStreamingScanQueue({ concurrency: 1, signal: new AbortController().signal,
      scan: async (candidate: string) => { if (candidate === "active") await gate; order.push(candidate); return candidate; }, onResult: vi.fn() });
    queue.add("active");
    queue.add("probe");
    queue.add("overlap");
    queue.add("page", 1);
    queue.add("overlap", 1);
    release();
    await queue.done();
    expect(order).toEqual(["active", "page", "overlap", "probe"]);
  });

  it("publishes while discovery is open and drains newly discovered CNAME work", async () => {
    const onResult = vi.fn((value: string) => { if (value === "cname-source") queue.add("cname-target"); });
    const scan = vi.fn(async (value: string) => value);
    const queue = createStreamingScanQueue({ concurrency: 1, signal: new AbortController().signal, scan, onResult });
    queue.add("first");
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledWith("first"));
    queue.add("first");
    queue.add("cname-source");
    await queue.done();
    expect(scan.mock.calls.map(([value]) => value)).toEqual(["first", "cname-source", "cname-target"]);
    expect(onResult).toHaveBeenCalledTimes(3);
  });

  it("shares the worker limit with candidates added from completed results", async () => {
    let active = 0;
    let peak = 0;
    const queue = createStreamingScanQueue({ concurrency: 2, signal: new AbortController().signal,
      scan: async (candidate: string) => {
        peak = Math.max(peak, ++active);
        await Promise.resolve();
        active -= 1;
        return candidate;
      }, onResult: candidate => { if (candidate === "0") for (let index = 5; index < 10; index++) queue.add(String(index)); } });
    for (let index = 0; index < 5; index++) queue.add(String(index));
    await queue.done();
    expect(peak).toBe(2);
  });

  it("stops without waiting for an uncooperative transport and suppresses late results", async () => {
    const controller = new AbortController();
    let release!: (value: string) => void;
    const scan = vi.fn(() => new Promise<string>(resolve => { release = resolve; }));
    const onResult = vi.fn();
    const queue = createStreamingScanQueue({ concurrency: 1, signal: controller.signal, scan, onResult });
    queue.add("active");
    queue.add("queued");
    const done = queue.done();
    const rejection = expect(done).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(1));
    controller.abort();
    await rejection;
    release("late");
    await Promise.resolve();
    expect(onResult).not.toHaveBeenCalled();
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it("retains worker failures for the caller even before discovery closes", async () => {
    const queue = createStreamingScanQueue({ concurrency: 1, signal: new AbortController().signal,
      scan: vi.fn(async () => { throw new Error("service unavailable"); }), onResult: vi.fn() });
    queue.add("first");
    await Promise.resolve();
    await expect(queue.done()).rejects.toThrow("service unavailable");
    await queue.cancel();
  });
});
