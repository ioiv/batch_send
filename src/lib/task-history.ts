import { sanitizeRoundArchiveText, type CollectionDisplayResult } from './collection-results';
import { evmNetworks } from './evm';

export type TaskNetwork = { kind: 'evm' | 'solana'; id: string; label: string; chainId?: number; blockExplorerUrl?: string };
export type TaskRecord = {
  id: string;
  toolId: string;
  label: string;
  network: TaskNetwork;
  targetAddress?: string;
  createdAt: string;
  updatedAt: string;
  acknowledgedAt?: string;
  results: CollectionDisplayResult[];
};

const storageKey = 'chainkit.public-task-history.v1';
const safeText = (value: unknown, limit = 500) => typeof value === 'string'
  ? sanitizeRoundArchiveText(value).replace(/[1-9A-HJ-NP-Za-km-z]{80,}/g, '[敏感数据已隐藏]').slice(0, limit) : '';
const publicAddress = (value: unknown) => typeof value === 'string' && /^(?:0x[\da-f]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/i.test(value) ? value : '';
const transactionHash = (value: unknown) => typeof value === 'string' && /^(?:0x[\da-f]{64}|[1-9A-HJ-NP-Za-km-z]{64,88})$/i.test(value) ? value : undefined;
const statuses = new Set(['pending', 'scanning', 'submitting', 'confirming', 'success', 'skipped', 'error']);
const tokenStandards = new Set(['native', 'erc20', 'erc721', 'erc1155', 'spl-token', 'token-2022']);
const collectionTools = new Set(['evm-token-collection', 'evm-nft-collection', 'sol-collection']);
const chainId = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0 ? value as number
  : typeof value === 'string' && /^solana:(?:mainnet-beta|devnet|testnet)$/.test(value) ? value : undefined;
const explorerBase = (value: unknown) => {
  if (typeof value !== 'string' || value.length > 500) return undefined;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
      ? url.href.replace(/\/+$/, '') : undefined;
  } catch { return undefined; }
};

/** Rebuild public links from the saved network; never preserve an arbitrary URL from a result. */
export function getTaskResultExplorerUrl(hash: string | undefined, network: TaskNetwork): string | undefined {
  if (!hash) return undefined;
  if (network.kind === 'solana') {
    if (!['mainnet-beta', 'devnet', 'testnet'].includes(network.id)) return undefined;
    return `https://solscan.io/tx/${hash}${network.id === 'mainnet-beta' ? '' : `?cluster=${network.id}`}`;
  }
  const configured = evmNetworks.find(item => item.chainId === network.chainId);
  const base = explorerBase(network.blockExplorerUrl) || explorerBase(configured?.blockExplorerUrl);
  return base ? `${base}/tx/${hash}` : undefined;
}

