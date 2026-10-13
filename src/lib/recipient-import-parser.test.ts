import { describe, expect, it } from "vitest";
import { importDistributionFileText } from "./distribution-generator";

const address = "0x00000000000000000000000000000000000000aa";
const other = "0x00000000000000000000000000000000000000bb";
const sol = "11111111111111111111111111111111";
const importEvm = (text: string) => importDistributionFileText(text, { addressKind: "evm" });

describe("intelligent recipient file recognition", () => {
  it.each([",", "\t", ";"])("recognizes named columns in any order with delimiter %s", delimiter => {
    const secret = "DO_NOT_SHOW_PRIVATE_MATERIAL";
    const result = importEvm([
      ["label", "amount", "private_key", "wallet_address"].join(delimiter),
      ["ops", "0.000000000000000001", secret, address].join(delimiter)
    ].join("\n"));
    expect(result).toMatchObject({ invalidRows: 0, addresses: address, rows: `${address},0.000000000000000001`, detectedColumns: ["收款地址", "金额"] });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("ops");
  });

  it("handles escaped quotes, multiline notes, BOM, CRLF and comment lines", () => {
    const result = importEvm(`\uFEFF# exported wallets\r\n备注,收款地址,金额\r\n"ops,\"\"desk\"\"\r\nteam",${address},0.10\r\n${"desk"},${other},2`);
    expect(result).toMatchObject({ sourceRows: 2, invalidRows: 0, rows: `${address},0.10\n${other},2` });
  });

  it("extracts common label/address text without mistaking sequence numbers for amounts", () => {
    expect(importEvm(`ops ${address}\nbackup\t${other}`)).toMatchObject({ invalidRows: 0, addresses: `${address}\n${other}`, hadAmounts: false });
    expect(importEvm(`1,${address}`)).toMatchObject({ invalidRows: 1, addresses: "" });
  });

  it("accepts JSON arrays, a wallet object, and wrapped exports", () => {
    expect(importEvm(JSON.stringify(address))).toMatchObject({ format: "JSON", addresses: address, invalidRows: 0 });
    expect(importEvm(`"${address}","0.1"`)).toMatchObject({ rows: `${address},0.1`, invalidRows: 0 });
    expect(importEvm(JSON.stringify([address, other]))).toMatchObject({ format: "JSON", addresses: `${address}\n${other}`, invalidRows: 0 });
    expect(importEvm(JSON.stringify({ address, amount: "0.000000000000000001", privateKey: "secret" }))).toMatchObject({ rows: `${address},0.000000000000000001`, invalidRows: 0 });
    expect(importEvm(JSON.stringify({ wallets: [{ wallet_address: address }, { publicKey: other }] }))).toMatchObject({ addresses: `${address}\n${other}`, invalidRows: 0 });
  });

  it("retains the original JSON numeric token without floating point conversion", () => {
    const result = importEvm(`[{"address":"${address}","amount":0.123456789012345678},{"amount":12345678901234567890,"address":"${other}"}]`);
    expect(result.rows).toBe(`${address},0.123456789012345678\n${other},12345678901234567890`);
  });

  it("never returns unexpected secret content in an amount field", () => {
    const secret = "0xabcdef-private-material";
    for (const contents of [`${address},${secret}`, JSON.stringify({ address, amount: secret }), `address,amount\n${address},${secret}`]) {
      const result = importEvm(contents);
      expect(result.invalidRows).toBe(1);
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    expect(importEvm(`[{"address":"${address}","amount":1e-18}]`)).toMatchObject({ invalidRows: 1, rows: "" });
    expect(importDistributionFileText('{"address":11111111111111111111111111111111,"amount":1}', { addressKind: "solana" })).toMatchObject({ invalidRows: 1, rows: "" });
  });

  it("detects missing JSON amounts instead of applying a shared amount", () => {
    const result = importEvm(JSON.stringify([{ address, amount: "1" }, { address: other }]));
    expect(result.invalidRows).toBe(1);
    expect(result.hasMixedAmounts).toBe(true);
    expect(result.issues).toContainEqual({ line: 2, message: "金额缺失，请补齐金额后导入" });
  });

  it("reports duplicates case-insensitively and blocks differing amounts", () => {
    const same = importEvm(`${address},01.0\n${address.toUpperCase().replace("0X", "0x")},1.00`);
    expect(same).toMatchObject({ duplicateRows: 1, conflictingRows: 0 });
    const conflict = importEvm(`${address},0.1\n${address},0.2`);
    expect(conflict).toMatchObject({ duplicateRows: 1, conflictingRows: 1 });
    expect(conflict.issues[0].message).toContain("金额不同");
  });

  it("rejects ambiguous headers and multiple candidate addresses", () => {
    expect(importEvm(`address,wallet_address,amount\n${address},${other},1`)).toMatchObject({ invalidRows: 1, rows: "" });
    expect(importEvm(`address,amount,value\n${address},1,2`)).toMatchObject({ invalidRows: 1, rows: "" });
    expect(importEvm(`${address},${other}`)).toMatchObject({ invalidRows: 1, rows: "" });
    expect(importEvm(JSON.stringify({ address, to: other }))).toMatchObject({ invalidRows: 1, rows: "" });
  });

  it("rejects wrong-chain, malformed and unexpected column rows with safe line diagnostics", () => {
    const secret = "secret-in-malformed-line";
    const result = importEvm(`address,amount\n${address},1\n${sol},2\n"${secret},1\n${other},3`);
    expect(result.invalidRows).toBe(2);
    expect(result.issues.map(issue => issue.line)).toEqual([3, 4]);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(importEvm(`address,amount\n${address},1,extra`)).toMatchObject({ invalidRows: 1, rows: "" });
  });

  it("blocks malformed JSON, unsupported containers, binary content, and row overflow", () => {
    expect(() => importEvm(`[{"address":"${address}"}`)).toThrow("JSON 格式");
    expect(() => importEvm(JSON.stringify({ wallets: [address], recipients: [other] }))).toThrow("多个钱包清单");
    expect(() => importEvm(`${address}\0`)).toThrow("UTF-8");
    expect(importDistributionFileText(`${address}\n${other}`, { addressKind: "evm", maxRows: 1 })).toMatchObject({ truncated: true, sourceRows: 2, addresses: address });
  });
});
