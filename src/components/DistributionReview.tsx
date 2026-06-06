import type { DistributionRow } from "../lib/distribution";
import { formatLamports } from "../lib/amount";

export function DistributionReview({ rows }: { rows: DistributionRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="review-list">
        <div className="empty">粘贴清单后会显示逐行检查结果。</div>
      </div>
    );
  }

  return (
    <div className="review-list">
      {rows.slice(0, 12).map((row) => {
        const label = row.status === "valid" ? "✓" : row.status === "warn" ? "!" : "×";
        const title = row.status === "valid" ? `第 ${row.line} 行可发送` : `第 ${row.line} 行需要检查`;
        const problemText = row.problems.length ? row.problems.join(" / ") : row.address;
        const amountText = row.lamports > 0n ? `${formatLamports(row.lamports)} SOL` : "金额无效";
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
      {rows.length > 12 ? <div className="empty">还有 {rows.length - 12} 行未展开，统计已计入。</div> : null}
    </div>
  );
}
