import {
  getAddress,
  isAddress,
  parseAbi,
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

const tokenRangeAbi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function totalMinted() view returns (uint256)",
  "function nextTokenId() view returns (uint256)",
  "function nextTokenIdToMint() view returns (uint256)",
  "function currentTokenId() view returns (uint256)",
  "function currentIndex() view returns (uint256)",
  "function tokenCount() view returns (uint256)",
  "function getCurrentTokenId() view returns (uint256)"
]);

const counterMethods = [
  "totalSupply",
  "totalMinted",
  "nextTokenId",
  "nextTokenIdToMint",
  "currentTokenId",
  "currentIndex",
  "tokenCount",
  "getCurrentTokenId"
] as const;

type CounterMethod = typeof counterMethods[number];

export type Erc721TokenRangeIssue = {
  code:
    | "balance-mismatch"
    | "balance-read-failed"
    | "invalid-input"
    | "range-limit-exceeded"
    | "range-required"
    | "rpc-budget-exceeded"
    | "token-limit-exceeded";
  message: string;
};

export type Erc721TokenRange = {
  fromTokenId: bigint;
  source: "manual" | CounterMethod;
  toTokenId: bigint;
};

export type Erc721TokenRangeProgress = {
  discovered: number;
  scanned: number;
  stage: "detecting-range" | "reading-balances" | "scanning-token-ids";
  tokenId: bigint | null;
  total: bigint | null;
};

export type Erc721TokenRangeDiscoveryResult = {
  assets: Extract<EvmCollectionAsset, { standard: "erc721" }>[];
  complete: boolean;
  expectedBalance: bigint | null;
  issues: Erc721TokenRangeIssue[];
  range: Erc721TokenRange | null;
  rpcRequests: number;
  scanned: number;
  snapshotBlock: bigint;
};

export type Erc721TokenRangeDiscoveryClient = Pick<PublicClient, "getBlockNumber" | "readContract">;

export type DiscoverErc721AssetsByTokenRangeParameters = {
  contractAddress: string;
  fromTokenId?: bigint;
  maxRpcRequests?: number;
  onProgress?: (progress: Erc721TokenRangeProgress) => void;
  ownerAddresses: readonly string[];
  publicClient: Erc721TokenRangeDiscoveryClient;
  signal?: AbortSignal;
  snapshotBlock?: bigint;
  toTokenId?: bigint;
};

const secretPattern = /0x[0-9a-fA-F]{64}/g;
const rpcUrlPattern = /https?:\/\/\S+/gi;

class RpcBudgetExceededError extends Error {}

function safeMessage(error: unknown, fallback: string) {
  const candidate = error && typeof error === "object"
    ? error as { message?: unknown; shortMessage?: unknown }
    : null;
  const raw = typeof candidate?.shortMessage === "string"
    ? candidate.shortMessage
    : typeof candidate?.message === "string"
      ? candidate.message
      : fallback;
  return raw
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
  const error = new Error("Token ID 探测已停止");
  error.name = "AbortError";
  throw error;
}

function emitProgress(
  onProgress: DiscoverErc721AssetsByTokenRangeParameters["onProgress"],
  progress: Erc721TokenRangeProgress
) {
  try {
    onProgress?.(progress);
  } catch {
    // Rendering progress must never interrupt a read-only RPC scan.
  }
}

function normalizeInputs(contractAddress: string, ownerAddresses: readonly string[]) {
  const issues: Erc721TokenRangeIssue[] = [];
  if (!isAddress(contractAddress) || getAddress(contractAddress) === zeroAddress) {
    issues.push({ code: "invalid-input", message: "ERC721 合约地址格式不正确" });
    return { contract: null, issues, owners: [] as Address[] };
  }
  if (!ownerAddresses.length || ownerAddresses.length > maximumCollectionSources) {
    issues.push({
      code: "invalid-input",
      message: `来源地址数量必须是 1–${maximumCollectionSources}`
    });
    return { contract: getAddress(contractAddress), issues, owners: [] as Address[] };
  }

  const owners: Address[] = [];
  const seen = new Set<string>();
  for (const ownerAddress of ownerAddresses) {
    if (!isAddress(ownerAddress) || getAddress(ownerAddress) === zeroAddress) {
      issues.push({ code: "invalid-input", message: "来源地址格式不正确" });
      continue;
    }
    const owner = getAddress(ownerAddress);
    const key = owner.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    owners.push(owner);
  }
  if (issues.length || !owners.length) return { contract: getAddress(contractAddress), issues, owners: [] as Address[] };
  return { contract: getAddress(contractAddress), issues, owners };
}

