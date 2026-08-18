import { Keypair, PublicKey, SystemInstruction, Transaction } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import {
  collectSolFromSources,
  createSolCollectionTransaction,
  decodeBase58,
  encodeBase58,
  getSafeSolCollectionErrorMessage,
  parseSolanaSecretKeyLine,
  parseSolanaSourceKeys,
  planSolCollection,
  preflightSolCollectionSources,
  type SolCollectionConnection,
  type SolCollectionProgress,
  type SolCollectionSource
} from "./sol-collection";
import { maximumCollectionSources } from "./collection-workload";

const testBlockhash = "11111111111111111111111111111111";

function encodeBase58ForTest(value: Uint8Array) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let number = 0n;
  value.forEach((byte) => {
    number = number * 256n + BigInt(byte);
  });

  let encoded = "";
  while (number > 0n) {
    encoded = alphabet[Number(number % 58n)] + encoded;
    number /= 58n;
  }

  let leadingZeros = 0;
  while (value[leadingZeros] === 0) leadingZeros += 1;
  return "1".repeat(leadingZeros) + encoded;
}

function makeKeypair(seedByte: number) {
  return Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => seedByte));
}

function makeSource(seedByte: number, line = seedByte): SolCollectionSource {
  const keypair = makeKeypair(seedByte);
  return {
    address: keypair.publicKey.toBase58(),
    keypair,
    label: `wallet-${seedByte}`,
    line
  };
}

function makeConnection(overrides: Partial<SolCollectionConnection> = {}) {
  return {
    confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
    getBalance: vi.fn(async () => 100_000),
    getFeeForMessage: vi.fn(async () => ({ value: 5_000 })),
    getLatestBlockhash: vi.fn(async () => ({ blockhash: testBlockhash, lastValidBlockHeight: 100 })),
    sendRawTransaction: vi.fn(async (rawTransaction: Uint8Array) => (
      encodeBase58(Transaction.from(rawTransaction).signature!)
    )),
    ...overrides
  } as unknown as SolCollectionConnection;
}

describe("Solana source key parsing", () => {
  it("decodes base58 including leading zero bytes", () => {
    const bytes = Uint8Array.from([0, 0, 1, 2, 255]);
    expect(decodeBase58(encodeBase58ForTest(bytes))).toEqual(bytes);
  });

  it("parses base58, JSON arrays and optional labels", () => {
    const base58Keypair = makeKeypair(3);
    const jsonKeypair = makeKeypair(4);
    const base58Source = parseSolanaSecretKeyLine(`hot wallet,${encodeBase58ForTest(base58Keypair.secretKey)}`, 7);
    const jsonSource = parseSolanaSecretKeyLine(JSON.stringify(Array.from(jsonKeypair.secretKey)), 8);

    expect(base58Source).toMatchObject({
      address: base58Keypair.publicKey.toBase58(),
      label: "hot wallet",
      line: 7
    });
    expect(jsonSource).toMatchObject({
      address: jsonKeypair.publicKey.toBase58(),
      label: undefined,
      line: 8
    });
  });

  it("accepts a 32-byte seed and derives its public key", () => {
    const seed = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const source = parseSolanaSecretKeyLine(encodeBase58ForTest(seed), 1);
    expect(source.address).toBe(Keypair.fromSeed(seed).publicKey.toBase58());
  });

  it("deduplicates derived addresses while preserving original line numbers", () => {
    const key = encodeBase58ForTest(makeKeypair(5).secretKey);
    const result = parseSolanaSourceKeys(`first,${key}\n\nsecond,${key}`);

    expect(result.errors).toEqual([]);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ label: "first", line: 1 });
    expect(result.duplicates).toEqual([{
      address: result.sources[0].address,
      duplicateLine: 3,
      originalLine: 1
    }]);
  });

  it("never repeats rejected private key material in parser errors", () => {
    const privateMaterial = "NEVER_REPEAT_THIS_PRIVATE_KEY!";
    const result = parseSolanaSourceKeys(`sensitive,${privateMaterial}`);

    expect(result.errors).toHaveLength(1);
    expect(JSON.stringify(result.errors)).not.toContain(privateMaterial);
    expect(() => parseSolanaSecretKeyLine(privateMaterial, 9)).toThrow("第 9 行：密钥格式无效");
  });

  it("rejects a label that itself looks like private key material", () => {
    const firstSecret = encodeBase58ForTest(makeKeypair(21).secretKey);
    const secondSecret = encodeBase58ForTest(makeKeypair(22).secretKey);
    const result = parseSolanaSourceKeys(`${firstSecret},${secondSecret}`);

    expect(result.sources).toHaveLength(0);
    expect(result.errors).toMatchObject([{
      code: "invalid-label",
      message: "第 1 行：标签疑似包含密钥，已拒绝解析"
    }]);
    expect(JSON.stringify(result.errors)).not.toContain(firstSecret);
    expect(JSON.stringify(result.errors)).not.toContain(secondSecret);
  });

  it("rejects oversized source sets before deriving any keypair", () => {
    const input = Array.from({ length: maximumCollectionSources + 1 }, () => "invalid-key").join("\n");
    const result = parseSolanaSourceKeys(input);

    expect(result.sources).toEqual([]);
    expect(result.errors).toEqual([expect.objectContaining({ code: "input-limit" })]);
  });

  it("rejects oversized JSON arrays before parsing attacker-controlled content", () => {
    const oversizedJson = `[${"1,".repeat(300)}1]`;
    const result = parseSolanaSourceKeys(oversizedJson);

    expect(result.sources).toEqual([]);
    expect(result.errors).toEqual([expect.objectContaining({ code: "invalid-key" })]);
  });
});

