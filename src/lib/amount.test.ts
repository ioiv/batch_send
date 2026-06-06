import { describe, expect, it } from "vitest";
import { formatLamports, parseSolToLamports } from "./amount";

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
});
