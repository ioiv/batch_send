import { describe, expect, it, vi } from "vitest";
import type { Erc1155TransferDiscoveryClient } from "./erc1155-transfer-discovery";
import { discoverErc1155AssetsByTransfer } from "./erc1155-transfer-discovery";

const contract = "0x00000000000000000000000000000000000000b2";
const owner = "0x0000000000000000000000000000000000000011";

function createClient({
  balances = {},
  getLogs
}: {
  balances?: Record<string, bigint>;
  getLogs: (parameters: { args?: Record<string, unknown>; event?: { name?: string } }) => Promise<unknown[]>;
}) {
  const client = {
    getBlockNumber: vi.fn(async () => 100n),
    getLogs: vi.fn(getLogs),
    readContract: vi.fn(async (parameters: { args?: readonly unknown[]; blockNumber?: bigint }) => (
      balances[String(parameters.args?.[1])] || 0n
    ))
  };
  return {
    client: client as unknown as Erc1155TransferDiscoveryClient,
    mocks: client
  };
}

describe("discoverErc1155AssetsByTransfer", () => {
  it("deduplicates TransferSingle and TransferBatch IDs and keeps positive snapshot balances", async () => {
    const { client, mocks } = createClient({
      balances: { 7: 2n, 9: 1n },
      getLogs: async ({ args, event }) => {
        if (!args?.to) return [];
        if (event?.name === "TransferSingle") return [{ args: { id: 7n } }];
        if (event?.name === "TransferBatch") return [{ args: { ids: [7n, 8n, 9n], values: [1n, 1n, 1n] } }];
        return [];
      }
    });

    const result = await discoverErc1155AssetsByTransfer({
      contractAddress: contract,
      fromBlock: 0n,
      ownerAddresses: [owner],
      publicClient: client,
      toBlock: 100n
    });

    expect(result.complete).toBe(true);
    expect(result.candidateCount).toBe(3);
    expect(result.assets.map((asset) => asset.tokenId)).toEqual([7n, 9n]);
    expect(mocks.getLogs).toHaveBeenCalledTimes(4);
    expect(mocks.readContract).toHaveBeenCalledTimes(3);
    expect(mocks.readContract.mock.calls.every(([request]) => request.blockNumber === 100n)).toBe(true);
  });

  it("returns verified assets as partial when one balance read fails", async () => {
    const { client, mocks } = createClient({
      balances: { 3: 1n },
      getLogs: async ({ args, event }) => (
        args?.to && event?.name === "TransferBatch" ? [{ args: { ids: [2n, 3n], values: [1n, 1n] } }] : []
      )
    });
    mocks.readContract.mockImplementation(async (request: { args?: readonly unknown[]; blockNumber?: bigint }) => {
      if (request.args?.[1] === 2n) throw new Error("failed at https://rpc.example.test/private");
      return 1n;
    });

    const result = await discoverErc1155AssetsByTransfer({
      contractAddress: contract,
      fromBlock: 0n,
      ownerAddresses: [owner],
      publicClient: client,
      toBlock: 100n
    });

    expect(result.complete).toBe(false);
    expect(result.assets.map((asset) => asset.tokenId)).toEqual([3n]);
    expect(result.issues).toEqual([expect.objectContaining({ code: "balance-read-failed" })]);
    expect(JSON.stringify(result, (_key, value) => typeof value === "bigint" ? value.toString() : value))
      .not.toContain("rpc.example.test");
  });

  it("rejects invalid source input before querying logs", async () => {
    const { client, mocks } = createClient({ getLogs: async () => [] });
    const result = await discoverErc1155AssetsByTransfer({
      contractAddress: contract,
      fromBlock: 0n,
      ownerAddresses: ["not-an-address"],
      publicClient: client,
      toBlock: 100n
    });

    expect(result.complete).toBe(false);
    expect(result.issues[0]?.code).toBe("invalid-input");
    expect(mocks.getLogs).not.toHaveBeenCalled();
  });
});
