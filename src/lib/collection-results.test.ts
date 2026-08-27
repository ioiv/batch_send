import { describe, expect, it } from "vitest";
import {
  createCollectionResultsCsv,
  filterCollectionResults,
  getCollectionResultCounts,
  sanitizeRoundArchiveText,
  shortenTransactionHash,
  type CollectionDisplayResult
} from "./collection-results";

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
  it("shows transaction hash prefixes and suffixes", () => {
    expect(shortenTransactionHash(`0x${"ab".repeat(32)}`)).toBe("0xabababab…ababab");
    expect(shortenTransactionHash("0xabc")).toBe("0xabc");
  });

  it("counts terminal and active states", () => {
    expect(getCollectionResultCounts([
      ...results,
      { address: "0x4", asset: "USDC", message: "正在提交", status: "submitting" }
    ])).toEqual({ active: 1, error: 1, skipped: 1, success: 1, total: 4 });
  });

  it("creates a spreadsheet-safe csv without secret material", () => {
    const evmSecretSentinel = `0x${"ab".repeat(32)}`;
    const solSecretSentinel = "4vJ9JU1bJJE96FWSJKvHsmmF7o4G1vJYp9wwaWg2kXQn";
    const csv = createCollectionResultsCsv([
      ...results,
      {
        address: "0x4",
        asset: "+SUM(1,1)",
        label: "=HYPERLINK(\"https://example.test\")",
        message: " @IMPORTXML(\"https://example.test\")",
        status: "error"
      },
      {
        address: "0x5",
        asset: "USDC",
        message: "已完成",
        privateKey: evmSecretSentinel,
        secretKey: solSecretSentinel,
        status: "success"
      } as CollectionDisplayResult
    ]);
    expect(csv.split("\r\n")[0]).toBe("label,address,asset,amount,status,message,transaction_hash,explorer_url");
    expect(csv).toContain('"wallet, one"');
    expect(csv).toContain('"RPC 请求失败\n请重试"');
    expect(csv).toContain('"\'=HYPERLINK(""https://example.test"")"');
    expect(csv).toContain('"\'+SUM(1,1)"');
    expect(csv).toContain('\' @IMPORTXML');
    expect(csv).not.toContain("privateKey");
    expect(csv).not.toContain(evmSecretSentinel);
    expect(csv).not.toContain(solSecretSentinel);
  });

  it("filters by terminal state and searches across safe display fields", () => {
    expect(filterCollectionResults(results, { status: "error" })).toEqual([results[2]]);
    expect(filterCollectionResults(results, { query: "WALLET, ONE" })).toEqual([results[0]]);
    expect(filterCollectionResults(results, { query: "余额为 0", status: "skipped" })).toEqual([results[1]]);
    expect(filterCollectionResults(results, { query: "missing" })).toEqual([]);
  });

  it("groups non-terminal states under active", () => {
    const active = { address: "0x4", asset: "USDC", message: "正在确认", status: "confirming" as const };
    expect(filterCollectionResults([...results, active], { status: "active" })).toEqual([active]);
  });

  it("redacts RPC-style URLs before a round is archived", () => {
    expect(sanitizeRoundArchiveText("请求 https://rpc.example/key-123 失败，改用 wss://secret.example/ws"))
      .toBe("请求 [敏感 URL 已隐藏] 失败，改用 [敏感 URL 已隐藏]");
  });
});
