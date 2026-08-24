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

const ownershipAbi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])"
]);

const erc721TransferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"
);
const consecutiveTransferEvent = parseAbiItem(
  "event ConsecutiveTransfer(uint256 indexed fromTokenId, uint256 toTokenId, address indexed fromAddress, address indexed toAddress)"
);
const erc1155TransferSingleEvent = parseAbiItem(
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)"
);
const erc1155TransferBatchEvent = parseAbiItem(
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)"
);

const openSeaChainByChainId: Readonly<Record<number, string>> = {
  1: "ethereum",
  10: "optimism",
  56: "bsc",
  100: "gnosis",
  137: "polygon",
  143: "monad",
  999: "hyperliquid",
  8453: "base",
  42161: "arbitrum",
  43114: "avalanche",
  11155111: "sepolia",
  84532: "base_sepolia",
  421614: "arbitrum_sepolia",
  11155420: "optimism_sepolia",
  80002: "amoy",
  43113: "avalanche_fuji",
  97: "bsctestnet"
};

const maximumOpenSeaOwners = 100;
const maximumOpenSeaPagesPerOwner = 25;
const maximumOpenSeaRequests = 250;
const maximumCandidateTokenIds = maximumEvmCollectionChecks;
const maximumLogRequests = 300;
const ownerTopicChunkSize = 50;
const initialLogBlockSpan = 1_000_000n;
const minimumLogBlockSpan = 2_000n;

const secretPattern = /0x[0-9a-fA-F]{64}/g;
const urlPattern = /https?:\/\/\S+/gi;

export type NftCandidateStandard = "erc721" | "erc1155";
export type NftCandidateAsset =
  | (Extract<EvmCollectionAsset, { standard: "erc721" }> & { ownerAddress: Address })
  | Extract<EvmCollectionAsset, { standard: "erc1155" }>;

export type NftCandidateDiscoveryIssueCode =
  | "balance-read-failed"
  | "candidate-limit-exceeded"
  | "invalid-input"
  | "log-scan-failed"
  | "log-scan-limit-exceeded"
  | "opensea-failed"
  | "opensea-limit-exceeded"
  | "verification-failed"
  | "verification-limit-exceeded";

export type NftCandidateDiscoveryIssue = {
  code: NftCandidateDiscoveryIssueCode;
  message: string;
};

export type NftCandidateDiscoveryProgress = {
  candidates: number;
  message: string;
  stage: "opensea" | "reading-balances" | "scanning-events" | "verifying";
  verified: number;
};

export type NftCandidateDiscoveryResult = {
  assets: NftCandidateAsset[];
  candidateCount: number;
  complete: boolean;
  eventScanComplete: boolean;
  expectedBalance: bigint | null;
  issues: NftCandidateDiscoveryIssue[];
  openSeaComplete: boolean;
  openSeaUsed: boolean;
  snapshotBlock: bigint;
  sources: Array<"opensea" | "transfer-events">;
};

export type NftCandidateDiscoveryClient = Pick<
  PublicClient,
  "getLogs" | "multicall" | "readContract"
>;

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Pick<Response, "json" | "ok" | "status">>;

export type DiscoverNftAssetsFromCandidatesParameters = {
  chainId: number;
  contractAddress: string;
  fetcher?: FetchLike;
  onProgress?: (progress: NftCandidateDiscoveryProgress) => void;
  openSeaApiKey?: string;
  ownerAddresses: readonly string[];
  publicClient: NftCandidateDiscoveryClient;
  signal?: AbortSignal;
  snapshotBlock: bigint;
  standard: NftCandidateStandard;
};

type CandidateMap = Map<string, Set<string>>;

class CandidateLimitExceededError extends Error {}
class LogRequestLimitExceededError extends Error {}

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
    .replace(urlPattern, "[地址已隐藏]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240) || fallback;
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("NFT 持仓识别已停止");
  error.name = "AbortError";
  throw error;
}

function emitProgress(
  callback: DiscoverNftAssetsFromCandidatesParameters["onProgress"],
  progress: NftCandidateDiscoveryProgress
) {
  try {
    callback?.(progress);
  } catch {
    // Rendering progress must never interrupt a read-only discovery.
  }
}

