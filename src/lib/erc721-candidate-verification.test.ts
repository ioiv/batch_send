import { describe, expect, it, vi } from "vitest";
import {
  verifyErc721IndexedCandidates,
  type Erc721CandidateVerificationClient
} from "./erc721-candidate-verification";

const contract = "0xD982d8F175BD50B976F4Ad90562c9e38200091f9";
const ownerA = "0x00000000000000000000000000000000000000A1";
const ownerB = "0x00000000000000000000000000000000000000b2";

function createClient(ownersByToken: Record<string, string>, balances: Record<string, bigint>) {
  return {
    getBlockNumber: vi.fn().mockResolvedValue(38_000_000n),
    readContract: vi.fn(async (request: { args?: readonly unknown[]; functionName: string }) => {
      if (request.functionName === "ownerOf") return ownersByToken[String(request.args?.[0])];
      if (request.functionName === "balanceOf") return balances[String(request.args?.[0]).toLowerCase()] ?? 0n;
      throw new Error("unexpected call");
    })
  } as unknown as Erc721CandidateVerificationClient;
}

describe("verifyErc721IndexedCandidates", () => {
  it("reconciles indexed candidates against ownerOf and balanceOf at one block", async () => {
    const result = await verifyErc721IndexedCandidates({
      candidates: [
        { ownerAddress: ownerA, tokenId: 1n },
        { ownerAddress: ownerA, tokenId: 2n },
        { ownerAddress: ownerB, tokenId: 3n }
      ],
      contractAddress: contract,
      ownerAddresses: [ownerA, ownerB],
      publicClient: createClient({ "1": ownerA, "2": ownerA, "3": ownerB }, {
        [ownerA.toLowerCase()]: 2n,
        [ownerB.toLowerCase()]: 1n
      })
    });

    expect(result.complete).toBe(true);
    expect(result.assets.map((asset) => asset.tokenId)).toEqual([1n, 2n, 3n]);
    expect(result.owners.map((owner) => owner.verified)).toEqual([2, 1]);
    expect(result.snapshotBlock).toBe(38_000_000n);
  });

  it("drops stale candidates without treating a reconciled result as incomplete", async () => {
    const outsider = "0x00000000000000000000000000000000000000C3";
    const result = await verifyErc721IndexedCandidates({
      candidates: [{ ownerAddress: ownerA, tokenId: 8n }],
      contractAddress: contract,
      ownerAddresses: [ownerA],
      publicClient: createClient({ "8": outsider }, { [ownerA.toLowerCase()]: 0n })
    });

    expect(result.complete).toBe(true);
    expect(result.assets).toEqual([]);
    expect(result.issues[0]?.code).toBe("stale-index");
  });

  it("marks the scan incomplete when the index misses an owned token", async () => {
    const result = await verifyErc721IndexedCandidates({
      candidates: [{ ownerAddress: ownerA, tokenId: 1n }],
      contractAddress: contract,
      ownerAddresses: [ownerA],
      publicClient: createClient({ "1": ownerA }, { [ownerA.toLowerCase()]: 2n })
    });

    expect(result.complete).toBe(false);
    expect(result.issues.some((issue) => issue.code === "balance-mismatch")).toBe(true);
  });

  it("rejects candidates that are not scoped to the requested owners", async () => {
    const result = await verifyErc721IndexedCandidates({
      candidates: [{ ownerAddress: ownerB, tokenId: 1n }],
      contractAddress: contract,
      ownerAddresses: [ownerA],
      publicClient: createClient({}, {})
    });

    expect(result.complete).toBe(false);
    expect(result.issues[0]?.code).toBe("invalid-input");
  });
});
