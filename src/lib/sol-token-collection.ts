import { Buffer } from "buffer";
import {
  ACCOUNT_SIZE,
  AccountState,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  calculateEpochFee,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  createTransferCheckedWithFeeInstruction,
  getAccountLen,
  getAccountTypeOfMintType,
  getAssociatedTokenAddressSync,
  getDefaultAccountState,
  getExtensionTypes,
  getMemoTransfer,
  getNonTransferable,
  getPausableConfig,
  getTransferFeeConfig,
  unpackAccount,
  unpackMint,
  type Account,
  type Mint
} from "@solana/spl-token";
import {
  PublicKey,
  Transaction,
  type Commitment,
  type Connection,
  type SendOptions,
  type TokenAccountsFilter,
  type TransactionSignature
} from "@solana/web3.js";
import {
  mapWithCollectionConcurrency,
  normalizeCollectionExecutionSettings,
  waitForCollectionDelay,
  type CollectionExecutionSettings,
  type CollectionPauseControl
} from "./collection-execution";
import { encodeBase58, type SolCollectionSource } from "./sol-collection";

globalThis.Buffer = globalThis.Buffer || Buffer;

export const defaultSolTokenCollectionFeeLamports = 5_000n;
export const maximumDiscoveredSolTokenAccounts = 5_000;
const mintAccountBatchSize = 100;
const tokenAccountQueryConcurrency = 10;

export type SolTokenProgram = "spl-token" | "token-2022";
export type SolanaHoldingsReadStatus = "error" | "ok" | "partial";
export type SolTokenHoldingStatus = "ready" | "unsupported" | "unverified";

export type SolTokenAssetHolding = {
  amount: bigint;
  decimals: number | null;
  formattedAmount: string | null;
  id: string;
  isAssociated: boolean;
  isFrozen: boolean;
  isNative: boolean;
  label?: string;
  line: number;
  mintAddress: string;
  mintExtensions: number[];
  program: SolTokenProgram;
  programId: string;
  sourceAddress: string;
  sourceTokenAccount: string;
  status: SolTokenHoldingStatus;
  unsupportedReason?: string;
};

export type SolanaWalletHoldings = {
  address: string;
  issues: string[];
  label?: string;
  line: number;
  nativeBalanceLamports: bigint | null;
  nativeBalanceStatus: "error" | "ok";
  status: SolanaHoldingsReadStatus;
  tokenInventoryStatus: "complete" | "partial";
  tokenAccounts: SolTokenAssetHolding[];
};

export type SolanaHoldingsResult = {
  holdings: SolTokenAssetHolding[];
  issues: string[];
  partial: boolean;
  readyTokenAccountCount: number;
  tokenInventoryComplete: boolean;
  tokenAccountCount: number;
  totalNativeBalanceLamports: bigint;
  wallets: SolanaWalletHoldings[];
};

export type DiscoverSolanaHoldingsOptions = {
  commitment?: Commitment;
  concurrency?: number;
  connection: SolanaHoldingsConnection;
  maximumTokenAccounts?: number;
  mintAddresses?: readonly (PublicKey | string)[];
  sources: readonly SolCollectionSource[];
};

export type SolTokenMintInspection = {
  decimals: number | null;
  extensions: number[];
  mintAddress: string;
  program: SolTokenProgram | null;
  programId: string | null;
  status: SolTokenHoldingStatus;
  unsupportedReason?: string;
};

export type InspectSolTokenMintsOptions = {
  commitment?: Commitment;
  connection: Pick<Connection, "getMultipleAccountsInfo">;
  mintAddresses: readonly (PublicKey | string)[];
};

export type SolanaHoldingsConnection = Pick<
  Connection,
  "getBalance" | "getMultipleAccountsInfo" | "getTokenAccountsByOwner"
>;

export type SolTokenCollectionConnection = SolanaHoldingsConnection & Pick<
  Connection,
  | "confirmTransaction"
  | "getAccountInfo"
  | "getEpochInfo"
  | "getFeeForMessage"
  | "getLatestBlockhash"
  | "getMinimumBalanceForRentExemption"
  | "sendRawTransaction"
>;

export type SolTokenCollectionJob = {
  amount: bigint;
  decimals: number;
  destinationAddress: string;
  destinationTokenAccount: string;
  id: string;
  mintAddress: string;
  program: SolTokenProgram;
  programId: string;
  source: SolCollectionSource;
  sourceAddress: string;
  sourceTokenAccount: string;
};

export type CreateSolTokenCollectionJobsOptions = {
  allowDestinationOwnerOffCurve?: boolean;
  destination: PublicKey | string;
  holdings: readonly SolTokenAssetHolding[];
  selectedHoldingIds: ReadonlySet<string> | readonly string[];
  sources: readonly SolCollectionSource[];
};

export type SolTokenCollectionSkipReason =
  | "duplicate-job"
  | "insufficient-native-balance"
  | "missing-token-account"
  | "same-token-account"
  | "unsupported-token"
  | "zero-balance";

export type SolTokenCollectionResultStatus = "error" | "skipped" | "success";

export type SolTokenCollectionResult = {
  amount: bigint;
  ataRentLamports: bigint;
  decimals: number;
  destinationAddress: string;
  destinationTokenAccount: string;
  feeLamports: bigint;
  id: string;
  message: string;
  mintAddress: string;
  nativeBalanceLamports: bigint;
  program: SolTokenProgram;
  programId: string;
  receivedAmount: bigint;
  reason?: SolTokenCollectionSkipReason;
  retryable: boolean;
  signature?: TransactionSignature;
  sourceAddress: string;
  sourceTokenAccount: string;
  status: SolTokenCollectionResultStatus;
  transferFeeAmount: bigint;
  uncertain: boolean;
};

export type SolTokenCollectionProgressPhase =
  | "error"
  | "preparing"
  | "skipped"
  | "submitted"
  | "success";

