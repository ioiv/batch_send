import { getDuplicateAddressKey, getListAddressKind, isValidSolanaAddress } from "./address";
import { formatLamports, parseSolToLamports } from "./amount";

export type ReviewStatus = "valid" | "warn" | "invalid";

export type DistributionRow = {
  line: number;
  address: string;
  amount: number;
  amountRaw: string;
  lamports: bigint;
  status: ReviewStatus;
  problems: string[];
};

export type ParseDistributionResult = {
  cleanRows: string[];
  duplicates: number;
  invalid: number;
  rows: DistributionRow[];
  total: string;
  totalLamports: bigint;
  validRows: DistributionRow[];
};

export const distributionListQueryParam = "list";
export const distributionTransferQueryParam = "from";
export const distributionTransferSource = "format-generator";
export const distributionTransferStorageKey = "sol_batch_send.generated_distribution";
export const maxDistributionUrlQueryLength = 1800;
export const solanaDistributionPage = "/sol/";
export const evmDistributionPage = "/evm/";

export function chunkRows<T>(rows: T[], chunkSize: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += chunkSize) {
    chunks.push(rows.slice(index, index + chunkSize));
  }
  return chunks;
}

export function parseDistribution(input: string): ParseDistributionResult {
  const lines = input.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const seen = new Set<string>();
  const rows: DistributionRow[] = [];
  let totalLamports = 0n;
  let invalid = 0;
  let duplicates = 0;

  lines.forEach((line, index) => {
    const parts = line.split(",").map((part) => part.trim());
    const address = parts[0] || "";
    const amountRaw = parts[1] || "";
    const amount = Number(amountRaw);
    const lamports = parseSolToLamports(amountRaw);
    const problems: string[] = [];

    if (parts.length !== 2) problems.push("格式需要刚好包含一个逗号");
    if (!isValidSolanaAddress(address)) problems.push("地址格式不正确");
    if (!lamports) problems.push("金额需要大于 0，最多 9 位小数");

    const duplicateKey = getDuplicateAddressKey(address, "solana");
    if (seen.has(duplicateKey)) {
      problems.push("重复地址不可发送");
      duplicates += 1;
    }
    seen.add(duplicateKey);

    if (problems.length > 0) invalid += 1;
    else totalLamports += lamports || 0n;

    rows.push({
      line: index + 1,
      address,
      amount,
      amountRaw,
      lamports: lamports || 0n,
      status: problems.length ? "invalid" : "valid",
      problems
    });
  });

  const cleanRows = rows
    .filter((row) => row.status === "valid")
    .map((row) => `${row.address},${formatLamports(row.lamports)}`);

  return {
    cleanRows,
    duplicates,
    invalid,
    rows,
    total: formatLamports(totalLamports),
    totalLamports,
    validRows: rows.filter((row) => row.status === "valid")
  };
}

export function getDistributionTransferHref(output: string, targetPage = solanaDistributionPage) {
  const directParams = new URLSearchParams({ [distributionListQueryParam]: output });
  const directHref = `${targetPage}?${directParams.toString()}`;
  if (directParams.toString().length <= maxDistributionUrlQueryLength) return directHref;

  try {
    window.sessionStorage.setItem(distributionTransferStorageKey, output);
    const storageParams = new URLSearchParams({ [distributionTransferQueryParam]: distributionTransferSource });
    return `${targetPage}?${storageParams.toString()}`;
  } catch {
    return directHref;
  }
}

export function getDistributionTargetPage(output: string) {
  const kinds = new Set(
    output
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => getListAddressKind((line.split(",")[0] || "").trim()))
      .filter((kind) => kind !== null)
  );

  if (kinds.size !== 1) return null;
  return kinds.has("evm") ? evmDistributionPage : solanaDistributionPage;
}

export function getInitialDistributionInput() {
  const params = new URLSearchParams(window.location.search);
  const queryList = params.get(distributionListQueryParam);
  if (queryList !== null) return queryList;

  if (params.get(distributionTransferQueryParam) !== distributionTransferSource) return "";

  try {
    return window.sessionStorage.getItem(distributionTransferStorageKey) || "";
  } catch {
    return "";
  }
}
