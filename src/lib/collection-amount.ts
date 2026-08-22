export type CollectionAmountPolicy =
  | { mode: "all" }
  | { mode: "percentage"; percentageBps: bigint }
  | { amount: bigint; mode: "fixed" }
  | { maxAmount: bigint; minAmount: bigint; mode: "random" };

export type CollectionAmountResolution =
  | { amount: bigint; status: "ready" }
  | { amount: 0n; reason: "amount-too-small" | "insufficient-balance"; status: "skipped" };

function randomBigIntBelow(exclusiveUpperBound: bigint) {
  if (exclusiveUpperBound <= 1n) return 0n;
  const byteLength = Math.ceil(exclusiveUpperBound.toString(2).length / 8);
  const range = 1n << BigInt(byteLength * 8);
  const limit = range - (range % exclusiveUpperBound);
  const bytes = new Uint8Array(byteLength);

  for (;;) {
    if (globalThis.crypto?.getRandomValues) {
      globalThis.crypto.getRandomValues(bytes);
    } else {
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Math.floor(Math.random() * 256);
      }
    }
    let value = 0n;
    for (const byte of bytes) value = (value << 8n) + BigInt(byte);
    if (value < limit) return value % exclusiveUpperBound;
  }
}

/** Resolve a user-selected amount against the balance that is safe to spend. */
export function resolveCollectionAmount(
  spendableBalance: bigint,
  policy: CollectionAmountPolicy,
  randomBelow: (exclusiveUpperBound: bigint) => bigint = randomBigIntBelow
): CollectionAmountResolution {
  if (spendableBalance <= 0n) {
    return { amount: 0n, reason: "insufficient-balance", status: "skipped" };
  }

  if (policy.mode === "all") return { amount: spendableBalance, status: "ready" };

  if (policy.mode === "percentage") {
    if (policy.percentageBps <= 0n || policy.percentageBps > 10_000n) {
      throw new RangeError("percentageBps must be between 1 and 10000");
    }
    const amount = spendableBalance * policy.percentageBps / 10_000n;
    return amount > 0n
      ? { amount, status: "ready" }
      : { amount: 0n, reason: "amount-too-small", status: "skipped" };
  }

  if (policy.mode === "fixed") {
    if (policy.amount <= 0n) throw new RangeError("fixed amount must be positive");
    return policy.amount <= spendableBalance
      ? { amount: policy.amount, status: "ready" }
      : { amount: 0n, reason: "insufficient-balance", status: "skipped" };
  }

  if (policy.minAmount <= 0n || policy.maxAmount < policy.minAmount) {
    throw new RangeError("random amount range is invalid");
  }
  if (spendableBalance < policy.minAmount) {
    return { amount: 0n, reason: "insufficient-balance", status: "skipped" };
  }
  const cappedMaximum = policy.maxAmount < spendableBalance ? policy.maxAmount : spendableBalance;
  const width = cappedMaximum - policy.minAmount + 1n;
  const offset = randomBelow(width);
  if (offset < 0n || offset >= width) throw new RangeError("random amount source returned an invalid value");
  return { amount: policy.minAmount + offset, status: "ready" };
}
