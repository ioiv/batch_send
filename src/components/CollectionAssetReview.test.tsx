// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollectionAssetReview, type CollectionAssetReviewItem } from "./CollectionAssetReview";

const { copyText } = vi.hoisted(() => ({ copyText: vi.fn().mockResolvedValue(true) }));
vi.mock("@/lib/clipboard", () => ({ copyText }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const tokenAddress = `0x${"a".repeat(40)}`;
const sourceAddress = (index: number) => `0x${index.toString(16).padStart(40, "0")}`;
const asset: CollectionAssetReviewItem = {
  amount: "0.00002", contractAddress: tokenAddress, name: "Wrapped Ether", sourceAddress: sourceAddress(10),
  sourceLabel: "实际持有资产的钱包", standard: "erc20", status: "ready", symbol: "WETH"
};

describe("CollectionAssetReview", () => {
  it("puts the positive holding first and keeps nine skipped sources behind an expandable summary", async () => {
    const user = userEvent.setup();
    render(<CollectionAssetReview items={[
      ...Array.from({ length: 9 }, (_, index) => ({ ...asset, amount: "0", message: "代币余额为 0，已跳过", sourceAddress: sourceAddress(index + 1), sourceLabel: `零余额钱包 ${index + 1}`, status: "skipped" as const })),
      asset
    ]} />);
    const review = screen.getByRole("region", { name: "本次归集资产与来源数量" });
    expect(within(review).getByText("0.00002 WETH")).toBeVisible();
    expect(within(review).getByText("估计数量 0.00002")).toBeVisible();
    expect(within(review).getByText(sourceAddress(10))).toBeVisible();
    expect(within(review).getByText(sourceAddress(1))).not.toBeVisible();
    expect(review.firstElementChild).toHaveClass("collection-asset-review__contract");
    const summary = within(review).getByText("零余额 / 跳过 9 项 · 9 个来源");
    expect(summary.closest("details")).not.toHaveAttribute("open");
    await user.click(summary);
    expect(within(review).getByText(sourceAddress(1))).toBeVisible();
    expect(within(review).getAllByText("代币余额为 0，已跳过")).toHaveLength(9);
    await user.click(within(review.firstElementChild as HTMLElement).getByRole("button", { name: "复制来源地址" }));
    expect(copyText).toHaveBeenLastCalledWith(sourceAddress(10));
    await user.click(within(review.firstElementChild as HTMLElement).getByRole("button", { name: "复制合约地址" }));
    expect(copyText).toHaveBeenLastCalledWith(tokenAddress);
  });

  it("adds displayed decimal amounts exactly and never hides failed reads with skipped rows", () => {
    render(<CollectionAssetReview items={[
      { ...asset, amount: "0.000000000000000001" },
      { ...asset, amount: "9007199254740993.000000000000000002", sourceAddress: sourceAddress(11) },
      { ...asset, amount: "读取失败", message: "余额读取超时", sourceAddress: sourceAddress(12), status: "failed" },
      { ...asset, amount: "0", sourceAddress: sourceAddress(13), status: "skipped" }
    ]} />);
    expect(screen.getByText("9007199254740993.000000000000000003 WETH")).toBeVisible();
    expect(screen.getByText("余额读取超时")).toBeVisible();
    expect(screen.getByText(sourceAddress(12))).toBeVisible();
    expect(screen.getByText(sourceAddress(13))).not.toBeVisible();
  });
});
