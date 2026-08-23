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

const erc721TransferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"
);

// ERC-2309 is used by some collections to mint a contiguous ID range during
// construction. Ignoring it makes a Transfer-history scan silently miss IDs.
const erc2309ConsecutiveTransferEvent = parseAbiItem(
  "event ConsecutiveTransfer(uint256 indexed fromTokenId, uint256 toTokenId, address indexed fromAddress, address indexed toAddress)"
);

const erc721OwnerOfAbi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)"
]);

const defaultBlockSpan = 250_000n;
// Keep shrinking down to a single block. Public RPC providers frequently
// impose ranges far smaller than 1,000 blocks, especially for indexed topic
// queries. The existing RPC budget still bounds the total amount of work.
const minimumBlockSpan = 1n;
const defaultRpcBudget = 2_500;
const secretPattern = /0x[0-9a-fA-F]{64}/g;
const rpcUrlPattern = /https?:\/\/\S+/gi;

export type Erc721TransferDiscoveryIssue = {
  code:
    | "invalid-input"
    | "balance-mismatch"
    | "balance-read-failed"
    | "log-query-failed"
    | "owner-read-failed"
    | "rpc-budget-exceeded"
    | "token-limit-exceeded";
  message: string;
};

export type Erc721TransferDiscoveryProgress = {
  candidateCount: number;
  fromBlock: bigint;
  logRequests: number;
  stage: "locating-deployment" | "reading-events" | "verifying-owner";
  toBlock: bigint;
  totalBlocks: bigint;
};

export type Erc721TransferDiscoveryScope = "full-history" | "manual-range";

export type Erc721TransferDiscoveryResult = {
  /** Only IDs whose ownerOf result belongs to a requested source are returned. */
  assets: Extract<EvmCollectionAsset, { standard: "erc721" }>[];
  candidateCount: number;
  /** True only when logs, ownerOf checks, and per-source snapshot balances reconcile. */
  complete: boolean;
  fromBlock: bigint;
  issues: Erc721TransferDiscoveryIssue[];
  /** A fixed head used for both log coverage and ownerOf verification. */
  latestBlock: bigint;
  rpcRequests: number;
  /** Whether the caller scanned from the contract deployment or a user-defined range. */
  scope: Erc721TransferDiscoveryScope;
};

export type Erc721TransferDiscoveryClient = Pick<
  PublicClient,
  "getBlockNumber" | "getCode" | "getLogs" | "readContract"
>;

export type DiscoverErc721AssetsByTransferParameters = {
  blockSpan?: bigint;
  contractAddress: string;
  fromBlock: bigint;
  maxRpcRequests?: number;
  maxTokens?: number;
  onProgress?: (progress: Erc721TransferDiscoveryProgress) => void;
  ownerAddresses: readonly string[];
  publicClient: Erc721TransferDiscoveryClient;
  signal?: AbortSignal;
  scope?: Erc721TransferDiscoveryScope;
  toBlock?: bigint;
};

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

function hasCode(value: string | undefined) {
  return Boolean(value && value !== "0x");
}

