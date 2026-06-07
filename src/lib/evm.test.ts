import { describe, expect, it } from "vitest";
import { parseEvmDistribution } from "./evm";

const addressOne = "0x00000000000000000000000000000000000000aa";
const addressOneMixedCase = "0x00000000000000000000000000000000000000AA";
const addressTwo = "0x0000000000000000000000000000000000000002";

describe("parseEvmDistribution", () => {
  it("parses EVM rows and totals wei with 18 decimals", () => {
    const parsed = parseEvmDistribution(`${addressOne},1\n${addressTwo},0.000000000000000001`);

    expect(parsed.validRows).toHaveLength(2);
    expect(parsed.invalid).toBe(0);
    expect(parsed.duplicates).toBe(0);
    expect(parsed.totalWei).toBe(1_000_000_000_000_000_001n);
    expect(parsed.total).toBe("1.000000000000000001");
  });

  it("rejects invalid addresses, malformed rows, and bad amounts", () => {
    const parsed = parseEvmDistribution([
      `${addressOne},0`,
      `${addressTwo}`,
      "not-an-address,1",
      `${addressTwo},1.0000000000000000001`
    ].join("\n"));

    expect(parsed.validRows).toHaveLength(0);
    expect(parsed.invalid).toBe(4);
    expect(parsed.rows.map((row) => row.status)).toEqual(["invalid", "invalid", "invalid", "invalid"]);
    expect(parsed.rows.flatMap((row) => row.problems)).toEqual(expect.arrayContaining([
      "EVM 地址格式不正确",
      "格式需要刚好包含一个逗号",
      "金额需要大于 0"
    ]));
  });

  it("marks duplicate EVM addresses case-insensitively", () => {
    const parsed = parseEvmDistribution(`${addressOne},1\n${addressOneMixedCase},2\n${addressTwo},3`);

    expect(parsed.duplicates).toBe(1);
    expect(parsed.invalid).toBe(1);
    expect(parsed.validRows.map((row) => row.address)).toEqual([addressOne, addressTwo]);
    expect(parsed.totalWei).toBe(4_000_000_000_000_000_000n);
  });
});
