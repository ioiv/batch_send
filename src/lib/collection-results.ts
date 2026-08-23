export type CollectionResultStatus =
  | "pending"
  | "scanning"
  | "submitting"
  | "confirming"
  | "success"
  | "skipped"
  | "error";

export type CollectionDisplayResult = {
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

export function sanitizeRoundArchiveText(value: string) {
  return value.replace(/\b(?:https?|wss?):\/\/[^\s<>"')]+/gi, "[敏感 URL 已隐藏]");
}

export type CollectionResultCounts = {
  active: number;
  error: number;
  skipped: number;
  success: number;
  total: number;
};

export type CollectionResultFilter = "all" | "active" | "success" | "skipped" | "error";

export type FilterCollectionResultsOptions = {
  query?: string;
  status?: CollectionResultFilter;
};

export function getCollectionResultCounts(results: CollectionDisplayResult[]): CollectionResultCounts {
  return results.reduce<CollectionResultCounts>((counts, result) => {
    counts.total += 1;
    if (result.status === "success") counts.success += 1;
    else if (result.status === "skipped") counts.skipped += 1;
    else if (result.status === "error") counts.error += 1;
    else counts.active += 1;
    return counts;
  }, { active: 0, error: 0, skipped: 0, success: 0, total: 0 });
}

export function filterCollectionResults(
  results: CollectionDisplayResult[],
  { query = "", status = "all" }: FilterCollectionResultsOptions = {}
) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return results.filter((result) => {
    const matchesStatus = status === "all"
      || (status === "active"
        ? !["success", "skipped", "error"].includes(result.status)
        : result.status === status);
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
  const header = ["label", "address", "asset", "amount", "status", "message", "transaction_hash", "explorer_url"];
  const rows = results.map((result) => [
    result.label || "",
    result.address,
    result.asset,
    result.amount || "",
    result.status,
    result.message,
    result.hash || "",
    result.explorerUrl || ""
  ]);

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
