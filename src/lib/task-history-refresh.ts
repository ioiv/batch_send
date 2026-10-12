import type { CollectionDisplayResult } from './collection-results';
import type { TaskNetwork, TaskRecord } from './task-history';

export async function refreshTaskTransactions(record: TaskRecord, currentNetwork: TaskNetwork, rpcEndpoint: string): Promise<TaskRecord> {
  if (currentNetwork.kind !== record.network.kind || currentNetwork.id !== record.network.id || currentNetwork.chainId !== record.network.chainId) {
    throw new Error(`请先切换到记录中的 ${record.network.label} 网络，再查询交易状态`);
  }
  const hashes = [...new Set(record.results.flatMap(result => result.hash ? [result.hash] : []))];
  if (!hashes.length) throw new Error('这轮没有已记录的交易哈希，请通过钱包记录核对');
  const states = new Map<string, { success?: boolean; message: string }>();
  if (record.network.kind === 'evm') {
    const { createPublicClient, http } = await import('viem');
    const client = createPublicClient({ transport: http(rpcEndpoint, { retryCount: 0, timeout: 15000 }) });
    if (await client.getChainId() !== record.network.chainId) throw new Error('当前 RPC 返回的网络与任务记录不一致');
    for (let index = 0; index < hashes.length; index += 4) {
      await Promise.all(hashes.slice(index, index + 4).map(async hash => {
        try {
          const receipt = await client.getTransactionReceipt({ hash: hash as `0x${string}` });
          states.set(hash, { success: receipt.status === 'success', message: receipt.status === 'success' ? '链上已确认成功' : '链上已确认执行失败' });
        } catch { states.set(hash, { message: '暂未取得交易回执，请稍后再查询；不要直接重发' }); }
      }));
    }
  } else {
    const { Connection, assertSolanaRpcNetwork } = await import('./solana');
    const connection = new Connection(rpcEndpoint, 'confirmed');
    if (!['mainnet-beta', 'devnet', 'testnet'].includes(record.network.id)) throw new Error('无法识别记录中的 Solana 网络');
    await assertSolanaRpcNetwork(connection, record.network.id as 'mainnet-beta' | 'devnet' | 'testnet');
    for (let index = 0; index < hashes.length; index += 256) {
      const batch = hashes.slice(index, index + 256);
      const response = await connection.getSignatureStatuses(batch, { searchTransactionHistory: true });
      batch.forEach((hash, position) => {
        const status = response.value[position];
        states.set(hash, status?.err ? { success: false, message: '链上已确认执行失败' }
          : status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized' || status.confirmations === null)
            ? { success: true, message: '链上已确认成功' }
            : { message: '暂未取得确认结果，请稍后再查询；不要直接重发' });
      });
    }
  }
  return { ...record, updatedAt: new Date().toISOString(), results: record.results.map((result): CollectionDisplayResult => {
    const state = result.hash ? states.get(result.hash) : undefined;
    return !state ? result : { ...result, status: state.success === true ? 'success' : 'error', uncertain: state.success === undefined, retryable: false, message: state.message };
  }) };
}
