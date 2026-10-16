import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CollectionPauseController } from './collection-execution';
import { prepareAutomaticEvmCollection } from './automatic-evm-collection';
import type { EvmCollectionPlanItem } from './evm-collection';
import { executeAutomaticCollection } from './collection-orchestrator';
import { createCollectionResultsCsv, type CollectionDisplayResult } from './collection-results';
import { inspectNftContract } from './nft-contract-inspection';

const mocks = vi.hoisted(() => ({ inventory: vi.fn(), plan: vi.fn(), execute: vi.fn(), network: vi.fn(), send: vi.fn(), write: vi.fn(),
  publicClient: { getBalance: vi.fn(), getBlockNumber: vi.fn(), readContract: vi.fn() } }));
vi.mock('viem', async original => ({ ...await original<typeof import('viem')>(), createWalletClient: () => ({ sendTransaction: mocks.send, writeContract: mocks.write }) }));
vi.mock('./evm', async original => ({ ...await original<typeof import('./evm')>(), createEvmPublicClient: () => mocks.publicClient, assertEvmRpcNetwork: mocks.network }));
vi.mock('./evm-wallet-inventory', async original => ({ ...await original<typeof import('./evm-wallet-inventory')>(), discoverEvmWalletInventory: mocks.inventory }));
vi.mock('./evm-collection', async original => ({ ...await original<typeof import('./evm-collection')>(), parseEvmPrivateKeyInput: () => ({ accounts: [{ address: source, label: '来源', line: 1, account: { address: source } }], invalid: 0, issues: [] }), planEvmCollection: mocks.plan, executeEvmCollectionPlan: mocks.execute }));
const source = '0x1111111111111111111111111111111111111111';
const target = '0x2222222222222222222222222222222222222222';
const token = { standard: 'erc20' as const, contractAddress: '0x3333333333333333333333333333333333333333' as const, key: 'erc20:token' };
const nft = { standard: 'erc721' as const, contractAddress: '0x4444444444444444444444444444444444444444' as const, tokenId: 900719925474099312345n, key: 'nft:id' };
const network = { id: 'ethereum' as const, label: 'Ethereum', chainId: 1, rpcEndpoint: 'https://rpc.example', blockExplorerUrl: 'https://example.com', disperseContractAddress: target as `0x${string}`, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } };
const item = (asset: EvmCollectionPlanItem['asset']): EvmCollectionPlanItem => ({ account: { address: source } as never, address: source, amount: asset.standard === 'native' ? 100000000000000000n : 123456789012345678901n, asset, id: asset.key, label: '来源', status: 'ready', message: '已核验', ...(asset.standard === 'erc20' ? { metadata: { contractAddress: token.contractAddress, decimals: 18, symbol: 'ABC', name: 'ABC' } } : {}) });
function prepare(signal: AbortSignal) { return prepareAutomaticEvmCollection({ keys: 'test-only-placeholder', network, rpcEndpoint: network.rpcEndpoint, targetAddress: target, indexer: 'https://eth.blockscout.com', signal, maxFeePerTransactionWei: 10000000000000000n }); }

