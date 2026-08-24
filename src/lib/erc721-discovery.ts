import {
  getAddress,
  isAddress,
  parseAbi,
  zeroAddress,
  type Address,
  type PublicClient
} from "viem";
import { maximumCollectionSources, maximumEvmCollectionChecks } from "./collection-workload";
import type { EvmCollectionAsset } from "./evm-collection";

/** ERC165 interface id for ERC721. */
const erc721InterfaceId = "0x80ac58cd" as const;
/** ERC165 interface id for the optional ERC721Enumerable extension. */
const erc721EnumerableInterfaceId = "0x780e9d63" as const;
const erc165InterfaceId = "0x01ffc9a7" as const;
const invalidErc165InterfaceId = "0xffffffff" as const;

export const erc721DiscoveryAbi = parseAbi([
  "function supportsInterface(bytes4 interfaceId) view returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)"
]);

export type Erc721DiscoveryIssueCode =
  | "invalid-input"
  | "not-erc721"
  | "not-enumerable"
  | "interface-check-failed"
  | "balance-read-failed"
  | "balance-limit-exceeded"
  | "contract-limit-exceeded"
  | "owner-limit-exceeded"
  | "rpc-budget-exceeded"
  | "token-read-failed"
  | "invalid-response"
  | "duplicate-token";

export type Erc721DiscoveryIssue = {
  code: Erc721DiscoveryIssueCode;
  contractAddress: Address | null;
  message: string;
  ownerAddress: Address | null;
  tokenIndex?: bigint;
};

export type Erc721DiscoveryOwner = {
  balance: bigint | null;
  discovered: number;
  ownerAddress: Address;
  scanned: number;
  status: "complete" | "failed" | "limit-exceeded" | "unsupported";
};

export type Erc721DiscoveryProgress = {
  contractAddress: Address;
  discovered: number;
  ownerAddress: Address;
  ownerIndex: number;
  ownerTotal: number;
  scanned: number;
  stage: "checking-contract" | "reading-balance" | "reading-token" | "owner-complete";
  tokenIndex: bigint | null;
  tokenTotal: bigint | null;
};

export type Erc721DiscoveryResult = {
  /** Directly consumable by planEvmCollection. Only ERC721Enumerable assets are included. */
  assets: Array<Extract<EvmCollectionAsset, { standard: "erc721" }> & {
    ownerAddress: Address;
  }>;
  issues: Erc721DiscoveryIssue[];
  owners: Erc721DiscoveryOwner[];
  /** Number of attempted `readContract` RPC calls, including failed calls. */
  rpcRequests: number;
  /** All balance and index reads are pinned to this block when present. */
  snapshotBlock: bigint | null;
};

type ReadContractParameters = Parameters<PublicClient["readContract"]>[0];
export type Erc721DiscoveryReadContract = (
  parameters: ReadContractParameters
) => Promise<unknown>;

export type DiscoverEnumerableErc721AssetsParameters = {
  contractAddress: string;
  /** Optional lower per-run budget. Values above the hard cap are rejected. */
  maxRpcRequests?: number;
  maxTokensPerContract?: number;
  maxTokensPerOwner?: number;
  onProgress?: (progress: Erc721DiscoveryProgress) => void;
  ownerAddresses: readonly string[];
  publicClient: Pick<PublicClient, "getBlockNumber" | "readContract">;
  /** Intended for deterministic tests and alternate transports. */
  readContract?: Erc721DiscoveryReadContract;
};

const defaultMaxTokensPerOwner = 250;
const defaultMaxTokensPerContract = 1_000;
const absoluteMaxTokensPerOwner = 2_000;
const absoluteMaxTokensPerContract = 5_000;
export const MAX_ERC721_DISCOVERY_OWNERS = maximumCollectionSources;
export const MAX_ERC721_DISCOVERY_RPC_REQUESTS = maximumEvmCollectionChecks;
const minimumErc165Requests = 4;
const minimumDiscoveryRequests = minimumErc165Requests + 1;
const secretPattern = /0x[0-9a-fA-F]{64}/g;
const rpcUrlPattern = /https?:\/\/\S+/gi;