describe("SOL collection planning", () => {
  it("subtracts the estimated fee and requested reserve", () => {
    expect(planSolCollection({
      balanceLamports: 100_000n,
      feeLamports: 5_000n,
      minCollectionLamports: 10_000n,
      reserveLamports: 20_000n
    })).toEqual({ status: "ready", transferLamports: 75_000n });
  });

  it("skips zero, insufficient and below-threshold balances", () => {
    expect(planSolCollection({
      balanceLamports: 0n,
      feeLamports: 5_000n,
      minCollectionLamports: 0n,
      reserveLamports: 0n
    })).toMatchObject({ reason: "zero-balance", status: "skipped" });
    expect(planSolCollection({
      balanceLamports: 10_000n,
      feeLamports: 5_000n,
      minCollectionLamports: 0n,
      reserveLamports: 5_000n
    })).toMatchObject({ reason: "insufficient-balance", status: "skipped" });
    expect(planSolCollection({
      balanceLamports: 20_000n,
      feeLamports: 5_000n,
      minCollectionLamports: 20_000n,
      reserveLamports: 0n
    })).toMatchObject({ reason: "below-minimum", status: "skipped" });
  });

  it("builds one System Program transfer with the source as fee payer", () => {
    const source = makeKeypair(6);
    const destination = makeKeypair(7);
    const transaction = createSolCollectionTransaction(
      source.publicKey,
      destination.publicKey,
      12_345n,
      testBlockhash
    );
    const decoded = SystemInstruction.decodeTransfer(transaction.instructions[0]);

    expect(transaction.feePayer?.equals(source.publicKey)).toBe(true);
    expect(transaction.recentBlockhash).toBe(testBlockhash);
    expect(decoded.fromPubkey.equals(source.publicKey)).toBe(true);
    expect(decoded.toPubkey.equals(destination.publicKey)).toBe(true);
    expect(decoded.lamports).toBe(12_345n);
  });

  it("preflights balances and fees without signing or broadcasting", async () => {
    const readySource = makeSource(23);
    const emptySource = makeSource(24);
    const destination = makeKeypair(25).publicKey;
    const connection = makeConnection({
      getBalance: vi.fn(async (publicKey: PublicKey) => (
        publicKey.equals(readySource.keypair.publicKey) ? 100_000 : 0
      ))
    });

    const result = await preflightSolCollectionSources({
      connection,
      destination,
      minCollectionLamports: 1n,
      reserveLamports: 10_000n,
      sources: [readySource, emptySource]
    });

    expect(result).toMatchObject({
      errorSources: 0,
      estimatedNetworkFeeLamports: 5_000n,
      executableSources: 1,
      skippedSources: 1,
      totalBalanceLamports: 100_000n,
      totalTransferLamports: 85_000n
    });
    expect(result.items.map((item) => item.status)).toEqual(["ready", "skipped"]);
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
    expect(connection.confirmTransaction).not.toHaveBeenCalled();
  });

  it("keeps per-source RPC failures in the read-only preflight result", async () => {
    const source = makeSource(26);
    const connection = makeConnection({
      getBalance: vi.fn(async () => {
        throw new Error("failed to fetch");
      })
    });

    const result = await preflightSolCollectionSources({
      connection,
      destination: makeKeypair(27).publicKey,
      minCollectionLamports: 1n,
      reserveLamports: 0n,
      sources: [source]
    });

    expect(result.errorSources).toBe(1);
    expect(result.executableSources).toBe(0);
    expect(result.items[0]).toMatchObject({
      message: "RPC 网络请求失败，请检查节点后重试",
      status: "error"
    });
  });
});

