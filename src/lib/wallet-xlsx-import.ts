export const maxWalletXlsxFileBytes = 512 * 1024;

/** `text` can contain private keys and belongs only in a transient ref or DOM input. */
export type WalletXlsxSheet = { name: string; text: string };
export type WalletXlsxFile = { size: number; arrayBuffer: () => Promise<ArrayBuffer> };

type WalletXlsxImportErrorCode = "too-large" | "read-failed" | "invalid-file" | "too-many-rows" | "too-many-columns" | "too-large-content" | "formula" | "unsupported-cell" | "empty-file";

export class WalletXlsxImportError extends Error {
  readonly code: WalletXlsxImportErrorCode;
  constructor(code: WalletXlsxImportErrorCode, message: string) {
    super(message);
    this.name = "WalletXlsxImportError";
    this.code = code;
  }
}

const maxExpandedBytes = 8 * 1024 * 1024;
const maxArchiveEntries = 256;
const maxSheets = 20;
const maxColumns = 64;
const maxCellCharacters = 4096;
const invalidFileMessage = "无法读取 XLSX 文件，请确认文件未损坏或加密，并以 XLSX 格式重新保存";
const contentLimitMessage = "表格内容过大，请仅保留要导入的钱包列和行后重试";
const invalidFile = () => new WalletXlsxImportError("invalid-file", invalidFileMessage);
const contentLimit = () => new WalletXlsxImportError("too-large-content", contentLimitMessage);
const rowLimit = (maxRows: number) => new WalletXlsxImportError("too-many-rows", `工作表最多支持 ${maxRows.toLocaleString("en-US")} 行（含表头），请拆分文件后导入`);
type ExactXlsxNumber = { exactNumber: string };
const walletTextHeaders = new Set(["privatekey", "secretkey", "privkey", "private", "secret", "key", "seed", "私钥", "密钥", "address", "recipient", "recipientaddress", "to", "toaddress", "wallet", "walletaddress", "publickey", "pubkey", "publicaddress", "地址", "收款地址", "收款钱包", "钱包地址", "公钥"]);
const normalizeHeader = (value: string) => value.trim().toLowerCase().replace(/[\s_-]/gu, "");
const walletCellMessage = "钱包地址或私钥列使用了数字或日期格式，请在原始文件中将这些单元格保存为文本后导入";

type ZipEntry = { size: number; method: number; compressedSize: number };

/** Check advertised sizes before any decompressor allocates output buffers. */
function readZipDirectory(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 22 || view.getUint32(0, true) !== 0x04034b50) throw invalidFile();
  let end = bytes.length - 22;
  const minimumEnd = Math.max(0, end - 65535);
  for (; end >= minimumEnd; end -= 1) {
    if (view.getUint32(end, true) === 0x06054b50 && end + 22 + view.getUint16(end + 20, true) === bytes.length) break;
  }
  if (end < minimumEnd || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw invalidFile();
  const count = view.getUint16(end + 10, true);
  if (!count || count !== view.getUint16(end + 8, true) || count > maxArchiveEntries) throw contentLimit();
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (directoryOffset + directorySize !== end) throw invalidFile();
  const entries = new Map<string, ZipEntry>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let position = directoryOffset;
  let expandedSize = 0;
  for (let index = 0; index < count; index += 1) {
    if (position + 46 > end || view.getUint32(position, true) !== 0x02014b50) throw invalidFile();
    const flags = view.getUint16(position + 8, true);
    const method = view.getUint16(position + 10, true);
    const compressedSize = view.getUint32(position + 20, true);
    const size = view.getUint32(position + 24, true);
    const nameLength = view.getUint16(position + 28, true);
    const extraLength = view.getUint16(position + 30, true);
    const commentLength = view.getUint16(position + 32, true);
    const localOffset = view.getUint32(position + 42, true);
    const next = position + 46 + nameLength + extraLength + commentLength;
    if (next > end || flags & 0x41 || ![0, 8].includes(method) || view.getUint16(position + 34, true)) throw invalidFile();
    if (size === 0xffffffff || compressedSize === 0xffffffff || size > maxExpandedBytes) throw contentLimit();
    expandedSize += size;
    if (expandedSize > maxExpandedBytes) throw contentLimit();
    const name = decoder.decode(bytes.subarray(position + 46, position + 46 + nameLength));
    if (!name || name.length > 240 || /[\u0000-\u001f\\]/u.test(name) || name.startsWith("/") || name.split("/").includes("..") || entries.has(name)) throw invalidFile();
    if (localOffset + 30 > directoryOffset || view.getUint32(localOffset, true) !== 0x04034b50) throw invalidFile();
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > directoryOffset || view.getUint16(localOffset + 6, true) !== flags || view.getUint16(localOffset + 8, true) !== method) throw invalidFile();
    if (decoder.decode(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength)) !== name) throw invalidFile();
    entries.set(name, { size, method, compressedSize });
    position = next;
  }
  if (position !== end || !entries.has("xl/workbook.xml") || !entries.has("xl/_rels/workbook.xml.rels")) throw invalidFile();
  return entries;
}

