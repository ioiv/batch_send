import {
  getDuplicateAddressKey,
  getListAddressKind,
  type AddressKind
} from "./address";

export type DistributionAmountMode = "fixed" | "random";

export type GenerateDistributionListArgs = {
  addresses: string;
  addressKind: AddressKind;
  decimals: number;
  fixedAmount?: string;
  maxAmount?: string;
  minAmount?: string;
  mode: DistributionAmountMode;
  /** Receives inclusive bounds expressed as precision-step indexes. */
  randomBigInt?: (min: bigint, max: bigint, address: string, index: number) => bigint;
  validateAddress?: (address: string) => boolean;
};

export type GeneratedDistributionList = {
  duplicates: number;
  invalid: number;
  issues: string[];
  output: string;
  total: string;
  totalUnits: bigint;
  validCount: number;
};

type AmountPlan = {
  issue: string | null;
  nextAmount: ((address: string, index: number) => bigint) | null;
};

const decimalAmountPattern = /^(\d+)(?:\.(\d*))?$/;

function assertDecimals(decimals: number) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new RangeError("decimals must be an integer between 0 and 255");
  }
}

function getScale(decimals: number) {
  assertDecimals(decimals);
  return 10n ** BigInt(decimals);
}

function parseAmountToUnits(value: string, decimals: number) {
  const match = value.trim().match(decimalAmountPattern);
  if (!match) return null;

  const fraction = match[2] || "";
  if (fraction.length > decimals) return null;

  const units = BigInt(match[1]) * getScale(decimals)
    + BigInt(fraction.padEnd(decimals, "0") || "0");
  return units > 0n ? units : null;
}

