import type { EvmCollectionAccount, EvmCollectionPlanItem } from "./evm-collection";

/**
 * Selects at most `limit` transferable ERC721 items across the checked wallets.
 * Wallets are visited in import order and contribute one Token ID per round so
 * a fixed total can use as many source wallets concurrently as possible.
 */
export function selectErc721CollectionPlan(
  plan: readonly EvmCollectionPlanItem[],
  accounts: readonly EvmCollectionAccount[],
  limit: number | null
) {
  const readyItems = plan.filter((item) => (
    item.status === "ready"
    && item.asset.standard === "erc721"
    && Boolean(item.account)
    && Boolean(item.address)
  ));
  if (limit === null || limit >= readyItems.length) return readyItems;
  if (!Number.isSafeInteger(limit) || limit <= 0) return [];

  const accountOrder = new Map(
    accounts.map((account, index) => [account.address.toLowerCase(), index] as const)
  );
  const groups = new Map<string, EvmCollectionPlanItem[]>();
  readyItems.forEach((item) => {
    const key = item.address!.toLowerCase();
    const current = groups.get(key) || [];
    current.push(item);
    groups.set(key, current);
  });
  const orderedGroups = [...groups.entries()]
    .sort(([left], [right]) => (
      (accountOrder.get(left) ?? Number.MAX_SAFE_INTEGER)
      - (accountOrder.get(right) ?? Number.MAX_SAFE_INTEGER)
    ))
    .map(([, items]) => items.sort((left, right) => {
      if (left.asset.standard !== "erc721" || right.asset.standard !== "erc721") return 0;
      return left.asset.tokenId < right.asset.tokenId ? -1 : left.asset.tokenId > right.asset.tokenId ? 1 : 0;
    }));

  const selected: EvmCollectionPlanItem[] = [];
  for (let round = 0; selected.length < limit; round += 1) {
    let added = false;
    for (const items of orderedGroups) {
      const item = items[round];
      if (!item) continue;
      selected.push(item);
      added = true;
      if (selected.length === limit) break;
    }
    if (!added) break;
  }
  return selected;
}
