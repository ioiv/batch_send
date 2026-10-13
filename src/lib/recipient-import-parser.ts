import { getDuplicateAddressKey, getListAddressKind, type AddressKind } from "./address";

export type RecipientImportOptions = { addressKind?: AddressKind; maxRows?: number };
type ImportIssue = { line: number; message: string };
type SourceRecord = { fields: string[] | null; line: number };
type RecipientRow = { address: string; amount?: string; line: number };

const addressHeaders = new Set(["address", "recipient", "recipientaddress", "to", "toaddress", "wallet", "walletaddress", "publickey", "publicaddress", "地址", "收款地址", "收款钱包", "钱包地址", "公钥"]);
const amountHeaders = new Set(["amount", "value", "quantity", "数量", "金额", "发送金额", "分发金额"]);
const ancillaryHeaders = new Set(["name", "label", "备注", "名称", "标签", "index", "序号", "id", "privatekey", "secretkey", "私钥", "secret", "key", "balance", "余额"]);
const collectionHeaders = new Set(["wallets", "recipients", "accounts", "addresses", "data", "list"]);
const decimalPattern = /^\d+(?:\.\d*)?$/;
const exactNumberKey = "__chainkit_exact_json_number__";
const normalizeHeader = (value: string) => value.trim().toLowerCase().replace(/[\s_-]/gu, "");

function delimiterFor(text: string) {
  const counts = new Map([[",", 0], ["\t", 0], [";", 0]]);
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && character === "\n") break;
    else if (!quoted && counts.has(character)) counts.set(character, counts.get(character)! + 1);
  }
  return [...counts].sort((left, right) => right[1] - left[1])[0]?.[1]
    ? [...counts].sort((left, right) => right[1] - left[1])[0][0]
    : "";
}

/** Keeps quoted newlines within one record, including spreadsheet exports. */
function readDelimitedRecords(text: string, delimiter: string): SourceRecord[] {
  const records: SourceRecord[] = [];
  let fields: string[] = [];
  let field = "";
  let quoted = false;
  let quoteClosed = false;
  let malformed = false;
  let line = 1;
  let recordLine = 1;
  const finishField = () => { fields.push(field.trim()); field = ""; quoteClosed = false; };
  const finishRecord = () => {
    finishField();
    if (fields.some(Boolean) || malformed) records.push({ fields: malformed ? null : fields, line: recordLine });
    fields = []; malformed = false;
  };
  for (let index = 0; index <= text.length; index += 1) {
    const character = text[index];
    if (character === undefined) {
      if (quoted) malformed = true;
      finishRecord(); break;
    }
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 1; }
        else { quoted = false; quoteClosed = true; }
      } else { field += character; if (character === "\n") line += 1; }
      continue;
    }
    if (character === '"') {
      if (field.trim() || quoteClosed) malformed = true;
      else quoted = true;
    } else if (delimiter && character === delimiter) finishField();
    else if (character === "\n") { finishRecord(); line += 1; recordLine = line; }
    else {
      if (quoteClosed && character.trim()) malformed = true;
      field += character;
    }
  }
  return records;
}

/** Keep numeric tokens distinct from strings, without rounding their value. */
function parseJsonWithExactNumbers(text: string): unknown {
  let rewritten = "";
  for (let index = 0; index < text.length;) {
    if (text[index] === '"') {
      const start = index++;
      while (index < text.length) {
        if (text[index] === "\\") { index += 2; continue; }
        if (text[index++] === '"') break;
      }
      rewritten += text.slice(start, index);
    } else if (/[\d-]/u.test(text[index])) {
      const match = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u);
      if (!match) throw new Error("JSON 格式不正确");
      rewritten += JSON.stringify({ [exactNumberKey]: match[0] }); index += match[0].length;
    } else rewritten += text[index++];
  }
  return JSON.parse(rewritten);
}

function exactJsonAmount(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    if (Object.keys(object).length === 1 && typeof object[exactNumberKey] === "string") return object[exactNumberKey];
  }
  return value;
}

function canonicalAmount(amount: string | undefined) {
  if (amount === undefined) return "";
  if (!decimalPattern.test(amount)) return amount;
  const [whole, fraction = ""] = amount.split(".");
  return `${whole.replace(/^0+(?=\d)/u, "")}.${fraction.replace(/0+$/u, "")}`;
}

