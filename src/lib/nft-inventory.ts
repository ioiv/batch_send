import { getAddress } from "viem";
import type { CollectionDisplayResult } from "./collection-results";
import {
  parseEvmCollectionAssets,
  type EvmCollectionStandard
} from "./evm-collection";
import { mergeNftAssetInput } from "./nft-asset-input";

export type NftInventoryStandard = Extract<EvmCollectionStandard, "erc721" | "erc1155">;

/**
 * Removes only parsed NFT assets. Invalid source rows are deliberately retained
 * so an inventory action can never silently discard input the parser could not
 * understand.
 */
export function removeValidNftInventoryAssets(
  assetInput: string,
  standard: NftInventoryStandard,
  assetKeys: Iterable<string>
) {
  const selectedKeys = new Set(assetKeys);
  if (!selectedKeys.size) return assetInput;

  const parsed = parseEvmCollectionAssets(assetInput, standard);
  const removableLines = new Set(
    parsed.rows
      .filter((row) => row.asset && selectedKeys.has(row.asset.key))
      .map((row) => row.line)
  );
  if (!removableLines.size) return assetInput;

  const lineBreak = assetInput.includes("\r\n") ? "\r\n" : "\n";
  return assetInput
    .split(/\r?\n/)
    .filter((_, index) => !removableLines.has(index + 1))
    .join(lineBreak);
}

/**
 * An NFT can produce more than one execution row (notably ERC1155 balances
 * held by several source wallets). It is settled only when at least one
 * transfer succeeded and every row is a success or a safe skip.
 */
export function getSettledNftAssetKeys(results: readonly CollectionDisplayResult[]) {
  const grouped = new Map<string, CollectionDisplayResult[]>();
  results.forEach((result) => {
    if (!result.assetKey) return;
    const current = grouped.get(result.assetKey) || [];
    current.push(result);
    grouped.set(result.assetKey, current);
  });

  return new Set([...grouped.entries()].flatMap(([assetKey, assetResults]) => {
    const hasSuccess = assetResults.some((result) => result.status === "success");
    const fullySettled = assetResults.every((result) => (
      result.status === "success" || result.status === "skipped"
    ));
    return hasSuccess && fullySettled ? [assetKey] : [];
  }));
}

/**
 * Reconciles a complete automatic discovery for one contract. Other contracts
 * stay untouched. Callers must not use this for partial scans because absence
 * from a partial range is not proof that an asset is no longer held.
 */
export function reconcileNftContractInventory({
  assetInput,
  contractAddress,
  standard,
  tokenIds
}: {
  assetInput: string;
  contractAddress: string;
  standard: NftInventoryStandard;
  tokenIds: readonly bigint[];
}) {
  const normalizedContract = getAddress(contractAddress);
  const parsed = parseEvmCollectionAssets(assetInput, standard);
  const replacedKeys = parsed.assets
    .filter((asset) => (
      (asset.standard === "erc721" || asset.standard === "erc1155")
      && asset.contractAddress.toLowerCase() === normalizedContract.toLowerCase()
    ))
    .map((asset) => asset.key);
  const baseInput = removeValidNftInventoryAssets(assetInput, standard, replacedKeys);

  if (!tokenIds.length) {
    return {
      added: 0,
      duplicates: 0,
      issues: [],
      removed: replacedKeys.length,
      serialized: baseInput,
      truncated: false
    };
  }

  const merged = mergeNftAssetInput(
    baseInput,
    normalizedContract,
    tokenIds.map(String).join(","),
    { standard }
  );
  if (merged.issues.some((issue) => issue.severity === "error")) {
    return { ...merged, removed: 0, serialized: assetInput };
  }
  return { ...merged, removed: replacedKeys.length };
}
