import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";

export type WorkbenchStatus =
  | "editing"
  | "preflight"
  | "ready"
  | "running"
  | "success"
  | "error"
  | "uncertain";

const STATUS_LABELS: Record<WorkbenchStatus, string> = {
  editing: "编辑中",
  preflight: "预检中",
  ready: "可执行",
  running: "执行中",
  success: "已完成",
  error: "已阻断",
  uncertain: "状态待确认"
};

export function ToolPageLayout({
  actions,
  children,
  className = "",
  currentToolId,
  status = "editing",
  statusLabel,
  title
}: {
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  currentToolId: string;
  status?: WorkbenchStatus;
  statusLabel?: string;
  title: string;
}) {
  const headingId = `${currentToolId}-page-title`;

  return (
    <div className="site-page site-tool-page" data-tool={currentToolId}>
      <SiteHeader currentToolId={currentToolId} />
      <main className={`site-tool-shell ${className}`.trim()} id="main">
        <header className="site-tool-heading">
          <div className="site-tool-title-row">
            <h1 id={headingId}>{title}</h1>
            <div className="site-tool-heading__actions">
              <Badge
                aria-atomic="true"
                aria-live="polite"
                className="workbench-status"
                data-state={status}
                role="status"
                variant="outline"
              >
                <span aria-hidden="true" className="workbench-status__dot" />
                {statusLabel || STATUS_LABELS[status]}
              </Badge>
              {actions}
            </div>
          </div>
        </header>
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
