import { Buffer } from "buffer";
import {
  ACCOUNT_SIZE,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AccountLayout,
  AccountState,
  AccountType,
  ExtensionType,
  MemoTransferLayout,
  MintLayout,
  PausableConfigLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TransferFeeConfigLayout,
  decodeTransferCheckedInstruction,
  decodeTransferCheckedWithFeeInstruction,
  getAccountLen,
  getAssociatedTokenAddressSync
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  Transaction,
  type AccountInfo
} from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { encodeBase58, type SolCollectionSource } from "./sol-collection";
import {
  collectSolTokenJobs,
  createSolTokenCollectionJobs,
  discoverSolanaHoldings,
  formatSolTokenAmount,
  inspectSolTokenMints,
  type SolTokenAssetHolding,
  type SolTokenCollectionConnection,
  type SolTokenCollectionJob,
  type SolanaHoldingsConnection
} from "./sol-token-collection";

const testBlockhash = "11111111111111111111111111111111";

function keypair(index: number) {
  const seed = new Uint8Array(32);
  seed[0] = index & 0xff;
  seed[1] = (index >> 8) & 0xff;
  seed[2] = (index >> 16) & 0xff;
  return Keypair.fromSeed(seed);
}

function source(index: number): SolCollectionSource {
  const signer = keypair(index);
  return {
    address: signer.publicKey.toBase58(),
    keypair: signer,
    label: `wallet-${index}`,
    line: index
  };
}

function accountInfo(data: Buffer, owner: PublicKey, lamports = 2_100_000): AccountInfo<Buffer> {
  return {
    data,
    executable: false,
    lamports,
    owner,
    rentEpoch: 0
  };
}

function withExtensions(
  baseData: Buffer,
  accountType: AccountType,
  extensions: Array<{ data?: Buffer; type: number }>
) {
  if (!extensions.length) return baseData;
  const dataLength = ACCOUNT_SIZE + 1 + extensions.reduce(
    (total, extension) => total + 4 + (extension.data?.length || 0),
    0
  );
  const data = Buffer.alloc(dataLength);
  baseData.copy(data);
  data[ACCOUNT_SIZE] = accountType;
  let offset = ACCOUNT_SIZE + 1;
  extensions.forEach((extension) => {
    const value = extension.data || Buffer.alloc(0);
    data.writeUInt16LE(extension.type, offset);
    data.writeUInt16LE(value.length, offset + 2);
    value.copy(data, offset + 4);
    offset += 4 + value.length;
  });
  return data;
}

function tokenAccountData(options: {
  amount: bigint;
  extensions?: Array<{ data?: Buffer; type: number }>;
  frozen?: boolean;
  mint: PublicKey;
  owner: PublicKey;
}) {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({
    amount: options.amount,
    closeAuthority: PublicKey.default,
    closeAuthorityOption: 0,
    delegate: PublicKey.default,
    delegatedAmount: 0n,
    delegateOption: 0,
    isNative: 0n,
    isNativeOption: 0,
    mint: options.mint,
    owner: options.owner,
    state: options.frozen ? AccountState.Frozen : AccountState.Initialized
  }, data);
  return withExtensions(data, AccountType.Account, options.extensions || []);
}

function mintData(options: {
  decimals?: number;
  extensions?: Array<{ data?: Buffer; type: number }>;
}) {
  const data = Buffer.alloc(MintLayout.span);
  MintLayout.encode({
    decimals: options.decimals ?? 6,
    freezeAuthority: PublicKey.default,
    freezeAuthorityOption: 0,
    isInitialized: true,
    mintAuthority: PublicKey.default,
    mintAuthorityOption: 0,
    supply: 10_000_000_000n
  }, data);
  return withExtensions(data, AccountType.Mint, options.extensions || []);
}

function encodedExtension<T>(layout: { encode: (value: T, buffer: Buffer) => number; span: number }, value: T) {
  const data = Buffer.alloc(layout.span);
  layout.encode(value, data);
  return data;
}

type OwnedAccount = {
  account: AccountInfo<Buffer>;
  pubkey: PublicKey;
};

function discoveryConnection(options: {
  balances?: Map<string, number>;
  mintInfos: Map<string, AccountInfo<Buffer>>;
  owned: Map<string, OwnedAccount[]>;
}) {
  return {
    getBalance: vi.fn(async (owner: PublicKey) => options.balances?.get(owner.toBase58()) ?? 0),
    getMultipleAccountsInfo: vi.fn(async (addresses: PublicKey[]) => (
      addresses.map((address) => options.mintInfos.get(address.toBase58()) || null)
    )),
    getTokenAccountsByOwner: vi.fn(async (
      owner: PublicKey,
      filter: { mint: PublicKey } | { programId: PublicKey }
    ) => {
      const ownedAccounts = "programId" in filter
        ? options.owned.get(`${owner.toBase58()}:${filter.programId.toBase58()}`) || []
        : [...options.owned.entries()]
          .filter(([key]) => key.startsWith(`${owner.toBase58()}:`))
          .flatMap(([, accounts]) => accounts)
          .filter(({ account }) => {
            try {
              return AccountLayout.decode(account.data).mint.equals(filter.mint);
            } catch {
              return false;
            }
          });
      return { context: { slot: 10 }, value: ownedAccounts };
    })
  } as unknown as SolanaHoldingsConnection;
}

function readyHolding(options: {
  amount?: bigint;
  decimals?: number;
  mint: PublicKey;
  programId?: PublicKey;
  source: SolCollectionSource;
  tokenAccount: PublicKey;
}): SolTokenAssetHolding {
  const programId = options.programId || TOKEN_PROGRAM_ID;
  const amount = options.amount ?? 1_000n;
  const decimals = options.decimals ?? 2;
  return {
    amount,
    decimals,
    formattedAmount: formatSolTokenAmount(amount, decimals),
    id: `${programId.toBase58()}:${options.tokenAccount.toBase58()}`,
    isAssociated: true,
    isFrozen: false,
    isNative: false,
    label: options.source.label,
    line: options.source.line,
    mintAddress: options.mint.toBase58(),
    mintExtensions: [],
    program: programId.equals(TOKEN_2022_PROGRAM_ID) ? "token-2022" : "spl-token",
    programId: programId.toBase58(),
    sourceAddress: options.source.address,
    sourceTokenAccount: options.tokenAccount.toBase58(),
    status: "ready"
  };
}

