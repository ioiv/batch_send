import { describe, expect, it, vi } from "vitest";
import {
  formatGasPriceGwei,
  getEvmFeeCapPerGas,
  getEvmFeeRequest,
  getEvmGasRecommendations,
  parseGweiToWei,
  resolveEvmFeeQuote
} from "./evm-gas";

describe("EVM gas helpers", () => {
  it("parses positive Gwei values without floating point loss", () => {
    expect(parseGweiToWei("1")).toBe(1_000_000_000n);
    expect(parseGweiToWei("0.125")).toBe(125_000_000n);
    expect(parseGweiToWei("12.000000001")).toBe(12_000_000_001n);
  });

  it("rejects empty, non-positive, negative, and over-precise values", () => {
    expect(parseGweiToWei("")).toBeNull();
    expect(parseGweiToWei("0")).toBeNull();
    expect(parseGweiToWei("-1")).toBeNull();
    expect(parseGweiToWei("1.0000000001")).toBeNull();
  });

  it("formats gas prices as compact Gwei values", () => {
    expect(formatGasPriceGwei(1_000_000_000n)).toBe("1");
    expect(formatGasPriceGwei(12_345_678_901n)).toBe("12.3456");
    expect(formatGasPriceGwei(125_000_000n)).toBe("0.125");
  });

  it("builds typed slow, standard, and fast legacy recommendations with ceiling rounding", () => {
    const recommendations = getEvmGasRecommendations({
      gasPrice: 101n,
      type: "legacy"
    });
    const slowTier: "slow" = recommendations.slow.tier;
    const standardLabel: "中" = recommendations.standard.label;
    const fastMultiplier: 120 = recommendations.fast.multiplierPercent;

    expect({ slowTier, standardLabel, fastMultiplier }).toEqual({
      fastMultiplier: 120,
      slowTier: "slow",
      standardLabel: "中"
    });
    expect(recommendations).toEqual({
      slow: {
        fee: { gasPrice: 91n, type: "legacy" },
        label: "慢",
        multiplierPercent: 90,
        tier: "slow"
      },
      standard: {
        fee: { gasPrice: 101n, type: "legacy" },
        label: "中",
        multiplierPercent: 100,
        tier: "standard"
      },
      fast: {
        fee: { gasPrice: 122n, type: "legacy" },
        label: "快",
        multiplierPercent: 120,
        tier: "fast"
      }
    });
  });

  it("scales both EIP-1559 fields while preserving the fee relationship", () => {
    const recommendations = getEvmGasRecommendations({
      maxFeePerGas: 101n,
      maxPriorityFeePerGas: 3n,
      type: "eip1559"
    });

    expect(recommendations.slow.fee).toEqual({
      maxFeePerGas: 91n,
      maxPriorityFeePerGas: 3n,
      type: "eip1559"
    });
    expect(recommendations.standard.fee).toEqual({
      maxFeePerGas: 101n,
      maxPriorityFeePerGas: 3n,
      type: "eip1559"
    });
    expect(recommendations.fast.fee).toEqual({
      maxFeePerGas: 122n,
      maxPriorityFeePerGas: 4n,
      type: "eip1559"
    });
    for (const recommendation of Object.values(recommendations)) {
      if (recommendation.fee.type !== "eip1559") {
        throw new Error("Expected an EIP-1559 recommendation");
      }
      expect(recommendation.fee.maxPriorityFeePerGas)
        .toBeLessThanOrEqual(recommendation.fee.maxFeePerGas);
    }
  });

  it("keeps zero priority fee valid and rounds positive one-wei values up", () => {
    const recommendations = getEvmGasRecommendations({
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 0n,
      type: "eip1559"
    });

    expect(recommendations.slow.fee).toEqual({
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 0n,
      type: "eip1559"
    });
    expect(recommendations.fast.fee).toEqual({
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 0n,
      type: "eip1559"
    });
  });

  it("rejects invalid base quotes instead of producing illegal presets", () => {
    expect(() => getEvmGasRecommendations({ gasPrice: 0n, type: "legacy" }))
      .toThrow("Gas Price 必须大于 0");
    expect(() => getEvmGasRecommendations({
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 2n,
      type: "eip1559"
    })).toThrow("Priority Fee 不能高于 Max Fee");
  });

  it("uses an EIP-1559 RPC quote without also requesting legacy gas price", async () => {
    const getGasPrice = vi.fn(async () => 99n);
    const quote = await resolveEvmFeeQuote({
      estimateFeesPerGas: vi.fn(async () => ({
        maxFeePerGas: 30n,
        maxPriorityFeePerGas: 2n
      })),
      getGasPrice
    });

    expect(quote).toMatchObject({
      maxFeePerGas: 30n,
      maxPriorityFeePerGas: 2n,
      source: "rpc",
      type: "eip1559"
    });
    expect(getEvmFeeCapPerGas(quote)).toBe(30n);
    expect(getEvmFeeRequest(quote)).toEqual({
      maxFeePerGas: 30n,
      maxPriorityFeePerGas: 2n
    });
    expect(getGasPrice).not.toHaveBeenCalled();
  });

  it("falls back to legacy only when EIP-1559 is unsupported", async () => {
    const quote = await resolveEvmFeeQuote({
      estimateFeesPerGas: vi.fn(async () => {
        const error = new Error("Chain does not support EIP-1559 fees");
        error.name = "Eip1559FeesNotSupportedError";
        throw error;
      }),
      getGasPrice: vi.fn(async () => 12n)
    });

    expect(quote).toMatchObject({ gasPrice: 12n, source: "rpc", type: "legacy" });
    expect(getEvmFeeRequest(quote)).toEqual({ gasPrice: 12n });
  });

  it("binds a custom quote without making an RPC fee request", async () => {
    const estimateFeesPerGas = vi.fn();
    const getGasPrice = vi.fn();
    const quote = await resolveEvmFeeQuote({ estimateFeesPerGas, getGasPrice }, {
      fee: {
        maxFeePerGas: 50n,
        maxPriorityFeePerGas: 3n,
        type: "eip1559"
      },
      mode: "custom"
    });

    expect(quote).toMatchObject({
      maxFeePerGas: 50n,
      maxPriorityFeePerGas: 3n,
      source: "custom",
      type: "eip1559"
    });
    expect(estimateFeesPerGas).not.toHaveBeenCalled();
    expect(getGasPrice).not.toHaveBeenCalled();
  });

  it("does not hide an RPC transport failure behind a legacy fallback", async () => {
    const getGasPrice = vi.fn(async () => 12n);
    await expect(resolveEvmFeeQuote({
      estimateFeesPerGas: vi.fn(async () => {
        throw new Error("HTTP request timed out");
      }),
      getGasPrice
    })).rejects.toThrow("timed out");
    expect(getGasPrice).not.toHaveBeenCalled();
  });
});
