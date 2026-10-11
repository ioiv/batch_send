import { describe, expect, it } from "vitest";
import {
  buildWalletAssetOverview,
  formatWalletAssetAmount,
  getWalletAssetSymbol,
  getWalletNftCount,
  isWalletOverviewZeroBalance,
  type WalletAssetHolding
} from "./wallet-asset-overview";

const token = (overrides: Partial<WalletAssetHolding> = {}): WalletAssetHolding => ({
  kind: "token", key: "account-one", address: "MintCaseSensitive123456789", symbol: "USDC", raw: 1_234_567n, decimals: 6, ...overrides
});

describe("wallet asset overviews", () => {
  it("merges token accounts using bigint and keeps the exact decimal amount", () => {
    const overview = buildWalletAssetOverview({ complete: true, holdings: [
      token({ raw: 9_007_199_254_740_993n }),
      token({ key: "account-two", raw: 2n })
    ] });
    expect(overview.tokens).toHaveLength(1);
    expect(overview.tokens[0].raw).toBe(9_007_199_254_740_995n);
    expect(formatWalletAssetAmount(overview.tokens[0].raw, 6)).toBe("9007199254.740995");
  });

  it("uses addresses rather than symbols for distinct token identities", () => {
    const overview = buildWalletAssetOverview({ complete: true, holdings: [
      token(), token({ key: "two", address: "DifferentMint", symbol: "USDC" })
    ] });
    expect(overview.tokens).toHaveLength(2);
  });

  it("normalizes EVM address casing without changing Solana Mint casing", () => {
    const address = `0x${"aB".repeat(20)}`;
    const evm = buildWalletAssetOverview({ complete: true, holdings: [token({ address }), token({ address: address.toLowerCase(), key: "two" })] });
    expect(evm.tokens).toHaveLength(1);
    const sol = buildWalletAssetOverview({ complete: true, holdings: [token({ address: "MintAB" }), token({ address: "MintAb" })] });
    expect(sol.tokens).toHaveLength(2);
  });

  it("keeps NFT identities separate and counts their quantities independently", () => {
    const overview = buildWalletAssetOverview({ complete: true, holdings: [
      token(), token({ kind: "nft", key: "#1", raw: 1n, decimals: 0 }),
      token({ kind: "nft", key: "#2", raw: 7n, decimals: 0 })
    ] });
    expect(overview.tokens).toHaveLength(1);
    expect(overview.nfts).toHaveLength(2);
    expect(getWalletNftCount(overview)).toBe(8n);
  });

  it("does not interpret unknown or inconsistent balances as zero", () => {
    const unknown = buildWalletAssetOverview({ complete: true, holdings: [token({ raw: null })], native: { symbol: "ETH", raw: 0n, decimals: 18 } });
    expect(unknown.complete).toBe(false);
    expect(unknown.tokens[0].raw).toBeNull();
    expect(isWalletOverviewZeroBalance(unknown)).toBe(false);
    const incompatible = buildWalletAssetOverview({ complete: true, holdings: [token(), token({ decimals: 18 })] });
    expect(incompatible.complete).toBe(false);
    expect(incompatible.tokens[0].raw).toBeNull();
  });

  it("requires a complete scan and an exact zero native balance for zero selection", () => {
    const empty = { holdings: [], complete: true, native: { symbol: "ETH", raw: 0n, decimals: 18 } };
    expect(isWalletOverviewZeroBalance(buildWalletAssetOverview(empty))).toBe(true);
    expect(isWalletOverviewZeroBalance(buildWalletAssetOverview({ ...empty, native: { ...empty.native, raw: 1n } }))).toBe(false);
    expect(isWalletOverviewZeroBalance(buildWalletAssetOverview({ ...empty, complete: false }))).toBe(false);
    expect(isWalletOverviewZeroBalance(buildWalletAssetOverview({ ...empty, scanned: false }))).toBe(false);
    expect(isWalletOverviewZeroBalance(buildWalletAssetOverview({ ...empty, native: null }))).toBe(false);
    expect(isWalletOverviewZeroBalance(buildWalletAssetOverview({ ...empty, holdings: [token()] }))).toBe(false);
  });

  it("removes confirmed empty assets but preserves unknown quantities", () => {
    const overview = buildWalletAssetOverview({ complete: true, holdings: [token({ raw: 0n }), token({ address: "Unknown", raw: null })] });
    expect(overview.tokens.map((holding) => holding.address)).toEqual(["Unknown"]);
  });

  it("shows tiny positive balances without rounding them to zero", () => {
    expect(formatWalletAssetAmount(1n, 18, { compact: true })).toBe("<0.000001");
    expect(formatWalletAssetAmount(1n, 18)).toBe("0.000000000000000001");
    expect(formatWalletAssetAmount(1_234_567_890n, 9, { compact: true })).toBe("1.234567");
    expect(formatWalletAssetAmount(0n, 18, { compact: true })).toBe("0");
  });

  it("bounds large compact amounts without losing exact detail precision", () => {
    const raw = 123_456_789_123_456_789_000_000_000n;
    expect(formatWalletAssetAmount(raw, 6, { compact: true })).toBe("1.23456e20");
    expect(formatWalletAssetAmount(raw, 6)).toBe("123456789123456789000");
    expect(formatWalletAssetAmount(raw, 256)).toBe("数量未知");
  });

  it("falls back to a shortened address when a symbol is missing", () => {
    expect(getWalletAssetSymbol(token({ symbol: null }))).toBe("MintCa…6789");
    expect(getWalletAssetSymbol(token({ symbol: "  " }))).toBe("MintCa…6789");
  });
});
