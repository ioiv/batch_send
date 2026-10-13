import { Keypair } from "@solana/web3.js";
import { privateKeyToAddress } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { createWalletXlsxFixture, walletXlsxFixtureFile } from "../test/xlsx-fixtures";
import { parseRecipientImport } from "./recipient-import-parser";
import { analyzeSecretKeyText } from "./secret-key-import";
import { maxWalletXlsxFileBytes, readWalletXlsxFile, WalletXlsxImportError } from "./wallet-xlsx-import";

const key = `0x${"0".repeat(63)}1` as const;
const address = privateKeyToAddress(key);
const dateStyles = '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>';
const read = (bytes: Uint8Array, maxRows = 1001) => readWalletXlsxFile(walletXlsxFixtureFile(bytes), maxRows);

function overwriteEntrySize(input: Uint8Array, target: string, size: number) {
  const bytes = input.slice();
  const view = new DataView(bytes.buffer);
  const end = bytes.length - 22;
  let position = view.getUint32(end + 16, true);
  while (position < end) {
    const nameLength = view.getUint16(position + 28, true);
    const extraLength = view.getUint16(position + 30, true);
    const commentLength = view.getUint16(position + 32, true);
    const name = new TextDecoder().decode(bytes.subarray(position + 46, position + 46 + nameLength));
    if (name === target) {
      view.setUint32(position + 24, size, true);
      view.setUint32(view.getUint32(position + 42, true) + 22, size, true);
      return bytes;
    }
    position += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error("Fixture entry not found");
}

describe("readWalletXlsxFile", () => {
  it("reads real shared and inline strings, quotes CSV cells, and keeps blank columns aligned", async () => {
    const bytes = createWalletXlsxFixture([{ name: "导出钱包", rows: [
      [{ sharedString: 0 }, "private_key", "unused", "address"],
      ['运营, "A"', key, null, { sharedString: 1 }]
    ] }], { sharedStrings: ["label", address] });
    const [sheet] = await read(bytes);
    expect(sheet.name).toBe("导出钱包");
    expect(sheet.text).toContain('"运营, ""A"""');
    const parsed = analyzeSecretKeyText(sheet.text, "evm", "xlsx");
    expect(parsed.wallets).toEqual([{ address, id: address.toLowerCase(), label: '运营 "A"', line: 2 }]);
    expect(parsed.issues).toEqual([]);
    expect(parsed.value).toBe(`运营 "A",${key}`);
  });

  it("keeps exact numeric lexemes and expands scientific notation without IEEE-754 rounding", async () => {
    const amounts = ["1.234567890123456789", "1E-18", "9007199254740993", "1.234500E+3", "-2.50E-3"];
    const [sheet] = await read(createWalletXlsxFixture([{ name: "金额", rows: [["amount", "address"], ...amounts.map(number => [{ number }, address])] }]));
    expect(sheet.text.split("\n").slice(1).map(row => row.split(",")[0])).toEqual([
      "1.234567890123456789", "0.000000000000000001", "9007199254740993", "1234.500", "-0.00250"
    ]);
    const parsed = parseRecipientImport(sheet.text, { addressKind: "evm" }, 5000);
    expect(parsed.issues).toContainEqual({ line: 6, message: "金额格式不正确，请填写普通十进制数字" });
  });

  it("returns all nonempty worksheets, including hidden ones, for explicit selection", async () => {
    const sheets = await read(createWalletXlsxFixture([
      { name: "空表", rows: [[], [null, null]] },
      { name: "主表", rows: [["address"], [address]] },
      { name: "备用", hidden: true, rows: [["private_key"], [key]] }
    ]));
    expect(sheets).toEqual([{ name: "主表", text: `address\n${address}` }, { name: "备用", text: `private_key\n${key}` }]);
  });

  it("supports stored ZIP entries without modifying the original archive", async () => {
    const bytes = createWalletXlsxFixture([{ name: "无压缩", rows: [["address", "amount"], [address, { number: "1E-18" }]] }], { compressionLevel: 0 });
    const original = bytes.slice();
    const [sheet] = await readWalletXlsxFile({ size: bytes.length, arrayBuffer: async () => bytes.buffer as ArrayBuffer }, 1001);
    expect(sheet.text).toBe(`address,amount\n${address},0.000000000000000001`);
    expect(bytes).toEqual(original);
  });

  it("normalizes multiline notes and Solana JSON byte arrays to one CSV record", async () => {
    const keypair = Keypair.fromSeed(new Uint8Array(32).fill(11));
    const secret = JSON.stringify(Array.from(keypair.secretKey), null, 2);
    const [sheet] = await read(createWalletXlsxFixture([{ name: "Solana", rows: [["secret_key", "label", "address"], [secret, "运营\r\n备用", keypair.publicKey.toBase58()]] }]));
    expect(sheet.text.split("\n")).toHaveLength(2);
    const result = analyzeSecretKeyText(sheet.text, "solana", "xlsx");
    expect(result.issues).toEqual([]);
    expect(result.wallets[0]).toMatchObject({ label: "运营 备用", address: keypair.publicKey.toBase58() });
    expect(JSON.parse(result.value.slice(result.value.indexOf(",") + 1))).toEqual(Array.from(keypair.secretKey));
  });

  it("keeps separating whitespace in a split secret so it cannot become a valid key", async () => {
    const split = `${key.slice(0, 34)}\n${key.slice(34)}`;
    const [sheet] = await read(createWalletXlsxFixture([{ name: "钱包", rows: [["private_key"], [split]] }]));
    expect(sheet.text).toContain(`${key.slice(0, 34)} ${key.slice(34)}`);
    expect(analyzeSecretKeyText(sheet.text, "evm", "xlsx").wallets).toEqual([]);
  });

  it("sanitizes sheet names before they can enter public UI state", async () => {
    const sheets = await read(createWalletXlsxFixture([
      { name: key, rows: [[address]] },
      { name: "  钱包\u202e\t列表  ", rows: [[address]] },
      { name: "a".repeat(200), rows: [[address]] }
    ]));
    expect(sheets.map(sheet => sheet.name)).toEqual(["工作表 1", "钱包 列表", "工作表 3"]);
    expect(JSON.stringify(sheets.map(sheet => sheet.name))).not.toContain(key);
  });

  it("retains original row numbers across empty rows while allowing arbitrary header order", async () => {
    const [sheet] = await read(createWalletXlsxFixture([{ name: "钱包", rows: [["label", "address", "private_key"], [], ["备用", address, key]] }]));
    expect(sheet.text.split("\n")[1]).toBe("");
    const result = analyzeSecretKeyText(sheet.text, "evm", "xlsx");
    expect(result.wallets[0]).toMatchObject({ address, line: 3 });
  });

  it("allows date metadata as ISO text without treating it as a numeric amount", async () => {
    const [sheet] = await read(createWalletXlsxFixture([{ name: "钱包", rows: [["address", "amount", "created_at"], [address, { number: "1E-18" }, { number: "45292", style: 1 }]] }], { extraFiles: { "xl/styles.xml": dateStyles } }));
    expect(sheet.text).toContain("2024-01-01T00:00:00.000Z");
    const result = parseRecipientImport(sheet.text, { addressKind: "evm" }, 5000);
    expect(result.issues).toEqual([]);
    expect(result.normalizedRows).toBe(`${address},0.000000000000000001`);
  });

  it("rejects a date amount through the existing amount validator", async () => {
    const [sheet] = await read(createWalletXlsxFixture([{ name: "钱包", rows: [["address", "amount"], [address, { number: "45292", style: 1 }]] }], { extraFiles: { "xl/styles.xml": dateStyles } }));
    const result = parseRecipientImport(sheet.text, { addressKind: "evm" }, 5000);
    expect(result.normalizedRows).toBe("");
    expect(result.issues[0].message).toContain("金额格式");
  });

  it.each(["private_key", "secret_key", "address"])("refuses numeric %s fields that Excel may have irreversibly rounded", async (header) => {
    const bytes = createWalletXlsxFixture([{ name: "钱包", rows: [[header], [{ number: "1.23456789012345E+63" }]] }]);
    await expect(read(bytes)).rejects.toMatchObject({ code: "unsupported-cell", message: expect.stringContaining("保存为文本") });
  });

  it.each([
    '<c r="A1" t="str"><f>CONCAT("secret", "value")</f><v>cached-secret</v></c>',
    '<c r="A1" t="n"><f t="shared" si="0"/><v>1E-18</v></c>'
  ])("rejects formula cells instead of trusting their cached results", async (cell) => {
    const bytes = createWalletXlsxFixture([{ name: "公式", xml: `<worksheet><sheetData><row r="1">${cell}</row></sheetData></worksheet>` }]);
    await expect(read(bytes)).rejects.toMatchObject({ code: "formula", message: "工作表含公式单元格，请在 Excel 中复制并粘贴为数值后导入" });
  });

  it("enforces the compressed file limit before requesting its contents", async () => {
    const arrayBuffer = vi.fn();
    await expect(readWalletXlsxFile({ size: maxWalletXlsxFileBytes + 1, arrayBuffer }, 1001)).rejects.toMatchObject({ code: "too-large" });
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("does not expose private input or native errors when file access fails", async () => {
    await expect(readWalletXlsxFile({ size: 1, arrayBuffer: async () => { throw new Error(key); } }, 1001)).rejects.toMatchObject({
      code: "read-failed", message: "无法读取文件，请确认文件可访问后重试"
    });
  });

  it.each([new Uint8Array([1, 2, 3]), new TextEncoder().encode(key), new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])])("uses a fixed safe message for damaged, non-XLSX, or encrypted input", async (bytes) => {
    await expect(read(bytes)).rejects.toMatchObject({ code: "invalid-file", message: "无法读取 XLSX 文件，请确认文件未损坏或加密，并以 XLSX 格式重新保存" });
  });

  it("does not expose an invalid cell's private string in a parser failure", async () => {
    const bytes = createWalletXlsxFixture([{ name: "钱包", xml: `<worksheet><sheetData><row r="1"><c r="A1" t="invalid-${key}"><v>${key}</v></c></row></sheetData></worksheet>` }]);
    await expect(read(bytes)).rejects.toMatchObject({ code: "invalid-file", message: "无法读取 XLSX 文件，请确认文件未损坏或加密，并以 XLSX 格式重新保存" });
  });

  it("rejects a ZIP entry that advertises excessive uncompressed size before inflating it", async () => {
    const bytes = createWalletXlsxFixture([{ name: "钱包", rows: [[address]] }]);
    await expect(read(overwriteEntrySize(bytes, "xl/workbook.xml", 9 * 1024 * 1024))).rejects.toMatchObject({ code: "too-large-content" });
  });

  it("bounds actual inflation even if ZIP metadata lies about decompressed size", async () => {
    const bytes = createWalletXlsxFixture([{ name: "钱包", rows: [[address]] }], { extraFiles: { "xl/oversized.xml": "x".repeat(9 * 1024 * 1024) } });
    expect(bytes.length).toBeLessThan(maxWalletXlsxFileBytes);
    await expect(read(overwriteEntrySize(bytes, "xl/oversized.xml", 1))).rejects.toMatchObject({ code: "too-large-content" });
  });

  it("rejects sparse oversized row indices before the parser can allocate their gaps", async () => {
    const bytes = createWalletXlsxFixture([{ name: "钱包", xml: '<worksheet><sheetData><row r="1048576"><c r="A1048576" t="inlineStr"><is><t>address</t></is></c></row></sheetData></worksheet>' }]);
    await expect(read(bytes)).rejects.toMatchObject({ code: "too-many-rows" });
  });

  it("counts header and data rows against the caller's limit", async () => {
    const bytes = createWalletXlsxFixture([{ name: "钱包", rows: [["address"], [address], [address]] }]);
    await expect(read(bytes, 2)).rejects.toMatchObject({ code: "too-many-rows" });
    expect(await read(bytes, 3)).toHaveLength(1);
  });

  it("rejects sparse oversized columns before the parser can allocate their gaps", async () => {
    const bytes = createWalletXlsxFixture([{ name: "钱包", xml: '<worksheet><sheetData><row r="1"><c r="XFD1" t="inlineStr"><is><t>address</t></is></c></row></sheetData></worksheet>' }]);
    await expect(read(bytes)).rejects.toMatchObject({ code: "too-many-columns" });
  });

  it("rejects excessive worksheet counts and oversized individual cells", async () => {
    await expect(read(createWalletXlsxFixture(Array.from({ length: 21 }, (_, index) => ({ name: `钱包 ${index + 1}`, rows: [[address]] }))))).rejects.toMatchObject({ code: "too-large-content" });
    await expect(read(createWalletXlsxFixture([{ name: "钱包", rows: [["x".repeat(4097)]] }]))).rejects.toMatchObject({ code: "too-large-content" });
  });

  it("bounds expanded CSV output even when a compressed file is very small", async () => {
    const bytes = createWalletXlsxFixture([{ name: "钱包", rows: Array.from({ length: 600 }, () => ["x".repeat(1000)]) }]);
    expect(bytes.length).toBeLessThan(maxWalletXlsxFileBytes);
    await expect(read(bytes)).rejects.toMatchObject({ code: "too-large-content" });
  });

  it("rejects external XML entity declarations with a safe message", async () => {
    const bytes = createWalletXlsxFixture([{ name: "钱包", xml: '<!DOCTYPE worksheet [<!ENTITY secret SYSTEM "file:///secret">]><worksheet><sheetData/></worksheet>' }]);
    await expect(read(bytes)).rejects.toMatchObject({ code: "invalid-file" });
  });

  it("reports an empty workbook without silently choosing another input", async () => {
    await expect(read(createWalletXlsxFixture([{ name: "空表", rows: [[], [null]] }]))).rejects.toBeInstanceOf(WalletXlsxImportError);
    await expect(read(createWalletXlsxFixture([{ name: "空表", rows: [] }]))).rejects.toMatchObject({ code: "empty-file" });
  });
});
