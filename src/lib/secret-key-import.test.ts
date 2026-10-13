import { Keypair } from "@solana/web3.js";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as xlsxImport from "./wallet-xlsx-import";
import { createWalletXlsxFixture, walletXlsxFixtureFile } from "../test/xlsx-fixtures";
import { encodeBase58, parseSolanaSourceKeys } from "./sol-collection";
import {
  analyzeSecretKeyText, maxSecretKeyFileBytes, maxSecretKeyFileLines, readSecretKeyFile,
  SecretKeyImportError, type SecretKeyImportFile
} from "./secret-key-import";

const first = `0x${"11".repeat(32)}` as const;
const second = `0x${"22".repeat(32)}` as const;
const firstAddress = privateKeyToAccount(first).address;
const secondAddress = privateKeyToAccount(second).address;
function makeFile(name: string, contents: string, type = "text/plain", overrides: Partial<SecretKeyImportFile> = {}): SecretKeyImportFile {
  return { name, size: contents.length, text: async () => contents, type, ...overrides };
}
function publicMetadata(result: Awaited<ReturnType<typeof readSecretKeyFile>>) {
  const { value: _value, sourceValue: _sourceValue, sheets: _sheets, ...metadata } = result;
  return JSON.stringify(metadata);
}
afterEach(() => vi.restoreAllMocks());

describe("Excel private wallet import", () => {
  it.each([0, 6] as const)("imports real binary Excel wallet columns with compression %s", async (compressionLevel) => {
    const pair = Keypair.fromSeed(new Uint8Array(32).fill(23));
    const key = JSON.stringify(Array.from(pair.secretKey));
    const bytes = createWalletXlsxFixture([
      { name: "来源钱包", rows: [["备注", "地址", "private_key"], ["运营\n备用", firstAddress, first], ["重复", firstAddress, first], ["地址不匹配", firstAddress, second]] },
      { name: "Solana 钱包", rows: [["secret_key", "address"], [key.replace(/,/g, ",\n"), pair.publicKey.toBase58()]] }
    ], { compressionLevel });
    const file = { ...walletXlsxFixtureFile(bytes), name: "wallets.xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", text: vi.fn(async () => "") };
    const result = await readSecretKeyFile(file, "evm");
    expect(file.text).not.toHaveBeenCalled();
    expect(result.value).toBe(`运营 备用,${first}`);
    expect(result.duplicates).toBe(1);
    expect(result.wallets[0].address).toBe(firstAddress);
    expect(result.issues[0].message).toContain("地址列与私钥");
    expect(result.sheets?.map((sheet) => sheet.name)).toEqual(["来源钱包", "Solana 钱包"]);
    const solana = analyzeSecretKeyText(result.sheets![1].text, "solana", "xlsx");
    expect(solana.wallets[0].address).toBe(pair.publicKey.toBase58());
    expect(JSON.parse(solana.value)).toEqual(Array.from(pair.secretKey));
    expect(publicMetadata(result)).not.toContain(first);
    expect(publicMetadata(result)).not.toContain(second);
  });

  it("reads binary XLSX sheets through the shared reader and previews only the first selected sheet", async () => {
    const sheets = [
      { name: "运营", text: `备注,address,private_key\nops,${firstAddress},${first}` },
      { name: "备用", text: `private_key\n${second}` }
    ];
    const readWorkbook = vi.spyOn(xlsxImport, "readWalletXlsxFile").mockResolvedValue(sheets);
    const binary = new ArrayBuffer(4);
    const text = vi.fn(async () => { throw new Error("binary read required"); });
    const file: SecretKeyImportFile = { name: "wallets.XLSX", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 4, text, arrayBuffer: async () => binary };
    const result = await readSecretKeyFile(file, "evm");
    expect(readWorkbook).toHaveBeenCalledWith(expect.objectContaining({ size: 4, arrayBuffer: expect.any(Function) }), 1_001);
    expect(text).not.toHaveBeenCalled();
    expect(result).toMatchObject({ format: "XLSX · 自动识别私钥列", value: `ops,${first}`, sourceValue: sheets[0].text, sheets });
    expect(result.wallets).toHaveLength(1);
    expect(publicMetadata(result)).not.toContain(first);
    expect(publicMetadata(result)).not.toContain(second);
  });

  it("preserves a header-only first sheet so another sheet can be selected", async () => {
    vi.spyOn(xlsxImport, "readWalletXlsxFile").mockResolvedValue([{ name: "说明", text: "private_key" }, { name: "钱包", text: `private_key\n${first}` }]);
    const result = await readSecretKeyFile(makeFile("wallets.xlsx", "", "", { arrayBuffer: async () => new ArrayBuffer(1) }), "evm");
    expect(result.wallets).toEqual([]);
    expect(result.issues[0].message).toContain("没有可导入");
    expect(result.sheets).toHaveLength(2);
  });

  it("supports quoted single-column Solana arrays and enforces the per-sheet key limit", () => {
    const pair = Keypair.fromSeed(new Uint8Array(32).fill(17));
    const key = JSON.stringify(Array.from(pair.secretKey));
    const result = analyzeSecretKeyText(`secret_key\n"${key}"`, "solana", "xlsx");
    expect(result.value).toBe(key);
    expect(result.wallets[0].address).toBe(pair.publicKey.toBase58());
    expect(() => analyzeSecretKeyText(`private_key\n${Array(1_001).fill(first).join("\n")}`, "evm", "xlsx")).toThrow("单次最多导入 1,000 条密钥");
  });

  it("rejects oversized, missing binary readers, corrupt and empty workbooks without returning secrets", async () => {
    const readWorkbook = vi.spyOn(xlsxImport, "readWalletXlsxFile").mockRejectedValue(new Error(first));
    await expect(readSecretKeyFile(makeFile("big.xlsx", "", "", { size: maxSecretKeyFileBytes + 1, arrayBuffer: async () => new ArrayBuffer(1) }), "evm")).rejects.toMatchObject({ code: "too-large" });
    expect(readWorkbook).not.toHaveBeenCalled();
    await expect(readSecretKeyFile(makeFile("keys.xlsx", "", ""), "evm")).rejects.toMatchObject({ code: "read-failed" });
    await expect(readSecretKeyFile(makeFile("bad.xlsx", "", "", { arrayBuffer: async () => new ArrayBuffer(1) }), "evm")).rejects.toMatchObject({ code: "invalid-content", message: expect.not.stringContaining(first) });
    readWorkbook.mockResolvedValue([]);
    await expect(readSecretKeyFile(makeFile("empty.xlsx", "", "", { arrayBuffer: async () => new ArrayBuffer(1) }), "evm")).rejects.toMatchObject({ code: "empty-file" });
  });
});

