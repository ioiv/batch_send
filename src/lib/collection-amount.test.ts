import { describe, expect, it } from "vitest";
import { resolveCollectionAmount } from "./collection-amount";

describe("resolveCollectionAmount", () => {
  it("supports all, percentage, fixed and bounded random amounts", () => {
    expect(resolveCollectionAmount(1_000n, { mode: "all" })).toEqual({ amount: 1_000n, status: "ready" });
    expect(resolveCollectionAmount(1_000n, { mode: "percentage", percentageBps: 2_500n }))
      .toEqual({ amount: 250n, status: "ready" });
    expect(resolveCollectionAmount(1_000n, { amount: 300n, mode: "fixed" }))
      .toEqual({ amount: 300n, status: "ready" });
    expect(resolveCollectionAmount(
      1_000n,
      { maxAmount: 400n, minAmount: 200n, mode: "random" },
      () => 37n
    )).toEqual({ amount: 237n, status: "ready" });
  });

  it("caps random amounts and skips fixed amounts that exceed the spendable balance", () => {
    expect(resolveCollectionAmount(
      250n,
      { maxAmount: 400n, minAmount: 200n, mode: "random" },
      (width) => width - 1n
    )).toEqual({ amount: 250n, status: "ready" });
    expect(resolveCollectionAmount(250n, { amount: 300n, mode: "fixed" }))
      .toEqual({ amount: 0n, reason: "insufficient-balance", status: "skipped" });
  });
});
