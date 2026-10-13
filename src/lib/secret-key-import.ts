import { maximumCollectionSources } from "./collection-workload";
import { deriveEvmCollectionAddress } from "./evm-collection";
import { decodeBase58, parseSolanaSecretKeyLine } from "./sol-collection";
import { readWalletXlsxFile, WalletXlsxImportError } from "./wallet-xlsx-import";

export const maxSecretKeyFileBytes = 512 * 1024;
export const maxSecretKeyFileLines = maximumCollectionSources;
export type SecretKeyImportMode = "evm" | "solana";
export type SecretKeyImportFile = { name: string; size: number; text: () => Promise<string>; type: string; arrayBuffer?: () => Promise<ArrayBuffer> };
/** Sheet contents can include private keys and must only be held in DOM/ref. */
export type SecretKeyImportSheet = { name: string; text: string };
export type SecretKeyImportIssue = { line: number; message: string };
export type SecretKeyImportWallet = { address: string; id: string; label?: string; line: number };
/** Public metadata is safe for React state; `value`, `sourceValue` and `sheets` belong only in DOM/ref. */
export type SecretKeyImportPreview = {
  duplicates: number;
  format: string;
  issues: SecretKeyImportIssue[];
  lineCount: number;
  wallets: SecretKeyImportWallet[];
};
export type SecretKeyImportResult = SecretKeyImportPreview & {
  fileName: string;
  sourceValue: string;
  value: string;
  sheets?: SecretKeyImportSheet[];
};
export type SecretKeyTextImportResult = SecretKeyImportPreview & { value: string };

