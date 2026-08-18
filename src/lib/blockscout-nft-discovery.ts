import { getAddress, isAddress, zeroAddress, type Address } from "viem";
import { maximumCollectionSources, maximumEvmCollectionChecks } from "./collection-workload";
import type { EvmCollectionAsset } from "./evm-collection";

const defaultMaxPagesPerOwner = 50;
const defaultMaxEntries = maximumEvmCollectionChecks;
const absoluteMaxPagesPerOwner = 100;
const absoluteMaxEntries = maximumEvmCollectionChecks;
const maximumTotalPages = maximumEvmCollectionChecks;
const maximumResponseItems = 200;
const uint256Maximum = (1n << 256n) - 1n;

const secretPattern = /0x[0-9a-fA-F]{64}/g;
const urlPattern = /https?:\/\/\S+/gi;
const dataUriPattern = /data:[^\s"']+/gi;

export const MAX_BLOCKSCOUT_NFT_DISCOVERY_OWNERS = maximumCollectionSources;
export const MAX_BLOCKSCOUT_NFT_DISCOVERY_PAGES_PER_OWNER = absoluteMaxPagesPerOwner;
export const MAX_BLOCKSCOUT_NFT_DISCOVERY_ENTRIES = absoluteMaxEntries;
export const MAX_BLOCKSCOUT_NFT_DISCOVERY_RESPONSE_ITEMS = maximumResponseItems;

export type BlockscoutNftDiscoveryErrorCode =
  | "aborted"
  | "entry-limit-exceeded"
  | "http-error"
  | "invalid-input"
  | "invalid-response"
  | "page-limit-exceeded"
  | "pagination-loop"
  | "request-failed";

/** An error whose message is bounded and safe to show in the page. */
export class BlockscoutNftDiscoveryError extends Error {
  readonly code: BlockscoutNftDiscoveryErrorCode;

  constructor(code: BlockscoutNftDiscoveryErrorCode, message: string) {
    super(safeMessage(message) || "Blockscout 请求失败");
    this.code = code;
    this.name = "BlockscoutNftDiscoveryError";
  }
}

export type BlockscoutNftDiscoveryFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Pick<Response, "json" | "ok" | "status">>;

export type BlockscoutErc721CandidateAsset = Extract<
  EvmCollectionAsset,
  { standard: "erc721" }
> & {
  /** Blockscout is an indexer: ownerOf must still be checked on-chain. */
  candidate: true;
  discoverySource: "blockscout";
};

export type BlockscoutNftDiscoveryIssue = {
  code: BlockscoutNftDiscoveryErrorCode;
  contractAddress: Address | null;
  /** Always bounded and scrubbed before being returned. */
  message: string;
  ownerAddress: Address | null;
  safeForDisplay: true;
};

export type BlockscoutNftDiscoveryOwnerStatus =
  | "aborted"
  | "complete"
  | "failed"
  | "limit-exceeded"
  | "partial";

export type BlockscoutNftDiscoveryOwner = {
  /** Unverified indexer candidates, deduplicated within this owner. */
  assets: BlockscoutErc721CandidateAsset[];
  entriesRead: number;
  issues: BlockscoutNftDiscoveryIssue[];
  ownerAddress: Address;
  pagesRead: number;
  status: BlockscoutNftDiscoveryOwnerStatus;
};

export type BlockscoutNftDiscoveryResult = {
  /** Globally deduplicated candidates. Every candidate still needs ownerOf. */
  assets: BlockscoutErc721CandidateAsset[];
  complete: boolean;
  contractAddress: Address | null;
  entriesRead: number;
  issues: BlockscoutNftDiscoveryIssue[];
  owners: BlockscoutNftDiscoveryOwner[];
  pagesRead: number;
};

export type DiscoverBlockscoutErc721CandidatesParameters = {
  baseUrl: string;
  contractAddress: string;
  fetch?: BlockscoutNftDiscoveryFetch;
  /** Lower per-run cap. Values above the hard cap are rejected. */
  maxEntries?: number;
  /** Lower per-owner cap. Values above the hard cap are rejected. */
  maxPagesPerOwner?: number;
  ownerAddresses: readonly string[];
  signal?: AbortSignal;
};

type JsonRecord = Record<string, unknown>;

function safeMessage(message: string) {
  return message
    .replace(dataUriPattern, "[data URI 已隐藏]")
    .replace(secretPattern, "[已隐藏敏感内容]")
    .replace(urlPattern, "[Blockscout 地址已隐藏]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAbortError(error: unknown, signal?: AbortSignal) {
  return Boolean(signal?.aborted)
    || (isRecord(error) && error.name === "AbortError");
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof BlockscoutNftDiscoveryError) return error.message;
  if (isRecord(error) && typeof error.message === "string") {
    return safeMessage(error.message) || fallback;
  }
  return fallback;
}

function normalizeBaseUrl(baseUrl: string) {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new BlockscoutNftDiscoveryError("invalid-input", "Blockscout 地址格式不正确");
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password
    || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new BlockscoutNftDiscoveryError(
      "invalid-input",
      "Blockscout 地址必须是无账号、参数和子路径的 HTTPS 站点地址"
    );
  }
  return url.origin;
}

