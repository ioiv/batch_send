// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { CollectionDisplayResult } from "../lib/collection-results";
import {
  CollectionResults,
  getCollectionResultSourceCount,
  getCollectionResultSetIdentity,
  getIndexedCollectionResults
} from "./CollectionResults";

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
    explorerUrl: "https://explorer.test/tx/0xabc",
    hash: "0xabc",
    message: "RPC 请求失败",
    status: "error"
  }
];

afterEach(cleanup);

describe("CollectionResults", () => {
  it("keeps original result indexes after filtering", () => {
    expect(getIndexedCollectionResults(results, "error", "")).toEqual([
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
    expect(screen.getByRole("button", { name: "导出失败/跳过项" })).toBeEnabled();
    expect(screen.getByLabelText("归集执行统计")).toHaveTextContent("资产项");
    expect(screen.getByRole("table", { name: "归集结果" })).toHaveTextContent("来源 1");
    expect(screen.getByRole("table", { name: "归集结果" })).toHaveTextContent("运营钱包");
    expect(screen.getByRole("link", { name: "查看来源 3的交易" })).toHaveAttribute("href", results[2].explorerUrl);
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
});
