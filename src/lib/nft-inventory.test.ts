import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import type { CollectionDisplayResult } from "./collection-results";
import {
  getSettledNftAssetKeys,
  reconcileNftContractInventory
} from "./nft-inventory";

const contractOne = "0x00000000000000000000000000000000000000a1";
const contractTwo = "0x00000000000000000000000000000000000000b2";

function result(
  assetKey: string,
  status: CollectionDisplayResult["status"]
): CollectionDisplayResult {
  return {
    address: contractTwo,
    asset: "NFT",
    assetKey,
    message: status,
    status
  };
}

describe("NFT inventory reconciliation", () => {
  it("replaces only the completely scanned contract and preserves other contracts", () => {
    const reconciled = reconcileNftContractInventory({
      assetInput: `${contractOne},1\n${contractOne},2\n${contractTwo},8`,
      contractAddress: contractOne,
      standard: "erc721",
      tokenIds: [2n, 3n]
    });

    expect(reconciled.removed).toBe(2);
    expect(reconciled.serialized).toBe(
      `${contractTwo},8\n${getAddress(contractOne)},2\n${getAddress(contractOne)},3`
    );
  });

  it("clears stale rows for a complete zero-balance result", () => {
    const reconciled = reconcileNftContractInventory({
      assetInput: `${contractOne},1\n${contractTwo},8`,
      contractAddress: contractOne,
      standard: "erc1155",
      tokenIds: []
    });

    expect(reconciled.removed).toBe(1);
    expect(reconciled.serialized).toBe(`${contractTwo},8`);
  });

  it("keeps malformed input atomic when replacement cannot be merged safely", () => {
    const assetInput = `${contractOne},1\nnot-an-address,2`;
    const reconciled = reconcileNftContractInventory({
      assetInput,
      contractAddress: contractOne,
      standard: "erc721",
      tokenIds: [3n]
    });

    expect(reconciled.issues.some((issue) => issue.severity === "error")).toBe(true);
    expect(reconciled.removed).toBe(0);
    expect(reconciled.serialized).toBe(assetInput);
  });
});

describe("settled NFT result aggregation", () => {
  const assetOne = `erc721:${contractOne.toLowerCase()}:1`;
  const assetTwo = `erc1155:${contractOne.toLowerCase()}:2`;

  it("removes success plus safe skips but retains mixed failures and uncertain work", () => {
    const settled = getSettledNftAssetKeys([
      result(assetOne, "success"),
      result(assetOne, "skipped"),
      result(assetTwo, "success"),
      result(assetTwo, "error"),
      result(`erc721:${contractOne.toLowerCase()}:3`, "confirming")
    ]);

    expect([...settled]).toEqual([assetOne]);
  });
});
