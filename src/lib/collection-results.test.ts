import { describe, expect, it } from "vitest";
import { createCollectionResultsCsv, getCollectionResultCounts, type CollectionDisplayResult } from "./collection-results";

const results: CollectionDisplayResult[] = [
  {
    address: "0x1111111111111111111111111111111111111111",
    amount: "12.5",
    asset: "USDC",
    label: "wallet, one",
    message: "已归集",
    status: "success"
  },
  {
    address: "0x2222222222222222222222222222222222222222",
    asset: "USDC",
    message: "余额为 0",
    status: "skipped"
  },
  {
    address: "0x3333333333333333333333333333333333333333",
    asset: "USDC",
    message: "RPC 请求失败\n请重试",
    status: "error"
  }
];

describe("collection result helpers", () => {
  it("counts terminal and active states", () => {
    expect(getCollectionResultCounts([
      ...results,
      { address: "0x4", asset: "USDC", message: "正在提交", status: "submitting" }
    ])).toEqual({ active: 1, error: 1, skipped: 1, success: 1, total: 4 });
  });

  it("creates a spreadsheet-safe csv without secret material", () => {
    const csv = createCollectionResultsCsv([
      ...results,
      {
        address: "0x4",
        asset: "+SUM(1,1)",
        label: "=HYPERLINK(\"https://example.test\")",
        message: " @IMPORTXML(\"https://example.test\")",
        status: "error"
      }
    ]);
    expect(csv).toContain('"wallet, one"');
    expect(csv).toContain('"RPC 请求失败\n请重试"');
    expect(csv).toContain('"\'=HYPERLINK(""https://example.test"")"');
    expect(csv).toContain('"\'+SUM(1,1)"');
    expect(csv).toContain('\' @IMPORTXML');
    expect(csv).not.toContain("privateKey");
  });
});
