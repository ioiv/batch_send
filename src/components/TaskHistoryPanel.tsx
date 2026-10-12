import { useState } from 'react';
import { Button } from './ui/button';
import { CollectionResults } from './CollectionResults';
import { ExecutionLogDialog, ReviewPanel, ConfirmActionDialog } from './WorkbenchPrimitives';
import { getCollectionResultCounts } from '../lib/collection-results';
import { refreshTaskTransactions } from '../lib/task-history-refresh';
import type { TaskNetwork, TaskRecord } from '../lib/task-history';

export function TaskHistoryPanel({ history, network, rpcEndpoint, busy = false }: {
  history: { records: TaskRecord[]; storageAvailable?: boolean; updateRecord: (record: TaskRecord) => void; deleteRecord: (id: string) => void };
  network: TaskNetwork; rpcEndpoint: string; busy?: boolean;
}) {
  const [querying, setQuerying] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ id: string; text: string } | null>(null);
  if (!history.records.length) return null;
  const refresh = async (record: TaskRecord) => {
    if (querying || busy) return;
    setQuerying(record.id); setNotice(null);
    try {
      const refreshed = await refreshTaskTransactions(record, network, rpcEndpoint);
      history.updateRecord(refreshed);
      const counts = getCollectionResultCounts(refreshed.results);
      setNotice({ id: record.id, text: `查询完成 · 已确认 ${counts.success} · 失败 ${counts.error} · 待核对 ${counts.uncertain}` });
    } catch (error) { setNotice({ id: record.id, text: error instanceof Error ? error.message : '查询失败，请稍后重试' }); }
    finally { setQuerying(null); }
  };
  return <section id="task-history-review" tabIndex={-1}><ReviewPanel className="task-history" title="可恢复任务记录" autoOpen={history.records.some(record => !record.acknowledgedAt && record.results.some(result => result.uncertain))} summary={`最近 ${history.records.length} 轮 · ${history.storageAvailable === false ? '浏览器存储不可用，仅当前页面可查看' : '刷新后仍可查看'}`}>
    <p className="hint">记录仅包含公开地址、金额和交易哈希。查询只读取链上结果，不会签名或重新发送。</p>
    <div className="task-history__list">{history.records.map(record => {
      const counts = getCollectionResultCounts(record.results);
      const matching = network.kind === record.network.kind && network.id === record.network.id && network.chainId === record.network.chainId;
      return <div className="task-history__round" key={record.id}>
        <div className="task-history__description"><strong>{record.label} · {record.network.label}</strong>
          <span>{new Date(record.createdAt).toLocaleString('zh-CN')} · 完成 {counts.success} · 失败 {counts.error} · 待核对 {counts.uncertain}</span>
          {record.targetAddress ? <code>接收地址 {record.targetAddress}</code> : null}
        </div>
        <div className="task-history__actions">
          <ExecutionLogDialog title={`${record.label} · ${record.network.label}`} triggerLabel="查看记录"><CollectionResults results={record.results} exportFilename={`${record.toolId}-${record.id}.csv`} /></ExecutionLogDialog>
          {record.results.some(result => result.hash) ? <Button size="sm" type="button" variant="outline" disabled={busy || Boolean(querying) || !matching}
            title={matching ? '通过当前网络 RPC 查询交易回执' : `请先切换到 ${record.network.label}`}
            onClick={() => void refresh(record)}>{querying === record.id ? '查询中…' : '继续查询交易状态'}</Button> : null}
          {!matching ? <span className="hint">切换到 {record.network.label} 后可查询</span> : null}
          {counts.uncertain && !record.acknowledgedAt ? <ConfirmActionDialog triggerLabel="已人工核对链上结果" triggerSize="sm" triggerVariant="outline" title="已核对这轮交易的链上结果？" description="确认你已通过钱包记录、交易哈希和收款地址核对结果；这不会重试或撤销交易。" confirmLabel="确认已核对" disabled={busy || Boolean(querying)} onConfirm={() => history.updateRecord({ ...record, acknowledgedAt: new Date().toISOString() })} /> : null}
          <ConfirmActionDialog triggerLabel="删除记录" triggerSize="sm" triggerVariant="ghost" title="删除这轮任务记录？" description="删除浏览器中的公开记录，链上交易不受影响。" confirmLabel="删除记录" disabled={busy || Boolean(querying) || Boolean(counts.uncertain && !record.acknowledgedAt)} onConfirm={() => history.deleteRecord(record.id)} />
        </div>
        {notice?.id === record.id ? <p className="hint" role="status">{notice.text}</p> : null}
      </div>;
    })}</div>
  </ReviewPanel></section>;
}
