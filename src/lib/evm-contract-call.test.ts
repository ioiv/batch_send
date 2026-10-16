import { afterEach, describe, expect, it, vi } from "vitest";
import { Transaction, Wallet, getAddress, keccak256 } from "ethers";
import {
  disposeEvmContractCallBatch, executeEvmContractCallBatch, fillEvmCalldataTemplate, inspectEvmContractCallTarget,
  prepareEvmContractCallBatch, randomEvmContractCallInteger, retryEvmContractCallBatch, validateEvmContractCallConfig,
  type EvmContractCallConfig, type EvmContractCallRow
} from "./evm-contract-call";

const keys = [1, 2, 3, 4].map((value) => `0x${value.toString(16).padStart(64, "0")}`);
const contract = "0x00000000000000000000000000000000000000a1";
const endpoint = "https://rpc.example.test/?api-key=private-rpc-token";
const word = (value: bigint) => value.toString(16).padStart(64, "0");

function config(overrides: Partial<EvmContractCallConfig> = {}): EvmContractCallConfig {
  return {
    contractAddress: contract, calldataTemplate: "0xabcd{address}{random}{randowId}{randowId}", rpcEndpoint: endpoint,
    amount: { mode: "fixed", fixed: "0.000000000000000123", min: "0", max: "0" },
    randomId: { min: "9007199254740993123456789", max: "9007199254740993123456789" },
    taskNum: 2, delay: { mode: "fixed", minMs: 0, maxMs: 0 }, ...overrides
  };
}

