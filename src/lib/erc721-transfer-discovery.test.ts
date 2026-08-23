import { describe, expect, it, vi } from "vitest";
import { zeroAddress } from "viem";
import type { Erc721TransferDiscoveryClient } from "./erc721-transfer-discovery";
import {
  discoverErc721AssetsByTransfer,
  findErc721DeploymentBlock
} from "./erc721-transfer-discovery";

const contractAddress = "0x00000000000000000000000000000000000000b2";
const ownerOne = "0x0000000000000000000000000000000000000011";
const ownerTwo = "0x0000000000000000000000000000000000000022";
const otherOwner = "0x0000000000000000000000000000000000000033";

type LogParameters = {
  args?: Record<string, unknown>;
  event?: { name?: string };
  fromBlock?: bigint;
  toBlock?: bigint;
};

function transferLog(tokenId: bigint) {
  return { args: { tokenId } };
}

function consecutiveLog(fromTokenId: bigint, toTokenId: bigint) {
  return { args: { fromTokenId, toTokenId } };
}

function makeClient({
  balanceReadError,
  balancesByOwner,
  getLogs,
  ownersByToken = {}
}: {
  balanceReadError?: Error;
  balancesByOwner?: Record<string, bigint>;
  getLogs: (parameters: LogParameters) => Promise<unknown[]>;
  ownersByToken?: Record<string, string>;
}) {
  const client = {
    getBlockNumber: vi.fn(async () => 100n),
    getCode: vi.fn(async () => "0x1234"),
    getLogs: vi.fn(getLogs),
    readContract: vi.fn(async (parameters: {
      args?: readonly unknown[];
      blockNumber?: bigint;
      functionName?: string;
    }) => {
      if (parameters.functionName === "balanceOf") {
        if (balanceReadError) throw balanceReadError;
        const owner = String(parameters.args?.[0]).toLowerCase();
        if (balancesByOwner && owner in balancesByOwner) return balancesByOwner[owner];
        return BigInt(Object.values(ownersByToken).filter((value) => value.toLowerCase() === owner).length);
      }
      return ownersByToken[String(parameters.args?.[0])] || otherOwner;
    })
  };
  return {
    client: client as unknown as Erc721TransferDiscoveryClient,
    mocks: client
  };
}