function createAsset(contractAddress: Address, tokenId: bigint): Extract<EvmCollectionAsset, { standard: "erc721" }> {
  return {
    contractAddress,
    key: `erc721:${contractAddress.toLowerCase()}:${tokenId}`,
    standard: "erc721",
    tokenId
  };
}

function toNonNegativeBigInt(value: unknown) {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return null;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
  shouldStop?: () => boolean
) {
  const results: R[] = [];
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length && !shouldStop?.()) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function discoverErc721AssetsByTokenRange(
  parameters: DiscoverErc721AssetsByTokenRangeParameters
): Promise<Erc721TokenRangeDiscoveryResult> {
  throwIfAborted(parameters.signal);
  const normalized = normalizeInputs(parameters.contractAddress, parameters.ownerAddresses);
  const maxRpcRequests = parameters.maxRpcRequests ?? maximumEvmCollectionChecks;
  const snapshotBlock = parameters.snapshotBlock ?? await parameters.publicClient.getBlockNumber();
  const issues = [...normalized.issues];
  const emptyResult = (overrides: Partial<Erc721TokenRangeDiscoveryResult> = {}): Erc721TokenRangeDiscoveryResult => ({
    assets: [],
    complete: false,
    expectedBalance: null,
    issues,
    range: null,
    rpcRequests: 0,
    scanned: 0,
    snapshotBlock,
    ...overrides
  });

  if (!normalized.contract || !normalized.owners.length) return emptyResult();
  if (!Number.isSafeInteger(maxRpcRequests) || maxRpcRequests < 1 || maxRpcRequests > maximumEvmCollectionChecks) {
    issues.push({
      code: "invalid-input",
      message: `RPC 请求预算必须是 1–${maximumEvmCollectionChecks} 的整数`
    });
    return emptyResult();
  }
  if ((parameters.fromTokenId === undefined) !== (parameters.toTokenId === undefined)
    || (parameters.fromTokenId !== undefined && (
      parameters.fromTokenId < 0n
      || parameters.toTokenId! < parameters.fromTokenId
    ))) {
    issues.push({ code: "invalid-input", message: "Token ID 起止范围无效" });
    return emptyResult();
  }

  const contract = normalized.contract;
  const owners = normalized.owners;
  const ownerSet = new Set(owners.map((owner) => owner.toLowerCase()));
  const expectedByOwner = new Map<string, bigint>();
  const discoveredByOwner = new Map<string, bigint>();
  let rpcRequests = parameters.snapshotBlock === undefined ? 1 : 0;
  let balanceReadFailed = false;

  const readContract = async (request: Parameters<PublicClient["readContract"]>[0]) => {
    throwIfAborted(parameters.signal);
    if (rpcRequests >= maxRpcRequests) throw new RpcBudgetExceededError("RPC 请求达到安全上限");
    rpcRequests += 1;
    return parameters.publicClient.readContract(request);
  };

  emitProgress(parameters.onProgress, {
    discovered: 0,
    scanned: 0,
    stage: "reading-balances",
    tokenId: null,
    total: BigInt(owners.length)
  });

  await mapWithConcurrency(owners, 8, async (owner) => {
    try {
      const value = toNonNegativeBigInt(await readContract({
        abi: tokenRangeAbi,
        address: contract,
        args: [owner],
        blockNumber: snapshotBlock,
        functionName: "balanceOf"
      }));
      if (value === null) throw new Error("balanceOf 返回格式不正确");
      expectedByOwner.set(owner.toLowerCase(), value);
      discoveredByOwner.set(owner.toLowerCase(), 0n);
    } catch (error) {
      if (isAbortError(error, parameters.signal) || error instanceof RpcBudgetExceededError) throw error;
      balanceReadFailed = true;
      issues.push({
        code: "balance-read-failed",
        message: `来源 ${owner.slice(0, 8)}… 的 balanceOf 读取失败：${safeMessage(error, "RPC 调用失败")}`
      });
    }
    return null;
  });

  const expectedBalance = [...expectedByOwner.values()].reduce((sum, value) => sum + value, 0n);
  if (!balanceReadFailed && expectedBalance === 0n) {
    return emptyResult({ complete: true, expectedBalance, rpcRequests });
  }
  if (expectedBalance > BigInt(maximumEvmCollectionAssets)) {
    issues.push({
      code: "token-limit-exceeded",
      message: `来源钱包共持有 ${expectedBalance} 个 NFT，超过单轮 ${maximumEvmCollectionAssets} 个资产上限，请拆分来源钱包`
    });
    return emptyResult({ expectedBalance, rpcRequests });
  }

  let range: Erc721TokenRange | null = null;
  if (parameters.fromTokenId !== undefined && parameters.toTokenId !== undefined) {
    range = {
      fromTokenId: parameters.fromTokenId,
      source: "manual",
      toTokenId: parameters.toTokenId
    };
  } else {
    emitProgress(parameters.onProgress, {
      discovered: 0,
      scanned: 0,
      stage: "detecting-range",
      tokenId: null,
      total: null
    });
    const counters: Array<{ method: CounterMethod; value: bigint }> = [];
    await mapWithConcurrency(counterMethods, 4, async (method) => {
      try {
        const value = toNonNegativeBigInt(await readContract({
          abi: tokenRangeAbi,
          address: contract,
          blockNumber: snapshotBlock,
          functionName: method
        }));
        if (value !== null) counters.push({ method, value });
      } catch (error) {
        if (isAbortError(error, parameters.signal) || error instanceof RpcBudgetExceededError) throw error;
        // Optional counters vary by contract. A revert only means this hint is unavailable.
      }
      return null;
    });
    if (counters.length) {
      const selected = counters.reduce((largest, current) => current.value > largest.value ? current : largest);
      range = {
        fromTokenId: 0n,
        source: selected.method,
        // Include both common conventions: IDs 0..supply-1 and IDs 1..supply.
        toTokenId: selected.value
      };
    }
  }

  if (!range) {
    issues.push({
      code: "range-required",
      message: "合约没有可读取的总量或铸造计数器，请填写 Token ID 起止范围后直接探测"
    });
    return emptyResult({ expectedBalance, rpcRequests });
  }

  const rangeLength = range.toTokenId - range.fromTokenId + 1n;
  const remainingBudget = BigInt(maxRpcRequests - rpcRequests);
  if (rangeLength > remainingBudget) {
    issues.push({
      code: "range-limit-exceeded",
      message: `推算范围 ${range.fromTokenId}–${range.toTokenId} 需要 ${rangeLength} 次 ownerOf，超过本次剩余 ${remainingBudget} 次 RPC 上限；请拆分范围`
    });
    return emptyResult({ expectedBalance, range, rpcRequests });
  }

  const tokenIds = Array.from({ length: Number(rangeLength) }, (_, index) => range.fromTokenId + BigInt(index));
  const assets: Extract<EvmCollectionAsset, { standard: "erc721" }>[] = [];
  let scanned = 0;
  const hasFoundExpectedBalance = () => !balanceReadFailed && [...expectedByOwner.entries()].every(([owner, balance]) => (
    (discoveredByOwner.get(owner) || 0n) >= balance
  ));

  emitProgress(parameters.onProgress, {
    discovered: 0,
    scanned: 0,
    stage: "scanning-token-ids",
    tokenId: range.fromTokenId,
    total: rangeLength
  });

  try {
    await mapWithConcurrency(tokenIds, 12, async (tokenId) => {
      let owner: Address | null = null;
      try {
        const value = await readContract({
          abi: tokenRangeAbi,
          address: contract,
          args: [tokenId],
          blockNumber: snapshotBlock,
          functionName: "ownerOf"
        });
        if (typeof value === "string" && isAddress(value) && getAddress(value) !== zeroAddress) {
          owner = getAddress(value);
        }
      } catch (error) {
        if (isAbortError(error, parameters.signal) || error instanceof RpcBudgetExceededError) throw error;
        // ownerOf normally reverts for IDs that were never minted or were burned.
      }
      scanned += 1;
      if (owner && ownerSet.has(owner.toLowerCase())) {
        assets.push(createAsset(contract, tokenId));
        discoveredByOwner.set(owner.toLowerCase(), (discoveredByOwner.get(owner.toLowerCase()) || 0n) + 1n);
      }
      if (scanned === 1 || scanned % 25 === 0 || scanned === tokenIds.length || hasFoundExpectedBalance()) {
        emitProgress(parameters.onProgress, {
          discovered: assets.length,
          scanned,
          stage: "scanning-token-ids",
          tokenId,
          total: rangeLength
        });
      }
      return null;
    }, hasFoundExpectedBalance);
  } catch (error) {
    if (error instanceof RpcBudgetExceededError) {
      issues.push({ code: "rpc-budget-exceeded", message: error.message });
    } else {
      throw error;
    }
  }

  assets.sort((left, right) => left.tokenId < right.tokenId ? -1 : left.tokenId > right.tokenId ? 1 : 0);
  const complete = !balanceReadFailed && hasFoundExpectedBalance();
  if (!complete && !issues.some((issue) => issue.code === "rpc-budget-exceeded")) {
    issues.push({
      code: "balance-mismatch",
      message: `范围内找到 ${assets.length} / ${expectedBalance} 个当前持仓 Token ID，请扩大或调整范围`
    });
  }

  return {
    assets,
    complete,
    expectedBalance,
    issues,
    range,
    rpcRequests,
    scanned,
    snapshotBlock
  };
}
