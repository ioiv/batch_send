import {
  getAddress,
  isAddress,
  parseAbi,
  zeroAddress,
  type Address,
  type PublicClient
} from "viem";
import { maximumEvmCollectionAssets } from "./collection-workload";
import type { EvmCollectionAsset } from "./evm-collection";

const ownershipAbi = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function balanceOf(address owner) view returns (uint256)"
]);

export type Erc721IndexedCandidate = {
  ownerAddress: string;
  tokenId: bigint;
};

export type Erc721CandidateVerificationIssue = {
  code: "invalid-input" | "candidate-limit" | "owner-read-failed" | "balance-read-failed" | "balance-mismatch" | "stale-index";
  message: string;
  ownerAddress?: Address;
  tokenId?: bigint;
};

export type Erc721CandidateVerificationResult = {
  assets: Extract<EvmCollectionAsset, { standard: "erc721" }>[];
  complete: boolean;
  issues: Erc721CandidateVerificationIssue[];
  owners: Array<{
    balance: bigint | null;
    indexed: number;
    ownerAddress: Address;
    status: "complete" | "mismatch" | "failed";
    verified: number;
  }>;
  snapshotBlock: bigint | null;
};

export type Erc721CandidateVerificationClient = Pick<PublicClient, "getBlockNumber" | "readContract">;

function createAsset(contractAddress: Address, tokenId: bigint): Extract<EvmCollectionAsset, { standard: "erc721" }> {
  return {
    contractAddress,
    key: `erc721:${contractAddress.toLowerCase()}:${tokenId.toString()}`,
    standard: "erc721",
    tokenId
  };
}

function normalizeOwners(values: readonly string[]) {
  const owners: Address[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!isAddress(value)) return null;
    const owner = getAddress(value);
    if (owner === zeroAddress) return null;
    const key = owner.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    owners.push(owner);
  }
  return owners;
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>
) {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(values.length, 1)) }, worker));
  return results;
}

