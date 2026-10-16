import { formatUnits, getAddress, http, isAddress, zeroAddress } from 'viem';
import { createEvmLocalWalletClient } from './evm-local-wallet';
import { createEvmPublicClient, assertEvmRpcNetwork, toEvmChain, getEvmExplorerUrl, isEvmNativeCurrencyEnabled, type EvmNetworkConfig } from './evm';
import { parseEvmPrivateKeyInput, planEvmCollection, executeEvmCollectionPlan, evmNativeCollectionAsset, type EvmCollectionPlanItem } from './evm-collection';
import { autoEvmGasSettings, type EvmGasSettings } from './evm-gas';
import { mapWithCollectionConcurrency } from './collection-execution';
import { createInventoryBudget, discoverEvmWalletInventory } from './evm-wallet-inventory';
import { assertAutomaticOperationActive, type AutomaticCollectionScanProgress, type AutomaticCollectionTask, type AutomaticCollectionWallet } from './collection-orchestrator';
import { getEvmCollectionAssetContext, type CollectionDisplayResult } from './collection-results';
import { createNftContractMetadataReader } from './nft-contract-inspection';

export async function prepareAutomaticEvmCollection({ keys, network, rpcEndpoint, targetAddress, indexer, signal, maxFeePerTransactionWei, gasSettings = autoEvmGasSettings, onScanProgress }: {
  keys: string; network: EvmNetworkConfig; rpcEndpoint: string; targetAddress: string; indexer: string; signal: AbortSignal;
  maxFeePerTransactionWei: bigint; gasSettings?: EvmGasSettings;
  onScanProgress?: (progress: AutomaticCollectionScanProgress) => void;
}): Promise<AutomaticCollectionWallet[]> {
  if (!isAddress(targetAddress) || getAddress(targetAddress) === zeroAddress) throw new Error('请输入有效目标地址');
  if (!isEvmNativeCurrencyEnabled(network)) throw new Error('请先确认该网络的原生币信息');
  if (maxFeePerTransactionWei <= 0n) throw new Error('单笔最高网络费必须大于 0');
  const parsed = parseEvmPrivateKeyInput(keys);
  if (parsed.invalid || parsed.issues.some(issue => issue.code === 'input-limit')) throw new Error('来源私钥清单包含无效项目或超出上限，请修正后扫描');
  const accounts = parsed.accounts.filter(source => source.address.toLowerCase() !== targetAddress.toLowerCase());
  if (!accounts.length) throw new Error('没有可归集的来源钱包，目标地址不能作为来源');
  const client = createEvmPublicClient(network, rpcEndpoint); await assertEvmRpcNetwork(client, network);
  const readNftMetadata = createNftContractMetadataReader(client);
  assertAutomaticOperationActive(signal); const budget = createInventoryBudget(); let completed = 0;
  return mapWithCollectionConcurrency(accounts, 3, async source => {
    const inventory = await discoverEvmWalletInventory({ address: source.address, chainId: network.chainId, indexer, signal, budget });
    const issues = [...inventory.issues]; let complete = inventory.complete;
    const tasks: AutomaticCollectionTask[] = []; let native: AutomaticCollectionWallet['native'] = null;
    for (const asset of [...inventory.assets, evmNativeCollectionAsset]) {
      assertAutomaticOperationActive(signal);
      const [readItem] = await planEvmCollection({ accounts: [source], assets: [asset], publicClient: client, readNftMetadata });
      assertAutomaticOperationActive(signal);
      const item: EvmCollectionPlanItem = { ...readItem, address: source.address, label: source.label };
      if (item.status === 'failed') { complete = false; issues.push(item.message); }
      const isNative = asset.standard === 'native';
      if (isNative) native = { symbol: network.nativeCurrency.symbol, decimals: network.nativeCurrency.decimals, raw: item.status === 'failed' ? null : item.amount };
      if (!isNative && item.status === 'skipped') continue;
      const decimals = isNative ? network.nativeCurrency.decimals : asset.standard === 'erc20' ? item.metadata?.decimals ?? null : 0;
      const symbol = isNative ? network.nativeCurrency.symbol : asset.standard === 'erc20'
        ? item.metadata?.symbol || `${asset.contractAddress.slice(0, 6)}…${asset.contractAddress.slice(-4)}`
        : `${asset.standard.toUpperCase()} #${asset.tokenId}`;
      const id = `${source.address.toLowerCase()}:${asset.key}`;
      const phase = isNative ? 'native' : asset.standard === 'erc20' ? 'token' : 'nft';
      const preview: CollectionDisplayResult = { address: source.address, sourceAddress: source.address,
        chainId: network.chainId, networkId: network.id, targetAddress, ...getEvmCollectionAssetContext(asset),
        label: source.label, asset: symbol, assetKey: asset.key, executionId: id, phase,
        amount: decimals === null || item.status === 'failed' ? undefined : formatUnits(item.amount, decimals),
        message: item.message, status: item.status === 'failed' ? 'error' : item.status === 'skipped' ? 'skipped' : 'pending' };
      tasks.push({ id, phase, preview, holding: isNative ? undefined : {
        kind: phase === 'token' ? 'token' : 'nft', key: asset.key, address: asset.contractAddress, symbol: item.metadata?.symbol || null,
        raw: item.status === 'failed' ? null : item.amount, decimals, name: item.metadata?.name, tokenStandard: asset.standard,
        ...('tokenId' in asset ? { tokenId: asset.tokenId.toString() } : {})
      }, async execute(progress, control) {
        await control.waitUntilResumed(); await assertEvmRpcNetwork(client, network); assertAutomaticOperationActive(signal);
        const [liveItem] = await planEvmCollection({ accounts: [source], assets: [asset], publicClient: client, readNftMetadata });
        assertAutomaticOperationActive(signal);
        const [result] = await executeEvmCollectionPlan({ plan: [{ ...liveItem, address: source.address, label: source.label }], publicClient: client, targetAddress, maxFeePerTransactionWei, gasSettings, pauseControl: control,
          getWalletClient: account => {
            const beforeSend = async () => { await control.waitUntilResumed(); await assertEvmRpcNetwork(client, network); assertAutomaticOperationActive(signal); };
            return createEvmLocalWalletClient({ account, chain: toEvmChain(network, rpcEndpoint), transport: http(rpcEndpoint), beforeSign: beforeSend });
          },
          onProgress(event) { progress({ ...preview, hash: event.hash || undefined, explorerUrl: event.hash ? getEvmExplorerUrl(event.hash, network) : undefined,
            amount: decimals === null ? undefined : formatUnits(event.amount, decimals), message: event.message,
            status: event.stage === 'failed' ? 'error' : event.stage === 'success' ? 'success' : event.stage === 'skipped' ? 'skipped' : event.stage === 'confirming' ? 'confirming' : 'submitting' }); }
        });
        return { ...preview, amount: decimals === null ? undefined : formatUnits(result.amount, decimals), message: result.message, hash: result.hash || undefined,
          explorerUrl: result.hash ? getEvmExplorerUrl(result.hash, network) : undefined, retryable: result.retryable, uncertain: result.uncertain,
          status: result.status === 'failed' ? 'error' : result.status };
      } });
    }
    const wallet: AutomaticCollectionWallet = { address: source.address, complete, issues, native, tasks, async verifyEmpty() {
      assertAutomaticOperationActive(signal); await assertEvmRpcNetwork(client, network);
      const fresh = await discoverEvmWalletInventory({ address: source.address, chainId: network.chainId, indexer, signal });
      if (!fresh.complete) return false;
      // Include the original candidates too: an indexer's delayed deletion cannot hide a failed transfer.
      const assets = [...new Map([...inventory.assets, ...fresh.assets].map(asset => [asset.key, asset])).values()];
      for (const asset of assets) {
        assertAutomaticOperationActive(signal);
        const checked = await planEvmCollection({ accounts: [source], assets: [asset], publicClient: client, readNftMetadata });
        if (checked.some(item => item.status === 'failed' || item.status === 'ready' && item.amount > 0n)) return false;
      }
      return true;
    } };
    assertAutomaticOperationActive(signal);
    onScanProgress?.({ completed: ++completed, total: accounts.length, wallet });
    return wallet;
  });
}
