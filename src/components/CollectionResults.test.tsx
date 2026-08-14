import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CollectionDisplayResult } from "../lib/collection-results";
import {
  CollectionResults,
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

  it("labels the export scope and fallback source identities clearly", () => {
    const markup = renderToStaticMarkup(
      <CollectionResults exportFilename="collection.csv" results={results} />
    );

    expect(markup).toContain("导出全部 CSV");
    expect(markup).toContain("来源 1");
    expect(markup).toContain("运营钱包");
    expect(markup).toContain('aria-label="查看来源 3的交易"');
  });
});
