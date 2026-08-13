import { Metric } from "./Metric";
import {
  downloadCollectionResults,
  getCollectionResultCounts,
  type CollectionDisplayResult,
  type CollectionResultStatus
} from "../lib/collection-results";

const statusLabels: Record<CollectionResultStatus, string> = {
  confirming: "确认中",
  error: "失败",
  pending: "待处理",
  scanning: "读取中",
  skipped: "已跳过",
  submitting: "提交中",
  success: "已完成"
};

export function CollectionResults({
  emptyMessage = "解析来源钱包后，这里会显示每个地址的归集状态。",
  exportFilename,
  results
}: {
  emptyMessage?: string;
  exportFilename: string;
  results: CollectionDisplayResult[];
}) {
  const counts = getCollectionResultCounts(results);

  return (
    <section className="panel collection-results" aria-labelledby="collection-results-title">
      <div className="panel-header collection-results-header">
        <div>
          <h2 className="panel-title" id="collection-results-title">执行结果</h2>
          <p className="panel-note">成功、跳过和失败会逐地址保留，便于中断后核对。</p>
        </div>
        <button
          className="button ghost compact-button"
          disabled={!results.length}
          onClick={() => downloadCollectionResults(results, exportFilename)}
          type="button"
        >
          导出 CSV
        </button>
      </div>

      {results.length ? (
        <div className="collection-results-body">
          <div className="stats collection-stats" aria-label="归集执行统计">
            <Metric label="来源" value={String(counts.total)} />
            <Metric label="完成" value={String(counts.success)} />
            <Metric label="跳过" value={String(counts.skipped)} />
            <Metric label="失败" value={String(counts.error)} />
          </div>

          <div className="collection-result-list" role="list">
            {results.map((result, index) => (
              <article className={`collection-result-row status-${result.status}`} key={`${result.address}-${result.asset}-${index}`} role="listitem">
                <div className="collection-result-main">
                  <div className="collection-result-title">
                    <strong>{result.label || `来源 ${index + 1}`}</strong>
                    <span className={`collection-status status-${result.status}`}>{statusLabels[result.status]}</span>
                  </div>
                  <code>{result.address}</code>
                  <p>{result.message}</p>
                </div>
                <div className="collection-result-asset">
                  <span>{result.asset}</span>
                  <strong>{result.amount || "—"}</strong>
                </div>
                <div className="collection-result-link">
                  {result.explorerUrl && result.hash ? (
                    <a
                      aria-label={`查看${result.label || `来源 ${index + 1}`}的交易`}
                      href={result.explorerUrl}
                      rel="noreferrer"
                      target="_blank"
                    >查看交易</a>
                  ) : result.hash ? <code>{result.hash}</code> : <span>—</span>}
                </div>
              </article>
            ))}
          </div>
        </div>
      ) : (
        <div className="empty collection-empty">
          <div>
            <span className="collection-empty-mark" aria-hidden="true">↙</span>
            <strong>等待归集清单</strong>
            <p>{emptyMessage}</p>
          </div>
        </div>
      )}
    </section>
  );
}