function normalizeInputs(contractAddress: string, ownerAddresses: readonly string[]) {
  const issues: NftCandidateDiscoveryIssue[] = [];
  if (!isAddress(contractAddress) || getAddress(contractAddress) === zeroAddress) {
    issues.push({ code: "invalid-input", message: "NFT 合约地址格式不正确" });
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
  return issues.length
    ? { contract: getAddress(contractAddress), issues, owners: [] as Address[] }
    : { contract: getAddress(contractAddress), issues, owners };
}

export function getOpenSeaChainIdentifier(chainId: number) {
  return openSeaChainByChainId[chainId] || null;
}

function addCandidate(candidates: CandidateMap, tokenId: bigint, ownerAddress?: string) {
  if (tokenId < 0n) return;
  const key = tokenId.toString();
  let candidateOwners = candidates.get(key);
  if (!candidateOwners) {
    if (candidates.size >= maximumCandidateTokenIds) {
      throw new CandidateLimitExceededError(
        `候选 Token ID 超过 ${maximumCandidateTokenIds} 个安全上限，请缩小来源地址或事件区间`
      );
    }
    candidateOwners = new Set<string>();
    candidates.set(key, candidateOwners);
  }
  if (ownerAddress) candidateOwners.add(ownerAddress.toLowerCase());
}

function parseTokenId(value: unknown) {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }
  return null;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  const settled = await Promise.allSettled(workers);
  const failed = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
  return results;
}

async function fetchOpenSeaCandidates({
  apiKey,
  chain,
  contract,
  fetcher,
  onProgress,
  owners,
  signal
}: {
  apiKey: string;
  chain: string;
  contract: Address;
  fetcher: FetchLike;
  onProgress: DiscoverNftAssetsFromCandidatesParameters["onProgress"];
  owners: readonly Address[];
  signal?: AbortSignal;
}) {
  const candidates: CandidateMap = new Map();
  const issues: NftCandidateDiscoveryIssue[] = [];
  let requestCount = 0;
  let complete = true;

  if (owners.length > maximumOpenSeaOwners) {
    return {
      candidates,
      complete: false,
      issues: [{
        code: "opensea-limit-exceeded" as const,
        message: `OpenSea 快速识别一次最多处理 ${maximumOpenSeaOwners} 个来源地址，已改用 RPC 事件扫描`
      }]
    };
  }

  try {
    await mapWithConcurrency(owners, 3, async (owner, ownerIndex) => {
      let cursor = "";
      let page = 0;
      const seenCursors = new Set<string>();
      do {
        throwIfAborted(signal);
        if (requestCount >= maximumOpenSeaRequests || page >= maximumOpenSeaPagesPerOwner) {
          complete = false;
          issues.push({
            code: "opensea-limit-exceeded",
            message: `OpenSea 分页达到安全上限，来源 ${owner.slice(0, 8)}… 的候选结果可能不完整`
          });
          return;
        }
        requestCount += 1;
        page += 1;
        const query = new URLSearchParams({ limit: "200" });
        if (cursor) query.set("next", cursor);
        const endpoint = `https://api.opensea.io/api/v2/chain/${encodeURIComponent(chain)}`
          + `/account/${encodeURIComponent(owner)}/nfts?${query.toString()}`;
        let response: Pick<Response, "json" | "ok" | "status">;
        try {
          response = await fetcher(endpoint, {
            headers: { accept: "application/json", "x-api-key": apiKey },
            signal
          });
        } catch (error) {
          throwIfAborted(signal);
          complete = false;
          issues.push({
            code: "opensea-failed",
            message: `OpenSea 查询来源 ${owner.slice(0, 8)}… 失败：${safeMessage(error, "网络请求失败")}`
          });
          return;
        }
        if (!response.ok) {
          complete = false;
          issues.push({
            code: "opensea-failed",
            message: `OpenSea 查询返回 HTTP ${response.status}，已继续使用 RPC 事件扫描`
          });
          return;
        }
        let data: unknown;
        try {
          data = await response.json();
        } catch {
          complete = false;
          issues.push({ code: "opensea-failed", message: "OpenSea 返回内容无法解析，已继续使用 RPC 事件扫描" });
          return;
        }
        if (!data || typeof data !== "object") {
          complete = false;
          issues.push({ code: "opensea-failed", message: "OpenSea 返回格式不正确，已继续使用 RPC 事件扫描" });
          return;
        }
        const pageData = data as { next?: unknown; nfts?: unknown };
        if (!Array.isArray(pageData.nfts)) {
          complete = false;
          issues.push({ code: "opensea-failed", message: "OpenSea NFT 列表格式不正确，已继续使用 RPC 事件扫描" });
          return;
        }
        for (const item of pageData.nfts) {
          if (!item || typeof item !== "object") continue;
          const nft = item as { contract?: unknown; identifier?: unknown };
          if (typeof nft.contract !== "string" || !isAddress(nft.contract)
            || getAddress(nft.contract).toLowerCase() !== contract.toLowerCase()) continue;
          const tokenId = parseTokenId(nft.identifier);
          if (tokenId !== null) addCandidate(candidates, tokenId, owner);
        }
        emitProgress(onProgress, {
          candidates: candidates.size,
          message: `OpenSea ${ownerIndex + 1}/${owners.length} · 第 ${page} 页`,
          stage: "opensea",
          verified: 0
        });
        const next = typeof pageData.next === "string" ? pageData.next.trim() : "";
        if (!next) return;
        if (seenCursors.has(next)) {
          complete = false;
          issues.push({ code: "opensea-failed", message: "OpenSea 返回重复分页游标，已停止该来源查询" });
          return;
        }
        seenCursors.add(next);
        cursor = next;
      } while (cursor);
    });
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof CandidateLimitExceededError) {
      complete = false;
      issues.push({ code: "candidate-limit-exceeded", message: error.message });
    } else {
      complete = false;
      issues.push({
        code: "opensea-failed",
        message: `OpenSea 候选识别失败：${safeMessage(error, "未知错误")}`
      });
    }
  }

  return { candidates, complete, issues };
}

