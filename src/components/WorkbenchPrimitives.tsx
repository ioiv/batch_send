import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown01Icon, Loading03Icon, PauseIcon, PlayIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
export { CompactNotice, NoticeTitle, NoticeDetail } from "./CompactNotice";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";

export function WorkbenchPanel({
  actions,
  children,
  className = "",
  footer,
  segmented = false,
  summary,
  title
}: {
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  footer?: ReactNode;
  segmented?: boolean;
  summary?: ReactNode;
  title: ReactNode;
}) {
  return (
    <Card className={`workbench-panel${footer ? " workbench-panel--actionable" : ""}${segmented ? " workbench-panel--segmented" : ""} overflow-visible ${className}`.trim()}>
      <CardHeader className="workbench-panel__header">
        <div className="workbench-panel__heading"><CardTitle>{title}</CardTitle>{summary ? <div className="workbench-panel__summary">{summary}</div> : null}</div>
        {actions ? <div className="workbench-panel__actions">{actions}</div> : null}
      </CardHeader>
      <CardContent className="workbench-panel__content">{children}</CardContent>
      {footer ? <CardFooter className="workbench-panel__footer">{footer}</CardFooter> : null}
    </Card>
  );
}

export function WorkbenchSection({ title, actions, summary, children, className = "" }: {
  title?: ReactNode;
  actions?: ReactNode;
  summary?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`workbench-section ${className}`.trim()}>
      {title || actions || summary ? (
        <div className="workbench-section__header">
          <div className="workbench-section__heading">{title ? <h2>{title}</h2> : null}{summary ? <div className="workbench-panel__summary">{summary}</div> : null}</div>
          {actions ? <div className="workbench-panel__actions">{actions}</div> : null}
        </div>
      ) : null}
      <div className="workbench-section__content">{children}</div>
    </section>
  );
}

export function ActionBar({ summary, feedback, secondaryActions, details, detailsAutoOpen = false, detailsStateKey, children, className = "" }: {
  summary?: ReactNode;
  feedback?: ReactNode;
  secondaryActions?: ReactNode;
  details?: ReactNode;
  detailsAutoOpen?: boolean;
  detailsStateKey?: string;
  children?: ReactNode;
  className?: string;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (detailsRef.current) detailsRef.current.open = detailsAutoOpen;
  }, [detailsAutoOpen, detailsStateKey]);
  return (
    <div className={`workbench-action-bar ${className}`.trim()}>
      {feedback ? <div className="workbench-action-bar__context">{feedback}</div> : null}
      {summary ? <div className="workbench-action-bar__summary">{summary}</div> : null}
      {secondaryActions ? <div className="workbench-action-bar__secondary">{secondaryActions}</div> : null}
      {details ? <details className="workbench-action-details" ref={detailsRef}>
        <summary>任务详情<HugeiconsIcon aria-hidden="true" icon={ArrowDown01Icon} size={14} strokeWidth={1.8} /></summary>
        <div className="workbench-action-details__body">
          <div className="workbench-action-details__records">{details}</div>
        </div>
      </details> : null}
      {children ? <div className="workbench-action-bar__actions">{children}</div> : null}
    </div>
  );
}