type Request = { jsonrpc: string; id: number; method: string; params: unknown[] };
type RpcOverride = (request: Request) => unknown | Promise<unknown>;
function rpcHarness(override?: RpcOverride) {
  const requests: Request[] = [];
  const signedTransactions: Transaction[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => {
    const request = JSON.parse(String(options?.body)) as Request;
    requests.push(request);
    const overridden = await override?.(request);
    if (overridden instanceof Response) return overridden;
    let result = overridden;
    if (result === undefined) {
      switch (request.method) {
        case "eth_chainId": result = "0x1"; break;
        case "eth_getCode": result = "0x60006000"; break;
        case "eth_gasPrice": result = "0x3b9aca00"; break;
        case "eth_getTransactionCount": result = "0x7"; break;
        case "eth_estimateGas": result = "0x5209"; break;
        case "eth_sendRawTransaction": {
          const raw = request.params[0] as string;
          signedTransactions.push(Transaction.from(raw));
          result = keccak256(raw); break;
        }
        default: throw new Error("unexpected RPC method");
      }
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), { status: 200 });
  });
  return { requests, signedTransactions, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function errorResponse(request: Request, message: string, code = -32000) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code, message } }), { status: 200 });
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("raw EVM calldata templates and preparation", () => {
  it("encodes each supported placeholder as a full 32-byte word and reuses randomId exactly", () => {
    const address = new Wallet(keys[0]).address;
    const amountWei = 123456789012345678901234567890n;
    const randomId = (1n << 256n) - 1n;
    expect(fillEvmCalldataTemplate({ template: "0x{address}{random}{randomId}{randowId}{randomId}", address, amountWei, randomId }))
      .toBe(`0x${address.slice(2).toLowerCase().padStart(64, "0")}${word(amountWei)}${word(randomId)}${word(randomId)}${word(randomId)}`);
  });

  it.each(["0xabc", "0x{randomID}", "0x{address", "0x{random}}", "abcd", "0xgg", "0x12 34"])("rejects malformed calldata %s", (template) => {
    expect(() => validateEvmContractCallConfig(config({ calldataTemplate: template }))).toThrow("calldata");
  });

  it("bounds calldata after placeholder expansion", () => {
    expect(() => validateEvmContractCallConfig(config({ calldataTemplate: `0x${"{random}".repeat(5000)}` }))).toThrow("展开后的 calldata 过长");
  });

  it("rejects unsafe values before any network or signing, and permits zero-value calls", () => {
    expect(() => prepareEvmContractCallBatch(keys[0], config({ amount: { mode: "fixed", fixed: "1.0000000000000000001", min: "", max: "" } }))).toThrow("18 位小数");
    expect(() => prepareEvmContractCallBatch(keys[0], config({ randomId: { min: "0", max: (1n << 256n).toString() } }))).toThrow();
    expect(() => prepareEvmContractCallBatch(keys[0], config({ taskNum: 0 }))).toThrow("线程数");
    expect(() => prepareEvmContractCallBatch(keys[0], config({ rpcEndpoint: "javascript:alert(1)" }))).toThrow("RPC");
    expect(() => prepareEvmContractCallBatch(`${keys[0]}\ninvalid key`, config())).toThrow("无效条目");
    const batch = prepareEvmContractCallBatch(keys[0], config({ amount: { mode: "fixed", fixed: "0", min: "", max: "" } }));
    expect(batch.rows[0].amountWei).toBe(0n);
  });

  it("deduplicates wallets, freezes previews, and never attaches private keys or signer objects", () => {
    const batch = prepareEvmContractCallBatch(`first,${keys[0]}\nagain,${keys[0]}\nsecond,${keys[1]}`, config());
    expect(batch.rows).toHaveLength(2);
    expect(batch.rows.map((row) => row.line)).toEqual([1, 3]);
    expect(Object.isFrozen(batch)).toBe(true);
    expect(Object.isFrozen(batch.rows)).toBe(true);
    expect(Object.isFrozen(batch.rows[0])).toBe(true);
    expect(Object.isFrozen(batch.config.amount)).toBe(true);
    const exposed = JSON.stringify(batch, (_key, value) => typeof value === "bigint" ? value.toString() : value);
    for (const key of keys) expect(exposed).not.toContain(key);
    expect(exposed).not.toContain("signer");
  });

  it("prepares independent repeated calls after wallet deduplication and fixes every sampled value", () => {
    const random = vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(array => {
      (array as Uint8Array).fill((random.mock.calls.length - 1) % 3);
      return array;
    });
    const batch = prepareEvmContractCallBatch(`alpha,${keys[0]}\nduplicate,${keys[0]}\nbeta,${keys[1]}`, config({
      callsPerWallet: 3,
      amount: { mode: "random", fixed: "", min: "0", max: "0.000000000000000002" },
      randomId: { min: "10", max: "12" }
    }));
    expect(batch.rows).toHaveLength(6);
    expect(new Set(batch.rows.map(row => row.id)).size).toBe(6);
    expect(batch.rows.map(row => [row.walletIndex, row.callIndex, row.callsPerWallet, row.line]))
      .toEqual([[0, 1, 3, 1], [0, 2, 3, 1], [0, 3, 3, 1], [1, 1, 3, 3], [1, 2, 3, 3], [1, 3, 3, 3]]);
    expect(new Set(batch.rows.slice(0, 3).map(row => row.amountWei)).size).toBe(3);
    expect(new Set(batch.rows.slice(0, 3).map(row => row.randomId)).size).toBe(3);
    batch.rows.forEach(row => {
      expect(row.calldata).toBe(`0xabcd${row.address.slice(2).toLowerCase().padStart(64, "0")}${word(row.amountWei)}${word(row.randomId)}${word(row.randomId)}`);
      expect(Object.isFrozen(row)).toBe(true);
    });
    disposeEvmContractCallBatch(batch);
  });

  it.each([0, -1, 1.5, 101, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid per-wallet call counts %s", callsPerWallet => {
    expect(() => prepareEvmContractCallBatch(keys[0], config({ callsPerWallet }))).toThrow("每钱包执行次数");
  });

  it("bounds expanded workload before sampling transaction data", () => {
    const manyKeys = Array.from({ length: 101 }, (_, index) => `0x${(index + 1).toString(16).padStart(64, "0")}`).join("\n");
    const random = vi.spyOn(globalThis.crypto, "getRandomValues");
    expect(() => prepareEvmContractCallBatch(manyKeys, config({ callsPerWallet: 100 }))).toThrow("调用总数不能超过");
    expect(() => prepareEvmContractCallBatch(keys[0], config({ callsPerWallet: 100, calldataTemplate: `0x${"00".repeat(100_000)}` }))).toThrow("调用数据总量过大");
    expect(random).not.toHaveBeenCalled();
  });

  it("samples inclusively with rejection sampling beyond Number precision", () => {
    const min = 9007199254740993123456789n;
    const rng = vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((array) => {
      (array as Uint8Array).fill(rng.mock.calls.length === 1 ? 255 : 2);
      return array;
    });
    // A span of 3 first rejects masked 255 = 3, then accepts 2.
    expect(randomEvmContractCallInteger(min, min + 2n)).toBe(min + 2n);
    expect(rng).toHaveBeenCalledTimes(2);
    expect(randomEvmContractCallInteger(min, min)).toBe(min);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])("rejects an unsafe expected chain id %s", expectedChainId => {
    expect(() => validateEvmContractCallConfig(config({ expectedChainId }))).toThrow("Chain ID");
  });
});

