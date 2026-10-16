import { afterEach, describe, expect, it, vi } from "vitest";
import { EvmRpcSyncPendingError, readWithEvmRpcSyncRetry } from "./evm-rpc-sync";

afterEach(() => vi.useRealTimers());

describe("confirmed-block balance recovery", () => {
  it("recovers after a lagging RPC catches up", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockRejectedValueOnce(new EvmRpcSyncPendingError()).mockResolvedValue(12n);
    const onWaiting = vi.fn();
    const result = readWithEvmRpcSyncRetry({ read, onWaiting, signal: new AbortController().signal });
    const assertion = expect(result).resolves.toBe(12n);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(onWaiting).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("stops after five unsuccessful reads and leaves a manual recovery path", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockRejectedValue(new EvmRpcSyncPendingError());
    const result = readWithEvmRpcSyncRetry({ read, onWaiting: vi.fn(), signal: new AbortController().signal });
    const assertion = expect(result).rejects.toBeInstanceOf(EvmRpcSyncPendingError);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(read).toHaveBeenCalledTimes(5);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["RPC 网络不匹配", "401 Unauthorized", "网络请求失败"])("does not retry unrelated failures: %s", async (message) => {
    const error = new Error(message);
    const read = vi.fn().mockRejectedValue(error);
    const onWaiting = vi.fn();
    await expect(readWithEvmRpcSyncRetry({ read, onWaiting, signal: new AbortController().signal })).rejects.toBe(error);
    expect(read).toHaveBeenCalledOnce();
    expect(onWaiting).not.toHaveBeenCalled();
  });

  it("cancels queued retries when the wallet or RPC context changes", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const read = vi.fn().mockRejectedValue(new EvmRpcSyncPendingError());
    const result = readWithEvmRpcSyncRetry({ read, onWaiting: vi.fn(), signal: controller.signal });
    const assertion = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await assertion;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(read).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("discards an in-flight result from an obsolete context", async () => {
    const controller = new AbortController();
    let finish!: (value: bigint) => void;
    const read = vi.fn(() => new Promise<bigint>(resolve => { finish = resolve; }));
    const result = readWithEvmRpcSyncRetry({ read, onWaiting: vi.fn(), signal: controller.signal });
    const assertion = expect(result).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    finish(999n);
    await assertion;
  });
});