export async function verifyErc721IndexedCandidates({
  candidates,
  concurrency = 12,
  contractAddress,
  ownerAddresses,
  publicClient
}: {
  candidates: readonly Erc721IndexedCandidate[];
  concurrency?: number;
  contractAddress: string;
  ownerAddresses: readonly string[];
  publicClient: Erc721CandidateVerificationClient;
}): Promise<Erc721CandidateVerificationResult> {
  const empty: Erc721CandidateVerificationResult = {
    assets: [],
    complete: false,
    issues: [],
    owners: [],
    snapshotBlock: null
  };
  if (!isAddress(contractAddress) || getAddress(contractAddress) === zeroAddress
    || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    empty.issues.push({ code: "invalid-input", message: "NFT 合约或并发参数不正确" });
    return empty;
  }
  const owners = normalizeOwners(ownerAddresses);
  if (!owners?.length) {
    empty.issues.push({ code: "invalid-input", message: "至少需要一个有效来源地址" });
    return empty;
  }
  if (candidates.length > maximumEvmCollectionAssets) {
    empty.issues.push({
      code: "candidate-limit",
      message: `索引器返回超过 ${maximumEvmCollectionAssets} 个候选 NFT，请拆分来源钱包`
    });
    return empty;
  }

  const contract = getAddress(contractAddress);
  const ownerSet = new Set(owners.map((owner) => owner.toLowerCase()));
  const indexedByOwner = new Map(owners.map((owner) => [owner.toLowerCase(), new Set<string>()]));
  const uniqueCandidates = new Map<string, { ownerAddress: Address; tokenId: bigint }>();
  for (const candidate of candidates) {
    if (!isAddress(candidate.ownerAddress) || candidate.tokenId < 0n) {
      empty.issues.push({ code: "invalid-input", message: "索引器候选包含无效 owner 或 Token ID" });
      continue;
    }
    const ownerAddress = getAddress(candidate.ownerAddress);
    if (!ownerSet.has(ownerAddress.toLowerCase())) {
      empty.issues.push({ code: "invalid-input", message: "索引器候选不属于本次来源地址" });
      continue;
    }
    const tokenKey = candidate.tokenId.toString();
    indexedByOwner.get(ownerAddress.toLowerCase())?.add(tokenKey);
    if (!uniqueCandidates.has(tokenKey)) uniqueCandidates.set(tokenKey, { ownerAddress, tokenId: candidate.tokenId });
  }
  if (empty.issues.some((issue) => issue.code === "invalid-input")) return empty;

  let snapshotBlock: bigint;
  try {
    snapshotBlock = await publicClient.getBlockNumber();
  } catch {
    empty.issues.push({ code: "owner-read-failed", message: "无法读取链上快照区块" });
    return empty;
  }

  const issues: Erc721CandidateVerificationIssue[] = [];
  const verifiedByOwner = new Map(owners.map((owner) => [owner.toLowerCase(), new Set<string>()]));
  const verifiedAssets: Extract<EvmCollectionAsset, { standard: "erc721" }>[] = [];
  await mapConcurrent([...uniqueCandidates.values()], concurrency, async (candidate) => {
    try {
      const value = await publicClient.readContract({
        abi: ownershipAbi,
        address: contract,
        args: [candidate.tokenId],
        blockNumber: snapshotBlock,
        functionName: "ownerOf"
      });
      if (typeof value !== "string" || !isAddress(value)) throw new Error("invalid ownerOf response");
      const actualOwner = getAddress(value);
      if (!ownerSet.has(actualOwner.toLowerCase())) {
        issues.push({
          code: "stale-index",
          message: `Token ID ${candidate.tokenId.toString()} 已不属于所选来源，已排除`,
          ownerAddress: candidate.ownerAddress,
          tokenId: candidate.tokenId
        });
        return;
      }
      if (actualOwner.toLowerCase() !== candidate.ownerAddress.toLowerCase()) {
        issues.push({
          code: "stale-index",
          message: `Token ID ${candidate.tokenId.toString()} 的索引归属已变化，已按链上 ownerOf 修正`,
          ownerAddress: actualOwner,
          tokenId: candidate.tokenId
        });
      }
      verifiedByOwner.get(actualOwner.toLowerCase())?.add(candidate.tokenId.toString());
      verifiedAssets.push(createAsset(contract, candidate.tokenId));
    } catch {
      issues.push({
        code: "owner-read-failed",
        message: `Token ID ${candidate.tokenId.toString()} 的 ownerOf 复核失败`,
        ownerAddress: candidate.ownerAddress,
        tokenId: candidate.tokenId
      });
    }
  });

  const ownerResults = await mapConcurrent(owners, Math.min(concurrency, 16), async (ownerAddress) => {
    const indexed = indexedByOwner.get(ownerAddress.toLowerCase())?.size || 0;
    const verified = verifiedByOwner.get(ownerAddress.toLowerCase())?.size || 0;
    try {
      const value = await publicClient.readContract({
        abi: ownershipAbi,
        address: contract,
        args: [ownerAddress],
        blockNumber: snapshotBlock,
        functionName: "balanceOf"
      });
      if (typeof value !== "bigint" || value < 0n) throw new Error("invalid balanceOf response");
      if (value !== BigInt(verified)) {
        issues.push({
          code: "balance-mismatch",
          message: `来源 ${ownerAddress.slice(0, 8)}… 的链上余额为 ${value.toString()}，索引复核得到 ${verified} 个`,
          ownerAddress
        });
        return { balance: value, indexed, ownerAddress, status: "mismatch" as const, verified };
      }
      return { balance: value, indexed, ownerAddress, status: "complete" as const, verified };
    } catch {
      issues.push({ code: "balance-read-failed", message: "无法复核来源钱包的 ERC721 余额", ownerAddress });
      return { balance: null, indexed, ownerAddress, status: "failed" as const, verified };
    }
  });

  verifiedAssets.sort((left, right) => left.tokenId < right.tokenId ? -1 : left.tokenId > right.tokenId ? 1 : 0);
  return {
    assets: verifiedAssets,
    complete: !issues.some((issue) => issue.code !== "stale-index")
      && ownerResults.every((owner) => owner.status === "complete"),
    issues,
    owners: ownerResults,
    snapshotBlock
  };
}
