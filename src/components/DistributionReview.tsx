import { useState } from "react";
import type { DistributionRow } from "../lib/distribution";
import { formatLamports } from "../lib/amount";

const collapsedRowCount = 12;

export function DistributionReview({
  formatAmount,
  rows
}: {
  formatAmount?: (row: DistributionRow) => string;
  rows: DistributionRow[];
}) {
  const [expanded, setExpanded] = useState(false);

  if (rows.length === 0) {
    return (
      <div className="review-list">
        <div className="empty">暂无清单</div>
      </div>
    );
  }

  const visibleRows = expanded ? rows : rows.slice(0, collapsedRowCount);

  return (
    <div className="review-list">
      {visibleRows.map((row) => {
        const label = row.status === "valid" ? "✓" : row.status === "warn" ? "!" : "×";
        const title = row.status === "valid" ? `第 ${row.line} 行可发送` : `第 ${row.line} 行需要检查`;
        const problemText = row.problems.length ? row.problems.join(" / ") : row.address;
        const amountText = row.lamports > 0n ? formatAmount?.(row) || `${formatLamports(row.lamports)} SOL` : "金额无效";
        return (
          <div className={`review-item ${row.status === "valid" ? "" : row.status}`} key={`${row.line}-${row.address}-${row.amountRaw}`}>
            <span className="icon">{label}</span>
            <div>
              <div className="review-title">{title}</div>
              <div className="review-meta">{problemText}</div>
            </div>
            <span className="amount-chip">{amountText}</span>
          </div>
        );
      })}
      {rows.length > collapsedRowCount ? (
        <button
          aria-expanded={expanded}
          className="button ghost review-expand-button"
          type="button"
          onClick={() => setExpanded((current) => !current)}
        >{expanded ? "收起清单" : `展开全部 ${rows.length} 行`}</button>
      ) : null}
    </div>
  );
}
