// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "../lib/clipboard";
import type { CollectionDisplayResult } from "../lib/collection-results";
import {
  CollectionResults,
  getCollectionResultSourceCount,
  getCollectionResultSetIdentity,
  getIndexedCollectionResults
} from "./CollectionResults";

const transactionHash = `0x${"ab".repeat(32)}`;
vi.mock("../lib/clipboard", () => ({ copyText: vi.fn(async () => true) }));

const results: CollectionDisplayResult[] = [
  {
    address: "0x1111111111111111111111111111111111111111",
    asset: "USDC",
    message: "归集完成",
    status: "success"
  },
  {
    address: "0x2222222222222222222222222222222222222222",
    asset: "USDC",
    label: "运营钱包",
    message: "余额为 0",
    status: "skipped"
  },
  {
    address: "0x3333333333333333333333333333333333333333",
    asset: "USDT",
    explorerUrl: `https://explorer.test/tx/${transactionHash}`,
    hash: transactionHash,
    message: "RPC 请求失败",
    status: "error"
  }
];

afterEach(cleanup);

describe("CollectionResults", () => {
  it("opens a full uncertain record, copies its hash and restores focus when closed", async () => {
    const user = userEvent.setup();
    const uncertain = { ...results[2], uncertain: true, message: "交易已提交，确认请求超时。请核对链上结果后再继续。" };
    render(<CollectionResults exportFilename="collection.csv" results={[uncertain]} />);
    const row = within(screen.getByRole("table", { name: "归集结果" }));
    expect(row.getByText("待核对")).toBeVisible();
    const trigger = screen.getByRole("button", { name: "查看来源 1的详情" });
    await user.click(trigger);
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText(uncertain.message)).toBeVisible();
    expect(dialog.getByText(uncertain.address)).toBeVisible();
    expect(dialog.getByText(transactionHash)).toBeVisible();
    await user.click(dialog.getByRole("button", { name: "复制交易哈希" }));
    expect(copyText).toHaveBeenCalledWith(transactionHash);
    expect(dialog.getByRole("button", { name: "复制交易哈希：已复制" })).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    await user.click(screen.getByRole("tab", { name: "失败" }));
    expect(screen.getByText("无匹配结果")).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "待核对" }));
    expect(screen.getByRole("table", { name: "归集结果" })).toHaveTextContent("待核对");
  });

  it("keeps original result indexes after filtering", () => {
    expect(getIndexedCollectionResults(results, "uncertain", "")).toEqual([
      { originalIndex: 2, result: results[2] }
    ]);
    expect(getIndexedCollectionResults(results, "all", "3333")).toEqual([
      { originalIndex: 2, result: results[2] }
    ]);
  });

  it("keeps the task identity stable across progress-only updates", () => {
    const progressUpdate = results.map((result) => ({
      ...result,
      amount: "1.5",
      message: "状态已更新",
      status: "confirming" as const
    }));
    const changedSources = results.map((result, index) => (
      index === 0 ? { ...result, address: "0x4444444444444444444444444444444444444444" } : result
    ));

    expect(getCollectionResultSetIdentity(progressUpdate)).toBe(getCollectionResultSetIdentity(results));
    expect(getCollectionResultSetIdentity(changedSources)).not.toBe(getCollectionResultSetIdentity(results));
    expect(getCollectionResultSetIdentity([])).not.toBe(getCollectionResultSetIdentity(results));
  });

  it("counts unique source wallets separately from transaction items", () => {
    const repeatedSource = [
      results[0],
      { ...results[0], asset: "ERC721 #8" },
      results[1]
    ];

    expect(getCollectionResultSourceCount(repeatedSource)).toBe(2);
  });

  it("labels the export scope and fallback source identities clearly", () => {
    render(<CollectionResults exportFilename="collection.csv" results={results} />);
    expect(screen.getByRole("region", { name: "执行结果" })).toHaveAttribute("data-slot", "card");
    expect(screen.getByRole("button", { name: "导出全部 CSV" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "导出待处理项" })).toBeEnabled();
    expect(screen.getByLabelText("归集执行统计")).toHaveTextContent("资产项");
    expect(screen.getByRole("table", { name: "归集结果" })).toHaveTextContent("来源 1");
    expect(screen.getByRole("table", { name: "归集结果" })).toHaveTextContent("运营钱包");
    const transactionLink = screen.getByRole("link", { name: "查看来源 3的交易" });
    expect(transactionLink).toHaveAttribute("href", results[2].explorerUrl);
    expect(transactionLink).toHaveTextContent("0xabababab…ababab");
  });

  it("supports an embedded wallet-list presentation", () => {
    render(
      <CollectionResults
        description="预检后显示余额"
        embedded
        emptyTitle="请导入来源钱包"
        exportFilename="collection.csv"
        results={[]}
        title="钱包清单"
      />
    );
    expect(screen.getByRole("heading", { name: "钱包清单", level: 3 })).toBeVisible();
    expect(screen.getByText("请导入来源钱包")).toBeVisible();
    expect(screen.getByText("预检后显示余额")).toHaveClass("sr-only");
    expect(screen.getByRole("button", { name: "导出全部 CSV" })).toBeDisabled();
  });

  it("shows the target in the result summary and copies structured asset identity in details", async () => {
    const user = userEvent.setup();
    const targetAddress = "0x4444444444444444444444444444444444444444";
    const contractAddress = "0x5555555555555555555555555555555555555555";
    render(<CollectionResults exportFilename="collection.csv" results={[{ ...results[0], targetAddress, contractAddress, tokenId: "7", tokenStandard: "erc1155", asset: "ERC1155 #7 · 0x5555…5555" }]} />);
    expect(screen.getByLabelText("归集目标摘要")).toHaveTextContent(targetAddress);
    await user.click(within(screen.getByLabelText("归集目标摘要")).getByRole("button", { name: "复制目标地址" }));
    expect(copyText).toHaveBeenCalledWith(targetAddress);
    await user.click(screen.getByRole("button", { name: "查看来源 1的详情" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText("ERC1155")).toBeVisible();
    expect(dialog.getByText("7")).toBeVisible();
    await user.click(dialog.getByRole("button", { name: "复制合约地址" }));
    expect(copyText).toHaveBeenCalledWith(contractAddress);
  });
});