function collectionConnection(options: {
  accountInfos: Map<string, AccountInfo<Buffer> | null>;
  balanceLamports?: number;
  confirmError?: unknown | null;
  confirmThrows?: boolean;
  feeLamports?: number | null;
  rentLamports?: number;
  send?: (raw: Uint8Array) => Promise<string>;
}) {
  return {
    confirmTransaction: vi.fn(async () => {
      if (options.confirmThrows) throw new Error("confirmation timed out");
      return { context: { slot: 20 }, value: { err: options.confirmError ?? null } };
    }),
    getAccountInfo: vi.fn(async (address: PublicKey) => (
      options.accountInfos.get(address.toBase58()) ?? null
    )),
    getBalance: vi.fn(async () => options.balanceLamports ?? 3_000_000),
    getEpochInfo: vi.fn(async () => ({ epoch: 4 })),
    getFeeForMessage: vi.fn(async () => ({ context: { slot: 20 }, value: options.feeLamports ?? 5_000 })),
    getLatestBlockhash: vi.fn(async () => ({ blockhash: testBlockhash, lastValidBlockHeight: 100 })),
    getMinimumBalanceForRentExemption: vi.fn(async () => options.rentLamports ?? 2_000_000),
    getMultipleAccountsInfo: vi.fn(),
    getTokenAccountsByOwner: vi.fn(),
    sendRawTransaction: vi.fn(options.send || (async (raw: Uint8Array) => (
      encodeBase58(Transaction.from(raw).signature!)
    )))
  } as unknown as SolTokenCollectionConnection;
}

function makeJobFixture(options: {
  amount?: bigint;
  decimals?: number;
  destination?: Keypair;
  mintIndex?: number;
  programId?: PublicKey;
  sourceIndex?: number;
  tokenAccountIndex?: number;
}) {
  const sourceWallet = source(options.sourceIndex ?? 1);
  const destination = options.destination || keypair(200);
  const mint = keypair(options.mintIndex ?? 100).publicKey;
  const tokenAccount = keypair(options.tokenAccountIndex ?? 50).publicKey;
  const programId = options.programId || TOKEN_PROGRAM_ID;
  const holding = readyHolding({
    amount: options.amount,
    decimals: options.decimals,
    mint,
    programId,
    source: sourceWallet,
    tokenAccount
  });
  const [job] = createSolTokenCollectionJobs({
    destination: destination.publicKey,
    holdings: [holding],
    selectedHoldingIds: new Set([holding.id]),
    sources: [sourceWallet]
  });
  return { destination, holding, job, mint, programId, sourceWallet, tokenAccount };
}

describe("Solana Mint inspection", () => {
  it("inspects classic and Token-2022 Mints independently and fails closed per item", async () => {
    const classicMint = keypair(8_000).publicKey;
    const token2022Mint = keypair(8_001).publicKey;
    const transferHookMint = keypair(8_002).publicKey;
    const missingMint = keypair(8_003).publicKey;
    const wrongOwnerMint = keypair(8_004).publicKey;
    const malformedMint = keypair(8_005).publicKey;
    const infos = new Map<string, AccountInfo<Buffer> | null>([
      [classicMint.toBase58(), accountInfo(mintData({ decimals: 6 }), TOKEN_PROGRAM_ID)],
      [token2022Mint.toBase58(), accountInfo(mintData({ decimals: 9 }), TOKEN_2022_PROGRAM_ID)],
      [transferHookMint.toBase58(), accountInfo(mintData({
        decimals: 2,
        extensions: [{ type: ExtensionType.TransferHook }]
      }), TOKEN_2022_PROGRAM_ID)],
      [missingMint.toBase58(), null],
      [wrongOwnerMint.toBase58(), accountInfo(mintData({}), PublicKey.default)],
      [malformedMint.toBase58(), accountInfo(Buffer.alloc(4), TOKEN_PROGRAM_ID)]
    ]);
    const connection = {
      getMultipleAccountsInfo: vi.fn(async (addresses: PublicKey[]) => (
        addresses.map((address) => infos.get(address.toBase58()) ?? null)
      ))
    };

    const result = await inspectSolTokenMints({
      connection,
      mintAddresses: [
        classicMint.toBase58(),
        token2022Mint,
        transferHookMint,
        missingMint,
        wrongOwnerMint,
        malformedMint,
        classicMint
      ]
    });

    expect(result).toHaveLength(7);
    expect(result[0]).toMatchObject({
      decimals: 6,
      extensions: [],
      mintAddress: classicMint.toBase58(),
      program: "spl-token",
      programId: TOKEN_PROGRAM_ID.toBase58(),
      status: "ready"
    });
    expect(result[1]).toMatchObject({
      decimals: 9,
      extensions: [],
      mintAddress: token2022Mint.toBase58(),
      program: "token-2022",
      programId: TOKEN_2022_PROGRAM_ID.toBase58(),
      status: "ready"
    });
    expect(result[2]).toMatchObject({
      decimals: 2,
      extensions: [ExtensionType.TransferHook],
      program: "token-2022",
      status: "unsupported"
    });
    expect(result[2].unsupportedReason).toContain("TransferHook");
    expect(result[3]).toMatchObject({
      decimals: null,
      mintAddress: missingMint.toBase58(),
      program: null,
      programId: null,
      status: "unverified",
      unsupportedReason: "Mint 账户不存在"
    });
    expect(result[4]).toMatchObject({
      decimals: null,
      program: null,
      programId: PublicKey.default.toBase58(),
      status: "unverified"
    });
    expect(result[4].unsupportedReason).toContain("owner");
    expect(result[5]).toMatchObject({
      decimals: null,
      program: "spl-token",
      programId: TOKEN_PROGRAM_ID.toBase58(),
      status: "unverified"
    });
    expect(result[6]).toEqual(result[0]);
    expect(connection.getMultipleAccountsInfo).toHaveBeenCalledTimes(1);
    expect(connection.getMultipleAccountsInfo.mock.calls[0][0]).toHaveLength(6);
  });

  it("continues later bounded batches when one Mint RPC batch fails", async () => {
    const mintAddresses = Array.from({ length: 101 }, (_, index) => keypair(8_100 + index).publicKey);
    const getMultipleAccountsInfo = vi.fn()
      .mockRejectedValueOnce(new Error("private RPC details must not leak"))
      .mockResolvedValueOnce([accountInfo(mintData({ decimals: 4 }), TOKEN_PROGRAM_ID)]);

    const result = await inspectSolTokenMints({
      connection: { getMultipleAccountsInfo },
      mintAddresses
    });

    expect(getMultipleAccountsInfo.mock.calls.map((call) => call[0].length)).toEqual([100, 1]);
    expect(result.slice(0, 100).every((mint) => (
      mint.status === "unverified" && mint.unsupportedReason === "Mint 信息读取失败，相关持仓不可归集"
    ))).toBe(true);
    expect(result[100]).toMatchObject({
      decimals: 4,
      mintAddress: mintAddresses[100].toBase58(),
      program: "spl-token",
      programId: TOKEN_PROGRAM_ID.toBase58(),
      status: "ready"
    });
    expect(JSON.stringify(result)).not.toContain("private RPC details");
  });

  it("rejects invalid Mint addresses before requesting account data", async () => {
    const connection = { getMultipleAccountsInfo: vi.fn() };

    await expect(inspectSolTokenMints({
      connection,
      mintAddresses: ["invalid-mint"]
    })).rejects.toThrow("mintAddresses[0] 不是有效的 Solana Mint 地址");
    expect(connection.getMultipleAccountsInfo).not.toHaveBeenCalled();
  });
});