export type SolTokenCollectionProgress = {
  amount: bigint;
  completed: number;
  current: number;
  decimals: number;
  id: string;
  mintAddress: string;
  phase: SolTokenCollectionProgressPhase;
  signature?: TransactionSignature;
  sourceAddress: string;
  sourceTokenAccount: string;
  total: number;
};

export type CollectSolTokenJobsOptions = {
  commitment?: Commitment;
  connection: SolTokenCollectionConnection;
  executionSettings?: Partial<CollectionExecutionSettings>;
  fallbackFeeLamports?: bigint | null;
  jobs: readonly SolTokenCollectionJob[];
  onProgress?: (progress: SolTokenCollectionProgress) => void;
  pauseControl?: CollectionPauseControl;
  sendOptions?: SendOptions;
};

type RawHolding = {
  account: Account;
  holding: Omit<
    SolTokenAssetHolding,
    "decimals" | "formattedAmount" | "mintExtensions" | "status" | "unsupportedReason"
  > & { unsupportedReason?: string };
};

type MintReview = {
  decimals: number | null;
  extensions: number[];
  mint: Mint | null;
  status: SolTokenHoldingStatus;
  unsupportedReason?: string;
};

class SolTokenCollectionSafeError extends Error {}

function programKind(programId: PublicKey): SolTokenProgram {
  return programId.equals(TOKEN_2022_PROGRAM_ID) ? "token-2022" : "spl-token";
}

function programPublicKey(program: SolTokenProgram | string) {
  if (program === "spl-token" || program === TOKEN_PROGRAM_ID.toBase58()) return TOKEN_PROGRAM_ID;
  if (program === "token-2022" || program === TOKEN_2022_PROGRAM_ID.toBase58()) return TOKEN_2022_PROGRAM_ID;
  throw new SolTokenCollectionSafeError("Token Program 无效");
}

function holdingId(programId: PublicKey | string, tokenAccount: PublicKey | string) {
  return `${programId.toString()}:${tokenAccount.toString()}`;
}

function toSafeBigInt(value: bigint | number, kind: "balance" | "fee" | "rent") {
  if (typeof value === "bigint") {
    if (value < 0n) throw new SolTokenCollectionSafeError(`${kind} 无效`);
    return value;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SolTokenCollectionSafeError(`${kind} 无法安全换算`);
  }
  return BigInt(value);
}

function safeExtensionTypes(tlvData: Buffer) {
  try {
    return getExtensionTypes(tlvData).map(Number);
  } catch {
    throw new SolTokenCollectionSafeError("Token-2022 扩展数据无效");
  }
}

const knownExtensionTypes = new Set<number>(Object.values(ExtensionType).filter(
  (value): value is number => typeof value === "number"
));

const auditedMintExtensionTypes = new Set<number>([
  ExtensionType.TransferFeeConfig,
  ExtensionType.MintCloseAuthority,
  ExtensionType.DefaultAccountState,
  ExtensionType.MetadataPointer,
  ExtensionType.TokenMetadata,
  ExtensionType.GroupPointer,
  ExtensionType.TokenGroup,
  ExtensionType.GroupMemberPointer,
  ExtensionType.TokenGroupMember,
  ExtensionType.PermanentDelegate,
  ExtensionType.PausableConfig,
  ExtensionType.PermissionedBurn
]);

const auditedAccountExtensionTypes = new Set<number>([
  ExtensionType.TransferFeeAmount,
  ExtensionType.ImmutableOwner,
  ExtensionType.MemoTransfer,
  ExtensionType.CpiGuard,
  ExtensionType.PausableAccount
]);

function unknownExtensionReason(types: readonly number[]) {
  return types.some((type) => !knownExtensionTypes.has(type))
    ? "包含当前客户端无法识别的 Token-2022 扩展"
    : undefined;
}

function unauditedExtensionReason(types: readonly number[], auditedTypes: ReadonlySet<number>) {
  return unknownExtensionReason(types)
    || (types.some((type) => !auditedTypes.has(type))
      ? "包含当前版本尚未审计的 Token-2022 扩展"
      : undefined);
}

function reviewToken2022Account(account: Account) {
  const types = safeExtensionTypes(account.tlvData);
  if (types.includes(ExtensionType.ConfidentialTransferAccount)) return "ConfidentialTransfer 账户暂不支持归集";
  if (types.includes(ExtensionType.NonTransferableAccount)) return "NonTransferable Token 不可归集";
  if (types.includes(ExtensionType.TransferHookAccount)) return "TransferHook Token 暂不支持归集";
  return unauditedExtensionReason(types, auditedAccountExtensionTypes);
}

function reviewMint(mint: Mint, programId: PublicKey): MintReview {
  if (!mint.isInitialized) {
    return { decimals: null, extensions: [], mint: null, status: "unverified", unsupportedReason: "Mint 尚未初始化" };
  }
  if (programId.equals(TOKEN_PROGRAM_ID)) {
    return { decimals: mint.decimals, extensions: [], mint, status: "ready" };
  }

  const extensions = safeExtensionTypes(mint.tlvData);
  let unsupportedReason: string | undefined;
  if (!unsupportedReason && extensions.includes(ExtensionType.ConfidentialTransferMint)) {
    unsupportedReason = "ConfidentialTransfer Token 暂不支持归集";
  }
  if (!unsupportedReason && (extensions.includes(ExtensionType.TransferHook))) {
    unsupportedReason = "TransferHook Token 暂不支持归集";
  }
  if (!unsupportedReason && extensions.includes(ExtensionType.InterestBearingConfig)) {
    unsupportedReason = "InterestBearing Token 的动态显示余额暂不支持归集";
  }
  if (!unsupportedReason && extensions.includes(ExtensionType.ScaledUiAmountConfig)) {
    unsupportedReason = "ScaledUiAmount Token 的动态显示余额暂不支持归集";
  }
  if (!unsupportedReason && getNonTransferable(mint)) {
    unsupportedReason = "NonTransferable Token 不可归集";
  }
  if (!unsupportedReason && getPausableConfig(mint)?.paused) {
    unsupportedReason = "Token 当前已暂停转账";
  }
  if (!unsupportedReason && getDefaultAccountState(mint)?.state === AccountState.Frozen) {
    unsupportedReason = "Token 新账户默认为冻结状态，暂不支持归集";
  }
  if (!unsupportedReason) {
    unsupportedReason = unauditedExtensionReason(extensions, auditedMintExtensionTypes);
  }

  return {
    decimals: mint.decimals,
    extensions,
    mint,
    status: unsupportedReason ? "unsupported" : "ready",
    ...(unsupportedReason ? { unsupportedReason } : {})
  };
}

