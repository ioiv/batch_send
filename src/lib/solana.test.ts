import { describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import type { DistributionRow } from "./distribution";
import {
  assertSolanaRpcNetwork,
  planTransferChunks,
  solanaGenesisHashes,
  transactionEstimateSenderAddress
} from "./solana";

function makeAddress(index: number) {
  const bytes = new Uint8Array(32);
  bytes[31] = index + 1;
  return new PublicKey(bytes).toBase58();
}

function makeRow(index: number, address = makeAddress(index)): DistributionRow {
  return {
    address,
    amount: 0.1,
    amountRaw: "0.1",
    lamports: 100_000_000n,
    line: index + 1,
    problems: [],
    status: "valid"
  };
}

describe("planTransferChunks", () => {
  it("returns no chunks for an empty list", () => {
    expect(planTransferChunks([], transactionEstimateSenderAddress)).toEqual([]);
  });

  it("keeps small lists in a single ordered chunk", () => {
    const rows = Array.from({ length: 3 }, (_, index) => makeRow(index));
    const chunks = planTransferChunks(rows, transactionEstimateSenderAddress);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual(rows);
  });

  it("splits rows before legacy transaction size is exceeded", () => {
    const rows = Array.from({ length: 22 }, (_, index) => makeRow(index));
    const chunks = planTransferChunks(rows, transactionEstimateSenderAddress);

    expect(chunks.map((chunk) => chunk.length)).toEqual([21, 1]);
    expect(chunks.flat()).toEqual(rows);
  });

  it("throws when a row cannot be converted into a transfer instruction", () => {
    expect(() => planTransferChunks([makeRow(0, "not-an-address")], transactionEstimateSenderAddress)).toThrow();
  });
});

describe("assertSolanaRpcNetwork", () => {
  it.each([
    ["mainnet-beta", "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"],
    ["devnet", "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"],
    ["testnet", "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY"]
  ] as const)("accepts the canonical %s genesis hash", async (networkId, genesisHash) => {
    const connection = { getGenesisHash: vi.fn(async () => genesisHash) };
    await expect(assertSolanaRpcNetwork(connection as never, networkId)).resolves.toBeUndefined();
  });

  it("blocks a mismatched RPC cluster", async () => {
    const connection = { getGenesisHash: vi.fn(async () => solanaGenesisHashes["mainnet-beta"]) };
    await expect(assertSolanaRpcNetwork(connection as never, "devnet"))
      .rejects.toThrow("RPC 网络不匹配");
  });
});