describe("collectSolFromSources", () => {
  it("skips the destination wallet before making any RPC request", async () => {
    const source = makeSource(8);
    const connection = makeConnection();
    const results = await collectSolFromSources({
      connection,
      destination: source.address,
      minCollectionLamports: 1n,
      reserveLamports: 10_000n,
      sources: [source]
    });

    expect(results).toMatchObject([{
      address: source.address,
      reason: "same-as-destination",
      status: "skipped",
      transferLamports: 0n
    }]);
    expect(connection.getBalance).not.toHaveBeenCalled();
  });

  it("estimates, signs, sends and confirms the planned transfer", async () => {
    const source = makeSource(9);
    const destination = makeKeypair(10).publicKey;
    let submittedTransaction: Transaction | undefined;
    const connection = makeConnection({
      sendRawTransaction: vi.fn(async (rawTransaction: Uint8Array) => {
        submittedTransaction = Transaction.from(rawTransaction);
        return encodeBase58(submittedTransaction.signature!);
      })
    });
    const progress: SolCollectionProgress[] = [];

    const results = await collectSolFromSources({
      connection,
      destination,
      minCollectionLamports: 1n,
      onProgress: (event) => progress.push(event),
      reserveLamports: 10_000n,
      sources: [source]
    });

    expect(results).toMatchObject([{
      address: source.address,
      balanceLamports: 100_000n,
      feeLamports: 5_000n,
      signature: encodeBase58(submittedTransaction!.signature!),
      status: "success",
      transferLamports: 85_000n
    }]);
    expect(connection.getFeeForMessage).toHaveBeenCalledOnce();
    expect(connection.confirmTransaction).toHaveBeenCalledWith({
      blockhash: testBlockhash,
      lastValidBlockHeight: 100,
      signature: encodeBase58(submittedTransaction!.signature!)
    }, "confirmed");
    expect(submittedTransaction).toBeDefined();
    const decoded = SystemInstruction.decodeTransfer(submittedTransaction!.instructions[0]);
    expect(decoded.lamports).toBe(85_000n);
    expect(submittedTransaction!.signatures[0].signature).not.toBeNull();
    expect(progress.map((event) => event.phase)).toEqual(["preparing", "submitted", "success"]);
  });

  it("continues after an item fails and sanitizes the failure message", async () => {
    const sources = [makeSource(11), makeSource(12)];
    const exposedSecret = encodeBase58ForTest(sources[0].keypair.secretKey);
    const connection = makeConnection({
      sendRawTransaction: vi.fn(async (rawTransaction: Uint8Array) => {
        const transaction = Transaction.from(rawTransaction);
        if (transaction.feePayer?.equals(sources[0].keypair.publicKey)) {
          throw new Error(`RPC rejected private material ${exposedSecret}`);
        }
        return encodeBase58(transaction.signature!);
      })
    });

    const results = await collectSolFromSources({
      connection,
      destination: new PublicKey(makeKeypair(13).publicKey),
      minCollectionLamports: 1n,
      reserveLamports: 10_000n,
      sources
    });

    expect(results.map((result) => result.status)).toEqual(["error", "success"]);
    expect(results[0].transferLamports).toBe(85_000n);
    expect(results[0].message).not.toContain(exposedSecret);
    expect(results[1].signature).toBeTruthy();
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(2);
  });

  it("retains a submitted signature when confirmation reports an error", async () => {
    const source = makeSource(14);
    const connection = makeConnection({
      confirmTransaction: vi.fn(async () => ({ value: { err: { InstructionError: [0, "Custom"] } } })),
      sendRawTransaction: vi.fn(async (rawTransaction: Uint8Array) => (
        encodeBase58(Transaction.from(rawTransaction).signature!)
      ))
    });

    const results = await collectSolFromSources({
      connection,
      destination: makeKeypair(15).publicKey,
      minCollectionLamports: 1n,
      reserveLamports: 10_000n,
      sources: [source]
    });

    expect(results).toMatchObject([{
      message: "交易已提交但确认失败，请先查链上状态，勿盲目重发",
      signature: expect.any(String),
      status: "error",
      transferLamports: 85_000n
    }]);
  });

  it("retains the signature and warns against resending when confirmation throws", async () => {
    const source = makeSource(16);
    const progress: SolCollectionProgress[] = [];
    const connection = makeConnection({
      confirmTransaction: vi.fn(async () => {
        throw new Error("confirmation RPC timed out");
      }),
      sendRawTransaction: vi.fn(async (rawTransaction: Uint8Array) => (
        encodeBase58(Transaction.from(rawTransaction).signature!)
      ))
    });

    const results = await collectSolFromSources({
      connection,
      destination: makeKeypair(17).publicKey,
      minCollectionLamports: 1n,
      onProgress: (event) => progress.push(event),
      reserveLamports: 10_000n,
      sources: [source]
    });

    expect(results).toMatchObject([{
      message: "交易已提交但确认失败，请先查链上状态，勿盲目重发",
      signature: expect.any(String),
      status: "error",
      transferLamports: 85_000n
    }]);
    expect(progress.at(-1)).toMatchObject({
      phase: "error",
      signature: expect.any(String)
    });
  });

  it("retains the locally derived signature when broadcast acknowledgement is lost", async () => {
    const source = makeSource(23);
    const connection = makeConnection({
      sendRawTransaction: vi.fn(async () => {
        throw new Error("network response lost");
      })
    });

    const [result] = await collectSolFromSources({
      connection,
      destination: makeKeypair(24).publicKey,
      minCollectionLamports: 1n,
      reserveLamports: 10_000n,
      sources: [source]
    });

    expect(result.status).toBe("error");
    expect(result.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    expect(result.message).toContain("提交状态不确定");
    expect(connection.confirmTransaction).not.toHaveBeenCalled();
  });

  it("uses a safe generic message rather than arbitrary error text", () => {
    const secret = "do-not-display-this-secret";
    const message = getSafeSolCollectionErrorMessage(new Error(secret));
    expect(message).toBe("归集失败，请稍后重试");
    expect(message).not.toContain(secret);
  });
});
