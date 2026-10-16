import { useEffect, useRef, useState } from 'react';
import type { CollectionDisplayResult } from '../lib/collection-results';
import { readTaskHistory, recoverTaskRecord, removeTaskRecord, saveTaskRecord, sanitizeTaskRecord, type TaskNetwork, type TaskRecord } from '../lib/task-history';

export function useTaskHistory({ toolId, label, network, targetAddress, results, busy = false, roundKey }: {
  toolId: string; label: string; network: TaskNetwork; targetAddress?: string;
  results: CollectionDisplayResult[]; busy?: boolean; roundKey?: string | number;
}) {
  const [records, setRecords] = useState(() => readTaskHistory(toolId).map(recoverTaskRecord));
  const currentRef = useRef<TaskRecord | null>(null);
  const suppliedResultsRef = useRef(results);
  const latestResultsRef = useRef(results);
  if (suppliedResultsRef.current !== results) {
    suppliedResultsRef.current = results; latestResultsRef.current = results;
  }
  const previousRoundRef = useRef(roundKey);
  const captureRef = useRef<((snapshot?: CollectionDisplayResult[]) => void) | null>(null);
  const [storageAvailable, setStorageAvailable] = useState(true);
  captureRef.current = (snapshot = latestResultsRef.current) => {
    latestResultsRef.current = snapshot;
    if (previousRoundRef.current !== roundKey) { currentRef.current = null; previousRoundRef.current = roundKey; }
    if (!snapshot.length) { currentRef.current = null; return; }
    const previous = currentRef.current;
    // A receipt queried in the history panel must survive a later pagehide with
    // the workbench's older "confirming" snapshot for the same transaction.
    const merged = snapshot.map(result => {
      const previousResult = result.hash && previous?.results.find(item => item.hash === result.hash && item.address === result.address && item.asset === result.asset && item.assetKey === result.assetKey);
      const enriched = previousResult ? { ...result, sourceAddress: result.sourceAddress || previousResult.sourceAddress,
        targetAddress: result.targetAddress || previousResult.targetAddress, resultKind: result.resultKind || previousResult.resultKind,
        executionContractAddress: result.executionContractAddress || previousResult.executionContractAddress,
        spenderAddress: result.spenderAddress || previousResult.spenderAddress } : result;
      const confirmed = previousResult && (previousResult.status === 'success' || previousResult.status === 'error' && previousResult.uncertain === false) ? previousResult : undefined;
      return confirmed && (result.uncertain || result.status === 'confirming')
        ? { ...enriched, status: confirmed.status, uncertain: false, message: confirmed.message } : enriched;
    });
    const newSubmission = merged.some((result, index) => {
      if (!result.uncertain && !['submitting', 'confirming'].includes(result.status)) return false;
      const old = previous?.results[index];
      return !old || old.address !== result.address || old.asset !== result.asset || old.hash !== result.hash
        || result.uncertain && !old.uncertain || ['submitting', 'confirming'].includes(result.status) && !['submitting', 'confirming'].includes(old.status);
    });
    const now = new Date().toISOString();
    const record: TaskRecord = previous
      ? { ...previous, updatedAt: now, results: merged, ...(newSubmission ? { acknowledgedAt: undefined } : {}) }
      : { id: `${toolId}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`, toolId, label, network: { ...network }, targetAddress, createdAt: now, updatedAt: now, results: merged };
    const saved = saveTaskRecord(record);
    // Read back the allowlisted snapshot; the history must not retain caller objects.
    const own = readTaskHistory(toolId);
    const persisted = saved ? own.find(item => item.id === record.id) : undefined;
    currentRef.current = persisted || sanitizeTaskRecord(record);
    setStorageAvailable(Boolean(persisted));
    setRecords(persisted ? own.map(item => item.id === persisted.id ? item : recoverTaskRecord(item))
      : currentRef.current ? [currentRef.current, ...records.filter(item => item.id !== record.id)].slice(0, 10) : records);
  };
  useEffect(() => { captureRef.current?.(); }, [results, roundKey, toolId]);
  useEffect(() => {
    const capture = () => captureRef.current?.();
    window.addEventListener('pagehide', capture);
    return () => window.removeEventListener('pagehide', capture);
  }, []);
  useEffect(() => {
    const sync = () => setRecords(readTaskHistory(toolId).map(item => item.id === currentRef.current?.id ? currentRef.current! : recoverTaskRecord(item)));
    const onStorage = (event: StorageEvent) => { if (event.key === 'chainkit.public-task-history.v1' || event.key === null) sync(); };
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', sync);
    window.addEventListener('pageshow', sync);
    return () => { window.removeEventListener('storage', onStorage); window.removeEventListener('focus', sync); window.removeEventListener('pageshow', sync); };
  }, [toolId]);
  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);
  return {
    records,
    currentRecordId: currentRef.current?.id,
    captureResults(snapshot: CollectionDisplayResult[]) { captureRef.current?.(snapshot); },
    checkRecoveryReview() {
      const fresh = readTaskHistory(toolId).map(recoverTaskRecord);
      const ownId = latestResultsRef.current.length ? currentRef.current?.id : undefined;
      const merged = [...fresh, ...records.filter(item => !fresh.some(saved => saved.id === item.id))];
      const blocked = merged.some(item => item.id !== ownId && !item.acknowledgedAt && item.results.some(result => result.uncertain));
      if (blocked) setRecords(merged);
      return blocked;
    },
    storageAvailable,
    needsRecoveryReview: records.some(record => (!results.length || record.id !== currentRef.current?.id) && !record.acknowledgedAt && record.results.some(result => result.uncertain || ['submitting', 'confirming'].includes(result.status))),
    updateRecord(record: TaskRecord) {
      const safe = sanitizeTaskRecord(record);
      if (!safe) return;
      const latest = currentRef.current?.id === safe.id ? currentRef.current : readTaskHistory(toolId).find(item => item.id === safe.id) || records.find(item => item.id === safe.id);
      const submissionIdentity = (value: TaskRecord) => JSON.stringify(value.results.map(item => [item.address, item.asset, item.assetKey, item.hash || (['submitting', 'confirming'].includes(item.status) ? 'broadcasting' : 'hashless')]));
      const merged = latest ? { ...latest, updatedAt: safe.updatedAt, acknowledgedAt: safe.acknowledgedAt && submissionIdentity(latest) === submissionIdentity(safe) ? safe.acknowledgedAt : latest.acknowledgedAt,
        results: latest.results.map(item => {
          // Query snapshots may be older than a newly retried submission. Only
          // update the receipt for an identical hash, preserving new hashes/rows.
          const incoming = item.hash && safe.results.find(candidate => candidate.hash === item.hash && candidate.address === item.address && candidate.asset === item.asset && candidate.assetKey === item.assetKey);
          if (!incoming) return item;
          // A transaction lookup may restore public context while its receipt is
          // temporarily unavailable. Keep definitive status and existing context.
          const publicContext = { sourceAddress: item.sourceAddress || incoming.sourceAddress,
            targetAddress: item.targetAddress || incoming.targetAddress, resultKind: item.resultKind || incoming.resultKind,
            executionContractAddress: item.executionContractAddress || incoming.executionContractAddress,
            spenderAddress: item.spenderAddress || incoming.spenderAddress };
          if (incoming.status === 'success' || incoming.status === 'error' && incoming.uncertain === false) return { ...incoming, ...publicContext };
          if (item.status === 'success' || item.status === 'error' && item.uncertain === false) return { ...item, ...publicContext };
          return { ...incoming, ...publicContext };
        }) } : safe;
      if (record.id === currentRef.current?.id) currentRef.current = merged;
      const saved = saveTaskRecord(merged); setStorageAvailable(saved);
      setRecords(saved ? readTaskHistory(toolId).map(item => item.id === currentRef.current?.id ? item : recoverTaskRecord(item))
        : records.map(item => item.id === merged.id ? merged : item));
    },
    deleteRecord(id: string) { removeTaskRecord(id); setRecords(records.filter(item => item.id !== id)); }
  };
}
