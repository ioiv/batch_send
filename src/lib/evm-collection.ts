import {
  encodeFunctionData,
  getAddress,
  isAddress,
  parseAbi,
  zeroAddress,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
  type WalletClient
} from "viem";
import {
  privateKeyToAccount,
  type PrivateKeyAccount
} from "viem/accounts";
import {
  maximumCollectionSources,
  maximumEvmCollectionAssets
} from "./collection-workload";

export type EvmCollectionStandard = "erc20" | "erc721" | "erc1155";

export type EvmCollectionAccount = {
  account: PrivateKeyAccount;
  address: Address;
  label: string;
  line: number;
};

export type EvmPrivateKeyInputIssue = {
  code: "duplicate-account" | "input-limit" | "invalid-format" | "invalid-private-key";
  line: number;
  message: string;
};

export type EvmPrivateKeyInputRow = {
  address: Address | null;
  label: string;
  line: number;
  message: string;
  status: "valid" | "invalid" | "duplicate";
};

export type ParseEvmPrivateKeyInputResult = {
  accounts: EvmCollectionAccount[];
  duplicates: number;
  invalid: number;
  issues: EvmPrivateKeyInputIssue[];
  rows: EvmPrivateKeyInputRow[];
};

export type EvmAccountDeriver = (privateKey: Hex) => PrivateKeyAccount;

export type EvmCollectionAsset =
  | {
      contractAddress: Address;
      key: string;
      standard: "erc20";
    }
  | {
      contractAddress: Address;
      key: string;
      standard: "erc721";
      tokenId: bigint;
    }
  | {
      contractAddress: Address;
      key: string;
      standard: "erc1155";
      tokenId: bigint;
    };

export type EvmCollectionAssetRow = {
  asset: EvmCollectionAsset | null;
  line: number;
  problems: string[];
  status: "valid" | "invalid" | "duplicate";
};

export type ParseEvmCollectionAssetsResult = {
  assets: EvmCollectionAsset[];
  duplicates: number;
  invalid: number;
  rows: EvmCollectionAssetRow[];
  validAssets: EvmCollectionAsset[];
};

export type Erc20CollectionMetadata = {
  contractAddress: Address;
  decimals: number;
  name: string;
  symbol: string;
};

export type EvmCollectionPlanStatus = "ready" | "skipped" | "failed";

export type EvmCollectionPlanItem = {
  /** The signing account is retained in memory and must not be logged or persisted. */
  account: PrivateKeyAccount | null;
  address: Address | null;
  amount: bigint;
  asset: EvmCollectionAsset;
  id: string;
  label: string;
  message: string;
  metadata?: Erc20CollectionMetadata;
  status: EvmCollectionPlanStatus;
};

export type EvmCollectionResultStatus = "success" | "skipped" | "failed";

export type EvmCollectionResult = {
  address: Address | null;
  amount: bigint;
  asset: EvmCollectionAsset;
  hash: Hash | null;
  id: string;
  label: string;
  message: string;
  status: EvmCollectionResultStatus;
};

export type EvmCollectionProgressStage =
  | "skipped"
  | "simulating"
  | "estimating"
  | "submitting"
  | "confirming"
  | "success"
  | "failed";

export type EvmCollectionProgress = {
  address: Address | null;
  amount: bigint;
  completed: number;
  hash: Hash | null;
  id: string;
  index: number;
  label: string;
  message: string;
  stage: EvmCollectionProgressStage;
  total: number;
};

export type EvmCollectionErrorCode =
  | "invalid-input"
  | "invalid-private-key"
  | "read-failed"
  | "simulation-failed"
  | "fee-check-failed"
  | "submission-failed"
  | "confirmation-failed"
  | "unknown";

export type EvmCollectionErrorInfo = {
  code: EvmCollectionErrorCode;
  message: string;
};

export type EvmCollectionPublicClient = Pick<
  PublicClient,
  | "estimateGas"
  | "getBalance"
  | "getGasPrice"
  | "readContract"
  | "simulateContract"
  | "waitForTransactionReceipt"
>;
export type EvmCollectionWalletClient = Pick<WalletClient, "writeContract">;

