import { Buffer } from "buffer";
import {
  clusterApiUrl,
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  type SendOptions,
  type TransactionSignature
} from "@solana/web3.js";
import type { SolanaWalletProvider } from "../hooks/useSolanaWallet";
import type { DistributionRow } from "./distribution";

globalThis.Buffer = globalThis.Buffer || Buffer;

export type SolanaNetworkId = "mainnet-beta" | "devnet" | "testnet";
export type DistributionSendStatus = "idle" | "preparing" | "awaiting-wallet" | "confirming" | "success" | "error";

export type SendProgress = {
  confirmed: number;
  signed: number;
  submitted: number;
  total: number;
};

export type DistributionSendState = {
  message: string;
  progress: SendProgress;
  signatures: TransactionSignature[];
  status: DistributionSendStatus;
};

export const fallbackTransfersPerTransaction = 8;
export const solanaLegacyTransactionSizeLimitBytes = 1232;
export const transactionEstimateSenderAddress = "BPFLoader1111111111111111111111111111111111";
export const transactionEstimateBlockhash = "11111111111111111111111111111111";
export const defaultSignatureFeeLamports = 5_000n;

export const solanaNetworks: Array<{ endpoint: string; id: SolanaNetworkId; label: string }> = [
  { endpoint: import.meta.env.VITE_MAINNET_RPC_URL || clusterApiUrl("mainnet-beta"), id: "mainnet-beta", label: "Mainnet" },
  { endpoint: import.meta.env.VITE_DEVNET_RPC_URL || clusterApiUrl("devnet"), id: "devnet", label: "Devnet" },
  { endpoint: import.meta.env.VITE_TESTNET_RPC_URL || clusterApiUrl("testnet"), id: "testnet", label: "Testnet" }
];

export const initialSendProgress: SendProgress = {
  confirmed: 0,
  signed: 0,
  submitted: 0,
  total: 0
};

export const initialSendState: DistributionSendState = {
  message: "",
  progress: initialSendProgress,
  signatures: [],
  status: "idle"
};

export function createSendProgress(total: number, signed = 0, submitted = 0, confirmed = 0): SendProgress {
  return {
    confirmed,
    signed,
    submitted,
    total
  };
}

export function getNetworkConfig(networkId: SolanaNetworkId) {
  return solanaNetworks.find((network) => network.id === networkId) || solanaNetworks[0];
}

export function getExplorerUrl(signature: TransactionSignature, networkId: SolanaNetworkId) {
  const cluster = networkId === "mainnet-beta" ? "" : `?cluster=${networkId}`;
  return `https://solscan.io/tx/${signature}${cluster}`;
}

export function getTransactionErrorMessage(error: unknown) {
  const detail = error && typeof error === "object" && "message" in error ? String((error as { message?: unknown }).message || "") : String(error || "");
  const code = error && typeof error === "object" && "code" in error ? Number((error as { code?: unknown }).code) : 0;

  if (code === 4001 || /reject|declin|cancel/i.test(detail)) return "用户取消了交易确认";
  if (/403|429|failed to fetch|network|fetch/i.test(detail)) return "RPC 请求失败，请更换 RPC 后重试";
  if (/insufficient|Attempt to debit|0x1|余额不足/i.test(detail)) return detail || "钱包余额不足，无法完成本次分发";
  if (/blockhash|expired/i.test(detail)) return "交易区块哈希已过期，请重新提交";
  if (/too large|encoding overruns|transaction too large/i.test(detail)) return "单笔交易过大，请减少本次清单数量";
  if (/timeout/i.test(detail)) return "交易确认超时，请稍后检查链上状态";
  return detail ? `交易发送失败：${detail}` : "交易发送失败，请稍后重试";
}

export function getSignatureFromResult(result: { signature?: TransactionSignature } | TransactionSignature) {
  if (typeof result === "string") return result;
  if (result.signature) return result.signature;
  throw new Error("Wallet returned no transaction signature");
}

export async function sendWalletTransaction(provider: SolanaWalletProvider, transaction: Transaction, connection: Connection) {
  const sendOptions: SendOptions = {
    preflightCommitment: "confirmed",
    skipPreflight: false
  };

  if (provider.signAndSendTransaction) {
    return getSignatureFromResult(await provider.signAndSendTransaction(transaction, sendOptions));
  }

  if (provider.signTransaction) {
    const signedTransaction = await provider.signTransaction(transaction);
    return connection.sendRawTransaction(signedTransaction.serialize(), sendOptions);
  }

  throw new Error("当前钱包不支持交易签名");
}

export function createTransferTransaction(senderAddress: string, rows: DistributionRow[], blockhash: string) {
  const feePayer = new PublicKey(senderAddress);
  const transaction = new Transaction();

  rows.forEach((row) => {
    transaction.add(SystemProgram.transfer({
      fromPubkey: feePayer,
      lamports: row.lamports,
      toPubkey: new PublicKey(row.address)
    }));
  });

  transaction.feePayer = feePayer;
  transaction.recentBlockhash = blockhash;

  return transaction;
}

export function getTransactionSize(transaction: Transaction) {
  return transaction.serialize({
    requireAllSignatures: false,
    verifySignatures: false
  }).length;
}

export function canFitTransferRows(senderAddress: string, rows: DistributionRow[], blockhash = transactionEstimateBlockhash) {
  try {
    return getTransactionSize(createTransferTransaction(senderAddress, rows, blockhash)) <= solanaLegacyTransactionSizeLimitBytes;
  } catch {
    return false;
  }
}

export function planTransferChunks(rows: DistributionRow[], senderAddress: string, blockhash = transactionEstimateBlockhash) {
  const chunks: DistributionRow[][] = [];
  let currentChunk: DistributionRow[] = [];

  rows.forEach((row) => {
    const candidateChunk = [...currentChunk, row];

    if (canFitTransferRows(senderAddress, candidateChunk, blockhash)) {
      currentChunk = candidateChunk;
      return;
    }

    if (currentChunk.length === 0) {
      throw new Error("单笔转账指令过大，无法构造交易");
    }

    chunks.push(currentChunk);
    currentChunk = [row];

    if (!canFitTransferRows(senderAddress, currentChunk, blockhash)) {
      throw new Error("单笔转账指令过大，无法构造交易");
    }
  });

  if (currentChunk.length > 0) chunks.push(currentChunk);
  return chunks;
}

export function getEstimatedTransferChunks(rows: DistributionRow[], senderAddress?: string) {
  try {
    return planTransferChunks(rows, senderAddress || transactionEstimateSenderAddress);
  } catch {
    return rows.length ? rows.reduce<DistributionRow[][]>((chunks, row, index) => {
      if (index % fallbackTransfersPerTransaction === 0) chunks.push([]);
      chunks[chunks.length - 1].push(row);
      return chunks;
    }, []) : [];
  }
}

export async function getBalanceLamports(connection: Connection, address: string) {
  return BigInt(await connection.getBalance(new PublicKey(address), "confirmed"));
}

export async function estimateTransactionFeesLamports(connection: Connection, transactions: Transaction[]) {
  let totalFeeLamports = 0n;

  for (const transaction of transactions) {
    const fee = await connection.getFeeForMessage(transaction.compileMessage(), "confirmed");
    totalFeeLamports += fee.value === null ? defaultSignatureFeeLamports : BigInt(fee.value);
  }

  return totalFeeLamports;
}

export { Connection, type SendOptions, type TransactionSignature };