function readXmlAttribute(tag: string, attribute: string) {
  const expression = new RegExp(`(?:^|\\s)${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "u");
  const match = expression.exec(tag);
  return match ? match[1] ?? match[2] : undefined;
}

/** Reject formulas and sparse coordinates before the XLSX parser fills array gaps. */
function inspectXml(content: string, maxRows: number) {
  if (/<!DOCTYPE|<!ENTITY/iu.test(content)) throw invalidFile();
  if (/<(?:[\w.-]+:)?workbook(?:\s|>)/u.test(content) && [...content.matchAll(/<(?:[\w.-]+:)?sheet(?=\s|\/|>)[^>]*>/gu)].length > maxSheets) {
    throw new WalletXlsxImportError("too-large-content", "工作表数量过多，请保留最多 20 个工作表后导入");
  }
  if (!/<(?:[\w.-]+:)?worksheet(?:\s|>)/u.test(content)) return;
  if (/<(?:[\w.-]+:)?f(?:\s|\/|>)/u.test(content)) {
    throw new WalletXlsxImportError("formula", "工作表含公式单元格，请在 Excel 中复制并粘贴为数值后导入");
  }
  let rowCount = 0;
  for (const match of content.matchAll(/<(?:[\w.-]+:)?row(?=\s|\/|>)[^>]*>/gu)) {
    rowCount += 1;
    const row = readXmlAttribute(match[0], "r");
    if (rowCount > maxRows || row !== undefined && (!/^\d{1,7}$/u.test(row) || Number(row) > maxRows)) throw rowLimit(maxRows);
  }
  let cellCount = 0;
  for (const match of content.matchAll(/<(?:[\w.-]+:)?c(?=\s|\/|>)[^>]*>/gu)) {
    cellCount += 1;
    if (cellCount > maxRows * maxColumns) throw contentLimit();
    const address = readXmlAttribute(match[0], "r");
    if (address === undefined) continue;
    const coordinate = /^([A-Z]{1,3})([1-9]\d{0,6})$/u.exec(address);
    if (!coordinate) throw invalidFile();
    if (Number(coordinate[2]) > maxRows) throw rowLimit(maxRows);
    let column = 0;
    for (const letter of coordinate[1]) column = column * 26 + letter.charCodeAt(0) - 64;
    if (column > maxColumns) throw new WalletXlsxImportError("too-many-columns", "工作表最多支持 64 列，请仅保留要导入的钱包列");
  }
}

/** Small input chunks keep forged ZIP sizes from causing an unbounded inflation. */
async function inspectArchive(bytes: Uint8Array, maxRows: number) {
  const entries = readZipDirectory(bytes);
  const { Unzip, UnzipInflate } = await import("fflate");
  let expandedSize = 0;
  const seen = new Set<string>();
  const completed = new Set<string>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const streams: Array<{ terminate: () => void }> = [];
  const unzip = new Unzip((file) => {
    const entry = entries.get(file.name);
    if (!entry || seen.has(file.name) || entry.method !== file.compression || file.originalSize !== undefined && file.originalSize !== entry.size || file.size !== undefined && file.size !== entry.compressedSize) throw invalidFile();
    seen.add(file.name);
    streams.push(file);
    const chunks: Uint8Array[] = [];
    let size = 0;
    const isXml = /\.(?:xml|rels)$/u.test(file.name);
    file.ondata = (error, chunk, final) => {
      // fflate catches an exception raised by our output callback and sends it
      // through ondata again; retain our safe, actionable validation message.
      if (error) throw error instanceof WalletXlsxImportError ? error : invalidFile();
      size += chunk.length;
      expandedSize += chunk.length;
      if (size > entry.size || expandedSize > maxExpandedBytes) throw contentLimit();
      if (isXml) chunks.push(chunk);
      if (final) {
        if (size !== entry.size) throw invalidFile();
        completed.add(file.name);
        if (isXml) {
          const xml = new Uint8Array(size);
          let position = 0;
          for (const part of chunks) { xml.set(part, position); position += part.length; }
          try { inspectXml(decoder.decode(xml), maxRows); }
          // ZIP STORE can return slices of the original archive, which is read again below.
          finally { xml.fill(0); chunks.length = 0; }
        }
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    for (let position = 0; position < bytes.length; position += 512) {
      unzip.push(bytes.subarray(position, position + 512), position + 512 >= bytes.length);
    }
    if (seen.size !== entries.size || completed.size !== entries.size) throw invalidFile();
  } finally { streams.forEach(file => file.terminate()); }
}

/** Expand scientific notation with digit strings, never floating point arithmetic. */
function exactDecimal(value: string) {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/u.exec(value);
  if (!match || value.length > 160) throw new WalletXlsxImportError("unsupported-cell", "表格中的数值格式不受支持，请改为普通十进制数字或文本后导入");
  if (match[4] === undefined) return value.startsWith("+") ? value.slice(1) : value;
  if (match[4].length > 6) throw contentLimit();
  const sign = match[1] === "-" ? "-" : "";
  const digits = match[2] + (match[3] || "");
  const decimalAt = match[2].length + Number(match[4]);
  if (Math.abs(decimalAt) > 160 || digits.length > 160) throw contentLimit();
  const result = decimalAt <= 0 ? `0.${"0".repeat(-decimalAt)}${digits}`
    : decimalAt >= digits.length ? `${digits}${"0".repeat(decimalAt - digits.length)}`
    : `${digits.slice(0, decimalAt)}.${digits.slice(decimalAt)}`;
  if (result.length + sign.length > 160) throw contentLimit();
  return sign + result;
}

function safeSheetName(value: string, index: number) {
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/gu, " ").replace(/\s+/gu, " ").trim();
  const secretLike = /(?:0x)?[a-fA-F0-9]{64}|[1-9A-HJ-NP-Za-km-z]{32,}|\[\s*\d+\s*,|(?:\b[a-z]+\s+){11,}\b[a-z]+/u;
  return clean && !secretLike.test(clean) ? clean.slice(0, 80) : `工作表 ${index + 1}`;
}

function csvCell(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && "exactNumber" in value && typeof value.exactNumber === "string") value = value.exactNumber;
  if (value instanceof Date && !Number.isNaN(value.getTime())) value = value.toISOString();
  if (typeof value !== "string" && typeof value !== "boolean") throw new WalletXlsxImportError("unsupported-cell", "工作表含不支持的单元格，请将钱包列改为文本或普通数字后导入");
  if (String(value).length > maxCellCharacters) throw contentLimit();
  // Keep a separating space so split secrets remain invalid while multiline notes and
  // Solana JSON byte arrays can be consumed by the same single-record CSV parser.
  const text = String(value).replace(/[\r\n]+/gu, " ");
  if (/\u0000/u.test(text)) throw new WalletXlsxImportError("unsupported-cell", "工作表含不支持的特殊字符，请清理钱包列后导入");
  return /[",]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

/** Read every nonempty worksheet; the caller lets the user choose a sheet. */
export async function readWalletXlsxFile(file: WalletXlsxFile, maxRows: number): Promise<WalletXlsxSheet[]> {
  if (!Number.isSafeInteger(file.size) || file.size < 0 || !Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 10001) throw invalidFile();
  if (file.size > maxWalletXlsxFileBytes) throw new WalletXlsxImportError("too-large", "文件不能超过 512 KB");
  let buffer: ArrayBuffer;
  try { buffer = await file.arrayBuffer(); }
  catch { throw new WalletXlsxImportError("read-failed", "无法读取文件，请确认文件可访问后重试"); }
  try {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== file.size) throw invalidFile();
    await inspectArchive(new Uint8Array(buffer), maxRows);
    const { default: readExcelFile } = await import("read-excel-file/universal");
    const sheets = await readExcelFile<ExactXlsxNumber>(buffer, { parseNumber: value => ({ exactNumber: exactDecimal(value) }), trim: false });
    if (sheets.length > maxSheets) throw new WalletXlsxImportError("too-large-content", "工作表数量过多，请保留最多 20 个工作表后导入");
    const output: WalletXlsxSheet[] = [];
    for (const [index, sheet] of sheets.entries()) {
      if (sheet.data.length > maxRows) throw rowLimit(maxRows);
      const firstRow = sheet.data.find(row => row.some(value => value !== null && value !== undefined && value !== ""));
      const textColumns = new Set(firstRow?.flatMap((value, column) => typeof value === "string" && walletTextHeaders.has(normalizeHeader(value)) ? [column] : []) || []);
      const text = sheet.data.map((row) => {
        if (row.length > maxColumns) throw new WalletXlsxImportError("too-many-columns", "工作表最多支持 64 列，请仅保留要导入的钱包列");
        if (row.every(value => value === null || value === undefined || value === "")) return "";
        return row.map((value, column) => {
          if (textColumns.has(column) && value !== null && value !== undefined && typeof value !== "string") {
            throw new WalletXlsxImportError("unsupported-cell", walletCellMessage);
          }
          return csvCell(value);
        }).join(",");
      }).join("\n");
      if (text.length > maxWalletXlsxFileBytes) throw contentLimit();
      if (text.trim()) output.push({ name: safeSheetName(sheet.sheet, index), text });
    }
    if (!output.length) throw new WalletXlsxImportError("empty-file", "文件中没有可导入的钱包内容");
    return output;
  } catch (error) {
    if (error instanceof WalletXlsxImportError) throw error;
    throw invalidFile();
  }
}