function mergeCandidates(target: CandidateMap, source: CandidateMap) {
  for (const [tokenId, owners] of source) {
    const id = BigInt(tokenId);
    if (!target.has(tokenId)) addCandidate(target, id);
    const targetOwners = target.get(tokenId)!;
    owners.forEach((owner) => targetOwners.add(owner));
  }
}

async function scanLogRanges(
  snapshotBlock: bigint,
  readRange: (fromBlock: bigint, toBlock: bigint) => Promise<void>,
  requestState: { count: number },
  signal?: AbortSignal
) {
  const read = async (fromBlock: bigint, toBlock: bigint) => {
    throwIfAborted(signal);
    if (requestState.count >= maximumLogRequests) {
      throw new LogRequestLimitExceededError(`事件扫描超过 ${maximumLogRequests} 次 RPC 请求上限`);
    }
    requestState.count += 1;
    await readRange(fromBlock, toBlock);
  };

  try {
    await read(0n, snapshotBlock);
    return;
  } catch (error) {
    if (error instanceof CandidateLimitExceededError || error instanceof LogRequestLimitExceededError) throw error;
    throwIfAborted(signal);
  }

  let fromBlock = 0n;
  const totalSpan = snapshotBlock + 1n;
  let blockSpan = (totalSpan < initialLogBlockSpan ? totalSpan : initialLogBlockSpan) / 2n;
  if (blockSpan < 1n) blockSpan = 1n;
  while (fromBlock <= snapshotBlock) {
    const toBlock = fromBlock + blockSpan - 1n > snapshotBlock
      ? snapshotBlock
      : fromBlock + blockSpan - 1n;
    try {
      await read(fromBlock, toBlock);
      fromBlock = toBlock + 1n;
      if (blockSpan < initialLogBlockSpan) blockSpan *= 2n;
    } catch (error) {
      if (error instanceof CandidateLimitExceededError || error instanceof LogRequestLimitExceededError) throw error;
      throwIfAborted(signal);
      if (blockSpan <= minimumLogBlockSpan) throw error;
      blockSpan /= 2n;
    }
  }
}