function normalizeAddress(value: string, label: string) {
  if (!isAddress(value)) {
    throw new BlockscoutNftDiscoveryError("invalid-input", `${label}格式不正确`);
  }
  const address = getAddress(value);
  if (address.toLowerCase() === zeroAddress) {
    throw new BlockscoutNftDiscoveryError("invalid-input", `${label}不能是零地址`);
  }
  return address;
}

function issueFromError(
  error: unknown,
  contractAddress: Address | null,
  ownerAddress: Address | null,
  fallback = "Blockscout 请求失败"
): BlockscoutNftDiscoveryIssue {
  return {
    code: error instanceof BlockscoutNftDiscoveryError ? error.code : "request-failed",
    contractAddress,
    message: getErrorMessage(error, fallback),
    ownerAddress,
    safeForDisplay: true
  };
}

function defaultFetch(input: RequestInfo | URL, init?: RequestInit) {
  return fetch(input, init);
}

async function readJson(
  url: URL,
  fetchImpl: BlockscoutNftDiscoveryFetch,
  signal?: AbortSignal
) {
  if (signal?.aborted) {
    throw new BlockscoutNftDiscoveryError("aborted", "Blockscout 扫描已取消");
  }
  let response: Pick<Response, "json" | "ok" | "status">;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      method: "GET",
      signal
    });
  } catch (error) {
    if (isAbortError(error, signal)) {
      throw new BlockscoutNftDiscoveryError("aborted", "Blockscout 扫描已取消");
    }
    throw new BlockscoutNftDiscoveryError(
      "request-failed",
      getErrorMessage(error, "无法连接 Blockscout")
    );
  }
  if (!response || typeof response.ok !== "boolean" || !Number.isSafeInteger(response.status)) {
    throw new BlockscoutNftDiscoveryError("invalid-response", "Blockscout HTTP 响应格式不正确");
  }
  if (!response.ok) {
    throw new BlockscoutNftDiscoveryError(
      "http-error",
      `Blockscout 请求失败（HTTP ${response.status}）`
    );
  }
  try {
    return await response.json() as unknown;
  } catch (error) {
    if (isAbortError(error, signal)) {
      throw new BlockscoutNftDiscoveryError("aborted", "Blockscout 扫描已取消");
    }
    throw new BlockscoutNftDiscoveryError("invalid-response", "Blockscout 返回的 JSON 无法解析");
  }
}

function parseTokenId(value: unknown) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 78) {
    return null;
  }
  try {
    const tokenId = BigInt(value);
    return tokenId <= uint256Maximum ? tokenId : null;
  } catch {
    return null;
  }
}

