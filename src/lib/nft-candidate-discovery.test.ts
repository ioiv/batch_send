import { describe, expect, it, vi } from "vitest";
import { discoverNftAssetsFromCandidates } from "./nft-candidate-discovery";

const contract = "0x0000000000000000000000000000000000000001" as const;
const owner = "0x0000000000000000000000000000000000000002" as const;

function response(body: unknown, status = 200) {
  return {
    json: vi.fn().mockResolvedValue(body),
    ok: status >= 200 && status < 300,
    status
  };
}

function createErc721Client({
  balance = 1n,
  ownerByToken = new Map([[42n, owner]]),
  transferTokenIds = [] as bigint[]
} = {}) {
  const getLogs = vi.fn(async ({ event }: { event: { name: string } }) => {
    if (event.name === "Transfer") {
      return transferTokenIds.map((tokenId) => ({ args: { to: owner, tokenId } }));
    }
    return [];
  });
  const multicall = vi.fn(async ({ contracts }: { contracts: Array<{ args: readonly unknown[]; functionName: string }> }) => (
    contracts.map((call) => {
      if (call.functionName === "balanceOf") return { result: balance, status: "success" };
      const tokenId = call.args[0] as bigint;
      const tokenOwner = ownerByToken.get(tokenId);
      return tokenOwner
        ? { result: tokenOwner, status: "success" }
        : { error: new Error("not minted"), status: "failure" };
    })
  ));
  return {
    getLogs: getLogs as never,
    multicall: multicall as never,
    readContract: vi.fn() as never
  };
}

describe("discoverNftAssetsFromCandidates", () => {
  it("uses OpenSea candidates and skips event history after ERC721 balances reconcile", async () => {
    const client = createErc721Client();
    const fetcher = vi.fn().mockResolvedValue(response({
      next: null,
      nfts: [{ contract, identifier: "42", token_standard: "erc721" }]
    }));

    const result = await discoverNftAssetsFromCandidates({
      chainId: 1,
      contractAddress: contract,
      fetcher,
      openSeaApiKey: "temporary-key",
      ownerAddresses: [owner],
      publicClient: client,
      snapshotBlock: 100n,
      standard: "erc721"
    });

    expect(result.complete).toBe(true);
    expect(result.assets.map((asset) => asset.tokenId)).toEqual([42n]);
    expect(result.assets[0]).toEqual(expect.objectContaining({ ownerAddress: owner }));
    expect(result.sources).toEqual(["opensea"]);
    expect(client.getLogs).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining(`/account/${owner}/nfts?limit=200`),
      expect.objectContaining({ headers: expect.objectContaining({ "x-api-key": "temporary-key" }) })
    );
  });

  it("supplements a stale OpenSea result from ERC721 Transfer events and verifies ownerOf", async () => {
    const client = createErc721Client({
      balance: 1n,
      ownerByToken: new Map([[7n, owner]]),
      transferTokenIds: [7n]
    });
    const fetcher = vi.fn().mockResolvedValue(response({ next: null, nfts: [] }));

    const result = await discoverNftAssetsFromCandidates({
      chainId: 8453,
      contractAddress: contract,
      fetcher,
      openSeaApiKey: "temporary-key",
      ownerAddresses: [owner],
      publicClient: client,
      snapshotBlock: 100n,
      standard: "erc721"
    });

    expect(result.complete).toBe(true);
    expect(result.assets.map((asset) => asset.tokenId)).toEqual([7n]);
    expect(result.sources).toEqual(["opensea", "transfer-events"]);
    expect(client.getLogs).toHaveBeenCalledTimes(2);
  });

  it("expands EIP-2309 ConsecutiveTransfer ranges before ownerOf verification", async () => {
    const client = createErc721Client({
      balance: 1n,
      ownerByToken: new Map([[6n, owner]])
    });
    client.getLogs = vi.fn(async ({ event }: { event: { name: string } }) => (
      event.name === "ConsecutiveTransfer"
        ? [{ args: { fromTokenId: 5n, toAddress: owner, toTokenId: 7n } }]
        : []
    )) as never;

    const result = await discoverNftAssetsFromCandidates({
      chainId: 1,
      contractAddress: contract,
      ownerAddresses: [owner],
      publicClient: client,
      snapshotBlock: 100n,
      standard: "erc721"
    });

    expect(result.complete).toBe(true);
    expect(result.candidateCount).toBe(3);
    expect(result.assets.map((asset) => asset.tokenId)).toEqual([6n]);
  });

  it("adaptively splits block ranges when an RPC rejects a large getLogs request", async () => {
    const client = createErc721Client({
      balance: 1n,
      ownerByToken: new Map([[42n, owner]])
    });
    const getLogs = vi.fn(async ({ event, fromBlock, toBlock }: {
      event: { name: string };
      fromBlock: bigint;
      toBlock: bigint;
    }) => {
      if (toBlock - fromBlock + 1n > 3_000n) throw new Error("block range too large");
      if (event.name === "Transfer" && fromBlock <= 8_222n && toBlock >= 8_222n) {
        return [{ args: { to: owner, tokenId: 42n } }];
      }
      return [];
    });
    client.getLogs = getLogs as never;

    const result = await discoverNftAssetsFromCandidates({
      chainId: 1,
      contractAddress: contract,
      ownerAddresses: [owner],
      publicClient: client,
      snapshotBlock: 10_000n,
      standard: "erc721"
    });

    expect(result.complete).toBe(true);
    expect(result.assets.map((asset) => asset.tokenId)).toEqual([42n]);
    expect(getLogs.mock.calls.length).toBeGreaterThan(4);
  });

  it("decodes ERC1155 TransferBatch candidates and keeps only positive snapshot balances", async () => {
    const getLogs = vi.fn(async ({ event }: { event: { name: string } }) => {
      if (event.name === "TransferBatch") {
        return [{ args: { ids: [9n, 10n], to: owner, values: [1n, 2n] } }];
      }
      return [];
    });
    const readContract = vi.fn().mockResolvedValue([0n, 2n]);

    const result = await discoverNftAssetsFromCandidates({
      chainId: 1,
      contractAddress: contract,
      ownerAddresses: [owner],
      publicClient: {
        getLogs: getLogs as never,
        multicall: vi.fn() as never,
        readContract: readContract as never
      },
      snapshotBlock: 100n,
      standard: "erc1155"
    });

    expect(result.complete).toBe(true);
    expect(result.assets.map((asset) => asset.tokenId)).toEqual([10n]);
    expect(result.holdings).toEqual([{
      balance: 2n,
      contractAddress: contract,
      ownerAddress: owner,
      tokenId: 10n
    }]);
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({
      blockNumber: 100n,
      functionName: "balanceOfBatch"
    }));
  });

  it("returns verified OpenSea ERC1155 IDs as partial when RPC event history is unavailable", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({
      next: null,
      nfts: [{ contract, identifier: "9", token_standard: "erc1155" }]
    }));
    const getLogs = vi.fn().mockRejectedValue(new Error("block range unavailable"));

    const result = await discoverNftAssetsFromCandidates({
      chainId: 1,
      contractAddress: contract,
      fetcher,
      openSeaApiKey: "temporary-key",
      ownerAddresses: [owner],
      publicClient: {
        getLogs: getLogs as never,
        multicall: vi.fn() as never,
        readContract: vi.fn().mockResolvedValue([3n]) as never
      },
      snapshotBlock: 100n,
      standard: "erc1155"
    });

    expect(result.complete).toBe(false);
    expect(result.assets.map((asset) => asset.tokenId)).toEqual([9n]);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "log-scan-failed" })
    ]));
  });
});