describe("read-only contract target inspection", () => {
  it("checks the selected network and contract code without accessing or broadcasting wallets", async () => {
    const { requests, signedTransactions, fetchImpl } = rpcHarness();
    await expect(inspectEvmContractCallTarget(config({ expectedChainId: 1 }), { fetchImpl })).resolves.toEqual({ chainId: 1 });
    expect(requests.map(request => request.method).sort()).toEqual(["eth_chainId", "eth_getCode"]);
    expect(requests.find(request => request.method === "eth_getCode")?.params).toEqual([getAddress(contract), "latest"]);
    expect(signedTransactions).toHaveLength(0);
  });

  it("rejects an address without contract code", async () => {
    const { fetchImpl } = rpcHarness(request => request.method === "eth_getCode" ? "0x" : undefined);
    await expect(inspectEvmContractCallTarget(config(), { fetchImpl })).rejects.toThrow("没有合约代码");
  });

  it.each(["0x0", "0xzz", null, 123])("rejects malformed contract code %j", async code => {
    const { fetchImpl } = rpcHarness(request => request.method === "eth_getCode" ? code : undefined);
    await expect(inspectEvmContractCallTarget(config(), { fetchImpl })).rejects.toThrow("合约代码响应无效");
  });

  it("rejects a different network and a chain id that cannot be represented safely", async () => {
    const { fetchImpl } = rpcHarness();
    await expect(inspectEvmContractCallTarget(config({ expectedChainId: 137 }), { fetchImpl })).rejects.toThrow("RPC 网络不匹配");
    const hugeChain = rpcHarness(request => request.method === "eth_chainId" ? "0x20000000000000" : undefined);
    await expect(inspectEvmContractCallTarget(config(), { fetchImpl: hugeChain.fetchImpl })).rejects.toThrow("Chain ID 超出允许范围");
  });

  it("redacts upstream errors and honors cancellation before making requests", async () => {
    const { fetchImpl } = rpcHarness(request => request.method === "eth_getCode" ? errorResponse(request, `${keys[0]} ${endpoint}`) : undefined);
    await expect(inspectEvmContractCallTarget(config(), { fetchImpl })).rejects.toThrow("RPC 拒绝请求（错误码 -32000）");
    const abort = new AbortController();
    abort.abort();
    const stoppedFetch = vi.fn() as unknown as typeof fetch;
    await expect(inspectEvmContractCallTarget(config(), { fetchImpl: stoppedFetch, signal: abort.signal })).rejects.toThrow("任务已停止");
    expect(stoppedFetch).not.toHaveBeenCalled();
  });
});

