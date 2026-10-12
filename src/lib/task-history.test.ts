// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { readTaskHistory, recoverTaskRecord, removeTaskRecord, saveTaskRecord, type TaskRecord } from './task-history';

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