describe("discoverErc721AssetsByTransfer", () => {
  it("finds Transfer candidates and only returns IDs that ownerOf verifies at the fixed snapshot", async () => {
    const { client, mocks } = makeClient({
      getLogs: async ({ args, event }) => {
        if (event?.name === "Transfer" && args?.from) return [transferLog(1n)];
        if (event?.name === "Transfer" && args?.to) return [transferLog(2n), transferLog(3n)];
        return [];
      },
      ownersByToken: {
        1: otherOwner,
        2: ownerOne,
        3: otherOwner
      }
    });

    const result = await discoverErc721AssetsByTransfer({
      contractAddress,
      fromBlock: 0n,
      ownerAddresses: [ownerOne, ownerTwo],
      publicClient: client,
      scope: "full-history",
      toBlock: 100n
    });

    expect(result.complete).toBe(true);
    expect(result.scope).toBe("full-history");
    expect(result.candidateCount).toBe(3);
    expect(result.assets.map((asset) => asset.tokenId)).toEqual([2n]);
    expect(result.rpcRequests).toBe(9);
    expect(mocks.getLogs).toHaveBeenCalledTimes(4);
    expect(mocks.readContract).toHaveBeenCalledTimes(5);
    expect(mocks.readContract.mock.calls.every(([parameters]) => parameters.blockNumber === 100n)).toBe(true);
  });

  it("includes ERC-2309 ranges and still verifies every candidate owner", async () => {
    const { client } = makeClient({
      getLogs: async ({ args, event }) => {
        if (event?.name === "ConsecutiveTransfer" && args?.toAddress) {
          return [consecutiveLog(10n, 11n)];
        }
        return [];
      },
      ownersByToken: { 10: ownerTwo, 11: otherOwner }
    });

    const result = await discoverErc721AssetsByTransfer({
      contractAddress,
      fromBlock: 0n,
      ownerAddresses: [ownerOne, ownerTwo],
      publicClient: client,
      toBlock: 100n
    });

    expect(result.complete).toBe(true);
    expect(result.candidateCount).toBe(2);
    expect(result.assets.map((asset) => asset.tokenId)).toEqual([10n]);
  });

  it("deduplicates ERC-2309 IDs already found in Transfer logs before applying the token cap", async () => {
    const { client } = makeClient({
      getLogs: async ({ args, event }) => {
        if (event?.name === "Transfer" && args?.to) return [transferLog(1n)];
        if (event?.name === "ConsecutiveTransfer" && args?.toAddress) return [consecutiveLog(1n, 2n)];
        return [];
      },
      ownersByToken: { 1: ownerOne, 2: ownerOne }
    });

    const result = await discoverErc721AssetsByTransfer({
      contractAddress,
      fromBlock: 0n,
      maxTokens: 2,
      ownerAddresses: [ownerOne],
      publicClient: client,
      toBlock: 100n
    });

    expect(result.complete).toBe(true);
    expect(result.assets.map((asset) => asset.tokenId)).toEqual([1n, 2n]);
    expect(result.issues).toEqual([]);
  });

  it("automatically retries a provider range limit with smaller event ranges", async () => {
    const { client, mocks } = makeClient({
      getLogs: async ({ fromBlock, toBlock }) => {
        if ((toBlock || 0n) - (fromBlock || 0n) + 1n > 1_000n) {
          throw new Error("range too large");
        }
        return [];
      }
    });

    const result = await discoverErc721AssetsByTransfer({
      blockSpan: 4_000n,
      contractAddress,
      fromBlock: 0n,
      maxRpcRequests: 100,
      ownerAddresses: [ownerOne],
      publicClient: client,
      toBlock: 5_000n
    });

    expect(result.complete).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.assets).toEqual([]);
    expect(mocks.getLogs.mock.calls.length).toBeGreaterThan(20);
  });

  it("continues reducing event ranges below 1,000 blocks when a provider requires it", async () => {
    const { client, mocks } = makeClient({
      getLogs: async ({ fromBlock, toBlock }) => {
        if ((toBlock || 0n) - (fromBlock || 0n) + 1n > 500n) {
          throw new Error("range too large");
        }
        return [];
      }
    });

    const result = await discoverErc721AssetsByTransfer({
      blockSpan: 1_500n,
      contractAddress,
      fromBlock: 0n,
      maxRpcRequests: 100,
      ownerAddresses: [ownerOne],
      publicClient: client,
      toBlock: 1_500n
    });

    expect(result.complete).toBe(true);
    expect(result.issues).toEqual([]);
    expect(mocks.getLogs).toHaveBeenCalled();
  });

  it("stops after cancellation instead of treating it as a range error", async () => {
    const controller = new AbortController();
    const { client, mocks } = makeClient({
      getLogs: async () => {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      }
    });

    await expect(discoverErc721AssetsByTransfer({
      blockSpan: 4_000n,
      contractAddress,
      fromBlock: 0n,
      ownerAddresses: [ownerOne],
      publicClient: client,
      signal: controller.signal,
      toBlock: 5_000n
    })).rejects.toMatchObject({ name: "AbortError" });

    expect(mocks.getLogs).toHaveBeenCalledTimes(4);
    expect(mocks.readContract).not.toHaveBeenCalled();
  });

  it("rejects the zero address as a discovery source before querying logs", async () => {
    const { client, mocks } = makeClient({ getLogs: async () => [] });

    const result = await discoverErc721AssetsByTransfer({
      contractAddress,
      fromBlock: 0n,
      ownerAddresses: [zeroAddress],
      publicClient: client,
      toBlock: 100n
    });

    expect(result.issues).toEqual([expect.objectContaining({ code: "invalid-input" })]);
    expect(mocks.getLogs).not.toHaveBeenCalled();
  });

  it("returns a partial result instead of silently truncating candidate IDs", async () => {
    const { client } = makeClient({
      getLogs: async ({ args, event }) => (
        event?.name === "Transfer" && args?.to
          ? [transferLog(1n), transferLog(2n)]
          : []
      ),
      ownersByToken: { 1: ownerOne }
    });

    const result = await discoverErc721AssetsByTransfer({
      contractAddress,
      fromBlock: 0n,
      maxTokens: 1,
      ownerAddresses: [ownerOne],
      publicClient: client,
      toBlock: 100n
    });

    expect(result.complete).toBe(false);
    expect(result.assets.map((asset) => asset.tokenId)).toEqual([1n]);
    expect(result.issues).toEqual([expect.objectContaining({ code: "token-limit-exceeded" })]);
  });

  it("does not label a scan complete when a source snapshot balance has undiscovered IDs", async () => {
    const { client, mocks } = makeClient({
      balancesByOwner: { [ownerOne.toLowerCase()]: 2n },
      getLogs: async ({ args, event }) => (
        event?.name === "Transfer" && args?.to ? [transferLog(1n)] : []
      ),
      ownersByToken: { 1: ownerOne }
    });

    const result = await discoverErc721AssetsByTransfer({
      contractAddress,
      fromBlock: 0n,
      ownerAddresses: [ownerOne],
      publicClient: client,
      toBlock: 100n
    });

    expect(result.assets.map((asset) => asset.tokenId)).toEqual([1n]);
    expect(result.complete).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "balance-mismatch" })
    ]));
    expect(mocks.readContract.mock.calls.every(([parameters]) => parameters.blockNumber === 100n)).toBe(true);
  });

  it("reports a non-sensitive snapshot balance read failure and keeps candidates partial", async () => {
    const { client } = makeClient({
      balanceReadError: new Error("failed at https://rpc.example.test/private-key"),
      getLogs: async ({ args, event }) => (
        event?.name === "Transfer" && args?.to ? [transferLog(1n)] : []
      ),
      ownersByToken: { 1: ownerOne }
    });

    const result = await discoverErc721AssetsByTransfer({
      contractAddress,
      fromBlock: 0n,
      ownerAddresses: [ownerOne],
      publicClient: client,
      toBlock: 100n
    });

    expect(result.assets.map((asset) => asset.tokenId)).toEqual([1n]);
    expect(result.complete).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "balance-read-failed" })
    ]));
    expect(JSON.stringify(result, (_key, value) => typeof value === "bigint" ? value.toString() : value))
      .not.toContain("rpc.example.test");
  });
});

describe("findErc721DeploymentBlock", () => {
  it("uses historical code to locate the first deployed block", async () => {
    const client = {
      getBlockNumber: vi.fn(async () => 100n),
      getCode: vi.fn(async ({ blockNumber }: { blockNumber?: bigint }) => (
        (blockNumber || 0n) >= 42n ? "0x1234" : "0x"
      ))
    };

    await expect(findErc721DeploymentBlock({
      contractAddress,
      publicClient: client as never
    })).resolves.toBe(42n);
  });
});
