import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import type { EvmCollectionAccount, EvmCollectionPlanItem } from "./evm-collection";
import { selectErc721CollectionPlan } from "./erc721-collection-selection";

const contractAddress = "0x0000000000000000000000000000000000000001" as const;
const accounts = ["11", "22", "33"].map((byte, index) => {
  const account = privateKeyToAccount((`0x${byte.repeat(32)}`) as `0x${string}`);
  return {
    account,
    address: account.address,
    label: `钱包 ${index + 1}`,
    line: index + 1
  } satisfies EvmCollectionAccount;
});

function item(account: EvmCollectionAccount, tokenId: bigint): EvmCollectionPlanItem {
  return {
    account: account.account,
    address: account.address,
    amount: 1n,
    asset: {
      contractAddress,
      key: `erc721:${contractAddress.toLowerCase()}:${tokenId}`,
      standard: "erc721",
      tokenId
    },
    id: `${account.address}:${tokenId}`,
    label: account.label,
    message: "可归集",
    status: "ready"
  };
}

describe("ERC721 total selection", () => {
  it("selects round-robin across wallets and sorts Token IDs within each wallet", () => {
    const plan = [
      item(accounts[0], 9n),
      item(accounts[0], 1n),
      item(accounts[1], 8n),
      item(accounts[2], 7n),
      item(accounts[1], 2n)
    ];

    expect(selectErc721CollectionPlan(plan, accounts, 4).map((entry) => [
      entry.address,
      entry.asset.standard === "erc721" ? entry.asset.tokenId : null
    ])).toEqual([
      [accounts[0].address, 1n],
      [accounts[1].address, 2n],
      [accounts[2].address, 7n],
      [accounts[0].address, 9n]
    ]);
  });

  it("collects every available item when the requested total is larger", () => {
    const plan = [item(accounts[0], 1n), item(accounts[1], 2n)];
    expect(selectErc721CollectionPlan(plan, accounts, 99)).toHaveLength(2);
    expect(selectErc721CollectionPlan(plan, accounts, null)).toHaveLength(2);
  });

  it("excludes skipped, failed, and non-ERC721 items", () => {
    const ready = item(accounts[0], 1n);
    const skipped = { ...item(accounts[1], 2n), status: "skipped" as const };
    const failed = { ...item(accounts[2], 3n), status: "failed" as const };
    expect(selectErc721CollectionPlan([ready, skipped, failed], accounts, null)).toEqual([ready]);
  });
});
