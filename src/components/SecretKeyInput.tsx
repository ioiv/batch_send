import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ChangeEvent
} from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { parseEvmPrivateKeyInput } from "../lib/evm-collection";
import {
  shortenTransactionHash,
  type CollectionResultStatus
} from "../lib/collection-results";
import { copyText } from "../lib/clipboard";
import { readSecretKeyFile, SecretKeyImportError } from "../lib/secret-key-import";
import { parseSolanaSourceKeys } from "../lib/sol-collection";

export type SecretKeyInputHandle = {
  clear: () => void;
  focus: () => void;
  read: () => string;
};

export type SecretKeyInputChangeReason = "import" | "remove" | "selection";

export type WalletExecutionItem = {
  amount?: string;
  asset: string;
  explorerUrl?: string;
  hash?: string;
  message: string;
  status: CollectionResultStatus;
};

const walletStatusLabels: Record<CollectionResultStatus, string> = {
  confirming: "确认中",
  error: "失败",
  pending: "待处理",
  scanning: "读取中",
  skipped: "已跳过",
  submitting: "提交中",
  success: "已完成"
};

const activeWalletStatuses = new Set<CollectionResultStatus>([
  "confirming",
  "pending",
  "scanning",
  "submitting"
]);

function getWalletSummaryStatus(statuses: readonly WalletExecutionItem[]): CollectionResultStatus {
  return statuses.find((item) => activeWalletStatuses.has(item.status))?.status
    || statuses.find((item) => item.status === "error")?.status
    || statuses.find((item) => item.status === "success")?.status
    || "skipped";
}

function getWalletStatusBreakdown(statuses: readonly WalletExecutionItem[]) {
  const success = statuses.filter((item) => item.status === "success").length;
  const failed = statuses.filter((item) => item.status === "error").length;
  const skipped = statuses.filter((item) => item.status === "skipped").length;
  const active = statuses.length - success - failed - skipped;
  return [
    success ? `成功 ${success}` : "",
    failed ? `失败 ${failed}` : "",
    active ? `处理中 ${active}` : "",
    skipped ? `跳过 ${skipped}` : ""
  ].filter(Boolean).join(" · ");
}

type ImportedWallet = {
  address: string;
  id: string;
  label?: string;
};

type ParsedSecretEntries = {
  issues: string[];
  lines: string[];
  wallets: ImportedWallet[];
};

const maximumSecretInputCharacters = 512 * 1024;
const maximumSecretInputLines = 1_000;
const importedWalletBatchSize = 40;

function countSecretInputLines(value: string) {
  let count = 0;
  let lineHasContent = false;
  for (let index = 0; index <= value.length; index += 1) {
    const character = value[index];
    if (character !== "\n" && character !== undefined) {
      if (!/\s/u.test(character)) lineHasContent = true;
      continue;
    }
    if (lineHasContent) {
      count += 1;
      if (count > maximumSecretInputLines) return count;
    }
    lineHasContent = false;
  }
  return count;
}

function parseSecretEntries(value: string, mode: "evm" | "solana"): ParsedSecretEntries {
  const sourceLines = value.split(/\r?\n/);
  if (mode === "evm") {
    const parsed = parseEvmPrivateKeyInput(value);
    return {
      issues: parsed.issues
        .filter((issue) => issue.code !== "duplicate-account")
        .map((issue) => `第 ${issue.line} 行：${issue.message}`),
      lines: parsed.accounts.map((account) => sourceLines[account.line - 1]?.trim() || "").filter(Boolean),
      wallets: parsed.accounts.map((account) => {
        const rawLine = sourceLines[account.line - 1]?.trim() || "";
        const firstComma = rawLine.indexOf(",");
        const secondComma = firstComma < 0 ? -1 : rawLine.indexOf(",", firstComma + 1);
        const hasExplicitLabel = firstComma > 0 && secondComma < 0 && Boolean(rawLine.slice(0, firstComma).trim());
        return {
          address: account.address,
          id: account.address.toLowerCase(),
          ...(hasExplicitLabel ? { label: account.label } : {})
        };
      })
    };
  }

  const parsed = parseSolanaSourceKeys(value);
  return {
    issues: parsed.errors.map((issue) => issue.message),
    lines: parsed.sources.map((source) => sourceLines[source.line - 1]?.trim() || "").filter(Boolean),
    wallets: parsed.sources.map((source) => ({
      address: source.address,
      id: source.address,
      ...(source.label ? { label: source.label } : {})
    }))
  };
}

