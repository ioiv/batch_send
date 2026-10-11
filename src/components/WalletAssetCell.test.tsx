// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildWalletAssetOverview, type WalletAssetHolding } from "../lib/wallet-asset-overview";
import { WalletAssetCell, WalletNativeAssetCell } from "./WalletAssetCell";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const token = (index = 0): WalletAssetHolding => ({ kind: "token", key: `account-${index}`, address: `MintAddress${index}1234567890123456`, symbol: `TOK${index}`, raw: 123_456_789n, decimals: 6 });

describe("WalletAssetCell", () => {
  it("distinguishes unscanned, complete empty and incomplete scans", () => {
    const { rerender } = render(<WalletAssetCell />);
    expect(screen.getByText("—")).toBeVisible();
    rerender(<WalletAssetCell overview={buildWalletAssetOverview({ complete: true, holdings: [] })} />);
    expect(screen.getByText("无资产")).toBeVisible();
    rerender(<WalletAssetCell overview={buildWalletAssetOverview({ complete: false, holdings: [] })} />);
    expect(screen.getByText("扫描不完整")).toBeVisible();
    expect(screen.queryByText("无资产")).not.toBeInTheDocument();
  });

  it("shows at most two symbols and a separate NFT count", () => {
    render(<WalletAssetCell overview={buildWalletAssetOverview({ complete: true, holdings: [
      token(), token(1), { ...token(2), kind: "nft", raw: 8n, decimals: 0 }
    ] })} />);
    expect(screen.getByText("TOK0")).toBeVisible();
    expect(screen.getByText("TOK1")).toBeVisible();
    expect(screen.getByText("NFT 8")).toBeVisible();
    expect(screen.queryByText("TOK2")).not.toBeInTheDocument();
    expect(screen.getAllByText("123.456789")).toHaveLength(2);
  });

  it("reduces twenty tokens to one count and puts exact copyable detail in the question mark", async () => {
    const user = userEvent.setup();
    const holdings = Array.from({ length: 20 }, (_, index) => token(index));
    holdings[0] = { ...holdings[0], raw: 1n, decimals: 18 };
    render(<WalletAssetCell accessibleName="来源一" overview={buildWalletAssetOverview({ complete: true, holdings })} />);
    expect(screen.getByText("共 20 种 Token")).toBeVisible();
    expect(screen.queryByText("TOK0")).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: /查看 来源一 完整资产明细/u });
    await user.click(trigger);
    const list = screen.getByRole("list", { name: "完整代币与 NFT 清单" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(20);
    expect(within(list).getByText("0.000000000000000001")).toBeVisible();
    expect(list).toHaveClass("wallet-asset-details__list");
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await user.click(within(list).getByRole("button", { name: `复制 TOK0 ${holdings[0].address} 合约或 Mint 地址` }));
    expect(writeText).toHaveBeenCalledWith(holdings[0].address);
    expect(within(list).getByText("已复制")).toBeVisible();
  });

  it("preserves symbols missing from metadata and unknown balances without inventing zero", () => {
    render(<WalletAssetCell overview={buildWalletAssetOverview({ complete: true, holdings: [{ ...token(), symbol: null, raw: null }] })} />);
    expect(screen.getByText("MintAd…3456")).toBeVisible();
    expect(screen.getByText("数量未知")).toBeVisible();
    expect(screen.getByText("扫描不完整")).toBeVisible();
  });

  it("keeps native currency outside the asset count and exposes exact dust", async () => {
    const user = userEvent.setup();
    const overview = buildWalletAssetOverview({ complete: true, holdings: [], native: { symbol: "ETH", raw: 1n, decimals: 18 } });
    render(<><WalletNativeAssetCell overview={overview} /><WalletAssetCell overview={overview} /></>);
    expect(screen.getByText("无资产")).toBeVisible();
    expect(screen.getByText("<0.000001")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /查看 钱包 原生币精确余额/u }));
    expect(screen.getByText("0.000000000000000001 ETH")).toBeVisible();
  });
});