export function formatSolTokenAmount(amount: bigint, decimals: number) {
  if (amount < 0n) throw new RangeError("amount must be non-negative");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new RangeError("decimals must be an integer between 0 and 255");
  }
  if (decimals === 0) return amount.toString();
  const digits = amount.toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function safeDiscoveryIssue(kind: "balance" | "mint" | "token") {
  if (kind === "balance") return "原生 SOL 余额读取失败";
  if (kind === "mint") return "Mint 信息读取失败，相关持仓不可归集";
  return "Token 账户读取失败";
}

function normalizeMintAddressFilter(
  mintAddresses: DiscoverSolanaHoldingsOptions["mintAddresses"]
) {
  if (mintAddresses === undefined) return undefined;
  if (!Array.isArray(mintAddresses)) {
    throw new TypeError("mintAddresses must be an array");
  }

  const normalized = new Set<string>();
  mintAddresses.forEach((address, index) => {
    try {
      if (typeof address !== "string" && !(address instanceof PublicKey)) {
        throw new TypeError("invalid Mint address type");
      }
      normalized.add((typeof address === "string" ? new PublicKey(address) : address).toBase58());
    } catch {
      throw new SolTokenCollectionSafeError(`mintAddresses[${index}] 不是有效的 Solana Mint 地址`);
    }
  });
  return normalized;
}

function normalizeMintAddressList(
  mintAddresses: InspectSolTokenMintsOptions["mintAddresses"]
) {
  if (!Array.isArray(mintAddresses)) {
    throw new TypeError("mintAddresses must be an array");
  }

  return mintAddresses.map((address, index) => {
    try {
      if (typeof address !== "string" && !(address instanceof PublicKey)) {
        throw new TypeError("invalid Mint address type");
      }
      return typeof address === "string" ? new PublicKey(address) : address;
    } catch {
      throw new SolTokenCollectionSafeError(`mintAddresses[${index}] 不是有效的 Solana Mint 地址`);
    }
  });
}

function unverifiedMintInspection(
  mintAddress: PublicKey,
  unsupportedReason: string,
  owner?: PublicKey
): SolTokenMintInspection {
  const supportedOwner = owner?.equals(TOKEN_PROGRAM_ID) || owner?.equals(TOKEN_2022_PROGRAM_ID);
  return {
    decimals: null,
    extensions: [],
    mintAddress: mintAddress.toBase58(),
    program: supportedOwner && owner ? programKind(owner) : null,
    programId: owner?.toBase58() || null,
    status: "unverified",
    unsupportedReason
  };
}

export async function inspectSolTokenMints({
  commitment = "confirmed",
  connection,
  mintAddresses
}: InspectSolTokenMintsOptions): Promise<SolTokenMintInspection[]> {
  const requestedMints = normalizeMintAddressList(mintAddresses);
  const uniqueMints = new Map<string, PublicKey>();
  requestedMints.forEach((mintAddress) => {
    const canonicalAddress = mintAddress.toBase58();
    if (!uniqueMints.has(canonicalAddress)) uniqueMints.set(canonicalAddress, mintAddress);
  });

  const inspected = new Map<string, SolTokenMintInspection>();
  const entries = [...uniqueMints.entries()];
  for (let offset = 0; offset < entries.length; offset += mintAccountBatchSize) {
    const chunk = entries.slice(offset, offset + mintAccountBatchSize);
    let infos: Awaited<ReturnType<typeof connection.getMultipleAccountsInfo>>;
    try {
      infos = await connection.getMultipleAccountsInfo(
        chunk.map(([, mintAddress]) => mintAddress),
        commitment
      );
    } catch {
      chunk.forEach(([canonicalAddress, mintAddress]) => {
        inspected.set(canonicalAddress, unverifiedMintInspection(
          mintAddress,
          safeDiscoveryIssue("mint")
        ));
      });
      continue;
    }

    chunk.forEach(([canonicalAddress, mintAddress], index) => {
      const accountInfo = infos[index];
      if (!accountInfo) {
        inspected.set(canonicalAddress, unverifiedMintInspection(
          mintAddress,
          "Mint 账户不存在"
        ));
        return;
      }
      const programId = accountInfo.owner;
      if (!programId.equals(TOKEN_PROGRAM_ID) && !programId.equals(TOKEN_2022_PROGRAM_ID)) {
        inspected.set(canonicalAddress, unverifiedMintInspection(
          mintAddress,
          "Mint 账户 owner 不是受支持的 Token Program",
          programId
        ));
        return;
      }

      try {
        const review = reviewMint(unpackMint(mintAddress, accountInfo, programId), programId);
        inspected.set(canonicalAddress, {
          decimals: review.decimals,
          extensions: review.extensions,
          mintAddress: canonicalAddress,
          program: programKind(programId),
          programId: programId.toBase58(),
          status: review.status,
          ...(review.unsupportedReason ? { unsupportedReason: review.unsupportedReason } : {})
        });
      } catch {
        inspected.set(canonicalAddress, unverifiedMintInspection(
          mintAddress,
          safeDiscoveryIssue("mint"),
          programId
        ));
      }
    });
  }

  return requestedMints.map((mintAddress) => inspected.get(mintAddress.toBase58())!);
}