describe("Solana holdings discovery", () => {
  it("formats token amounts without Number precision loss", () => {
    expect(formatSolTokenAmount(12_345_678_901_234_567_890n, 9)).toBe("12345678901.23456789");
    expect(formatSolTokenAmount(5n, 9)).toBe("0.000000005");
    expect(formatSolTokenAmount(10_000n, 4)).toBe("1");
  });

  it("scans both token programs and preserves a zero native SOL balance", async () => {
    const owner = source(1);
    const classicMint = keypair(10).publicKey;
    const token2022Mint = keypair(11).publicKey;
    const classicAccount = keypair(12).publicKey;
    const token2022Account = keypair(13).publicKey;
    const owned = new Map<string, OwnedAccount[]>([
      [`${owner.address}:${TOKEN_PROGRAM_ID.toBase58()}`, [{
        account: accountInfo(tokenAccountData({ amount: 1_500_000n, mint: classicMint, owner: owner.keypair.publicKey }), TOKEN_PROGRAM_ID),
        pubkey: classicAccount
      }]],
      [`${owner.address}:${TOKEN_2022_PROGRAM_ID.toBase58()}`, [{
        account: accountInfo(tokenAccountData({ amount: 250n, mint: token2022Mint, owner: owner.keypair.publicKey }), TOKEN_2022_PROGRAM_ID),
        pubkey: token2022Account
      }]]
    ]);
    const connection = discoveryConnection({
      balances: new Map([[owner.address, 0]]),
      mintInfos: new Map([
        [classicMint.toBase58(), accountInfo(mintData({ decimals: 6 }), TOKEN_PROGRAM_ID)],
        [token2022Mint.toBase58(), accountInfo(mintData({ decimals: 2 }), TOKEN_2022_PROGRAM_ID)]
      ]),
      owned
    });

    const result = await discoverSolanaHoldings({ connection, sources: [owner] });

    expect(result.wallets[0]).toMatchObject({
      nativeBalanceLamports: 0n,
      nativeBalanceStatus: "ok",
      status: "ok"
    });
    expect(result.holdings).toMatchObject([
      { amount: 1_500_000n, decimals: 6, formattedAmount: "1.5", program: "spl-token", status: "ready" },
      { amount: 250n, decimals: 2, formattedAmount: "2.5", program: "token-2022", status: "ready" }
    ]);
    expect(connection.getTokenAccountsByOwner).toHaveBeenCalledTimes(2);
    expect(connection.getMultipleAccountsInfo).toHaveBeenCalledTimes(1);
  });

  it("filters classic and Token-2022 accounts by a validated, deduplicated Mint allowlist", async () => {
    const owner = source(101);
    const classicMint = keypair(110).publicKey;
    const token2022Mint = keypair(111).publicKey;
    const unlistedMint = keypair(112).publicKey;
    const classicAccount = keypair(113).publicKey;
    const token2022Account = keypair(114).publicKey;
    const unlistedAccount = keypair(115).publicKey;
    const connection = discoveryConnection({
      balances: new Map([[owner.address, 0]]),
      mintInfos: new Map([
        [classicMint.toBase58(), accountInfo(mintData({ decimals: 6 }), TOKEN_PROGRAM_ID)],
        [token2022Mint.toBase58(), accountInfo(mintData({ decimals: 2 }), TOKEN_2022_PROGRAM_ID)],
        [unlistedMint.toBase58(), accountInfo(mintData({ decimals: 9 }), TOKEN_PROGRAM_ID)]
      ]),
      owned: new Map([
        [`${owner.address}:${TOKEN_PROGRAM_ID.toBase58()}`, [
          {
            account: accountInfo(tokenAccountData({ amount: 1_500_000n, mint: classicMint, owner: owner.keypair.publicKey }), TOKEN_PROGRAM_ID),
            pubkey: classicAccount
          },
          {
            account: accountInfo(tokenAccountData({ amount: 999n, mint: unlistedMint, owner: owner.keypair.publicKey }), TOKEN_PROGRAM_ID),
            pubkey: unlistedAccount
          }
        ]],
        [`${owner.address}:${TOKEN_2022_PROGRAM_ID.toBase58()}`, [{
          account: accountInfo(tokenAccountData({ amount: 250n, mint: token2022Mint, owner: owner.keypair.publicKey }), TOKEN_2022_PROGRAM_ID),
          pubkey: token2022Account
        }]]
      ])
    });

    const result = await discoverSolanaHoldings({
      connection,
      mintAddresses: [classicMint, classicMint.toBase58(), token2022Mint.toBase58()],
      sources: [owner]
    });

    expect(result.wallets[0]).toMatchObject({
      nativeBalanceLamports: 0n,
      nativeBalanceStatus: "ok",
      status: "ok"
    });
    expect(result.holdings.map((holding) => holding.mintAddress)).toEqual([
      classicMint.toBase58(),
      token2022Mint.toBase58()
    ]);
    expect(result).toMatchObject({
      readyTokenAccountCount: 2,
      tokenAccountCount: 2,
      tokenInventoryComplete: true,
      totalNativeBalanceLamports: 0n
    });
    expect(connection.getTokenAccountsByOwner).toHaveBeenCalledTimes(2);
    expect(vi.mocked(connection.getTokenAccountsByOwner).mock.calls.map((call) => (
      "mint" in call[1] ? call[1].mint.toBase58() : "program-query"
    ))).toEqual([classicMint.toBase58(), token2022Mint.toBase58()]);
    expect(connection.getMultipleAccountsInfo).toHaveBeenCalledWith(
      [classicMint, token2022Mint],
      "confirmed"
    );
  });

  it("returns only native SOL for an empty Mint allowlist without querying Token Programs", async () => {
    const owner = source(102);
    const connection = discoveryConnection({
      balances: new Map([[owner.address, 0]]),
      mintInfos: new Map(),
      owned: new Map()
    });
    vi.mocked(connection.getTokenAccountsByOwner).mockRejectedValue(new Error("Token RPC unavailable"));

    const result = await discoverSolanaHoldings({
      connection,
      mintAddresses: [],
      sources: [owner]
    });

    expect(result).toMatchObject({
      holdings: [],
      partial: false,
      readyTokenAccountCount: 0,
      tokenAccountCount: 0,
      tokenInventoryComplete: true,
      totalNativeBalanceLamports: 0n
    });
    expect(result.wallets[0]).toMatchObject({
      nativeBalanceLamports: 0n,
      nativeBalanceStatus: "ok",
      status: "ok",
      tokenAccounts: [],
      tokenInventoryStatus: "complete"
    });
    expect(connection.getBalance).toHaveBeenCalledTimes(1);
    expect(connection.getTokenAccountsByOwner).not.toHaveBeenCalled();
    expect(connection.getMultipleAccountsInfo).not.toHaveBeenCalled();
  });

  it("bounds per-wallet Mint queries when the allowlist is large", async () => {
    const owner = source(104);
    const mintAddresses = Array.from({ length: 25 }, (_, index) => keypair(6_000 + index).publicKey);
    const connection = discoveryConnection({
      balances: new Map([[owner.address, 0]]),
      mintInfos: new Map(),
      owned: new Map()
    });
    let activeQueries = 0;
    let maximumActiveQueries = 0;
    vi.mocked(connection.getTokenAccountsByOwner).mockImplementation(async () => {
      activeQueries += 1;
      maximumActiveQueries = Math.max(maximumActiveQueries, activeQueries);
      await new Promise((resolve) => setTimeout(resolve, 1));
      activeQueries -= 1;
      return { context: { slot: 10 }, value: [] } as never;
    });

    const result = await discoverSolanaHoldings({
      connection,
      mintAddresses,
      sources: [owner]
    });

    expect(result.tokenInventoryComplete).toBe(true);
    expect(connection.getTokenAccountsByOwner).toHaveBeenCalledTimes(25);
    expect(maximumActiveQueries).toBe(10);
  });

  it("rejects an invalid Mint allowlist before making RPC requests", async () => {
    const owner = source(103);
    const connection = discoveryConnection({
      mintInfos: new Map(),
      owned: new Map()
    });

    await expect(discoverSolanaHoldings({
      connection,
      mintAddresses: ["not-a-solana-mint"],
      sources: [owner]
    })).rejects.toThrow("mintAddresses[0] 不是有效的 Solana Mint 地址");
    expect(connection.getBalance).not.toHaveBeenCalled();
    expect(connection.getTokenAccountsByOwner).not.toHaveBeenCalled();
  });

  it("keeps token holdings when native SOL reading fails and marks the wallet partial", async () => {
    const owner = source(2);
    const mint = keypair(20).publicKey;
    const tokenAccount = keypair(21).publicKey;
    const connection = discoveryConnection({
      mintInfos: new Map([[mint.toBase58(), accountInfo(mintData({}), TOKEN_PROGRAM_ID)]]),
      owned: new Map([[`${owner.address}:${TOKEN_PROGRAM_ID.toBase58()}`, [{
        account: accountInfo(tokenAccountData({ amount: 1n, mint, owner: owner.keypair.publicKey }), TOKEN_PROGRAM_ID),
        pubkey: tokenAccount
      }]]]),
      balances: new Map()
    });
    vi.mocked(connection.getBalance).mockRejectedValueOnce(new Error("network secret should not leak"));

    const result = await discoverSolanaHoldings({ connection, sources: [owner] });

    expect(result.wallets[0]).toMatchObject({
      nativeBalanceLamports: null,
      nativeBalanceStatus: "error",
      status: "partial",
      tokenInventoryStatus: "complete"
    });
    expect(result.tokenInventoryComplete).toBe(true);
    expect(result.holdings).toHaveLength(1);
    expect(JSON.stringify(result, (_, value) => typeof value === "bigint" ? value.toString() : value))
      .not.toContain("network secret");
  });

  it("marks the Token inventory incomplete when either Token Program query fails", async () => {
    const owner = source(20);
    const mint = keypair(520).publicKey;
    const tokenAccount = keypair(521).publicKey;
    const connection = discoveryConnection({
      mintInfos: new Map([[mint.toBase58(), accountInfo(mintData({}), TOKEN_PROGRAM_ID)]]),
      owned: new Map([[`${owner.address}:${TOKEN_PROGRAM_ID.toBase58()}`, [{
        account: accountInfo(tokenAccountData({ amount: 1n, mint, owner: owner.keypair.publicKey }), TOKEN_PROGRAM_ID),
        pubkey: tokenAccount
      }]]])
    });
    vi.mocked(connection.getTokenAccountsByOwner).mockImplementation(async (queriedOwner, filter) => {
      if ("programId" in filter && filter.programId.equals(TOKEN_2022_PROGRAM_ID)) {
        throw new Error("token-2022 RPC failed");
      }
      return {
        context: { slot: 10 },
        value: queriedOwner.equals(owner.keypair.publicKey)
          ? [{
            account: accountInfo(tokenAccountData({ amount: 1n, mint, owner: owner.keypair.publicKey }), TOKEN_PROGRAM_ID),
            pubkey: tokenAccount
          }]
          : []
      } as never;
    });

    const result = await discoverSolanaHoldings({ connection, sources: [owner] });

    expect(result.holdings).toHaveLength(1);
    expect(result).toMatchObject({ partial: true, tokenInventoryComplete: false });
    expect(result.wallets[0]).toMatchObject({
      status: "partial",
      tokenInventoryStatus: "partial"
    });
  });

  it("loads unique mint accounts in bounded batches", async () => {
    const owner = source(3);
    const ownedAccounts: OwnedAccount[] = [];
    const mintInfos = new Map<string, AccountInfo<Buffer>>();
    for (let index = 0; index < 101; index += 1) {
      const mint = keypair(1_000 + index).publicKey;
      const tokenAccount = keypair(2_000 + index).publicKey;
      mintInfos.set(mint.toBase58(), accountInfo(mintData({}), TOKEN_PROGRAM_ID));
      ownedAccounts.push({
        account: accountInfo(tokenAccountData({ amount: 1n, mint, owner: owner.keypair.publicKey }), TOKEN_PROGRAM_ID),
        pubkey: tokenAccount
      });
    }
    const connection = discoveryConnection({
      mintInfos,
      owned: new Map([[`${owner.address}:${TOKEN_PROGRAM_ID.toBase58()}`, ownedAccounts]])
    });

    const result = await discoverSolanaHoldings({ connection, sources: [owner] });

    expect(result.holdings).toHaveLength(101);
    expect(vi.mocked(connection.getMultipleAccountsInfo).mock.calls.map((call) => call[0].length)).toEqual([100, 1]);
  });

  it("fails closed for frozen and dangerous or unknown Token-2022 extensions", async () => {
    const owner = source(4);
    const cases = [
      { accountFrozen: true, extension: undefined, reason: "冻结" },
      { extension: ExtensionType.NonTransferable, reason: "NonTransferable" },
      { extension: ExtensionType.TransferHook, reason: "TransferHook" },
      { extension: ExtensionType.ConfidentialTransferMint, reason: "ConfidentialTransfer" },
      { extension: ExtensionType.InterestBearingConfig, reason: "InterestBearing" },
      { extension: ExtensionType.ScaledUiAmountConfig, reason: "ScaledUiAmount" },
      { extension: 65_000, reason: "无法识别" }
    ];
    const ownedAccounts: OwnedAccount[] = [];
    const mintInfos = new Map<string, AccountInfo<Buffer>>();
    cases.forEach((item, index) => {
      const mint = keypair(3_000 + index).publicKey;
      const tokenAccount = keypair(4_000 + index).publicKey;
      mintInfos.set(mint.toBase58(), accountInfo(mintData({
        extensions: item.extension === undefined ? [] : [{ type: item.extension }]
      }), TOKEN_2022_PROGRAM_ID));
      ownedAccounts.push({
        account: accountInfo(tokenAccountData({
          amount: 10n,
          frozen: item.accountFrozen,
          mint,
          owner: owner.keypair.publicKey
        }), TOKEN_2022_PROGRAM_ID),
        pubkey: tokenAccount
      });
    });
    const pausedMint = keypair(3_100).publicKey;
    const pausedAccount = keypair(4_100).publicKey;
    const pausedData = encodedExtension(PausableConfigLayout, {
      authority: keypair(99).publicKey,
      paused: true
    });
    mintInfos.set(pausedMint.toBase58(), accountInfo(mintData({
      extensions: [{ data: pausedData, type: ExtensionType.PausableConfig }]
    }), TOKEN_2022_PROGRAM_ID));
    ownedAccounts.push({
      account: accountInfo(tokenAccountData({ amount: 10n, mint: pausedMint, owner: owner.keypair.publicKey }), TOKEN_2022_PROGRAM_ID),
      pubkey: pausedAccount
    });
    const connection = discoveryConnection({
      mintInfos,
      owned: new Map([[`${owner.address}:${TOKEN_2022_PROGRAM_ID.toBase58()}`, ownedAccounts]])
    });

    const result = await discoverSolanaHoldings({ connection, sources: [owner] });

    expect(result.holdings).toHaveLength(cases.length + 1);
    cases.forEach((item, index) => {
      expect(result.holdings[index]).toMatchObject({ status: "unsupported" });
      expect(result.holdings[index].unsupportedReason).toContain(item.reason);
    });
    expect(result.holdings.at(-1)).toMatchObject({ status: "unsupported" });
    expect(result.holdings.at(-1)?.unsupportedReason).toContain("暂停");
  });
});

