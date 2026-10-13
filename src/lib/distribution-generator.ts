import {
  getDuplicateAddressKey,
  getListAddressKind,
  type AddressKind
} from "./address";
import { MAX_SOLANA_LAMPORTS } from "./amount";
import { parseRecipientImport, type RecipientImportOptions } from "./recipient-import-parser";

export type DistributionAmountMode = "fixed" | "random" | "per-row";

export const MAX_DISTRIBUTION_ROWS = 5_000;
export const MAX_DISTRIBUTION_INPUT_CHARACTERS = 512 * 1024;

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
const maxUint256 = (1n << 256n) - 1n;

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
  const normalizedInput = value.trim();
  if (normalizedInput.length > 160) return null;
  const match = normalizedInput.match(decimalAmountPattern);
  if (!match) return null;

  const fraction = match[2] || "";
  if (fraction.length > decimals) return null;
  const normalizedWhole = match[1].replace(/^0+(?=\d)/, "");
  if (normalizedWhole.length > 78) return null;

  const units = BigInt(normalizedWhole) * getScale(decimals)
    + BigInt(fraction.padEnd(decimals, "0") || "0");
  return units > 0n && units <= maxUint256 ? units : null;
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

export type ImportedDistributionFile = ImportedDistributionInput & {
  /** Normalized source rows, retaining each supplied amount without recomputation. */
  rows: string;
  invalidRows: number;
  sourceRows: number;
  truncated: boolean;
  issues: { line: number; message: string }[];
  format: string;
  detectedColumns: string[];
  duplicateRows: number;
  conflictingRows: number;
};

export function importDistributionInput(input: string): ImportedDistributionInput {
  const rows = input.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const addresses: string[] = [];
  const amounts = new Set<string>();
  let hadAmounts = false;
  let rowsWithAmounts = 0;

  rows.forEach((line) => {
    const parts = line.split(",").map((part) => part.trim());
    if (parts[0]) addresses.push(parts[0]);
    if (parts.length === 2 && parts[1]) {
      hadAmounts = true;
      rowsWithAmounts += 1;
      amounts.add(parts[1]);
    }
  });

  const hasMixedAmounts = amounts.size > 1
    || (hadAmounts && rowsWithAmounts !== addresses.length);

  return {
    addresses: addresses.join("\n"),
    fixedAmount: !hasMixedAmounts && amounts.size === 1 ? [...amounts][0] : "",
    hadAmounts,
    hasMixedAmounts
  };
}

export function importDistributionFileText(
  input: string,
  optionsOrMaxRows: number | RecipientImportOptions = MAX_DISTRIBUTION_ROWS
): ImportedDistributionFile {
  const options = typeof optionsOrMaxRows === "number" ? {} : optionsOrMaxRows;
  const maxRows = typeof optionsOrMaxRows === "number" ? optionsOrMaxRows : optionsOrMaxRows.maxRows ?? MAX_DISTRIBUTION_ROWS;
  if (!Number.isInteger(maxRows) || maxRows <= 0 || maxRows > 10_000) {
    throw new RangeError("maxRows must be an integer between 1 and 10000");
  }
  if (input.length > MAX_DISTRIBUTION_INPUT_CHARACTERS) {
    throw new RangeError("distribution file text must not exceed 512 KB");
  }
  const { normalizedRows, ...metadata } = parseRecipientImport(input, options, maxRows);
  return {
    ...importDistributionInput(normalizedRows),
    rows: normalizedRows,
    ...metadata
  };
}

export function generateDistributionList(args: GenerateDistributionListArgs): GeneratedDistributionList {
  assertDecimals(args.decimals);

  if (args.addresses.length > MAX_DISTRIBUTION_INPUT_CHARACTERS) {
    return {
      duplicates: 0,
      invalid: 1,
      issues: ["清单不能超过 512 KB，请拆分后分批处理"],
      output: "",
      total: "0",
      totalUnits: 0n,
      validCount: 0
    };
  }

  const addresses = getAddressRows(args.addresses);
  if (addresses.length > MAX_DISTRIBUTION_ROWS) {
    return {
      duplicates: 0,
      invalid: addresses.length - MAX_DISTRIBUTION_ROWS,
      issues: [`清单最多支持 ${MAX_DISTRIBUTION_ROWS} 个地址，请拆分后分批处理`],
      output: "",
      total: "0",
      totalUnits: 0n,
      validCount: 0
    };
  }
  const amountPlan = args.mode === "per-row" ? null : createAmountPlan(args);
  const seen = new Set<string>();
  const outputRows: string[] = [];
  const issues: string[] = [];
  let duplicates = 0;
  let invalid = 0;
  let totalUnits = 0n;
  const isExpectedAddress = (address: string) => args.validateAddress
    ? args.validateAddress(address)
    : getListAddressKind(address) === args.addressKind;

  addresses.forEach((sourceRow, index) => {
    const parts = args.mode === "per-row" ? sourceRow.split(",").map((part) => part.trim()) : [sourceRow];
    const address = parts[0];
    if (!isExpectedAddress(address)) {
      issues.push(`第 ${index + 1} 行地址格式不正确`);
      invalid += 1;
      return;
    }

    const rowAmount = args.mode === "per-row" && parts.length === 2 ? parseAmountToUnits(parts[1], args.decimals) : null;
    if (args.mode === "per-row" && (rowAmount === null || args.addressKind === "solana" && (rowAmount > MAX_SOLANA_LAMPORTS || parts[1].length > 64))) {
      issues.push(`第 ${index + 1} 行需要“地址,金额”，金额必须大于 0，最多 ${args.decimals} 位小数`);
      invalid += 1;
      return;
    }

    const duplicateKey = getDuplicateAddressKey(address, args.addressKind);
    if (seen.has(duplicateKey)) {
      duplicates += 1;
      return;
    }
    seen.add(duplicateKey);

    if (args.mode !== "per-row" && !amountPlan?.nextAmount) {
      invalid += 1;
      return;
    }

    const amountUnits = rowAmount ?? amountPlan!.nextAmount!(address, index);
    totalUnits += amountUnits;
    outputRows.push(`${address},${args.mode === "per-row" ? parts[1] : formatAmountUnits(amountUnits, args.decimals)}`);
  });

  if (amountPlan?.issue && addresses.some(isExpectedAddress)) {
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

export function dedupeDistributionAddresses(addresses: string, kind: AddressKind, mode: DistributionAmountMode = "fixed") {
  const seen = new Set<string>();
  return getAddressRows(addresses).filter((address) => {
    const duplicateKey = getDuplicateAddressKey(mode === "per-row" ? address.split(",")[0].trim() : address, kind);
    if (seen.has(duplicateKey)) return false;
    seen.add(duplicateKey);
    return true;
  }).join("\n");
}
