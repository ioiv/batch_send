// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTaskHistory } from './useTaskHistory';
import type { CollectionDisplayResult } from '../lib/collection-results';
import { readTaskHistory, saveTaskRecord } from '../lib/task-history';

const network = { kind: 'evm' as const, id: 'ethereum', label: 'Ethereum', chainId: 1 };
const pending: CollectionDisplayResult[] = [{ address: `0x${'1'.repeat(40)}`, asset: 'ETH', hash: `0x${'a'.repeat(64)}`, status: 'confirming', message: '链上确认中' }];
beforeEach(() => window.localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('task history lifecycle', () => {
  it('persists submissions, recovers them as unknown and unblocks only after review', () => {
    const options = { toolId: 'evm-distribution', label: '批量分发', network };
    const running = renderHook(() => useTaskHistory({ ...options, results: pending, busy: true }));
    expect(running.result.current.records[0].results[0].hash).toBe(pending[0].hash);
    running.unmount();
    const empty: CollectionDisplayResult[] = [];
    const recovered = renderHook(() => useTaskHistory({ ...options, results: empty }));
    expect(recovered.result.current.needsRecoveryReview).toBe(true);
    const record = recovered.result.current.records[0];
    expect(record.results[0]).toMatchObject({ status: 'error', uncertain: true, retryable: false });
    act(() => recovered.result.current.updateRecord({ ...record, acknowledgedAt: new Date().toISOString() }));
    expect(recovered.result.current.needsRecoveryReview).toBe(false);
  });
  it('keeps an acknowledgement when pagehide captures the current round again', () => {
    const mounted = renderHook(() => useTaskHistory({ toolId: 'evm-distribution', label: '批量分发', network, results: pending }));
    const record = mounted.result.current.records[0];
    act(() => mounted.result.current.updateRecord({ ...record, acknowledgedAt: '2026-10-12T12:30:00Z' }));
    act(() => window.dispatchEvent(new Event('pagehide')));
    expect(readTaskHistory('evm-distribution')[0].acknowledgedAt).toBe('2026-10-12T12:30:00Z');
  });
  it('keeps an honest in-memory snapshot when browser storage is full', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Quota exceeded'); });
    const mounted = renderHook(() => useTaskHistory({ toolId: 'evm-distribution', label: '批量分发', network, results: pending }));
    expect(mounted.result.current.storageAvailable).toBe(false);
    expect(mounted.result.current.records[0].results[0].hash).toBe(pending[0].hash);
  });
  it('freezes the source network and target for a round and uses a new record for the next round', () => {
    const mounted = renderHook(({ results, roundKey, targetAddress }) => useTaskHistory({ toolId: 'evm-distribution', label: '批量分发', network, results, roundKey, targetAddress }),
      { initialProps: { results: pending, roundKey: 1, targetAddress: `0x${'2'.repeat(40)}` } });
    const firstId = mounted.result.current.currentRecordId;
    mounted.rerender({ results: [{ ...pending[0], status: 'success', uncertain: false }], roundKey: 1, targetAddress: `0x${'3'.repeat(40)}` });
    expect(mounted.result.current.records[0].targetAddress).toBe(`0x${'2'.repeat(40)}`);
    mounted.rerender({ results: pending, roundKey: 2, targetAddress: `0x${'3'.repeat(40)}` });
    expect(mounted.result.current.currentRecordId).not.toBe(firstId);
    expect(mounted.result.current.records).toHaveLength(2);
  });
  it('invalidates an old acknowledgement when a failed item is retried with a new submission', () => {
    const original: CollectionDisplayResult[] = [{ ...pending[0], status: 'error', uncertain: true }, { ...pending[0], hash: undefined, asset: 'USDC', status: 'error', uncertain: false }];
    const options = { toolId: 'evm-distribution', label: '批量分发', network };
    const mounted = renderHook(({ results }) => useTaskHistory({ ...options, results, roundKey: 1 }), { initialProps: { results: original } });
    act(() => mounted.result.current.updateRecord({ ...mounted.result.current.records[0], acknowledgedAt: '2026-10-12T12:30:00Z' }));
    mounted.rerender({ results: [original[0], { ...original[1], hash: `0x${'b'.repeat(64)}`, status: 'confirming', uncertain: false }] });
    expect(mounted.result.current.records[0].acknowledgedAt).toBeUndefined();
    mounted.unmount();
    const empty: CollectionDisplayResult[] = [];
    const restored = renderHook(() => useTaskHistory({ ...options, results: empty }));
    expect(restored.result.current.needsRecoveryReview).toBe(true);
  });
  it('persists a submitting snapshot synchronously before the next React render', () => {
    const empty: CollectionDisplayResult[] = [];
    const mounted = renderHook(() => useTaskHistory({ toolId: 'evm-distribution', label: '批量分发', network, results: empty }));
    act(() => mounted.result.current.captureResults([{ ...pending[0], status: 'submitting' }]));
    act(() => window.dispatchEvent(new Event('pagehide')));
    expect(readTaskHistory('evm-distribution')[0].results[0]).toMatchObject({ status: 'submitting', hash: pending[0].hash });
  });
  it('does not overwrite a queried definitive receipt with an older confirming snapshot on pagehide', () => {
    const mounted = renderHook(() => useTaskHistory({ toolId: 'evm-distribution', label: '批量分发', network, results: pending }));
    const record = mounted.result.current.records[0];
    act(() => mounted.result.current.updateRecord({ ...record, results: [{ ...record.results[0], status: 'success', uncertain: false, message: '链上已确认成功' }] }));
    act(() => window.dispatchEvent(new Event('pagehide')));
    expect(readTaskHistory('evm-distribution')[0].results[0]).toMatchObject({ status: 'success', uncertain: false });
  });
  it('merges a late receipt query without losing a newer retried transaction', () => {
    const original: CollectionDisplayResult[] = [{ ...pending[0], status: 'error', uncertain: true }, { ...pending[0], hash: undefined, asset: 'USDC', status: 'error', uncertain: false }];
    const mounted = renderHook(({ results }) => useTaskHistory({ toolId: 'evm-distribution', label: '批量分发', network, results }), { initialProps: { results: original } });
    const querySnapshot = mounted.result.current.records[0];
    mounted.rerender({ results: [original[0], { ...original[1], hash: `0x${'b'.repeat(64)}`, status: 'confirming' }] });
    act(() => mounted.result.current.updateRecord({ ...querySnapshot, results: [{ ...querySnapshot.results[0], status: 'success', uncertain: false }, querySnapshot.results[1]] }));
    expect(readTaskHistory('evm-distribution')[0].results[1]).toMatchObject({ hash: `0x${'b'.repeat(64)}`, status: 'confirming' });
  });
  it('receives other-tab updates and synchronously checks fresh history before a send', () => {
    const empty: CollectionDisplayResult[] = [];
    const mounted = renderHook(() => useTaskHistory({ toolId: 'evm-distribution', label: '批量分发', network, results: empty }));
    const foreign = { id: 'other-tab', toolId: 'evm-distribution', label: '另一页', network, createdAt: '2026-10-12', updatedAt: '2026-10-12', results: pending };
    saveTaskRecord(foreign);
    let blocked = false;
    act(() => { blocked = mounted.result.current.checkRecoveryReview(); });
    expect(blocked).toBe(true);
    expect(mounted.result.current.needsRecoveryReview).toBe(true);
    act(() => { saveTaskRecord({ ...foreign, acknowledgedAt: new Date().toISOString() }); window.dispatchEvent(new StorageEvent('storage', { key: 'chainkit.public-task-history.v1' })); });
    expect(mounted.result.current.needsRecoveryReview).toBe(false);
  });
});
