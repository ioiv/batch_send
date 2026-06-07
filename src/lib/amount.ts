export const LAMPORTS_PER_SOL_BIGINT = 1_000_000_000n;
export const GENERATOR_AMOUNT_STEP_LAMPORTS = 100_000n;

export function formatSol(value: number) {
  return Number(value.toFixed(4)).toString();
}

export function formatLamports(lamports: bigint) {
  const whole = lamports / LAMPORTS_PER_SOL_BIGINT;
  const fraction = lamports % LAMPORTS_PER_SOL_BIGINT;
  if (fraction === 0n) return whole.toString();
  const fractionText = fraction.toString().padStart(9, "0").replace(/0+$/, "");
  return `${whole}.${fractionText}`;
}

export function formatLamportsForDisplay(lamports: bigint, maxFractionDigits = 2) {
  const [integer, fraction = ""] = formatLamports(lamports).split(".");
  if (maxFractionDigits <= 0 || !fraction) return integer;

  const displayFraction = fraction.slice(0, maxFractionDigits).replace(/0+$/, "");
  return displayFraction ? `${integer}.${displayFraction}` : integer;
}

export function parseSolToLamports(value: string) {
  const match = value.trim().match(/^(\d+)(?:\.(\d{0,9}))?$/);
  if (!match) return null;

  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] || "").padEnd(9, "0"));
  const lamports = whole * LAMPORTS_PER_SOL_BIGINT + fraction;
  return lamports > 0n ? lamports : null;
}

export function ceilDiv(value: bigint, divisor: bigint) {
  return (value + divisor - 1n) / divisor;
}

export function randomBigIntInclusive(min: bigint, max: bigint) {
  if (max < min) throw new Error("Random range max must be greater than or equal to min");

  const range = max - min + 1n;
  const byteLength = Math.max(1, Math.ceil(range.toString(2).length / 8));
  const maxGenerated = 1n << BigInt(byteLength * 8);
  const limit = maxGenerated - (maxGenerated % range);
  const bytes = new Uint8Array(byteLength);

  while (true) {
    crypto.getRandomValues(bytes);
    let value = 0n;
    for (const byte of bytes) {
      value = (value << 8n) + BigInt(byte);
    }
    if (value < limit) return min + (value % range);
  }
}

export function randomLamportsInStepRange(minLamports: bigint, maxLamports: bigint, stepLamports = GENERATOR_AMOUNT_STEP_LAMPORTS) {
  const minUnits = ceilDiv(minLamports, stepLamports);
  const maxUnits = maxLamports / stepLamports;
  if (maxUnits < minUnits) return null;
  return randomBigIntInclusive(minUnits, maxUnits) * stepLamports;
}