function formatAmountUnits(units: bigint, decimals: number) {
  const scale = getScale(decimals);
  const whole = units / scale;
  if (decimals === 0) return whole.toString();

  const fraction = (units % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function getTypedFractionDigits(value: string) {
  const match = value.trim().match(decimalAmountPattern);
  return match ? (match[2] || "").length : 0;
}

/**
 * Returns the smallest base-unit step represented by the supplied amount inputs.
 * The final argument is the asset's decimals, for example:
 * getDistributionAmountStep("0.01", "1", 6) === 10_000n.
 */
export function getDistributionAmountStep(
  ...valuesAndDecimals: [...values: string[], decimals: number]
) {
  const decimals = valuesAndDecimals.at(-1);
  if (typeof decimals !== "number") {
    throw new TypeError("getDistributionAmountStep requires decimals as its final argument");
  }
  assertDecimals(decimals);

  const values = valuesAndDecimals.slice(0, -1) as string[];
  const fractionDigits = values.reduce(
    (highest, value) => Math.max(highest, Math.min(getTypedFractionDigits(value), decimals)),
    0
  );
  return 10n ** BigInt(decimals - fractionDigits);
}

function randomBigIntInclusive(min: bigint, max: bigint) {
  if (max < min) throw new RangeError("random maximum must be greater than or equal to minimum");

  const range = max - min + 1n;
  const byteLength = Math.max(1, Math.ceil(range.toString(2).length / 8));
  const generatedRange = 1n << BigInt(byteLength * 8);
  const limit = generatedRange - (generatedRange % range);
  const bytes = new Uint8Array(byteLength);

  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("secure random number generation is unavailable");
  }

  while (true) {
    globalThis.crypto.getRandomValues(bytes);
    let value = 0n;
    for (const byte of bytes) value = (value << 8n) + BigInt(byte);
    if (value < limit) return min + (value % range);
  }
}

function createAmountPlan(args: GenerateDistributionListArgs): AmountPlan {
  if (args.mode === "fixed") {
    const amount = parseAmountToUnits(args.fixedAmount || "", args.decimals);
    return amount === null
      ? {
          issue: `固定金额需要大于 0，最多 ${args.decimals} 位小数`,
          nextAmount: null
        }
      : {
          issue: null,
          nextAmount: () => amount
        };
  }

  const minAmount = parseAmountToUnits(args.minAmount || "", args.decimals);
  const maxAmount = parseAmountToUnits(args.maxAmount || "", args.decimals);
  if (minAmount === null || maxAmount === null || maxAmount < minAmount) {
    return {
      issue: `随机区间需要大于 0，最大值不能小于最小值，且最多 ${args.decimals} 位小数`,
      nextAmount: null
    };
  }

  const step = getDistributionAmountStep(args.minAmount || "", args.maxAmount || "", args.decimals);
  const minStep = (minAmount + step - 1n) / step;
  const maxStep = maxAmount / step;
  if (maxStep < minStep) {
    return {
      issue: "随机区间没有符合当前输入精度的金额",
      nextAmount: null
    };
  }

  const chooseRandomBigInt = args.randomBigInt || randomBigIntInclusive;
  return {
    issue: null,
    nextAmount: (address, index) => {
      const selectedStep = chooseRandomBigInt(minStep, maxStep, address, index);
      if (selectedStep < minStep || selectedStep > maxStep) {
        throw new RangeError("randomBigInt returned a value outside the requested inclusive range");
      }
      return selectedStep * step;
    }
  };
}

function getAddressRows(addresses: string) {
  return addresses
    .split(/\n+/)
    .map((address) => address.trim())
    .filter(Boolean);
}

export type ImportedDistributionInput = {
  addresses: string;
  fixedAmount: string;
  hadAmounts: boolean;
  hasMixedAmounts: boolean;
};

export function importDistributionInput(input: string): ImportedDistributionInput {
  const rows = input.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const addresses: string[] = [];
  const amounts = new Set<string>();
  let hadAmounts = false;

  rows.forEach((line) => {
    const parts = line.split(",").map((part) => part.trim());
    if (parts[0]) addresses.push(parts[0]);
    if (parts.length === 2 && parts[1]) {
      hadAmounts = true;
      amounts.add(parts[1]);
    }
  });

  return {
    addresses: addresses.join("\n"),
    fixedAmount: amounts.size === 1 ? [...amounts][0] : "",
    hadAmounts,
    hasMixedAmounts: amounts.size > 1
  };
}

export function generateDistributionList(args: GenerateDistributionListArgs): GeneratedDistributionList {
  assertDecimals(args.decimals);

  const addresses = getAddressRows(args.addresses);
  const amountPlan = createAmountPlan(args);
  const seen = new Set<string>();
  const outputRows: string[] = [];
  const issues: string[] = [];
  let duplicates = 0;
  let invalid = 0;
  let totalUnits = 0n;
  const isExpectedAddress = (address: string) => args.validateAddress
    ? args.validateAddress(address)
    : getListAddressKind(address) === args.addressKind;

  addresses.forEach((address, index) => {
    if (!isExpectedAddress(address)) {
      issues.push(`第 ${index + 1} 行地址格式不正确`);
      invalid += 1;
      return;
    }

    const duplicateKey = getDuplicateAddressKey(address, args.addressKind);
    if (seen.has(duplicateKey)) {
      duplicates += 1;
      return;
    }
    seen.add(duplicateKey);

    if (!amountPlan.nextAmount) {
      invalid += 1;
      return;
    }

    const amountUnits = amountPlan.nextAmount(address, index);
    totalUnits += amountUnits;
    outputRows.push(`${address},${formatAmountUnits(amountUnits, args.decimals)}`);
  });

  if (amountPlan.issue && addresses.some(isExpectedAddress)) {
    issues.push(amountPlan.issue);
  }

  return {
    duplicates,
    invalid,
    issues,
    output: outputRows.join("\n"),
    total: formatAmountUnits(totalUnits, args.decimals),
    totalUnits,
    validCount: outputRows.length
  };
}

export function dedupeDistributionAddresses(addresses: string, kind: AddressKind) {
  const seen = new Set<string>();
  return getAddressRows(addresses).filter((address) => {
    const duplicateKey = getDuplicateAddressKey(address, kind);
    if (seen.has(duplicateKey)) return false;
    seen.add(duplicateKey);
    return true;
  }).join("\n");
}
