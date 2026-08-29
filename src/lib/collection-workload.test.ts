import { describe, expect, it } from "vitest";
import {
  maximumCollectionSources,
  maximumEvmCollectionAssets,
  maximumEvmCollectionChecks,
  validateEvmCollectionWorkload,
  validateSolCollectionWorkload,
  validateSolTokenCollectionWorkload
} from "./collection-workload";

describe("collection workload limits", () => {
  it("allows ordinary collection batches", () => {
    expect(validateEvmCollectionWorkload({ accountCount: 100, assetCount: 5, standard: "erc20" })).toEqual([]);
    expect(validateEvmCollectionWorkload({ accountCount: 1_000, assetCount: 1_000, standard: "erc721" })).toEqual([]);
    expect(validateSolCollectionWorkload(1_000)).toEqual([]);
    expect(validateSolTokenCollectionWorkload(100, 50)).toEqual([]);
  });

  it("blocks source, asset, and multiplied read amplification independently", () => {
    expect(validateEvmCollectionWorkload({
      accountCount: maximumCollectionSources + 1,
      assetCount: maximumEvmCollectionAssets + 1,
      standard: "erc1155"
    })).toHaveLength(3);
    expect(validateEvmCollectionWorkload({
      accountCount: 100,
      assetCount: maximumEvmCollectionChecks / 100 + 1,
      standard: "erc20"
    }).at(-1)).toContain("余额检查");
  });

  it("caps SOL sources before any RPC execution", () => {
    expect(validateSolCollectionWorkload(maximumCollectionSources + 1)[0]).toContain("拆分任务");
  });

  it("caps SPL Mint count and wallet × Mint amplification", () => {
    expect(validateSolTokenCollectionWorkload(1, maximumEvmCollectionAssets + 1)[0]).toContain("Token Mint");
    expect(validateSolTokenCollectionWorkload(100, maximumEvmCollectionChecks / 100 + 1).at(-1))
      .toContain("钱包与 Token 检查");
  });
});
