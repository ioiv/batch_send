import { describe, expect, it, vi } from "vitest";
import { CollectionPauseController } from "./collection-execution";
import { executeAutomaticCollection, type AutomaticCollectionPhase, type AutomaticCollectionTask, type AutomaticCollectionWallet } from "./collection-orchestrator";
import type { CollectionDisplayResult } from "./collection-results";

const transactionHash = `0x${"ab".repeat(32)}`;
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function task(address: string, phase: AutomaticCollectionPhase, suffix = "", execute?: AutomaticCollectionTask["execute"]): AutomaticCollectionTask {
  const preview: CollectionDisplayResult = { address, asset: phase, status: "pending", message: "等待归集" };
  return {
    id: `${address}-${phase}${suffix}`, phase, preview,
    execute: execute || vi.fn(async (): Promise<CollectionDisplayResult> => ({ ...preview, status: "success", message: "已确认" }))
  };
}
function wallet(address: string, tasks: AutomaticCollectionTask[], complete = true): AutomaticCollectionWallet {
  return { address, complete, issues: complete ? [] : ["扫描不完整"], native: null, tasks, verifyEmpty: vi.fn(async () => true) };
}
function run(wallets: AutomaticCollectionWallet[], overrides: Partial<Parameters<typeof executeAutomaticCollection>[0]> = {}) {
  return executeAutomaticCollection({ wallets, includeNative: true, pauseControl: new CollectionPauseController(), signal: new AbortController().signal, ...overrides });
}

