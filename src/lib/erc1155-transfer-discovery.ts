import {
  getAddress,
  isAddress,
  parseAbi,
  parseAbiItem,
  zeroAddress,
  type Address,
  type PublicClient
} from "viem";
import {
  maximumCollectionSources,
  maximumEvmCollectionAssets,
  maximumEvmCollectionChecks
} from "./collection-workload";
import type { EvmCollectionAsset } from "./evm-collection";

const transferSingleEvent = parseAbiItem(
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)"
);
const transferBatchEvent = parseAbiItem(
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)"
);
const erc1155BalanceAbi = parseAbi([
  "function balanceOf(address account, uint256 id) view returns (uint256)"
]);

const defaultBlockSpan = 250_000n;
const minimumBlockSpan = 1n;
const defaultRpcBudget = 5_000;
const secretPattern = /0x[0-9a-fA-F]{64}/g;
const rpcUrlPattern = /https?:\/\/\S+/gi;

export type Erc1155TransferDiscoveryIssue = {
  code:
    | "invalid-input"
    | "balance-read-failed"
    | "log-query-failed"
    | "rpc-budget-exceeded"
    | "token-limit-exceeded";
  message: string;
};

export type Erc1155TransferDiscoveryProgress = {
  candidateCount: number;
  fromBlock: bigint;
  rpcRequests: number;
  stage: "reading-events" | "verifying-balance";
  toBlock: bigint;
};

export type Erc1155TransferDiscoveryClient = Pick<
  PublicClient,
  "getBlockNumber" | "getLogs" | "readContract"
>;

export type Erc1155TransferDiscoveryResult = {
  assets: Extract<EvmCollectionAsset, { standard: "erc1155" }>[];
  candidateCount: number;
  complete: boolean;
  fromBlock: bigint;
  issues: Erc1155TransferDiscoveryIssue[];
  latestBlock: bigint;
  rpcRequests: number;
};