export const erc20CollectionAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)"
]);

export const erc721CollectionAbi = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function safeTransferFrom(address from, address to, uint256 tokenId)"
]);

export const erc1155CollectionAbi = parseAbi([
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes data)"
]);

const privateKeyPattern = /^0x[0-9a-fA-F]{64}$/;
const embeddedPrefixedSecretPattern = /0x[0-9a-fA-F]{64}/gi;
const embeddedBareSecretPattern = /\b[0-9a-fA-F]{64}\b/g;
const tokenIdPattern = /^\d+$/;

export const maximumEvmCollectionInputCharacters = 512 * 1024;
export const maximumEvmCollectionInputLines = 5_000;
export const maximumEvmCollectionInputIssues = 100;
export const maximumEvmPrivateKeyInputEntries = maximumCollectionSources;
export const maximumEvmCollectionAssetInputEntries = maximumEvmCollectionAssets;
export const maximumEvmTokenIdDigits = 78;
export const maximumEvmTokenId = (1n << 256n) - 1n;

type BoundedInputIssue = {
  line: number;
  message: string;
};

function inspectBoundedInput(input: string, maximumEntries: number, entryLabel: string): BoundedInputIssue | null {
  if (input.length > maximumEvmCollectionInputCharacters) {
    return {
      line: 1,
      message: `输入内容过长，单次最多 ${maximumEvmCollectionInputCharacters.toLocaleString("en-US")} 个字符`
    };
  }

  let currentLine = 1;
  let entries = 0;
  let lineHasContent = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === "\n") {
      if (lineHasContent) {
        entries += 1;
        if (entries > maximumEntries) {
          return {
            line: currentLine,
            message: `${entryLabel}过多，单次最多 ${maximumEntries.toLocaleString("en-US")} 条`
          };
        }
      }
      currentLine += 1;
      if (currentLine > maximumEvmCollectionInputLines) {
        return {
          line: currentLine,
          message: `输入行数过多，单次最多 ${maximumEvmCollectionInputLines.toLocaleString("en-US")} 行`
        };
      }
      lineHasContent = false;
      continue;
    }
    if (!/\s/u.test(character)) lineHasContent = true;
  }

  if (lineHasContent && entries + 1 > maximumEntries) {
    return {
      line: currentLine,
      message: `${entryLabel}过多，单次最多 ${maximumEntries.toLocaleString("en-US")} 条`
    };
  }
  return null;
}

function redactSecrets(value: string) {
  return value
    .replace(embeddedPrefixedSecretPattern, "[已隐藏敏感内容]")
    .replace(embeddedBareSecretPattern, "[已隐藏敏感内容]")
    .replace(/https?:\/\/\S+/gi, "[RPC 地址已隐藏]");
}

function safeLabel(value: string, fallback: string) {
  const redacted = redactSecrets(value).trim();
  return redacted.slice(0, 120) || fallback;
}

function getErrorText(error: unknown) {
  if (typeof error === "string") return error;
  if (!error || typeof error !== "object") return "";

  const candidate = error as { details?: unknown; message?: unknown; shortMessage?: unknown };
  if (typeof candidate.shortMessage === "string") return candidate.shortMessage;
  if (typeof candidate.message === "string") return candidate.message;
  if (typeof candidate.details === "string") return candidate.details;
  return "";
}

export class EvmCollectionCoreError extends Error {
  readonly code: EvmCollectionErrorCode;

  constructor(code: EvmCollectionErrorCode, message: string) {
    super(redactSecrets(message));
    this.code = code;
    this.name = "EvmCollectionCoreError";
  }
}

export function normalizeEvmCollectionError(
  error: unknown,
  fallback = "操作失败",
  code: EvmCollectionErrorCode = "unknown"
): EvmCollectionErrorInfo {
  const knownCode = error instanceof EvmCollectionCoreError ? error.code : code;
  const normalized = redactSecrets(getErrorText(error)).replace(/\s+/g, " ").trim();
  return {
    code: knownCode,
    message: (normalized || redactSecrets(fallback)).slice(0, 500)
  };
}

