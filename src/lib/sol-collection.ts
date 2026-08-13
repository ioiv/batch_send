import { Buffer } from "buffer";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type BlockhashWithExpiryBlockHeight,
  type Commitment,
  type Connection as Web3Connection,
  type Message,
  type SendOptions,
  type TransactionSignature
} from "@solana/web3.js";

globalThis.Buffer = globalThis.Buffer || Buffer;

const base58Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const base58Indexes = new Map(Array.from(base58Alphabet, (character, index) => [character, index]));

export const defaultSolCollectionFeeLamports = 5_000n;

export type SolCollectionParseErrorCode = "empty-key" | "invalid-key" | "invalid-label";

export type SolCollectionParseError = {
  code: SolCollectionParseErrorCode;
  line: number;
  message: string;
};

export type SolCollectionDuplicate = {
  address: string;
  duplicateLine: number;
  originalLine: number;
};

export type SolCollectionSource = {
  address: string;
  keypair: Keypair;
  label?: string;
  line: number;
};

export type SolCollectionSourceParseResult = {
  duplicates: SolCollectionDuplicate[];
  errors: SolCollectionParseError[];
  sources: SolCollectionSource[];
};

export type SolCollectionSkipReason =
  | "below-minimum"
  | "duplicate-source"
  | "insufficient-balance"
  | "same-as-destination"
  | "zero-balance";

export type SolCollectionPlan =
  | {
    status: "ready";
    transferLamports: bigint;
  }
  | {
    reason: Exclude<SolCollectionSkipReason, "duplicate-source" | "same-as-destination">;
    status: "skipped";
    transferLamports: 0n;
  };

export type SolCollectionItemStatus = "error" | "skipped" | "success";

export type SolCollectionItemResult = {
  address: string;
  balanceLamports: bigint;
  feeLamports: bigint;
  label?: string;
  line: number;
  message: string;
  reason?: SolCollectionSkipReason;
  reserveLamports: bigint;
  signature?: TransactionSignature;
  status: SolCollectionItemStatus;
  transferLamports: bigint;
};

export type SolCollectionProgressPhase = "error" | "preparing" | "skipped" | "submitted" | "success";

export type SolCollectionProgress = {
  address: string;
  completed: number;
  current: number;
  label?: string;
  phase: SolCollectionProgressPhase;
  signature?: TransactionSignature;
  total: number;
  transferLamports: bigint;
};

/**
 * This deliberately small interface keeps the collection runner straightforward
 * to test while remaining structurally compatible with a web3.js Connection.
 */
export interface SolCollectionConnection {
  confirmTransaction(
    strategy: BlockhashWithExpiryBlockHeight & { signature: TransactionSignature },
    commitment?: Commitment
  ): Promise<{ value: { err: unknown | null } }>;
  getBalance(publicKey: PublicKey, commitment?: Commitment): Promise<bigint | number>;
  getFeeForMessage(message: Message, commitment?: Commitment): Promise<{ value: number | null }>;
  getLatestBlockhash(commitment?: Commitment): Promise<BlockhashWithExpiryBlockHeight>;
  sendRawTransaction(rawTransaction: Uint8Array, options?: SendOptions): Promise<TransactionSignature>;
}

type AssertTrue<T extends true> = T;
type Web3ConnectionIsCompatible = AssertTrue<Web3Connection extends SolCollectionConnection ? true : false>;

export type CollectSolFromSourcesOptions = {
  commitment?: Commitment;
  connection: SolCollectionConnection;
  destination: PublicKey | string;
  fallbackFeeLamports?: bigint | null;
  minCollectionLamports: bigint;
  onProgress?: (progress: SolCollectionProgress) => void;
  reserveLamports: bigint;
  sendOptions?: SendOptions;
  sources: readonly SolCollectionSource[];
};

class SafeSolCollectionError extends Error {}

class SecretKeyParseError extends Error {
  readonly code: SolCollectionParseErrorCode;

