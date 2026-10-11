import { getAddress, isAddress, zeroAddress, type Address } from 'viem';
import type { EvmCollectionAsset } from './evm-collection';
import { assertAutomaticOperationActive } from './collection-orchestrator';

const indexers: Record<number, string> = {
  1: 'https://eth.blockscout.com', 10: 'https://optimism.blockscout.com',
  100: 'https://gnosis.blockscout.com', 8453: 'https://base.blockscout.com',
  42161: 'https://arbitrum.blockscout.com', 11155111: 'https://eth-sepolia.blockscout.com',
  84532: 'https://base-sepolia.blockscout.com'
};
export function getAutomaticEvmIndexer(chainId: number) { return indexers[chainId] || ''; }
export function normalizeAutomaticIndexer(value: string) {
  const url = new URL(value.trim());
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('资产索引节点需要是不含凭据或参数的 HTTP(S) 地址');
  return url.href.replace(/\/$/, '').replace(/\/api\/v2$/, '');
}
export type EvmWalletInventory = { assets: EvmCollectionAsset[]; complete: boolean; issues: string[] };
type InventoryBudget = { requests: number; assets: number };
export function createInventoryBudget(): InventoryBudget { return { requests: 0, assets: 0 }; }
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function uint(value: unknown) {
  if (typeof value !== 'string' || !/^\d{1,78}$/.test(value)) throw new Error('索引返回了无法校验的资产数量或 Token ID');
  const parsed = BigInt(value); if (parsed >= 2n ** 256n) throw new Error('索引资产数值超出范围');
  return parsed;
}

/** Indexer discovers candidates only. The adapter reads ownership and quantities from the selected RPC. */
export async function discoverEvmWalletInventory({ address, chainId, indexer, signal, budget = createInventoryBudget(), fetcher = fetch }: {
  address: Address; chainId: number; indexer: string; signal: AbortSignal;
  budget?: InventoryBudget; fetcher?: typeof fetch;
}): Promise<EvmWalletInventory> {
  const base = normalizeAutomaticIndexer(indexer);
  const assets = new Map<string, EvmCollectionAsset>(); const issues: string[] = [];
  // Custom hosts can return a different chain's empty inventory. They never authorize native sweeping.
  if (base !== indexers[chainId]) issues.push('自定义索引节点的网络无法自动核验，本钱包将保留原生币');
  for (const [path, type] of [['tokens', 'ERC-20'], ['nft', 'ERC-721,ERC-1155']] as const) {
    let cursor: Record<string, unknown> | null = {}; const seen = new Set<string>();
    try {
      for (let page = 0; cursor; page++) {
        assertAutomaticOperationActive(signal);
        if (page >= 100 || ++budget.requests > 500) throw new Error('扫描达到分页或请求上限，清单可能不完整');
        const url = new URL(`${base}/api/v2/addresses/${address}/${path}`); url.searchParams.set('type', type);
        for (const [key, value] of Object.entries(cursor)) {
          if (key === 'type' || !['string', 'number', 'boolean'].includes(typeof value)) throw new Error('索引分页参数无效');
          url.searchParams.set(key, String(value));
        }
        if (seen.has(url.href)) throw new Error('索引分页重复，已停止扫描'); seen.add(url.href);
        const response = await fetcher(url.href, { credentials: 'omit', signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]), headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(response.status === 429 ? '资产索引节点限流，请稍后重试' : `资产索引请求失败 (${response.status})`);
        const body: unknown = await response.json();
        assertAutomaticOperationActive(signal);
        if (!record(body) || !Array.isArray(body.items) || !Object.hasOwn(body, 'next_page_params')) throw new Error('资产索引响应不完整');
        for (const item of body.items) {
          if (!record(item) || !record(item.token)) throw new Error('资产索引条目无效');
          const token = item.token;
          const contract = token.address_hash;
          if (typeof contract !== 'string' || !isAddress(contract) || getAddress(contract) === zeroAddress) throw new Error('资产索引合约地址无效');
          const contractAddress = getAddress(contract); let asset: EvmCollectionAsset;
          if (path === 'tokens') {
            if (token.type !== 'ERC-20') throw new Error('索引返回了不支持的 Token 类型');
            if (uint(item.value) === 0n) continue;
            asset = { standard: 'erc20', contractAddress, key: `erc20:${contractAddress.toLowerCase()}` };
          } else {
            if (!['ERC-721', 'ERC-1155'].includes(String(token.type))) throw new Error('索引返回了不支持的 NFT 类型');
            const tokenId = uint(item.id);
            asset = { standard: token.type === 'ERC-721' ? 'erc721' : 'erc1155', contractAddress, tokenId, key: `${token.type}:${contractAddress.toLowerCase()}:${tokenId}` };
          }
          if (!assets.has(asset.key)) {
            if (assets.size >= 1000 || ++budget.assets > 5000) throw new Error('资产数量达到扫描上限，清单可能不完整');
            assets.set(asset.key, asset);
          }
        }
        const next = body.next_page_params;
        if (next !== null && (!record(next) || !Object.keys(next).length)) throw new Error('索引分页状态不明确');
        cursor = next as Record<string, unknown> | null;
      }
    } catch (error) {
      assertAutomaticOperationActive(signal);
      issues.push(error instanceof Error ? error.message : '扫描失败');
    }
  }
  assertAutomaticOperationActive(signal);
  return { assets: [...assets.values()], complete: issues.length === 0, issues };
}