describe("continuing known unbroadcast calls", () => {
  it("continues multiple unsent calls from the same wallet without expanding or randomizing them again", async () => {
    const settings = config({ callsPerWallet: 3 });
    const original = prepareEvmContractCallBatch(keys.slice(0, 2).join("\n"), settings);
    const previous: EvmContractCallRow[] = original.rows.map((row, index) => ({
      ...row, status: index === 1 || index === 5 ? "failed" : index === 2 ? "cancelled" : "submitted",
      hash: index === 1 || index === 2 || index === 5 ? null : `0x${"a".repeat(64)}`
    }));
    disposeEvmContractCallBatch(original);
    const random = vi.spyOn(globalThis.crypto, "getRandomValues");
    const retry = retryEvmContractCallBatch(keys.slice(0, 2).reverse().join("\n"), settings, [...previous].reverse());
    expect(random).not.toHaveBeenCalled();
    expect(retry.rows.map(row => row.index)).toEqual([1, 2, 5]);
    retry.rows.forEach(row => expect(row).toEqual({ ...previous[row.index], status: "pending", hash: null, message: expect.any(String) }));
    const { signedTransactions, fetchImpl } = rpcHarness();
    const final = await executeEvmContractCallBatch(retry, { fetchImpl });
    expect(final.every(row => row.status === "submitted")).toBe(true);
    for (const row of retry.rows) {
      const tx = signedTransactions.find(transaction => transaction.from === row.address && transaction.nonce === (row.walletIndex === 0 && row.callIndex === 3 ? 8 : 7));
      expect(tx?.data).toBe(row.calldata);
      expect(tx?.value).toBe(row.amountWei);
    }
  });
  it("preserves sampled transaction data, labels and identity while matching reordered keys by address", async () => {
    const settings = config({
      amount: { mode: "random", fixed: "", min: "0.001", max: "0.002" },
      randomId: { min: "100", max: "200" }
    });
    const original = prepareEvmContractCallBatch(`alpha,${keys[0]}\nbravo,${keys[1]}`, settings);
    const previous: EvmContractCallRow[] = original.rows.map((row, index) => ({ ...row, status: index ? "cancelled" : "failed", message: "未广播" }));
    disposeEvmContractCallBatch(original);
    const random = vi.spyOn(globalThis.crypto, "getRandomValues");
    const retry = retryEvmContractCallBatch(`new bravo,${keys[1]}\nnew alpha,${keys[0]}`, settings, previous);
    expect(random).not.toHaveBeenCalled();
    expect(Object.isFrozen(retry.rows[0])).toBe(true);
    for (const [index, row] of retry.rows.entries()) {
      expect(row).toEqual({ ...previous[index], status: "pending", hash: null, message: expect.any(String) });
    }
    const { signedTransactions, fetchImpl } = rpcHarness();
    const results = await executeEvmContractCallBatch(retry, { fetchImpl });
    expect(results.map(row => row.status)).toEqual(["submitted", "submitted"]);
    signedTransactions.forEach((transaction, index) => {
      expect(transaction.from).toBe(previous[index].address);
      expect(transaction.value).toBe(previous[index].amountWei);
      expect(transaction.data).toBe(previous[index].calldata);
    });
    expect(previous.map(row => row.status)).toEqual(["failed", "cancelled"]);
  });

  it("excludes submitted, uncertain and any hash-bearing records, retaining original noncontiguous indices", () => {
    const original = prepareEvmContractCallBatch(keys.join("\n"), config());
    const previous: EvmContractCallRow[] = [
      { ...original.rows[0], status: "submitted", hash: `0x${"1".repeat(64)}` },
      { ...original.rows[1], status: "unknown" },
      { ...original.rows[2], status: "failed", hash: `0x${"2".repeat(64)}` },
      { ...original.rows[3], status: "cancelled" }
    ];
    const retry = retryEvmContractCallBatch(keys[3], config(), previous);
    expect(retry.rows).toHaveLength(1);
    expect(retry.rows[0]).toMatchObject({ id: original.rows[3].id, index: 3, line: 4, address: original.rows[3].address, status: "pending" });
    disposeEvmContractCallBatch(original);
    disposeEvmContractCallBatch(retry);
  });

  it("reports missing keys and refuses batches with no eligible calls", () => {
    const original = prepareEvmContractCallBatch(keys[0], config());
    const failed = [{ ...original.rows[0], status: "failed" as const }];
    expect(() => retryEvmContractCallBatch(keys[1], config(), failed)).toThrow("缺少私钥");
    expect(() => retryEvmContractCallBatch("", config(), failed)).toThrow("缺少私钥");
    expect(() => retryEvmContractCallBatch(keys[0], config(), [{ ...original.rows[0], status: "unknown" }])).toThrow("没有可继续");
    expect(() => retryEvmContractCallBatch(keys[0], config(), [{ ...failed[0], hash: `0x${"3".repeat(64)}` }])).toThrow("没有可继续");
    expect(() => retryEvmContractCallBatch(keys[0], config(), [failed[0], failed[0]])).toThrow("重复调用或记录");
    disposeEvmContractCallBatch(original);
  });
});