async function fetchMintReviews(
  connection: SolanaHoldingsConnection,
  holdings: readonly RawHolding[],
  commitment: Commitment
) {
  const keys = new Map<string, { mint: PublicKey; programId: PublicKey }>();
  holdings.forEach(({ account, holding }) => {
    const programId = programPublicKey(holding.programId);
    const key = `${programId.toBase58()}:${account.mint.toBase58()}`;
    if (!keys.has(key)) keys.set(key, { mint: account.mint, programId });
  });

  const reviews = new Map<string, MintReview>();
  const entries = [...keys.entries()];
  for (let offset = 0; offset < entries.length; offset += mintAccountBatchSize) {
    const chunk = entries.slice(offset, offset + mintAccountBatchSize);
    try {
      const infos = await connection.getMultipleAccountsInfo(
        chunk.map(([, value]) => value.mint),
        commitment
      );
      chunk.forEach(([key, value], index) => {
        try {
          const mint = unpackMint(value.mint, infos[index], value.programId);
          reviews.set(key, reviewMint(mint, value.programId));
        } catch {
          reviews.set(key, {
            decimals: null,
            extensions: [],
            mint: null,
            status: "unverified",
            unsupportedReason: safeDiscoveryIssue("mint")
          });
        }
      });
    } catch {
      chunk.forEach(([key]) => reviews.set(key, {
        decimals: null,
        extensions: [],
        mint: null,
        status: "unverified",
        unsupportedReason: safeDiscoveryIssue("mint")
      }));
    }
  }
  return reviews;
}

export async function discoverSolanaHoldings({
  commitment = "confirmed",
  concurrency = 5,
  connection,
  maximumTokenAccounts = maximumDiscoveredSolTokenAccounts,
  mintAddresses,
  sources
}: DiscoverSolanaHoldingsOptions): Promise<SolanaHoldingsResult> {
  if (!Number.isInteger(maximumTokenAccounts) || maximumTokenAccounts < 1) {
    throw new RangeError("maximumTokenAccounts must be a positive integer");
  }
  const executionSettings = normalizeCollectionExecutionSettings({ concurrency });
  const mintAddressFilter = normalizeMintAddressFilter(mintAddresses);
  const programIds = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID] as const;
  const tokenAccountQueries: Array<{
    expectedMintAddress?: string;
    expectedProgramId?: PublicKey;
    filter: TokenAccountsFilter;
    issueLabel: string;
  }> = mintAddressFilter === undefined
    ? programIds.map((programId) => ({
      expectedProgramId: programId,
      filter: { programId },
      issueLabel: programKind(programId)
    }))
    : [...mintAddressFilter].map((mintAddress) => ({
      expectedMintAddress: mintAddress,
      filter: { mint: new PublicKey(mintAddress) },
      issueLabel: `Mint ${mintAddress}`
    }));
  let returnedTokenAccountCount = 0;

  const scanned = await mapWithCollectionConcurrency(
    sources,
    executionSettings.concurrency,
    async (source) => {
      const address = source.keypair.publicKey.toBase58();
      const issues: string[] = [];
      if (source.address !== address) {
        return {
          rawHoldings: [] as RawHolding[],
          wallet: {
            address,
            issues: ["来源钱包信息不一致"],
            label: source.label,
            line: source.line,
            nativeBalanceLamports: null,
            nativeBalanceStatus: "error" as const,
            status: "error" as const,
            tokenInventoryStatus: "partial" as const,
            tokenAccounts: [] as SolTokenAssetHolding[]
          }
        };
      }

      const balancePromise = Promise.allSettled([
        connection.getBalance(source.keypair.publicKey, commitment)
      ]).then(([result]) => result);
      const tokenResults = await mapWithCollectionConcurrency(
        tokenAccountQueries,
        tokenAccountQueryConcurrency,
        async (query) => {
          try {
            return {
              status: "fulfilled" as const,
              value: await connection.getTokenAccountsByOwner(
                source.keypair.publicKey,
                query.filter,
                commitment
              )
            };
          } catch (reason) {
            return { reason, status: "rejected" as const };
          }
        }
      );
      const balanceResult = await balancePromise;
      let nativeBalanceLamports: bigint | null = null;
      if (balanceResult.status === "fulfilled") {
        try {
          nativeBalanceLamports = toSafeBigInt(balanceResult.value, "balance");
        } catch {
          issues.push(safeDiscoveryIssue("balance"));
        }
      } else {
        issues.push(safeDiscoveryIssue("balance"));
      }

      const rawHoldings: RawHolding[] = [];
      let tokenInventoryComplete = true;
      returnedTokenAccountCount += tokenResults.reduce(
        (count, result) => count + (result.status === "fulfilled" ? result.value.value.length : 0),
        0
      );
      if (returnedTokenAccountCount > maximumTokenAccounts) {
        throw new SolTokenCollectionSafeError(
          `识别到的 Token 账户超过 ${maximumTokenAccounts.toLocaleString("en-US")} 个，请拆分来源钱包`
        );
      }
      tokenResults.forEach((result, queryIndex) => {
        const query = tokenAccountQueries[queryIndex];
        if (result.status === "rejected") {
          tokenInventoryComplete = false;
          issues.push(`${query.issueLabel} ${safeDiscoveryIssue("token")}`);
          return;
        }
        result.value.value.forEach(({ account: accountInfo, pubkey }) => {
          try {
            const programId = accountInfo.owner;
            if (!programIds.some((supportedProgramId) => supportedProgramId.equals(programId))) {
              throw new SolTokenCollectionSafeError("Token 账户 Program 不受支持");
            }
            if (query.expectedProgramId && !query.expectedProgramId.equals(programId)) {
              throw new SolTokenCollectionSafeError("Token 账户 Program 与查询不一致");
            }
            const account = unpackAccount(pubkey, accountInfo, programId);
            if (!account.owner.equals(source.keypair.publicKey)) {
              throw new SolTokenCollectionSafeError("Token 账户 owner 不匹配");
            }
            const mintAddress = account.mint.toBase58();
            if (query.expectedMintAddress && query.expectedMintAddress !== mintAddress) {
              throw new SolTokenCollectionSafeError("Token 账户 Mint 与查询不一致");
            }
            if (mintAddressFilter && !mintAddressFilter.has(mintAddress)) return;
            if (!account.isInitialized || account.amount === 0n) return;
            const accountUnsupportedReason = account.isFrozen
              ? "Token 账户已冻结"
              : programId.equals(TOKEN_2022_PROGRAM_ID) ? reviewToken2022Account(account) : undefined;
            const expectedAta = getAssociatedTokenAddressSync(
              account.mint,
              source.keypair.publicKey,
              false,
              programId
            );
            rawHoldings.push({
              account,
              holding: {
                amount: account.amount,
                id: holdingId(programId, pubkey),
                isAssociated: expectedAta.equals(pubkey),
                isFrozen: account.isFrozen,
                isNative: account.isNative,
                label: source.label,
                line: source.line,
                mintAddress,
                program: programKind(programId),
                programId: programId.toBase58(),
                sourceAddress: address,
                sourceTokenAccount: pubkey.toBase58(),
                ...(accountUnsupportedReason ? { unsupportedReason: accountUnsupportedReason } : {})
              }
            });
          } catch {
            tokenInventoryComplete = false;
            issues.push(`${query.issueLabel} ${safeDiscoveryIssue("token")}`);
          }
        });
      });

      return {
        rawHoldings,
        wallet: {
          address,
          issues,
          label: source.label,
          line: source.line,
          nativeBalanceLamports,
          nativeBalanceStatus: nativeBalanceLamports === null ? "error" as const : "ok" as const,
          status: issues.length ? "partial" as const : "ok" as const,
          tokenInventoryStatus: tokenInventoryComplete ? "complete" as const : "partial" as const,
          tokenAccounts: [] as SolTokenAssetHolding[]
        }
      };
    }
  );

  const allRawHoldings = scanned.flatMap((entry) => entry.rawHoldings);
  if (allRawHoldings.length > maximumTokenAccounts) {
    throw new SolTokenCollectionSafeError(
      `识别到的 Token 账户超过 ${maximumTokenAccounts.toLocaleString("en-US")} 个，请拆分来源钱包`
    );
  }
  const mintReviews = await fetchMintReviews(connection, allRawHoldings, commitment);
  const holdings = allRawHoldings.map(({ account, holding }): SolTokenAssetHolding => {
    const review = mintReviews.get(`${holding.programId}:${holding.mintAddress}`);
    const accountReason = holding.unsupportedReason;
    const status = accountReason ? "unsupported" : review?.status || "unverified";
    const unsupportedReason = accountReason || review?.unsupportedReason;
    const decimals = review?.decimals ?? null;
    return {
      ...holding,
      decimals,
      formattedAmount: decimals === null ? null : formatSolTokenAmount(holding.amount, decimals),
      mintExtensions: review?.extensions || [],
      status,
      ...(unsupportedReason ? { unsupportedReason } : {})
    };
  });
  const holdingsByAddress = new Map<string, SolTokenAssetHolding[]>();
  holdings.forEach((holding) => {
    const list = holdingsByAddress.get(holding.sourceAddress) || [];
    list.push(holding);
    holdingsByAddress.set(holding.sourceAddress, list);
  });
  const wallets = scanned.map(({ wallet }): SolanaWalletHoldings => {
    const tokenAccounts = holdingsByAddress.get(wallet.address) || [];
    const hasUnverifiedMint = tokenAccounts.some((holding) => holding.status === "unverified");
    const issues = hasUnverifiedMint
      ? [...wallet.issues, safeDiscoveryIssue("mint")]
      : wallet.issues;
    return {
      ...wallet,
      issues,
      status: wallet.status === "error"
        ? "error"
        : issues.length ? "partial" : "ok",
      tokenAccounts
    };
  });
  const issues = wallets.flatMap((wallet) => wallet.issues.map((issue) => `${wallet.address}: ${issue}`));
  return {
    holdings,
    issues,
    partial: wallets.some((wallet) => wallet.status !== "ok"),
    readyTokenAccountCount: holdings.filter((holding) => holding.status === "ready").length,
    tokenInventoryComplete: wallets.every((wallet) => wallet.tokenInventoryStatus === "complete"),
    tokenAccountCount: holdings.length,
    totalNativeBalanceLamports: wallets.reduce(
      (total, wallet) => total + (wallet.nativeBalanceLamports || 0n),
      0n
    ),
    wallets
  };
}

