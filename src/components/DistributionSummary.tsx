import { useId, type ReactNode } from "react";

export type DistributionSummaryRow = {
  /** Marks a count that blocks sending, such as rows to fix or duplicates. */
  alert?: boolean;
  label: string;
  value: ReactNode;
};

// What the list amounts to, beside the settings that decide how it is sent.
export function DistributionSummary({ rows }: { rows: readonly DistributionSummaryRow[] }) {
  const titleId = useId();

  return (
    <section aria-labelledby={titleId} className="distribution-summary">
      <h3 className="workbench-form__group" id={titleId}>清单摘要</h3>
      <dl>
        {rows.map((row) => (
          <div data-alert={row.alert || undefined} key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