function mergeUniqueSecretEntries(
  existing: ParsedSecretEntries,
  incoming: ParsedSecretEntries
): Pick<ParsedSecretEntries, "lines" | "wallets"> {
  const lines = [...existing.lines];
  const wallets = [...existing.wallets];
  const seenIds = new Set(wallets.map((wallet) => wallet.id));

  incoming.wallets.forEach((wallet, index) => {
    if (seenIds.has(wallet.id)) return;
    seenIds.add(wallet.id);
    wallets.push(wallet);
    lines.push(incoming.lines[index]);
  });

  return { lines, wallets };
}

function shortenAddress(value: string, edge = 8) {
  return value.length > edge * 2 + 1 ? `${value.slice(0, edge)}…${value.slice(-edge)}` : value;
}

function WalletStatusSummary({
  accessibleName,
  address,
  label,
  statuses
}: {
  accessibleName: string;
  address: string;
  label?: string;
  statuses: readonly WalletExecutionItem[];
}) {
  const summaryStatus = getWalletSummaryStatus(statuses);
  const firstStatus = statuses[0];
  const firstStatusSummary = `${firstStatus.asset}${firstStatus.amount ? ` · ${firstStatus.amount}` : ""}`;
  const nftStandard = statuses.some((status) => status.asset.startsWith("ERC1155"))
    ? "ERC1155"
    : statuses.some((status) => status.asset.startsWith("ERC721")) ? "ERC721" : null;
  const summaryText = nftStandard
    ? nftStandard === "ERC1155"
      ? `ERC1155 · ${statuses.length} 个 Token ID`
      : `ERC721 · ${statuses.length} 个`
    : statuses.length === 1 ? firstStatusSummary : `${statuses.length} 项结果`;
  const statusBreakdown = getWalletStatusBreakdown(statuses);
  const transactions = new Map<string, { explorerUrl: string; hash: string }>();
  statuses.forEach((status) => {
    if (status.hash && status.explorerUrl) {
      transactions.set(status.hash, { explorerUrl: status.explorerUrl, hash: status.hash });
    }
  });
  const singleTransaction = transactions.size === 1 ? [...transactions.values()][0] : null;

  return (
    <div aria-label={`${accessibleName} 归集状态`} className="imported-wallet-status-summary">
      <Badge
        data-status={summaryStatus}
        variant={summaryStatus === "error" ? "destructive" : "outline"}
      >
        {walletStatusLabels[summaryStatus]}
      </Badge>
      <strong title={summaryText}>
        {summaryText}
      </strong>
      {singleTransaction ? (
        <a
          aria-label={`查看交易 ${singleTransaction.hash}`}
          href={singleTransaction.explorerUrl}
          rel="noreferrer"
          target="_blank"
          title={singleTransaction.hash}
        >{shortenTransactionHash(singleTransaction.hash)}</a>
      ) : null}
      <Sheet>
        <SheetTrigger
          render={(
            <Button
              aria-label={`查看 ${accessibleName} 归集详情`}
              className="imported-wallet-status-summary__details"
              size="sm"
              type="button"
              variant="ghost"
            />
          )}
        >
          详情
        </SheetTrigger>
        <SheetContent className="wallet-status-sheet">
          <SheetHeader className="wallet-status-sheet__header">
            <SheetTitle>归集详情</SheetTitle>
            <SheetDescription>
              {label ? <span>{label}</span> : null}
              <code title={address}>{address}</code>
            </SheetDescription>
          </SheetHeader>
          <div className="wallet-status-sheet__summary" aria-label="钱包归集结果摘要">
            <span><strong>{statuses.length}</strong> 项结果</span>
            {statusBreakdown ? <span>{statusBreakdown}</span> : null}
            <Badge
              data-status={summaryStatus}
              variant={summaryStatus === "error" ? "destructive" : "outline"}
            >
              {walletStatusLabels[summaryStatus]}
            </Badge>
          </div>
          <div className="wallet-status-sheet__results" role="list">
            {statuses.map((status, index) => (
              <article
                className="wallet-status-detail"
                data-status={status.status}
                key={`${status.asset}-${index}`}
                role="listitem"
              >
                <div className="wallet-status-detail__heading">
                  <Badge variant={status.status === "error" ? "destructive" : "outline"}>
                    {walletStatusLabels[status.status]}
                  </Badge>
                  <strong>{status.asset}{status.amount ? ` · ${status.amount}` : ""}</strong>
                </div>
                <p>{status.message}</p>
                {status.explorerUrl && status.hash ? (
                  <a
                    aria-label={`查看交易 ${status.hash}`}
                    href={status.explorerUrl}
                    rel="noreferrer"
                    target="_blank"
                    title={status.hash}
                  >{shortenTransactionHash(status.hash)}</a>
                ) : status.hash ? <code title={status.hash}>{shortenTransactionHash(status.hash)}</code> : null}
              </article>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

export const SecretKeyInput = forwardRef<SecretKeyInputHandle, {
  compactStatuses?: boolean;
  disabled?: boolean;
  mode: "evm" | "solana";
  onDirty?: (reason: SecretKeyInputChangeReason, address?: string) => void;
  onImportingChange?: (importing: boolean) => void;
  onLineCountChange?: (lineCount: number) => void;
  walletBalances?: Readonly<Record<
    string,
    readonly { amount: string; contractAddress?: string; symbol: string }[]
  >>;
  walletStatuses?: Readonly<Record<string, readonly WalletExecutionItem[]>>;
}>(function SecretKeyInput({
  compactStatuses = false,
  disabled = false,
  mode,
  onDirty,
  onImportingChange,
  onLineCountChange,
  walletBalances = {},
  walletStatuses = {}
}, ref) {
  const disabledRef = useRef(disabled);
  const draftTextareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importingRef = useRef(false);
  const importRequestRef = useRef(0);
  const copyFeedbackTimerRef = useRef<number | null>(null);
  const secretStoreRef = useRef<HTMLTextAreaElement>(null);
  const selectedIdsRef = useRef<Set<string>>(new Set());
  const walletListRef = useRef<HTMLDivElement>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draftLineCount, setDraftLineCount] = useState(0);
  const [fileStatus, setFileStatus] = useState<
    | { kind: "error" | "idle" | "loading"; message: string }
    | { fileName: string; kind: "success"; lineCount: number }
  >({ kind: "idle", message: "可粘贴私钥，或选择 TXT / CSV / JSON 文件" });
  const [importIssues, setImportIssues] = useState<string[]>([]);
  const [copyFeedback, setCopyFeedback] = useState<{
    status: "error" | "success";
    walletId: string;
  } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [visibleWalletCount, setVisibleWalletCount] = useState(importedWalletBatchSize);
  const [wallets, setWallets] = useState<ImportedWallet[]>([]);
  disabledRef.current = disabled;
  selectedIdsRef.current = selectedIds;

  const updateSelectedIds = useCallback((nextSelectedIds: Set<string>) => {
    selectedIdsRef.current = nextSelectedIds;
    setSelectedIds(nextSelectedIds);
    onLineCountChange?.(nextSelectedIds.size);
  }, [onLineCountChange]);

  const setImportActive = useCallback((active: boolean) => {
    if (importingRef.current === active) return;
    importingRef.current = active;
    onImportingChange?.(active);
  }, [onImportingChange]);

  const resetDraft = useCallback(() => {
    importRequestRef.current += 1;
    setImportActive(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (draftTextareaRef.current) draftTextareaRef.current.value = "";
    setDraftLineCount(0);
    setImportIssues([]);
    setFileStatus({ kind: "idle", message: "可粘贴私钥，或选择 TXT / CSV / JSON 文件" });
  }, [setImportActive]);

  const clearDomValue = useCallback(() => {
    resetDraft();
    if (copyFeedbackTimerRef.current !== null) {
      window.clearTimeout(copyFeedbackTimerRef.current);
      copyFeedbackTimerRef.current = null;
    }
    setCopyFeedback(null);
    if (secretStoreRef.current) secretStoreRef.current.value = "";
    setWallets([]);
    setVisibleWalletCount(importedWalletBatchSize);
    updateSelectedIds(new Set());
    setDialogOpen(false);
  }, [resetDraft, updateSelectedIds]);

  useEffect(() => {
    const secretStoreElement = secretStoreRef.current;
    const draftElement = draftTextareaRef.current;
    const clearRestoredValue = (event: PageTransitionEvent) => {
      if (event.persisted) clearDomValue();
    };
    window.addEventListener("pagehide", clearDomValue);
    window.addEventListener("pageshow", clearRestoredValue);
    return () => {
      window.removeEventListener("pagehide", clearDomValue);
      window.removeEventListener("pageshow", clearRestoredValue);
      resetDraft();
      if (secretStoreElement) secretStoreElement.value = "";
      if (draftElement) draftElement.value = "";
    };
  }, [clearDomValue, resetDraft]);

  useImperativeHandle(ref, () => ({
    clear: clearDomValue,
    focus() {
      setDialogOpen(true);
      window.requestAnimationFrame(() => draftTextareaRef.current?.focus());
    },
    read() {
      const storedValue = secretStoreRef.current?.value || "";
      if (!storedValue) return "";
      const parsed = parseSecretEntries(storedValue, mode);
      const selected = selectedIdsRef.current;
      return parsed.wallets
        .map((wallet, index) => selected.has(wallet.id) ? parsed.lines[index] : "")
        .filter(Boolean)
        .join("\n");
    }
  }), [clearDomValue, mode]);

  useEffect(() => {
    if (!disabled) return;
    resetDraft();
    setDialogOpen(false);
  }, [disabled, resetDraft]);

  const handleDialogOpenChange = (open: boolean) => {
    if (disabled && open) return;
    setDialogOpen(open);
    if (!open) {
      resetDraft();
      return;
    }
    window.requestAnimationFrame(() => draftTextareaRef.current?.focus());
  };

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;

    const requestId = importRequestRef.current + 1;
    importRequestRef.current = requestId;
    setImportActive(true);
    setImportIssues([]);
    setFileStatus({ kind: "loading", message: "正在本地读取文件…" });

    try {
      const imported = await readSecretKeyFile(file, mode);
      if (requestId !== importRequestRef.current || disabledRef.current || !draftTextareaRef.current) return;

      draftTextareaRef.current.value = imported.value;
      setDraftLineCount(imported.lineCount);
      setFileStatus({
        fileName: imported.fileName,
        kind: "success",
        lineCount: imported.lineCount
      });
    } catch (error) {
      if (requestId !== importRequestRef.current) return;
      setFileStatus({
        kind: "error",
        message: error instanceof SecretKeyImportError
          ? error.message
          : "文件导入失败，请重新选择文件"
      });
    } finally {
      input.value = "";
      if (requestId === importRequestRef.current) setImportActive(false);
    }
  };

  const importWallets = () => {
    const draft = draftTextareaRef.current?.value || "";
    if (!draft.trim()) {
      setImportIssues(["请粘贴私钥或选择钱包文件"]);
      draftTextareaRef.current?.focus();
      return;
    }

    const existingValue = secretStoreRef.current?.value || "";
    const existing = existingValue.trim()
      ? parseSecretEntries(existingValue, mode)
      : { issues: [], lines: [], wallets: [] };
    const incoming = parseSecretEntries(draft, mode);
    if (incoming.issues.length || !incoming.wallets.length) {
      setImportIssues(incoming.issues.length ? incoming.issues : ["没有识别到有效的钱包私钥"]);
      return;
    }

    const parsed = mergeUniqueSecretEntries(existing, incoming);
    if (parsed.wallets.length > maximumSecretInputLines) {
      setImportIssues([
        `来源钱包总数不能超过 ${maximumSecretInputLines.toLocaleString("zh-CN")} 个，请删除部分钱包后再导入`
      ]);
      return;
    }

    if (secretStoreRef.current) secretStoreRef.current.value = parsed.lines.join("\n");
    const existingIds = new Set(wallets.map((wallet) => wallet.id));
    const nextSelectedIds = new Set(selectedIdsRef.current);
    parsed.wallets.forEach((wallet) => {
      if (!existingIds.has(wallet.id)) nextSelectedIds.add(wallet.id);
    });
    setWallets(parsed.wallets);
    setVisibleWalletCount((current) => Math.min(
      parsed.wallets.length,
      Math.max(current, importedWalletBatchSize)
    ));
    updateSelectedIds(nextSelectedIds);
    if (parsed.wallets.some((wallet) => !existingIds.has(wallet.id))) onDirty?.("import");
    setDialogOpen(false);
    resetDraft();
  };

  const copyWalletAddress = async (wallet: ImportedWallet) => {
    const copied = await copyText(wallet.address);
    setCopyFeedback({ status: copied ? "success" : "error", walletId: wallet.id });
    if (copyFeedbackTimerRef.current !== null) {
      window.clearTimeout(copyFeedbackTimerRef.current);
    }
    copyFeedbackTimerRef.current = window.setTimeout(() => {
      setCopyFeedback(null);
      copyFeedbackTimerRef.current = null;
    }, 1_600);
  };

  const toggleWallet = (walletId: string, checked: boolean) => {
    const nextSelectedIds = new Set(selectedIdsRef.current);
    if (checked) nextSelectedIds.add(walletId);
    else nextSelectedIds.delete(walletId);
    updateSelectedIds(nextSelectedIds);
    onDirty?.("selection");
  };

  const removeWallet = (walletId: string) => {
    const storedValue = secretStoreRef.current?.value || "";
    const parsed = parseSecretEntries(storedValue, mode);
    const removedWallet = parsed.wallets.find((wallet) => wallet.id === walletId);
    const nextLines = parsed.wallets
      .map((wallet, index) => wallet.id === walletId ? "" : parsed.lines[index])
      .filter(Boolean);
    const nextValue = nextLines.join("\n");
    const reparsed = parseSecretEntries(nextValue, mode);
    if (secretStoreRef.current) secretStoreRef.current.value = nextValue;
    setWallets(reparsed.wallets);
    const nextSelectedIds = new Set(selectedIdsRef.current);
    nextSelectedIds.delete(walletId);
    updateSelectedIds(nextSelectedIds);
    onDirty?.("remove", removedWallet?.address);
  };

  const toggleAllWallets = () => {
    const allSelected = wallets.length > 0 && selectedIdsRef.current.size === wallets.length;
    updateSelectedIds(allSelected ? new Set() : new Set(wallets.map((wallet) => wallet.id)));
    onDirty?.("selection");
  };

  const loadMoreWallets = () => {
    setVisibleWalletCount((current) => Math.min(wallets.length, current + importedWalletBatchSize));
  };

  const handleWalletListScroll = () => {
    const list = walletListRef.current;
    if (!list || visibleWalletCount >= wallets.length) return;
    if (list.scrollHeight - list.scrollTop - list.clientHeight <= 48) loadMoreWallets();
  };

  const placeholder = mode === "evm"
    ? "每行一个私钥，或：备注,0x私钥\n示例：运营钱包 01,0x…"
    : "每行一个 Base58 / JSON 数组私钥，或：备注,私钥\n示例：运营钱包 01,[12,34,…]";
  const visibleWallets = wallets.slice(0, visibleWalletCount);
  const hasMoreWallets = visibleWalletCount < wallets.length;
  const allWalletsSelected = wallets.length > 0 && selectedIds.size === wallets.length;

  return (
    <Field className="secret-input">
      <textarea
        aria-hidden="true"
        autoComplete="off"
        className="secret-dom-store"
        data-1p-ignore="true"
        data-bwignore="true"
        maxLength={maximumSecretInputCharacters}
        ref={secretStoreRef}
        tabIndex={-1}
      />
      <Input
        accept=".txt,.csv,.json,text/plain,text/csv,application/json"
        aria-hidden="true"
        className="sr-only"
        disabled={disabled}
        onChange={handleFileChange}
        ref={fileInputRef}
        tabIndex={-1}
        type="file"
      />

      <div className="secret-input-heading">
        <FieldLabel>来源钱包</FieldLabel>
        <Badge aria-live="polite" variant="outline">
          {wallets.length ? `已选择 ${selectedIds.size} / ${wallets.length}` : "尚未导入"}
        </Badge>
      </div>

      <Dialog onOpenChange={handleDialogOpenChange} open={dialogOpen}>
        <DialogTrigger
          disabled={disabled}
          render={<Button className="secret-file-button" disabled={disabled} type="button" variant="outline" />}
        >
          {wallets.length ? "继续导入钱包" : "导入钱包"}
        </DialogTrigger>
        <DialogContent className="secret-import-dialog">
          <DialogHeader>
            <DialogTitle>导入来源钱包</DialogTitle>
            <DialogDescription>
              私钥仅在当前页面内存中解析和签名。关闭或刷新页面后会清除。
            </DialogDescription>
          </DialogHeader>
          <Field>
            <div className="secret-import-draft-heading">
              <FieldLabel htmlFor={`${mode}-secret-draft`}>粘贴私钥</FieldLabel>
              <Badge
                aria-live="polite"
                data-status={draftLineCount > maximumSecretInputLines ? "error" : "ready"}
                variant="outline"
              >
                {draftLineCount
                  ? `${draftLineCount.toLocaleString("zh-CN")} / ${maximumSecretInputLines.toLocaleString("zh-CN")}`
                  : `最多 ${maximumSecretInputLines.toLocaleString("zh-CN")} 个`}
              </Badge>
            </div>
            <Textarea
              autoCapitalize="none"
              autoComplete="off"
              className="secret-import-textarea"
              data-1p-ignore="true"
              data-bwignore="true"
              id={`${mode}-secret-draft`}
              maxLength={maximumSecretInputCharacters}
              onInput={(event) => {
                setDraftLineCount(countSecretInputLines(event.currentTarget.value));
                setImportIssues([]);
                setFileStatus({ kind: "idle", message: "已手动编辑" });
              }}
              placeholder={placeholder}
              ref={draftTextareaRef}
              rows={8}
              spellCheck={false}
            />
            <FieldDescription>
              {draftLineCount > maximumSecretInputLines
                ? `超过 ${maximumSecretInputLines.toLocaleString("zh-CN")} 行上限，请减少后再导入`
                : draftLineCount
                  ? `${draftLineCount.toLocaleString("zh-CN")} 个钱包待解析`
                  : "支持批量粘贴；数量较多时也可直接选择本地文件"}
            </FieldDescription>
          </Field>
          <div className="secret-import-file-row">
            <Button onClick={() => fileInputRef.current?.click()} type="button" variant="outline">
              选择钱包文件
            </Button>
            <span aria-live="polite" className="secret-file-status">
              {fileStatus.kind === "success"
                ? `${fileStatus.fileName} · 已读取 ${fileStatus.lineCount} 行`
                : fileStatus.message}
            </span>
          </div>
          {fileStatus.kind === "error" ? (
            <Alert variant="destructive"><AlertDescription>{fileStatus.message}</AlertDescription></Alert>
          ) : null}
          {importIssues.length ? (
            <Alert variant="destructive">
              <AlertDescription>
                <ul>{importIssues.slice(0, 6).map((issue) => <li key={issue}>{issue}</li>)}</ul>
              </AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button onClick={() => handleDialogOpenChange(false)} type="button" variant="outline">取消</Button>
            <Button
              aria-label="确认导入"
              disabled={!draftLineCount || draftLineCount > maximumSecretInputLines}
              onClick={importWallets}
              type="button"
            >
              {draftLineCount ? `导入 ${draftLineCount.toLocaleString("zh-CN")} 个钱包` : "确认导入"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {wallets.length ? (
        <div aria-label="已导入来源钱包" className="imported-wallet-browser">
          <div aria-label="钱包列表控制" className="imported-wallet-toolbar">
            <span aria-live="polite">
              已显示 {visibleWallets.length} / {wallets.length}
            </span>
            <div className="imported-wallet-toolbar__actions">
              {hasMoreWallets ? (
                <Button disabled={disabled} onClick={loadMoreWallets} size="sm" type="button" variant="ghost">
                  加载更多钱包
                </Button>
              ) : null}
              <Button disabled={disabled} onClick={toggleAllWallets} size="sm" type="button" variant="ghost">
                {allWalletsSelected ? "取消全选" : "全选"}
              </Button>
            </div>
          </div>
          <div
            className="imported-wallet-list"
            onScroll={handleWalletListScroll}
            ref={walletListRef}
            role="list"
          >
            {visibleWallets.map((wallet) => {
              const balances = walletBalances[wallet.id]
                || walletBalances[wallet.address]
                || walletBalances[wallet.address.toLowerCase()]
                || [];
              const statuses = walletStatuses[wallet.id]
                || walletStatuses[wallet.address]
                || walletStatuses[wallet.address.toLowerCase()]
                || [];
              const accessibleName = [wallet.label, wallet.address].filter(Boolean).join(" ");
              return (
                <div
                  className="imported-wallet-row"
                  data-compact-status={compactStatuses && statuses.length ? true : undefined}
                  key={wallet.id}
                  role="listitem"
                >
                  <Checkbox
                    aria-label={`选择 ${accessibleName}`}
                    checked={selectedIds.has(wallet.id)}
                    disabled={disabled}
                    onCheckedChange={(checked) => toggleWallet(wallet.id, checked === true)}
                  />
                  <div className="imported-wallet-identity">
                    {wallet.label ? <strong>{wallet.label}</strong> : null}
                    <div className="imported-wallet-address">
                      <code title={wallet.address}>{shortenAddress(wallet.address)}</code>
                      <Button
                        aria-label={`复制 ${accessibleName} 地址`}
                        className="imported-wallet-copy"
                        onClick={() => void copyWalletAddress(wallet)}
                        size="xs"
                        title="复制完整地址"
                        type="button"
                        variant="ghost"
                      >
                        {copyFeedback?.walletId === wallet.id
                          ? copyFeedback.status === "success" ? "已复制" : "复制失败"
                          : "复制"}
                      </Button>
                    </div>
                  </div>
                  {balances.length ? (
                    <div aria-label={`${accessibleName} 余额`} className="imported-wallet-balances">
                      {balances.map((balance) => (
                        <span key={balance.contractAddress || balance.symbol}>
                          <strong>{balance.amount}</strong>
                          <small>{balance.symbol}</small>
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {statuses.length ? (
                    compactStatuses ? (
                      <WalletStatusSummary
                        accessibleName={accessibleName}
                        address={wallet.address}
                        label={wallet.label}
                        statuses={statuses}
                      />
                    ) : (
                      <div aria-label={`${accessibleName} 归集状态`} className="imported-wallet-statuses">
                        {statuses.map((status, index) => (
                          <div className="imported-wallet-status" data-status={status.status} key={`${status.asset}-${index}`}>
                            <div className="imported-wallet-status__heading">
                              <Badge variant={status.status === "error" ? "destructive" : "outline"}>
                                {walletStatusLabels[status.status]}
                              </Badge>
                              <strong>{status.asset}{status.amount ? ` · ${status.amount}` : ""}</strong>
                              {status.explorerUrl && status.hash ? (
                                <a href={status.explorerUrl} rel="noreferrer" target="_blank">查看交易</a>
                              ) : null}
                            </div>
                            <span title={status.message}>{status.message}</span>
                          </div>
                        ))}
                      </div>
                    )
                  ) : null}
                  <Button
                    aria-label={`删除 ${accessibleName}`}
                    className="imported-wallet-remove"
                    disabled={disabled}
                    onClick={() => removeWallet(wallet.id)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    删除
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="secret-empty-state">导入后将在这里显示钱包地址，可勾选或删除。</p>
      )}

      <FieldDescription className="sr-only">
        私钥只保留在当前 DOM 中；主页面仅展示派生的钱包地址。
      </FieldDescription>
    </Field>
  );
});
