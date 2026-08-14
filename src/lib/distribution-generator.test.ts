import { describe, expect, it, vi } from "vitest";
import {
  dedupeDistributionAddresses,
  generateDistributionList,
  getDistributionAmountStep,
  importDistributionFileText,
  importDistributionInput
} from "./distribution-generator";

const solanaAddressOne = "11111111111111111111111111111111";
const solanaAddressTwo = "BPFLoader1111111111111111111111111111111111";
const evmAddressOne = "0x00000000000000000000000000000000000000aa";
const evmAddressOneMixedCase = "0x00000000000000000000000000000000000000AA";
const evmAddressTwo = "0x00000000000000000000000000000000000000bb";

describe("getDistributionAmountStep", () => {
  it("derives a base-unit step from the highest typed precision", () => {
    expect(getDistributionAmountStep("0.5", "1", 9)).toBe(100_000_000n);
    expect(getDistributionAmountStep("0.0100", "1", 6)).toBe(100n);
    expect(getDistributionAmountStep("1", 0)).toBe(1n);
  });

  it("caps the step precision at the asset decimals", () => {
    expect(getDistributionAmountStep("0.1234567", 6)).toBe(1n);
  });

  it("rejects unsupported decimals", () => {
    expect(() => getDistributionAmountStep("1", -1)).toThrow("decimals");
    expect(() => getDistributionAmountStep("1", 1.5)).toThrow("decimals");
  });
});

describe("generateDistributionList fixed amounts", () => {
  it("generates an ordered Solana list and totals exact bigint units", () => {
    const result = generateDistributionList({
      addresses: `${solanaAddressOne}\n\n${solanaAddressTwo}`,
      addressKind: "solana",
      decimals: 9,
      fixedAmount: "0.100000000",
      mode: "fixed"
    });

    expect(result).toEqual({
      duplicates: 0,
      invalid: 0,
      issues: [],
      output: `${solanaAddressOne},0.1\n${solanaAddressTwo},0.1`,
      total: "0.2",
      totalUnits: 200_000_000n,
      validCount: 2
    });
  });

  it("supports exact 6-decimal and 18-decimal EVM assets", () => {
    const sixDecimals = generateDistributionList({
      addresses: evmAddressOne,
      addressKind: "evm",
      decimals: 6,
      fixedAmount: "0.000001",
      mode: "fixed"
    });
    const eighteenDecimals = generateDistributionList({
      addresses: evmAddressOne,
      addressKind: "evm",
      decimals: 18,
      fixedAmount: "0.000000000000000001",
      mode: "fixed"
    });

    expect(sixDecimals.totalUnits).toBe(1n);
    expect(sixDecimals.total).toBe("0.000001");
    expect(eighteenDecimals.totalUnits).toBe(1n);
    expect(eighteenDecimals.total).toBe("0.000000000000000001");
  });

  it("counts wrong-chain and malformed addresses as invalid", () => {
    const result = generateDistributionList({
      addresses: `${solanaAddressOne}\n${evmAddressOne}\nnot-an-address`,
      addressKind: "solana",
      decimals: 9,
      fixedAmount: "1",
      mode: "fixed"
    });

    expect(result.validCount).toBe(1);
    expect(result.invalid).toBe(2);
    expect(result.issues).toEqual([
      "第 2 行地址格式不正确",
      "第 3 行地址格式不正确"
    ]);
  });

  it("counts every otherwise valid row when the fixed amount is invalid", () => {
    const result = generateDistributionList({
      addresses: `${evmAddressOne}\n${evmAddressTwo}`,
      addressKind: "evm",
      decimals: 6,
      fixedAmount: "0.0000001",
      mode: "fixed"
    });

    expect(result.output).toBe("");
    expect(result.validCount).toBe(0);
    expect(result.invalid).toBe(2);
    expect(result.issues).toEqual(["固定金额需要大于 0，最多 6 位小数"]);
    expect(result.totalUnits).toBe(0n);
    expect(result.total).toBe("0");
  });

  it("rejects amounts outside uint256 without parsing unbounded integers", () => {
    const result = generateDistributionList({
      addresses: evmAddressOne,
      addressKind: "evm",
      decimals: 18,
      fixedAmount: "9".repeat(100_000),
      mode: "fixed"
    });

    expect(result.validCount).toBe(0);
    expect(result.invalid).toBe(1);
  });

  it("tracks EVM duplicates case-insensitively and excludes them from the sendable total", () => {
    const result = generateDistributionList({
      addresses: `${evmAddressOne}\n${evmAddressOneMixedCase}\n${evmAddressTwo}`,
      addressKind: "evm",
      decimals: 18,
      fixedAmount: "1",
      mode: "fixed"
    });

    expect(result.duplicates).toBe(1);
    expect(result.invalid).toBe(0);
    expect(result.validCount).toBe(2);
    expect(result.total).toBe("2");
    expect(result.output.split("\n").map((row) => row.split(",")[0])).toEqual([
      evmAddressOne,
      evmAddressTwo
    ]);
  });

  it("uses the page validator when stricter address checks are required", () => {
    const badChecksumAddress = "0x00000000000000000000000000000000000000aA";
    const result = generateDistributionList({
      addresses: `${evmAddressOne}\n${badChecksumAddress}`,
      addressKind: "evm",
      decimals: 18,
      fixedAmount: "1",
      mode: "fixed",
      validateAddress: (address) => address !== badChecksumAddress
    });

    expect(result.invalid).toBe(1);
    expect(result.output).toBe(`${evmAddressOne},1`);
  });
});