function readAddress(value: unknown) {
  return typeof value === "string" && isAddress(value) ? getAddress(value) : null;
}

function getDeclaredContract(item: JsonRecord) {
  const direct = item.contract_address_hash ?? item.address_hash;
  if (direct !== undefined) return { present: true, value: readAddress(direct) };
  if (item.token !== undefined) {
    if (!isRecord(item.token)) return { present: true, value: null };
    const nested = item.token.address_hash ?? item.token.address;
    if (nested !== undefined) return { present: true, value: readAddress(nested) };
  }
  return { present: false, value: null };
}

function getDeclaredOwner(item: JsonRecord) {
  const direct = item.owner_hash;
  if (direct !== undefined) return { present: true, value: readAddress(direct) };
  if (item.owner !== undefined) {
    if (typeof item.owner === "string") return { present: true, value: readAddress(item.owner) };
    if (!isRecord(item.owner)) return { present: true, value: null };
    const nested = item.owner.hash ?? item.owner.address_hash ?? item.owner.address;
    if (nested !== undefined) return { present: true, value: readAddress(nested) };
  }
  return { present: false, value: null };
}

function parseCandidate(
  item: unknown,
  contractAddress: Address,
  ownerAddress: Address
): BlockscoutErc721CandidateAsset | null {
  if (!isRecord(item)) return null;
  const tokenId = parseTokenId(item.id);
  if (tokenId === null) return null;

  const declaredContract = getDeclaredContract(item);
  if (declaredContract.present && (!declaredContract.value
    || declaredContract.value.toLowerCase() !== contractAddress.toLowerCase())) return null;
  const declaredOwner = getDeclaredOwner(item);
  if (declaredOwner.present && (!declaredOwner.value
    || declaredOwner.value.toLowerCase() !== ownerAddress.toLowerCase())) return null;

  return {
    candidate: true,
    contractAddress,
    discoverySource: "blockscout",
    key: `erc721:${contractAddress.toLowerCase()}:${tokenId}`,
    standard: "erc721",
    tokenId
  };
}

function parseNextCursor(value: unknown) {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || !("unique_token" in value)) {
    throw new BlockscoutNftDiscoveryError(
      "invalid-response",
      "Blockscout 分页参数格式不正确"
    );
  }
  const raw = value.unique_token;
  if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw) || raw < 0) {
      throw new BlockscoutNftDiscoveryError("invalid-response", "Blockscout 分页游标格式不正确");
    }
    return String(raw);
  }
  if (typeof raw !== "string" || parseTokenId(raw) === null) {
    throw new BlockscoutNftDiscoveryError("invalid-response", "Blockscout 分页游标格式不正确");
  }
  return raw;
}

function createInstancesUrl(
  baseUrl: string,
  contractAddress: Address,
  ownerAddress: Address,
  cursor: string | null
) {
  const url = new URL(`/api/v2/tokens/${contractAddress}/instances`, baseUrl);
  url.searchParams.set("holder_address_hash", ownerAddress);
  if (cursor !== null) url.searchParams.set("unique_token", cursor);
  return url;
}

function statusAfterError(
  issue: BlockscoutNftDiscoveryIssue,
  hasProgress: boolean
): BlockscoutNftDiscoveryOwnerStatus {
  if (issue.code === "aborted") return "aborted";
  if (issue.code === "entry-limit-exceeded" || issue.code === "page-limit-exceeded") {
    return "limit-exceeded";
  }
  return hasProgress ? "partial" : "failed";
}

function pendingOwner(
  ownerAddress: Address,
  issue: BlockscoutNftDiscoveryIssue
): BlockscoutNftDiscoveryOwner {
  return {
    assets: [],
    entriesRead: 0,
    issues: [issue],
    ownerAddress,
    pagesRead: 0,
    status: issue.code === "aborted" ? "aborted" : "limit-exceeded"
  };
}

