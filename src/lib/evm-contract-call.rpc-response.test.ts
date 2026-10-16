import { describe, expect, it, vi } from "vitest";
import { executeEvmContractCallBatch, prepareEvmContractCallBatch, type EvmContractCallConfig } from "./evm-contract-call";

const key = `0x${"1".padStart(64, "0")}`;
const settings: EvmContractCallConfig = {
  contractAddress: "0x00000000000000000000000000000000000000a1",
  calldataTemplate: "0x12345678{address}",
  rpcEndpoint: "https://rpc.example.test/",
  amount: { mode: "fixed", fixed: "0", min: "0", max: "0" },
  randomId: { min: "0", max: "0" },
  taskNum: 1,
  delay: { mode: "fixed", minMs: 0, maxMs: 0 },
  gasLimit: "50000",
  gasPriceGwei: "1"
};

async function executeWithBroadcastError(error: unknown) {
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { id: number; method: string };
    const payload = request.method === "eth_sendRawTransaction"
      ? { jsonrpc: "2.0", id: request.id, error }
      : { jsonrpc: "2.0", id: request.id, result: request.method === "eth_chainId" ? "0x1" : "0x0" };
    return new Response(JSON.stringify(payload));
  }) as unknown as typeof fetch;
  const batch = prepareEvmContractCallBatch(key, settings);
  const [row] = await executeEvmContractCallBatch(batch, { fetchImpl });
  return row;
}

describe("contract-call JSON-RPC error boundaries", () => {
  it("does not interpret unknown transaction as a known submitted transaction", async () => {
    const row = await executeWithBroadcastError({ code: -32000, message: "unknown transaction" });
    expect(row.status).toBe("failed");
    expect(row.message).not.toContain("已被 RPC 接收");
  });

  it.each([null, [], "rejected", {}, { code: -32000 }, { message: "rejected" }, { code: "-32000", message: "rejected" }])(
    "keeps a malformed broadcast error uncertain: %j",
    async error => {
      const row = await executeWithBroadcastError(error);
      expect(row.status).toBe("unknown");
      expect(row.hash).toMatch(/^0x[0-9a-f]{64}$/);
    }
  );

  it("requires hash verification if the pending nonce was consumed before broadcast", async () => {
    const row = await executeWithBroadcastError({ code: -32000, message: "nonce too low" });
    expect(row.status).toBe("unknown");
    expect(row.hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("disposes signing material when a batch is already stopped before execution", async () => {
    const abort = new AbortController();
    abort.abort();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const batch = prepareEvmContractCallBatch(key, settings);
    const rows = await executeEvmContractCallBatch(batch, { fetchImpl, signal: abort.signal });
    expect(rows[0].status).toBe("cancelled");
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(executeEvmContractCallBatch(batch, { fetchImpl })).rejects.toThrow("预览已失效");
  });
});