describe("SPL Token collection", () => {
  it("creates only explicitly selected ready jobs and excludes the destination ATA itself", () => {
    const sourceWallet = source(5);
    const destination = sourceWallet.keypair.publicKey;
    const firstMint = keypair(500).publicKey;
    const secondMint = keypair(501).publicKey;
    const destinationAta = getAssociatedTokenAddressSync(firstMint, destination);
    const secondAccount = keypair(502).publicKey;
    const first = readyHolding({ mint: firstMint, source: sourceWallet, tokenAccount: destinationAta });
    const second = readyHolding({ mint: secondMint, source: sourceWallet, tokenAccount: secondAccount });

    const jobs = createSolTokenCollectionJobs({
      destination,
      holdings: [first, second],
      selectedHoldingIds: new Set([first.id, second.id]),
      sources: [sourceWallet]
    });

    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe(second.id);
  });

  it("keeps every selected Token Account for the same Mint and deduplicates only the same account", () => {
    const sourceWallet = source(19);
    const destination = keypair(519).publicKey;
    const mint = keypair(520).publicKey;
    const first = readyHolding({
      mint,
      source: sourceWallet,
      tokenAccount: keypair(521).publicKey
    });
    const second = readyHolding({
      mint,
      source: sourceWallet,
      tokenAccount: keypair(522).publicKey
    });

    const jobs = createSolTokenCollectionJobs({
      destination,
      holdings: [first, second, { ...first }],
      selectedHoldingIds: new Set([first.id, second.id]),
      sources: [sourceWallet]
    });

    expect(jobs.map((job) => job.id)).toEqual([first.id, second.id]);
    expect(jobs.every((job) => job.mintAddress === mint.toBase58())).toBe(true);
  });

  it("rejects a selected holding whose identity does not match its Token Account", () => {
    const sourceWallet = source(17);
    const holding = readyHolding({
      mint: keypair(510).publicKey,
      source: sourceWallet,
      tokenAccount: keypair(511).publicKey
    });
    const forged = { ...holding, id: `${holding.programId}:${keypair(512).publicKey.toBase58()}` };

    expect(() => createSolTokenCollectionJobs({
      destination: keypair(513).publicKey,
      holdings: [forged],
      selectedHoldingIds: new Set([forged.id]),
      sources: [sourceWallet]
    })).toThrow("Token 持仓标识不一致");
  });

  it("rejects a forged job identity before reading or signing", async () => {
    const fixture = makeJobFixture({ sourceIndex: 18 });
    const connection = collectionConnection({ accountInfos: new Map() });

    const [result] = await collectSolTokenJobs({
      connection,
      jobs: [{ ...fixture.job, id: "forged-job-id" }]
    });

    expect(result).toMatchObject({
      message: "Token 任务标识不一致，请重新识别持仓",
      retryable: true,
      status: "error"
    });
    expect(connection.getAccountInfo).not.toHaveBeenCalled();
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("rechecks that the destination owner is on curve before signing", async () => {
    const fixture = makeJobFixture({ sourceIndex: 16 });
    const [offCurveDestination] = PublicKey.findProgramAddressSync(
      [Buffer.from("collection-target")],
      TOKEN_PROGRAM_ID
    );
    const unsafeJob: SolTokenCollectionJob = {
      ...fixture.job,
      destinationAddress: offCurveDestination.toBase58(),
      destinationTokenAccount: getAssociatedTokenAddressSync(
        fixture.mint,
        offCurveDestination,
        true,
        fixture.programId
      ).toBase58()
    };
    const connection = collectionConnection({ accountInfos: new Map() });

    const [result] = await collectSolTokenJobs({ connection, jobs: [unsafeJob] });

    expect(result).toMatchObject({
      message: "SPL Token 归集目标必须是可签名的钱包地址",
      retryable: true,
      status: "error",
      uncertain: false
    });
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("creates an ATA idempotently, checks rent plus fee, transfers the full live balance and forces RPC preflight", async () => {
    const fixture = makeJobFixture({ amount: 12_345n, decimals: 3 });
    const infos = new Map<string, AccountInfo<Buffer> | null>([
      [fixture.tokenAccount.toBase58(), accountInfo(tokenAccountData({
        amount: 20_000n,
        mint: fixture.mint,
        owner: fixture.sourceWallet.keypair.publicKey
      }), fixture.programId)],
      [fixture.mint.toBase58(), accountInfo(mintData({ decimals: 3 }), fixture.programId)],
      [fixture.job.destinationTokenAccount, null]
    ]);
    let submitted: Transaction | undefined;
    const connection = collectionConnection({
      accountInfos: infos,
      balanceLamports: 2_005_000,
      send: async (raw) => {
        submitted = Transaction.from(raw);
        return encodeBase58(submitted.signature!);
      }
    });

    const [result] = await collectSolTokenJobs({
      connection,
      jobs: [fixture.job],
      sendOptions: { skipPreflight: true }
    });

    expect(result).toMatchObject({
      amount: 20_000n,
      ataRentLamports: 2_000_000n,
      decimals: 3,
      feeLamports: 5_000n,
      receivedAmount: 20_000n,
      status: "success",
      transferFeeAmount: 0n
    });
    expect(submitted?.instructions).toHaveLength(2);
    expect(submitted?.instructions[0].programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    const transfer = decodeTransferCheckedInstruction(submitted!.instructions[1], TOKEN_PROGRAM_ID);
    expect(transfer.data).toMatchObject({ amount: 20_000n, decimals: 3 });
    expect(connection.sendRawTransaction).toHaveBeenCalledWith(expect.any(Uint8Array), expect.objectContaining({
      skipPreflight: false
    }));
  });

  it("does not budget rent or recreate an ATA that existed at read time", async () => {
    const fixture = makeJobFixture({ sourceIndex: 6 });
    const destinationAta = new PublicKey(fixture.job.destinationTokenAccount);
    const infos = new Map<string, AccountInfo<Buffer> | null>([
      [fixture.tokenAccount.toBase58(), accountInfo(tokenAccountData({
        amount: fixture.job.amount,
        mint: fixture.mint,
        owner: fixture.sourceWallet.keypair.publicKey
      }), fixture.programId)],
      [fixture.mint.toBase58(), accountInfo(mintData({ decimals: fixture.job.decimals }), fixture.programId)],
      [destinationAta.toBase58(), accountInfo(tokenAccountData({
        amount: 0n,
        mint: fixture.mint,
        owner: fixture.destination.publicKey
      }), fixture.programId)]
    ]);
    let submitted: Transaction | undefined;
    const connection = collectionConnection({
      accountInfos: infos,
      balanceLamports: 5_000,
      send: async (raw) => {
        submitted = Transaction.from(raw);
        return encodeBase58(submitted.signature!);
      }
    });

    const [result] = await collectSolTokenJobs({ connection, jobs: [fixture.job] });

    expect(result).toMatchObject({ ataRentLamports: 0n, status: "success" });
    expect(submitted?.instructions).toHaveLength(1);
    expect(submitted?.instructions[0].programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(connection.getMinimumBalanceForRentExemption).not.toHaveBeenCalled();
  });

  it("uses TransferCheckedWithFee and reports the expected Token-2022 net amount", async () => {
    const fixture = makeJobFixture({
      amount: 1_000n,
      decimals: 2,
      programId: TOKEN_2022_PROGRAM_ID,
      sourceIndex: 7
    });
    const feeConfig = encodedExtension(TransferFeeConfigLayout, {
      newerTransferFee: { epoch: 4n, maximumFee: 100n, transferFeeBasisPoints: 100 },
      olderTransferFee: { epoch: 0n, maximumFee: 100n, transferFeeBasisPoints: 50 },
      transferFeeConfigAuthority: PublicKey.default,
      withheldAmount: 0n,
      withdrawWithheldAuthority: PublicKey.default
    });
    const infos = new Map<string, AccountInfo<Buffer> | null>([
      [fixture.tokenAccount.toBase58(), accountInfo(tokenAccountData({
        amount: 1_000n,
        mint: fixture.mint,
        owner: fixture.sourceWallet.keypair.publicKey
      }), TOKEN_2022_PROGRAM_ID)],
      [fixture.mint.toBase58(), accountInfo(mintData({
        decimals: 2,
        extensions: [{ data: feeConfig, type: ExtensionType.TransferFeeConfig }]
      }), TOKEN_2022_PROGRAM_ID)],
      [fixture.job.destinationTokenAccount, null]
    ]);
    let submitted: Transaction | undefined;
    const connection = collectionConnection({
      accountInfos: infos,
      send: async (raw) => {
        submitted = Transaction.from(raw);
        return encodeBase58(submitted.signature!);
      }
    });

    const [result] = await collectSolTokenJobs({ connection, jobs: [fixture.job] });

    expect(result).toMatchObject({
      amount: 1_000n,
      receivedAmount: 990n,
      status: "success",
      transferFeeAmount: 10n
    });
    expect(connection.getMinimumBalanceForRentExemption).toHaveBeenCalledWith(
      getAccountLen([ExtensionType.TransferFeeAmount, ExtensionType.ImmutableOwner]),
      "confirmed"
    );
    const transfer = decodeTransferCheckedWithFeeInstruction(
      submitted!.instructions[1],
      TOKEN_2022_PROGRAM_ID
    );
    expect(transfer.data).toMatchObject({ amount: 1_000n, decimals: 2, fee: 10n });
  });

  it("fails closed when a destination Token-2022 ATA requires Memo", async () => {
    const fixture = makeJobFixture({ programId: TOKEN_2022_PROGRAM_ID, sourceIndex: 8 });
    const memo = encodedExtension(MemoTransferLayout, { requireIncomingTransferMemos: true });
    const infos = new Map<string, AccountInfo<Buffer> | null>([
      [fixture.tokenAccount.toBase58(), accountInfo(tokenAccountData({
        amount: fixture.job.amount,
        mint: fixture.mint,
        owner: fixture.sourceWallet.keypair.publicKey
      }), TOKEN_2022_PROGRAM_ID)],
      [fixture.mint.toBase58(), accountInfo(mintData({ decimals: fixture.job.decimals }), TOKEN_2022_PROGRAM_ID)],
      [fixture.job.destinationTokenAccount, accountInfo(tokenAccountData({
        amount: 0n,
        extensions: [{ data: memo, type: ExtensionType.MemoTransfer }],
        mint: fixture.mint,
        owner: fixture.destination.publicKey
      }), TOKEN_2022_PROGRAM_ID)]
    ]);
    const connection = collectionConnection({ accountInfos: infos });

    const [result] = await collectSolTokenJobs({ connection, jobs: [fixture.job] });

    expect(result).toMatchObject({
      message: expect.stringContaining("Memo"),
      reason: "unsupported-token",
      status: "skipped"
    });
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("skips before signing when native SOL cannot cover ATA rent and network fee", async () => {
    const fixture = makeJobFixture({ sourceIndex: 9 });
    const infos = new Map<string, AccountInfo<Buffer> | null>([
      [fixture.tokenAccount.toBase58(), accountInfo(tokenAccountData({
        amount: fixture.job.amount,
        mint: fixture.mint,
        owner: fixture.sourceWallet.keypair.publicKey
      }), fixture.programId)],
      [fixture.mint.toBase58(), accountInfo(mintData({ decimals: fixture.job.decimals }), fixture.programId)],
      [fixture.job.destinationTokenAccount, null]
    ]);
    const connection = collectionConnection({ accountInfos: infos, balanceLamports: 2_004_999 });

    const [result] = await collectSolTokenJobs({ connection, jobs: [fixture.job] });

    expect(result).toMatchObject({
      nativeBalanceLamports: 2_004_999n,
      reason: "insufficient-native-balance",
      receivedAmount: 0n,
      status: "skipped"
    });
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("serializes jobs from one source while allowing different sources to run concurrently", async () => {
    const destination = keypair(220);
    const fixtures = [
      makeJobFixture({ destination, mintIndex: 600, sourceIndex: 10, tokenAccountIndex: 700 }),
      makeJobFixture({ destination, mintIndex: 601, sourceIndex: 10, tokenAccountIndex: 701 }),
      makeJobFixture({ destination, mintIndex: 602, sourceIndex: 11, tokenAccountIndex: 702 }),
      makeJobFixture({ destination, mintIndex: 603, sourceIndex: 11, tokenAccountIndex: 703 })
    ];
    const infos = new Map<string, AccountInfo<Buffer> | null>();
    fixtures.forEach((fixture) => {
      infos.set(fixture.tokenAccount.toBase58(), accountInfo(tokenAccountData({
        amount: fixture.job.amount,
        mint: fixture.mint,
        owner: fixture.sourceWallet.keypair.publicKey
      }), fixture.programId));
      infos.set(fixture.mint.toBase58(), accountInfo(mintData({ decimals: fixture.job.decimals }), fixture.programId));
      infos.set(fixture.job.destinationTokenAccount, accountInfo(tokenAccountData({
        amount: 0n,
        mint: fixture.mint,
        owner: destination.publicKey
      }), fixture.programId));
    });
    const activeBySource = new Map<string, number>();
    let maximumTotalActive = 0;
    let totalActive = 0;
    let releaseFirstPair!: () => void;
    const firstPair = new Promise<void>((resolve) => { releaseFirstPair = resolve; });
    const connection = collectionConnection({
      accountInfos: infos,
      send: async (raw) => {
        const transaction = Transaction.from(raw);
        const address = transaction.feePayer!.toBase58();
        activeBySource.set(address, (activeBySource.get(address) || 0) + 1);
        totalActive += 1;
        maximumTotalActive = Math.max(maximumTotalActive, totalActive);
        expect(activeBySource.get(address)).toBe(1);
        if (totalActive === 2) releaseFirstPair();
        await firstPair;
        await Promise.resolve();
        activeBySource.set(address, activeBySource.get(address)! - 1);
        totalActive -= 1;
        return encodeBase58(transaction.signature!);
      }
    });

    const results = await collectSolTokenJobs({
      connection,
      executionSettings: { concurrency: 2 },
      jobs: fixtures.map((fixture) => fixture.job)
    });

    expect(results.every((result) => result.status === "success")).toBe(true);
    expect(maximumTotalActive).toBe(2);
  });

  it("retains the local signature and forbids blind retry when RPC returns a different signature", async () => {
    const fixture = makeJobFixture({ sourceIndex: 12 });
    const infos = new Map<string, AccountInfo<Buffer> | null>([
      [fixture.tokenAccount.toBase58(), accountInfo(tokenAccountData({
        amount: fixture.job.amount,
        mint: fixture.mint,
        owner: fixture.sourceWallet.keypair.publicKey
      }), fixture.programId)],
      [fixture.mint.toBase58(), accountInfo(mintData({ decimals: fixture.job.decimals }), fixture.programId)],
      [fixture.job.destinationTokenAccount, null]
    ]);
    const connection = collectionConnection({
      accountInfos: infos,
      send: async () => keypair(999).publicKey.toBase58()
    });

    const [result] = await collectSolTokenJobs({ connection, jobs: [fixture.job] });

    expect(result).toMatchObject({
      retryable: false,
      signature: expect.any(String),
      status: "error",
      uncertain: true
    });
    expect(connection.confirmTransaction).not.toHaveBeenCalled();
  });

  it("treats an explicit RPC preflight rejection as unbroadcast and safely retryable", async () => {
    const fixture = makeJobFixture({ sourceIndex: 19 });
    const infos = new Map<string, AccountInfo<Buffer> | null>([
      [fixture.tokenAccount.toBase58(), accountInfo(tokenAccountData({
        amount: fixture.job.amount,
        mint: fixture.mint,
        owner: fixture.sourceWallet.keypair.publicKey
      }), fixture.programId)],
      [fixture.mint.toBase58(), accountInfo(mintData({ decimals: fixture.job.decimals }), fixture.programId)],
      [fixture.job.destinationTokenAccount, null]
    ]);
    const connection = collectionConnection({
      accountInfos: infos,
      send: async () => { throw new Error("Transaction simulation failed: custom program error"); }
    });

    const [result] = await collectSolTokenJobs({ connection, jobs: [fixture.job] });

    expect(result).toMatchObject({
      message: expect.stringContaining("未广播"),
      receivedAmount: 0n,
      retryable: true,
      status: "error",
      uncertain: false
    });
    expect(result.signature).toBeUndefined();
    expect(connection.confirmTransaction).not.toHaveBeenCalled();
  });

  it("distinguishes a confirmed chain failure from an uncertain confirmation timeout", async () => {
    const makeInfos = (fixture: ReturnType<typeof makeJobFixture>) => new Map<string, AccountInfo<Buffer> | null>([
      [fixture.tokenAccount.toBase58(), accountInfo(tokenAccountData({
        amount: fixture.job.amount,
        mint: fixture.mint,
        owner: fixture.sourceWallet.keypair.publicKey
      }), fixture.programId)],
      [fixture.mint.toBase58(), accountInfo(mintData({ decimals: fixture.job.decimals }), fixture.programId)],
      [fixture.job.destinationTokenAccount, null]
    ]);
    const failedFixture = makeJobFixture({ sourceIndex: 13 });
    const failedConnection = collectionConnection({
      accountInfos: makeInfos(failedFixture),
      confirmError: { InstructionError: [1, "Custom"] }
    });
    const timeoutFixture = makeJobFixture({ sourceIndex: 14 });
    const timeoutConnection = collectionConnection({
      accountInfos: makeInfos(timeoutFixture),
      confirmThrows: true
    });

    const [failed] = await collectSolTokenJobs({ connection: failedConnection, jobs: [failedFixture.job] });
    const [timeout] = await collectSolTokenJobs({ connection: timeoutConnection, jobs: [timeoutFixture.job] });

    expect(failed).toMatchObject({ receivedAmount: 0n, retryable: true, status: "error", uncertain: false });
    expect(timeout).toMatchObject({ receivedAmount: 0n, retryable: false, status: "error", uncertain: true });
  });

  it("returns a safe mint-missing error without signing or broadcasting", async () => {
    const fixture = makeJobFixture({ sourceIndex: 15 });
    const infos = new Map<string, AccountInfo<Buffer> | null>([
      [fixture.tokenAccount.toBase58(), accountInfo(tokenAccountData({
        amount: fixture.job.amount,
        mint: fixture.mint,
        owner: fixture.sourceWallet.keypair.publicKey
      }), fixture.programId)],
      [fixture.mint.toBase58(), null]
    ]);
    const connection = collectionConnection({ accountInfos: infos });

    const [result] = await collectSolTokenJobs({ connection, jobs: [fixture.job] });

    expect(result).toMatchObject({
      message: "Mint 不存在或已关闭，请重新识别持仓",
      retryable: true,
      status: "error",
      uncertain: false
    });
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });
});