function getErrorMessage(error: unknown, fallback: string) {
  if (!error || typeof error !== "object") return fallback;
  const candidate = error as { shortMessage?: unknown; message?: unknown };
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

function normalizeOwners(ownerAddresses: readonly string[]) {
  const seen = new Set<string>();
  const owners: Address[] = [];
  let hasInvalidOwner = false;
  for (const ownerAddress of ownerAddresses) {
    if (!isAddress(ownerAddress)) {
      hasInvalidOwner = true;
      continue;
    }
    const address = getAddress(ownerAddress);
    // The zero address is the mint/burn endpoint for every ERC721 contract,
    // not a wallet that can supply assets. Including it makes a discovery scan
    // unnecessarily read most of the collection history.
    if (address.toLowerCase() === zeroAddress) {
      hasInvalidOwner = true;
      continue;
    }
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    owners.push(address);
  }
  return { hasInvalidOwner, owners };
}

function normalizeContract(contractAddress: string) {
  if (!isAddress(contractAddress)) return null;
  const contract = getAddress(contractAddress);
  return contract.toLowerCase() === zeroAddress ? null : contract;
}

function createAsset(contractAddress: Address, tokenId: bigint): Extract<EvmCollectionAsset, { standard: "erc721" }> {
  return {
    contractAddress,
    key: "erc721:" + contractAddress.toLowerCase() + ":" + tokenId,
    standard: "erc721",
    tokenId
  };
}

function emit(
  onProgress: DiscoverErc721AssetsByTransferParameters["onProgress"],
  progress: Erc721TransferDiscoveryProgress
) {
  try {
    onProgress?.(progress);
  } catch {
    // Rendering progress must never stop a read-only chain scan.
  }
}

/**
 * Finds the first historical block where the contract has runtime code.
 * This needs an RPC that can serve historical code. Callers can instead use a
 * known start block and present the result as a bounded manual-range scan.
 */
export async function findErc721DeploymentBlock({
  contractAddress,
  onProgress,
  publicClient
}: {
  contractAddress: string;
  onProgress?: (progress: Pick<Erc721TransferDiscoveryProgress, "stage">) => void;
  publicClient: Pick<PublicClient, "getBlockNumber" | "getCode">;
}) {
  const contract = normalizeContract(contractAddress);
  if (!contract) throw new Error("NFT 合约地址格式不正确");

  onProgress?.({ stage: "locating-deployment" });
  const latestBlock = await publicClient.getBlockNumber();
  const latestCode = await publicClient.getCode({ address: contract, blockNumber: latestBlock });
  if (!hasCode(latestCode)) throw new Error("该地址当前没有合约代码，无法扫描 ERC721 事件");

  let lower = 0n;
  let upper = latestBlock;
  while (lower < upper) {
    const middle = lower + (upper - lower) / 2n;
    const code = await publicClient.getCode({ address: contract, blockNumber: middle });
    if (hasCode(code)) upper = middle;
    else lower = middle + 1n;
  }
  return lower;
}

/**
 * Recovers ERC721 candidate IDs from standard Transfer and ERC-2309 events,
 * then verifies each candidate using ownerOf at one fixed block. Unlike an ID
 * range sweep, this never guesses IDs that were not present in on-chain logs.
 */
export async function discoverErc721AssetsByTransfer(
  parameters: DiscoverErc721AssetsByTransferParameters
): Promise<Erc721TransferDiscoveryResult> {
  throwIfAborted(parameters.signal);
  const contract = normalizeContract(parameters.contractAddress);
  const { hasInvalidOwner, owners } = normalizeOwners(parameters.ownerAddresses);
  const maxRpcRequests = parameters.maxRpcRequests ?? defaultRpcBudget;
  const maxTokens = parameters.maxTokens ?? maximumEvmCollectionAssets;
  const blockSpan = parameters.blockSpan ?? defaultBlockSpan;
  const scope = parameters.scope ?? "manual-range";
  const issues: Erc721TransferDiscoveryIssue[] = [];
  const emptyResult: Erc721TransferDiscoveryResult = {
    assets: [],
    candidateCount: 0,
    complete: false,
    fromBlock: parameters.fromBlock,
    issues,
    latestBlock: parameters.toBlock ?? parameters.fromBlock,
    rpcRequests: 0,
    scope
  };

  if (!contract || !owners.length || hasInvalidOwner || parameters.ownerAddresses.length > maximumCollectionSources
    || owners.length > maximumCollectionSources || parameters.fromBlock < 0n
    || !Number.isSafeInteger(maxRpcRequests) || maxRpcRequests < 1 || maxRpcRequests > maximumEvmCollectionChecks
    || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > maximumEvmCollectionAssets
    || blockSpan < 1n) {
    issues.push({
      code: "invalid-input",
      message: "自动发现参数无效：请检查 NFT 合约、来源钱包、起始区块和扫描上限"
    });
    return emptyResult;
  }

  let latestBlock: bigint;
  let rpcRequests = 0;
  try {
    latestBlock = parameters.toBlock ?? await parameters.publicClient.getBlockNumber();
    throwIfAborted(parameters.signal);
    if (!parameters.toBlock) rpcRequests += 1;
  } catch (error) {
    if (isAbortError(error, parameters.signal)) throw error;
    issues.push({ code: "log-query-failed", message: getErrorMessage(error, "无法读取当前区块高度") });
    return emptyResult;
  }
  if (latestBlock < parameters.fromBlock) {
    issues.push({ code: "invalid-input", message: "起始区块不能高于当前区块" });
    return { ...emptyResult, latestBlock, rpcRequests };
  }

  let complete = true;
  const tokenIds = new Set<string>();
  const ownerSet = new Set(owners.map((owner) => owner.toLowerCase()));
  const totalBlocks = latestBlock - parameters.fromBlock + 1n;
  let rangeStart = parameters.fromBlock;
  let activeBlockSpan = blockSpan;
  let limitReported = false;

  const addTokenId = (tokenId: bigint) => {
    const key = tokenId.toString();
    if (tokenIds.has(key)) return true;
    if (tokenIds.size >= maxTokens) {
      complete = false;
      if (!limitReported) {
        issues.push({
          code: "token-limit-exceeded",
          message: "发现候选 Token ID 已达到 " + maxTokens + " 个安全上限；请缩小区块范围或拆分来源钱包"
        });
        limitReported = true;
      }
      return false;
    }
    tokenIds.add(key);
    return true;
  };

  const addConsecutiveRange = (fromTokenId: unknown, toTokenId: unknown) => {
    if (typeof fromTokenId !== "bigint" || typeof toTokenId !== "bigint" || toTokenId < fromTokenId) {
      complete = false;
      issues.push({
        code: "log-query-failed",
        message: "ConsecutiveTransfer 日志格式不正确，无法完整恢复 Token ID"
      });
      return false;
    }
    const rangeSize = toTokenId - fromTokenId + 1n;
    // A range can overlap IDs already recovered from standard Transfer logs.
    // Compare against the absolute cap here, then let addTokenId deduplicate
    // each entry; comparing with the remaining slots would incorrectly reject
    // an overlapping range that still fits in the final unique set.
    if (rangeSize > BigInt(maxTokens)) {
      complete = false;
      if (!limitReported) {
        issues.push({
          code: "token-limit-exceeded",
          message: "ERC-2309 批量铸造包含超过当前 " + maxTokens + " 个候选 ID 的范围；请缩小扫描范围或分批处理"
        });
        limitReported = true;
      }
      return false;
    }
    for (let tokenId = fromTokenId; tokenId <= toTokenId; tokenId += 1n) {
      if (!addTokenId(tokenId)) return false;
    }
    return true;
  };

  while (rangeStart <= latestBlock) {
    throwIfAborted(parameters.signal);
    const rangeEnd = rangeStart + activeBlockSpan - 1n > latestBlock
      ? latestBlock
      : rangeStart + activeBlockSpan - 1n;
    const logCalls = 4;
    if (rpcRequests + logCalls > maxRpcRequests) {
      complete = false;
      issues.push({
        code: "rpc-budget-exceeded",
        message: "事件扫描达到 " + maxRpcRequests + " 次 RPC 请求预算，后续区块未扫描；请缩小区块范围或更换支持大范围日志的 RPC"
      });
      break;
    }
    emit(parameters.onProgress, {
      candidateCount: tokenIds.size,
      fromBlock: rangeStart,
      logRequests: rpcRequests,
      stage: "reading-events",
      toBlock: rangeEnd,
      totalBlocks
    });
    throwIfAborted(parameters.signal);

    try {
      rpcRequests += logCalls;
      const [sentLogs, receivedLogs, consecutiveSentLogs, consecutiveReceivedLogs] = await Promise.all([
        parameters.publicClient.getLogs({
          address: contract,
          args: { from: owners },
          event: erc721TransferEvent,
          fromBlock: rangeStart,
          toBlock: rangeEnd
        }),
        parameters.publicClient.getLogs({
          address: contract,
          args: { to: owners },
          event: erc721TransferEvent,
          fromBlock: rangeStart,
          toBlock: rangeEnd
        }),
        parameters.publicClient.getLogs({
          address: contract,
          args: { fromAddress: owners },
          event: erc2309ConsecutiveTransferEvent,
          fromBlock: rangeStart,
          toBlock: rangeEnd
        }),
        parameters.publicClient.getLogs({
          address: contract,
          args: { toAddress: owners },
          event: erc2309ConsecutiveTransferEvent,
          fromBlock: rangeStart,
          toBlock: rangeEnd
        })
      ]);
      throwIfAborted(parameters.signal);
      for (const log of [...sentLogs, ...receivedLogs]) {
        const tokenId = (log as { args?: { tokenId?: unknown } }).args?.tokenId;
        if (typeof tokenId === "bigint" && !addTokenId(tokenId)) break;
      }
      if (complete) {
        for (const log of [...consecutiveSentLogs, ...consecutiveReceivedLogs]) {
          const args = (log as { args?: { fromTokenId?: unknown; toTokenId?: unknown } }).args;
          if (!addConsecutiveRange(args?.fromTokenId, args?.toTokenId)) break;
        }
      }
      if (!complete) break;
    } catch (error) {
      if (isAbortError(error, parameters.signal)) throw error;
      // Providers often reject broad eth_getLogs ranges. Retry the same range
      // automatically with a smaller span before declaring the scan partial.
      if (activeBlockSpan > minimumBlockSpan) {
        activeBlockSpan = activeBlockSpan / 2n < minimumBlockSpan
          ? minimumBlockSpan
          : activeBlockSpan / 2n;
        continue;
      }
      complete = false;
      issues.push({
        code: "log-query-failed",
        message: "区块 " + rangeStart.toString() + "–" + rangeEnd.toString()
          + " 的 NFT 事件读取失败：" + getErrorMessage(error, "请缩小扫描范围或更换 RPC")
      });
      break;
    }
    rangeStart = rangeEnd + 1n;
  }

  const tokenList = [...tokenIds]
    .map((value) => BigInt(value))
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const assets: Extract<EvmCollectionAsset, { standard: "erc721" }>[] = [];
  const verifiedTokenIdsByOwner = new Map(
    owners.map((owner) => [owner.toLowerCase(), new Set<string>()])
  );
  for (const tokenId of tokenList) {
    throwIfAborted(parameters.signal);
    if (rpcRequests >= maxRpcRequests) {
      complete = false;
      issues.push({
        code: "rpc-budget-exceeded",
        message: "候选 NFT 所有权校验达到 " + maxRpcRequests + " 次 RPC 请求预算，结果仅为部分候选项"
      });
      break;
    }
    emit(parameters.onProgress, {
      candidateCount: tokenList.length,
      fromBlock: parameters.fromBlock,
      logRequests: rpcRequests,
      stage: "verifying-owner",
      toBlock: latestBlock,
      totalBlocks
    });
    throwIfAborted(parameters.signal);
    try {
      rpcRequests += 1;
      const owner = await parameters.publicClient.readContract({
        abi: erc721OwnerOfAbi,
        address: contract,
        args: [tokenId],
        blockNumber: latestBlock,
        functionName: "ownerOf"
      });
      throwIfAborted(parameters.signal);
      if (typeof owner !== "string" || !isAddress(owner)) {
        complete = false;
        issues.push({
          code: "owner-read-failed",
          message: "Token ID " + tokenId.toString() + " 的 ownerOf 返回格式不正确"
        });
        continue;
      }
      const ownerAddress = getAddress(owner);
      const ownerKey = ownerAddress.toLowerCase();
      if (ownerSet.has(ownerKey)) {
        verifiedTokenIdsByOwner.get(ownerKey)?.add(tokenId.toString());
        assets.push(createAsset(contract, tokenId));
      }
    } catch (error) {
      if (isAbortError(error, parameters.signal)) throw error;
      complete = false;
      issues.push({
        code: "owner-read-failed",
        message: "Token ID " + tokenId.toString()
          + " 所有权校验失败：" + getErrorMessage(error, "无法读取 ownerOf")
      });
    }
  }

  // Transfer logs are only a candidate source. Reconcile every requested
  // wallet's snapshot balance with its verified unique token IDs before
  // calling a scan complete; otherwise an RPC/indexing gap could look like a
  // fully recovered collection.
  for (const ownerAddress of owners) {
    throwIfAborted(parameters.signal);
    if (rpcRequests >= maxRpcRequests) {
      complete = false;
      issues.push({
        code: "rpc-budget-exceeded",
        message: "来源钱包 NFT 余额校验达到 " + maxRpcRequests + " 次 RPC 请求预算，结果仅为部分候选项"
      });
      break;
    }
    try {
      rpcRequests += 1;
      const balance = await parameters.publicClient.readContract({
        abi: erc721OwnerOfAbi,
        address: contract,
        args: [ownerAddress],
        blockNumber: latestBlock,
        functionName: "balanceOf"
      });
      throwIfAborted(parameters.signal);
      if (typeof balance !== "bigint" || balance < 0n) {
        throw new Error("invalid balanceOf response");
      }
      const verifiedCount = BigInt(verifiedTokenIdsByOwner.get(ownerAddress.toLowerCase())?.size || 0);
      if (balance !== verifiedCount) {
        complete = false;
        issues.push({
          code: "balance-mismatch",
          message: "来源 " + ownerAddress.slice(0, 8) + "…" + ownerAddress.slice(-6)
            + " 的快照余额为 " + balance.toString()
            + "，但只验证到 " + verifiedCount.toString() + " 个 Token ID；结果不完整"
        });
      }
    } catch (error) {
      if (isAbortError(error, parameters.signal)) throw error;
      complete = false;
      issues.push({
        code: "balance-read-failed",
        message: "无法校验来源 " + ownerAddress.slice(0, 8) + "…" + ownerAddress.slice(-6)
          + " 的快照 NFT 余额：" + getErrorMessage(error, "请检查 RPC")
      });
    }
  }

  return {
    assets,
    candidateCount: tokenList.length,
    complete,
    fromBlock: parameters.fromBlock,
    issues,
    latestBlock,
    rpcRequests,
    scope
  };
}