function selectedIdSet(value: ReadonlySet<string> | readonly string[]) {
  return value instanceof Set ? value : new Set(value);
}

export function createSolTokenCollectionJobs({
  allowDestinationOwnerOffCurve = false,
  destination,
  holdings,
  selectedHoldingIds,
  sources
}: CreateSolTokenCollectionJobsOptions): SolTokenCollectionJob[] {
  let destinationPublicKey: PublicKey;
  try {
    destinationPublicKey = typeof destination === "string" ? new PublicKey(destination) : destination;
  } catch {
    throw new SolTokenCollectionSafeError("归集目标地址无效");
  }
  if (!allowDestinationOwnerOffCurve && !PublicKey.isOnCurve(destinationPublicKey.toBytes())) {
    throw new SolTokenCollectionSafeError("SPL Token 归集目标必须是可签名的钱包地址");
  }

  const selected = selectedIdSet(selectedHoldingIds);
  const sourceByAddress = new Map(sources.map((source) => [source.address, source]));
  const seen = new Set<string>();
  const jobs: SolTokenCollectionJob[] = [];
  holdings.forEach((holding) => {
    if (!selected.has(holding.id)) return;
    if (holding.status !== "ready" || holding.decimals === null || holding.amount <= 0n) return;
    const source = sourceByAddress.get(holding.sourceAddress);
    if (!source || source.keypair.publicKey.toBase58() !== holding.sourceAddress) return;
    const programId = programPublicKey(holding.program);
    if (programId.toBase58() !== holding.programId) return;
    const canonicalId = holdingId(programId, holding.sourceTokenAccount);
    if (holding.id !== canonicalId) {
      throw new SolTokenCollectionSafeError("Token 持仓标识不一致，请重新识别持仓");
    }
    if (seen.has(canonicalId)) return;
    const mint = new PublicKey(holding.mintAddress);
    const destinationTokenAccount = getAssociatedTokenAddressSync(
      mint,
      destinationPublicKey,
      allowDestinationOwnerOffCurve,
      programId
    );
    if (destinationTokenAccount.toBase58() === holding.sourceTokenAccount) return;
    seen.add(canonicalId);
    jobs.push({
      amount: holding.amount,
      decimals: holding.decimals,
      destinationAddress: destinationPublicKey.toBase58(),
      destinationTokenAccount: destinationTokenAccount.toBase58(),
      id: canonicalId,
      mintAddress: holding.mintAddress,
      program: holding.program,
      programId: holding.programId,
      source,
      sourceAddress: holding.sourceAddress,
      sourceTokenAccount: holding.sourceTokenAccount
    });
  });
  return jobs;
}

