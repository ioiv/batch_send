import { describe, expect, it, vi } from "vitest";
import { discoverErc721AssetsByTokenRange } from "./erc721-token-range-discovery";

const contract = "0x0000000000000000000000000000000000000001" as const;
const owner = "0x0000000000000000000000000000000000000002" as const;

describe("discoverErc721AssetsByTokenRange", () => {
  it("infers a compact range from totalSupply and stops after balanceOf is reconciled", async () => {
    const readContract = vi.fn(async ({ args, functionName }: { args?: readonly unknown[]; functionName: string }) => {
      if (functionName === "balanceOf") return 2n;
      if (functionName === "totalSupply") return 4n;
      if (functionName === "ownerOf") {
        const tokenId = args?.[0];
        if (tokenId === 1n || tokenId === 4n) return owner;
        throw new Error("ERC721NonexistentToken");
      }
      throw new Error("method unavailable");
    });

    const result = await discoverErc721AssetsByTokenRange({
      contractAddress: contract,
      ownerAddresses: [owner],
      publicClient: {
        getBlockNumber: vi.fn().mockResolvedValue(100n),
        readContract: readContract as never
      }
    });

    expect(result.complete).toBe(true);
    expect(result.assets.map((asset) => asset.tokenId)).toEqual([1n, 4n]);
    expect(result.range).toEqual({ fromTokenId: 0n, source: "totalSupply", toTokenId: 4n });
    expect(readContract.mock.calls.some(([request]) => request.functionName === "getLogs")).toBe(false);
  });

  it("requests a manual range when the contract exposes no usable counter", async () => {
    const result = await discoverErc721AssetsByTokenRange({
      contractAddress: contract,
      ownerAddresses: [owner],
      publicClient: {
        getBlockNumber: vi.fn().mockResolvedValue(100n),
        readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
          if (functionName === "balanceOf") return 1n;
          throw new Error("method unavailable");
        }) as never
      }
    });

    expect(result.complete).toBe(false);
    expect(result.range).toBeNull();
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "range-required" })
    ]));
  });

  it("uses a user-provided Token ID range and never reads event logs", async () => {
    const readContract = vi.fn(async ({ args, functionName }: { args?: readonly unknown[]; functionName: string }) => {
      if (functionName === "balanceOf") return 1n;
      if (functionName === "ownerOf" && args?.[0] === 42n) return owner;
      throw new Error("ERC721NonexistentToken");
    });

    const result = await discoverErc721AssetsByTokenRange({
      contractAddress: contract,
      fromTokenId: 40n,
      ownerAddresses: [owner],
      publicClient: {
        getBlockNumber: vi.fn().mockResolvedValue(100n),
        readContract: readContract as never
      },
      toTokenId: 45n
    });

    expect(result.complete).toBe(true);
    expect(result.assets.map((asset) => asset.tokenId)).toEqual([42n]);
    expect(result.range?.source).toBe("manual");
    expect(readContract).not.toHaveBeenCalledWith(expect.objectContaining({ functionName: "getLogs" }));
  });
});
