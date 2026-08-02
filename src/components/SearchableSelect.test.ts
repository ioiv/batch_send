import { describe, expect, it } from "vitest";
import {
  filterSearchableSelectOptions,
  type SearchableSelectOption
} from "./SearchableSelect";

const options = [
  {
    keywords: ["ether", "mainnet"],
    label: "Ethereum",
    meta: "1",
    value: "ethereum"
  },
  {
    keywords: ["binance smart chain", "mainnet"],
    label: "BNB Chain",
    meta: "56",
    value: "bsc"
  },
  {
    keywords: ["layer 2", "mainnet"],
    label: "Arbitrum",
    meta: "42161",
    value: "arbitrum-one"
  },
  {
    keywords: ["testnet"],
    label: "Base Sepolia",
    meta: "84532",
    value: "base-sepolia"
  }
] as const satisfies readonly SearchableSelectOption<string>[];

describe("filterSearchableSelectOptions", () => {
  it("preserves option order for an empty query", () => {
    expect(filterSearchableSelectOptions(options, "  \t ").map((option) => option.value)).toEqual([
      "ethereum",
      "bsc",
      "arbitrum-one",
      "base-sepolia"
    ]);
  });

  it("matches option names case-insensitively", () => {
    expect(filterSearchableSelectOptions(options, "bNb ChAiN")).toEqual([options[1]]);
  });

  it("matches numeric metadata such as a Chain ID", () => {
    expect(filterSearchableSelectOptions(options, "42161")).toEqual([options[2]]);
  });

  it("prefers an exact numeric Chain ID over longer prefix matches", () => {
    const optionsWithBase = [
      ...options,
      { label: "Base", meta: "8453", value: "base" }
    ] as const satisfies readonly SearchableSelectOption<string>[];

    expect(filterSearchableSelectOptions(optionsWithBase, "8453")).toEqual([optionsWithBase[4]]);
  });

  it("matches both keywords and internal IDs", () => {
    expect(filterSearchableSelectOptions(options, "binance")).toEqual([options[1]]);
    expect(filterSearchableSelectOptions(options, "arbitrum-one")).toEqual([options[2]]);
  });

  it("requires every search term to match the combined option text", () => {
    expect(filterSearchableSelectOptions(options, "base testnet 84532")).toEqual([options[3]]);
  });

  it("returns no options when nothing matches", () => {
    expect(filterSearchableSelectOptions(options, "solana 101")).toEqual([]);
  });
});
