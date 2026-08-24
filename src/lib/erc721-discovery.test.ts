import { describe, expect, it, vi } from "vitest";
import { zeroAddress, type PublicClient } from "viem";
import {
  discoverEnumerableErc721Assets,
  MAX_ERC721_DISCOVERY_OWNERS,
  MAX_ERC721_DISCOVERY_RPC_REQUESTS,
  type Erc721DiscoveryReadContract
} from "./erc721-discovery";
import { maximumCollectionSources, maximumEvmCollectionChecks } from "./collection-workload";

const contractAddress = "0x00000000000000000000000000000000000000b2";
const ownerOne = "0x0000000000000000000000000000000000000011";
const ownerTwo = "0x0000000000000000000000000000000000000022";
const secret = `0x${"a".repeat(64)}`;

type ReadParameters = {
  args?: readonly unknown[];
  functionName: string;
};

function makeParameters(readContract: (parameters: ReadParameters) => Promise<unknown>) {
  const injectedRead = vi.fn(readContract) as unknown as Erc721DiscoveryReadContract;
  const publicBlock = vi.fn(async () => 12_345n);
  const publicRead = vi.fn(async () => {
    throw new Error("injected readContract should be used");
  });
  return {
    injectedRead,
    parameters: {
      contractAddress,
      ownerAddresses: [ownerOne, ownerTwo],
      publicClient: {
        getBlockNumber: publicBlock,
        readContract: publicRead
      } as unknown as Pick<PublicClient, "getBlockNumber" | "readContract">,
      readContract: injectedRead
    },
    publicBlock,
    publicRead
  };
}

function supportsInterfaceResponse(args?: readonly unknown[]) {
  return args?.[0] !== "0xffffffff";
}

function enumerableRead(tokenIdsByOwner: Record<string, readonly bigint[]>) {
  return async ({ args, functionName }: ReadParameters) => {
    if (functionName === "supportsInterface") return supportsInterfaceResponse(args);
    const owner = String(args?.[0]).toLowerCase();
    const ids = tokenIdsByOwner[owner] || [];
    if (functionName === "balanceOf") return BigInt(ids.length);
    if (functionName === "tokenOfOwnerByIndex") return ids[Number(args?.[1])];
    throw new Error("unexpected call");
  };
}

