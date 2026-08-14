import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import {
  expandNftTokenIds,
  mergeNftAssetInput,
  parseNftAssetFile
} from "./nft-asset-input";

const nftContract = "0x00000000000000000000000000000000000000b2";
const anotherContract = "0x00000000000000000000000000000000000000c3";
const checksummedContract = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const invalidChecksumContract = "0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const uint256Max = (1n << 256n) - 1n;

describe("expandNftTokenIds", () => {
  it("expands inclusive ranges across comma, space, and newline separators", () => {
    const result = expandNftTokenIds("1, 2\n3-5 0005\t2");

    expect(result.values).toEqual(["1", "2", "3", "4", "5"]);
    expect(result.tokenIds).toEqual([1n, 2n, 3n, 4n, 5n]);
    expect(result.duplicates).toBe(2);
    expect(result.issues).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("returns Chinese display-safe issues for malformed, negative, and reversed values", () => {
    const result = expandNftTokenIds("-1 nope 8-3");

    expect(result.tokenIds).toEqual([]);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "invalid-token-id",
      "invalid-token-id",
      "invalid-range"
    ]);
    expect(result.issues.every((issue) => issue.severity === "error")).toBe(true);
    expect(JSON.stringify(result.issues)).not.toContain("nope");
  });

  it("accepts uint256 max and rejects values above the NFT ABI range", () => {
    const result = expandNftTokenIds(`${uint256Max} ${uint256Max + 1n}`);

    expect(result.tokenIds).toEqual([uint256Max]);
    expect(result.issues).toMatchObject([{ code: "token-id-out-of-range" }]);
  });

  it("rejects a huge range before expansion", () => {
    const result = expandNftTokenIds("1-999999999999999999999999", { maxItems: 20 });

    expect(result.tokenIds).toEqual([]);
    expect(result.truncated).toBe(true);
    expect(result.issues).toMatchObject([{ code: "item-limit" }]);
  });

  it("enforces the configured unique-item limit without throwing", () => {
    expect(() => expandNftTokenIds("1 2 3", { maxItems: 2 })).not.toThrow();
    const result = expandNftTokenIds("1 2 3", { maxItems: 2 });

    expect(result.values).toEqual(["1", "2"]);
    expect(result.truncated).toBe(true);
    expect(result.issues).toMatchObject([{ code: "item-limit", item: 3 }]);
  });
});

describe("parseNftAssetFile", () => {
  it("parses BOM-prefixed CSV/TXT rows, an optional header, and quoted fields", () => {
    const result = parseNftAssetFile(
      `\uFEFFcontract_address,token_id\n"${nftContract}","1"\n${anotherContract} 2`
    );

    expect(result.invalid).toBe(0);
    expect(result.valid).toBe(2);
    expect(result.rows.map((row) => row.status)).toEqual(["header", "valid", "valid"]);
    expect(result.lines).toEqual([
      `${getAddress(nftContract)},1`,
      `${getAddress(anotherContract)},2`
    ]);
    expect(result.serialized).toBe(result.lines.join("\n"));
  });

  it("deduplicates by normalized contract and exact bigint Token ID", () => {
    const normalizedContract = getAddress(anotherContract);
    const result = parseNftAssetFile(
      `${anotherContract},0007\n${normalizedContract},7\n${anotherContract},8`
    );

    expect(result.valid).toBe(2);
    expect(result.duplicates).toBe(1);
    expect(result.rows.map((row) => row.status)).toEqual(["valid", "duplicate", "valid"]);
    expect(result.issues).toMatchObject([{ code: "duplicate-row", severity: "warning", line: 2 }]);
  });

  it("accepts a valid EIP-55 address and rejects an invalid mixed-case checksum", () => {
    const result = parseNftAssetFile(
      `${checksummedContract},1\n${invalidChecksumContract},2`
    );

    expect(result.lines).toEqual([`${checksummedContract},1`]);
    expect(result.valid).toBe(1);
    expect(result.invalid).toBe(1);
    expect(result.rows.map((row) => row.status)).toEqual(["valid", "invalid"]);
    expect(result.issues).toEqual([expect.objectContaining({
      code: "invalid-contract",
      line: 2
    })]);
  });

  it("reports malformed rows, bad contracts, negatives, and out-of-range IDs", () => {
    const result = parseNftAssetFile([
      "only-one-column",
      "not-an-address,1",
      `${nftContract},-1`,
      `${nftContract},${uint256Max + 1n}`
    ].join("\n"));

    expect(result.valid).toBe(0);
    expect(result.invalid).toBe(4);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "invalid-row",
      "invalid-contract",
      "invalid-token-id",
      "token-id-out-of-range"
    ]);
    expect(result.issues.every((issue) => issue.message.includes(`第 ${issue.line} 行`))).toBe(true);
  });

  it("stops at the import limit and returns the safe serialized subset", () => {
    const result = parseNftAssetFile([
      `${nftContract},1`,
      `${nftContract},2`,
      `${nftContract},3`
    ].join("\n"), { maxItems: 2 });

    expect(result.lines).toHaveLength(2);
    expect(result.invalid).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.issues.at(-1)).toMatchObject({ code: "item-limit", line: 3 });
  });
});

describe("mergeNftAssetInput", () => {
  it("serializes one contract plus a range into existing contract,tokenId rows", () => {
    const existing = `${anotherContract},9`;
    const result = mergeNftAssetInput(existing, nftContract, "1-3,2");

    expect(result.added).toBe(3);
    expect(result.duplicates).toBe(1);
    expect(result.lines).toEqual([
      `${getAddress(anotherContract)},9`,
      `${getAddress(nftContract)},1`,
      `${getAddress(nftContract)},2`,
      `${getAddress(nftContract)},3`
    ]);
    expect(result.serialized).toBe(result.lines.join("\n"));
  });

  it("does not append rows already present in the existing input", () => {
    const result = mergeNftAssetInput(
      `${nftContract},2`,
      nftContract,
      "1-3"
    );

    expect(result.added).toBe(2);
    expect(result.duplicates).toBe(1);
    expect(result.lines.map((line) => line.split(",")[1])).toEqual(["2", "1", "3"]);
  });

  it("keeps the existing text unchanged when new input contains an error", () => {
    const existing = `${nftContract},7`;
    const result = mergeNftAssetInput(existing, nftContract, "1-3 bad");

    expect(result.added).toBe(0);
    expect(result.serialized).toBe(`${getAddress(nftContract)},7`);
    expect(result.issues).toMatchObject([{ code: "invalid-token-id" }]);
  });

  it("does not repair or append a contract with an invalid EIP-55 checksum", () => {
    const existing = `${nftContract},7`;
    const result = mergeNftAssetInput(existing, invalidChecksumContract, "1-3");

    expect(result.added).toBe(0);
    expect(result.serialized).toBe(`${getAddress(nftContract)},7`);
    expect(result.issues).toEqual([expect.objectContaining({ code: "invalid-contract" })]);
  });

  it("keeps the existing list when the merged result would exceed the limit", () => {
    const existing = `${nftContract},1\n${nftContract},2`;
    const result = mergeNftAssetInput(existing, nftContract, "3", { maxItems: 2 });

    expect(result.added).toBe(0);
    expect(result.lines).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.issues).toMatchObject([{ code: "item-limit" }]);
  });
});