class RpcBudgetExceededError extends Error {}

function safeMessage(message: string) {
  return message
    .replace(secretPattern, "[已隐藏敏感内容]")
    .replace(rpcUrlPattern, "[RPC 地址已隐藏]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function getErrorMessage(error: unknown, fallback: string) {
  if (!error || typeof error !== "object") return fallback;
  const candidate = error as { message?: unknown; shortMessage?: unknown };
  if (typeof candidate.shortMessage === "string") return safeMessage(candidate.shortMessage) || fallback;
  if (typeof candidate.message === "string") return safeMessage(candidate.message) || fallback;
  return fallback;
}

function emitProgress(
  onProgress: DiscoverEnumerableErc721AssetsParameters["onProgress"],
  progress: Erc721DiscoveryProgress
) {
  try {
    onProgress?.(progress);
  } catch {
    // UI callbacks must not interrupt a read-only scan.
  }
}

function invalidIssue(message: string): Erc721DiscoveryIssue {
  return {
    code: "invalid-input",
    contractAddress: null,
    message,
    ownerAddress: null
  };
}

function limitIssue(
  code: "owner-limit-exceeded" | "rpc-budget-exceeded",
  contractAddress: Address,
  message: string,
  ownerAddress: Address | null = null
): Erc721DiscoveryIssue {
  return { code, contractAddress, message, ownerAddress };
}

function normalizeInputs({
  contractAddress,
  maxRpcRequests = MAX_ERC721_DISCOVERY_RPC_REQUESTS,
  maxTokensPerContract = defaultMaxTokensPerContract,
  maxTokensPerOwner = defaultMaxTokensPerOwner,
  ownerAddresses
}: Pick<
  DiscoverEnumerableErc721AssetsParameters,
  "contractAddress" | "maxRpcRequests" | "maxTokensPerContract" | "maxTokensPerOwner" | "ownerAddresses"
>) {
  const issues: Erc721DiscoveryIssue[] = [];
  if (!isAddress(contractAddress) || getAddress(contractAddress).toLowerCase() === zeroAddress) {
    issues.push(invalidIssue("ERC721 合约地址格式不正确"));
    return { contract: null, contractLimit: 0, issues, ownerLimit: 0, owners: [] as Address[], rpcBudget: 0 };
  }
  const contract = getAddress(contractAddress);
  if (!Number.isSafeInteger(maxTokensPerOwner) || maxTokensPerOwner < 1
    || maxTokensPerOwner > absoluteMaxTokensPerOwner) {
    issues.push(invalidIssue(`每个钱包扫描上限必须是 1-${absoluteMaxTokensPerOwner} 的整数`));
    return {
      contract,
      contractLimit: 0,
      issues,
      ownerLimit: 0,
      owners: [] as Address[],
      rpcBudget: 0
    };
  }
  if (!Number.isSafeInteger(maxTokensPerContract) || maxTokensPerContract < 1
    || maxTokensPerContract > absoluteMaxTokensPerContract) {
    issues.push(invalidIssue(`单合约扫描上限必须是 1-${absoluteMaxTokensPerContract} 的整数`));
    return {
      contract,
      contractLimit: 0,
      issues,
      ownerLimit: 0,
      owners: [] as Address[],
      rpcBudget: 0
    };
  }
  if (Number.isSafeInteger(maxRpcRequests) && maxRpcRequests < minimumDiscoveryRequests) {
    issues.push(limitIssue(
      "rpc-budget-exceeded",
      contract,
      "完成快照与 ERC165 接口检查至少需要 " + minimumDiscoveryRequests + " 次 RPC 请求"
    ));
    return {
      contract,
      contractLimit: 0,
      issues,
      ownerLimit: 0,
      owners: [] as Address[],
      rpcBudget: 0
    };
  }
  if (!Number.isSafeInteger(maxRpcRequests)) {
    issues.push(invalidIssue(
      `RPC 请求预算必须是 ${minimumDiscoveryRequests}-${MAX_ERC721_DISCOVERY_RPC_REQUESTS} 的整数`
    ));
    return {
      contract,
      contractLimit: 0,
      issues,
      ownerLimit: 0,
      owners: [] as Address[],
      rpcBudget: 0
    };
  }
  if (maxRpcRequests > MAX_ERC721_DISCOVERY_RPC_REQUESTS) {
    issues.push(limitIssue(
      "rpc-budget-exceeded",
      contract,
      `RPC 请求预算不能超过 ${MAX_ERC721_DISCOVERY_RPC_REQUESTS} 次安全上限`
    ));
    return {
      contract,
      contractLimit: 0,
      issues,
      ownerLimit: 0,
      owners: [] as Address[],
      rpcBudget: 0
    };
  }
  // Check the raw list before normalization so repeated or invalid entries
  // cannot turn an attacker-controlled unbounded loop into a small unique set.
  if (ownerAddresses.length > MAX_ERC721_DISCOVERY_OWNERS) {
    issues.push(limitIssue(
      "owner-limit-exceeded",
      contract,
      `自动发现一次最多处理 ${MAX_ERC721_DISCOVERY_OWNERS} 个来源钱包，请拆分任务`
    ));
    return {
      contract,
      contractLimit: 0,
      issues,
      ownerLimit: 0,
      owners: [] as Address[],
      rpcBudget: 0
    };
  }

  const owners: Address[] = [];
  const seen = new Set<string>();
  let hasInvalidOwner = false;
  for (const owner of ownerAddresses) {
    if (!isAddress(owner)) {
      hasInvalidOwner = true;
      issues.push(invalidIssue("来源钱包地址格式不正确"));
      continue;
    }
    const address = getAddress(owner);
    if (address.toLowerCase() === zeroAddress) {
      hasInvalidOwner = true;
      issues.push(invalidIssue("来源钱包不能是零地址"));
      continue;
    }
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    owners.push(address);
  }
  if (hasInvalidOwner) {
    return {
      contract,
      contractLimit: 0,
      issues,
      ownerLimit: 0,
      owners: [] as Address[],
      rpcBudget: 0
    };
  }
  if (owners.length === 0) issues.push(invalidIssue("至少需要一个有效的来源钱包地址"));
  if (owners.length > 0 && minimumDiscoveryRequests + owners.length > maxRpcRequests) {
    issues.push(limitIssue(
      "rpc-budget-exceeded",
      contract,
      `仅完成快照、接口检查与来源余额读取至少需要 ${minimumDiscoveryRequests + owners.length} 次 RPC 请求，超过本次 ${maxRpcRequests} 次预算`
    ));
    return {
      contract,
      contractLimit: 0,
      issues,
      ownerLimit: 0,
      owners: [] as Address[],
      rpcBudget: 0
    };
  }
  return {
    contract,
    contractLimit: maxTokensPerContract,
    issues,
    ownerLimit: maxTokensPerOwner,
    owners,
    rpcBudget: maxRpcRequests
  };
}

/**
 * Discovers token ids only when the contract implements ERC721Enumerable.
 * ERC721 does not provide a universal owner-token listing API, so this function
 * intentionally makes no attempt to discover non-enumerable collections.
 */
export async function discoverEnumerableErc721Assets(
  parameters: DiscoverEnumerableErc721AssetsParameters
): Promise<Erc721DiscoveryResult> {
  const { contract, contractLimit, issues, ownerLimit, owners, rpcBudget } = normalizeInputs(parameters);
  const result: Erc721DiscoveryResult = {
    assets: [],
    issues,
    owners: [],
    rpcRequests: 0,
    snapshotBlock: null
  };
  if (!contract || contractLimit === 0 || ownerLimit === 0 || owners.length === 0 || rpcBudget === 0) {
    return result;
  }

  let snapshotBlock: bigint;
  try {
    result.rpcRequests += 1;
    snapshotBlock = await parameters.publicClient.getBlockNumber();
    result.snapshotBlock = snapshotBlock;
  } catch (error) {
    result.issues.push({
      code: "interface-check-failed",
      contractAddress: contract,
      message: getErrorMessage(error, "无法固定 NFT 扫描区块；请检查 RPC 后重试"),
      ownerAddress: null
    });
    result.owners = owners.map((ownerAddress) => ({
      balance: null,
      discovered: 0,
      ownerAddress,
      scanned: 0,
      status: "unsupported"
    }));
    return result;
  }

  const unmeteredReadContract = parameters.readContract
    || parameters.publicClient.readContract.bind(parameters.publicClient) as Erc721DiscoveryReadContract;
  const readContract: Erc721DiscoveryReadContract = async (readParameters) => {
    if (result.rpcRequests >= rpcBudget) {
      throw new RpcBudgetExceededError();
    }
    result.rpcRequests += 1;
    return unmeteredReadContract({ ...readParameters, blockNumber: snapshotBlock });
  };
  const emit = (progress: Omit<Erc721DiscoveryProgress, "contractAddress">) => {
    emitProgress(parameters.onProgress, { contractAddress: contract, ...progress });
  };
  const commonProgress = {
    discovered: 0,
    ownerAddress: owners[0],
    ownerIndex: 0,
    ownerTotal: owners.length,
    scanned: 0,
    tokenIndex: null,
    tokenTotal: null
  } satisfies Omit<Erc721DiscoveryProgress, "contractAddress" | "stage">;
  emit({ ...commonProgress, stage: "checking-contract" });

  let supportsErc165: unknown;
  let rejectsInvalidInterface: unknown;
  let isErc721: unknown;
  let isEnumerable: unknown;
  try {
    [supportsErc165, rejectsInvalidInterface, isErc721, isEnumerable] = await Promise.all([
      readContract({
        abi: erc721DiscoveryAbi,
        address: contract,
        args: [erc165InterfaceId],
        functionName: "supportsInterface"
      }),
      readContract({
        abi: erc721DiscoveryAbi,
        address: contract,
        args: [invalidErc165InterfaceId],
        functionName: "supportsInterface"
      }),
      readContract({
        abi: erc721DiscoveryAbi,
        address: contract,
        args: [erc721InterfaceId],
        functionName: "supportsInterface"
      }),
      readContract({
        abi: erc721DiscoveryAbi,
        address: contract,
        args: [erc721EnumerableInterfaceId],
        functionName: "supportsInterface"
      })
    ]);
  } catch (error) {
    result.issues.push({
      code: error instanceof RpcBudgetExceededError ? "rpc-budget-exceeded" : "interface-check-failed",
      contractAddress: contract,
      message: error instanceof RpcBudgetExceededError
        ? `ERC165 接口检查超过本次 ${rpcBudget} 次 RPC 请求预算，已停止自动发现`
        : getErrorMessage(error, "无法确认合约支持 ERC721Enumerable；请手动填写 Token ID"),
      ownerAddress: null
    });
    result.owners = owners.map((ownerAddress) => ({
      balance: null,
      discovered: 0,
      ownerAddress,
      scanned: 0,
      status: error instanceof RpcBudgetExceededError ? "limit-exceeded" : "unsupported"
    }));
    return result;
  }

  if (typeof supportsErc165 !== "boolean" || typeof rejectsInvalidInterface !== "boolean"
    || typeof isErc721 !== "boolean" || typeof isEnumerable !== "boolean") {
    result.issues.push({
      code: "invalid-response",
      contractAddress: contract,
      message: "ERC165 接口检测返回格式不正确；请手动填写 Token ID",
      ownerAddress: null
    });
    result.owners = owners.map((ownerAddress) => ({
      balance: null,
      discovered: 0,
      ownerAddress,
      scanned: 0,
      status: "unsupported"
    }));
    return result;
  }
  if (!supportsErc165 || rejectsInvalidInterface !== false) {
    result.issues.push({
      code: "not-erc721",
      contractAddress: contract,
      message: "该合约未通过 ERC165 规范校验，已停止 Token ID 自动发现",
      ownerAddress: null
    });
    result.owners = owners.map((ownerAddress) => ({
      balance: null,
      discovered: 0,
      ownerAddress,
      scanned: 0,
      status: "unsupported"
    }));
    return result;
  }
  if (!isErc721 || !isEnumerable) {
    result.issues.push({
      code: isErc721 ? "not-enumerable" : "not-erc721",
      contractAddress: contract,
      message: isErc721
        ? "该合约未声明 ERC721Enumerable，无法可靠自动列出 Token ID；请改为手动填写"
        : "该合约未声明 ERC721 接口，已停止自动发现",
      ownerAddress: null
    });
    result.owners = owners.map((ownerAddress) => ({
      balance: null,
      discovered: 0,
      ownerAddress,
      scanned: 0,
      status: "unsupported"
    }));
    return result;
  }

  const seenTokens = new Set<string>();
  let contractScanned = 0;
  for (let ownerIndex = 0; ownerIndex < owners.length; ownerIndex += 1) {
    const ownerAddress = owners[ownerIndex];
    emit({
      discovered: result.assets.length,
      ownerAddress,
      ownerIndex,
      ownerTotal: owners.length,
      scanned: 0,
      stage: "reading-balance",
      tokenIndex: null,
      tokenTotal: null
    });

    let balance: bigint;
    try {
      const value = await readContract({
        abi: erc721DiscoveryAbi,
        address: contract,
        args: [ownerAddress],
        functionName: "balanceOf"
      });
      if (typeof value !== "bigint" || value < 0n) throw new Error("invalid balanceOf response");
      balance = value;
    } catch (error) {
      if (error instanceof RpcBudgetExceededError) {
        result.issues.push(limitIssue(
          "rpc-budget-exceeded",
          contract,
          `自动发现已达到本次 ${rpcBudget} 次 RPC 请求预算，剩余来源未扫描`,
          ownerAddress
        ));
        for (let pendingIndex = ownerIndex; pendingIndex < owners.length; pendingIndex += 1) {
          result.owners.push({
            balance: null,
            discovered: 0,
            ownerAddress: owners[pendingIndex],
            scanned: 0,
            status: "limit-exceeded"
          });
        }
        return result;
      }
      result.issues.push({
        code: "balance-read-failed",
        contractAddress: contract,
        message: getErrorMessage(error, "无法读取该钱包的 NFT 余额"),
        ownerAddress
      });
      result.owners.push({ balance: null, discovered: 0, ownerAddress, scanned: 0, status: "failed" });
      continue;
    }

    // Keep one balance request reserved for every later owner. An owner is
    // scanned atomically only when all of its declared token reads fit in the
    // remaining budget, preventing a misleading partial list at the cutoff.
    const reservedBalanceRequests = owners.length - ownerIndex - 1;
    const availableTokenRequests = rpcBudget - result.rpcRequests - reservedBalanceRequests;

    if (balance > BigInt(ownerLimit)) {
      result.issues.push({
        code: "balance-limit-exceeded",
        contractAddress: contract,
        message: `该钱包持有 ${balance} 个 NFT，超过单钱包 ${ownerLimit} 个的安全扫描上限；未执行部分扫描`,
        ownerAddress
      });
      result.owners.push({
        balance,
        discovered: 0,
        ownerAddress,
        scanned: 0,
        status: "limit-exceeded"
      });
      continue;
    }
    if (contractScanned + Number(balance) > contractLimit) {
      result.issues.push({
        code: "contract-limit-exceeded",
        contractAddress: contract,
        message: `扫描该钱包将超过单合约 ${contractLimit} 个 Token ID 的安全上限；未执行部分扫描`,
        ownerAddress
      });
      result.owners.push({
        balance,
        discovered: 0,
        ownerAddress,
        scanned: 0,
        status: "limit-exceeded"
      });
      continue;
    }
    if (Number(balance) > availableTokenRequests) {
      result.issues.push(limitIssue(
        "rpc-budget-exceeded",
        contract,
        `扫描该钱包的 ${balance} 个 Token ID 将超过本次 ${rpcBudget} 次 RPC 请求预算；未执行部分扫描`,
        ownerAddress
      ));
      result.owners.push({
        balance,
        discovered: 0,
        ownerAddress,
        scanned: 0,
        status: "limit-exceeded"
      });
      continue;
    }

    let ownerDiscovered = 0;
    let scanned = 0;
    let failed = false;
    for (let tokenIndex = 0n; tokenIndex < balance; tokenIndex += 1n) {
      emit({
        discovered: result.assets.length,
        ownerAddress,
        ownerIndex,
        ownerTotal: owners.length,
        scanned,
        stage: "reading-token",
        tokenIndex,
        tokenTotal: balance
      });
      let tokenId: unknown;
      try {
        contractScanned += 1;
        tokenId = await readContract({
          abi: erc721DiscoveryAbi,
          address: contract,
          args: [ownerAddress, tokenIndex],
          functionName: "tokenOfOwnerByIndex"
        });
      } catch (error) {
        if (error instanceof RpcBudgetExceededError) {
          result.issues.push(limitIssue(
            "rpc-budget-exceeded",
            contract,
            `自动发现已达到本次 ${rpcBudget} 次 RPC 请求预算，已停止 Token ID 扫描`,
            ownerAddress
          ));
          result.owners.push({
            balance,
            discovered: ownerDiscovered,
            ownerAddress,
            scanned,
            status: "limit-exceeded"
          });
          for (let pendingIndex = ownerIndex + 1; pendingIndex < owners.length; pendingIndex += 1) {
            result.owners.push({
              balance: null,
              discovered: 0,
              ownerAddress: owners[pendingIndex],
              scanned: 0,
              status: "limit-exceeded"
            });
          }
          return result;
        }
        result.issues.push({
          code: "token-read-failed",
          contractAddress: contract,
          message: getErrorMessage(error, "读取 Token ID 失败；该钱包的自动发现结果不完整"),
          ownerAddress,
          tokenIndex
        });
        failed = true;
        break;
      }
      scanned += 1;
      if (typeof tokenId !== "bigint" || tokenId < 0n) {
        result.issues.push({
          code: "invalid-response",
          contractAddress: contract,
          message: "tokenOfOwnerByIndex 返回格式不正确；该钱包的自动发现结果不完整",
          ownerAddress,
          tokenIndex
        });
        failed = true;
        break;
      }

      const key = `erc721:${contract.toLowerCase()}:${tokenId}`;
      if (seenTokens.has(key)) {
        result.issues.push({
          code: "duplicate-token",
          contractAddress: contract,
          message: "合约返回了重复 Token ID，已跳过重复项",
          ownerAddress,
          tokenIndex
        });
        continue;
      }
      seenTokens.add(key);
      result.assets.push({
        contractAddress: contract,
        key,
        ownerAddress,
        standard: "erc721",
        tokenId
      });
      ownerDiscovered += 1;
    }

    result.owners.push({
      balance,
      discovered: ownerDiscovered,
      ownerAddress,
      scanned,
      status: failed ? "failed" : "complete"
    });
    emit({
      discovered: result.assets.length,
      ownerAddress,
      ownerIndex,
      ownerTotal: owners.length,
      scanned,
      stage: "owner-complete",
      tokenIndex: null,
      tokenTotal: balance
    });
  }

  return result;
}
