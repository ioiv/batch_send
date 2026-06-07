import { afterEach, describe, expect, it, vi } from "vitest";
import {
  distributionTransferQueryParam,
  distributionTransferSource,
  distributionTransferStorageKey,
  evmDistributionPage,
  getDistributionTargetPage,
  getDistributionTransferHref,
  parseDistribution,
  solanaDistributionPage
} from "./distribution";

const systemProgram = "11111111111111111111111111111111";
const bpfLoader = "BPFLoader1111111111111111111111111111111111";
const evmAddress = "0x00000000000000000000000000000000000000aa";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseDistribution", () => {
  it("parses valid rows and totals lamports", () => {
    const parsed = parseDistribution(`${systemProgram},1\n${bpfLoader},0.5`);

    expect(parsed.validRows).toHaveLength(2);
    expect(parsed.invalid).toBe(0);
    expect(parsed.duplicates).toBe(0);
    expect(parsed.totalLamports).toBe(1_500_000_000n);
    expect(parsed.total).toBe("1.5");
    expect(parsed.cleanRows).toEqual([
      `${systemProgram},1`,
      `${bpfLoader},0.5`
    ]);
  });

  it("rejects invalid amounts, invalid addresses, and malformed lines", () => {
    const parsed = parseDistribution([
      `${systemProgram},0`,
      `${bpfLoader},1.0000000001`,
      "not-an-address,1",
      `${systemProgram}`,
      `${systemProgram},1,extra`
    ].join("\n"));

    expect(parsed.validRows).toHaveLength(0);
    expect(parsed.invalid).toBe(5);
    expect(parsed.rows.map((row) => row.status)).toEqual(["invalid", "invalid", "invalid", "invalid", "invalid"]);
    expect(parsed.rows.flatMap((row) => row.problems)).toEqual(expect.arrayContaining([
      "金额需要大于 0，最多 9 位小数",
      "地址格式不正确",
      "格式需要刚好包含一个逗号"
    ]));
  });

  it("marks duplicate addresses as invalid and excludes them from sendable rows", () => {
    const parsed = parseDistribution(`${systemProgram},1\n${systemProgram},2\n${bpfLoader},3`);

    expect(parsed.duplicates).toBe(1);
    expect(parsed.invalid).toBe(1);
    expect(parsed.validRows.map((row) => row.address)).toEqual([systemProgram, bpfLoader]);
    expect(parsed.rows[1].status).toBe("invalid");
    expect(parsed.rows[1].problems).toContain("重复地址不可发送");
    expect(parsed.totalLamports).toBe(4_000_000_000n);
  });

  it("ignores blank lines and numbers rows after filtering", () => {
    const parsed = parseDistribution(`\n${systemProgram},1\n\n${bpfLoader},2\n`);

    expect(parsed.rows.map((row) => row.line)).toEqual([1, 2]);
    expect(parsed.validRows).toHaveLength(2);
  });
});

describe("getDistributionTransferHref", () => {
  it("stores the generated list in sessionStorage instead of the URL", () => {
    const output = `${systemProgram},1\n${bpfLoader},0.5`;
    const setItem = vi.fn();
    vi.stubGlobal("window", {
      sessionStorage: {
        setItem
      }
    });

    const href = getDistributionTransferHref(output, solanaDistributionPage);
    const params = new URLSearchParams({ [distributionTransferQueryParam]: distributionTransferSource });

    expect(href).toBe(`${solanaDistributionPage}?${params.toString()}`);
    expect(href).not.toContain(output);
    expect(href).not.toContain("list=");
    expect(setItem).toHaveBeenCalledWith(distributionTransferStorageKey, output);
  });

  it("does not fall back to exposing the list when sessionStorage is unavailable", () => {
    const output = `${evmAddress},1`;
    vi.stubGlobal("window", {
      sessionStorage: {
        setItem: () => {
          throw new Error("Storage disabled");
        }
      }
    });

    const href = getDistributionTransferHref(output, evmDistributionPage);

    expect(href).toBe(evmDistributionPage);
    expect(href).not.toContain(output);
    expect(href).not.toContain("list=");
  });
});

describe("getDistributionTargetPage", () => {
  it("routes Solana rows to the Solana distributor", () => {
    expect(getDistributionTargetPage(`${systemProgram},1\n${bpfLoader},0.5`)).toBe(solanaDistributionPage);
  });

  it("routes EVM rows to the EVM distributor", () => {
    expect(getDistributionTargetPage(`${evmAddress},1`)).toBe(evmDistributionPage);
  });

  it("does not pick a distributor for mixed or empty lists", () => {
    expect(getDistributionTargetPage(`${systemProgram},1\n${evmAddress},1`)).toBeNull();
    expect(getDistributionTargetPage("")).toBeNull();
  });
});
