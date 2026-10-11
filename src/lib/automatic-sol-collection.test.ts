import { Keypair } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CollectionPauseController } from "./collection-execution";
import { executeAutomaticCollection } from "./collection-orchestrator";
import { prepareAutomaticSolCollection } from "./automatic-sol-collection";
import { collectSolFromSources } from "./sol-collection";
import { collectSolTokenJobs, discoverSolanaHoldings, type SolanaHoldingsResult, type SolTokenAssetHolding } from "./sol-token-collection";
import { buildWalletAssetOverview } from "./wallet-asset-overview";

const connectionMethods = vi.hoisted(() => ({
  getGenesisHash: vi.fn(),
  sendRawTransaction: vi.fn()
}));
vi.mock("@solana/web3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solana/web3.js")>();
  return { ...actual, Connection: class {
    getGenesisHash = connectionMethods.getGenesisHash;
    sendRawTransaction = connectionMethods.sendRawTransaction;
  } };
});
vi.mock("./sol-token-collection", async (importOriginal) => ({
  ...await importOriginal<typeof import("./sol-token-collection")>(),
  collectSolTokenJobs: vi.fn(), discoverSolanaHoldings: vi.fn()
}));
vi.mock("./sol-collection", async (importOriginal) => ({
  ...await importOriginal<typeof import("./sol-collection")>(), collectSolFromSources: vi.fn()
}));

const source = Keypair.fromSeed(new Uint8Array(32).fill(41));
const target = Keypair.fromSeed(new Uint8Array(32).fill(42));
const mint = Keypair.fromSeed(new Uint8Array(32).fill(43)).publicKey.toBase58();
const address = source.publicKey.toBase58();
const endpoint = "https://api.devnet.solana.com";
const genesis = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const keys = JSON.stringify([...source.secretKey]);
const prepare = (signal = new AbortController().signal) => prepareAutomaticSolCollection({ keys, networkId: "devnet", rpcEndpoint: endpoint, targetAddress: target.publicKey.toBase58(), signal });

function holding(index: number, overrides: Partial<SolTokenAssetHolding> = {}): SolTokenAssetHolding {
  const account = Keypair.fromSeed(new Uint8Array(32).fill(50 + index)).publicKey.toBase58();
  return {
    amount: 100n, decimals: 6, formattedAmount: "0.0001", id: `${TOKEN_PROGRAM_ID.toBase58()}:${account}`,
    isAssociated: false, isFrozen: false, isNative: false, line: 1, mintAddress: mint, mintExtensions: [],
    program: "spl-token", programId: TOKEN_PROGRAM_ID.toBase58(), sourceAddress: address,
    sourceTokenAccount: account, status: "ready", ...overrides
  };
}

function scan(holdings: SolTokenAssetHolding[], complete = true): SolanaHoldingsResult {
  return {
    holdings, issues: complete ? [] : ["Token-2022 读取失败"], partial: !complete,
    readyTokenAccountCount: holdings.filter((item) => item.status === "ready").length,
    tokenInventoryComplete: complete, tokenAccountCount: holdings.length, totalNativeBalanceLamports: 1_000_000_000n,
    wallets: [{ address, line: 1, issues: complete ? [] : ["Token-2022 读取失败"], nativeBalanceLamports: 1_000_000_000n,
      nativeBalanceStatus: "ok", status: complete ? "ok" : "partial", tokenInventoryStatus: complete ? "complete" : "partial", tokenAccounts: holdings }]
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  connectionMethods.getGenesisHash.mockResolvedValue(genesis);
  connectionMethods.sendRawTransaction.mockResolvedValue("sig");
  vi.mocked(discoverSolanaHoldings).mockReset();
  vi.mocked(collectSolTokenJobs).mockReset();
  vi.mocked(collectSolFromSources).mockReset();
  vi.mocked(collectSolTokenJobs).mockImplementation(async ({ jobs }) => jobs.map((job) => ({
    amount: job.amount, decimals: job.decimals, destinationAddress: job.destinationAddress, destinationTokenAccount: job.destinationTokenAccount,
    id: job.id, mintAddress: job.mintAddress, program: job.program, programId: job.programId,
    sourceAddress: job.sourceAddress, sourceTokenAccount: job.sourceTokenAccount,
    ataRentLamports: 0n, feeLamports: 5_000n, nativeBalanceLamports: 1_000_000_000n,
    receivedAmount: job.amount, transferFeeAmount: 0n, message: "归集成功", retryable: false, signature: "token-sig", status: "success", uncertain: false
  })));
  vi.mocked(collectSolFromSources).mockResolvedValue([{ address, balanceLamports: 123_456n, feeLamports: 5_000n, line: 1,
    message: "归集成功", reserveLamports: 0n, retryable: false, signature: "native-sig", status: "success", transferLamports: 118_456n }]);
});