export function parseRecipientImport(text: string, options: RecipientImportOptions, maxRows: number) {
  const issues: ImportIssue[] = [];
  const rows: RecipientRow[] = [];
  const detectedColumns: string[] = [];
  let sourceRows = 0;
  let invalidRows = 0;
  let format = "TXT";
  let jsonAmountColumn = false;
  const report = (line: number, message: string) => { invalidRows += 1; issues.push({ line, message }); };
  const addRow = (address: unknown, amount: unknown, line: number, hasAmount: boolean) => {
    if (typeof address !== "string" || !getListAddressKind(address.trim())
      || options.addressKind && getListAddressKind(address.trim()) !== options.addressKind) {
      report(line, "地址无效或与当前网络不匹配"); return;
    }
    if (hasAmount && (typeof amount !== "string" || !amount.trim())) {
      report(line, "金额缺失，请补齐金额后导入"); return;
    }
    if (hasAmount && (String(amount).trim().length > 160 || !decimalPattern.test(String(amount).trim()))) {
      report(line, "金额格式不正确，请填写普通十进制数字"); return;
    }
    rows.push({ address: address.trim(), ...(hasAmount ? { amount: String(amount).trim() } : {}), line });
  };
  const fromFields = (fields: string[] | null, line: number) => {
    if (!fields) { report(line, "列分隔或引号不正确"); return; }
    if (fields.length === 1) {
      const value = fields[0];
      const words = value.split(/\s+/u);
      if (words.length > 1 && words.some(word => getListAddressKind(word))) { fromFields(words, line); return; }
      addRow(value, undefined, line, false); return;
    }
    const addressIndexes = fields.flatMap((field, index) => getListAddressKind(field) ? [index] : []);
    if (addressIndexes.length !== 1) { report(line, addressIndexes.length > 1 ? "存在多个地址，请用列名指定收款地址" : "没有识别到有效的收款地址"); return; }
    const addressIndex = addressIndexes[0];
    if (fields.length === 2 && addressIndex === 0) { addRow(fields[0], fields[1], line, true); return; }
    const others = fields.filter((_, index) => index !== addressIndex);
    if (others.some(field => decimalPattern.test(field))) { report(line, "金额或序号列不明确，请增加 address、amount 列名"); return; }
    addRow(fields[addressIndex], undefined, line, false);
  };

  const trimmed = text.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").trim();
  if (trimmed.includes("\0") || trimmed.includes("\uFFFD")) throw new Error("文件包含无法识别的内容，请使用 UTF-8 文本文件");
  if (/^[\[{]/u.test(trimmed) || /^"(?:[^"\\]|\\.)*"$/u.test(trimmed)) {
    format = "JSON";
    let json: unknown;
    try { json = parseJsonWithExactNumbers(trimmed); }
    catch { throw new Error("JSON 格式不正确，请检查文件后重试"); }
    if (json && typeof json === "object" && !Array.isArray(json)) {
      const object = json as Record<string, unknown>;
      const containers = Object.keys(object).filter(key => collectionHeaders.has(normalizeHeader(key)));
      if (containers.length > 1) throw new Error("JSON 中有多个钱包清单，请只保留一个清单");
      if (containers.length === 1) json = object[containers[0]];
    }
    const entries = Array.isArray(json) ? json : [json];
    sourceRows = entries.length;
    entries.slice(0, maxRows).forEach((entry, index) => {
      const line = index + 1;
      if (typeof entry === "string") { fromFields([entry.trim()], line); return; }
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) { report(line, "需要地址字符串或包含 address 的钱包对象"); return; }
      const object = entry as Record<string, unknown>;
      const keys = Object.keys(object);
      const addressKeys = keys.filter(key => addressHeaders.has(normalizeHeader(key)));
      const amountKeys = keys.filter(key => amountHeaders.has(normalizeHeader(key)));
      if (addressKeys.length !== 1 || amountKeys.length > 1) { report(line, "地址或金额字段不明确，请各保留一个字段"); return; }
      if (!detectedColumns.includes("收款地址")) detectedColumns.push("收款地址");
      if (amountKeys.length && !detectedColumns.includes("金额")) detectedColumns.push("金额");
      jsonAmountColumn ||= amountKeys.length > 0;
      addRow(object[addressKeys[0]], amountKeys.length ? exactJsonAmount(object[amountKeys[0]]) : undefined, line, amountKeys.length > 0);
    });
  } else {
    const meaningful = trimmed.split("\n").filter(line => !/^\s*(?:#|\/\/)/u.test(line)).join("\n");
    const delimiter = delimiterFor(meaningful);
    format = delimiter === "\t" ? "TSV" : delimiter === ";" ? "分号分隔" : delimiter ? "CSV" : "TXT";
    const records = readDelimitedRecords(trimmed, delimiter).filter(record => !record.fields || !/^\s*(?:#|\/\/)/u.test(record.fields[0] || ""));
    const first = records[0]?.fields;
    const header = first?.map(normalizeHeader) || [];
    const addressIndexes = header.flatMap((field, index) => addressHeaders.has(field) ? [index] : []);
    const amountIndexes = header.flatMap((field, index) => amountHeaders.has(field) ? [index] : []);
    const isHeader = addressIndexes.length > 0 || header.some(field => amountHeaders.has(field) || ancillaryHeaders.has(field));
    if (isHeader) records.shift();
    sourceRows = records.length;
    if (isHeader && (addressIndexes.length !== 1 || amountIndexes.length > 1)) {
      report(1, "收款地址或金额列不明确，请各保留一个列名");
    } else {
      if (isHeader) detectedColumns.push("收款地址", ...(amountIndexes.length ? ["金额"] : []));
      records.slice(0, maxRows).forEach(record => {
        if (!isHeader) { fromFields(record.fields, record.line); return; }
        if (!record.fields || record.fields.length !== first!.length) { report(record.line, "列数与表头不一致，请检查分隔符或引号"); return; }
        addRow(record.fields[addressIndexes[0]], amountIndexes.length ? record.fields[amountIndexes[0]] : undefined, record.line, amountIndexes.length > 0);
      });
    }
  }
  // A partly missing amount column is never silently converted to one amount.
  if (jsonAmountColumn) for (const row of rows) {
    if (row.amount === undefined) report(row.line, "金额缺失，请补齐金额后导入");
  }
  let duplicateRows = 0;
  let conflictingRows = 0;
  const seen = new Map<string, RecipientRow>();
  for (const row of rows) {
    const kind = getListAddressKind(row.address)!;
    const key = getDuplicateAddressKey(row.address, kind);
    const existing = seen.get(key);
    if (!existing) { seen.set(key, row); continue; }
    duplicateRows += 1;
    if (canonicalAmount(existing.amount) !== canonicalAmount(row.amount)) {
      conflictingRows += 1;
      issues.push({ line: row.line, message: `与第 ${existing.line} 行地址重复但金额不同，请保留一个明确金额` });
    }
  }
  return {
    normalizedRows: rows.map(row => row.amount === undefined ? row.address : `${row.address},${row.amount}`).join("\n"),
    invalidRows, sourceRows, truncated: sourceRows > maxRows, issues, format, detectedColumns, duplicateRows, conflictingRows
  };
}
