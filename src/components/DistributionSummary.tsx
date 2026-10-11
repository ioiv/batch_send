import { useId, type ReactNode } from "react";
import { HelpTooltip } from "./HelpTooltip";
import "./distribution-workbench.css";

export type DistributionSummaryRow = {
  /** Marks a count that blocks sending, such as rows to fix or duplicates. */
  alert?: boolean;
  label: string;
  onClick?: () => void;
  value: ReactNode;
};

// What the list amounts to, beside the settings that decide how it is sent.
export function DistributionSummary({ rows, details }: { rows: readonly DistributionSummaryRow[]; details?: ReactNode }) {
  const titleId = useId();

  return (
    <section aria-labelledby={titleId} className="distribution-summary distribution-summary--compact">
      <h3 className="sr-only" id={titleId}>清单摘要</h3>
      <dl>
        {rows.map((row) => (
          <div data-alert={row.alert || undefined} key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.onClick ? (
              <button aria-label={`定位${row.label}：${row.value}`} onClick={row.onClick} type="button">{row.value}</button>
            ) : row.value}</dd>
          </div>
        ))}
      </dl>
      {details ? <HelpTooltip label="清单与费用详情">{details}</HelpTooltip> : null}
    </section>
  );
}