async function scanTransferEventCandidates({
  candidates,
  contract,
  onProgress,
  owners,
  publicClient,
  signal,
  snapshotBlock,
  standard
}: {
  candidates: CandidateMap;
  contract: Address;
  onProgress: DiscoverNftAssetsFromCandidatesParameters["onProgress"];
  owners: readonly Address[];
  publicClient: NftCandidateDiscoveryClient;
  signal?: AbortSignal;
  snapshotBlock: bigint;
  standard: NftCandidateStandard;
}) {
  const issues: NftCandidateDiscoveryIssue[] = [];
  const requestState = { count: 0 };
  const ownerChunks = Array.from(
    { length: Math.ceil(owners.length / ownerTopicChunkSize) },
    (_, index) => owners.slice(index * ownerTopicChunkSize, (index + 1) * ownerTopicChunkSize)
  );

  try {
    for (const [ownerChunkIndex, ownerChunk] of ownerChunks.entries()) {
      throwIfAborted(signal);
      if (standard === "erc721") {
        await scanLogRanges(snapshotBlock, async (fromBlock, toBlock) => {
          const logs = await publicClient.getLogs({
            address: contract,
            args: { to: ownerChunk },
            event: erc721TransferEvent,
            fromBlock,
            strict: true,
            toBlock
          });
          for (const log of logs) addCandidate(candidates, log.args.tokenId, log.args.to);
        }, requestState, signal);
        await scanLogRanges(snapshotBlock, async (fromBlock, toBlock) => {
          const logs = await publicClient.getLogs({
            address: contract,
            args: { toAddress: ownerChunk },
            event: consecutiveTransferEvent,
            fromBlock,
            strict: true,
            toBlock
          });
          for (const log of logs) {
            const { fromTokenId, toAddress, toTokenId } = log.args;
            if (toTokenId < fromTokenId) continue;
            const count = toTokenId - fromTokenId + 1n;
            if (count > BigInt(maximumCandidateTokenIds - candidates.size)) {
              throw new CandidateLimitExceededError(
                `ConsecutiveTransfer 区间包含 ${count} 个 Token ID，超过候选安全上限`
              );
            }
            for (let tokenId = fromTokenId; tokenId <= toTokenId; tokenId += 1n) {
              addCandidate(candidates, tokenId, toAddress);
            }
          }
        }, requestState, signal);
      } else {
        await scanLogRanges(snapshotBlock, async (fromBlock, toBlock) => {
          const logs = await publicClient.getLogs({
            address: contract,
            args: { to: ownerChunk },
            event: erc1155TransferSingleEvent,
            fromBlock,
            strict: true,
            toBlock
          });
          for (const log of logs) addCandidate(candidates, log.args.id, log.args.to);
        }, requestState, signal);
        await scanLogRanges(snapshotBlock, async (fromBlock, toBlock) => {
          const logs = await publicClient.getLogs({
            address: contract,
            args: { to: ownerChunk },
            event: erc1155TransferBatchEvent,
            fromBlock,
            strict: true,
            toBlock
          });
          for (const log of logs) {
            for (const tokenId of log.args.ids) addCandidate(candidates, tokenId, log.args.to);
          }
        }, requestState, signal);
      }
      emitProgress(onProgress, {
        candidates: candidates.size,
        message: `Transfer 事件 ${ownerChunkIndex + 1}/${ownerChunks.length}`,
        stage: "scanning-events",
        verified: 0
      });
    }
    return { complete: true, issues };
  } catch (error) {
    throwIfAborted(signal);
    const isCandidateLimit = error instanceof CandidateLimitExceededError;
    const isRequestLimit = error instanceof LogRequestLimitExceededError;
    issues.push({
      code: isCandidateLimit
        ? "candidate-limit-exceeded"
        : isRequestLimit ? "log-scan-limit-exceeded" : "log-scan-failed",
      message: isCandidateLimit || isRequestLimit
        ? error.message
        : `Transfer 事件扫描未完成：${safeMessage(error, "RPC 不支持该日志范围")}`
    });
    return { complete: false, issues };
  }
}

function createAsset(
  contract: Address,
  standard: NftCandidateStandard,
  tokenId: bigint,
  ownerAddress?: Address
): NftCandidateAsset {
  return {
    contractAddress: contract,
    key: `${standard}:${contract.toLowerCase()}:${tokenId}`,
    ...(standard === "erc721" && ownerAddress ? { ownerAddress } : {}),
    standard,
    tokenId
  } as NftCandidateAsset;
}