  constructor(code: SolCollectionParseErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function assertNonNegativeLamports(value: bigint, name: string) {
  if (value < 0n) throw new RangeError(`${name} must be non-negative`);
}

function toSafeLamports(value: bigint | number, kind: "balance" | "fee") {
  if (typeof value === "bigint") {
    if (value < 0n) throw new SafeSolCollectionError(kind === "balance" ? "RPC 返回了无效余额" : "RPC 返回了无效手续费");
    return value;
  }

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SafeSolCollectionError(kind === "balance" ? "RPC 返回的余额无法安全换算" : "RPC 返回的手续费无法安全换算");
  }

  return BigInt(value);
}

/** Decode base58 without retaining or exposing the source text in thrown errors. */
export function decodeBase58(value: string) {
  const encoded = value.trim();
  if (!encoded) throw new SecretKeyParseError("empty-key", "密钥不能为空");
  if (encoded.length > 128) throw new SecretKeyParseError("invalid-key", "密钥格式无效");

  let decodedNumber = 0n;

  for (const character of encoded) {
    const index = base58Indexes.get(character);
    if (index === undefined) throw new SecretKeyParseError("invalid-key", "密钥格式无效");
    decodedNumber = decodedNumber * 58n + BigInt(index);
  }

  const bytes: number[] = [];
  while (decodedNumber > 0n) {
    bytes.unshift(Number(decodedNumber & 0xffn));
    decodedNumber >>= 8n;
  }

  let leadingZeros = 0;
  while (encoded[leadingZeros] === "1") leadingZeros += 1;
  return Uint8Array.from([...Array<number>(leadingZeros).fill(0), ...bytes]);
}

export function encodeBase58(value: Uint8Array) {
  if (!value.length) return "";
  let encodedNumber = 0n;
  for (const byte of value) encodedNumber = encodedNumber * 256n + BigInt(byte);

  let encoded = "";
  while (encodedNumber > 0n) {
    encoded = base58Alphabet[Number(encodedNumber % 58n)] + encoded;
    encodedNumber /= 58n;
  }

  let leadingZeros = 0;
  while (leadingZeros < value.length && value[leadingZeros] === 0) leadingZeros += 1;
  return "1".repeat(leadingZeros) + encoded;
}

function parseJsonSecretKey(value: string) {
  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch {
    throw new SecretKeyParseError("invalid-key", "密钥格式无效");
  }

  if (!Array.isArray(parsed) || !parsed.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    throw new SecretKeyParseError("invalid-key", "密钥格式无效");
  }

  return Uint8Array.from(parsed);
}

function deriveKeypair(bytes: Uint8Array) {
  try {
    if (bytes.length === 32) return Keypair.fromSeed(bytes);
    if (bytes.length === 64) return Keypair.fromSecretKey(Uint8Array.from(bytes));
    throw new SecretKeyParseError("invalid-key", "密钥长度无效，应为 32 或 64 字节");
  } catch (error) {
    if (error instanceof SecretKeyParseError) throw error;
    throw new SecretKeyParseError("invalid-key", "密钥内容无效");
  } finally {
    bytes.fill(0);
  }
}

function splitSecretKeyLine(rawLine: string) {
  const trimmed = rawLine.trim();
  if (!trimmed) throw new SecretKeyParseError("empty-key", "密钥不能为空");

  if (trimmed.startsWith("[")) return { key: trimmed, label: undefined };

  const separatorIndex = trimmed.indexOf(",");
  if (separatorIndex < 0) return { key: trimmed, label: undefined };

  const label = trimmed.slice(0, separatorIndex).trim();
  const key = trimmed.slice(separatorIndex + 1).trim();
  if (!label) throw new SecretKeyParseError("invalid-label", "标签不能为空");
  if (!key) throw new SecretKeyParseError("empty-key", "密钥不能为空");
  if (looksLikeSolanaSecret(label)) {
    throw new SecretKeyParseError("invalid-label", "标签疑似包含密钥，已拒绝解析");
  }
  return { key, label };
}

function looksLikeSolanaSecret(value: string) {
  if (value.startsWith("[") || /^\d+(?:\s+\d+){15,}$/.test(value)) return true;
  try {
    const decoded = decodeBase58(value);
    const isSecretLength = decoded.length === 32 || decoded.length === 64;
    decoded.fill(0);
    return isSecretLength;
  } catch {
    return false;
  }
}

/**
 * Parse one source line. Error messages only identify the line and never
 * interpolate the supplied key or label.
 */
export function parseSolanaSecretKeyLine(rawLine: string, line = 1): SolCollectionSource {
  try {
    const { key, label } = splitSecretKeyLine(rawLine);
    const bytes = key.startsWith("[") ? parseJsonSecretKey(key) : decodeBase58(key);
    const keypair = deriveKeypair(bytes);

    return {
      address: keypair.publicKey.toBase58(),
      keypair,
      label,
      line
    };
  } catch (error) {
    const parseError = error instanceof SecretKeyParseError
      ? error
      : new SecretKeyParseError("invalid-key", "密钥格式无效");
    throw new SecretKeyParseError(parseError.code, `第 ${line} 行：${parseError.message}`);
  }
}

/** Parse, derive and address-deduplicate newline-separated local keys. */
export function parseSolanaSourceKeys(input: string): SolCollectionSourceParseResult {
  const result: SolCollectionSourceParseResult = {
    duplicates: [],
    errors: [],
    sources: []
  };
  const firstLineByAddress = new Map<string, number>();

  input.split(/\r?\n/).forEach((rawLine, index) => {
    if (!rawLine.trim()) return;
    const line = index + 1;

    try {
      const source = parseSolanaSecretKeyLine(rawLine, line);
      const originalLine = firstLineByAddress.get(source.address);

      if (originalLine !== undefined) {
        result.duplicates.push({
          address: source.address,
          duplicateLine: line,
          originalLine
        });
        return;
      }

      firstLineByAddress.set(source.address, line);
      result.sources.push(source);
    } catch (error) {
      const parseError = error instanceof SecretKeyParseError
        ? error
        : new SecretKeyParseError("invalid-key", `第 ${line} 行：密钥格式无效`);
      result.errors.push({
        code: parseError.code,
        line,
        message: parseError.message
      });
    }
  });

  return result;
}

export function planSolCollection(options: {
  balanceLamports: bigint;
  feeLamports: bigint;
  minCollectionLamports: bigint;
  reserveLamports: bigint;
}): SolCollectionPlan {
  const { balanceLamports, feeLamports, minCollectionLamports, reserveLamports } = options;
  assertNonNegativeLamports(balanceLamports, "balanceLamports");
  assertNonNegativeLamports(feeLamports, "feeLamports");
  assertNonNegativeLamports(minCollectionLamports, "minCollectionLamports");
  assertNonNegativeLamports(reserveLamports, "reserveLamports");

  if (balanceLamports === 0n) {
    return { reason: "zero-balance", status: "skipped", transferLamports: 0n };
  }

  if (balanceLamports <= feeLamports + reserveLamports) {
    return { reason: "insufficient-balance", status: "skipped", transferLamports: 0n };
  }

  const transferLamports = balanceLamports - feeLamports - reserveLamports;
  if (transferLamports < minCollectionLamports) {
    return { reason: "below-minimum", status: "skipped", transferLamports: 0n };
  }

  return { status: "ready", transferLamports };
}

export function createSolCollectionTransaction(
  source: PublicKey | string,
  destination: PublicKey | string,
  lamports: bigint,
  blockhash: string
) {
  if (lamports <= 0n) throw new RangeError("lamports must be positive");

  const sourcePublicKey = typeof source === "string" ? new PublicKey(source) : source;
  const destinationPublicKey = typeof destination === "string" ? new PublicKey(destination) : destination;
  const transaction = new Transaction({
    feePayer: sourcePublicKey,
    recentBlockhash: blockhash
  });

  transaction.add(SystemProgram.transfer({
    fromPubkey: sourcePublicKey,
    lamports,
    toPubkey: destinationPublicKey
  }));
  return transaction;
}

export function getSafeSolCollectionErrorMessage(error: unknown) {
  if (error instanceof SafeSolCollectionError) return error.message;

  const detail = error instanceof Error ? error.message : String(error ?? "");
  if (/429|rate.?limit|too many requests/i.test(detail)) return "RPC 请求过于频繁，请稍后重试";
  if (/403|failed to fetch|network|fetch/i.test(detail)) return "RPC 网络请求失败，请检查节点后重试";
  if (/blockhash|expired/i.test(detail)) return "交易区块哈希已过期，请重新归集";
  if (/insufficient|attempt to debit|0x1/i.test(detail)) return "来源钱包余额不足，无法完成归集";
  if (/simulation|preflight/i.test(detail)) return "交易预检失败，请检查余额和目标地址";
  return "归集失败，请稍后重试";
}

function getSkipMessage(reason: SolCollectionSkipReason) {
  switch (reason) {
    case "zero-balance": return "余额为 0，已跳过";
    case "insufficient-balance": return "余额不足以支付手续费和保留金额，已跳过";
    case "below-minimum": return "可归集余额低于最小阈值，已跳过";
    case "same-as-destination": return "来源地址与归集地址相同，已跳过";
    case "duplicate-source": return "来源地址重复，已跳过";
  }
}

function emitProgress(callback: CollectSolFromSourcesOptions["onProgress"], progress: SolCollectionProgress) {
  try {
    callback?.(progress);
  } catch {
    // UI progress handlers must not interrupt signing or leave a batch half-run.
  }
}

export async function collectSolFromSources(options: CollectSolFromSourcesOptions) {
  const {
    commitment = "confirmed",
    connection,
    destination,
    fallbackFeeLamports = defaultSolCollectionFeeLamports,
    minCollectionLamports,
    onProgress,
    reserveLamports,
    sendOptions = { preflightCommitment: "confirmed", skipPreflight: false },
    sources
  } = options;

  assertNonNegativeLamports(minCollectionLamports, "minCollectionLamports");
  assertNonNegativeLamports(reserveLamports, "reserveLamports");
  if (fallbackFeeLamports !== null) assertNonNegativeLamports(fallbackFeeLamports, "fallbackFeeLamports");

  let destinationPublicKey: PublicKey;
  try {
    destinationPublicKey = typeof destination === "string" ? new PublicKey(destination) : destination;
  } catch {
    throw new SafeSolCollectionError("归集目标地址无效");
  }

  const destinationAddress = destinationPublicKey.toBase58();
  const seenAddresses = new Set<string>();
  const results: SolCollectionItemResult[] = [];

  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    const address = source.keypair.publicKey.toBase58();
    let balanceLamports = 0n;
    let feeLamports = 0n;
    let submittedSignature: TransactionSignature | undefined;
    let broadcastAcknowledged = false;
    let transferLamports = 0n;

    emitProgress(onProgress, {
      address,
      completed: results.length,
      current: index + 1,
      label: source.label,
      phase: "preparing",
      total: sources.length,
      transferLamports
    });

    const finishSkipped = (reason: SolCollectionSkipReason) => {
      const result: SolCollectionItemResult = {
        address,
        balanceLamports,
        feeLamports,
        label: source.label,
        line: source.line,
        message: getSkipMessage(reason),
        reason,
        reserveLamports,
        status: "skipped",
        transferLamports: 0n
      };
      results.push(result);
      emitProgress(onProgress, {
        address,
        completed: results.length,
        current: index + 1,
        label: source.label,
        phase: "skipped",
        total: sources.length,
        transferLamports: 0n
      });
    };

    try {
      if (source.address !== address) throw new SafeSolCollectionError("来源钱包信息不一致，已停止处理该项");
      if (seenAddresses.has(address)) {
        finishSkipped("duplicate-source");
        continue;
      }
      seenAddresses.add(address);

      if (address === destinationAddress) {
        finishSkipped("same-as-destination");
        continue;
      }

      balanceLamports = toSafeLamports(await connection.getBalance(source.keypair.publicKey, commitment), "balance");
      if (balanceLamports === 0n) {
        finishSkipped("zero-balance");
        continue;
      }

      const latestBlockhash = await connection.getLatestBlockhash(commitment);
      const feeProbe = createSolCollectionTransaction(
        source.keypair.publicKey,
        destinationPublicKey,
        1n,
        latestBlockhash.blockhash
      );
      const feeResponse = await connection.getFeeForMessage(feeProbe.compileMessage(), commitment);
      if (feeResponse.value === null && fallbackFeeLamports === null) {
        throw new SafeSolCollectionError("RPC 无法估算交易手续费，已停止处理该项");
      }
      feeLamports = feeResponse.value === null
        ? fallbackFeeLamports as bigint
        : toSafeLamports(feeResponse.value, "fee");

      const plan = planSolCollection({
        balanceLamports,
        feeLamports,
        minCollectionLamports,
        reserveLamports
      });
      if (plan.status === "skipped") {
        finishSkipped(plan.reason);
        continue;
      }
      transferLamports = plan.transferLamports;

      const transaction = createSolCollectionTransaction(
        source.keypair.publicKey,
        destinationPublicKey,
        transferLamports,
        latestBlockhash.blockhash
      );
      transaction.sign(source.keypair);

      if (!transaction.signature) throw new SafeSolCollectionError("交易签名失败，已停止处理该项");
      submittedSignature = encodeBase58(transaction.signature);

      const rpcSignature = await connection.sendRawTransaction(transaction.serialize(), sendOptions);
      if (rpcSignature !== submittedSignature) {
        throw new SafeSolCollectionError("RPC 返回的交易签名不一致，提交状态需要人工核对");
      }
      broadcastAcknowledged = true;
      emitProgress(onProgress, {
        address,
        completed: results.length,
        current: index + 1,
        label: source.label,
        phase: "submitted",
        signature: submittedSignature,
        total: sources.length,
        transferLamports
      });

      const confirmation = await connection.confirmTransaction({
        ...latestBlockhash,
        signature: submittedSignature
      }, commitment);
      if (confirmation.value.err) throw new SafeSolCollectionError("交易已提交但链上执行失败");

      const result: SolCollectionItemResult = {
        address,
        balanceLamports,
        feeLamports,
        label: source.label,
        line: source.line,
        message: "归集成功",
        reserveLamports,
        signature: submittedSignature,
        status: "success",
        transferLamports
      };
      results.push(result);
      emitProgress(onProgress, {
        address,
        completed: results.length,
        current: index + 1,
        label: source.label,
        phase: "success",
        signature: submittedSignature,
        total: sources.length,
        transferLamports
      });
    } catch (error) {
      const result: SolCollectionItemResult = {
        address,
        balanceLamports,
        feeLamports,
        label: source.label,
        line: source.line,
        message: submittedSignature
          ? broadcastAcknowledged
            ? "交易已提交但确认失败，请先查链上状态，勿盲目重发"
            : "交易已签名且提交状态不确定，请先用交易签名查链上状态，勿盲目重发"
          : getSafeSolCollectionErrorMessage(error),
        reserveLamports,
        signature: submittedSignature,
        status: "error",
        transferLamports
      };
      results.push(result);
      emitProgress(onProgress, {
        address,
        completed: results.length,
        current: index + 1,
        label: source.label,
        phase: "error",
        signature: submittedSignature,
        total: sources.length,
        transferLamports
      });
    }
  }

  return results;
}