describe("offline signing and raw RPC broadcast", () => {
  it("serializes each wallet's calls with increasing nonces despite stale pending RPC values", async () => {
    vi.useFakeTimers();
    const active = new Map<string, number>();
    let peak = 0;
    const { signedTransactions, fetchImpl } = rpcHarness(async request => {
      if (request.method !== "eth_sendRawTransaction") return;
      const tx = Transaction.from(request.params[0] as string);
      const address = tx.from!;
      expect(active.get(address) || 0).toBe(0);
      active.set(address, 1);
      peak = Math.max(peak, [...active.values()].reduce((sum, count) => sum + count, 0));
      await new Promise(resolve => setTimeout(resolve, 5));
      active.set(address, 0);
    });
    const batch = prepareEvmContractCallBatch(keys.slice(0, 2).join("\n"), config({ callsPerWallet: 3, taskNum: 2 }));
    const run = executeEvmContractCallBatch(batch, { fetchImpl });
    await vi.runAllTimersAsync();
    const rows = await run;
    expect(rows.every(row => row.status === "submitted")).toBe(true);
    expect(new Set(rows.map(row => row.hash)).size).toBe(6);
    for (const address of new Set(batch.rows.map(row => row.address))) {
      expect(signedTransactions.filter(tx => tx.from === address).map(tx => tx.nonce)).toEqual([7, 8, 9]);
    }
    expect(peak).toBe(2);
  });

  it.each(["estimate failure", "broadcast uncertain"])("stops a wallet's later calls after %s while other wallets continue", async failure => {
    const firstAddress = new Wallet(keys[0]).address;
    const { requests, fetchImpl } = rpcHarness(request => {
      if (failure === "estimate failure" && request.method === "eth_estimateGas" && (request.params[0] as { from: string }).from === firstAddress) {
        return errorResponse(request, "execution reverted");
      }
      if (failure === "broadcast uncertain" && request.method === "eth_sendRawTransaction" && Transaction.from(request.params[0] as string).from === firstAddress) {
        return errorResponse(request, "nonce too low");
      }
    });
    const batch = prepareEvmContractCallBatch(keys.slice(0, 2).join("\n"), config({ callsPerWallet: 3 }));
    const rows = await executeEvmContractCallBatch(batch, { fetchImpl });
    expect(rows.map(row => row.status)).toEqual([failure === "estimate failure" ? "failed" : "unknown", "cancelled", "cancelled", "submitted", "submitted", "submitted"]);
    expect(rows.slice(1, 3).every(row => row.hash === null && row.message.includes("后续调用未发送"))).toBe(true);
    expect(requests.filter(request => request.method === "eth_sendRawTransaction")).toHaveLength(failure === "estimate failure" ? 3 : 4);
  });

  it("applies the task interval between calls within one wallet without delaying after the last call", async () => {
    vi.useFakeTimers();
    const starts: number[] = [];
    const { fetchImpl } = rpcHarness(request => { if (request.method === "eth_getTransactionCount") starts.push(Date.now()); });
    const batch = prepareEvmContractCallBatch(keys[0], config({ callsPerWallet: 3, delay: { mode: "fixed", minMs: 100, maxMs: 100 } }));
    const start = Date.now();
    const run = executeEvmContractCallBatch(batch, { fetchImpl });
    await vi.runAllTimersAsync();
    expect((await run).every(row => row.status === "submitted")).toBe(true);
    expect(starts.map(time => time - start)).toEqual([0, 100, 200]);
    expect(Date.now() - start).toBe(200);
  });

  it("stops the remaining calls of the current wallet when a broadcast is interrupted", async () => {
    const abort = new AbortController();
    const { requests, fetchImpl } = rpcHarness(request => {
      if (request.method === "eth_sendRawTransaction") { abort.abort(); return new Promise(() => {}); }
    });
    const batch = prepareEvmContractCallBatch(keys[0], config({ callsPerWallet: 3 }));
    const rows = await executeEvmContractCallBatch(batch, { fetchImpl, signal: abort.signal });
    expect(rows.map(row => row.status)).toEqual(["unknown", "cancelled", "cancelled"]);
    expect(rows[0].hash).toMatch(/^0x[\da-f]{64}$/);
    expect(rows.slice(1).every(row => row.hash === null)).toBe(true);
    expect(requests.filter(request => request.method === "eth_sendRawTransaction")).toHaveLength(1);
  });
  it("fails every unbroadcast wallet if the RPC network differs from the prepared network", async () => {
    const batch = prepareEvmContractCallBatch(keys.slice(0, 2).join("\n"), config({ expectedChainId: 137 }));
    const { requests, signedTransactions, fetchImpl } = rpcHarness();
    const results = await executeEvmContractCallBatch(batch, { fetchImpl });
    expect(results.every(row => row.status === "failed" && row.hash === null && row.message.includes("RPC 网络不匹配"))).toBe(true);
    expect(requests.map(request => request.method).sort()).toEqual(["eth_chainId", "eth_gasPrice"]);
    expect(signedTransactions).toHaveLength(0);
  });

  it("signs exactly the prepared preview, with pending nonce, protected chain id and per-wallet gas", async () => {
    const batch = prepareEvmContractCallBatch(keys.slice(0, 2).join("\n"), config());
    const { requests, signedTransactions, fetchImpl } = rpcHarness();
    const updates: EvmContractCallRow[] = [];
    const results = await executeEvmContractCallBatch(batch, { fetchImpl, onUpdate: (row) => updates.push(row) });
    expect(results.map((row) => row.status)).toEqual(["submitted", "submitted"]);
    for (const [index, tx] of signedTransactions.entries()) {
      const preview = batch.rows[index];
      expect(tx.from).toBe(preview.address);
      expect(tx.to?.toLowerCase()).toBe(contract);
      expect(tx.data).toBe(preview.calldata);
      expect(tx.value).toBe(preview.amountWei);
      expect(tx.chainId).toBe(1n);
      expect(tx.nonce).toBe(7);
      expect(tx.gasPrice).toBe(1_000_000_000n);
      expect(tx.gasLimit).toBe(25202n);
      expect(results[index].hash).toBe(tx.hash);
    }
    for (const request of requests.filter((item) => item.method === "eth_getTransactionCount")) expect(request.params[1]).toBe("pending");
    for (const request of requests.filter((item) => item.method === "eth_estimateGas")) {
      const tx = request.params[0] as Record<string, unknown>;
      const preview = batch.rows.find((row) => row.address === tx.from)!;
      expect(tx.data).toBe(preview.calldata);
      expect(tx.value).toBe("0x7b");
    }
    const wire = JSON.stringify(requests);
    for (const key of keys) expect(wire).not.toContain(`"${key}"`);
    expect(updates.some((row) => row.status === "signing")).toBe(true);
    expect(updates.some((row) => row.status === "sending")).toBe(true);
    await expect(executeEvmContractCallBatch(batch, { fetchImpl })).rejects.toThrow("预览已失效");
  });

  it("keeps sampled amounts and IDs unchanged between preview and execution", async () => {
    const batch = prepareEvmContractCallBatch(keys[0], config({
      amount: { mode: "random", fixed: "", min: "0.001", max: "0.002" },
      randomId: { min: "10000000000000000000", max: "10000000000000000009" }
    }));
    const preview = { ...batch.rows[0] };
    const { signedTransactions, fetchImpl } = rpcHarness();
    const results = await executeEvmContractCallBatch(batch, { fetchImpl });
    expect(signedTransactions[0].data).toBe(preview.calldata);
    expect(signedTransactions[0].value).toBe(preview.amountWei);
    expect(results[0].randomId).toBe(preview.randomId);
  });

  it("supports explicit gas settings without reading a gas estimate or network gas price", async () => {
    const batch = prepareEvmContractCallBatch(keys[0], config({ gasLimit: "50000", gasPriceGwei: "0.123456789" }));
    const { requests, signedTransactions, fetchImpl } = rpcHarness();
    await executeEvmContractCallBatch(batch, { fetchImpl });
    expect(requests.map((request) => request.method)).not.toContain("eth_estimateGas");
    expect(requests.map((request) => request.method)).not.toContain("eth_gasPrice");
    expect(signedTransactions[0].gasLimit).toBe(50000n);
    expect(signedTransactions[0].gasPrice).toBe(123456789n);
  });

  it.each(["0", ""])("supports zero gas prices on free-gas EVM networks (manual %s)", async (gasPriceGwei) => {
    const { signedTransactions, fetchImpl } = rpcHarness((request) => request.method === "eth_gasPrice" ? "0x0" : undefined);
    const batch = prepareEvmContractCallBatch(keys[0], config({ gasPriceGwei }));
    const [row] = await executeEvmContractCallBatch(batch, { fetchImpl });
    expect(row.status).toBe("submitted");
    expect(signedTransactions[0].gasPrice).toBe(0n);
  });

  it("contains failures per wallet, hides upstream secrets, and never retries broadcasts", async () => {
    let sends = 0;
    const { requests, fetchImpl } = rpcHarness((request) => {
      if (request.method === "eth_sendRawTransaction" && ++sends === 1) return errorResponse(request, `leak ${keys[0]} ${endpoint} signed ${request.params[0]}`);
    });
    const batch = prepareEvmContractCallBatch(keys.slice(0, 2).join("\n"), config());
    const rows = await executeEvmContractCallBatch(batch, { fetchImpl });
    expect(rows.map((row) => row.status)).toEqual(["failed", "submitted"]);
    expect(rows[0].message).toBe("RPC 拒绝请求（错误码 -32000）");
    expect(rows[0].message).not.toContain(keys[0]);
    expect(rows[0].message).not.toContain(endpoint);
    expect(requests.filter((request) => request.method === "eth_sendRawTransaction")).toHaveLength(2);
  });

  it("retains locally computed hash for mismatched RPC hash and counts already-known as submitted", async () => {
    let sends = 0;
    const { fetchImpl } = rpcHarness((request) => {
      if (request.method !== "eth_sendRawTransaction") return;
      return ++sends === 1 ? `0x${"f".repeat(64)}` : errorResponse(request, "already known");
    });
    const batch = prepareEvmContractCallBatch(keys.slice(0, 2).join("\n"), config());
    const rows = await executeEvmContractCallBatch(batch, { fetchImpl });
    expect(rows.map((row) => row.status)).toEqual(["unknown", "submitted"]);
    expect(rows[0].hash).toMatch(/^0x[\da-f]{64}$/);
    expect(rows[0].hash).not.toBe(`0x${"f".repeat(64)}`);
  });

  it("cancels queued wallets and retains the active broadcast hash on stop", async () => {
    const controller = new AbortController();
    const { requests, fetchImpl } = rpcHarness((request) => {
      if (request.method === "eth_sendRawTransaction") {
        controller.abort();
        return new Promise(() => {});
      }
    });
    const batch = prepareEvmContractCallBatch(keys.slice(0, 3).join("\n"), config({ taskNum: 1 }));
    const rows = await executeEvmContractCallBatch(batch, { fetchImpl, signal: controller.signal });
    expect(rows.map((row) => row.status)).toEqual(["unknown", "cancelled", "cancelled"]);
    expect(rows[0].hash).toMatch(/^0x[\da-f]{64}$/);
    expect(rows.slice(1).every((row) => row.hash === null)).toBe(true);
    expect(requests.filter((request) => request.method === "eth_sendRawTransaction")).toHaveLength(1);
  });

  it("stops before signing or broadcasting when the local signing update triggers cancellation", async () => {
    const controller = new AbortController();
    const { requests, fetchImpl } = rpcHarness();
    const batch = prepareEvmContractCallBatch(keys[0], config());
    const rows = await executeEvmContractCallBatch(batch, { fetchImpl, signal: controller.signal, onUpdate: (row) => { if (row.status === "signing") controller.abort(); } });
    expect(rows[0].status).toBe("cancelled");
    expect(rows[0].hash).toBeNull();
    expect(requests.some((request) => request.method === "eth_sendRawTransaction")).toBe(false);
  });

  it("bounds complete wallet workers to taskNum, including their delay before the next task", async () => {
    vi.useFakeTimers();
    let active = 0;
    let peak = 0;
    const starts: number[] = [];
    const { fetchImpl } = rpcHarness(async (request) => {
      if (request.method === "eth_getTransactionCount") starts.push(Date.now());
      if (request.method === "eth_sendRawTransaction") {
        peak = Math.max(peak, ++active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
      }
    });
    const batch = prepareEvmContractCallBatch(keys.join("\n"), config({ taskNum: 2, delay: { mode: "fixed", minMs: 100, maxMs: 100 } }));
    const run = executeEvmContractCallBatch(batch, { fetchImpl });
    await vi.runAllTimersAsync();
    const rows = await run;
    expect(rows.every((row) => row.status === "submitted")).toBe(true);
    expect(peak).toBe(2);
    expect(starts).toHaveLength(4);
    expect(starts[2] - starts[0]).toBeGreaterThanOrEqual(105);
    expect(starts[3] - starts[1]).toBeGreaterThanOrEqual(105);
  });

  it("finishes immediately after the final broadcast without an unnecessary final task delay", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const { fetchImpl } = rpcHarness();
    const batch = prepareEvmContractCallBatch(keys[0], config({ taskNum: 1, delay: { mode: "fixed", minMs: 300000, maxMs: 300000 } }));
    const run = executeEvmContractCallBatch(batch, { fetchImpl });
    await vi.runAllTimersAsync();
    const [row] = await run;
    expect(row.status).toBe("submitted");
    expect(Date.now() - start).toBe(0);
  });

  it("marks a POST timeout unknown without waiting for an uncooperative transport or retrying", async () => {
    vi.useFakeTimers();
    const { requests, fetchImpl } = rpcHarness((request) => request.method === "eth_sendRawTransaction" ? new Promise(() => {}) : undefined);
    const batch = prepareEvmContractCallBatch(keys[0], config({ requestTimeoutMs: 25 }));
    const run = executeEvmContractCallBatch(batch, { fetchImpl });
    await vi.runAllTimersAsync();
    const rows = await run;
    expect(rows[0].status).toBe("unknown");
    expect(rows[0].hash).toMatch(/^0x[\da-f]{64}$/);
    expect(requests.filter((request) => request.method === "eth_sendRawTransaction")).toHaveLength(1);
  });

  it("rejects malformed chain RPC responses before any wallet broadcast and allows disposal", async () => {
    const { requests, fetchImpl } = rpcHarness((request) => request.method === "eth_chainId" ? "0x01" : undefined);
    const batch = prepareEvmContractCallBatch(keys[0], config());
    const rows = await executeEvmContractCallBatch(batch, { fetchImpl });
    expect(rows[0].status).toBe("failed");
    expect(requests.some((request) => request.method === "eth_sendRawTransaction")).toBe(false);
    const disposed = prepareEvmContractCallBatch(keys[0], config());
    disposeEvmContractCallBatch(disposed);
    await expect(executeEvmContractCallBatch(disposed, { fetchImpl })).rejects.toThrow("预览已失效");
  });
});
