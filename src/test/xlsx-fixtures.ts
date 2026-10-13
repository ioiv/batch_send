import { strToU8, zipSync } from "fflate";

export type WalletXlsxFixtureCell = string | { number: string; style?: number } | { sharedString: number } | null;
export type WalletXlsxFixtureSheet = { name: string; rows?: WalletXlsxFixtureCell[][]; xml?: string; hidden?: boolean };

const escapeXml = (value: string) => value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");

function columnName(index: number) {
  let name = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + (value - 1) % 26) + name;
  return name;
}

/** Real ZIP/OOXML fixtures keep parser tests independent of mocks or floating point. */
export function createWalletXlsxFixture(sheets: WalletXlsxFixtureSheet[], options: { sharedStrings?: string[]; extraFiles?: Record<string, string>; compressionLevel?: 0 | 6 } = {}) {
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' + sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") + "</Types>"),
    "_rels/.rels": strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    "xl/workbook.xml": strToU8('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + sheets.map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"${sheet.hidden ? ' state="hidden"' : ""}/>`).join("") + "</sheets></workbook>"),
    "xl/_rels/workbook.xml.rels": strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("") + "</Relationships>")
  };
  sheets.forEach((sheet, index) => {
    const xml = sheet.xml ?? '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + (sheet.rows || []).map((row, rowIndex) => `<row r="${rowIndex + 1}">` + row.map((cell, columnIndex) => {
      if (cell === null) return "";
      const address = `${columnName(columnIndex)}${rowIndex + 1}`;
      if (typeof cell === "string") return `<c r="${address}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell)}</t></is></c>`;
      if ("number" in cell) return `<c r="${address}" t="n"${cell.style === undefined ? "" : ` s="${cell.style}"`}><v>${cell.number}</v></c>`;
      return `<c r="${address}" t="s"><v>${cell.sharedString}</v></c>`;
    }).join("") + "</row>").join("") + "</sheetData></worksheet>";
    files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(xml);
  });
  if (options.sharedStrings) files["xl/sharedStrings.xml"] = strToU8('<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' + options.sharedStrings.map(value => `<si><t xml:space="preserve">${escapeXml(value)}</t></si>`).join("") + "</sst>");
  for (const [path, text] of Object.entries(options.extraFiles || {})) files[path] = strToU8(text);
  return zipSync(files, { level: options.compressionLevel ?? 6 });
}

export function walletXlsxFixtureFile(bytes: Uint8Array) {
  return { size: bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer };
}