describe("smart wallet file import", () => {
  it("normalizes BOM, CRLF and label/key CSV without secret metadata", async () => {
    const result = await readSecretKeyFile(makeFile("wallets.csv", `\uFEFFwallet 1,${first}\r\n\r\nwallet 2,${second}\r\n`, "text/csv"), "evm");
    expect(result).toMatchObject({ fileName: "wallets.csv", lineCount: 2, value: `wallet 1,${first}\nwallet 2,${second}` });
    expect(result.wallets).toEqual([{ address: firstAddress, id: firstAddress.toLowerCase(), label: "wallet 1", line: 1 }, { address: secondAddress, id: secondAddress.toLowerCase(), label: "wallet 2", line: 3 }]);
    expect(publicMetadata(result)).not.toContain(first);
    expect(publicMetadata(result)).not.toContain(second);
  });

  it.each([",", "\t", ";"])("recognizes private-key and address columns in either order (%s)", async (separator) => {
    const result = await readSecretKeyFile(makeFile(separator === "\t" ? "wallets.tsv" : "wallets.csv", `备注${separator}wallet_address${separator}private_key\n"日常, 钱包"${separator}${firstAddress}${separator}${first.slice(2)}`), "evm");
    expect(result.value).toBe(`日常 钱包,${first}`);
    expect(result.wallets).toHaveLength(1);
    expect(result.issues).toEqual([]);
    expect(result.format).toContain("自动识别私钥列");
  });

  it("recognizes headerless key/address rows and preserves quoted CSV labels", async () => {
    const result = await readSecretKeyFile(makeFile("wallets.csv", `${first},${firstAddress},"运营, A"`), "evm");
    expect(result.value).toBe(`运营 A,${first}`);
    expect(result.wallets[0].label).toBe("运营 A");
  });

  it("keeps original source and reports original rows for invalid or mismatched entries", async () => {
    const source = `address,private_key\n${firstAddress},${first}\n${firstAddress},${second}\n${secondAddress},not-a-key`;
    const result = await readSecretKeyFile(makeFile("wallets.csv", source), "evm");
    expect(result.sourceValue).toBe(source);
    expect(result.value).toBe(first);
    expect(result.lineCount).toBe(3);
    expect(result.issues).toEqual([{ line: 3, message: "地址列与私钥派生的钱包地址不一致，请核对这一行" }, { line: 4, message: "私钥无效或无法派生地址" }]);
    expect(publicMetadata(result)).not.toContain(first);
    expect(publicMetadata(result)).not.toContain(second);
  });

  it("does not treat address-only CSV or TXT as private keys", async () => {
    const solAddress = Keypair.fromSeed(new Uint8Array(32).fill(41)).publicKey.toBase58();
    for (const [mode, address] of [["evm", firstAddress], ["solana", solAddress]] as const) {
      const csv = await readSecretKeyFile(makeFile("addresses.csv", `address\n${address}`), mode);
      const txt = await readSecretKeyFile(makeFile("addresses.txt", address), mode);
      expect(csv.wallets).toEqual([]);
      expect(txt.wallets).toEqual([]);
      expect(csv.issues[0].message).toContain("钱包地址");
      expect(publicMetadata(txt)).not.toContain(address);
    }
  });

  it.each([
    `private_key,private_key\n${first},${second}`,
    `address,address,private_key\n${firstAddress},${firstAddress},${first}`,
    `${first},${second}`
  ])("rejects ambiguous headers and multiple keys", async (source) => {
    const result = await readSecretKeyFile(makeFile("wallets.csv", source), "evm");
    expect(result.wallets).toEqual([]);
    expect(result.issues[0].message).toContain("多个");
    expect(publicMetadata(result)).not.toContain(first);
    expect(publicMetadata(result)).not.toContain(second);
  });

  it("recognizes a complete JSON string without mistaking quoted CSV for JSON", () => {
    const json = analyzeSecretKeyText(JSON.stringify(first), "evm");
    const csv = analyzeSecretKeyText(`"运营, A",${first}`, "evm");
    expect(json.value).toBe(first);
    expect(json.format).toContain("JSON");
    expect(csv.value).toBe(`运营 A,${first}`);
    expect(csv.format).toBe("CSV");
    expect(csv.issues).toEqual([]);
  });

  it("supports EVM JSON strings, wallet objects and common wrappers", async () => {
    const strings = await readSecretKeyFile(makeFile("keys.json", JSON.stringify([first, `ops,${second}`]), "application/json"), "evm");
    const objects = await readSecretKeyFile(makeFile("wallets.json", JSON.stringify({ wallets: [{ address: firstAddress, privateKey: first, name: "ops" }, { 私钥: second, 地址: secondAddress, 备注: "备用" }] }), "application/json"), "evm");
    expect(strings.value).toBe(`${first}\nops,${second}`);
    expect(objects.value).toBe(`ops,${first}\n备用,${second}`);
    expect(objects.issues).toEqual([]);
    expect(objects.lineCount).toBe(2);
  });

  it("supports Solana byte arrays, keypair objects, Base58 secret fields and deduplication", async () => {
    const keypair = Keypair.fromSeed(new Uint8Array(32).fill(7));
    const bytes = Array.from(keypair.secretKey);
    const result = await readSecretKeyFile(makeFile("sol.json", JSON.stringify([{ keypair: { secretKey: bytes }, label: "sol", publicKey: keypair.publicKey.toBase58() }, { secret_key: encodeBase58(keypair.secretKey) }, bytes]), "application/json"), "solana");
    const single = await readSecretKeyFile(makeFile("key.json", JSON.stringify(bytes), "application/json"), "solana");
    expect(single).toMatchObject({ lineCount: 1, value: JSON.stringify(bytes) });
    expect(result.value).toBe(`sol,${JSON.stringify(bytes)}`);
    expect(result.duplicates).toBe(2);
    expect(result.issues).toEqual([]);
    expect(publicMetadata(result)).not.toContain(encodeBase58(keypair.secretKey));
    expect(publicMetadata(result)).not.toContain(JSON.stringify(bytes));
  });

  it.each(["json", "csv", "xlsx"] as const)("keeps bracketed Solana labels importable after %s preview normalization", async (extension) => {
    const firstPair = Keypair.fromSeed(new Uint8Array(32).fill(11));
    const secondPair = Keypair.fromSeed(new Uint8Array(32).fill(12));
    const entries = [
      { label: "[ops]", address: firstPair.publicKey.toBase58(), secret_key: encodeBase58(firstPair.secretKey) },
      { label: "[2026] 备用", address: secondPair.publicKey.toBase58(), secret_key: Array.from(secondPair.secretKey) }
    ];
    const file = extension === "xlsx"
      ? {
        ...walletXlsxFixtureFile(createWalletXlsxFixture([{ name: "Solana", rows: [
          ["label", "address", "secret_key"],
          ...entries.map(entry => [entry.label, entry.address, typeof entry.secret_key === "string" ? entry.secret_key : JSON.stringify(entry.secret_key)])
        ] }])),
        name: "wallets.xlsx", type: "", text: async () => ""
      }
      : makeFile(`wallets.${extension}`, extension === "json" ? JSON.stringify(entries)
        : "label,address,secret_key\n" + entries.map(entry => `${entry.label},${entry.address},${typeof entry.secret_key === "string" ? entry.secret_key : JSON.stringify(entry.secret_key)}`).join("\n"));
    const preview = await readSecretKeyFile(file, "solana");
    const imported = parseSolanaSourceKeys(preview.value);

    expect(preview.issues).toEqual([]);
    expect(preview.wallets).toHaveLength(2);
    expect(imported.errors).toEqual([]);
    expect(imported.sources.map(source => ({ address: source.address, label: source.label })))
      .toEqual(entries.map(entry => ({ address: entry.address, label: entry.label })));
    expect(publicMetadata(preview)).not.toContain(encodeBase58(firstPair.secretKey));
    expect(publicMetadata(preview)).not.toContain(JSON.stringify(Array.from(secondPair.secretKey)));
  });

  it("supports unquoted Solana byte arrays in CSV and newline array lists", async () => {
    const bytes = JSON.stringify(Array.from(Keypair.fromSeed(new Uint8Array(32).fill(8)).secretKey));
    const csv = await readSecretKeyFile(makeFile("sol.csv", `label,secret_key\nsol,${bytes}`), "solana");
    const text = analyzeSecretKeyText(`${bytes}\n${bytes}`, "solana");
    expect(csv.value).toBe(`sol,${bytes}`);
    expect(text.wallets).toHaveLength(1);
    expect(text.duplicates).toBe(1);
    expect(csv.issues).toEqual([]);
  });

  it("requires an explicit field for ambiguous 32-byte Solana Base58 seeds", async () => {
    const seed = encodeBase58(new Uint8Array(32).fill(9));
    const explicit = await readSecretKeyFile(makeFile("seed.csv", `secret_key\n${seed}`), "solana");
    const plain = await readSecretKeyFile(makeFile("seed.txt", seed), "solana");
    expect(explicit.wallets).toHaveLength(1);
    expect(plain.wallets).toEqual([]);
    expect(plain.issues[0].message).toContain("32 字节种子");
  });

  it("does not put a mistaken secret label into public metadata", async () => {
    const result = await readSecretKeyFile(makeFile("wallets.csv", `label,private_key\n${second},${first}`), "evm");
    expect(result.wallets[0]).not.toHaveProperty("label");
    expect(publicMetadata(result)).not.toContain(second);
    expect(result.value).toBe(first);
  });

  it("identifies encrypted Keystore and mnemonic entries without secret errors", async () => {
    const secret = "never-print-this-secret";
    const result = await readSecretKeyFile(makeFile("wallets.json", JSON.stringify([{ crypto: { ciphertext: secret } }, { mnemonic: secret }, { privateKey: first }]), "application/json"), "evm");
    expect(result.issues).toEqual([{ line: 1, message: "不支持加密 Keystore，请先在钱包中导出私钥" }, { line: 2, message: "不支持助记词，请先在钱包中导出私钥" }]);
    expect(result.wallets).toHaveLength(1);
    expect(publicMetadata(result)).not.toContain(secret);
    expect(publicMetadata(result)).not.toContain(first);
    const mnemonic = analyzeSecretKeyText("abandon ".repeat(11) + "about", "evm");
    expect(mnemonic.issues[0].message).toContain("不支持助记词");
  });

  it.each([
    makeFile("wallets.exe", first, "application/octet-stream"),
    makeFile("wallets.json", JSON.stringify([first]), "application/octet-stream"),
    makeFile("wallets.txt", first, "text/plain", { size: maxSecretKeyFileBytes + 1 })
  ])("rejects files outside extension, MIME and size allowlists", async (file) => {
    await expect(readSecretKeyFile(file, "evm")).rejects.toBeInstanceOf(SecretKeyImportError);
  });

  it("replaces file-read failures with a safe generic error", async () => {
    await expect(readSecretKeyFile(makeFile("keys.txt", "", "text/plain", { size: 10, text: async () => { throw new Error(first); } }), "evm"))
      .rejects.toMatchObject({ message: "无法读取文件，请确认文件可访问后重试" });
  });

  it("rejects empty, binary, invalid JSON and overlong row counts before deduplication", async () => {
    await expect(readSecretKeyFile(makeFile("empty.txt", " \r\n "), "evm")).rejects.toMatchObject({ code: "empty-file" });
    await expect(readSecretKeyFile(makeFile("binary.txt", `${first}\0`), "evm")).rejects.toMatchObject({ code: "invalid-content" });
    await expect(readSecretKeyFile(makeFile("broken.json", `{\"privateKey\":\"${first}\"`), "evm")).rejects.toMatchObject({ code: "invalid-content" });
    expect(maxSecretKeyFileLines).toBe(1_000);
    const keys = Array.from({ length: maxSecretKeyFileLines + 1 }, () => first);
    await expect(readSecretKeyFile(makeFile("many.txt", keys.join("\n")), "evm")).rejects.toMatchObject({ code: "too-many-lines" });
    await expect(readSecretKeyFile(makeFile("many.json", JSON.stringify(keys), "application/json"), "evm")).rejects.toMatchObject({ code: "too-many-lines" });
  });

  it("supports full 1,000-entry files and counts duplicates before applying the limit", async () => {
    const keys = Array.from({ length: maxSecretKeyFileLines }, () => first);
    const result = await readSecretKeyFile(makeFile("keys.csv", "private_key\n" + keys.join("\n")), "evm");
    expect(result.lineCount).toBe(1_000);
    expect(result.wallets).toHaveLength(1);
    expect(result.duplicates).toBe(999);
  });

  it("accepts short Base58 representations of full 64-byte Solana keys", async () => {
    const keypair = Keypair.fromSeed(new Uint8Array(32));
    const secret = encodeBase58(keypair.secretKey);
    expect(secret.length).toBeLessThan(80);
    const result = await readSecretKeyFile(makeFile("sol.txt", secret), "solana");
    expect(result.issues).toEqual([]);
    expect(result.wallets[0].address).toBe(keypair.publicKey.toBase58());
    expect(result.value).toBe(secret);
  });

  it("rejects conflicting JSON key sources or multiple wrapper lists", async () => {
    const objects = [
      { privateKey: first, keypair: { secretKey: second } },
      { privateKey: first, private_key: second },
      { privateKey: first, address: firstAddress, publicKey: firstAddress }
    ];
    for (const entry of objects) {
      const result = await readSecretKeyFile(makeFile("ambiguous.json", JSON.stringify(entry), "application/json"), "evm");
      expect(result.wallets).toEqual([]);
      expect(result.issues[0].message).toContain("多个");
      expect(publicMetadata(result)).not.toContain(first);
      expect(publicMetadata(result)).not.toContain(second);
    }
    for (const entry of [{ wallets: [first], accounts: [second] }, { wallets: [first], privateKey: second }]) {
      await expect(readSecretKeyFile(makeFile("ambiguous.json", JSON.stringify(entry), "application/json"), "evm"))
        .rejects.toMatchObject({ message: "JSON 中包含多个钱包清单或密钥来源，请仅保留要导入的清单" });
    }
  });

  it("keeps accidental secret file names and 32-byte Base58 seed labels out of metadata", async () => {
    const seed = encodeBase58(new Uint8Array(32).fill(19));
    const result = await readSecretKeyFile(makeFile(`${first}.txt`, `${seed},${first}`), "evm");
    expect(result.fileName).toBe("钱包文件");
    expect(result.wallets[0]).not.toHaveProperty("label");
    expect(publicMetadata(result)).not.toContain(first);
    expect(publicMetadata(result)).not.toContain(seed);
  });

  it("sanitizes control characters in the displayed file name", async () => {
    const result = await readSecretKeyFile(makeFile("wallets\nprivate.txt", first), "evm");
    expect(result.fileName).toBe("wallets private.txt");
  });
});