describe("generateDistributionList random amounts", () => {
  it("uses inclusive minimum and maximum step bounds", () => {
    const chooseMinimum = vi.fn((min: bigint) => min);
    const chooseMaximum = vi.fn((_min: bigint, max: bigint) => max);
    const args = {
      addresses: solanaAddressOne,
      addressKind: "solana" as const,
      decimals: 9,
      maxAmount: "0.35",
      minAmount: "0.15",
      mode: "random" as const
    };

    const minimum = generateDistributionList({ ...args, randomBigInt: chooseMinimum });
    const maximum = generateDistributionList({ ...args, randomBigInt: chooseMaximum });

    expect(minimum.output).toBe(`${solanaAddressOne},0.15`);
    expect(maximum.output).toBe(`${solanaAddressOne},0.35`);
    expect(chooseMinimum).toHaveBeenCalledWith(15n, 35n, solanaAddressOne, 0);
    expect(chooseMaximum).toHaveBeenCalledWith(15n, 35n, solanaAddressOne, 0);
  });

  it("generates one amount per valid row at the typed precision", () => {
    const values = [123n, 200n];
    const randomBigInt = vi.fn(() => values.shift() || 100n);
    const result = generateDistributionList({
      addresses: `${evmAddressOne}\n${evmAddressTwo}`,
      addressKind: "evm",
      decimals: 6,
      maxAmount: "0.200",
      minAmount: "0.100",
      mode: "random",
      randomBigInt
    });

    expect(result.output).toBe(`${evmAddressOne},0.123\n${evmAddressTwo},0.2`);
    expect(result.totalUnits).toBe(323_000n);
    expect(result.total).toBe("0.323");
    expect(randomBigInt).toHaveBeenCalledTimes(2);
  });

  it("rejects reversed, non-positive, and over-precision ranges", () => {
    const baseArgs = {
      addresses: evmAddressOne,
      addressKind: "evm" as const,
      decimals: 6,
      mode: "random" as const
    };

    for (const [minAmount, maxAmount] of [["2", "1"], ["0", "1"], ["0.0000001", "1"]]) {
      const result = generateDistributionList({ ...baseArgs, maxAmount, minAmount });
      expect(result.invalid).toBe(1);
      expect(result.validCount).toBe(0);
      expect(result.issues[0]).toContain("随机区间");
    }
  });

  it("rejects an injected random value outside the inclusive bounds", () => {
    expect(() => generateDistributionList({
      addresses: solanaAddressOne,
      addressKind: "solana",
      decimals: 9,
      maxAmount: "0.2",
      minAmount: "0.1",
      mode: "random",
      randomBigInt: (_min, max) => max + 1n
    })).toThrow("outside");
  });
});