async function readWithMulticallFallback(
  publicClient: NftCandidateDiscoveryClient,
  contracts: readonly {
    abi: typeof ownershipAbi;
    address: Address;
    args: readonly unknown[];
    functionName: "balanceOf" | "ownerOf";
  }[],
  snapshotBlock: bigint,
  signal?: AbortSignal
) {
  try {
    const results = await publicClient.multicall({
      allowFailure: true,
      blockNumber: snapshotBlock,
      contracts: contracts as never
    });
    return (results as readonly { result?: unknown; status: "failure" | "success" }[]).map((entry) => (
      entry.status === "success" ? entry.result : null
    ));
  } catch {
    return mapWithConcurrency(contracts, 10, async (contractCall) => {
      throwIfAborted(signal);
      try {
        return await publicClient.readContract({
          ...contractCall,
          blockNumber: snapshotBlock
        } as never);
      } catch {
        return null;
      }
    });
  }
}

async function readErc721Balances(
  contract: Address,
  owners: readonly Address[],
  publicClient: NftCandidateDiscoveryClient,
  snapshotBlock: bigint,
  signal?: AbortSignal
) {
  const calls = owners.map((owner) => ({
    abi: ownershipAbi,
    address: contract,
    args: [owner] as const,
    functionName: "balanceOf" as const
  }));
  const values = await readWithMulticallFallback(publicClient, calls, snapshotBlock, signal);
  const balances = new Map<string, bigint>();
  let complete = true;
  values.forEach((value, index) => {
    if (typeof value !== "bigint" || value < 0n) {
      complete = false;
      return;
    }
    balances.set(owners[index].toLowerCase(), value);
  });
  return { balances, complete };
}

async function verifyErc721Candidates({
  candidates,
  contract,
  onProgress,
  owners,
  publicClient,
  signal,
  snapshotBlock
}: {
  candidates: CandidateMap;
  contract: Address;
  onProgress: DiscoverNftAssetsFromCandidatesParameters["onProgress"];
  owners: readonly Address[];
  publicClient: NftCandidateDiscoveryClient;
  signal?: AbortSignal;
  snapshotBlock: bigint;
}) {
  emitProgress(onProgress, {
    candidates: candidates.size,
    message: "正在读取来源钱包 balanceOf",
    stage: "reading-balances",
    verified: 0
  });
  const { balances, complete: balancesComplete } = await readErc721Balances(
    contract,
    owners,
    publicClient,
    snapshotBlock,
    signal
  );
  const ownerSet = new Set(owners.map((owner) => owner.toLowerCase()));
  const tokenIds = [...candidates.keys()].map(BigInt);
  const calls = tokenIds.map((tokenId) => ({
    abi: ownershipAbi,
    address: contract,
    args: [tokenId] as const,
    functionName: "ownerOf" as const
  }));
  const values: unknown[] = [];
  for (let index = 0; index < calls.length; index += 200) {
    throwIfAborted(signal);
    values.push(...await readWithMulticallFallback(
      publicClient,
      calls.slice(index, index + 200),
      snapshotBlock,
      signal
    ));
    emitProgress(onProgress, {
      candidates: candidates.size,
      message: `ownerOf ${Math.min(index + 200, calls.length)}/${calls.length}`,
      stage: "verifying",
      verified: values.length
    });
  }

  const assets: NftCandidateAsset[] = [];
  const discoveredByOwner = new Map<string, bigint>();
  let verificationComplete = true;
  values.forEach((value, index) => {
    if (value === null) {
      // A revert is expected for a burned candidate and does not make the candidate set unsafe.
      return;
    }
    if (typeof value !== "string" || !isAddress(value) || getAddress(value) === zeroAddress) {
      verificationComplete = false;
      return;
    }
    const owner = getAddress(value).toLowerCase();
    if (!ownerSet.has(owner)) return;
    assets.push(createAsset(contract, "erc721", tokenIds[index], getAddress(value)));
    discoveredByOwner.set(owner, (discoveredByOwner.get(owner) || 0n) + 1n);
  });
  assets.sort((left, right) => left.tokenId < right.tokenId ? -1 : left.tokenId > right.tokenId ? 1 : 0);
  const expectedBalance = balancesComplete
    ? [...balances.values()].reduce((sum, balance) => sum + balance, 0n)
    : null;
  const reconciled = balancesComplete && verificationComplete && owners.every((owner) => (
    (discoveredByOwner.get(owner.toLowerCase()) || 0n) === balances.get(owner.toLowerCase())
  ));
  return { assets, expectedBalance, reconciled, verificationComplete: balancesComplete && verificationComplete };
}

