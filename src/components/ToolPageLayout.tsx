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
  actionBar,
  actions,
  children,
  className = "",
  currentToolId,
  modeSwitch,
  stickyActions = false,
  status = "editing",
  statusLabel,
  title,
  walletControl
}: {
  actionBar?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  currentToolId: string;
  modeSwitch?: ReactNode;
  stickyActions?: boolean;
  status?: WorkbenchStatus;
  statusLabel?: string;
  title: string;
  walletControl?: ReactNode;
}) {
  const headingId = `${currentToolId}-page-title`;

  return (
    <div
      className="site-page site-tool-page"
      data-sticky-actions={stickyActions || undefined}
      data-tool={currentToolId}
    >
      <SiteHeader action={walletControl} currentToolId={currentToolId} />
      <div className="site-content" data-region="main">
        <div className="site-tool-scroll">
          <div className="site-tool-toolbar">
            <div className="site-tool-heading">
              <h1 id={headingId}>{title}</h1>
              {modeSwitch ? <div className="site-tool-mode-switch">{modeSwitch}</div> : null}
            </div>
            <div aria-label="页面状态与快捷操作" className="site-tool-heading__actions">
              <Badge
                aria-atomic="true"
                aria-live="polite"
                aria-label={statusLabel || STATUS_LABELS[status]}
                className="workbench-status"
                data-state={status}
                role="status"
                title={statusLabel || STATUS_LABELS[status]}
                variant="outline"
              >
                <span aria-hidden="true" className="workbench-status__dot" />
                <span className="workbench-status__label">{statusLabel || STATUS_LABELS[status]}</span>
              </Badge>
            </div>
            {actions ? <div className="site-tool-context" aria-label="网络行情">{actions}</div> : null}
          </div>
          <main className={`site-tool-shell ${className}`.trim()} id="main">
            {children}
            {!stickyActions && actionBar ? <div className="site-action-inline">{actionBar}</div> : null}
          </main>
          <SiteFooter />
        </div>
        {stickyActions && actionBar ? <div className="site-action-dock" aria-label="任务操作">{actionBar}</div> : null}
      </div>
    </div>
  );
}