function emitProgress(
  callback: CollectSolTokenJobsOptions["onProgress"],
  progress: SolTokenCollectionProgress
) {
  try {
    callback?.(progress);
  } catch {
    // Progress rendering must never interrupt a signed collection transaction.
  }
}

function safeExecutionMessage(error: unknown) {
  if (error instanceof SolTokenCollectionSafeError) return error.message;
  const detail = error instanceof Error ? error.message : String(error || "");
  if (/429|rate.?limit|too many requests/i.test(detail)) return "RPC 请求过于频繁，请稍后重试";
  if (/403|failed to fetch|network|fetch/i.test(detail)) return "RPC 网络请求失败，请检查节点后重试";
  if (/blockhash|expired/i.test(detail)) return "交易区块哈希已过期，请重新归集";
  if (/insufficient|attempt to debit|0x1/i.test(detail)) return "来源钱包 SOL 不足，无法支付归集费用";
  if (/simulation|preflight/i.test(detail)) return "交易预检失败，Token 状态可能已经变化";
  return "SPL Token 归集失败，请稍后重试";
}

function isExplicitPreflightRejection(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error || "");
  return /transaction simulation failed|simulation failed|preflight failure|preflight rejected/i.test(detail);
}

function validateLiveTokenAccount(
  account: Account,
  source: PublicKey,
  mint: PublicKey,
  programId: PublicKey
) {
  if (!account.owner.equals(source) || !account.mint.equals(mint)) {
    throw new SolTokenCollectionSafeError("Token 账户信息已变化，请重新识别持仓");
  }
  if (!account.isInitialized) throw new SolTokenCollectionSafeError("Token 账户尚未初始化");
  if (account.isFrozen) return "Token 账户已冻结";
  return programId.equals(TOKEN_2022_PROGRAM_ID) ? reviewToken2022Account(account) : undefined;
}

function validateDestinationAccount(
  account: Account,
  destination: PublicKey,
  mint: PublicKey,
  programId: PublicKey
) {
  if (!account.owner.equals(destination) || !account.mint.equals(mint) || !account.isInitialized) {
    throw new SolTokenCollectionSafeError("目标 ATA 信息不匹配，已拒绝提交");
  }
  if (account.isFrozen) return "目标 ATA 已冻结";
  if (programId.equals(TOKEN_2022_PROGRAM_ID)) {
    const unsupported = reviewToken2022Account(account);
    if (unsupported) return unsupported;
    if (getMemoTransfer(account)?.requireIncomingTransferMemos) {
      return "目标 ATA 要求 Memo，当前归集暂不支持";
    }
  }
  return undefined;
}

type ExecuteJobState = {
  completed: number;
  duplicate: boolean;
  index: number;
  total: number;
};