/** Copy only public fields; never serialize caller objects or signing material. */
export function sanitizeTaskRecord(value: unknown): TaskRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as TaskRecord;
  if (!record.network || !['evm', 'solana'].includes(record.network.kind) || !Array.isArray(record.results)) return null;
  if (!record.id || !record.toolId || !record.createdAt || !record.updatedAt) return null;
  const results = record.results.filter(result => result && statuses.has(result.status)).map(result => {
    const hash = transactionHash(result.hash);
    return {
      address: publicAddress(result.address) || '—',
      chainId: chainId(result.chainId) ?? (record.network.kind === 'solana' ? chainId(`solana:${record.network.id}`) : chainId(record.network.chainId)),
      networkId: safeText(result.networkId, 80) || safeText(record.network.id, 80) || undefined,
      sourceAddress: publicAddress(result.sourceAddress) || (collectionTools.has(record.toolId) ? publicAddress(result.address) : '') || undefined,
      targetAddress: publicAddress(result.targetAddress) || publicAddress(record.targetAddress) || undefined,
      contractAddress: publicAddress(result.contractAddress) || undefined,
      tokenStandard: tokenStandards.has(result.tokenStandard || '') ? result.tokenStandard : undefined,
      tokenId: typeof result.tokenId === 'string' && /^\d{1,78}$/.test(result.tokenId) ? result.tokenId : undefined,
      asset: safeText(result.asset, 160),
      assetKey: safeText(result.assetKey, 180) || undefined,
      amount: safeText(result.amount, 120) || undefined,
      label: safeText(result.label, 120) || undefined,
      message: safeText(result.message),
      hash,
      explorerUrl: getTaskResultExplorerUrl(hash, record.network),
      status: result.status,
      uncertain: typeof result.uncertain === 'boolean' ? result.uncertain : undefined,
      retryable: false,
      phase: ['token', 'nft', 'native'].includes(result.phase || '') ? result.phase : undefined
    } satisfies CollectionDisplayResult;
  });
  return {
    id: safeText(record.id, 100), toolId: safeText(record.toolId, 80), label: safeText(record.label, 120),
    createdAt: safeText(record.createdAt, 40), updatedAt: safeText(record.updatedAt, 40),
    acknowledgedAt: typeof record.acknowledgedAt === 'string' ? safeText(record.acknowledgedAt, 40) : undefined,
    targetAddress: publicAddress(record.targetAddress) || undefined,
    network: { kind: record.network.kind, id: safeText(record.network.id, 80), label: safeText(record.network.label, 100),
      ...(Number.isSafeInteger(record.network.chainId) && record.network.chainId! > 0 ? { chainId: record.network.chainId } : {}),
      ...(explorerBase(record.network.blockExplorerUrl) ? { blockExplorerUrl: explorerBase(record.network.blockExplorerUrl) } : {}) },
    results
  };
}

export function readTaskHistory(toolId: string): TaskRecord[] {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(storageKey) || '[]');
    if (!Array.isArray(stored)) return [];
    return stored.map(sanitizeTaskRecord).filter((record): record is TaskRecord => record !== null && record.toolId === toolId).slice(0, 10);
  } catch { return []; }
}

export function saveTaskRecord(record: TaskRecord): boolean {
  const safe = sanitizeTaskRecord(record);
  if (!safe || !safe.results.length) return false;
  try {
    let stored: unknown = [];
    try { stored = JSON.parse(window.localStorage.getItem(storageKey) || '[]'); } catch { /* Replace corrupt history with a valid public snapshot. */ }
    const records = (Array.isArray(stored) ? stored : []).map(sanitizeTaskRecord).filter((item): item is TaskRecord => item !== null && item.id !== safe.id);
    const own = [safe, ...records.filter(item => item.toolId === safe.toolId)].slice(0, 10);
    window.localStorage.setItem(storageKey, JSON.stringify([...own, ...records.filter(item => item.toolId !== safe.toolId)].slice(0, 80)));
    return true;
  } catch { return false; }
}

export function removeTaskRecord(id: string) {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(storageKey) || '[]');
    if (Array.isArray(stored)) window.localStorage.setItem(storageKey, JSON.stringify(stored.map(sanitizeTaskRecord).filter(record => record && record.id !== id)));
  } catch { /* Storage may be disabled. */ }
}

export function recoverTaskRecord(record: TaskRecord): TaskRecord {
  return { ...record, results: record.results.map(result => {
    if (result.uncertain || !result.hash && ['submitting', 'confirming'].includes(result.status)) return { ...result, status: 'error', uncertain: true, retryable: false, message: result.hash ? '页面已重新打开，请查询这笔交易的链上结果' : '提交过程曾中断且未记录交易哈希，请通过钱包及链上记录核对，勿直接重发' };
    if (['success', 'skipped'].includes(result.status) || result.status === 'error' && result.uncertain === false) return result;
    if (result.hash) return { ...result, status: 'error', uncertain: true, retryable: false, message: '页面已重新打开，请查询这笔交易的链上结果' };
    if (result.status === 'error') return result;
    return { ...result, status: 'skipped', uncertain: false, retryable: false, message: '页面关闭前未记录交易哈希；请核对钱包及链上记录，勿直接重发' };
  }) };
}
