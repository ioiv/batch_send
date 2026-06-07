import { describe, expect, it } from "vitest";
import { GENERATOR_AMOUNT_STEP_LAMPORTS, formatLamports, formatLamportsForDisplay, getSolAmountFractionDigits, getSolAmountStepLamports, parseSolToLamports, randomLamportsInStepRange } from "./amount";

describe("parseSolToLamports", () => {
  it("parses SOL strings into lamports", () => {
    expect(parseSolToLamports("1")).toBe(1_000_000_000n);
    expect(parseSolToLamports("0.000000001")).toBe(1n);
    expect(parseSolToLamports("1.23456789")).toBe(1_234_567_890n);
    expect(parseSolToLamports(" 2.5 ")).toBe(2_500_000_000n);
  });

  it("rejects invalid or non-positive amounts", () => {
    expect(parseSolToLamports("0")).toBeNull();
    expect(parseSolToLamports("0.0")).toBeNull();
    expect(parseSolToLamports("-1")).toBeNull();
    expect(parseSolToLamports("1.0000000001")).toBeNull();
    expect(parseSolToLamports("abc")).toBeNull();
    expect(parseSolToLamports(".1")).toBeNull();
  });
});

describe("formatLamports", () => {
  it("formats lamports without losing precision", () => {
    expect(formatLamports(0n)).toBe("0");
    expect(formatLamports(1n)).toBe("0.000000001");
    expect(formatLamports(1_000_000_000n)).toBe("1");
    expect(formatLamports(1_234_567_890n)).toBe("1.23456789");
    expect(formatLamports(1_500_000_000n)).toBe("1.5");
  });

  it("formats displayed balances to at most 2 decimal places", () => {
    expect(formatLamportsForDisplay(1_234_567_890n)).toBe("1.23");
    expect(formatLamportsForDisplay(1_200_000_000n)).toBe("1.2");
    expect(formatLamportsForDisplay(42n)).toBe("0");
  });

  it("formats displayed totals to a requested SOL precision", () => {
    expect(formatLamportsForDisplay(1_234_567_890n, 3)).toBe("1.234");
    expect(formatLamportsForDisplay(1_230_000_000n, 3)).toBe("1.23");
    expect(formatLamportsForDisplay(999_999n, 3)).toBe("0");
  });
});

describe("getSolAmountFractionDigits", () => {
  it("reads the typed SOL amount precision", () => {
    expect(getSolAmountFractionDigits("1")).toBe(0);
    expect(getSolAmountFractionDigits("0.5")).toBe(1);
    expect(getSolAmountFractionDigits("0.001")).toBe(3);
    expect(getSolAmountFractionDigits("0.0100")).toBe(4);
    expect(getSolAmountFractionDigits("0.1234567891")).toBe(9);
  });
});

describe("getSolAmountStepLamports", () => {
  it("uses the highest typed precision across amount inputs", () => {
    expect(getSolAmountStepLamports("0.5", "1")).toBe(100_000_000n);
    expect(getSolAmountStepLamports("0.01", "1")).toBe(10_000_000n);
    expect(getSolAmountStepLamports("0.1", "0.001")).toBe(1_000_000n);
  });
});

describe("randomLamportsInStepRange", () => {
  it("uses 0.1 SOL as the default generator step", () => {
    expect(GENERATOR_AMOUNT_STEP_LAMPORTS).toBe(100_000_000n);
    expect(randomLamportsInStepRange(1n, 99_999_999n)).toBeNull();
    expect(randomLamportsInStepRange(1n, 199_999_999n)).toBe(100_000_000n);
  });
});
