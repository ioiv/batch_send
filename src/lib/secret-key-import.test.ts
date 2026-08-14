import { describe, expect, it } from "vitest";
import {
  maxSecretKeyFileBytes,
  maxSecretKeyFileLines,
  readSecretKeyFile,
  SecretKeyImportError,
  type SecretKeyImportFile
} from "./secret-key-import";

function makeFile(
  name: string,
  contents: string,
  type = "text/plain",
  overrides: Partial<SecretKeyImportFile> = {}
): SecretKeyImportFile {
  return {
    name,
    size: contents.length,
    text: async () => contents,
    type,
    ...overrides
  };
}

describe("readSecretKeyFile", () => {
  it("normalizes local TXT and CSV text without exposing content in metadata", async () => {
    const result = await readSecretKeyFile(
      makeFile("wallets.csv", "\uFEFFwallet 1,0xabc\r\n\r\nwallet 2,0xdef\r\n", "text/csv"),
      "evm"
    );

    expect(result).toEqual({
      fileName: "wallets.csv",
      lineCount: 2,
      value: "wallet 1,0xabc\n\nwallet 2,0xdef"
    });
    expect(JSON.stringify({ fileName: result.fileName, lineCount: result.lineCount })).not.toContain("0xabc");
  });

  it("supports EVM JSON string lists", async () => {
    const result = await readSecretKeyFile(
      makeFile("evm.json", JSON.stringify(["0xabc", "ops,0xdef"]), "application/json"),
      "evm"
    );

    expect(result.value).toBe("0xabc\nops,0xdef");
    expect(result.lineCount).toBe(2);
  });

  it("supports one Solana byte-array key and lists of byte arrays", async () => {
    const single = await readSecretKeyFile(
      makeFile("single.json", JSON.stringify([1, 2, 3]), "application/json"),
      "solana"
    );
    const list = await readSecretKeyFile(
      makeFile("list.json", JSON.stringify([[1, 2, 3], [4, 5, 6]]), "application/json"),
      "solana"
    );

    expect(single).toMatchObject({ lineCount: 1, value: "[1,2,3]" });
    expect(list).toMatchObject({ lineCount: 2, value: "[1,2,3]\n[4,5,6]" });
  });

  it.each([
    makeFile("wallets.exe", "0xabc", "application/octet-stream"),
    makeFile("wallets.json", "[\"0xabc\"]", "application/octet-stream"),
    makeFile("wallets.txt", "0xabc", "text/plain", { size: maxSecretKeyFileBytes + 1 })
  ])("rejects files outside the extension, MIME and size allowlists", async (file) => {
    await expect(readSecretKeyFile(file, "evm")).rejects.toBeInstanceOf(SecretKeyImportError);
  });

  it("rejects unsupported JSON objects without interpolating secret material", async () => {
    const secret = "do-not-print-this-secret";
    const file = makeFile(
      "keystore.json",
      JSON.stringify({ crypto: { ciphertext: secret } }),
      "application/json"
    );

    let message = "";
    try {
      await readSecretKeyFile(file, "evm");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("不支持 Keystore");
    expect(message).not.toContain(secret);
  });

  it("replaces file-read failures with a safe generic error", async () => {
    const secret = "secret-from-upstream-error";
    const file = makeFile("wallets.txt", "", "text/plain", {
      size: 10,
      text: async () => {
        throw new Error(secret);
      }
    });

    let message = "";
    try {
      await readSecretKeyFile(file, "evm");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe("无法读取文件，请确认文件可访问后重试");
    expect(message).not.toContain(secret);
  });

  it("rejects empty, binary and overlong line sets", async () => {
    await expect(readSecretKeyFile(makeFile("empty.txt", " \r\n "), "evm"))
      .rejects.toMatchObject({ code: "empty-file" });
    await expect(readSecretKeyFile(makeFile("binary.txt", "0xabc\0hidden"), "evm"))
      .rejects.toMatchObject({ code: "invalid-content" });

    const tooMany = `${Array.from({ length: maxSecretKeyFileLines + 1 }, () => "0xabc").join("\n")}`;
    await expect(readSecretKeyFile(makeFile("many.txt", tooMany), "evm"))
      .rejects.toMatchObject({ code: "too-many-lines" });
  });

  it("aligns text and JSON key lists with the 1,000-source collection limit", async () => {
    expect(maxSecretKeyFileLines).toBe(1_000);

    const accepted = Array.from({ length: maxSecretKeyFileLines }, () => "0xabc");
    await expect(readSecretKeyFile(
      makeFile("wallets.json", JSON.stringify(accepted), "application/json"),
      "evm"
    )).resolves.toMatchObject({ lineCount: maxSecretKeyFileLines });

    const rejected = [...accepted, "0xdef"];
    await expect(readSecretKeyFile(
      makeFile("wallets.json", JSON.stringify(rejected), "application/json"),
      "evm"
    )).rejects.toMatchObject({ code: "too-many-lines" });
  });

  it("sanitizes control characters in the displayed file name", async () => {
    const result = await readSecretKeyFile(makeFile("wallets\nprivate.txt", "0xabc"), "evm");
    expect(result.fileName).toBe("wallets private.txt");
  });
});
