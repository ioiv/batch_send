// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { readTaskHistory, recoverTaskRecord, removeTaskRecord, saveTaskRecord, type TaskRecord } from './task-history';
import { createCollectionResultsCsv } from './collection-results';

const hash = `0x${'a'.repeat(64)}`;
const address = `0x${'1'.repeat(40)}`;
const makeRecord = (id = 'round-1'): TaskRecord => ({ id, toolId: 'evm-token-collection', label: '手动归集',
  network: { kind: 'evm', id: 'ethereum', label: 'Ethereum', chainId: 1 }, createdAt: '2026-10-12T12:00:00Z', updatedAt: '2026-10-12T12:00:00Z',
  targetAddress: address, results: [{ address, asset: 'ETH', amount: '0.1', hash, status: 'confirming', message: '确认中' }] });
beforeEach(() => window.localStorage.clear());

describe('public task history', () => {
  it('stores only allowlisted public data and strips signing fields, RPC credentials and secret-like labels', () => {
    const record = makeRecord();
    const secret = `0x${'b'.repeat(64)}`;
    Object.assign(record, { privateKey: secret, rpcEndpoint: 'https://user:password@rpc.test/private-token', signingPlan: { secret } });
    Object.assign(record.results[0], { privateKey: secret, account: { secret }, message: `失败 ${secret} https://rpc.test/private-token`, label: 'A'.repeat(88) });
    saveTaskRecord(record);
    const stored = window.localStorage.getItem('chainkit.public-task-history.v1')!;
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain('private-token');
    expect(stored).not.toContain('privateKey');
    expect(stored).not.toContain('signingPlan');
    expect(stored).not.toContain('A'.repeat(88));
    expect(readTaskHistory(record.toolId)[0].results[0].hash).toBe(hash);
  });
  it('recovers submitted tasks as uncertain, including submissions whose hash was not returned', () => {
    const record = makeRecord();
    record.results.push({ address, asset: 'ETH', status: 'submitting', message: '提交中', uncertain: true });
    const recovered = recoverTaskRecord(record);
    expect(recovered.results.every(result => result.status === 'error' && result.uncertain && result.retryable === false)).toBe(true);
    expect(recovered.results[1].message).toContain('未记录交易哈希');
  });
  it('preserves full NFT context and explorer links through storage and recovery', () => {
    const record = makeRecord();
    record.network = { kind: 'evm', id: 'baseSepolia', label: 'Base Sepolia', chainId: 84532 };
    const contract = `0x${'3'.repeat(40)}`;
    const target = `0x${'4'.repeat(40)}`;
    const tokenId = (2n ** 256n - 1n).toString();
    record.targetAddress = target;
    Object.assign(record.results[0], { contractAddress: contract, tokenStandard: 'erc721', tokenId, amount: '1' });
    expect(saveTaskRecord(record)).toBe(true);
    const result = recoverTaskRecord(readTaskHistory(record.toolId)[0]).results[0];
    expect(result).toMatchObject({ chainId: 84532, sourceAddress: address, targetAddress: target, contractAddress: contract,
      tokenStandard: 'erc721', tokenId, amount: '1', hash, explorerUrl: `https://sepolia.basescan.org/tx/${hash}` });
    expect(createCollectionResultsCsv([result])).toContain(`84532,${address},${target},${contract},erc721,${tokenId}`);
  });
  it('fills only known legacy context and leaves missing asset identifiers empty', () => {
    const record = makeRecord(); record.results[0].asset = 'ERC721 #1 · 0x24…3A17';
    saveTaskRecord(record);
    const result = readTaskHistory(record.toolId)[0].results[0];
    expect(result).toMatchObject({ chainId: 1, sourceAddress: address, targetAddress: address, explorerUrl: `https://etherscan.io/tx/${hash}` });
    expect(result.contractAddress).toBeUndefined();
    expect(result.tokenId).toBeUndefined();
    expect(result.tokenStandard).toBeUndefined();
  });
  it('does not treat legacy distribution recipients as source wallets', () => {
    const record = makeRecord(); record.toolId = 'evm-distribution';
    saveTaskRecord(record);
    expect(readTaskHistory(record.toolId)[0].results[0].sourceAddress).toBeUndefined();
  });
  it('migrates legacy distribution roles using an approval sender without calling recipients sources', () => {
    const record = makeRecord(); record.toolId = 'evm-distribution'; record.targetAddress = undefined;
    const sender = `0x${'2'.repeat(40)}`; const execution = `0x${'3'.repeat(40)}`; const token = `0x${'4'.repeat(40)}`;
    record.results = [{ address: sender, label: 'Token 授权', targetAddress: execution, contractAddress: token, asset: 'TKN', status: 'success', message: '已授权' },
      ...[5, 6, 7].map(index => ({ address: `0x${String(index).repeat(40)}`, asset: 'TKN', status: 'success' as const, message: '已分发' }))];
    expect(saveTaskRecord(record)).toBe(true);
    const migrated = readTaskHistory(record.toolId)[0];
    expect(migrated.senderAddress).toBe(sender);
    expect(migrated.results[0]).toMatchObject({ resultKind: 'approval', sourceAddress: sender, spenderAddress: execution, executionContractAddress: token });
    expect(migrated.results[0].targetAddress).toBeUndefined();
    expect(migrated.results.slice(1).every(result => result.resultKind === 'distribution' && result.sourceAddress === sender && result.targetAddress === result.address && result.executionContractAddress === execution)).toBe(true);
    const csv = createCollectionResultsCsv(migrated.results);
    expect(csv).toContain('result_kind,execution_contract_address,spender_address');
    expect(csv).toContain(`distribution,${execution},`);
  });
  it('uses an explicit legacy sender and leaves ambiguous or absent senders unknown', () => {
    const sender = `0x${'2'.repeat(40)}`;
    const record = { ...makeRecord(), toolId: 'evm-distribution', sender };
    expect(saveTaskRecord(record)).toBe(true);
    expect(readTaskHistory(record.toolId)[0].results[0].sourceAddress).toBe(sender);
    delete (record as { sender?: string }).sender;
    record.results.push({ ...record.results[0], address: `0x${'3'.repeat(40)}` });
    saveTaskRecord(record);
    expect(readTaskHistory(record.toolId)[0].results.every(result => !result.sourceAddress)).toBe(true);
    record.results[0].sourceAddress = sender; record.results[1].sourceAddress = `0x${'4'.repeat(40)}`;
    record.results.push({ ...record.results[0], sourceAddress: undefined });
    saveTaskRecord(record);
    expect(readTaskHistory(record.toolId)[0].results[2].sourceAddress).toBeUndefined();
  });
  it('preserves configured custom explorer bases and rejects credential URLs or arbitrary result links', () => {
    const record = makeRecord();
    record.network = { kind: 'evm', id: 'custom-123', label: 'Custom', chainId: 123, blockExplorerUrl: 'https://scan.example.test/explorer/' };
    record.results[0].explorerUrl = 'https://rpc.example.test/private-token';
    saveTaskRecord(record);
    expect(readTaskHistory(record.toolId)[0].results[0].explorerUrl).toBe(`https://scan.example.test/explorer/tx/${hash}`);
    record.network.blockExplorerUrl = 'https://user:password@rpc.example.test/private-token';
    saveTaskRecord(record);
    expect(readTaskHistory(record.toolId)[0].network.blockExplorerUrl).toBeUndefined();
    expect(readTaskHistory(record.toolId)[0].results[0].explorerUrl).toBeUndefined();
    expect(window.localStorage.getItem('chainkit.public-task-history.v1')).not.toContain('private-token');
  });
  it('retains Solana cluster, mint and token program metadata', () => {
    const mint = 'So11111111111111111111111111111111111111112';
    const signature = '2'.repeat(88);
    const record = makeRecord();
    record.network = { kind: 'solana', id: 'devnet', label: 'Devnet' };
    Object.assign(record.results[0], { address: mint, hash: signature, contractAddress: mint, tokenStandard: 'token-2022' });
    saveTaskRecord(record);
    expect(readTaskHistory(record.toolId)[0].results[0]).toMatchObject({ chainId: 'solana:devnet', contractAddress: mint,
      tokenStandard: 'token-2022', explorerUrl: `https://solscan.io/tx/${signature}?cluster=devnet` });
  });
  it('retains confirmed successes and failures without turning a chain failure into an unknown result', () => {
    const record = makeRecord();
    record.results[0] = { ...record.results[0], status: 'error', uncertain: false };
    expect(recoverTaskRecord(record).results[0]).toMatchObject({ status: 'error', uncertain: false });
    record.results[0].status = 'success';
    expect(recoverTaskRecord(record).results[0].status).toBe('success');
  });
  it('upserts a running round and retains ten rounds per tool without deleting other tools', () => {
    for (let i = 0; i < 12; i++) saveTaskRecord(makeRecord(`round-${i}`));
    const other = { ...makeRecord('other'), toolId: 'sol-distribution' }; saveTaskRecord(other);
    const updated = makeRecord('round-11'); updated.results[0].status = 'success'; saveTaskRecord(updated);
    expect(readTaskHistory(updated.toolId)).toHaveLength(10);
    expect(readTaskHistory(updated.toolId)[0].results[0].status).toBe('success');
    expect(readTaskHistory(other.toolId)).toHaveLength(1);
    removeTaskRecord('round-11'); expect(readTaskHistory(updated.toolId)).toHaveLength(9);
  });
  it('ignores corrupt storage and malformed records', () => {
    window.localStorage.setItem('chainkit.public-task-history.v1', 'broken');
    expect(readTaskHistory('evm-token-collection')).toEqual([]);
    window.localStorage.setItem('chainkit.public-task-history.v1', JSON.stringify([null, {}, { privateKey: 'secret' }]));
    expect(readTaskHistory('evm-token-collection')).toEqual([]);
  });
  it('preserves native-phase uncertain transactions after 5000 asset results', () => {
    const record = makeRecord();
    record.results = Array.from({ length: 5000 }, () => ({ address, asset: 'Token', status: 'success' as const, message: '完成' }));
    record.results.push({ address, asset: 'ETH', phase: 'native', status: 'confirming', hash, uncertain: true, message: '待确认' });
    expect(saveTaskRecord(record)).toBe(true);
    const recovered = recoverTaskRecord(readTaskHistory(record.toolId)[0]);
    expect(recovered.results).toHaveLength(5001);
    expect(recovered.results[5000]).toMatchObject({ phase: 'native', hash, uncertain: true });
  });
});