describe("discoverEnumerableErc721Assets", () => {
  it("keeps hard discovery limits aligned with collection workload limits", () => {
    expect(MAX_ERC721_DISCOVERY_OWNERS).toBe(maximumCollectionSources);
    expect(MAX_ERC721_DISCOVERY_RPC_REQUESTS).toBe(maximumEvmCollectionChecks);
  });

  it("discovers bounded ERC721Enumerable token ids as serializable collection assets", async () => {
    const { injectedRead, parameters, publicRead } = makeParameters(enumerableRead({
      [ownerOne.toLowerCase()]: [0n, 9_007_199_254_740_993n],
      [ownerTwo.toLowerCase()]: [42n]
    }));
    const progress = vi.fn(() => {
      throw new Error("UI callback failure");
    });

    const result = await discoverEnumerableErc721Assets({ ...parameters, onProgress: progress });

    expect(result.assets).toEqual([
      {
        contractAddress,
        key: `erc721:${contractAddress}:0`,
        ownerAddress: ownerOne,
        standard: "erc721",
        tokenId: 0n
      },
      {
        contractAddress,
        key: `erc721:${contractAddress}:9007199254740993`,
        ownerAddress: ownerOne,
        standard: "erc721",
        tokenId: 9_007_199_254_740_993n
      },
      {
        contractAddress,
        key: `erc721:${contractAddress}:42`,
        ownerAddress: ownerTwo,
        standard: "erc721",
        tokenId: 42n
      }
    ]);
    expect(result.owners).toEqual([
      { balance: 2n, discovered: 2, ownerAddress: ownerOne, scanned: 2, status: "complete" },
      { balance: 1n, discovered: 1, ownerAddress: ownerTwo, scanned: 1, status: "complete" }
    ]);
    expect(result.issues).toEqual([]);
    expect(progress).toHaveBeenCalled();
    expect(publicRead).not.toHaveBeenCalled();
    expect(injectedRead).toHaveBeenCalledTimes(9);
    expect(result.rpcRequests).toBe(10);
    expect(result.snapshotBlock).toBe(12_345n);
  });

  it("stops before balances when ERC165 says the ERC721 contract is not enumerable", async () => {
    const { injectedRead, parameters } = makeParameters(async ({ args, functionName }) => {
      if (functionName !== "supportsInterface") throw new Error("balance must not be read");
      return args?.[0] !== "0xffffffff" && args?.[0] !== "0x780e9d63";
    });

    const result = await discoverEnumerableErc721Assets(parameters);

    expect(result.assets).toEqual([]);
    expect(result.issues).toEqual([expect.objectContaining({ code: "not-enumerable" })]);
    expect(result.owners.map((owner) => owner.status)).toEqual(["unsupported", "unsupported"]);
    expect(injectedRead).toHaveBeenCalledTimes(4);
  });

  it("reports and redacts ERC165 RPC errors without claiming the contract is unsupported", async () => {
    const { parameters } = makeParameters(async () => {
      throw new Error(`RPC failed at https://provider.test/key secret ${secret}`);
    });

    const result = await discoverEnumerableErc721Assets(parameters);
    const serialized = JSON.stringify(result, (_key, value) => typeof value === "bigint" ? value.toString() : value);

    expect(result.issues).toEqual([expect.objectContaining({ code: "interface-check-failed" })]);
    expect(serialized).toContain("[RPC 地址已隐藏]");
    expect(serialized).toContain("[已隐藏敏感内容]");
    expect(serialized).not.toContain("provider.test");
    expect(serialized).not.toContain(secret);
    expect(result.rpcRequests).toBe(5);
  });

  it("does not partially scan an owner whose declared balance exceeds the owner limit", async () => {
    const { injectedRead, parameters } = makeParameters(async ({ args, functionName }) => {
      if (functionName === "supportsInterface") return supportsInterfaceResponse(args);
      if (functionName === "balanceOf") return 3n;
      throw new Error("token read must not run");
    });

    const result = await discoverEnumerableErc721Assets({
      ...parameters,
      maxTokensPerOwner: 2
    });

    expect(result.assets).toEqual([]);
    expect(result.issues).toHaveLength(2);
    expect(result.issues.every((issue) => issue.code === "balance-limit-exceeded")).toBe(true);
    expect(result.owners.every((owner) => owner.status === "limit-exceeded")).toBe(true);
    expect(injectedRead).toHaveBeenCalledTimes(6);
  });

  it("enforces a separate hard token-read limit for the whole contract", async () => {
    const { injectedRead, parameters } = makeParameters(enumerableRead({
      [ownerOne.toLowerCase()]: [1n, 2n],
      [ownerTwo.toLowerCase()]: [3n, 4n]
    }));

    const result = await discoverEnumerableErc721Assets({
      ...parameters,
      maxTokensPerContract: 3
    });

    expect(result.assets.map((asset) => asset.tokenId)).toEqual([1n, 2n]);
    expect(result.issues).toEqual([expect.objectContaining({
      code: "contract-limit-exceeded",
      ownerAddress: ownerTwo
    })]);
    expect(result.owners[1]).toMatchObject({ scanned: 0, status: "limit-exceeded" });
    expect(injectedRead).toHaveBeenCalledTimes(8);
  });

  it("keeps earlier assets, marks an owner incomplete, and redacts token read failures", async () => {
    const { parameters } = makeParameters(async ({ args, functionName }) => {
      if (functionName === "supportsInterface") return supportsInterfaceResponse(args);
      if (functionName === "balanceOf") return args?.[0] === ownerOne ? 3n : 0n;
      if (args?.[1] === 0n) return 8n;
      throw new Error(`failed ${secret} via https://provider.test/private`);
    });

    const result = await discoverEnumerableErc721Assets(parameters);
    const serialized = JSON.stringify(result, (_key, value) => typeof value === "bigint" ? value.toString() : value);

    expect(result.assets.map((asset) => asset.tokenId)).toEqual([8n]);
    expect(result.owners[0]).toMatchObject({ discovered: 1, scanned: 1, status: "failed" });
    expect(result.issues).toEqual([expect.objectContaining({ code: "token-read-failed", tokenIndex: 1n })]);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("provider.test");
    expect(result.rpcRequests).toBe(9);
  });

  it("deduplicates owner inputs and malicious duplicate token ids", async () => {
    const { parameters } = makeParameters(enumerableRead({
      [ownerOne.toLowerCase()]: [7n],
      [ownerTwo.toLowerCase()]: [7n]
    }));

    const result = await discoverEnumerableErc721Assets({
      ...parameters,
      ownerAddresses: [ownerOne, ownerOne.toUpperCase().replace("0X", "0x"), ownerTwo]
    });

    expect(result.owners).toHaveLength(2);
    expect(result.assets.map((asset) => asset.tokenId)).toEqual([7n]);
    expect(result.issues).toEqual([expect.objectContaining({ code: "duplicate-token" })]);
  });

  it("rejects an oversized raw owner list before normalization or RPC", async () => {
    const { injectedRead, parameters } = makeParameters(enumerableRead({}));

    const result = await discoverEnumerableErc721Assets({
      ...parameters,
      ownerAddresses: Array.from(
        { length: MAX_ERC721_DISCOVERY_OWNERS + 1 },
        () => ownerOne
      )
    });

    expect(result.assets).toEqual([]);
    expect(result.issues).toEqual([expect.objectContaining({ code: "owner-limit-exceeded" })]);
    expect(result.rpcRequests).toBe(0);
    expect(injectedRead).not.toHaveBeenCalled();
  });

  it("rejects the zero address as a source before making discovery requests", async () => {
    const { injectedRead, parameters, publicBlock } = makeParameters(enumerableRead({}));

    const result = await discoverEnumerableErc721Assets({
      ...parameters,
      ownerAddresses: [zeroAddress]
    });

    expect(result.issues).toEqual([expect.objectContaining({ code: "invalid-input" })]);
    expect(result.rpcRequests).toBe(0);
    expect(publicBlock).not.toHaveBeenCalled();
    expect(injectedRead).not.toHaveBeenCalled();
  });

  it("rejects a budget below the known minimum before making RPC calls", async () => {
    const { injectedRead, parameters } = makeParameters(enumerableRead({}));

    const result = await discoverEnumerableErc721Assets({
      ...parameters,
      maxRpcRequests: 4
    });

    expect(result.issues).toEqual([expect.objectContaining({ code: "rpc-budget-exceeded" })]);
    expect(result.rpcRequests).toBe(0);
    expect(injectedRead).not.toHaveBeenCalled();
  });

  it("does not start token reads that would exceed the total RPC budget", async () => {
    const { injectedRead, parameters } = makeParameters(async ({ args, functionName }) => {
      if (functionName === "supportsInterface") return supportsInterfaceResponse(args);
      if (functionName === "balanceOf") return 1n;
      throw new Error("token read must not run");
    });

    const result = await discoverEnumerableErc721Assets({
      ...parameters,
      maxRpcRequests: 6,
      ownerAddresses: [ownerOne]
    });

    expect(result.assets).toEqual([]);
    expect(result.issues).toEqual([expect.objectContaining({
      code: "rpc-budget-exceeded",
      ownerAddress: ownerOne
    })]);
    expect(result.owners).toEqual([
      { balance: 1n, discovered: 0, ownerAddress: ownerOne, scanned: 0, status: "limit-exceeded" }
    ]);
    expect(result.rpcRequests).toBe(6);
    expect(injectedRead).toHaveBeenCalledTimes(5);
  });

  it("returns input issues without making RPC calls", async () => {
    const { injectedRead, parameters } = makeParameters(enumerableRead({}));

    const invalidAddress = await discoverEnumerableErc721Assets({
      ...parameters,
      contractAddress: "not-an-address"
    });
    const invalidLimits = await discoverEnumerableErc721Assets({
      ...parameters,
      maxTokensPerContract: 5_001,
      maxTokensPerOwner: 2_001
    });
    const invalidRpcBudget = await discoverEnumerableErc721Assets({
      ...parameters,
      maxRpcRequests: MAX_ERC721_DISCOVERY_RPC_REQUESTS + 1
    });

    expect(invalidAddress.issues[0]).toMatchObject({ code: "invalid-input" });
    expect(invalidLimits.issues[0]).toMatchObject({ code: "invalid-input" });
    expect(invalidRpcBudget.issues[0]).toMatchObject({ code: "rpc-budget-exceeded" });
    expect(injectedRead).not.toHaveBeenCalled();
  });
});