describe("automatic Solana collection adapter", () => {
  it("scans all token programs without a Mint filter or any writes", async () => {
    vi.mocked(discoverSolanaHoldings).mockResolvedValue(scan([holding(1)]));
    const wallets = await prepare();
    const options = vi.mocked(discoverSolanaHoldings).mock.calls[0][0];
    expect(options.mintAddresses).toBeUndefined();
    expect(options.sources.map((item) => item.address)).toEqual([address]);
    expect(wallets[0].tasks.map((task) => task.phase)).toEqual(["token", "native"]);
    expect(collectSolTokenJobs).not.toHaveBeenCalled();
    expect(collectSolFromSources).not.toHaveBeenCalled();
    expect(connectionMethods.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("executes same-Mint accounts separately, NFT next, then verifies before fresh all-SOL collection", async () => {
    const nftAccount = Keypair.fromSeed(new Uint8Array(32).fill(61)).publicKey.toBase58();
    const nft = holding(3, { amount: 1n, decimals: 0, mintAddress: Keypair.fromSeed(new Uint8Array(32).fill(62)).publicKey.toBase58(),
      program: "token-2022", programId: TOKEN_2022_PROGRAM_ID.toBase58(), id: `${TOKEN_2022_PROGRAM_ID.toBase58()}:${nftAccount}`, sourceTokenAccount: nftAccount });
    vi.mocked(discoverSolanaHoldings).mockResolvedValueOnce(scan([holding(1), holding(2), nft])).mockResolvedValueOnce(scan([]));
    const signal = new AbortController().signal;
    const wallets = await prepare(signal);
    const overview = buildWalletAssetOverview({ complete: true, native: wallets[0].native, holdings: wallets[0].tasks.flatMap((task) => task.holding ? [task.holding] : []) });
    expect(overview.tokens).toHaveLength(1);
    expect(overview.tokens[0].raw).toBe(200n);
    expect(overview.nfts).toHaveLength(1);
    const phases: string[] = [];
    const results = await executeAutomaticCollection({ wallets, includeNative: true, signal, pauseControl: new CollectionPauseController(), onPhase: (phase) => phases.push(phase) });
    expect(phases).toEqual(["token", "nft", "native"]);
    expect(vi.mocked(collectSolTokenJobs).mock.calls.map(([options]) => options.jobs[0].sourceTokenAccount)).toEqual([holding(1).sourceTokenAccount, holding(2).sourceTokenAccount, nftAccount]);
    expect(collectSolFromSources).toHaveBeenCalledWith(expect.objectContaining({ amountPolicy: { mode: "all" }, reserveLamports: 0n, minCollectionLamports: 0n, fallbackFeeLamports: null }));
    expect(discoverSolanaHoldings).toHaveBeenCalledTimes(2);
    expect(results.at(-1)?.amount).toBe("0.000118456");
    expect(results.every((result) => result.status === "success")).toBe(true);
  });

  it("never executes native or rechecks holdings with the native option off", async () => {
    vi.mocked(discoverSolanaHoldings).mockResolvedValue(scan([holding(1)]));
    const signal = new AbortController().signal;
    await executeAutomaticCollection({ wallets: await prepare(signal), includeNative: false, signal, pauseControl: new CollectionPauseController() });
    expect(collectSolFromSources).not.toHaveBeenCalled();
    expect(discoverSolanaHoldings).toHaveBeenCalledTimes(1);
  });

  it.each(["partial", "unsupported", "remaining", "partial-recheck"] as const)("preserves native SOL after %s assets", async (condition) => {
    const asset = holding(1, condition === "unsupported" ? { status: "unsupported", isFrozen: true, unsupportedReason: "Token 账户已冻结" } : {});
    vi.mocked(discoverSolanaHoldings).mockResolvedValueOnce(scan([asset], condition !== "partial"))
      .mockResolvedValueOnce(condition === "partial-recheck" ? scan([], false) : scan([asset]));
    const signal = new AbortController().signal;
    const results = await executeAutomaticCollection({ wallets: await prepare(signal), includeNative: true, signal, pauseControl: new CollectionPauseController() });
    expect(collectSolFromSources).not.toHaveBeenCalled();
    expect(results.at(-1)?.status).toBe("skipped");
    expect(results.at(-1)?.message).toContain("保留原生币");
    if (condition === "unsupported") expect(collectSolTokenJobs).not.toHaveBeenCalled();
  });

  it("checks cancellation again at the actual send boundary", async () => {
    vi.mocked(discoverSolanaHoldings).mockResolvedValue(scan([holding(1)]));
    const controller = new AbortController();
    const wallets = await prepare(controller.signal);
    vi.mocked(collectSolTokenJobs).mockImplementationOnce(async ({ connection }) => {
      controller.abort();
      await connection.sendRawTransaction(new Uint8Array([1]));
      return [];
    });
    await expect(wallets[0].tasks[0].execute(() => {}, new CollectionPauseController())).rejects.toMatchObject({ name: "AbortError" });
    expect(connectionMethods.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("rechecks the RPC network at the actual send boundary", async () => {
    vi.mocked(discoverSolanaHoldings).mockResolvedValue(scan([holding(1)]));
    const wallets = await prepare();
    vi.mocked(collectSolTokenJobs).mockImplementationOnce(async ({ connection }) => {
      connectionMethods.getGenesisHash.mockResolvedValue("wrong-network");
      await connection.sendRawTransaction(new Uint8Array([1]));
      return [];
    });
    await expect(wallets[0].tasks[0].execute(() => {}, new CollectionPauseController())).rejects.toThrow("RPC 网络不匹配");
    expect(connectionMethods.sendRawTransaction).not.toHaveBeenCalled();
  });
});
