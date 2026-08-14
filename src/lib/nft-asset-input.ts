import { getAddress, isAddress, type Address } from "viem";

export const DEFAULT_NFT_ASSET_ITEM_LIMIT = 1_000;
export const MAX_NFT_ASSET_ITEM_LIMIT = 10_000;

const MAX_INPUT_LENGTH = 500_000;
const MAX_UINT256 = (1n << 256n) - 1n;

export type NftAssetInputIssueCode =
  | "empty-input"
  | "input-too-large"
  | "invalid-token-id"
  | "invalid-range"
  | "token-id-out-of-range"
  | "item-limit"
  | "invalid-contract"
  | "invalid-row"
  | "duplicate-row";

export type NftAssetInputIssue = {
  code: NftAssetInputIssueCode;
  item?: number;
  line?: number;
  message: string;
  severity: "error" | "warning";
};

export type ExpandNftTokenIdsOptions = {
  maxItems?: number;
};

export type ExpandNftTokenIdsResult = {
  duplicates: number;
  issues: NftAssetInputIssue[];
  tokenIds: bigint[];
  truncated: boolean;
  values: string[];
};

export type NftAssetFileRow = {
  contractAddress: Address | null;
  line: number;
  problems: string[];
  status: "valid" | "invalid" | "duplicate" | "header";
  tokenId: bigint | null;
};

export type ParseNftAssetFileOptions = {
  maxItems?: number;
};

export type ParseNftAssetFileResult = {
  duplicates: number;
  invalid: number;
  issues: NftAssetInputIssue[];
  lines: string[];
  rows: NftAssetFileRow[];
  serialized: string;
  truncated: boolean;
  valid: number;
};

export type MergeNftAssetInputOptions = {
  maxItems?: number;
  standard?: "erc721" | "erc1155";
};

export type MergeNftAssetInputResult = {
  added: number;
  duplicates: number;
  issues: NftAssetInputIssue[];
  lines: string[];
  serialized: string;
  truncated: boolean;
};

type ParsedTokenId =
  | { ok: true; value: bigint }
  | { ok: false; code: "invalid-token-id" | "token-id-out-of-range" };

function normalizeItemLimit(value: number | undefined) {
  if (value === undefined) return DEFAULT_NFT_ASSET_ITEM_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1) return DEFAULT_NFT_ASSET_ITEM_LIMIT;
  return Math.min(value, MAX_NFT_ASSET_ITEM_LIMIT);
}

function errorIssue(
  code: NftAssetInputIssueCode,
  message: string,
  location: Pick<NftAssetInputIssue, "item" | "line"> = {}
): NftAssetInputIssue {
  return { code, message, severity: "error", ...location };
}

function parseUint256(value: string): ParsedTokenId {
  if (!/^\d+$/.test(value)) return { ok: false, code: "invalid-token-id" };

  const normalized = value.replace(/^0+(?=\d)/, "");
  // uint256 has at most 78 decimal digits. Checking length first avoids
  // constructing a BigInt from an attacker-controlled, extremely long value.
  if (normalized.length > 78) return { ok: false, code: "token-id-out-of-range" };

  const tokenId = BigInt(normalized);
  if (tokenId > MAX_UINT256) return { ok: false, code: "token-id-out-of-range" };
  return { ok: true, value: tokenId };
}

function tokenIdProblem(code: ParsedTokenId & { ok: false }, item: number) {
  if (code.code === "token-id-out-of-range") {
    return errorIssue(
      code.code,
      `第 ${item} 项超过了 ERC-721 / ERC-1155 支持的 Token ID 范围`,
      { item }
    );
  }
  return errorIssue(
    code.code,
    `第 ${item} 项不是有效的 Token ID 或连续区间（例如 1-5）`,
    { item }
  );
}

/**
 * Expands comma/space/newline separated token IDs and inclusive ranges.
 * User input problems are returned as issues rather than thrown.
 */
