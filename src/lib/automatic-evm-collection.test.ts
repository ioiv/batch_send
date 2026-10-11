import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CollectionPauseController } from './collection-execution';
import { prepareAutomaticEvmCollection } from './automatic-evm-collection';
import type { EvmCollectionPlanItem } from './evm-collection';

const mocks = vi.hoisted(() => ({ inventory: vi.fn(), plan: vi.fn(), execute: vi.fn(), network: vi.fn(), send: vi.fn(), write: vi.fn() }));
vi.mock('viem', async original => ({ ...await original<typeof import('viem')>(), createWalletClient: () => ({ sendTransaction: mocks.send, writeContract: mocks.write }) }));
vi.mock('./evm', async original => ({ ...await original<typeof import('./evm')>(), createEvmPublicClient: () => ({}), assertEvmRpcNetwork: mocks.network }));
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
      await client.sendTransaction({}); return [];
    });
    await expect(wallet.tasks[0].execute(vi.fn(), new CollectionPauseController())).rejects.toThrow();
    expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled();
  });
});