type SecretKeyImportErrorCode = "empty-file" | "invalid-content" | "invalid-type" | "read-failed" | "too-large" | "too-many-lines";
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
  tsv: new Set(["", "text/tab-separated-values", "text/plain"]),
  json: new Set(["", "application/json", "text/json", "text/plain"]),
  xlsx: new Set(["", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/octet-stream"]),
  txt: new Set(["", "text/plain"])
};
const secretHeaders = new Set(["privatekey", "secretkey", "privkey", "private", "secret", "key", "seed", "私钥", "密钥"]);
const addressHeaders = new Set(["address", "walletaddress", "publickey", "pubkey", "钱包地址", "地址", "公钥"]);
const labelHeaders = new Set(["label", "name", "remark", "remarks", "note", "notes", "walletname", "标签", "名称", "名字", "备注", "钱包名称"]);
const mnemonicHeaders = new Set(["mnemonic", "mnemonicphrase", "recoveryphrase", "seedphrase", "助记词"]);
const normalizeHeader = (value: string) => value.trim().toLowerCase().replace(/[\s_\-]/g, "");
const fileExtension = (name: string) => /\.([^.]+)$/.exec(name.trim().toLowerCase())?.[1] || "";
const normalizeText = (value: string) => value.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();

function safeFileName(name: string) {
  const normalized = name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  return normalized ? safeLabel(normalized) || "钱包文件" : "未命名文件";
}
function assertAllowedFile(file: Pick<SecretKeyImportFile, "name" | "size" | "type">) {
  const extension = fileExtension(file.name);
  if (!(extension in allowedFileTypes)) throw new SecretKeyImportError("invalid-type", "仅支持 TXT、CSV、TSV、JSON 或 XLSX 文件");
  if (!allowedFileTypes[extension as keyof typeof allowedFileTypes].has(file.type.trim().toLowerCase())) {
    throw new SecretKeyImportError("invalid-type", "文件类型与扩展名不匹配，请使用 TXT、CSV、TSV、JSON 或 XLSX 文件");
  }
  if (!Number.isSafeInteger(file.size) || file.size < 0) throw new SecretKeyImportError("invalid-content", "无法验证文件大小，请重新选择文件");
  if (file.size > maxSecretKeyFileBytes) throw new SecretKeyImportError("too-large", "文件不能超过 512 KB");
}
function assertContent(value: string) {
  if (value.length > maxSecretKeyFileBytes) throw new SecretKeyImportError("too-large", "文件不能超过 512 KB");
  if (value.includes("\0")) throw new SecretKeyImportError("invalid-content", "文件包含不支持的二进制内容");
}

/** Quoted cells and unquoted JSON arrays are both common in exported wallet lists. */
function splitCells(value: string, separator: string) {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"') {
      if (quoted && value[index + 1] === '"') { current += '"'; index += 1; }
      else quoted = !quoted;
    } else if (!quoted && character === "[") { depth += 1; current += character; }
    else if (!quoted && character === "]") { depth -= 1; current += character; }
    else if (!quoted && depth === 0 && character === separator) { cells.push(current.trim()); current = ""; }
    else current += character;
  }
  if (quoted || depth !== 0) return null;
  cells.push(current.trim());
  return cells;
}
function findDelimiter(line: string) {
  return ["\t", ",", ";", "|"].find((delimiter) => (splitCells(line, delimiter)?.length || 0) > 1);
}
function isByteArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255);
}
function normalizeKey(value: unknown, mode: SecretKeyImportMode) {
  if (mode === "solana" && isByteArray(value)) return JSON.stringify(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (mode === "evm" && /^[a-fA-F0-9]{64}$/.test(trimmed)) return `0x${trimmed}`;
  return trimmed;
}
function resemblesSecret(value: string, mode: SecretKeyImportMode, explicit: boolean) {
  if (mode === "evm") return /^(?:0x)?[a-fA-F0-9]{64}$/.test(value);
  if (value.startsWith("[")) return true;
  // A 32-byte Base58 value is also a public address. It needs an explicit key field.
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,88}$/.test(value)) return false;
  try {
    const bytes = decodeBase58(value);
    const supported = bytes.length === 64 || (explicit && bytes.length === 32);
    bytes.fill(0);
    return supported;
  } catch { return false; }
}
function safeLabel(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  // Do not let a mistaken label column put another secret into public metadata.
  if (/(?:0x)?[a-fA-F0-9]{64}|[1-9A-HJ-NP-Za-km-z]{32,}|\[\s*\d+\s*,|(?:\b[a-z]+\s+){11,}\b[a-z]+/u.test(value)) return undefined;
  return value.replace(/[\u0000-\u001f\u007f,]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || undefined;
}

type Candidate = { key?: unknown; label?: unknown; address?: unknown; line: number; explicit: boolean; issue?: string };
function objectCandidate(entry: Record<string, unknown>, line: number): Candidate {
  const keys = Object.keys(entry);
  const encrypted = keys.some((key) => ["crypto", "cryptography", "ciphertext"].includes(normalizeHeader(key)));
  if (encrypted) return { line, explicit: true, issue: "不支持加密 Keystore，请先在钱包中导出私钥" };
  const keypair = entry.keypair;
  if (keypair && typeof keypair === "object" && !Array.isArray(keypair)) {
    if (keys.some((key) => secretHeaders.has(normalizeHeader(key)))) return { line, explicit: true, issue: "包含多个密钥字段，请仅保留要导入的私钥字段" };
    const nested = objectCandidate(keypair as Record<string, unknown>, line);
    const labelKey = keys.find((key) => labelHeaders.has(normalizeHeader(key)));
    const addressKey = keys.find((key) => addressHeaders.has(normalizeHeader(key)));
    return { ...nested, label: labelKey ? entry[labelKey] : nested.label, address: addressKey ? entry[addressKey] : nested.address };
  }
  const keyNames = keys.filter((key) => secretHeaders.has(normalizeHeader(key)) || normalizeHeader(key) === "keypair");
  if (keys.filter((key) => addressHeaders.has(normalizeHeader(key))).length > 1) return { line, explicit: true, issue: "包含多个地址字段，请仅保留钱包地址字段" };
  if (keyNames.length > 1) return { line, explicit: true, issue: "包含多个密钥字段，请仅保留要导入的私钥字段" };
  if (!keyNames.length) {
    if (keys.some((key) => mnemonicHeaders.has(normalizeHeader(key)))) return { line, explicit: true, issue: "不支持助记词，请先在钱包中导出私钥" };
    return { line, explicit: true, issue: "没有找到私钥字段；钱包地址或公钥不能作为私钥导入" };
  }
  const addressKey = keys.find((key) => addressHeaders.has(normalizeHeader(key)));
  const labelKey = keys.find((key) => labelHeaders.has(normalizeHeader(key)));
  return { key: entry[keyNames[0]], label: labelKey ? entry[labelKey] : undefined, address: addressKey ? entry[addressKey] : undefined, line, explicit: true };
}
function jsonCandidates(raw: string, mode: SecretKeyImportMode): Candidate[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new SecretKeyImportError("invalid-content", "JSON 文件格式不正确，请检查逗号和引号"); }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    const wrapperKeys = Object.keys(record).filter((key) => ["wallets", "accounts", "keys", "data"].includes(normalizeHeader(key)) && Array.isArray(record[key]));
    if (wrapperKeys.length > 1 || (wrapperKeys.length && Object.keys(record).some((key) => secretHeaders.has(normalizeHeader(key)) || normalizeHeader(key) === "keypair"))) {
      throw new SecretKeyImportError("invalid-content", "JSON 中包含多个钱包清单或密钥来源，请仅保留要导入的清单");
    }
    if (wrapperKeys.length) parsed = record[wrapperKeys[0]];
  }
  const entries = isByteArray(parsed) || !Array.isArray(parsed) ? [parsed] : parsed;
  return entries.map((entry, index): Candidate => {
    const line = index + 1;
    if (typeof entry === "string") {
      const extracted = textCandidates(entry, mode).candidates;
      return extracted.length === 1 ? { ...extracted[0], line, explicit: true } : { line, explicit: true, issue: "一个 JSON 条目只能包含一个钱包私钥" };
    }
    if (isByteArray(entry)) return { key: entry, line, explicit: true };
    if (entry && typeof entry === "object" && !Array.isArray(entry)) return objectCandidate(entry as Record<string, unknown>, line);
    return { line, explicit: true, issue: "钱包条目应为私钥字符串、密钥字节数组或含私钥字段的对象" };
  });
}
function textCandidates(raw: string, mode: SecretKeyImportMode): { candidates: Candidate[]; format: string } {
  const lines = raw.split("\n").map((value, index) => ({ value: value.trim(), line: index + 1 })).filter((item) => item.value && !/^(?:#|\/\/)/u.test(item.value));
  if (!lines.length) return { candidates: [], format: "逐行私钥" };
  const delimiter = findDelimiter(lines[0].value);
  const first = splitCells(lines[0].value, delimiter || ",");
  const headers = first?.map(normalizeHeader) || [];
  const hasHeader = headers.some((header) => secretHeaders.has(header) || addressHeaders.has(header) || mnemonicHeaders.has(header));
  const keyIndices = headers.flatMap((header, index) => secretHeaders.has(header) ? [index] : []);
  const addressIndex = headers.findIndex((header) => addressHeaders.has(header));
  const labelIndex = headers.findIndex((header) => labelHeaders.has(header));
  const candidates = (hasHeader ? lines.slice(1) : lines).map(({ value, line }): Candidate => {
    const cells = splitCells(value, delimiter || ",");
    if (!cells) return { line, explicit: hasHeader, issue: "引号或密钥数组未闭合，请检查这一行" };
    if (hasHeader) {
      if (keyIndices.length !== 1) return { line, explicit: true, issue: keyIndices.length ? "包含多个私钥列，请仅保留要导入的私钥列" : headers.some((header) => mnemonicHeaders.has(header)) ? "不支持助记词，请先在钱包中导出私钥" : "没有找到私钥列；钱包地址或公钥不能作为私钥导入" };
      if (headers.filter((header) => addressHeaders.has(header)).length > 1) return { line, explicit: true, issue: "包含多个地址列，请仅保留钱包地址列" };
      if (cells.length !== headers.length) return { line, explicit: true, issue: "列数与表头不一致，请检查分隔符或引号" };
      return { key: cells[keyIndices[0]], address: addressIndex >= 0 ? cells[addressIndex] : undefined, label: labelIndex >= 0 ? cells[labelIndex] : undefined, line, explicit: true };
    }
    if (cells.length === 1) return { key: cells[0], line, explicit: false };
    const keyIndex = cells.findIndex((cell) => resemblesSecret(cell, mode, false));
    if (keyIndex < 0) return { line, explicit: false, issue: "未识别到私钥，请添加 private_key 表头或使用每行一个私钥" };
    if (cells.filter((cell) => resemblesSecret(cell, mode, false)).length > 1) return { line, explicit: false, issue: "这一行包含多个私钥，无法确定要导入哪一个" };
    const otherCells = cells.filter((_, index) => index !== keyIndex);
    const address = otherCells.find((cell) => mode === "evm" ? /^0x[a-fA-F0-9]{40}$/.test(cell) : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(cell));
    return { key: cells[keyIndex], address, label: otherCells.find((cell) => cell !== address), line, explicit: false };
  });
  const separator = delimiter === "\t" ? "TSV" : delimiter ? "CSV" : "逐行私钥";
  return { candidates, format: hasHeader ? `${separator} · 自动识别私钥列` : separator };
}

/** Parse exported formats locally. Never return signing accounts or raw input in preview metadata. */
export function analyzeSecretKeyText(rawText: string, mode: SecretKeyImportMode, formatHint?: string): SecretKeyTextImportResult {
  assertContent(rawText);
  const raw = normalizeText(rawText);
  let candidates: Candidate[];
  let format: string;
  const looksJson = formatHint !== "xlsx" && (formatHint === "json" || /^"(?:[^"\\]|\\.)*"$/u.test(raw) || raw.startsWith("{") || /^\[\s*(?:\{|"|\[|\d)/u.test(raw) && !raw.includes("\n["));
  if (looksJson) {
    try { candidates = jsonCandidates(raw, mode); format = "JSON · 自动识别钱包条目"; }
    catch (error) {
      // Newline-separated Solana arrays are a supported plain-text format.
      if (formatHint === "json" || !raw.split("\n").every((line) => !line.trim() || line.trim().startsWith("["))) throw error;
      ({ candidates, format } = textCandidates(raw, mode));
    }
  } else ({ candidates, format } = textCandidates(raw, mode));
  if (formatHint === "xlsx") format = format.includes("自动识别私钥列") ? "XLSX · 自动识别私钥列" : "XLSX";
  if (!candidates.length) throw new SecretKeyImportError("empty-file", "文件中没有可导入的密钥");
  if (candidates.length > maxSecretKeyFileLines) throw new SecretKeyImportError("too-many-lines", `单次最多导入 ${maxSecretKeyFileLines.toLocaleString("en-US")} 条密钥`);
  const wallets: SecretKeyImportWallet[] = [];
  const issues: SecretKeyImportIssue[] = [];
  const lines: string[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (const candidate of candidates) {
    const issue = (message: string) => issues.push({ line: candidate.line, message });
    if (candidate.issue) { issue(candidate.issue); continue; }
    const key = normalizeKey(candidate.key, mode);
    if (!key) { issue("私钥为空或格式不正确"); continue; }
    if (/^(?:[a-z]+\s+){11,}[a-z]+$/iu.test(key)) { issue("不支持助记词，请先在钱包中导出私钥"); continue; }
    if (!resemblesSecret(key, mode, candidate.explicit)) { issue(mode === "solana" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(key) ? "这是钱包地址或 32 字节种子；种子需使用明确的 secret_key 字段或 JSON 字节数组" : "私钥无效或无法派生地址"); continue; }
    try {
      const address = mode === "evm" ? deriveEvmCollectionAddress(key) : parseSolanaSecretKeyLine(key).address;
      const expected = typeof candidate.address === "string" ? candidate.address.trim() : candidate.address;
      if (expected !== undefined && expected !== "" && (typeof expected !== "string" || (mode === "evm" ? expected.toLowerCase() !== address.toLowerCase() : expected !== address))) {
        issue("地址列与私钥派生的钱包地址不一致，请核对这一行");
        continue;
      }
      const id = mode === "evm" ? address.toLowerCase() : address;
      if (seen.has(id)) { duplicates += 1; continue; }
      seen.add(id);
      const label = safeLabel(candidate.label);
      wallets.push({ address, id, line: candidate.line, ...(label ? { label } : {}) });
      lines.push(label ? `${label},${key}` : key);
    } catch { issue("私钥无效或无法派生地址"); }
  }
  return { duplicates, format, issues, lineCount: candidates.length, wallets, value: lines.join("\n") };
}

export async function readSecretKeyFile(file: SecretKeyImportFile, mode: SecretKeyImportMode): Promise<SecretKeyImportResult> {
  assertAllowedFile(file);
  if (fileExtension(file.name) === "xlsx") {
    if (!file.arrayBuffer) throw new SecretKeyImportError("read-failed", "无法读取 Excel 文件，请重新选择文件");
    let sheets: SecretKeyImportSheet[];
    try { sheets = await readWalletXlsxFile({ size: file.size, arrayBuffer: () => file.arrayBuffer!() }, maxSecretKeyFileLines + 1); }
    catch (error) {
      if (error instanceof WalletXlsxImportError) {
        const code = error.code === "too-large" ? "too-large" : error.code === "read-failed" ? "read-failed" : error.code === "too-many-rows" ? "too-many-lines" : error.code === "empty-file" ? "empty-file" : "invalid-content";
        throw new SecretKeyImportError(code, error.message);
      }
      throw new SecretKeyImportError("invalid-content", "无法读取 Excel 文件，请检查文件格式、工作表内容和行数后重试");
    }
    if (!sheets.length) throw new SecretKeyImportError("empty-file", "Excel 文件中没有非空工作表");
    // Keep the sheet selector available even when the first sheet cannot be imported.
    let analysis: SecretKeyTextImportResult;
    try { analysis = analyzeSecretKeyText(sheets[0].text, mode, "xlsx"); }
    catch (error) {
      analysis = { duplicates: 0, format: "XLSX", issues: [{ line: 1, message: error instanceof SecretKeyImportError ? error.message : "工作表内容无法识别" }], lineCount: 0, wallets: [], value: "" };
    }
    return { ...analysis, fileName: safeFileName(file.name), sourceValue: sheets[0].text, sheets };
  }
  let rawText: string;
  try { rawText = await file.text(); }
  catch { throw new SecretKeyImportError("read-failed", "无法读取文件，请确认文件可访问后重试"); }
  try {
    const analysis = analyzeSecretKeyText(rawText, mode, fileExtension(file.name) === "json" ? "json" : undefined);
    return { ...analysis, fileName: safeFileName(file.name), sourceValue: normalizeText(rawText) };
  } catch (error) {
    if (error instanceof SecretKeyImportError) throw error;
    throw new SecretKeyImportError("invalid-content", "文件内容无法解析，请检查格式后重试");
  } finally { rawText = ""; }
}
