import { maximumCollectionSources } from "./collection-workload";

export const maxSecretKeyFileBytes = 512 * 1024;
export const maxSecretKeyFileLines = maximumCollectionSources;

export type SecretKeyImportMode = "evm" | "solana";

export type SecretKeyImportFile = {
  name: string;
  size: number;
  text: () => Promise<string>;
  type: string;
};

export type SecretKeyImportResult = {
  fileName: string;
  lineCount: number;
  value: string;
};

type SecretKeyImportErrorCode =
  | "empty-file"
  | "invalid-content"
  | "invalid-type"
  | "read-failed"
  | "too-large"
  | "too-many-lines";

export class SecretKeyImportError extends Error {
  readonly code: SecretKeyImportErrorCode;

  constructor(code: SecretKeyImportErrorCode, message: string) {
    super(message);
    this.name = "SecretKeyImportError";
    this.code = code;
  }
}

const allowedFileTypes = {
  csv: new Set(["", "application/csv", "application/vnd.ms-excel", "text/csv", "text/plain"]),
  json: new Set(["", "application/json", "text/json", "text/plain"]),
  txt: new Set(["", "text/plain"])
} as const;

function getFileExtension(name: string) {
  const match = /\.([^.]+)$/.exec(name.trim().toLowerCase());
  return match?.[1] || "";
}

function getSafeFileName(name: string) {
  const normalized = name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return normalized.slice(0, 120) || "未命名文件";
}

function assertAllowedFile(file: Pick<SecretKeyImportFile, "name" | "size" | "type">) {
  const extension = getFileExtension(file.name);
  if (!(extension in allowedFileTypes)) {
    throw new SecretKeyImportError("invalid-type", "仅支持 TXT、CSV 或 JSON 文件");
  }

  const acceptedTypes = allowedFileTypes[extension as keyof typeof allowedFileTypes];
  if (!acceptedTypes.has(file.type.trim().toLowerCase())) {
    throw new SecretKeyImportError("invalid-type", "文件类型与扩展名不匹配，请使用 TXT、CSV 或 JSON 文件");
  }

  if (!Number.isSafeInteger(file.size) || file.size < 0) {
    throw new SecretKeyImportError("invalid-content", "无法验证文件大小，请重新选择文件");
  }
  if (file.size > maxSecretKeyFileBytes) {
    throw new SecretKeyImportError("too-large", "文件不能超过 512 KB");
  }
}

function normalizePlainText(value: string) {
  return value
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

function normalizeJsonEntry(entry: unknown, mode: SecretKeyImportMode) {
  if (typeof entry === "string") return entry.trim();

  if (
    mode === "solana"
    && Array.isArray(entry)
    && entry.length > 0
    && entry.every((byte) => Number.isInteger(byte) && Number(byte) >= 0 && Number(byte) <= 255)
  ) {
    return JSON.stringify(entry);
  }

  throw new SecretKeyImportError(
    "invalid-content",
    mode === "solana"
      ? "JSON 仅支持单个字节数组，或由 Base58 / 字节数组组成的列表"
      : "JSON 仅支持私钥字符串或私钥字符串列表，不支持 Keystore 文件"
  );
}

function normalizeJsonText(value: string, mode: SecretKeyImportMode) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new SecretKeyImportError("invalid-content", "JSON 文件格式不正确");
  }

  if (typeof parsed === "string") return normalizeJsonEntry(parsed, mode);

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new SecretKeyImportError(
      "invalid-content",
      mode === "solana"
        ? "JSON 仅支持单个字节数组，或由 Base58 / 字节数组组成的列表"
        : "JSON 仅支持私钥字符串或私钥字符串列表，不支持 Keystore 文件"
    );
  }

  // A numeric array is one Solana key; every other array is treated as a list
  // of source keys. Unsupported objects are rejected without being stringified
  // into an error, so secret material cannot leak through diagnostics.
  if (mode === "solana" && parsed.every((value) => typeof value === "number")) {
    return normalizeJsonEntry(parsed, mode);
  }

  if (parsed.length > maxSecretKeyFileLines) {
    throw new SecretKeyImportError(
      "too-many-lines",
      `单次最多导入 ${maxSecretKeyFileLines.toLocaleString("en-US")} 条密钥`
    );
  }

  return parsed.map((entry) => normalizeJsonEntry(entry, mode)).filter(Boolean).join("\n");
}

function countNonEmptyLines(value: string) {
  let count = 0;
  let lineHasContent = false;
  for (let index = 0; index <= value.length; index += 1) {
    const character = value[index];
    if (index === value.length || character === "\n") {
      if (lineHasContent) {
        count += 1;
        if (count > maxSecretKeyFileLines) return count;
      }
      lineHasContent = false;
    } else if (!/\s/u.test(character)) {
      lineHasContent = true;
    }
  }
  return count;
}

export async function readSecretKeyFile(
  file: SecretKeyImportFile,
  mode: SecretKeyImportMode
): Promise<SecretKeyImportResult> {
  assertAllowedFile(file);

  let rawText: string;
  try {
    rawText = await file.text();
  } catch {
    throw new SecretKeyImportError("read-failed", "无法读取文件，请确认文件可访问后重试");
  }

  try {
    if (rawText.length > maxSecretKeyFileBytes || rawText.includes("\0")) {
      throw new SecretKeyImportError(
        "invalid-content",
        rawText.length > maxSecretKeyFileBytes ? "文件不能超过 512 KB" : "文件包含不支持的二进制内容"
      );
    }

    const extension = getFileExtension(file.name);
    const value = extension === "json"
      ? normalizeJsonText(rawText.replace(/^\uFEFF/, ""), mode)
      : normalizePlainText(rawText);
    const lineCount = countNonEmptyLines(value);

    if (lineCount === 0) throw new SecretKeyImportError("empty-file", "文件中没有可导入的密钥");
    if (lineCount > maxSecretKeyFileLines) {
      throw new SecretKeyImportError(
        "too-many-lines",
        `单次最多导入 ${maxSecretKeyFileLines.toLocaleString("en-US")} 条密钥`
      );
    }

    return {
      fileName: getSafeFileName(file.name),
      lineCount,
      value
    };
  } catch (error) {
    if (error instanceof SecretKeyImportError) throw error;
    throw new SecretKeyImportError("invalid-content", "文件内容无法解析，请检查格式后重试");
  } finally {
    // Release the local raw-text reference as soon as normalization completes.
    rawText = "";
  }
}