describe("dedupeDistributionAddresses", () => {
  it("removes EVM duplicates case-insensitively and preserves the first row", () => {
    expect(dedupeDistributionAddresses(
      `${evmAddressOne}\n${evmAddressTwo}\n${evmAddressOneMixedCase}\n${evmAddressTwo}`,
      "evm"
    )).toBe(`${evmAddressOne}\n${evmAddressTwo}`);
  });

  it("preserves Solana order and trims blank lines", () => {
    expect(dedupeDistributionAddresses(
      `\n ${solanaAddressTwo} \n${solanaAddressOne}\n${solanaAddressTwo}\n`,
      "solana"
    )).toBe(`${solanaAddressTwo}\n${solanaAddressOne}`);
  });
});

describe("importDistributionInput", () => {
  it("preserves a shared amount from a legacy list", () => {
    expect(importDistributionInput(`${evmAddressOne},0.25\r\n${evmAddressTwo},0.25`)).toEqual({
      addresses: `${evmAddressOne}\n${evmAddressTwo}`,
      fixedAmount: "0.25",
      hadAmounts: true,
      hasMixedAmounts: false
    });
  });

  it("does not silently replace mixed legacy amounts", () => {
    expect(importDistributionInput(`${evmAddressOne},0.1\n${evmAddressTwo},2`)).toEqual({
      addresses: `${evmAddressOne}\n${evmAddressTwo}`,
      fixedAmount: "",
      hadAmounts: true,
      hasMixedAmounts: true
    });
  });

  it("keeps pure-address input ready for the default amount", () => {
    expect(importDistributionInput(`${evmAddressOne}\n${evmAddressTwo}`)).toEqual({
      addresses: `${evmAddressOne}\n${evmAddressTwo}`,
      fixedAmount: "",
      hadAmounts: false,
      hasMixedAmounts: false
    });
  });
});

describe("importDistributionFileText", () => {
  it("accepts a csv header and preserves one shared amount", () => {
    expect(importDistributionFileText(`\uFEFFaddress,amount\n${evmAddressOne},0.5\n${evmAddressTwo},0.5`)).toEqual({
      addresses: `${evmAddressOne}\n${evmAddressTwo}`,
      fixedAmount: "0.5",
      hadAmounts: true,
      hasMixedAmounts: false,
      invalidRows: 0,
      sourceRows: 2,
      truncated: false
    });
  });

  it("accepts tab-delimited text and rejects oversized content", () => {
    expect(importDistributionFileText(`address\tamount\n${evmAddressOne}\t0.5`).fixedAmount).toBe("0.5");
    expect(() => importDistributionFileText("x".repeat(512 * 1024 + 1))).toThrow("512 KB");
  });

  it("reports mixed amounts and truncation without silently changing the first rows", () => {
    expect(importDistributionFileText(`${evmAddressOne},1\n${evmAddressTwo},2`, 1)).toEqual({
      addresses: evmAddressOne,
      fixedAmount: "1",
      hadAmounts: true,
      hasMixedAmounts: false,
      invalidRows: 0,
      sourceRows: 2,
      truncated: true
    });
    expect(importDistributionFileText(`${evmAddressOne},1\n${evmAddressTwo},2`).hasMixedAmounts).toBe(true);
  });

  it("accepts common headers and quoted values while reporting malformed rows", () => {
    const imported = importDistributionFileText(
      `wallet_address,amount\n"${evmAddressOne}","0.25"\n${evmAddressTwo},0.25,unexpected`
    );

    expect(imported.addresses).toBe(evmAddressOne);
    expect(imported.fixedAmount).toBe("0.25");
    expect(imported.invalidRows).toBe(1);
  });

  it("rejects unsafe row limits", () => {
    expect(() => importDistributionFileText(evmAddressOne, 0)).toThrow("maxRows");
    expect(() => importDistributionFileText(evmAddressOne, 10_001)).toThrow("maxRows");
  });
});
