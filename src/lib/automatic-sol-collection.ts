import { Connection, PublicKey, type SendOptions } from "@solana/web3.js";
import { assertAutomaticOperationActive, type AutomaticCollectionTask, type AutomaticCollectionWallet } from "./collection-orchestrator";
import { type CollectionPauseControl } from "./collection-execution";
import { type CollectionDisplayResult } from "./collection-results";
import { collectSolFromSources, parseSolanaSourceKeys } from "./sol-collection";
import {
  collectSolTokenJobs,
  createSolTokenCollectionJobs,
  discoverSolanaHoldings,
  type SolTokenAssetHolding,
  type SolTokenCollectionProgress
} from "./sol-token-collection";
import { assertSolanaRpcNetwork, getExplorerUrl, type SolanaNetworkId } from "./solana";
import { formatWalletAssetAmount, type WalletAssetHolding } from "./wallet-asset-overview";

function describeHolding(holding: SolTokenAssetHolding): WalletAssetHolding {
  return {
    kind: holding.decimals === 0 && holding.amount === 1n ? "nft" : "token",
    key: holding.mintAddress,
    address: holding.mintAddress,
    symbol: null,
    raw: holding.amount,
    decimals: holding.decimals
  };
}

function progressStatus(phase: SolTokenCollectionProgress["phase"]): CollectionDisplayResult["status"] {
  return phase === "submitted" ? "confirming" : phase === "preparing" ? "submitting" : phase;
}