async function verifyErc1155Candidates({
  candidates,
  contract,
  onProgress,
  owners,
  publicClient,
  signal,
  snapshotBlock
}: {
  candidates: CandidateMap;
  contract: Address;
  onProgress: DiscoverNftAssetsFromCandidatesParameters["onProgress"];
  owners: readonly Address[];
  publicClient: NftCandidateDiscoveryClient;
  signal?: AbortSignal;
  snapshotBlock: bigint;
}) {
  const tokenIds = [...candidates.keys()].map(BigInt);
  const totalChecks = BigInt(tokenIds.length) * BigInt(owners.length);
  if (totalChecks > BigInt(maximumEvmCollectionChecks)) {
    return {
      assets: [] as NftCandidateAsset[],
      issue: {
        code: "verification-limit-exceeded" as const,
        message: `ERC1155 候选需要 ${totalChecks} 次余额配对检查，超过 ${maximumEvmCollectionChecks} 次安全上限`
      },
      verificationComplete: false
    };
  }

  const pairs = tokenIds.flatMap((tokenId) => owners.map((owner) => ({ owner, tokenId })));
  const positiveTokenIds = new Set<string>();
  let verificationComplete = true;
  for (let index = 0; index < pairs.length; index += 500) {
    throwIfAborted(signal);
    const chunk = pairs.slice(index, index + 500);
    try {
      const result = await publicClient.readContract({
        abi: ownershipAbi,
        address: contract,
        args: [chunk.map((pair) => pair.owner), chunk.map((pair) => pair.tokenId)],
        blockNumber: snapshotBlock,
        functionName: "balanceOfBatch"
      });
      if (!Array.isArray(result) || result.length !== chunk.length
        || result.some((value) => typeof value !== "bigint" || value < 0n)) {
        verificationComplete = false;
        break;
      }
      result.forEach((balance, pairIndex) => {
        if (balance > 0n) positiveTokenIds.add(chunk[pairIndex].tokenId.toString());
      });
    } catch {
      verificationComplete = false;
      break;
    }
    emitProgress(onProgress, {
      candidates: candidates.size,
      message: `balanceOfBatch ${Math.min(index + 500, pairs.length)}/${pairs.length}`,
      stage: "verifying",
      verified: Math.min(index + 500, pairs.length)
    });
  }
  const assets = [...positiveTokenIds]
    .map((tokenId) => createAsset(contract, "erc1155", BigInt(tokenId)))
    .sort((left, right) => left.tokenId < right.tokenId ? -1 : left.tokenId > right.tokenId ? 1 : 0);
  return { assets, issue: null, verificationComplete };
}