export function expandNftTokenIds(
  input: string,
  options: ExpandNftTokenIdsOptions = {}
): ExpandNftTokenIdsResult {
  const maxItems = normalizeItemLimit(options.maxItems);
  const issues: NftAssetInputIssue[] = [];
  const tokenIds: bigint[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  let truncated = false;
  let limitReported = false;

  if (input.length > MAX_INPUT_LENGTH) {
    return {
      duplicates,
      issues: [errorIssue("input-too-large", "Token ID 输入内容过大，请分批处理")],
      tokenIds,
      truncated: true,
      values: []
    };
  }

  const items = input.trim().split(/[,\s]+/).filter(Boolean);
  if (items.length === 0) {
    return {
      duplicates,
      issues: [errorIssue("empty-input", "请输入至少一个 Token ID")],
      tokenIds,
      truncated,
      values: []
    };
  }

  const reportLimit = (item: number) => {
    truncated = true;
    if (limitReported) return;
    issues.push(errorIssue(
      "item-limit",
      `一次最多生成 ${maxItems} 个 NFT 资产，请缩小区间或分批处理`,
      { item }
    ));
    limitReported = true;
  };

  const addTokenId = (tokenId: bigint, item: number) => {
    const key = tokenId.toString();
    if (seen.has(key)) {
      duplicates += 1;
      return true;
    }
    if (tokenIds.length >= maxItems) {
      reportLimit(item);
      return false;
    }
    seen.add(key);
    tokenIds.push(tokenId);
    return true;
  };

  items.forEach((itemValue, itemIndex) => {
    const item = itemIndex + 1;
    const rangeMatch = /^(\d+)-(\d+)$/.exec(itemValue);
    if (!rangeMatch) {
      const parsed = parseUint256(itemValue);
      if (!parsed.ok) {
        issues.push(tokenIdProblem(parsed, item));
        return;
      }
      addTokenId(parsed.value, item);
      return;
    }

    const start = parseUint256(rangeMatch[1]);
    const end = parseUint256(rangeMatch[2]);
    if (!start.ok) {
      issues.push(tokenIdProblem(start, item));
      return;
    }
    if (!end.ok) {
      issues.push(tokenIdProblem(end, item));
      return;
    }
    if (start.value > end.value) {
      issues.push(errorIssue(
        "invalid-range",
        `第 ${item} 项的区间起点不能大于终点`,
        { item }
      ));
      return;
    }

    const rangeSize = end.value - start.value + 1n;
    if (rangeSize > BigInt(maxItems)) {
      reportLimit(item);
      return;
    }

    for (let tokenId = start.value; tokenId <= end.value; tokenId += 1n) {
      if (!addTokenId(tokenId, item)) break;
    }
  });

  return {
    duplicates,
    issues,
    tokenIds,
    truncated,
    values: tokenIds.map(String)
  };
}

function parseCsvFields(line: string): string[] | null {
  if (!line.includes(",")) {
    const fields = line.trim().split(/\s+/);
    return fields.length === 2 ? fields : null;
  }

  const fields: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (character === "," && !quoted) {
      fields.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }

  if (quoted) return null;
  fields.push(current.trim());
  return fields;
}

function isHeader(fields: string[]) {
  if (fields.length !== 2) return false;
  const normalized = fields.map((field) => field.toLowerCase().replace(/[\s_-]/g, ""));
  return ["contract", "contractaddress", "address"].includes(normalized[0])
    && ["tokenid", "id"].includes(normalized[1]);
}

function normalizeContractAddress(value: string): Address | null {
  const trimmed = value.trim();
  // `getAddress` canonicalizes casing even when a mixed-case input carries an
  // invalid checksum. Validate the original value first so a checksum typo is
  // rejected instead of silently rewritten into a different accepted string.
  if (!isAddress(trimmed)) return null;
  try {
    return getAddress(trimmed);
  } catch {
    return null;
  }
}

function emptyFileResult(issue: NftAssetInputIssue): ParseNftAssetFileResult {
  return {
    duplicates: 0,
    invalid: 0,
    issues: [issue],
    lines: [],
    rows: [],
    serialized: "",
    truncated: issue.code === "input-too-large",
    valid: 0
  };
}

/** Parses TXT/CSV data containing one `contract,tokenId` asset per row. */
export function parseNftAssetFile(
  text: string,
  options: ParseNftAssetFileOptions = {}
): ParseNftAssetFileResult {
  const maxItems = normalizeItemLimit(options.maxItems);
  if (text.length > MAX_INPUT_LENGTH) {
    return emptyFileResult(errorIssue("input-too-large", "NFT 资产文件过大，请拆分后重新导入"));
  }
  if (!text.trim()) {
    return emptyFileResult(errorIssue("empty-input", "文件中没有可导入的 NFT 资产"));
  }

  const issues: NftAssetInputIssue[] = [];
  const lines: string[] = [];
  const rows: NftAssetFileRow[] = [];
  const seen = new Map<string, number>();
  let duplicates = 0;
  let invalid = 0;
  let truncated = false;

  const sourceLines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (let index = 0; index < sourceLines.length; index += 1) {
    const line = index + 1;
    const source = sourceLines[index].trim();
    if (!source) continue;

    const fields = parseCsvFields(source);
    if (fields && rows.length === 0 && isHeader(fields)) {
      rows.push({
        contractAddress: null,
        line,
        problems: [],
        status: "header",
        tokenId: null
      });
      continue;
    }

    if (!fields || fields.length !== 2 || !fields[0] || !fields[1]) {
      const message = `第 ${line} 行格式不正确，应为 合约地址,Token ID`;
      issues.push(errorIssue("invalid-row", message, { line }));
      rows.push({
        contractAddress: null,
        line,
        problems: [message],
        status: "invalid",
        tokenId: null
      });
      invalid += 1;
      continue;
    }

    const contractAddress = normalizeContractAddress(fields[0]);
    const parsedTokenId = parseUint256(fields[1]);
    const problems: string[] = [];
    if (!contractAddress) problems.push("合约地址格式不正确");
    if (!parsedTokenId.ok) {
      problems.push(parsedTokenId.code === "token-id-out-of-range"
        ? "Token ID 超出 uint256 范围"
        : "Token ID 必须是非负十进制整数");
    }

    if (!contractAddress || !parsedTokenId.ok) {
      const message = `第 ${line} 行：${problems.join("；")}`;
      const issueCode: NftAssetInputIssueCode = !contractAddress
        ? "invalid-contract"
        : parsedTokenId.ok
          ? "invalid-row"
          : parsedTokenId.code;
      issues.push(errorIssue(
        issueCode,
        message,
        { line }
      ));
      rows.push({
        contractAddress,
        line,
        problems,
        status: "invalid",
        tokenId: parsedTokenId.ok ? parsedTokenId.value : null
      });
      invalid += 1;
      continue;
    }

    const key = `${contractAddress.toLowerCase()}:${parsedTokenId.value}`;
    const firstLine = seen.get(key);
    if (firstLine !== undefined) {
      const message = `与第 ${firstLine} 行的 NFT 资产重复`;
      issues.push({
        code: "duplicate-row",
        line,
        message: `第 ${line} 行${message}`,
        severity: "warning"
      });
      rows.push({
        contractAddress,
        line,
        problems: [message],
        status: "duplicate",
        tokenId: parsedTokenId.value
      });
      duplicates += 1;
      continue;
    }

    if (lines.length >= maxItems) {
      const message = `一次最多导入 ${maxItems} 个 NFT 资产，请拆分文件后重试`;
      issues.push(errorIssue("item-limit", message, { line }));
      rows.push({
        contractAddress,
        line,
        problems: [message],
        status: "invalid",
        tokenId: parsedTokenId.value
      });
      invalid += 1;
      truncated = true;
      break;
    }

    seen.set(key, line);
    lines.push(`${contractAddress},${parsedTokenId.value}`);
    rows.push({
      contractAddress,
      line,
      problems: [],
      status: "valid",
      tokenId: parsedTokenId.value
    });
  }

  return {
    duplicates,
    invalid,
    issues,
    lines,
    rows,
    serialized: lines.join("\n"),
    truncated,
    valid: lines.length
  };
}

/**
 * Appends one contract plus a Token ID expression to an existing NFT asset list.
 * The list is only changed when every new input is valid, preventing accidental
 * partial additions when a range contains a typo.
 */
export function mergeNftAssetInput(
  existing: string,
  contract: string,
  tokenExpression: string,
  options: MergeNftAssetInputOptions = {}
): MergeNftAssetInputResult {
  const maxItems = normalizeItemLimit(options.maxItems);
  const normalizedExisting = existing.trim();
  const existingResult = normalizedExisting
    ? parseNftAssetFile(normalizedExisting, { maxItems })
    : null;
  const existingLines = existingResult?.lines ?? [];
  const issues = [...(existingResult?.issues ?? [])];
  const hasExistingErrors = issues.some((issue) => issue.severity === "error");

  const contractAddress = normalizeContractAddress(contract);
  if (!contractAddress) {
    issues.push(errorIssue("invalid-contract", "请输入有效的 NFT 合约地址"));
  }

  const expanded = expandNftTokenIds(tokenExpression, { maxItems });
  issues.push(...expanded.issues);

  const unchangedLines = hasExistingErrors
    ? normalizedExisting.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : existingLines;
  const hasNewErrors = expanded.issues.some((issue) => issue.severity === "error")
    || !contractAddress;
  if (hasExistingErrors || hasNewErrors) {
    return {
      added: 0,
      duplicates: (existingResult?.duplicates ?? 0) + expanded.duplicates,
      issues,
      lines: unchangedLines,
      serialized: unchangedLines.join("\n"),
      truncated: Boolean(existingResult?.truncated || expanded.truncated)
    };
  }

  const seen = new Set(existingLines.map((line) => line.toLowerCase()));
  const addedLines: string[] = [];
  let duplicates = (existingResult?.duplicates ?? 0) + expanded.duplicates;
  for (const tokenId of expanded.tokenIds) {
    const line = `${contractAddress},${tokenId}`;
    const key = line.toLowerCase();
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    addedLines.push(line);
  }

  if (existingLines.length + addedLines.length > maxItems) {
    issues.push(errorIssue(
      "item-limit",
      `合并后最多保留 ${maxItems} 个 NFT 资产，请分批处理`
    ));
    return {
      added: 0,
      duplicates,
      issues,
      lines: existingLines,
      serialized: existingLines.join("\n"),
      truncated: true
    };
  }

  const lines = [...existingLines, ...addedLines];
  return {
    added: addedLines.length,
    duplicates,
    issues,
    lines,
    serialized: lines.join("\n"),
    truncated: Boolean(existingResult?.truncated || expanded.truncated)
  };
}