function deriveAccountSafely(privateKey: string, deriveAccount: EvmAccountDeriver) {
  if (!privateKeyPattern.test(privateKey)) {
    throw new EvmCollectionCoreError("invalid-private-key", "私钥格式不正确");
  }

  try {
    return deriveAccount(privateKey as Hex);
  } catch {
    // Deliberately discard the upstream error because it may include the key.
    throw new EvmCollectionCoreError("invalid-private-key", "无法从该私钥派生地址");
  }
}

export function deriveEvmCollectionAddress(
  privateKey: string,
  deriveAccount: EvmAccountDeriver = privateKeyToAccount
) {
  try {
    return getAddress(deriveAccountSafely(privateKey.trim(), deriveAccount).address);
  } catch {
    throw new EvmCollectionCoreError("invalid-private-key", "无法从该私钥派生地址");
  }
}

export function parseEvmPrivateKeyInput(
  input: string,
  options: { deriveAccount?: EvmAccountDeriver } = {}
): ParseEvmPrivateKeyInputResult {
  const deriveAccount = options.deriveAccount || privateKeyToAccount;
  const accounts: EvmCollectionAccount[] = [];
  const issues: EvmPrivateKeyInputIssue[] = [];
  const rows: EvmPrivateKeyInputRow[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  let invalid = 0;

  const limitIssue = inspectBoundedInput(input, maximumEvmPrivateKeyInputEntries, "来源钱包条目");
  if (limitIssue) {
    return {
      accounts,
      duplicates,
      invalid: 1,
      issues: [{ code: "input-limit", ...limitIssue }],
      rows: [{
        address: null,
        label: "输入限制",
        line: limitIssue.line,
        message: limitIssue.message,
        status: "invalid"
      }]
    };
  }

  const pushIssue = (
    issue: EvmPrivateKeyInputIssue,
    row: EvmPrivateKeyInputRow
  ) => {
    if (issues.length >= maximumEvmCollectionInputIssues) return;
    issues.push(issue);
    rows.push(row);
  };

  for (const [index, untrimmedLine] of input.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const line = untrimmedLine.trim();
    if (!line) continue;

    const firstComma = line.indexOf(",");
    const secondComma = firstComma < 0 ? -1 : line.indexOf(",", firstComma + 1);
    const hasLabel = firstComma >= 0 && secondComma < 0;
    const rawLabel = hasLabel ? line.slice(0, firstComma).trim() : "";
    const label = safeLabel(rawLabel, `钱包 ${lineNumber}`);
    if (secondComma >= 0 || (hasLabel && !rawLabel)) {
      const message = "格式应为 0x私钥 或 标签,0x私钥";
      invalid += 1;
      pushIssue(
        { code: "invalid-format", line: lineNumber, message },
        { address: null, label, line: lineNumber, message, status: "invalid" }
      );
      continue;
    }

    const privateKey = hasLabel ? line.slice(firstComma + 1).trim() : line;
    let account: PrivateKeyAccount;
    let address: Address;
    try {
      account = deriveAccountSafely(privateKey, deriveAccount);
      address = getAddress(account.address);
    } catch {
      const message = "私钥无效或无法派生地址";
      invalid += 1;
      pushIssue(
        { code: "invalid-private-key", line: lineNumber, message },
        { address: null, label, line: lineNumber, message, status: "invalid" }
      );
      continue;
    }

    const duplicateKey = address.toLowerCase();
    if (seen.has(duplicateKey)) {
      const message = "该来源地址已导入，已跳过重复项";
      duplicates += 1;
      pushIssue(
        { code: "duplicate-account", line: lineNumber, message },
        { address, label, line: lineNumber, message, status: "duplicate" }
      );
      continue;
    }
    seen.add(duplicateKey);

    accounts.push({ account, address, label, line: lineNumber });
    rows.push({ address, label, line: lineNumber, message: "地址派生成功", status: "valid" });
  }

  return { accounts, duplicates, invalid, issues, rows };
}

function parseContractAddress(value: string) {
  if (!isAddress(value)) return null;
  try {
    return getAddress(value);
  } catch {
    return null;
  }
}

function parseAssetLine(line: string, standard: EvmCollectionStandard) {
  const problems: string[] = [];
  const firstComma = line.indexOf(",");
  const secondComma = firstComma < 0 ? -1 : line.indexOf(",", firstComma + 1);
  const hasExpectedParts = standard === "erc20" ? firstComma < 0 : firstComma >= 0 && secondComma < 0;
  if (!hasExpectedParts) {
    problems.push(standard === "erc20"
      ? "ERC20 每行只填写一个合约地址"
      : "NFT 每行格式应为 合约地址,Token ID");
    return { asset: null, problems };
  }

  const contractText = (firstComma < 0 ? line : line.slice(0, firstComma)).trim();
  const contractAddress = parseContractAddress(contractText);
  if (!contractAddress) problems.push("合约地址格式不正确");

  if (standard === "erc20") {
    return {
      asset: contractAddress
        ? {
            contractAddress,
            key: `erc20:${contractAddress.toLowerCase()}`,
            standard: "erc20" as const
          }
        : null,
      problems
    };
  }

  const tokenIdText = line.slice(firstComma + 1).trim();
  if (!tokenIdPattern.test(tokenIdText)) problems.push("Token ID 必须是非负十进制整数");
  else if (tokenIdText.length > maximumEvmTokenIdDigits) problems.push("Token ID 超出 uint256 范围");
  if (!contractAddress || problems.length > 0) return { asset: null, problems };

  const tokenId = BigInt(tokenIdText);
  if (tokenId > maximumEvmTokenId) {
    return { asset: null, problems: ["Token ID 超出 uint256 范围"] };
  }
  return {
    asset: {
      contractAddress,
      key: `${standard}:${contractAddress.toLowerCase()}:${tokenId}`,
      standard,
      tokenId
    } satisfies EvmCollectionAsset,
    problems
  };
}

export function parseEvmCollectionAssets(
  input: string,
  standard: EvmCollectionStandard
): ParseEvmCollectionAssetsResult {
  const assets: EvmCollectionAsset[] = [];
  const rows: EvmCollectionAssetRow[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  let invalid = 0;

  const limitIssue = inspectBoundedInput(input, maximumEvmCollectionAssetInputEntries, "资产条目");
  if (limitIssue) {
    return {
      assets,
      duplicates,
      invalid: 1,
      rows: [{ asset: null, line: limitIssue.line, problems: [limitIssue.message], status: "invalid" }],
      validAssets: assets
    };
  }

  let issueRows = 0;
  const pushIssueRow = (row: EvmCollectionAssetRow) => {
    if (issueRows >= maximumEvmCollectionInputIssues) return;
    issueRows += 1;
    rows.push(row);
  };

  for (const [index, untrimmedLine] of input.split(/\r?\n/).entries()) {
    const line = untrimmedLine.trim();
    if (!line) continue;

    const { asset, problems } = parseAssetLine(line, standard);
    if (!asset) {
      invalid += 1;
      pushIssueRow({ asset: null, line: index + 1, problems, status: "invalid" });
      continue;
    }
    if (seen.has(asset.key)) {
      duplicates += 1;
      pushIssueRow({
        asset,
        line: index + 1,
        problems: ["资产条目重复，已跳过"],
        status: "duplicate"
      });
      continue;
    }

    seen.add(asset.key);
    assets.push(asset);
    rows.push({ asset, line: index + 1, problems: [], status: "valid" });
  }

  return { assets, duplicates, invalid, rows, validAssets: assets };
}

function assertBigIntResult(value: unknown, label: string) {
  if (typeof value !== "bigint" || value < 0n) {
    throw new EvmCollectionCoreError("read-failed", `${label} 返回格式不正确`);
  }
  return value;
}

export async function readErc20Metadata(
  publicClient: EvmCollectionPublicClient,
  contractAddress: Address
): Promise<Erc20CollectionMetadata> {
  const [name, symbol, decimals] = await Promise.all([
    publicClient.readContract({
      abi: erc20CollectionAbi,
      address: contractAddress,
      functionName: "name"
    }).catch(() => "ERC20 Token"),
    publicClient.readContract({
      abi: erc20CollectionAbi,
      address: contractAddress,
      functionName: "symbol"
    }).catch(() => "TOKEN"),
    publicClient.readContract({
      abi: erc20CollectionAbi,
      address: contractAddress,
      functionName: "decimals"
    })
  ]);

  if (typeof decimals !== "number" || !Number.isInteger(decimals)
    || decimals < 0 || decimals > 255) {
    throw new EvmCollectionCoreError("read-failed", "ERC20 元数据返回格式不正确");
  }

  return {
    contractAddress,
    decimals,
    name: typeof name === "string" && name.trim() ? name : "ERC20 Token",
    symbol: typeof symbol === "string" && symbol.trim() ? symbol : "TOKEN"
  };
}

function createPlanItem(args: Omit<EvmCollectionPlanItem, "id" | "label"> & {
  idSuffix?: string;
  label: string;
}) {
  const { idSuffix, ...item } = args;
  const addressKey = item.address?.toLowerCase() || idSuffix || "asset";
  return {
    ...item,
    id: `${item.asset.key}:${addressKey}`,
    label: safeLabel(item.label, "来源钱包")
  } satisfies EvmCollectionPlanItem;
}

async function planErc20Asset(
  asset: Extract<EvmCollectionAsset, { standard: "erc20" }>,
  accounts: readonly EvmCollectionAccount[],
  publicClient: EvmCollectionPublicClient
) {
  let metadata: Erc20CollectionMetadata;
  try {
    metadata = await readErc20Metadata(publicClient, asset.contractAddress);
  } catch (error) {
    const detail = normalizeEvmCollectionError(error, "无法读取 ERC20 元数据", "read-failed");
    return accounts.map((source) => createPlanItem({
      account: source.account,
      address: source.address,
      amount: 0n,
      asset,
      label: source.label,
      message: `读取 ERC20 元数据失败：${detail.message}`,
      status: "failed"
    }));
  }

  return Promise.all(accounts.map(async (source) => {
    try {
      const balance = assertBigIntResult(await publicClient.readContract({
        abi: erc20CollectionAbi,
        address: asset.contractAddress,
        args: [source.address],
        functionName: "balanceOf"
      }), "ERC20 balanceOf");
      return createPlanItem({
        account: source.account,
        address: source.address,
        amount: balance,
        asset,
        label: source.label,
        message: balance === 0n ? "代币余额为 0，已跳过" : "已检测到可归集代币余额",
        metadata,
        status: balance === 0n ? "skipped" : "ready"
      });
    } catch (error) {
      const detail = normalizeEvmCollectionError(error, "无法读取代币余额", "read-failed");
      return createPlanItem({
        account: source.account,
        address: source.address,
        amount: 0n,
        asset,
        label: source.label,
        message: `读取代币余额失败：${detail.message}`,
        metadata,
        status: "failed"
      });
    }
  }));
}

async function planErc721Asset(
  asset: Extract<EvmCollectionAsset, { standard: "erc721" }>,
  accounts: readonly EvmCollectionAccount[],
  publicClient: EvmCollectionPublicClient
) {
  try {
    const owner = await publicClient.readContract({
      abi: erc721CollectionAbi,
      address: asset.contractAddress,
      args: [asset.tokenId],
      functionName: "ownerOf"
    });
    if (typeof owner !== "string" || !isAddress(owner)) {
      throw new EvmCollectionCoreError("read-failed", "ERC721 ownerOf 返回格式不正确");
    }
    const ownerAddress = getAddress(owner);
    const source = accounts.find((candidate) => candidate.address.toLowerCase() === ownerAddress.toLowerCase());
    if (!source) {
      return [createPlanItem({
        account: null,
        address: ownerAddress,
        amount: 1n,
        asset,
        idSuffix: "external-owner",
        label: "未导入的钱包",
        message: "NFT 所有者不在已导入的来源钱包中，已跳过",
        status: "skipped"
      })];
    }

    return [createPlanItem({
      account: source.account,
      address: source.address,
      amount: 1n,
      asset,
      label: source.label,
      message: "已确认 NFT 所有权",
      status: "ready"
    })];
  } catch (error) {
    const detail = normalizeEvmCollectionError(error, "无法读取 NFT 所有者", "read-failed");
    return [createPlanItem({
      account: null,
      address: null,
      amount: 0n,
      asset,
      idSuffix: "owner-read-failed",
      label: "资产检查",
      message: `读取 NFT 所有者失败：${detail.message}`,
      status: "failed"
    })];
  }
}

async function planErc1155Asset(
  asset: Extract<EvmCollectionAsset, { standard: "erc1155" }>,
  accounts: readonly EvmCollectionAccount[],
  publicClient: EvmCollectionPublicClient
) {
  return Promise.all(accounts.map(async (source) => {
    try {
      const balance = assertBigIntResult(await publicClient.readContract({
        abi: erc1155CollectionAbi,
        address: asset.contractAddress,
        args: [source.address, asset.tokenId],
        functionName: "balanceOf"
      }), "ERC1155 balanceOf");
      return createPlanItem({
        account: source.account,
        address: source.address,
        amount: balance,
        asset,
        label: source.label,
        message: balance === 0n ? "该 NFT 余额为 0，已跳过" : "已检测到可归集 NFT 余额",
        status: balance === 0n ? "skipped" : "ready"
      });
    } catch (error) {
      const detail = normalizeEvmCollectionError(error, "无法读取 NFT 余额", "read-failed");
      return createPlanItem({
        account: source.account,
        address: source.address,
        amount: 0n,
        asset,
        label: source.label,
        message: `读取 NFT 余额失败：${detail.message}`,
        status: "failed"
      });
    }
  }));
}

export async function planEvmCollection({
  accounts,
  assets,
  publicClient
}: {
  accounts: readonly EvmCollectionAccount[];
  assets: readonly EvmCollectionAsset[];
  publicClient: EvmCollectionPublicClient;
}): Promise<EvmCollectionPlanItem[]> {
  const plan: EvmCollectionPlanItem[] = [];
  for (const asset of assets) {
    if (asset.standard === "erc20") {
      plan.push(...await planErc20Asset(asset, accounts, publicClient));
    } else if (asset.standard === "erc721") {
      plan.push(...await planErc721Asset(asset, accounts, publicClient));
    } else {
      plan.push(...await planErc1155Asset(asset, accounts, publicClient));
    }
  }
  return plan;
}

function resultFromPlanItem(
  item: EvmCollectionPlanItem,
  status: EvmCollectionResultStatus,
  message: string,
  hash: Hash | null = null
): EvmCollectionResult {
  return {
    address: item.address,
    amount: item.amount,
    asset: item.asset,
    hash,
    id: redactSecrets(item.id),
    label: safeLabel(item.label, "来源钱包"),
    message: redactSecrets(message),
    status
  };
}

function emitProgress(
  onProgress: ((progress: EvmCollectionProgress) => void) | undefined,
  item: EvmCollectionPlanItem,
  stage: EvmCollectionProgressStage,
  index: number,
  total: number,
  message: string,
  hash: Hash | null = null
) {
  try {
    onProgress?.({
      address: item.address,
      amount: item.amount,
      completed: stage === "success" || stage === "failed" || stage === "skipped" ? index + 1 : index,
      hash,
      id: redactSecrets(item.id),
      index,
      label: safeLabel(item.label, "来源钱包"),
      message: redactSecrets(message),
      stage,
      total
    });
  } catch {
    // UI progress handlers must never interrupt signing or confirmation.
  }
}

async function simulateCollectionTransfer(
  publicClient: EvmCollectionPublicClient,
  item: EvmCollectionPlanItem,
  targetAddress: Address
): Promise<{ request: unknown }> {
  if (!item.account || !item.address) {
    throw new EvmCollectionCoreError("invalid-input", "归集计划缺少签名账户");
  }

  if (item.asset.standard === "erc20") {
    const { request, result } = await publicClient.simulateContract({
      abi: erc20CollectionAbi,
      account: item.account,
      address: item.asset.contractAddress,
      args: [targetAddress, item.amount],
      functionName: "transfer"
    });
    if (result !== true) {
      throw new EvmCollectionCoreError("simulation-failed", "ERC20 transfer 模拟返回 false，已阻止提交");
    }
    return { request };
  }
  if (item.asset.standard === "erc721") {
    const { request } = await publicClient.simulateContract({
      abi: erc721CollectionAbi,
      account: item.account,
      address: item.asset.contractAddress,
      args: [item.address, targetAddress, item.asset.tokenId],
      functionName: "safeTransferFrom"
    });
    return { request };
  }
  const { request } = await publicClient.simulateContract({
    abi: erc1155CollectionAbi,
    account: item.account,
    address: item.asset.contractAddress,
    args: [item.address, targetAddress, item.asset.tokenId, item.amount, "0x"],
    functionName: "safeTransferFrom"
  });
  return { request };
}

function encodeCollectionTransferData(item: EvmCollectionPlanItem, targetAddress: Address) {
  if (!item.address) throw new EvmCollectionCoreError("invalid-input", "归集计划缺少来源地址");
  if (item.asset.standard === "erc20") {
    return encodeFunctionData({
      abi: erc20CollectionAbi,
      args: [targetAddress, item.amount],
      functionName: "transfer"
    });
  }
  if (item.asset.standard === "erc721") {
    return encodeFunctionData({
      abi: erc721CollectionAbi,
      args: [item.address, targetAddress, item.asset.tokenId],
      functionName: "safeTransferFrom"
    });
  }
  return encodeFunctionData({
    abi: erc1155CollectionAbi,
    args: [item.address, targetAddress, item.asset.tokenId, item.amount, "0x"],
    functionName: "safeTransferFrom"
  });
}

export async function executeEvmCollectionPlan({
  getWalletClient,
  maxFeePerTransactionWei,
  onProgress,
  plan,
  publicClient,
  targetAddress
}: {
  getWalletClient: (
    account: PrivateKeyAccount,
    item: EvmCollectionPlanItem
  ) => EvmCollectionWalletClient | Promise<EvmCollectionWalletClient>;
  maxFeePerTransactionWei: bigint;
  onProgress?: (progress: EvmCollectionProgress) => void;
  plan: readonly EvmCollectionPlanItem[];
  publicClient: EvmCollectionPublicClient;
  targetAddress: string;
}): Promise<EvmCollectionResult[]> {
  if (!isAddress(targetAddress)) {
    throw new EvmCollectionCoreError("invalid-input", "目标归集地址格式不正确");
  }
  const target = getAddress(targetAddress);
  if (target === zeroAddress) {
    throw new EvmCollectionCoreError("invalid-input", "目标归集地址不能是零地址");
  }
  if (maxFeePerTransactionWei <= 0n) {
    throw new EvmCollectionCoreError("invalid-input", "单笔最大网络费必须大于 0");
  }
  const results: EvmCollectionResult[] = [];
  const uncertainSources = new Set<string>();

  for (let index = 0; index < plan.length; index += 1) {
    const item = plan[index];
    if (item.status !== "ready") {
      const status = item.status === "skipped" ? "skipped" : "failed";
      emitProgress(onProgress, item, status, index, plan.length, item.message);
      results.push(resultFromPlanItem(item, status, item.message));
      continue;
    }
    if (!item.account || !item.address || item.amount <= 0n) {
      const message = "归集计划缺少可执行的账户或数量";
      emitProgress(onProgress, item, "failed", index, plan.length, message);
      results.push(resultFromPlanItem(item, "failed", message));
      continue;
    }
    const sourceKey = item.address.toLowerCase();
    if (uncertainSources.has(sourceKey)) {
      const message = "同一来源钱包此前存在未确认交易，已停止其后续归集项";
      emitProgress(onProgress, item, "failed", index, plan.length, message);
      results.push(resultFromPlanItem(item, "failed", message));
      continue;
    }
    if (getAddress(item.account.address) !== getAddress(item.address)) {
      const message = "签名账户与来源地址不匹配";
      emitProgress(onProgress, item, "failed", index, plan.length, message);
      results.push(resultFromPlanItem(item, "failed", message));
      continue;
    }
    if (item.address.toLowerCase() === target.toLowerCase()) {
      const message = "来源地址与目标地址相同，已跳过";
      emitProgress(onProgress, item, "skipped", index, plan.length, message);
      results.push(resultFromPlanItem(item, "skipped", message));
      continue;
    }

    let simulation: { request: unknown };
    try {
      emitProgress(onProgress, item, "simulating", index, plan.length, "正在模拟归集交易");
      simulation = await simulateCollectionTransfer(publicClient, item, target);
    } catch (error) {
      const detail = normalizeEvmCollectionError(error, "交易模拟失败", "simulation-failed");
      const message = `模拟失败：${detail.message}`;
      emitProgress(onProgress, item, "failed", index, plan.length, message);
      results.push(resultFromPlanItem(item, "failed", message));
      continue;
    }

    let preparedRequest: unknown;
    try {
      emitProgress(onProgress, item, "estimating", index, plan.length, "正在估算并限制网络费");
      const [estimatedGas, gasPrice, nativeBalance] = await Promise.all([
        publicClient.estimateGas({
          account: item.account,
          data: encodeCollectionTransferData(item, target),
          to: item.asset.contractAddress
        }),
        publicClient.getGasPrice(),
        publicClient.getBalance({ address: item.address })
      ]);
      const gasLimit = (estimatedGas * 120n + 99n) / 100n;
      const maximumNetworkFee = gasLimit * gasPrice;
      if (maximumNetworkFee > maxFeePerTransactionWei) {
        throw new EvmCollectionCoreError("fee-check-failed", "预计单笔网络费超过已确认上限，已阻止提交");
      }
      if (nativeBalance < maximumNetworkFee) {
        throw new EvmCollectionCoreError("fee-check-failed", "来源钱包原生币余额不足以支付最大网络费");
      }
      preparedRequest = {
        ...(simulation.request as Record<string, unknown>),
        gas: gasLimit,
        gasPrice
      };
    } catch (error) {
      const detail = normalizeEvmCollectionError(error, "网络费检查失败", "fee-check-failed");
      const message = `网络费检查失败：${detail.message}`;
      emitProgress(onProgress, item, "failed", index, plan.length, message);
      results.push(resultFromPlanItem(item, "failed", message));
      continue;
    }

    try {
      emitProgress(onProgress, item, "submitting", index, plan.length, "模拟通过，正在提交交易");
      const walletClient = await getWalletClient(item.account, item);
      // viem's request type is ABI-generic. The request is produced immediately
      // above by simulateContract and is deliberately kept opaque across this boundary.
      const hash = await walletClient.writeContract(preparedRequest as never);
      emitProgress(onProgress, item, "confirming", index, plan.length, "交易已提交，正在等待链上确认", hash);
      try {
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") {
          const message = "交易已上链，但执行状态为失败";
          emitProgress(onProgress, item, "failed", index, plan.length, message, hash);
          results.push(resultFromPlanItem(item, "failed", message, hash));
          continue;
        }
        const message = "归集交易已确认";
        emitProgress(onProgress, item, "success", index, plan.length, message, hash);
        results.push(resultFromPlanItem(item, "success", message, hash));
      } catch (error) {
        uncertainSources.add(sourceKey);
        const detail = normalizeEvmCollectionError(error, "等待链上确认失败", "confirmation-failed");
        const message = `交易已提交但确认失败：${detail.message}。请先查询链上状态，勿盲目重发`;
        emitProgress(onProgress, item, "failed", index, plan.length, message, hash);
        results.push(resultFromPlanItem(item, "failed", message, hash));
      }
    } catch (error) {
      uncertainSources.add(sourceKey);
      const detail = normalizeEvmCollectionError(error, "交易提交失败", "submission-failed");
      const message = `提交失败或状态不确定：${detail.message}。已停止该来源后续交易；重试前请检查链上记录`;
      emitProgress(onProgress, item, "failed", index, plan.length, message);
      results.push(resultFromPlanItem(item, "failed", message));
    }
  }

  return results;
}