async function executeSolTokenJob(
  job: SolTokenCollectionJob,
  options: CollectSolTokenJobsOptions,
  state: ExecuteJobState,
  complete: () => number
): Promise<SolTokenCollectionResult> {
  const { commitment = "confirmed", connection, onProgress, pauseControl } = options;
  let amount = 0n;
  let ataRentLamports = 0n;
  let feeLamports = 0n;
  let nativeBalanceLamports = 0n;
  let transferFeeAmount = 0n;
  let submittedSignature: TransactionSignature | undefined;
  let broadcastAcknowledged = false;
  let chainExecutionFailed = false;
  let preflightRejected = false;

  const progressBase = {
    decimals: job.decimals,
    id: job.id,
    mintAddress: job.mintAddress,
    sourceAddress: job.sourceAddress,
    sourceTokenAccount: job.sourceTokenAccount,
    total: state.total
  };
  emitProgress(onProgress, {
    ...progressBase,
    amount,
    completed: state.completed,
    current: state.index + 1,
    phase: "preparing"
  });

  const finishSkipped = (reason: SolTokenCollectionSkipReason, message: string) => {
    const completed = complete();
    emitProgress(onProgress, {
      ...progressBase,
      amount,
      completed,
      current: state.index + 1,
      phase: "skipped"
    });
    return {
      amount,
      ataRentLamports,
      decimals: job.decimals,
      destinationAddress: job.destinationAddress,
      destinationTokenAccount: job.destinationTokenAccount,
      feeLamports,
      id: job.id,
      message,
      mintAddress: job.mintAddress,
      nativeBalanceLamports,
      program: job.program,
      programId: job.programId,
      receivedAmount: 0n,
      reason,
      retryable: false,
      sourceAddress: job.sourceAddress,
      sourceTokenAccount: job.sourceTokenAccount,
      status: "skipped" as const,
      transferFeeAmount,
      uncertain: false
    };
  };

  if (state.duplicate) return finishSkipped("duplicate-job", "Token 账户任务重复，已跳过");

  try {
    const programId = programPublicKey(job.program);
    if (programId.toBase58() !== job.programId) {
      throw new SolTokenCollectionSafeError("Token Program 信息不一致");
    }
    const source = job.source.keypair.publicKey;
    if (job.source.address !== job.sourceAddress || source.toBase58() !== job.sourceAddress) {
      throw new SolTokenCollectionSafeError("来源钱包信息不一致");
    }
    const sourceTokenAccount = new PublicKey(job.sourceTokenAccount);
    const mintAddress = new PublicKey(job.mintAddress);
    const destinationAddress = new PublicKey(job.destinationAddress);
    if (job.id !== holdingId(programId, sourceTokenAccount)) {
      throw new SolTokenCollectionSafeError("Token 任务标识不一致，请重新识别持仓");
    }
    if (!PublicKey.isOnCurve(destinationAddress.toBytes())) {
      throw new SolTokenCollectionSafeError("SPL Token 归集目标必须是可签名的钱包地址");
    }
    const destinationTokenAccount = getAssociatedTokenAddressSync(
      mintAddress,
      destinationAddress,
      true,
      programId
    );
    if (destinationTokenAccount.toBase58() !== job.destinationTokenAccount) {
      throw new SolTokenCollectionSafeError("目标 ATA 推导结果不一致");
    }
    if (destinationTokenAccount.equals(sourceTokenAccount)) {
      return finishSkipped("same-token-account", "来源 Token 账户就是目标 ATA，已跳过");
    }

    await pauseControl?.waitUntilResumed();
    await waitForCollectionDelay(normalizeCollectionExecutionSettings(options.executionSettings));
    await pauseControl?.waitUntilResumed();

    const sourceInfo = await connection.getAccountInfo(sourceTokenAccount, commitment);
    if (!sourceInfo) return finishSkipped("missing-token-account", "来源 Token 账户不存在，已跳过");
    const sourceAccount = unpackAccount(sourceTokenAccount, sourceInfo, programId);
    const sourceUnsupported = validateLiveTokenAccount(sourceAccount, source, mintAddress, programId);
    if (sourceUnsupported) return finishSkipped("unsupported-token", sourceUnsupported);
    if (sourceAccount.amount === 0n) return finishSkipped("zero-balance", "Token 余额为 0，已跳过");
    amount = sourceAccount.amount;

    const mintInfo = await connection.getAccountInfo(mintAddress, commitment);
    if (!mintInfo) throw new SolTokenCollectionSafeError("Mint 不存在或已关闭，请重新识别持仓");
    const mint = unpackMint(mintAddress, mintInfo, programId);
    const mintReview = reviewMint(mint, programId);
    if (mintReview.status !== "ready") {
      return finishSkipped("unsupported-token", mintReview.unsupportedReason || "Token 暂不支持归集");
    }
    if (mint.decimals !== job.decimals) {
      throw new SolTokenCollectionSafeError("Mint 精度已变化，请重新识别持仓");
    }

    const destinationInfo = await connection.getAccountInfo(destinationTokenAccount, commitment);
    const createDestinationAta = destinationInfo === null;
    if (destinationInfo) {
      const destinationAccount = unpackAccount(destinationTokenAccount, destinationInfo, programId);
      const destinationUnsupported = validateDestinationAccount(
        destinationAccount,
        destinationAddress,
        mintAddress,
        programId
      );
      if (destinationUnsupported) return finishSkipped("unsupported-token", destinationUnsupported);
    } else {
      let accountLength = ACCOUNT_SIZE;
      if (programId.equals(TOKEN_2022_PROGRAM_ID)) {
        try {
          accountLength = getAccountLen([
            ...safeExtensionTypes(mint.tlvData).map((extension) => (
              getAccountTypeOfMintType(extension as ExtensionType)
            )),
            ExtensionType.ImmutableOwner
          ]);
        } catch {
          return finishSkipped("unsupported-token", "无法确定 Token-2022 ATA 大小，已拒绝提交");
        }
      }
      ataRentLamports = toSafeBigInt(
        await connection.getMinimumBalanceForRentExemption(accountLength, commitment),
        "rent"
      );
    }

    const transferFeeConfig = programId.equals(TOKEN_2022_PROGRAM_ID)
      ? getTransferFeeConfig(mint)
      : null;
    if (transferFeeConfig) {
      const epochInfo = await connection.getEpochInfo(commitment);
      transferFeeAmount = calculateEpochFee(transferFeeConfig, BigInt(epochInfo.epoch), amount);
    }

    const latestBlockhash = await connection.getLatestBlockhash(commitment);
    const transaction = new Transaction({
      feePayer: source,
      recentBlockhash: latestBlockhash.blockhash
    });
    // Creation is idempotent when the ATA was absent. If an existing ATA is
    // closed after the read, the transfer safely fails instead of unexpectedly
    // charging rent that was not included in the source SOL check.
    if (createDestinationAta) {
      transaction.add(createAssociatedTokenAccountIdempotentInstruction(
        source,
        destinationTokenAccount,
        destinationAddress,
        mintAddress,
        programId
      ));
    }
    transaction.add(transferFeeConfig
      ? createTransferCheckedWithFeeInstruction(
        sourceTokenAccount,
        mintAddress,
        destinationTokenAccount,
        source,
        amount,
        mint.decimals,
        transferFeeAmount,
        [],
        programId
      )
      : createTransferCheckedInstruction(
        sourceTokenAccount,
        mintAddress,
        destinationTokenAccount,
        source,
        amount,
        mint.decimals,
        [],
        programId
      ));

    const feeResponse = await connection.getFeeForMessage(transaction.compileMessage(), commitment);
    const fallbackFeeLamports = options.fallbackFeeLamports ?? defaultSolTokenCollectionFeeLamports;
    if (feeResponse.value === null && options.fallbackFeeLamports === null) {
      throw new SolTokenCollectionSafeError("RPC 无法估算交易手续费，已停止该项");
    }
    feeLamports = feeResponse.value === null
      ? fallbackFeeLamports
      : toSafeBigInt(feeResponse.value, "fee");
    nativeBalanceLamports = toSafeBigInt(await connection.getBalance(source, commitment), "balance");
    if (nativeBalanceLamports < feeLamports + ataRentLamports) {
      return finishSkipped(
        "insufficient-native-balance",
        "来源钱包 SOL 不足以支付网络费和目标 ATA 租金，已跳过"
      );
    }

    transaction.sign(job.source.keypair);
    if (!transaction.signature) throw new SolTokenCollectionSafeError("交易签名失败");
    submittedSignature = encodeBase58(transaction.signature);
    const sendOptions: SendOptions = {
      ...options.sendOptions,
      preflightCommitment: options.sendOptions?.preflightCommitment || commitment,
      skipPreflight: false
    };
    let rpcSignature: TransactionSignature;
    try {
      rpcSignature = await connection.sendRawTransaction(transaction.serialize(), sendOptions);
    } catch (error) {
      preflightRejected = isExplicitPreflightRejection(error);
      throw error;
    }
    if (rpcSignature !== submittedSignature) {
      throw new SolTokenCollectionSafeError("RPC 返回的交易签名不一致，提交状态需要人工核对");
    }
    broadcastAcknowledged = true;
    emitProgress(onProgress, {
      ...progressBase,
      amount,
      completed: state.completed,
      current: state.index + 1,
      phase: "submitted",
      signature: submittedSignature
    });

    const confirmation = await connection.confirmTransaction({
      ...latestBlockhash,
      signature: submittedSignature
    }, commitment);
    if (confirmation.value.err) {
      chainExecutionFailed = true;
      throw new SolTokenCollectionSafeError("交易已提交但链上执行失败");
    }

    const completed = complete();
    emitProgress(onProgress, {
      ...progressBase,
      amount,
      completed,
      current: state.index + 1,
      phase: "success",
      signature: submittedSignature
    });
    return {
      amount,
      ataRentLamports,
      decimals: job.decimals,
      destinationAddress: job.destinationAddress,
      destinationTokenAccount: job.destinationTokenAccount,
      feeLamports,
      id: job.id,
      message: transferFeeAmount > 0n ? "归集成功，已扣除 Token-2022 转账费" : "归集成功",
      mintAddress: job.mintAddress,
      nativeBalanceLamports,
      program: job.program,
      programId: job.programId,
      receivedAmount: amount - transferFeeAmount,
      retryable: false,
      signature: submittedSignature,
      sourceAddress: job.sourceAddress,
      sourceTokenAccount: job.sourceTokenAccount,
      status: "success",
      transferFeeAmount,
      uncertain: false
    };
  } catch (error) {
    const completed = complete();
    emitProgress(onProgress, {
      ...progressBase,
      amount,
      completed,
      current: state.index + 1,
      phase: "error",
      ...(submittedSignature && !preflightRejected ? { signature: submittedSignature } : {})
    });
    const uncertain = Boolean(submittedSignature) && !chainExecutionFailed && !preflightRejected;
    return {
      amount,
      ataRentLamports,
      decimals: job.decimals,
      destinationAddress: job.destinationAddress,
      destinationTokenAccount: job.destinationTokenAccount,
      feeLamports,
      id: job.id,
      message: preflightRejected
        ? "RPC 预检已明确拒绝且交易未广播，请重新识别后重试"
        : submittedSignature
          ? chainExecutionFailed
            ? "交易已确认执行失败，可重新识别后重试"
            : broadcastAcknowledged
              ? "交易已提交但确认失败，请先查链上状态，勿盲目重发"
              : "交易已签名且提交状态不确定，请先用交易签名查链上状态"
          : safeExecutionMessage(error),
      mintAddress: job.mintAddress,
      nativeBalanceLamports,
      program: job.program,
      programId: job.programId,
      receivedAmount: 0n,
      retryable: preflightRejected || chainExecutionFailed || !submittedSignature,
      ...(submittedSignature && !preflightRejected ? { signature: submittedSignature } : {}),
      sourceAddress: job.sourceAddress,
      sourceTokenAccount: job.sourceTokenAccount,
      status: "error",
      transferFeeAmount,
      uncertain
    };
  }
}