function getErrorMessage(error: unknown, fallback: string) {
  if (!error || typeof error !== "object") return fallback;
  const candidate = error as { message?: unknown; shortMessage?: unknown };
  const message = typeof candidate.shortMessage === "string"
    ? candidate.shortMessage
    : typeof candidate.message === "string"
      ? candidate.message
      : "";
  return message
    .replace(secretPattern, "[已隐藏敏感内容]")
    .replace(rpcUrlPattern, "[RPC 地址已隐藏]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240) || fallback;
}

function isAbortError(error: unknown, signal?: AbortSignal) {
  return Boolean(signal?.aborted)
    || (Boolean(error) && typeof error === "object" && (error as { name?: unknown }).name === "AbortError");
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("NFT 历史扫描已停止");
  error.name = "AbortError";
  throw error;
}

function normalizeAddress(value: string) {
  if (!isAddress(value)) return null;
  const address = getAddress(value);
  return address === zeroAddress ? null : address;
}

function normalizeOwners(ownerAddresses: readonly string[]) {
  const seen = new Set<string>();
  const owners: Address[] = [];
  let invalid = false;
  ownerAddresses.forEach((value) => {
    const address = normalizeAddress(value);
    if (!address) {
      invalid = true;
      return;
    }
    const key = address.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    owners.push(address);
  });
  return { invalid, owners };
}

function createAsset(
  contractAddress: Address,
  tokenId: bigint
): Extract<EvmCollectionAsset, { standard: "erc1155" }> {
  return {
    contractAddress,
    key: `erc1155:${contractAddress.toLowerCase()}:${tokenId}`,
    standard: "erc1155",
    tokenId
  };
}

/**
 * Recovers ERC1155 Token IDs touched by the requested wallets, then keeps only
 * IDs with a positive balance at one fixed snapshot block. ERC1155 has no
 * enumerable owner API, so complete TransferSingle/TransferBatch history is
 * the only standards-based automatic discovery path.
 */
export async function discoverErc1155AssetsByTransfer({
  blockSpan = defaultBlockSpan,
  contractAddress,
  fromBlock,
  maxRpcRequests = defaultRpcBudget,
  maxTokens = maximumEvmCollectionAssets,
  onProgress,
  ownerAddresses,
  publicClient,
  signal,
  toBlock
}: {
  blockSpan?: bigint;
  contractAddress: string;
  fromBlock: bigint;
  maxRpcRequests?: number;
  maxTokens?: number;
  onProgress?: (progress: Erc1155TransferDiscoveryProgress) => void;
  ownerAddresses: readonly string[];
  publicClient: Erc1155TransferDiscoveryClient;
  signal?: AbortSignal;
  toBlock?: bigint;
}): Promise<Erc1155TransferDiscoveryResult> {
  throwIfAborted(signal);
  const contract = normalizeAddress(contractAddress);
  const normalizedOwners = normalizeOwners(ownerAddresses);
  const issues: Erc1155TransferDiscoveryIssue[] = [];
  const emptyResult: Erc1155TransferDiscoveryResult = {
    assets: [],
    candidateCount: 0,
    complete: false,
    fromBlock,
    issues,
    latestBlock: toBlock ?? fromBlock,
    rpcRequests: 0
  };

  if (!contract || normalizedOwners.invalid || !normalizedOwners.owners.length
    || ownerAddresses.length > maximumCollectionSources
    || normalizedOwners.owners.length > maximumCollectionSources
    || fromBlock < 0n || blockSpan < 1n
    || !Number.isSafeInteger(maxRpcRequests) || maxRpcRequests < 1 || maxRpcRequests > maximumEvmCollectionChecks
    || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > maximumEvmCollectionAssets) {
    issues.push({ code: "invalid-input", message: "ERC1155 自动识别参数无效，请检查合约、来源钱包与扫描上限" });
    return emptyResult;
  }

  let latestBlock: bigint;
  let rpcRequests = 0;
  try {
    latestBlock = toBlock ?? await publicClient.getBlockNumber();
    throwIfAborted(signal);
    if (toBlock === undefined) rpcRequests += 1;
  } catch (error) {
    if (isAbortError(error, signal)) throw error;
    issues.push({ code: "log-query-failed", message: getErrorMessage(error, "无法读取当前区块高度") });
    return emptyResult;
  }
  if (latestBlock < fromBlock) {
    issues.push({ code: "invalid-input", message: "起始区块不能高于当前区块" });
    return { ...emptyResult, latestBlock, rpcRequests };
  }

  let complete = true;
  let activeBlockSpan = blockSpan;
  let rangeStart = fromBlock;
  let limitReported = false;
  const tokenIds = new Set<string>();
  const addTokenId = (value: unknown) => {
    if (typeof value !== "bigint") {
      complete = false;
      return;
    }
    const key = value.toString();
    if (tokenIds.has(key)) return;
    if (tokenIds.size >= maxTokens) {
      complete = false;
      if (!limitReported) {
        limitReported = true;
        issues.push({
          code: "token-limit-exceeded",
          message: `ERC1155 候选 Token ID 已达到 ${maxTokens} 个安全上限，请拆分来源或缩小扫描范围`
        });
      }
      return;
    }
    tokenIds.add(key);
  };

  while (rangeStart <= latestBlock && complete) {
    throwIfAborted(signal);
    const rangeEnd = rangeStart + activeBlockSpan - 1n > latestBlock
      ? latestBlock
      : rangeStart + activeBlockSpan - 1n;
    if (rpcRequests + 4 > maxRpcRequests) {
      complete = false;
      issues.push({ code: "rpc-budget-exceeded", message: `ERC1155 事件扫描达到 ${maxRpcRequests} 次 RPC 预算，结果仅为部分数据` });
      break;
    }
    try {
      onProgress?.({
        candidateCount: tokenIds.size,
        fromBlock: rangeStart,
        rpcRequests,
        stage: "reading-events",
        toBlock: rangeEnd
      });
      throwIfAborted(signal);
      rpcRequests += 4;
      const [singleSent, singleReceived, batchSent, batchReceived] = await Promise.all([
        publicClient.getLogs({ address: contract, args: { from: normalizedOwners.owners }, event: transferSingleEvent, fromBlock: rangeStart, toBlock: rangeEnd }),
        publicClient.getLogs({ address: contract, args: { to: normalizedOwners.owners }, event: transferSingleEvent, fromBlock: rangeStart, toBlock: rangeEnd }),
        publicClient.getLogs({ address: contract, args: { from: normalizedOwners.owners }, event: transferBatchEvent, fromBlock: rangeStart, toBlock: rangeEnd }),
        publicClient.getLogs({ address: contract, args: { to: normalizedOwners.owners }, event: transferBatchEvent, fromBlock: rangeStart, toBlock: rangeEnd })
      ]);
      throwIfAborted(signal);
      [...singleSent, ...singleReceived].forEach((log) => {
        addTokenId((log as { args?: { id?: unknown } }).args?.id);
      });
      [...batchSent, ...batchReceived].forEach((log) => {
        const ids = (log as { args?: { ids?: unknown } }).args?.ids;
        if (!Array.isArray(ids)) {
          complete = false;
          return;
        }
        ids.forEach(addTokenId);
      });
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      if (activeBlockSpan > minimumBlockSpan) {
        activeBlockSpan = activeBlockSpan / 2n < minimumBlockSpan ? minimumBlockSpan : activeBlockSpan / 2n;
        continue;
      }
      complete = false;
      issues.push({
        code: "log-query-failed",
        message: `区块 ${rangeStart}–${rangeEnd} 的 ERC1155 事件读取失败：${getErrorMessage(error, "请更换 RPC 后重试")}`
      });
      break;
    }
    rangeStart = rangeEnd + 1n;
  }

  const sortedTokenIds = [...tokenIds]
    .map((value) => BigInt(value))
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const assets: Extract<EvmCollectionAsset, { standard: "erc1155" }>[] = [];

  for (const tokenId of sortedTokenIds) {
    throwIfAborted(signal);
    let held = false;
    for (const owner of normalizedOwners.owners) {
      throwIfAborted(signal);
      if (rpcRequests >= maxRpcRequests) {
        complete = false;
        issues.push({ code: "rpc-budget-exceeded", message: `ERC1155 余额复核达到 ${maxRpcRequests} 次 RPC 预算，结果仅为部分数据` });
        break;
      }
      try {
        onProgress?.({
          candidateCount: sortedTokenIds.length,
          fromBlock,
          rpcRequests,
          stage: "verifying-balance",
          toBlock: latestBlock
        });
        throwIfAborted(signal);
        rpcRequests += 1;
        const balance = await publicClient.readContract({
          abi: erc1155BalanceAbi,
          address: contract,
          args: [owner, tokenId],
          blockNumber: latestBlock,
          functionName: "balanceOf"
        });
        throwIfAborted(signal);
        if (typeof balance !== "bigint" || balance < 0n) throw new Error("invalid balanceOf response");
        if (balance > 0n) held = true;
      } catch (error) {
        if (isAbortError(error, signal)) throw error;
        complete = false;
        issues.push({
          code: "balance-read-failed",
          message: `Token ID ${tokenId} 在来源 ${owner.slice(0, 8)}…${owner.slice(-6)} 的余额复核失败：${getErrorMessage(error, "无法读取 balanceOf")}`
        });
      }
      if (held) break;
    }
    if (held) assets.push(createAsset(contract, tokenId));
    if (rpcRequests >= maxRpcRequests) break;
  }

  return {
    assets,
    candidateCount: sortedTokenIds.length,
    complete,
    fromBlock,
    issues,
    latestBlock,
    rpcRequests
  };
}