/** The final send boundary also checks cancellation and the RPC's genesis hash. */
function guardedConnection(connection: Connection, networkId: SolanaNetworkId, signal: AbortSignal, control: CollectionPauseControl) {
  return new Proxy(connection, {
    get(target, property) {
      if (property === "sendRawTransaction") return async (raw: Uint8Array, options?: SendOptions) => {
        assertAutomaticOperationActive(signal);
        await control.waitUntilResumed();
        assertAutomaticOperationActive(signal);
        await assertSolanaRpcNetwork(connection, networkId);
        assertAutomaticOperationActive(signal);
        return connection.sendRawTransaction(raw, options);
      };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

export async function prepareAutomaticSolCollection({
  keys, networkId, rpcEndpoint, targetAddress, signal
}: {
  keys: string;
  networkId: SolanaNetworkId;
  rpcEndpoint: string;
  targetAddress: string;
  signal: AbortSignal;
}): Promise<AutomaticCollectionWallet[]> {
  assertAutomaticOperationActive(signal);
  const parsed = parseSolanaSourceKeys(keys);
  if (parsed.errors.length || !parsed.sources.length) throw new Error(parsed.errors[0]?.message || "请先导入来源钱包");
  if (parsed.sources.length > 1_000) throw new Error("一键归集最多支持 1,000 个来源钱包");
  const destination = new PublicKey(targetAddress.trim());
  if (!PublicKey.isOnCurve(destination.toBytes())) throw new Error("归集目标必须是可签名的钱包地址");
  const destinationAddress = destination.toBase58();
  const sources = parsed.sources.filter((source) => source.address !== destinationAddress);
  if (!sources.length) throw new Error("来源钱包与接收地址相同，请选择其他来源钱包");
  const connection = new Connection(rpcEndpoint.trim(), "confirmed");
  await assertSolanaRpcNetwork(connection, networkId);
  assertAutomaticOperationActive(signal);
  // No Mint filter: read every SPL and Token-2022 token account.
  const scan = await discoverSolanaHoldings({ connection, sources });
  assertAutomaticOperationActive(signal);
  const jobs = createSolTokenCollectionJobs({
    destination, holdings: scan.holdings,
    selectedHoldingIds: new Set(scan.holdings.filter((holding) => holding.amount > 0n).map((holding) => holding.id)),
    sources
  });
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const scanByAddress = new Map(scan.wallets.map((wallet) => [wallet.address, wallet]));
  const prepareWrite = async (control: CollectionPauseControl) => {
    assertAutomaticOperationActive(signal);
    await control.waitUntilResumed();
    assertAutomaticOperationActive(signal);
    await assertSolanaRpcNetwork(connection, networkId);
    assertAutomaticOperationActive(signal);
  };
  return sources.map((source): AutomaticCollectionWallet => {
    const scanned = scanByAddress.get(source.address);
    const holdings = scanned?.tokenAccounts || scan.holdings.filter((holding) => holding.sourceAddress === source.address);
    const tasks: AutomaticCollectionTask[] = holdings.filter((holding) => holding.amount > 0n).map((holding) => {
      const assetHolding = describeHolding(holding);
      const job = jobsById.get(holding.id);
      const id = `sol:${source.address}:${holding.id}`;
      const unavailable = !job || holding.status !== "ready";
      const preview: CollectionDisplayResult = {
        address: source.address,
        amount: formatWalletAssetAmount(holding.amount, holding.decimals),
        asset: `${assetHolding.kind === "nft" ? "NFT" : "Token"} ${holding.mintAddress}`,
        assetKey: `${holding.programId}:${holding.mintAddress}`,
        executionId: id,
        label: source.label,
        message: unavailable ? holding.unsupportedReason || "资产状态未验证，无法自动转移" : "待归集",
        status: unavailable ? "error" : "pending",
        retryable: false,
        phase: assetHolding.kind
      };
      return {
        id, phase: assetHolding.kind, preview, holding: assetHolding,
        async execute(progress, control) {
          assertAutomaticOperationActive(signal);
          if (unavailable || !job) return preview;
          await prepareWrite(control);
          const [result] = await collectSolTokenJobs({
            connection: guardedConnection(connection, networkId, signal, control),
            jobs: [job], pauseControl: control, fallbackFeeLamports: null,
            onProgress(value) {
              progress({
                ...preview, amount: formatWalletAssetAmount(value.amount, value.decimals),
                status: progressStatus(value.phase),
                message: value.phase === "submitted" ? "交易已提交，等待确认" : value.phase === "preparing" ? "正在校验并转移资产" : preview.message,
                ...(value.signature ? { hash: value.signature, explorerUrl: getExplorerUrl(value.signature, networkId) } : {})
              });
            }
          });
          if (!result) throw new Error("资产归集未返回执行结果");
          const feeSuffix = result.status === "success" && result.transferFeeAmount > 0n
            ? `；预计到账 ${formatWalletAssetAmount(result.receivedAmount, result.decimals)}，Token 费 ${formatWalletAssetAmount(result.transferFeeAmount, result.decimals)}` : "";
          return {
            ...preview, amount: formatWalletAssetAmount(result.amount, result.decimals),
            status: result.status, message: `${result.message}${feeSuffix}`,
            retryable: result.retryable, uncertain: result.uncertain,
            ...(result.signature ? { hash: result.signature, explorerUrl: getExplorerUrl(result.signature, networkId) } : {})
          };
        }
      };
    });
    const nativePreview: CollectionDisplayResult = {
      address: source.address, amount: formatWalletAssetAmount(scanned?.nativeBalanceLamports ?? null, 9),
      asset: "SOL", assetKey: "native:SOL", executionId: `sol:${source.address}:native`,
      label: source.label, message: "在 Token / NFT 完成后读取最新余额", status: "pending", phase: "native"
    };
    tasks.push({
      id: nativePreview.executionId!, phase: "native", preview: nativePreview,
      async execute(progress, control) {
        await prepareWrite(control);
        const [result] = await collectSolFromSources({
          connection: guardedConnection(connection, networkId, signal, control), destination,
          sources: [source], amountPolicy: { mode: "all" }, minCollectionLamports: 0n, reserveLamports: 0n,
          fallbackFeeLamports: null, pauseControl: control,
          onProgress(value) {
            progress({ ...nativePreview, amount: formatWalletAssetAmount(value.transferLamports, 9),
              status: progressStatus(value.phase), message: value.phase === "submitted" ? "SOL 已提交，等待确认" : "读取最新 SOL 余额并扣除手续费",
              ...(value.signature ? { hash: value.signature, explorerUrl: getExplorerUrl(value.signature, networkId) } : {}) });
          }
        });
        if (!result) throw new Error("SOL 归集未返回执行结果");
        return { ...nativePreview, amount: formatWalletAssetAmount(result.transferLamports, 9),
          message: result.message, status: result.status, retryable: result.retryable,
          uncertain: result.status === "error" && Boolean(result.signature) && !result.retryable,
          ...(result.signature ? { hash: result.signature, explorerUrl: getExplorerUrl(result.signature, networkId) } : {}) };
      }
    });
    return {
      address: source.address,
      complete: Boolean(scanned && scanned.status === "ok" && scanned.tokenInventoryStatus === "complete" && scanned.nativeBalanceStatus === "ok"),
      issues: scanned?.issues || ["钱包扫描结果缺失"],
      native: { symbol: "SOL", raw: scanned?.nativeBalanceLamports ?? null, decimals: 9 },
      tasks,
      async verifyEmpty() {
        assertAutomaticOperationActive(signal);
        await assertSolanaRpcNetwork(connection, networkId);
        assertAutomaticOperationActive(signal);
        const fresh = await discoverSolanaHoldings({ connection, sources: [source] });
        assertAutomaticOperationActive(signal);
        return !fresh.partial && fresh.tokenInventoryComplete && fresh.wallets.length === 1
          && fresh.wallets[0].status === "ok" && fresh.wallets[0].tokenInventoryStatus === "complete"
          && fresh.holdings.every((holding) => holding.amount === 0n);
      }
    };
  });
}