export function WorkbenchSummary({ items, className = "" }: {
  items: readonly { label: ReactNode; value: ReactNode }[];
  className?: string;
}) {
  return (
    <dl className={`workbench-inline-summary ${className}`.trim()}>
      {items.map((item, index) => <div key={index}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}
    </dl>
  );
}

export function ExecutionLogDialog({ children, disabled = false, title = "执行日志", triggerLabel = "查看日志", actions }: {
  children: ReactNode;
  disabled?: boolean;
  title?: string;
  triggerLabel?: string;
  actions?: ReactNode;
}) {
  return (
    <Dialog>
      <DialogTrigger disabled={disabled} render={<Button disabled={disabled} type="button" variant="outline" size="sm" />}>{triggerLabel}</DialogTrigger>
      <DialogContent className="execution-log-dialog">
        <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription className="sr-only">查看任务记录、交易状态和详细原因</DialogDescription></DialogHeader>
        {actions ? <div className="execution-log-dialog__actions">{actions}</div> : null}
        <div className="execution-log-dialog__content">{children}</div>
      </DialogContent>
    </Dialog>
  );
}

export function ReviewPanel({
  actions,
  autoOpen = false,
  children,
  className = "",
  defaultOpen = false,
  stateKey,
  summary,
  title
}: {
  actions?: ReactNode;
  autoOpen?: boolean;
  children: ReactNode;
  className?: string;
  defaultOpen?: boolean;
  stateKey?: string | number;
  summary: ReactNode;
  title: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen || autoOpen);
  const previousAutomaticState = useRef({ autoOpen, stateKey });
  const titleText = typeof title === "string" ? title : "详情";

  useEffect(() => {
    const previous = previousAutomaticState.current;
    if (previous.autoOpen === autoOpen && previous.stateKey === stateKey) return;
    previousAutomaticState.current = { autoOpen, stateKey };
    setOpen(autoOpen);
  }, [autoOpen, stateKey]);

  return (
    <Collapsible
      className={`workbench-review ${className}`.trim()}
      onOpenChange={setOpen}
      open={open}
    >
      <Card className="workbench-panel workbench-review__card overflow-visible">
        <CardHeader className="workbench-panel__header workbench-review__header">
          <div className="workbench-review__heading">
            <CardTitle>{title}</CardTitle>
            <div className="workbench-review__summary">{summary}</div>
          </div>
          <div className="workbench-review__controls">
            {actions}
            <CollapsibleTrigger
              aria-label={`${open ? "收起" : "展开"}${titleText}`}
              render={(
                <Button
                  className="workbench-review__trigger"
                  size="sm"
                  type="button"
                  variant="ghost"
                />
              )}
            >
              {open ? "收起" : "查看"}
              <HugeiconsIcon aria-hidden="true" className="disclosure-arrow" icon={ArrowDown01Icon} size={14} strokeWidth={1.8} />
            </CollapsibleTrigger>
          </div>
        </CardHeader>
        <CollapsibleContent className="workbench-review__content">
          <CardContent className="workbench-panel__content">{children}</CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

export function AdvancedSettings({
  children,
  disabled = false,
  label = "高级设置",
  summary,
  invalid = false
}: {
  children: ReactNode;
  disabled?: boolean;
  label?: string;
  summary?: ReactNode;
  invalid?: boolean;
}) {
  const [open, setOpen] = useState(invalid);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { if (invalid) setOpen(true); }, [invalid]);
  useEffect(() => {
    const element = root.current;
    const reveal = () => setOpen(true);
    element?.addEventListener("workbench-reveal", reveal);
    return () => element?.removeEventListener("workbench-reveal", reveal);
  }, []);
  return (
    <Collapsible className="advanced-settings" open={open} onOpenChange={setOpen} ref={root}>
      <div className="advanced-settings__heading">
      {summary ? <span className="advanced-settings__summary">{summary}</span> : null}
      <CollapsibleTrigger
        disabled={disabled}
        render={<Button className="advanced-settings__trigger" size="sm" type="button" variant="ghost" />}
      >
        {label}
        <HugeiconsIcon aria-hidden="true" className="disclosure-arrow" icon={ArrowDown01Icon} size={14} strokeWidth={1.8} />
      </CollapsibleTrigger>
      </div>
      <CollapsibleContent keepMounted data-visible={open} className="advanced-settings__content">{children}</CollapsibleContent>
    </Collapsible>
  );
}

export function ConfirmActionDialog({
  cancelLabel = "取消",
  confirmLabel,
  description,
  disabled = false,
  hideTrigger = false,
  onConfirm,
  open: controlledOpen,
  onOpenChange,
  returnFocusId,
  title,
  triggerAriaLabel,
  triggerClassName,
  triggerLabel,
  triggerSize,
  triggerVariant = "default"
}: {
  cancelLabel?: string;
  confirmLabel: string;
  description: ReactNode;
  disabled?: boolean;
  hideTrigger?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  returnFocusId?: string;
  onConfirm: () => void | Promise<void>;
  title: string;
  triggerAriaLabel?: string;
  triggerClassName?: string;
  triggerLabel: string;
  triggerSize?: "default" | "sm" | "lg" | "icon" | "icon-sm" | "icon-lg";
  triggerVariant?: "default" | "outline" | "secondary" | "ghost" | "destructive";
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (value: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(value);
    onOpenChange?.(value);
  };

  return (
    <AlertDialog onOpenChange={setOpen} open={open}>
      {!hideTrigger ? <AlertDialogTrigger
        disabled={disabled}
        render={(
          <Button
            aria-label={triggerAriaLabel}
            className={triggerClassName}
            disabled={disabled}
            size={triggerSize}
            type="button"
            variant={triggerVariant}
          />
        )}
      >
        {triggerLabel}
      </AlertDialogTrigger> : null}
      <AlertDialogContent finalFocus={returnFocusId ? () => document.getElementById(returnFocusId) : undefined}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription className="confirm-action-description" render={<div />}>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            disabled={disabled}
            onClick={() => {
              setOpen(false);
              void onConfirm();
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function ExecutionProgress({
  current,
  label = "执行进度",
  total
}: {
  current: number;
  label?: string;
  total: number;
}) {
  const safeTotal = Math.max(0, total);
  const safeCurrent = Math.min(Math.max(0, current), safeTotal || current);
  const value = safeTotal > 0 ? Math.round((safeCurrent / safeTotal) * 100) : 0;

  return (
    <Progress aria-label={label} value={value}>
      <ProgressLabel>{label}</ProgressLabel>
      <ProgressValue>{() => `${safeCurrent}/${safeTotal}`}</ProgressValue>
    </Progress>
  );
}

export function CollectionExecutionControls({
  current,
  label,
  onPausedChange,
  paused,
  total
}: {
  current: number;
  label: string;
  onPausedChange: (paused: boolean) => void;
  paused: boolean;
  total: number;
}) {
  return (
    <div
      aria-live="polite"
      className="collection-execution-controls"
      data-paused={paused || undefined}
      role="status"
    >
      <div className="collection-execution-controls__progress">
        <div className="collection-execution-controls__status">
          <HugeiconsIcon
            aria-hidden="true"
            className={paused ? "" : "animate-spin"}
            icon={paused ? PauseIcon : Loading03Icon}
            strokeWidth={2}
          />
          <span>{paused ? "已暂停，将在当前交易完成后停止启动新任务" : "归集中，请保持页面打开"}</span>
        </div>
        <ExecutionProgress
          current={current}
          label={paused ? `${label}（已暂停）` : label}
          total={total}
        />
      </div>
      <Button
        aria-pressed={paused}
        onClick={() => onPausedChange(!paused)}
        type="button"
        variant={paused ? "default" : "outline"}
      >
        <HugeiconsIcon aria-hidden="true" icon={paused ? PlayIcon : PauseIcon} strokeWidth={2} />
        {paused ? "继续归集" : "暂停归集"}
      </Button>
    </div>
  );
}

export type ResultColumn<Row> = {
  header: string;
  key: string;
  render: (row: Row) => ReactNode;
};

export function ResultTable<Row>({
  caption,
  columns,
  emptyLabel = "暂无结果",
  getRowKey,
  rows
}: {
  caption: string;
  columns: readonly ResultColumn<Row>[];
  emptyLabel?: string;
  getRowKey: (row: Row, index: number) => string;
  rows: readonly Row[];
}) {
  if (rows.length === 0) {
    return (
      <Empty className="workbench-empty">
        <EmptyHeader>
          <EmptyTitle>{emptyLabel}</EmptyTitle>
          <EmptyDescription className="sr-only">{caption}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <Table aria-label={caption}>
      <TableHeader>
        <TableRow>
          {columns.map((column) => <TableHead key={column.key}>{column.header}</TableHead>)}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => (
          <TableRow key={getRowKey(row, index)}>
            {columns.map((column) => <TableCell key={column.key}>{column.render(row)}</TableCell>)}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export type WalletChoice = {
  id: string;
  name: string;
};

export function WalletChooserDialog({
  choices,
  disabled = false,
  label,
  onChoose,
  selectedId,
  triggerLabel = "选择钱包"
}: {
  choices: readonly WalletChoice[];
  disabled?: boolean;
  label: string;
  onChoose: (id: string) => void;
  selectedId?: string | null;
  triggerLabel?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        disabled={disabled}
        render={<Button disabled={disabled} type="button" />}
      >
        {triggerLabel}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
          <DialogDescription className="sr-only">选择并连接已检测到的钱包</DialogDescription>
        </DialogHeader>
        <div className="wallet-choice-list" role="list">
          {choices.map((choice) => (
            <div key={choice.id} role="listitem">
              <Button
                className="wallet-choice"
                onClick={() => {
                  setOpen(false);
                  onChoose(choice.id);
                }}
                type="button"
                variant={choice.id === selectedId ? "secondary" : "outline"}
              >
                <span>{choice.name}</span>
                {choice.id === selectedId ? <Badge variant="outline">当前</Badge> : null}
              </Button>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
