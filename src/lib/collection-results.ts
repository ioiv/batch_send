export type CollectionResultStatus =
  | "pending"
  | "scanning"
  | "submitting"
  | "confirming"
  | "success"
  | "skipped"
  | "error";

export type CollectionDisplayResult = {
  phase?: "token" | "nft" | "native";
  address: string;
  amount?: string;
  asset: string;
  assetKey?: string;
  executionId?: string;
  explorerUrl?: string;
  hash?: string;
  label?: string;
  message: string;
  retryable?: boolean;
  status: CollectionResultStatus;
  uncertain?: boolean;
};

export type CollectionResultDisplayStatus = CollectionResultStatus | "uncertain";

// Keep execution states intact; an uncertain submission is a separate review state.
export function getCollectionResultDisplayStatus(result: CollectionDisplayResult): CollectionResultDisplayStatus {
  return result.uncertain || (result.uncertain === undefined && result.status === "error" && result.hash && result.retryable !== true)
    ? "uncertain" : result.status;
}

export function shortenTransactionHash(hash: string) {
  return hash.length > 18 ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : hash;
}

export function sanitizeRoundArchiveText(value: string) {
  return value.replace(/\b(?:https?|wss?):\/\/[^\s<>"')]+/gi, "[敏感 URL 已隐藏]").replace(/\b(?:0x)?[a-fA-F0-9]{64}\b/g, "[敏感数据已隐藏]");
}

export type CollectionResultCounts = {
  active: number;
  error: number;
  skipped: number;
  success: number;
  total: number;
  uncertain: number;
};

export type CollectionResultFilter = "all" | "active" | "success" | "skipped" | "error" | "uncertain";

export type FilterCollectionResultsOptions = {
  query?: string;
  status?: CollectionResultFilter;
};

export function getCollectionResultCounts(results: CollectionDisplayResult[]): CollectionResultCounts {
  return results.reduce<CollectionResultCounts>((counts, result) => {
    counts.total += 1;
    const status = getCollectionResultDisplayStatus(result);
    if (status === "success") counts.success += 1;
    else if (status === "skipped") counts.skipped += 1;
    else if (status === "error") counts.error += 1;
    else if (status === "uncertain") counts.uncertain += 1;
    else counts.active += 1;
    return counts;
  }, { active: 0, error: 0, skipped: 0, success: 0, total: 0, uncertain: 0 });
}

export function filterCollectionResults(
  results: CollectionDisplayResult[],
  { query = "", status = "all" }: FilterCollectionResultsOptions = {}
) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return results.filter((result) => {
    const displayStatus = getCollectionResultDisplayStatus(result);
    const matchesStatus = status === "all"
      || (status === "active"
        ? !["success", "skipped", "error", "uncertain"].includes(displayStatus)
        : displayStatus === status);
    if (!matchesStatus) return false;
    if (!normalizedQuery) return true;

    return [
      result.address,
      result.amount,
      result.asset,
      result.hash,
      result.label,
      result.message
    ].some((value) => value?.toLocaleLowerCase().includes(normalizedQuery));
  });
}

function escapeCsvCell(value: string) {
  // Spreadsheet applications may execute cells beginning with formula markers.
  // Prefixing an apostrophe preserves the visible value while treating it as text.
  const safeValue = /^[\s\u0000-\u001f]*[=+\-@]/.test(value) ? `'${value}` : value;
  if (!/[",\r\n]/.test(safeValue)) return safeValue;
  return `"${safeValue.replace(/"/g, '""')}"`;
}

export function createCollectionResultsCsv(results: CollectionDisplayResult[]) {
  const includePhase = results.some(result => result.phase);
  const header = ["label", "address", "asset", "amount", "status", "message", "transaction_hash", "explorer_url"];
  const rows = results.map((result) => [
    result.label || "",
    result.address,
    result.asset,
    result.amount || "",
    getCollectionResultDisplayStatus(result),
    result.message,
    result.hash || "",
    result.explorerUrl || ""
  ]);

  if (includePhase) { header.push("phase"); rows.forEach((row, index) => row.push(results[index].phase || "")); }
  return [header, ...rows]
    .map((row) => row.map((cell) => escapeCsvCell(cell)).join(","))
    .join("\r\n");
}

export function downloadCollectionResults(results: CollectionDisplayResult[], filename: string) {
  const blob = new Blob([`\uFEFF${createCollectionResultsCsv(results)}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.download = filename;
  anchor.href = url;
  anchor.click();
  URL.revokeObjectURL(url);
}
