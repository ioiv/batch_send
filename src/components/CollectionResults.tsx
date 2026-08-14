import { useEffect, useMemo, useRef, useState } from "react";
import { Metric } from "./Metric";
import {
  downloadCollectionResults,
  filterCollectionResults,
  getCollectionResultCounts,
  type CollectionDisplayResult,
  type CollectionResultFilter,
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

const filterOptions: Array<{ label: string; value: CollectionResultFilter }> = [
  { label: "全部", value: "all" },
  { label: "处理中", value: "active" },
  { label: "完成", value: "success" },
  { label: "跳过", value: "skipped" },
  { label: "失败", value: "error" }
];

type IndexedCollectionResult = {
  originalIndex: number;
  result: CollectionDisplayResult;
};

export function getCollectionResultSetIdentity(results: CollectionDisplayResult[]) {
  return JSON.stringify(results.map((result) => [
    result.address,
    result.asset,
    result.label || ""
  ]));
}

export function getIndexedCollectionResults(
  results: CollectionDisplayResult[],
  filter: CollectionResultFilter,
  query: string
): IndexedCollectionResult[] {
  const matchingResults = new Set(filterCollectionResults(results, { query, status: filter }));
  return results.flatMap((result, originalIndex) => (
    matchingResults.has(result) ? [{ originalIndex, result }] : []
  ));
}

function CollectionResultsBody({ results }: { results: CollectionDisplayResult[] }) {
  const [filter, setFilter] = useState<CollectionResultFilter>("all");
  const [query, setQuery] = useState("");
  const counts = getCollectionResultCounts(results);
  const hasActiveResults = counts.active > 0;
  const previousHasActiveResultsRef = useRef(hasActiveResults);
  const filteredResults = useMemo(
    () => getIndexedCollectionResults(results, filter, query),
    [filter, query, results]
  );
  const clearFilters = () => {
    setFilter("all");
    setQuery("");
  };

  useEffect(() => {
    if (!previousHasActiveResultsRef.current && hasActiveResults) {
      setFilter("all");
      setQuery("");
    }
    previousHasActiveResultsRef.current = hasActiveResults;
  }, [hasActiveResults]);

  return (
    <div className="collection-results-body">
      <div className="stats collection-stats" aria-label="归集执行统计">
        <Metric label="来源" value={String(counts.total)} />
        <Metric label="完成" value={String(counts.success)} />
        <Metric label="跳过" value={String(counts.skipped)} />
        <Metric label="失败" value={String(counts.error)} />
      </div>

      <div className="collection-results-toolbar">
        <div className="collection-filter-tabs" role="group" aria-label="筛选执行结果">
          {filterOptions.map((option) => (
            <button
              aria-pressed={filter === option.value}
              className={filter === option.value ? "is-active" : undefined}
              key={option.value}
              onClick={() => setFilter(option.value)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
        <label className="collection-result-search">
          <span className="sr-only">搜索执行结果</span>
          <input
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索地址、备注或资产"
            type="search"
            value={query}
          />
        </label>
      </div>

      {filteredResults.length ? <div className="collection-result-list" role="list">
        {filteredResults.map(({ originalIndex, result }) => {
          const resultLabel = result.label || `来源 ${originalIndex + 1}`;
          return (
            <article className={`collection-result-row status-${result.status}`} key={originalIndex} role="listitem">
              <div className="collection-result-main">
                <div className="collection-result-title">
                  <strong>{resultLabel}</strong>
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
                    aria-label={`查看${resultLabel}的交易`}
                    href={result.explorerUrl}
                    rel="noreferrer"
                    target="_blank"
                  >查看交易</a>
                ) : result.hash ? <code>{result.hash}</code> : <span>—</span>}
              </div>
            </article>
          );
        })}
      </div> : (
        <div className="empty collection-filter-empty">
          <div role="status">
            <strong>当前筛选没有匹配结果</strong>
            <p>全部 {results.length} 条执行结果仍然保留，清除筛选即可查看。</p>
          </div>
          <button className="button ghost compact-button" onClick={clearFilters} type="button">
            清除筛选
          </button>
        </div>
      )}
    </div>
  );
}

export function CollectionResults({
  emptyMessage = "解析来源钱包后，这里会显示每个地址的归集状态。",
  exportFilename,
  results
}: {
  emptyMessage?: string;
  exportFilename: string;
  results: CollectionDisplayResult[];
}) {
  const resultSetIdentity = useMemo(() => getCollectionResultSetIdentity(results), [results]);

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
          导出全部 CSV
        </button>
      </div>

      {results.length ? (
        <CollectionResultsBody key={resultSetIdentity} results={results} />
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