beforeEach(() => {
  vi.resetAllMocks(); mocks.network.mockResolvedValue(undefined); mocks.inventory.mockResolvedValue({ assets: [token, nft], complete: true, issues: [] });
  mocks.plan.mockImplementation(async ({ assets }) => assets.map(item));
  mocks.execute.mockImplementation(async ({ plan }) => [{ ...plan[0], hash: null, retryable: false, status: 'success' }]);
});
describe('automatic EVM collection adapter', () => {
  it('scan is read-only, keeps exact quantities and creates distinct Token/NFT/native stages', async () => {
    const [wallet] = await prepare(new AbortController().signal);
    expect(wallet.complete).toBe(true); expect(wallet.tasks.map(task => task.phase)).toEqual(['token', 'nft', 'native']);
    expect(wallet.tasks[0].holding?.raw).toBe(123456789012345678901n); expect(wallet.tasks[0].preview.amount).toBe('123.456789012345678901');
    expect(wallet.tasks[1].preview.asset).toContain(nft.tokenId.toString()); expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('publishes a completed wallet preview without starting any writes', async () => {
    const onScanProgress = vi.fn();
    const wallets = await prepareAutomaticEvmCollection({ keys: 'test-only-placeholder', network, rpcEndpoint: network.rpcEndpoint, targetAddress: target, indexer: 'https://eth.blockscout.com', signal: new AbortController().signal, maxFeePerTransactionWei: 1n, onScanProgress });
    expect(onScanProgress).toHaveBeenCalledWith({ completed: 1, total: 1, wallet: wallets[0] });
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('shows the same contract name and symbol as manual confirmation and shares reads across token IDs', async () => {
    const core = await vi.importActual<typeof import('./evm-collection')>('./evm-collection');
    mocks.plan.mockImplementation(core.planEvmCollection);
    mocks.inventory.mockResolvedValue({ assets: [nft, { ...nft, tokenId: nft.tokenId + 1n, key: 'nft:second-id' }], complete: true, issues: [] });
    mocks.publicClient.getBalance.mockResolvedValue(0n);
    mocks.publicClient.getBlockNumber.mockResolvedValue(100n);
    mocks.publicClient.readContract.mockImplementation(async ({ functionName, args }) => {
      if (functionName === 'name') return 'Example Collectibles';
      if (functionName === 'symbol') return 'EXNFT';
      if (functionName === 'ownerOf') return source;
      return args?.[0] === '0x01ffc9a7' || args?.[0] === '0x80ac58cd';
    });
    const manual = await inspectNftContract({ contractAddress: nft.contractAddress, publicClient: mocks.publicClient as never });
    mocks.publicClient.readContract.mockClear();

    const [wallet] = await prepare(new AbortController().signal);
    expect(wallet.tasks.filter(task => task.phase === 'nft').map(task => task.holding)).toEqual([
      expect.objectContaining({ name: manual.name, symbol: manual.symbol, raw: 1n }),
      expect.objectContaining({ name: manual.name, symbol: manual.symbol, raw: 1n })
    ]);
    expect(wallet.tasks[0].preview.asset).toBe(`ERC721 #${nft.tokenId}`);
    expect(mocks.publicClient.readContract.mock.calls.filter(([request]) => request.functionName === 'name')).toHaveLength(1);
    expect(mocks.publicClient.readContract.mock.calls.filter(([request]) => request.functionName === 'symbol')).toHaveLength(1);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('exports complete NFT identities through progress, shared ERC1155 hashes, skips and different networks', async () => {
    const assets = [
      nft,
      { ...nft, contractAddress: token.contractAddress, key: 'other-contract:same-id' },
      { ...nft, standard: 'erc1155' as const, key: 'erc1155:first' },
      { ...nft, standard: 'erc1155' as const, tokenId: nft.tokenId + 1n, key: 'erc1155:second' }
    ];
    mocks.inventory.mockResolvedValue({ assets, complete: true, issues: [] });
    mocks.execute.mockImplementation(async ({ plan, onProgress }) => {
      const current = plan[0];
      const hash = `0x${(current.asset.standard === 'erc1155' ? 'b' : 'a').repeat(64)}`;
      const result = { ...current, amount: current.asset.standard === 'erc1155' ? 3n : 1n, hash, retryable: false, status: 'success', message: '归集成功' };
      onProgress({ ...result, stage: 'confirming' });
      return [result];
    });
    const signal = new AbortController().signal;
    const wallets = await prepare(signal);
    const progress: CollectionDisplayResult[] = [];
    const results = await executeAutomaticCollection({ wallets, includeNative: false, signal,
      pauseControl: new CollectionPauseController(), onResult: (_, result) => progress.push(result) });
    for (const result of [...progress, ...results]) {
      expect(result).toMatchObject({ chainId: 1, networkId: 'ethereum', sourceAddress: source, targetAddress: target });
      expect(result.contractAddress).toBeTruthy();
      expect(result.tokenId).toMatch(/^\d+$/);
    }
    const csv = createCollectionResultsCsv(results).split('\r\n').map(row => row.split(','));
    const rows = csv.slice(1).map(values => Object.fromEntries(csv[0].map((column, index) => [column, values[index]])));
    expect(rows.map(row => [row.contract_address, row.token_standard, row.token_id, row.amount])).toEqual([
      [nft.contractAddress, 'erc721', nft.tokenId.toString(), '1'],
      [token.contractAddress, 'erc721', nft.tokenId.toString(), '1'],
      [nft.contractAddress, 'erc1155', nft.tokenId.toString(), '3'],
      [nft.contractAddress, 'erc1155', (nft.tokenId + 1n).toString(), '3']
    ]);
    expect(rows.every(row => row.chain_id === '1' && row.source_address === source && row.target_address === target)).toBe(true);
    expect(rows[2].transaction_hash).toBe(rows[3].transaction_hash);
    expect(rows.every(row => row.explorer_url === `https://example.com/tx/${row.transaction_hash}`)).toBe(true);

    const baseNetwork = { ...network, id: 'baseSepolia' as const, chainId: 84532, label: 'Base Sepolia', blockExplorerUrl: 'https://sepolia.basescan.org' };
    const otherWallets = await prepareAutomaticEvmCollection({ keys: 'test-only-placeholder', network: baseNetwork,
      rpcEndpoint: network.rpcEndpoint, targetAddress: target, indexer: 'https://base-sepolia.blockscout.com', signal, maxFeePerTransactionWei: 1n });
    const skipped = await executeAutomaticCollection({ wallets: otherWallets, includeNative: false, selectedTaskIds: new Set(),
      signal, pauseControl: new CollectionPauseController() });
    expect(skipped).toHaveLength(4);
    expect(skipped.every(result => result.chainId === 84532 && result.status === 'skipped' && result.targetAddress === target)).toBe(true);
    expect(skipped[0]).toMatchObject({ contractAddress: nft.contractAddress, tokenId: nft.tokenId.toString(), tokenStandard: 'erc721' });
  });
  it('failed ownership reads retain their source and unknown quantity rather than claiming no assets', async () => {
    mocks.plan.mockImplementation(async ({ assets }) => [{ ...item(assets[0]), account: null, address: null, amount: 0n, status: 'failed', message: '读取失败' }]);
    const [wallet] = await prepare(new AbortController().signal);
    expect(wallet.complete).toBe(false); expect(wallet.native?.raw).toBeNull();
    expect(wallet.tasks[1].preview.address).toBe(source); expect(wallet.tasks[1].holding?.raw).toBeNull(); expect(wallet.tasks[1].preview.amount).toBeUndefined();
  });
  it('verifies fresh discovered assets as well as original candidates before allowing native sweep', async () => {
    const [wallet] = await prepare(new AbortController().signal);
    mocks.inventory.mockResolvedValue({ assets: [], complete: true, issues: [] });
    expect(await wallet.verifyEmpty()).toBe(false);
    mocks.plan.mockImplementation(async ({ assets }) => [{ ...item(assets[0]), amount: 0n, status: 'skipped' }]);
    expect(await wallet.verifyEmpty()).toBe(true);
    mocks.inventory.mockResolvedValue({ assets: [], complete: false, issues: ['限流'] }); expect(await wallet.verifyEmpty()).toBe(false);
  });
  it('uses the existing runner with the configured fee cap and preserves uncertain transaction hashes', async () => {
    const [wallet] = await prepare(new AbortController().signal);
    mocks.execute.mockResolvedValue([{ ...item(token), amount: 10n, status: 'failed', hash: '0xhash', uncertain: true, retryable: false, message: '待核对' }]);
    const result = await wallet.tasks[0].execute(vi.fn(), new CollectionPauseController());
    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({ maxFeePerTransactionWei: 10000000000000000n, targetAddress: target }));
    expect(result).toMatchObject({ hash: '0xhash', uncertain: true, retryable: false, status: 'error' });
  });
  it('replans a zero native scan after the wallet receives gas rather than reusing a skipped task', async () => {
    mocks.plan.mockImplementation(async ({ assets }) => [{ ...item(assets[0]), ...(assets[0].standard === 'native' ? { amount: 0n, status: 'skipped' } : {}) }]);
    const [wallet] = await prepare(new AbortController().signal);
    expect(wallet.tasks.find(task => task.phase === 'native')?.preview.status).toBe('skipped');
    mocks.plan.mockImplementation(async ({ assets }) => assets.map(item));
    await wallet.tasks.find(task => task.phase === 'native')!.execute(vi.fn(), new CollectionPauseController());
    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({ plan: [expect.objectContaining({ amount: 100000000000000000n, status: 'ready' })] }));
  });
  it('rejects cancellation during the final native balance read', async () => {
    const abort = new AbortController();
    mocks.plan.mockImplementation(async ({ assets }) => { if (assets[0].standard === 'native') abort.abort(); return assets.map(item); });
    await expect(prepare(abort.signal)).rejects.toThrow('操作已停止');
  });
  it.each(['abort', 'network'])('rechecks %s at the actual send boundary, including after transaction preparation', async reason => {
    const abort = new AbortController(); const [wallet] = await prepare(abort.signal);
    mocks.execute.mockImplementation(async ({ getWalletClient, plan }) => {
      const client = getWalletClient(plan[0].account);
      if (reason === 'abort') abort.abort(); else mocks.network.mockRejectedValue(new Error('网络变更'));
      await client.sendTransaction({ gas: 21_000n, gasPrice: 1n }); return [];
    });
    await expect(wallet.tasks[0].execute(vi.fn(), new CollectionPauseController())).rejects.toThrow(reason === 'abort' ? '操作已停止' : '网络变更');
    expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled();
  });
});
