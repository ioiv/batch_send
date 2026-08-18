import { useState, type ReactNode } from "react";
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
  title
}: {
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  footer?: ReactNode;
  title: ReactNode;
}) {
  return (
    <Card className={`workbench-panel${footer ? " workbench-panel--actionable" : ""} overflow-visible ${className}`.trim()}>
      <CardHeader className="workbench-panel__header">
        <CardTitle>{title}</CardTitle>
        {actions ? <div className="workbench-panel__actions">{actions}</div> : null}
      </CardHeader>
      <CardContent className="workbench-panel__content">{children}</CardContent>
      {footer ? <CardFooter className="workbench-panel__footer">{footer}</CardFooter> : null}
    </Card>
  );
}

export function AdvancedSettings({
  children,
  disabled = false,
  label = "高级设置"
}: {
  children: ReactNode;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <Collapsible className="advanced-settings">
      <CollapsibleTrigger
        disabled={disabled}
        render={<Button className="advanced-settings__trigger" type="button" variant="ghost" />}
      >
        {label}
        <span aria-hidden="true">⌄</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="advanced-settings__content">{children}</CollapsibleContent>
    </Collapsible>
  );
}

export function ConfirmActionDialog({
  cancelLabel = "取消",
  confirmLabel,
  description,
  disabled = false,
  onConfirm,
  title,
  triggerLabel,
  triggerVariant = "default"
}: {
  cancelLabel?: string;
  confirmLabel: string;
  description: ReactNode;
  disabled?: boolean;
  onConfirm: () => void | Promise<void>;
  title: string;
  triggerLabel: string;
  triggerVariant?: "default" | "outline" | "secondary" | "ghost" | "destructive";
}) {
  const [open, setOpen] = useState(false);

  return (
    <AlertDialog onOpenChange={setOpen} open={open}>
      <AlertDialogTrigger
        disabled={disabled}
        render={<Button disabled={disabled} type="button" variant={triggerVariant} />}
      >
        {triggerLabel}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription render={<div />}>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
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