export async function collectSolTokenJobs(options: CollectSolTokenJobsOptions) {
  const executionSettings = normalizeCollectionExecutionSettings(options.executionSettings);
  if (options.fallbackFeeLamports !== undefined && options.fallbackFeeLamports !== null
    && options.fallbackFeeLamports < 0n) {
    throw new RangeError("fallbackFeeLamports must be non-negative");
  }
  const duplicateIndexes = new Set<number>();
  const seenTokenAccounts = new Set<string>();
  options.jobs.forEach((job, index) => {
    const tokenAccountKey = `${job.programId}:${job.sourceTokenAccount}`;
    if (seenTokenAccounts.has(tokenAccountKey)) duplicateIndexes.add(index);
    else seenTokenAccounts.add(tokenAccountKey);
  });
  const grouped = new Map<string, Array<{ index: number; job: SolTokenCollectionJob }>>();
  options.jobs.forEach((job, index) => {
    const group = grouped.get(job.sourceAddress) || [];
    group.push({ index, job });
    grouped.set(job.sourceAddress, group);
  });
  const results = new Array<SolTokenCollectionResult>(options.jobs.length);
  let completed = 0;
  const complete = () => {
    completed += 1;
    return completed;
  };

  await mapWithCollectionConcurrency(
    [...grouped.values()],
    executionSettings.concurrency,
    async (group) => {
      for (const { index, job } of group) {
        results[index] = await executeSolTokenJob(
          job,
          { ...options, executionSettings },
          {
            completed,
            duplicate: duplicateIndexes.has(index),
            index,
            total: options.jobs.length
          },
          complete
        );
      }
    }
  );
  return results;
}

// Compile-time checks keep the narrow interfaces aligned with web3.js.
type AssertTrue<T extends true> = T;
type ConnectionSupportsHoldings = AssertTrue<Connection extends SolanaHoldingsConnection ? true : false>;
type ConnectionSupportsCollection = AssertTrue<Connection extends SolTokenCollectionConnection ? true : false>;