describe("automatic collection orchestration", () => {
  it("finishes the token phase across all wallets before NFT and native phases begin", async () => {
    const events: string[] = [];
    const started = deferred(); const releaseSlowToken = deferred();
    const sources = ["a", "b", "c", "d"].map(address => wallet(address, ["token", "nft", "native"].map(phase => task(address, phase as AutomaticCollectionPhase, "", async () => {
      events.push(`start:${address}:${phase}`);
      if (address === "a" && phase === "token") { started.resolve(); await releaseSlowToken.promise; }
      events.push(`end:${address}:${phase}`);
      return { address, asset: phase, message: "已完成", status: "success" };
    }))));
    const phases: AutomaticCollectionPhase[] = [];
    const running = run(sources, { onPhase: phase => phases.push(phase) });
    await started.promise;
    await Promise.resolve(); await Promise.resolve();
    expect(events.some(event => event.endsWith(":nft") || event.endsWith(":native"))).toBe(false);
    releaseSlowToken.resolve();
    const results = await running;
    expect(phases).toEqual(["token", "nft", "native"]);
    const tokenEnd = Math.max(...events.map((event, index) => event.startsWith("end:") && event.endsWith(":token") ? index : -1));
    const nftStart = events.findIndex(event => event.startsWith("start:") && event.endsWith(":nft"));
    const nftEnd = Math.max(...events.map((event, index) => event.startsWith("end:") && event.endsWith(":nft") ? index : -1));
    const nativeStart = events.findIndex(event => event.startsWith("start:") && event.endsWith(":native"));
    expect(nftStart).toBeGreaterThan(tokenEnd);
    expect(nativeStart).toBeGreaterThan(nftEnd);
    expect(results).toHaveLength(12);
    expect(results.every(result => result.status === "success")).toBe(true);
  });

  it("never executes or rechecks native tasks when the optional sweep is disabled", async () => {
    const source = wallet("a", [task("a", "native"), task("a", "nft"), task("a", "token")]);
    const result = await run([source], { includeNative: false });
    expect(result.map(row => row.phase)).toEqual(["token", "nft"]);
    expect(source.tasks[0].execute).not.toHaveBeenCalled();
    expect(source.verifyEmpty).not.toHaveBeenCalled();
  });

  it("executes only selected assets and preserves native even if a fresh check would claim the wallet is empty", async () => {
    const selected = task("a", "token"); const retained = task("a", "nft"); const native = task("a", "native");
    const source = wallet("a", [selected, retained, native]);
    const results = await run([source], { selectedTaskIds: new Set([selected.id]) });
    expect(selected.execute).toHaveBeenCalledOnce();
    expect(retained.execute).not.toHaveBeenCalled();
    expect(native.execute).not.toHaveBeenCalled();
    expect(source.verifyEmpty).not.toHaveBeenCalled();
    expect(results[1]).toMatchObject({ status: "skipped", message: "本次未选择，已保留资产" });
    expect(results[2]).toMatchObject({ status: "skipped", message: "本钱包有未选择的资产，已保留原生币" });
  });

  it("keeps exclusion local to its wallet while other selected wallets can still sweep native", async () => {
    const first = wallet("a", [task("a", "token"), task("a", "native")]);
    const second = wallet("b", [task("b", "token"), task("b", "native")]);
    await run([first, second], { selectedTaskIds: new Set([second.tasks[0].id]) });
    expect(first.tasks[0].execute).not.toHaveBeenCalled();
    expect(first.tasks[1].execute).not.toHaveBeenCalled();
    expect(second.tasks[0].execute).toHaveBeenCalledOnce();
    expect(second.tasks[1].execute).toHaveBeenCalledOnce();
    expect(second.verifyEmpty).toHaveBeenCalledOnce();
  });

  it.each(["error", "skipped"] as const)("preserves gas after a %s asset result while other wallets still complete", async status => {
    const failedToken = task("a", "token", "", async () => ({ address: "a", asset: "token", status, message: "余额不足或资产未完成" }));
    const first = wallet("a", [failedToken, task("a", "nft"), task("a", "native")]);
    const second = wallet("b", [task("b", "token"), task("b", "native")]);
    const results = await run([first, second]);
    expect(first.tasks[1].execute).toHaveBeenCalledOnce();
    expect(first.tasks[2].execute).not.toHaveBeenCalled();
    expect(first.verifyEmpty).not.toHaveBeenCalled();
    expect(results.find(result => result.executionId === "a-native")).toMatchObject({ status: "skipped", retryable: false });
    expect(second.tasks[1].execute).toHaveBeenCalledOnce();
  });

  it("collects known assets from an incomplete inventory but keeps its native currency", async () => {
    const source = wallet("a", [task("a", "token"), task("a", "nft"), task("a", "native")], false);
    const result = await run([source]);
    expect(source.tasks[0].execute).toHaveBeenCalledOnce();
    expect(source.tasks[1].execute).toHaveBeenCalledOnce();
    expect(source.tasks[2].execute).not.toHaveBeenCalled();
    expect(source.verifyEmpty).not.toHaveBeenCalled();
    expect(result[2].message).toMatch(/扫描不完整.*保留原生币/);
  });

  it.each(["remaining", "unavailable"] as const)("requires a fresh empty-holdings check before native sweeping: %s", async failure => {
    const source = wallet("a", [task("a", "token"), task("a", "native")]);
    if (failure === "remaining") source.verifyEmpty = vi.fn(async () => false);
    else source.verifyEmpty = vi.fn(async () => { throw new Error("RPC 不可用"); });
    const result = await run([source]);
    expect(source.verifyEmpty).toHaveBeenCalledOnce();
    expect(source.tasks[1].execute).not.toHaveBeenCalled();
    expect(result[1]).toMatchObject({ status: "skipped", retryable: false });
    expect(result[1].message).toMatch(/保留原生币/);
  });

  it("keeps a hash observed before a throw and stops all later writes for that wallet", async () => {
    const first = task("a", "token", "first", async progress => {
      progress({ address: "a", asset: "token", status: "confirming", message: "已提交", hash: transactionHash });
      throw new Error("回执超时");
    });
    const second = task("a", "token", "second");
    const nft = task("a", "nft"); const native = task("a", "native");
    const source = wallet("a", [first, second, nft, native]);
    const publish = vi.fn();
    const result = await run([source], { onResult: publish });
    expect(result[0]).toMatchObject({ hash: transactionHash, status: "error", uncertain: true, retryable: false });
    expect(publish).toHaveBeenCalledWith(first.id, expect.objectContaining({ hash: transactionHash, status: "confirming" }));
    for (const later of [second, nft, native]) expect(later.execute).not.toHaveBeenCalled();
    expect(result.slice(1).every(row => row.status === "skipped" && row.retryable === false)).toBe(true);
    expect(source.verifyEmpty).not.toHaveBeenCalled();
  });

  it("allows later supported assets after a pre-submission error but retains native currency", async () => {
    const first = task("a", "token", "first", async () => { throw new Error("签名前模拟失败"); });
    const source = wallet("a", [first, task("a", "token", "second"), task("a", "native")]);
    const results = await run([source]);
    expect(results[0]).toMatchObject({ status: "error", uncertain: false, retryable: true });
    expect(source.tasks[1].execute).toHaveBeenCalledOnce();
    expect(source.tasks[2].execute).not.toHaveBeenCalled();
  });

  it("requires reconciliation when submission throws before returning a hash", async () => {
    const first = task("a", "token", "first", async progress => {
      progress({ address: "a", asset: "token", status: "submitting", message: "正在提交" });
      throw new Error("节点在响应前断开");
    });
    const second = task("a", "token", "second");
    const source = wallet("a", [first, second, task("a", "native")]);
    const results = await run([source]);
    expect(results[0]).toMatchObject({ status: "error", uncertain: true, retryable: false });
    expect(second.execute).not.toHaveBeenCalled();
    expect(source.tasks[2].execute).not.toHaveBeenCalled();
  });

  it("does not begin a write while paused, then resumes in the required order", async () => {
    const pause = new CollectionPauseController(); pause.pause();
    const source = wallet("a", [task("a", "token"), task("a", "native")]);
    const running = run([source], { pauseControl: pause });
    await Promise.resolve(); await Promise.resolve();
    expect(source.tasks[0].execute).not.toHaveBeenCalled();
    pause.resume();
    const results = await running;
    expect(results.map(result => result.status)).toEqual(["success", "success"]);
  });

  it("lets a submitted operation finish while paused but holds the next asset until resume", async () => {
    const pause = new CollectionPauseController();
    const started = deferred(); const finish = deferred();
    const first = task("a", "token", "first", async progress => {
      progress({ address: "a", asset: "token", hash: transactionHash, status: "confirming", message: "等待确认" });
      started.resolve(); await finish.promise;
      return { address: "a", asset: "token", hash: transactionHash, status: "success", message: "已确认" };
    });
    const second = task("a", "token", "second");
    const running = run([wallet("a", [first, second])], { pauseControl: pause, includeNative: false });
    await started.promise; pause.pause(); finish.resolve();
    await Promise.resolve(); await Promise.resolve();
    expect(second.execute).not.toHaveBeenCalled();
    pause.resume(); await running;
    expect(second.execute).toHaveBeenCalledOnce();
  });

  it("cancels a paused operation without submitting when its pause wait is released", async () => {
    const pause = new CollectionPauseController(); pause.pause();
    const abort = new AbortController();
    const source = wallet("a", [task("a", "token"), task("a", "nft"), task("a", "native")]);
    const running = run([source], { pauseControl: pause, signal: abort.signal });
    await Promise.resolve();
    abort.abort(); pause.resume();
    await running;
    for (const operation of source.tasks) expect(operation.execute).not.toHaveBeenCalled();
    expect(source.verifyEmpty).not.toHaveBeenCalled();
  });

  it("confirms an already-started operation but never starts another after cancellation", async () => {
    const abort = new AbortController();
    const source = wallet("a", [task("a", "token", "first", async progress => {
      progress({ address: "a", asset: "token", hash: transactionHash, status: "confirming", message: "等待确认" });
      abort.abort();
      return { address: "a", asset: "token", hash: transactionHash, status: "success", message: "已确认" };
    }), task("a", "token", "second"), task("a", "nft"), task("a", "native")]);
    const results = await run([source], { signal: abort.signal });
    expect(results[0]).toMatchObject({ hash: transactionHash, status: "success" });
    expect(results.slice(1).every(result => result.status === "skipped")).toBe(true);
    for (const operation of source.tasks.slice(1)) expect(operation.execute).not.toHaveBeenCalled();
  });

  it("does not sweep native if cancellation arrives during the final holdings check", async () => {
    const abort = new AbortController();
    const source = wallet("a", [task("a", "native")]);
    source.verifyEmpty = vi.fn(async () => { abort.abort(); return true; });
    await run([source], { signal: abort.signal });
    expect(source.tasks[0].execute).not.toHaveBeenCalled();
  });
});
