import { beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshTaskTransactions } from './task-history-refresh';
import type { TaskRecord } from './task-history';
const rpc = vi.hoisted(() => ({ getChainId: vi.fn(), getTransactionReceipt: vi.fn() }));
vi.mock('viem', async original => ({ ...await original<typeof import('viem')>(), createPublicClient: () => rpc, http: vi.fn() }));
const hash = `0x${'a'.repeat(64)}`;
const record: TaskRecord = { id: 'test', toolId: 'evm-distribution', label: '分发', createdAt: '2026-10-12', updatedAt: '2026-10-12',
  network: { kind: 'evm', id: 'ethereum', label: 'Ethereum', chainId: 1 },
  results: [{ address: `0x${'1'.repeat(40)}`, asset: 'ETH', message: '待核对', hash, status: 'error', uncertain: true }] };
beforeEach(() => { vi.clearAllMocks(); rpc.getChainId.mockResolvedValue(1); });
describe('read-only transaction recovery', () => {
  it('refuses a different selected chain and a mismatched RPC before looking up receipts', async () => {
    await expect(refreshTaskTransactions(record, { ...record.network, id: 'base', chainId: 8453 }, 'https://rpc.test')).rejects.toThrow('切换');
    expect(rpc.getChainId).not.toHaveBeenCalled();
    rpc.getChainId.mockResolvedValue(8453);
    await expect(refreshTaskTransactions(record, record.network, 'https://rpc.test')).rejects.toThrow('不一致');
    expect(rpc.getTransactionReceipt).not.toHaveBeenCalled();
  });
  it('distinguishes success, reverted transactions and unavailable receipts', async () => {
    rpc.getTransactionReceipt.mockResolvedValueOnce({ status: 'success' }).mockResolvedValueOnce({ status: 'reverted' }).mockRejectedValueOnce(new Error('not found'));
    const expanded = { ...record, results: [record.results[0], { ...record.results[0], hash: `0x${'b'.repeat(64)}` }, { ...record.results[0], hash: `0x${'c'.repeat(64)}` }] };
    const refreshed = await refreshTaskTransactions(expanded, record.network, 'https://rpc.test');
    expect(refreshed.results[0]).toMatchObject({ status: 'success', uncertain: false, explorerUrl: `https://etherscan.io/tx/${hash}` });
    expect(refreshed.results[1]).toMatchObject({ status: 'error', uncertain: false });
    expect(refreshed.results[2]).toMatchObject({ status: 'error', uncertain: true, retryable: false });
  });
});