/**
 * Reads holder-filtered ERC721 instances from a public Blockscout indexer.
 * Returned assets are candidates only; callers must verify ownerOf on-chain.
 * Only addresses and token ids are retained from responses.
 */
export async function discoverBlockscoutErc721Candidates(
  parameters: DiscoverBlockscoutErc721CandidatesParameters
): Promise<BlockscoutNftDiscoveryResult> {
  let baseUrl: string | null = null;
  let contractAddress: Address | null = null;
  const inputIssues: BlockscoutNftDiscoveryIssue[] = [];
  try {
    baseUrl = normalizeBaseUrl(parameters.baseUrl);
  } catch (error) {
    inputIssues.push(issueFromError(error, null, null));
  }
  try {
    contractAddress = normalizeAddress(parameters.contractAddress, "ERC721 合约地址");
  } catch (error) {
    inputIssues.push(issueFromError(error, null, null));
  }

  const maxPagesPerOwner = parameters.maxPagesPerOwner ?? defaultMaxPagesPerOwner;
  const maxEntries = parameters.maxEntries ?? defaultMaxEntries;
  if (!Number.isSafeInteger(maxPagesPerOwner) || maxPagesPerOwner < 1
    || maxPagesPerOwner > absoluteMaxPagesPerOwner) {
    inputIssues.push(issueFromError(new BlockscoutNftDiscoveryError(
      "invalid-input",
      `每个钱包分页上限必须是 1-${absoluteMaxPagesPerOwner} 的整数`
    ), contractAddress, null));
  }
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > absoluteMaxEntries) {
    inputIssues.push(issueFromError(new BlockscoutNftDiscoveryError(
      "invalid-input",
      `响应条目上限必须是 1-${absoluteMaxEntries} 的整数`
    ), contractAddress, null));
  }
  if (parameters.ownerAddresses.length === 0
    || parameters.ownerAddresses.length > MAX_BLOCKSCOUT_NFT_DISCOVERY_OWNERS) {
    inputIssues.push(issueFromError(new BlockscoutNftDiscoveryError(
      "invalid-input",
      parameters.ownerAddresses.length === 0
        ? "至少需要一个来源钱包地址"
        : `一次最多处理 ${MAX_BLOCKSCOUT_NFT_DISCOVERY_OWNERS} 个来源钱包`
    ), contractAddress, null));
  }

  const owners: Address[] = [];
  const seenOwners = new Set<string>();
  let hasInvalidOwner = false;
  if (parameters.ownerAddresses.length <= MAX_BLOCKSCOUT_NFT_DISCOVERY_OWNERS) {
    for (const rawOwner of parameters.ownerAddresses) {
      try {
        const ownerAddress = normalizeAddress(rawOwner, "来源钱包地址");
        const key = ownerAddress.toLowerCase();
        if (!seenOwners.has(key)) {
          seenOwners.add(key);
          owners.push(ownerAddress);
        }
      } catch (error) {
        hasInvalidOwner = true;
        inputIssues.push(issueFromError(error, contractAddress, null));
      }
    }
  }

  const result: BlockscoutNftDiscoveryResult = {
    assets: [],
    complete: false,
    contractAddress,
    entriesRead: 0,
    issues: inputIssues,
    owners: [],
    pagesRead: 0
  };
  if (inputIssues.length > 0 || hasInvalidOwner || !baseUrl || !contractAddress || owners.length === 0) {
    return result;
  }

  const fetchImpl = parameters.fetch ?? defaultFetch;
  const globalAssets = new Map<string, BlockscoutErc721CandidateAsset>();
  let stopped = false;

  for (let ownerIndex = 0; ownerIndex < owners.length; ownerIndex += 1) {
    const ownerAddress = owners[ownerIndex];
    const ownerIssues: BlockscoutNftDiscoveryIssue[] = [];
    const ownerAssets = new Map<string, BlockscoutErc721CandidateAsset>();
    const seenCursors = new Set<string>();
    let ownerEntriesRead = 0;
    let ownerPagesRead = 0;
    let ownerStatus: BlockscoutNftDiscoveryOwnerStatus = "complete";
    let cursor: string | null = null;

    while (true) {
      if (parameters.signal?.aborted) {
        const issue = issueFromError(
          new BlockscoutNftDiscoveryError("aborted", "Blockscout 扫描已取消"),
          contractAddress,
          ownerAddress
        );
        ownerIssues.push(issue);
        result.issues.push(issue);
        ownerStatus = "aborted";
        stopped = true;
        break;
      }
      if (ownerPagesRead >= maxPagesPerOwner || result.pagesRead >= maximumTotalPages) {
        const issue = issueFromError(new BlockscoutNftDiscoveryError(
          "page-limit-exceeded",
          `Blockscout 扫描已达到分页安全上限，${ownerAddress} 的结果可能不完整`
        ), contractAddress, ownerAddress);
        ownerIssues.push(issue);
        result.issues.push(issue);
        ownerStatus = "limit-exceeded";
        stopped = result.pagesRead >= maximumTotalPages;
        break;
      }

      let body: unknown;
      try {
        body = await readJson(
          createInstancesUrl(baseUrl, contractAddress, ownerAddress, cursor),
          fetchImpl,
          parameters.signal
        );
        ownerPagesRead += 1;
        result.pagesRead += 1;
      } catch (error) {
        const issue = issueFromError(error, contractAddress, ownerAddress);
        ownerIssues.push(issue);
        result.issues.push(issue);
        ownerStatus = statusAfterError(issue, ownerPagesRead > 0 || ownerAssets.size > 0);
        stopped = issue.code === "aborted";
        break;
      }

      if (!isRecord(body) || !Array.isArray(body.items)) {
        const issue = issueFromError(new BlockscoutNftDiscoveryError(
          "invalid-response",
          "Blockscout NFT 列表响应格式不正确"
        ), contractAddress, ownerAddress);
        ownerIssues.push(issue);
        result.issues.push(issue);
        ownerStatus = statusAfterError(issue, ownerPagesRead > 1 || ownerAssets.size > 0);
        break;
      }
      if (body.items.length > maximumResponseItems) {
        const issue = issueFromError(new BlockscoutNftDiscoveryError(
          "entry-limit-exceeded",
          `Blockscout 单页返回超过 ${maximumResponseItems} 个条目，已停止处理该钱包`
        ), contractAddress, ownerAddress);
        ownerIssues.push(issue);
        result.issues.push(issue);
        ownerStatus = "limit-exceeded";
        break;
      }
      if (result.entriesRead + body.items.length > maxEntries) {
        const issue = issueFromError(new BlockscoutNftDiscoveryError(
          "entry-limit-exceeded",
          `Blockscout 扫描已达到 ${maxEntries} 个响应条目的安全上限`
        ), contractAddress, ownerAddress);
        ownerIssues.push(issue);
        result.issues.push(issue);
        ownerStatus = "limit-exceeded";
        stopped = true;
        break;
      }

      ownerEntriesRead += body.items.length;
      result.entriesRead += body.items.length;
      let invalidEntries = 0;
      for (const item of body.items) {
        const asset = parseCandidate(item, contractAddress, ownerAddress);
        if (!asset) {
          invalidEntries += 1;
          continue;
        }
        ownerAssets.set(asset.key, asset);
        globalAssets.set(asset.key, asset);
      }
      if (invalidEntries > 0) {
        const issue = issueFromError(new BlockscoutNftDiscoveryError(
          "invalid-response",
          `Blockscout 本页有 ${invalidEntries} 个条目格式不正确，已忽略`
        ), contractAddress, ownerAddress);
        ownerIssues.push(issue);
        result.issues.push(issue);
        ownerStatus = "partial";
      }

      let nextCursor: string | null;
      try {
        nextCursor = parseNextCursor(body.next_page_params);
      } catch (error) {
        const issue = issueFromError(error, contractAddress, ownerAddress);
        ownerIssues.push(issue);
        result.issues.push(issue);
        ownerStatus = statusAfterError(issue, true);
        break;
      }
      if (nextCursor === null) break;
      if (seenCursors.has(nextCursor)) {
        const issue = issueFromError(new BlockscoutNftDiscoveryError(
          "pagination-loop",
          "Blockscout 返回了重复分页游标，已停止以避免无限请求"
        ), contractAddress, ownerAddress);
        ownerIssues.push(issue);
        result.issues.push(issue);
        ownerStatus = "partial";
        break;
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    result.owners.push({
      assets: [...ownerAssets.values()],
      entriesRead: ownerEntriesRead,
      issues: ownerIssues,
      ownerAddress,
      pagesRead: ownerPagesRead,
      status: ownerStatus
    });

    if (stopped) {
      const lastIssue = ownerIssues.at(-1) || issueFromError(new BlockscoutNftDiscoveryError(
        "entry-limit-exceeded",
        "Blockscout 扫描已达到安全上限"
      ), contractAddress, ownerAddress);
      for (let pendingIndex = ownerIndex + 1; pendingIndex < owners.length; pendingIndex += 1) {
        const pendingIssue: BlockscoutNftDiscoveryIssue = {
          ...lastIssue,
          ownerAddress: owners[pendingIndex]
        };
        result.issues.push(pendingIssue);
        result.owners.push(pendingOwner(owners[pendingIndex], pendingIssue));
      }
      break;
    }
  }

  result.assets = [...globalAssets.values()];
  result.complete = result.owners.length === owners.length
    && result.owners.every((owner) => owner.status === "complete");
  return result;
}

function parseCreationTransactionHash(body: unknown) {
  if (!isRecord(body) || typeof body.creation_transaction_hash !== "string"
    || !/^0x[0-9a-fA-F]{64}$/.test(body.creation_transaction_hash)) {
    throw new BlockscoutNftDiscoveryError(
      "invalid-response",
      "Blockscout 未返回有效的合约创建交易哈希"
    );
  }
  return body.creation_transaction_hash;
}

function parseBlockNumber(body: unknown) {
  if (!isRecord(body)) {
    throw new BlockscoutNftDiscoveryError("invalid-response", "Blockscout 创建交易响应格式不正确");
  }
  const value = body.block_number;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new BlockscoutNftDiscoveryError("invalid-response", "Blockscout 部署区块格式不正确");
    }
    return BigInt(value);
  }
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 78) {
    throw new BlockscoutNftDiscoveryError("invalid-response", "Blockscout 部署区块格式不正确");
  }
  try {
    const blockNumber = BigInt(value);
    if (blockNumber > uint256Maximum) throw new Error("out of range");
    return blockNumber;
  } catch {
    throw new BlockscoutNftDiscoveryError("invalid-response", "Blockscout 部署区块格式不正确");
  }
}

/** Resolve a deployment block without relying on historical eth_getCode. */
export async function resolveBlockscoutDeploymentBlock(
  baseUrl: string,
  contractAddress: string,
  fetchImpl: BlockscoutNftDiscoveryFetch = defaultFetch,
  signal?: AbortSignal
): Promise<bigint> {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const contract = normalizeAddress(contractAddress, "合约地址");
  const addressUrl = new URL(`/api/v2/addresses/${contract}`, normalizedBaseUrl);
  const addressBody = await readJson(addressUrl, fetchImpl, signal);
  const creationTransactionHash = parseCreationTransactionHash(addressBody);
  const transactionUrl = new URL(
    `/api/v2/transactions/${creationTransactionHash}`,
    normalizedBaseUrl
  );
  const transactionBody = await readJson(transactionUrl, fetchImpl, signal);
  return parseBlockNumber(transactionBody);
}