export async function discoverNftAssetsFromCandidates(
  parameters: DiscoverNftAssetsFromCandidatesParameters
): Promise<NftCandidateDiscoveryResult> {
  throwIfAborted(parameters.signal);
  const normalized = normalizeInputs(parameters.contractAddress, parameters.ownerAddresses);
  const issues = [...normalized.issues];
  const emptyResult = (overrides: Partial<NftCandidateDiscoveryResult> = {}): NftCandidateDiscoveryResult => ({
    assets: [],
    candidateCount: 0,
    complete: false,
    eventScanComplete: false,
    expectedBalance: null,
    issues,
    openSeaComplete: false,
    openSeaUsed: false,
    snapshotBlock: parameters.snapshotBlock,
    sources: [],
    ...overrides
  });
  if (!normalized.contract || !normalized.owners.length) return emptyResult();

  const contract = normalized.contract;
  const owners = normalized.owners;
  const candidates: CandidateMap = new Map();
  const sources: NftCandidateDiscoveryResult["sources"] = [];
  const apiKey = parameters.openSeaApiKey?.trim() || "";
  const openSeaChain = getOpenSeaChainIdentifier(parameters.chainId);
  let openSeaComplete = false;
  let openSeaUsed = false;

  if (apiKey && openSeaChain) {
    openSeaUsed = true;
    const openSea = await fetchOpenSeaCandidates({
      apiKey,
      chain: openSeaChain,
      contract,
      fetcher: parameters.fetcher || fetch,
      onProgress: parameters.onProgress,
      owners,
      signal: parameters.signal
    });
    mergeCandidates(candidates, openSea.candidates);
    issues.push(...openSea.issues);
    openSeaComplete = openSea.complete;
    sources.push("opensea");

    if (parameters.standard === "erc721") {
      const verified = await verifyErc721Candidates({
        candidates,
        contract,
        onProgress: parameters.onProgress,
        owners,
        publicClient: parameters.publicClient,
        signal: parameters.signal,
        snapshotBlock: parameters.snapshotBlock
      });
      if (verified.reconciled) {
        if (verified.assets.length > maximumEvmCollectionAssets) {
          issues.push({
            code: "candidate-limit-exceeded",
            message: `来源钱包持有 ${verified.assets.length} 个 NFT，超过单轮 ${maximumEvmCollectionAssets} 个资产上限`
          });
          return emptyResult({
            candidateCount: candidates.size,
            expectedBalance: verified.expectedBalance,
            issues,
            openSeaComplete,
            openSeaUsed,
            sources
          });
        }
        return emptyResult({
          assets: verified.assets,
          candidateCount: candidates.size,
          complete: true,
          expectedBalance: verified.expectedBalance,
          issues,
          openSeaComplete,
          openSeaUsed,
          sources
        });
      }
    }
  }

  emitProgress(parameters.onProgress, {
    candidates: candidates.size,
    message: "正在扫描 Transfer 事件",
    stage: "scanning-events",
    verified: 0
  });
  const eventScan = await scanTransferEventCandidates({
    candidates,
    contract,
    onProgress: parameters.onProgress,
    owners,
    publicClient: parameters.publicClient,
    signal: parameters.signal,
    snapshotBlock: parameters.snapshotBlock,
    standard: parameters.standard
  });
  issues.push(...eventScan.issues);
  sources.push("transfer-events");

  if (parameters.standard === "erc721") {
    const verified = await verifyErc721Candidates({
      candidates,
      contract,
      onProgress: parameters.onProgress,
      owners,
      publicClient: parameters.publicClient,
      signal: parameters.signal,
      snapshotBlock: parameters.snapshotBlock
    });
    if (!verified.verificationComplete) {
      issues.push({ code: "verification-failed", message: "部分 ownerOf 或 balanceOf 复核失败" });
    }
    if (verified.assets.length > maximumEvmCollectionAssets) {
      issues.push({
        code: "candidate-limit-exceeded",
        message: `来源钱包持有 ${verified.assets.length} 个 NFT，超过单轮 ${maximumEvmCollectionAssets} 个资产上限`
      });
      return emptyResult({
        candidateCount: candidates.size,
        eventScanComplete: eventScan.complete,
        expectedBalance: verified.expectedBalance,
        issues,
        openSeaComplete,
        openSeaUsed,
        sources
      });
    }
    return emptyResult({
      assets: verified.assets,
      candidateCount: candidates.size,
      complete: verified.reconciled,
      eventScanComplete: eventScan.complete,
      expectedBalance: verified.expectedBalance,
      issues,
      openSeaComplete,
      openSeaUsed,
      sources
    });
  }

  const verified = await verifyErc1155Candidates({
    candidates,
    contract,
    onProgress: parameters.onProgress,
    owners,
    publicClient: parameters.publicClient,
    signal: parameters.signal,
    snapshotBlock: parameters.snapshotBlock
  });
  if (verified.issue) issues.push(verified.issue);
  if (!verified.verificationComplete && !verified.issue) {
    issues.push({ code: "verification-failed", message: "部分 ERC1155 balanceOfBatch 复核失败" });
  }
  if (verified.assets.length > maximumEvmCollectionAssets) {
    issues.push({
      code: "candidate-limit-exceeded",
      message: `来源钱包持有 ${verified.assets.length} 个 NFT，超过单轮 ${maximumEvmCollectionAssets} 个资产上限`
    });
    return emptyResult({
      candidateCount: candidates.size,
      eventScanComplete: eventScan.complete,
      issues,
      openSeaComplete,
      openSeaUsed,
      sources
    });
  }
  return emptyResult({
    assets: verified.assets,
    candidateCount: candidates.size,
    complete: eventScan.complete && verified.verificationComplete,
    eventScanComplete: eventScan.complete,
    issues,
    openSeaComplete,
    openSeaUsed,
    sources
  });
}
