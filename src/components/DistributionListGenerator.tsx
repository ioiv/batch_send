import { useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Field, FieldLabel } from "@/components/ui/field";
import { HugeiconsIcon } from "@hugeicons/react";
import { Upload01Icon } from "@hugeicons/core-free-icons";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { DistributionListEditor } from "./DistributionListEditor";
import { HelpTooltip } from "./HelpTooltip";
import { ConfirmActionDialog } from "./WorkbenchPrimitives";
import { getDuplicateAddressKey, type AddressKind } from "../lib/address";
import {
  dedupeDistributionAddresses,
  generateDistributionList,
  getDistributionAmountStep,
  importDistributionFileText,
  type DistributionAmountMode,
  type GeneratedDistributionList,
  type ImportedDistributionFile
} from "../lib/distribution-generator";
import {
  beginLocalFileImport,
  cancelLocalFileImport,
  isCurrentLocalFileImport,
  type LocalFileImportEpoch
} from "../lib/local-file-import";
import { readWalletXlsxFile } from "../lib/wallet-xlsx-import";
import "./distribution-workbench.css";

export type DistributionListGeneratorHandle = {
  focusProblem: (kind: "invalid" | "duplicate") => void;
};

type DistributionListGeneratorProps = {
  addressKind: AddressKind;
  decimals: number;
  controlRef?: Ref<DistributionListGeneratorHandle>;
  disabled?: boolean;
  generationDisabled?: boolean;
  initialAddresses?: string;
  initialFixedAmount?: string;
  onDirty?: () => void;
  onImportingChange?: (importing: boolean) => void;
  onResultChange: (result: GeneratedDistributionList) => void;
  symbol: string;
  unavailableMessage?: string;
  validateAddress?: (address: string) => boolean;
};

const randomEntropyBytes = 128;
const randomEntropyRange = 1n << BigInt(randomEntropyBytes * 8);
const maximumDistributionFileBytes = 512 * 1024;
const recipientBatchSize = 40;

function createRandomEntropy() {
  const bytes = crypto.getRandomValues(new Uint8Array(randomEntropyBytes));
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) + BigInt(byte);
  return value;
}

function extendRandomEntropies(
  addresses: string,
  addressKind: AddressKind,
  current: Map<string, bigint>
) {
  const next = new Map(current);
  addresses.split(/\n+/).map((address) => address.trim()).filter(Boolean).forEach((address) => {
    const key = getDuplicateAddressKey(address, addressKind);
    if (!next.has(key)) next.set(key, createRandomEntropy());
  });
  return next;
}

function formatStepUnits(units: bigint, decimals: number) {
  if (decimals === 0) return units.toString();

  const padded = units.toString().padStart(decimals + 1, "0");
  const integer = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${integer}.${fraction}` : integer;
}

function comparableAmount(value: string) {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d*)?$/.test(normalized)) return normalized;
  const [whole, fraction = ""] = normalized.split(".");
  return `${whole.replace(/^0+(?=\d)/, "")}.${fraction.replace(/0+$/, "")}`;
}

function sourceAddress(row: string, mode: DistributionAmountMode) {
  return (mode === "per-row" ? row.split(",")[0] : row).trim();
}

export function DistributionListGenerator({
  addressKind,
  decimals,
  controlRef,
  disabled = false,
  generationDisabled = false,
  initialAddresses = "",
  initialFixedAmount = "0.1",
  onDirty,
  onImportingChange,
  onResultChange,
  symbol,
  unavailableMessage,
  validateAddress
}: DistributionListGeneratorProps) {
  const instanceId = useId().replace(/:/g, "");
  const disabledRef = useRef(disabled);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addressInputRef = useRef<HTMLTextAreaElement>(null);
  const importDraftRef = useRef<HTMLTextAreaElement>(null);
  const importDraftValueRef = useRef("");
  const workbookSheetsRef = useRef<{ name: string; text: string }[]>([]);
  const normalizedImportEpochRef = useRef(0);
  const importEpochRef = useRef<LocalFileImportEpoch>({ current: 0 });
  const importingRef = useRef(false);
  const [addresses, setAddresses] = useState(initialAddresses);
  const [mode, setMode] = useState<DistributionAmountMode>("fixed");
  const [fixedAmount, setFixedAmount] = useState(initialFixedAmount);
  const [minAmount, setMinAmount] = useState("0.5");
  const [maxAmount, setMaxAmount] = useState("1");
  const [randomEntropies, setRandomEntropies] = useState<Map<string, bigint>>(() => new Map());
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState("");
  const [pendingImport, setPendingImport] = useState<ImportedDistributionFile | null>(null);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importError, setImportError] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [workbookSheetNames, setWorkbookSheetNames] = useState<string[]>([]);
  const [selectedWorkbookSheet, setSelectedWorkbookSheet] = useState(0);
  const [addressEditorOpen, setAddressEditorOpen] = useState(false);
  const [walletQuery, setWalletQuery] = useState("");
  const [visibleWalletCount, setVisibleWalletCount] = useState(recipientBatchSize);
  const [excludedKeys, setExcludedKeys] = useState<Set<string>>(() => new Set());
  const [importUndo, setImportUndo] = useState<{ addresses: string; mode: DistributionAmountMode; fixedAmount: string; minAmount: string; maxAmount: string; randomEntropies: Map<string, bigint>; excludedKeys: Set<string> } | null>(null);
  disabledRef.current = disabled;

  const setImportActive = useCallback((active: boolean) => {
    if (importingRef.current === active) return;
    importingRef.current = active;
    setImporting(active);
    onImportingChange?.(active);
  }, [onImportingChange]);

  const cancelPendingImport = useCallback(() => {
    cancelLocalFileImport(importEpochRef.current);
    workbookSheetsRef.current = [];
    setWorkbookSheetNames([]);
    setSelectedWorkbookSheet(0);
    setImportActive(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [setImportActive]);
  const randomBigInt = useMemo(() => {
    if (mode !== "random") return undefined;

    return (min: bigint, max: bigint, address: string) => {
      const key = getDuplicateAddressKey(address, addressKind);
      const entropy = randomEntropies.get(key) ?? 0n;
      const range = max - min + 1n;
      const selectedOffset = entropy * range / randomEntropyRange;
      return min + selectedOffset;
    };
  }, [addressKind, mode, randomEntropies]);
  const generationArgs = useMemo(() => ({
    addresses,
    addressKind,
    decimals,
    fixedAmount,
    maxAmount,
    minAmount,
    mode,
    randomBigInt,
    validateAddress
  }), [addressKind, addresses, decimals, fixedAmount, maxAmount, minAmount, mode, randomBigInt, validateAddress]);
  const fullResult = useMemo(() => generateDistributionList(generationArgs), [generationArgs]);
  const result = useMemo(() => excludedKeys.size ? generateDistributionList({
    ...generationArgs,
    addresses: addresses.split("\n").filter(row => !excludedKeys.has(getDuplicateAddressKey(sourceAddress(row, mode), addressKind))).join("\n")
  }) : fullResult, [addressKind, addresses, excludedKeys, fullResult, generationArgs, mode]);
  const fixedStep = formatStepUnits(getDistributionAmountStep(fixedAmount, decimals), decimals);
  const randomStep = formatStepUnits(getDistributionAmountStep(minAmount, maxAmount, decimals), decimals);

  useEffect(() => {
    onResultChange(result);
  }, [onResultChange, result]);

  useEffect(() => {
    if (disabled) { cancelPendingImport(); setPendingImport(null); setImportDialogOpen(false); importDraftValueRef.current = ""; if (importDraftRef.current) importDraftRef.current.value = ""; }
  }, [cancelPendingImport, disabled]);

  useEffect(() => {
    const clearDraft = () => {
      cancelLocalFileImport(importEpochRef.current);
      workbookSheetsRef.current = [];
      importDraftValueRef.current = "";
      if (importDraftRef.current) importDraftRef.current.value = "";
    };
    const handlePageHide = () => { clearDraft(); setWorkbookSheetNames([]); setSelectedWorkbookSheet(0); setImportActive(false); setImportDialogOpen(false); setPendingImport(null); };
    window.addEventListener("pagehide", handlePageHide);
    return () => { window.removeEventListener("pagehide", handlePageHide); clearDraft(); };
  }, [setImportActive]);

  const regenerateRandomAmounts = (sourceAddresses = addresses) => {
    cancelPendingImport();
    setImportUndo(null);
    onDirty?.();
    setRandomEntropies(extendRandomEntropies(sourceAddresses, addressKind, new Map()));
  };

  const updateValue = (setter: (value: string) => void, value: string) => {
    cancelPendingImport();
    setImportUndo(null);
    onDirty?.();
    setter(value);
  };

  const updateAddresses = (value: string, cancelImport = true) => {
    if (cancelImport) cancelPendingImport();
    setImportUndo(null);
    onDirty?.();
    setImportMessage("");
    setAddresses(value);
    const nextKeys = new Set(value.split("\n").map(row => getDuplicateAddressKey(sourceAddress(row, mode), addressKind)));
    setExcludedKeys(current => new Set([...current].filter(key => nextKeys.has(key))));
    if (mode === "random") {
      setRandomEntropies(extendRandomEntropies(value, addressKind, randomEntropies));
    }
  };

  const identifyImport = (text: string, format?: string, emptyMessage?: string) => {
    setPendingImport(null);
    setImportError("");
    if (!text.trim()) {
      if (emptyMessage) setImportError(emptyMessage);
      return;
    }
    try {
      const imported = importDistributionFileText(text, { addressKind });
      if (format) imported.format = format;
      if (imported.truncated) {
        setImportError("清单超过 5000 个钱包，请拆分后重新导入；未修改当前清单");
        return;
      }
      if (imported.invalidRows > 0 || imported.conflictingRows > 0) {
        const issue = imported.issues[0];
        setImportError(`${issue ? `${issue.line > 0 ? `第 ${issue.line} 行：` : ""}${issue.message}` : `内容有 ${imported.invalidRows} 行无法识别`}；未修改当前清单`);
        return;
      }
      if (!imported.addresses) {
        setImportError("没有识别到收款地址；未修改当前清单");
        return;
      }
      const checked = generateDistributionList({ addresses: imported.hadAmounts ? imported.rows : imported.addresses, addressKind, decimals, mode: imported.hadAmounts ? "per-row" : "fixed", fixedAmount: "1", validateAddress });
      if (checked.invalid > 0) {
        setImportError(`有 ${checked.invalid} 行地址或金额缺失、无效：${checked.issues[0] || "请检查清单"}。未修改当前清单`);
        return;
      }
      if (!imported.hadAmounts && mode === "per-row") {
        setImportError("逐行金额模式需要每行提供“地址,金额”；文件未提供金额，未修改当前清单");
        return;
      }
      normalizedImportEpochRef.current = importEpochRef.current.current;
      setPendingImport(imported);
      return imported;
    } catch (error) {
      setImportError(`${error instanceof Error ? error.message : "内容过大或格式无法识别，请使用 TXT、CSV、TSV、JSON 或 XLSX"}；未修改当前清单`);
    }
  };

  const closeImport = () => {
    cancelPendingImport();
    setPendingImport(null);
    setImportError("");
    setImportDialogOpen(false);
    importDraftValueRef.current = "";
    if (importDraftRef.current) importDraftRef.current.value = "";
  };

  const openImport = () => {
    if (disabledRef.current) return;
    cancelPendingImport();
    importDraftValueRef.current = "";
    setPendingImport(null);
    setImportError("");
    setImportDialogOpen(true);
  };

  const importAddressFile = async (file: File | undefined) => {
    if (!file) return;
    if (disabledRef.current) return;
    setImportDialogOpen(true);
    const requestId = beginLocalFileImport(importEpochRef.current);
    workbookSheetsRef.current = [];
    setWorkbookSheetNames([]);
    setSelectedWorkbookSheet(0);
    setImportActive(true);
    setPendingImport(null);
    setImportError("");
    importDraftValueRef.current = "";
    if (importDraftRef.current) importDraftRef.current.value = "";
    setImportMessage("正在本地读取钱包文件…");
    try {
      const isWorkbook = /\.xlsx$/i.test(file.name);
      if (!isWorkbook && file.size > maximumDistributionFileBytes) {
        setImportError("文件不能超过 512 KB；未修改当前清单");
        setImportMessage("");
        return;
      }
      if (!/\.(?:txt|csv|tsv|json|xlsx)$/i.test(file.name)) {
        setImportError("请选择 TXT、CSV、TSV、JSON 或 XLSX 文件；未修改当前清单");
        setImportMessage("");
        return;
      }
      const sheets = isWorkbook ? await readWalletXlsxFile(file, 5001) : null;
      const fileText = sheets ? sheets[0]?.text : await file.text();
      if (!isCurrentLocalFileImport(importEpochRef.current, requestId) || disabledRef.current) return;
      if (sheets) {
        if (!sheets.length) throw new Error("XLSX 文件没有可导入的工作表");
        workbookSheetsRef.current = sheets;
        setWorkbookSheetNames(sheets.map(sheet => sheet.name));
      }
      const imported = identifyImport(fileText || "", sheets ? "XLSX" : undefined, sheets
        ? "当前工作表为空，未导入地址；当前清单保持原样"
        : "文件为空，未导入地址；当前清单保持原样");
      const publicRows = imported?.rows || "";
      importDraftValueRef.current = publicRows;
      if (importDraftRef.current) importDraftRef.current.value = publicRows;
      setImportMessage(imported ? "文件已读取，请核对识别结果" : "");
    } catch (error) {
      if (isCurrentLocalFileImport(importEpochRef.current, requestId)) {
        setImportError(`${/\.xlsx$/i.test(file.name) && error instanceof Error ? error.message : "文件读取失败，请使用 UTF-8 编码的 TXT、CSV、TSV、JSON，或有效的 XLSX 文件"}；未修改当前清单`);
        setImportMessage("");
      }
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
      if (isCurrentLocalFileImport(importEpochRef.current, requestId)) setImportActive(false);
    }
  };

  const selectWorkbookSheet = (index: number) => {
    if (disabledRef.current || importingRef.current) return;
    const sheet = workbookSheetsRef.current[index];
    if (!sheet) return;
    beginLocalFileImport(importEpochRef.current);
    setSelectedWorkbookSheet(index);
    const imported = identifyImport(sheet.text, "XLSX", "当前工作表为空，未导入地址；当前清单保持原样");
    const publicRows = imported?.rows || "";
    importDraftValueRef.current = publicRows;
    if (importDraftRef.current) importDraftRef.current.value = publicRows;
    setImportMessage(imported ? "工作表已切换，请核对识别结果" : "");
  };

  const controlsDisabled = disabled || importing;
  const existingRowAmountConflict = useMemo(() => {
    if (mode !== "per-row") return false;
    const amounts = new Map<string, string>();
    for (const row of addresses.split("\n").filter(row => row.trim())) {
      const parts = row.split(",").map(part => part.trim());
      const key = getDuplicateAddressKey(parts[0], addressKind);
      const amount = parts.length === 2 ? comparableAmount(parts[1]) : parts.slice(1).join(",");
      if (amounts.has(key) && amounts.get(key) !== amount) return true;
      amounts.set(key, amount);
    }
    return false;
  }, [addressKind, addresses, mode]);
  const existingAmounts = new Map(fullResult.output.split("\n").filter(Boolean).map(row => [getDuplicateAddressKey(row.split(",")[0], addressKind), row.split(",")[1]]));
  const overlappingAmountConflict = pendingImport?.hadAmounts && pendingImport.rows.split("\n").some(row => {
    const [address, amount] = row.split(",");
    const existingAmount = existingAmounts.get(getDuplicateAddressKey(address, addressKind));
    return existingAmount && comparableAmount(existingAmount) !== comparableAmount(amount);
  });
  const appendBlockedReason = !addresses.trim() ? "" : existingRowAmountConflict
    ? "当前清单中同一钱包存在不同金额，请先修正原始清单；可以选择替换清单。"
    : overlappingAmountConflict
    ? "重复钱包的金额与当前清单不同，请先核对金额；可以选择替换清单。"
    : pendingImport?.hadAmounts && mode !== "per-row" && (
    mode === "random" || pendingImport.hasMixedAmounts || comparableAmount(pendingImport.fixedAmount) !== comparableAmount(fixedAmount)
  ) ? "文件金额与当前金额规则不同，只能替换清单；这样可以保留文件原金额，也不会重算当前清单。" : "";

  const applyImport = (append: boolean) => {
    if (!pendingImport || controlsDisabled || disabledRef.current || !isCurrentLocalFileImport(importEpochRef.current, normalizedImportEpochRef.current) || append && appendBlockedReason) return;
    const checked = generateDistributionList({ addresses: pendingImport.hadAmounts ? pendingImport.rows : pendingImport.addresses, addressKind, decimals, mode: pendingImport.hadAmounts ? "per-row" : "fixed", fixedAmount: "1", validateAddress });
    if (checked.invalid > 0) {
      setImportError(`当前资产下有 ${checked.invalid} 行地址或金额无效：${checked.issues[0] || "请检查清单"}。未修改当前清单`);
      setPendingImport(null);
      return;
    }
    const preserveRowAmounts = pendingImport.hadAmounts && (pendingImport.hasMixedAmounts || mode === "per-row");
    const importedRows = preserveRowAmounts ? pendingImport.rows : pendingImport.addresses;
    const nextMode = preserveRowAmounts ? "per-row" : !append && pendingImport.hadAmounts ? "fixed" : mode;
    const next = dedupeDistributionAddresses(append && addresses.trim() ? `${addresses.trim()}\n${importedRows}` : importedRows, addressKind, nextMode);
    if (next.split(/\n/).filter(line => line.trim()).length > 5000) {
      setImportMessage('追加后超过 5000 行，请减少清单或选择替换'); return;
    }
    setImportUndo({ addresses, mode, fixedAmount, minAmount, maxAmount, randomEntropies: new Map(randomEntropies), excludedKeys: new Set(excludedKeys) });
    onDirty?.(); setAddresses(next);
    setExcludedKeys(append ? new Set([...excludedKeys].filter(key => existingKeys.has(key))) : new Set());
    if (preserveRowAmounts) {
      setMode("per-row");
    } else if (!append && pendingImport.hadAmounts && pendingImport.fixedAmount) {
      setMode('fixed'); setFixedAmount(pendingImport.fixedAmount);
    } else if (mode === 'random') setRandomEntropies(extendRandomEntropies(next, addressKind, randomEntropies));
    setImportMessage(`${append ? '已追加' : '已导入'} ${append ? newImportCount : uniqueImportCount} 个钱包${duplicateImportCount + (append ? overlappingImportCount : 0) ? '，已自动合并重复钱包' : ''}${preserveRowAmounts ? '，按逐行原金额发送' : append ? '，沿用当前金额规则' : pendingImport.hadAmounts ? `，统一金额 ${pendingImport.fixedAmount}` : ''}`);
    closeImport();
  };
  const incomingLines = pendingImport?.addresses.split('\n').filter(Boolean) || [];
  const existingKeys = new Set(addresses.split('\n').map(address => getDuplicateAddressKey(sourceAddress(address, mode), addressKind)));
  const duplicateImportCount = incomingLines.length - new Set(incomingLines.map(address => getDuplicateAddressKey(address, addressKind))).size;
  const uniqueImportCount = new Set(incomingLines.map(address => getDuplicateAddressKey(address, addressKind))).size;
  const overlappingImportCount = new Set(incomingLines.filter(address => existingKeys.has(getDuplicateAddressKey(address, addressKind))).map(address => getDuplicateAddressKey(address, addressKind))).size;
  const newImportCount = new Set(incomingLines.map(address => getDuplicateAddressKey(address, addressKind)).filter(key => !existingKeys.has(key))).size;
  const walletRows = useMemo(() => addresses.split("\n").map(row => row.trim()).filter(Boolean).map((row, index) => ({
    address: sourceAddress(row, mode),
    key: getDuplicateAddressKey(sourceAddress(row, mode), addressKind),
    amount: mode === "per-row" ? row.split(",")[1] : existingAmounts.get(getDuplicateAddressKey(row, addressKind)),
    index
  })), [addresses, addressKind, mode, fullResult.output]);
  const filteredWallets = walletRows.filter(wallet => wallet.address.toLowerCase().includes(walletQuery.trim().toLowerCase()));
  const selectedWalletCount = walletRows.filter(wallet => !excludedKeys.has(wallet.key)).length;
  const visibleWallets = filteredWallets.slice(0, visibleWalletCount);
  const changeWalletSelection = (key: string, selected: boolean) => {
    if (controlsDisabled) return;
    setImportUndo(null);
    onDirty?.();
    setExcludedKeys(current => { const next = new Set(current); if (selected) next.delete(key); else next.add(key); return next; });
  };
  const removeWallets = (keys: Set<string>) => {
    updateAddresses(addresses.split("\n").filter(row => !keys.has(getDuplicateAddressKey(sourceAddress(row, mode), addressKind))).join("\n"));
  };

  useImperativeHandle(controlRef, () => ({
    focusProblem(kind) {
      setAddressEditorOpen(true);
      const input = addressInputRef.current;
      if (!input) return;
      const sourceLines = addresses.split("\n");
      const nonemptyLines = sourceLines.map((line, index) => ({ text: line.trim(), index })).filter((line) => line.text && !excludedKeys.has(getDuplicateAddressKey(sourceAddress(line.text, mode), addressKind)));
      let lineIndex = 0;
      if (kind === "duplicate") {
        const seen = new Set<string>();
        const duplicate = nonemptyLines.find((line) => {
          const key = getDuplicateAddressKey(sourceAddress(line.text, mode), addressKind);
          if (seen.has(key)) return true;
          seen.add(key);
          return false;
        });
        lineIndex = duplicate?.index ?? 0;
      } else {
        const firstInvalid = result.issues.find((issue) => /^第 \d+ 行/.test(issue));
        const generatedLine = firstInvalid?.match(/^第 (\d+) 行/)?.[1];
        lineIndex = nonemptyLines[Math.max(0, Number(generatedLine || 1) - 1)]?.index ?? 0;
      }
      const start = sourceLines.slice(0, lineIndex).reduce((offset, line) => offset + line.length + 1, 0);
      window.requestAnimationFrame(() => {
        input.scrollIntoView?.({ block: "center", behavior: "smooth" });
        input.focus({ preventScroll: true });
        input.setSelectionRange(start, start + (sourceLines[lineIndex]?.length || 0));
      });
    }
  }), [addressKind, addresses, excludedKeys, mode, result.issues]);

  return (
    <section
      aria-disabled={controlsDisabled || undefined}
      className={`distribution-generator${controlsDisabled ? " disabled" : ""}${generationDisabled ? " generation-disabled" : ""}`}
      aria-label="批量金额清单生成器"
    >
      <div className="distribution-generator__heading">
        <h3>收款清单</h3>
        <div className="generator-heading-actions">
        <Input
          accept=".txt,.csv,.tsv,.json,.xlsx,text/plain,text/csv,application/json,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          aria-hidden="true"
          disabled={controlsDisabled}
          hidden
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            void importAddressFile(file);
          }}
          ref={fileInputRef}
          tabIndex={-1}
          type="file"
        />
        {importUndo ? <Button disabled={controlsDisabled} variant="outline" type="button" onClick={() => {
          onDirty?.(); setAddresses(importUndo.addresses); setMode(importUndo.mode); setFixedAmount(importUndo.fixedAmount);
          setMinAmount(importUndo.minAmount); setMaxAmount(importUndo.maxAmount); setRandomEntropies(importUndo.randomEntropies);
          setExcludedKeys(importUndo.excludedKeys);
          setImportUndo(null); setImportMessage('已撤销导入，恢复之前的清单和金额设置');
        }}>撤销导入</Button> : null}
        {mode === "random" ? (
          <Button disabled={controlsDisabled || generationDisabled || !result.output} onClick={() => regenerateRandomAmounts()} type="button" variant="outline">重新随机</Button>
        ) : null}
        <Button disabled={controlsDisabled || result.duplicates === 0} onClick={() => updateAddresses(dedupeDistributionAddresses(addresses, addressKind, mode))} type="button" variant="outline">去重</Button>
        <ConfirmActionDialog
          confirmLabel="确认清空"
          description={`将删除当前 ${walletRows.length} 个收款钱包及全部已填写内容，无法撤销。`}
          disabled={controlsDisabled || !addresses.trim()}
          onConfirm={() => { updateAddresses(""); setRandomEntropies(new Map()); }}
          title="清空收款清单？"
          triggerClassName="action-group__destructive"
          triggerLabel="清空"
          triggerVariant="destructive"
        />
        </div>
      </div>

      <Button
        aria-label={walletRows.length ? "继续导入收款钱包" : "导入收款钱包"}
        aria-haspopup="dialog"
        aria-expanded={importDialogOpen}
        className={walletRows.length ? "recipient-import-summary" : "recipient-import-dropzone"}
        id={`${instanceId}-recipient-import`}
        data-drag-active={dragActive || undefined}
        disabled={controlsDisabled}
        onClick={openImport}
        onDragOver={event => { event.preventDefault(); if (controlsDisabled) return; event.dataTransfer.dropEffect = "copy"; setDragActive(true); }}
        onDragLeave={() => setDragActive(false)}
        onDrop={event => { event.preventDefault(); setDragActive(false); if (controlsDisabled) return; const file = event.dataTransfer.files[0]; if (file) void importAddressFile(file); }}
        type="button"
        variant="outline"
      >
        <HugeiconsIcon aria-hidden="true" icon={Upload01Icon} size={20} strokeWidth={1.8} />
        <span>{walletRows.length ? `已导入 ${walletRows.length} 个收款钱包` : "拖入文件或点击导入"}</span>
        <span className="recipient-import-dropzone__hint">{walletRows.length ? "继续导入钱包" : "TXT、CSV、TSV、JSON、XLSX · 支持粘贴地址"}</span>
      </Button>
      {importMessage ? <p className="hint generator-import-message" role="status">{importMessage}</p> : null}
      <Dialog open={importDialogOpen} onOpenChange={open => { if (!open) { closeImport(); setImportMessage('已取消导入，当前清单保持原样'); } }}>
        <DialogContent className="recipient-import-dialog" finalFocus={() => document.getElementById(`${instanceId}-recipient-import`)}>
          <DialogHeader><DialogTitle>导入收款钱包</DialogTitle><DialogDescription>自动识别地址和金额，合并重复钱包。文件有金额时保留原金额；导入完成后可以撤销一次。</DialogDescription></DialogHeader>
          {workbookSheetNames.length > 0 ? <Field className="wallet-import-sheet-field">
            {workbookSheetNames.length > 1 ? <>
              <FieldLabel htmlFor={`${instanceId}-recipient-sheet`}>导入工作表</FieldLabel>
              <select className="wallet-import-sheet-selector" disabled={controlsDisabled} id={`${instanceId}-recipient-sheet`} value={selectedWorkbookSheet} onChange={event => selectWorkbookSheet(Number(event.target.value))}>
                {workbookSheetNames.map((name, index) => <option key={`${index}-${name}`} value={index}>{name}</option>)}
              </select>
            </> : null}
            <p className="hint">当前工作表：{workbookSheetNames[selectedWorkbookSheet]}。只导入当前工作表的内容。</p>
          </Field> : null}
          <Field>
            <div className="recipient-import-draft-heading">
              <FieldLabel htmlFor={`${instanceId}-recipient-draft`}>粘贴地址或清单</FieldLabel>
              <Badge variant="outline">{pendingImport ? `${uniqueImportCount} / 5,000` : "最多 5,000 个"}</Badge>
            </div>
            <Textarea
              autoCapitalize="none"
              autoComplete="off"
              className="recipient-import-textarea"
              defaultValue={importDraftValueRef.current}
              disabled={controlsDisabled}
              id={`${instanceId}-recipient-draft`}
              maxLength={maximumDistributionFileBytes}
              onInput={event => {
                cancelPendingImport();
                importDraftValueRef.current = event.currentTarget.value;
                setImportMessage("");
                identifyImport(event.currentTarget.value);
              }}
              onPaste={event => {
                const input = event.currentTarget;
                const nextLength = input.value.length - (input.selectionEnd - input.selectionStart) + event.clipboardData.getData("text").length;
                if (nextLength <= maximumDistributionFileBytes) return;
                event.preventDefault();
                cancelPendingImport();
                setPendingImport(null);
                setImportError("粘贴内容不能超过 512 KB，请拆分后重新导入；未修改当前清单");
              }}
              placeholder={"每行一个地址，或地址,金额\n也可以粘贴带表头的表格、钱包 JSON"}
              ref={importDraftRef}
              rows={6}
              spellCheck={false}
            />
          </Field>
          <div className="recipient-import-file-row">
            <Button disabled={controlsDisabled} onClick={() => fileInputRef.current?.click()} type="button" variant="outline">选择钱包文件</Button>
            <span className="hint">{importing ? "正在读取…" : "TXT、CSV、TSV、JSON、XLSX"}</span>
          </div>
          {importError ? <p role="alert" className="recipient-import-error">{importError}</p> : null}
          {pendingImport ? <>
          <div aria-label="收款钱包识别预览" className="summary-list recipient-import-preview">
            <div><span>识别格式</span><strong>{pendingImport.format}{pendingImport.detectedColumns.length ? ` · ${pendingImport.detectedColumns.join("、")}` : ""}</strong></div>
            <div><span>识别到的钱包</span><strong>{uniqueImportCount} 个 · 自动去重 {duplicateImportCount} 条</strong></div>
            <div><span>与当前清单重复</span><strong>{overlappingImportCount} 个（自动合并）</strong></div>
            <div><span>可新增地址</span><strong>{newImportCount} 个</strong></div>
            <div><span>当前金额规则</span><strong>{mode === 'per-row' ? '逐行原金额' : mode === 'fixed' ? `每个地址 ${fixedAmount} ${symbol}` : `${minAmount}–${maxAmount} ${symbol}`}</strong></div>
            <div><span>替换后金额</span><strong>{pendingImport?.hadAmounts ? pendingImport.hasMixedAmounts || mode === 'per-row' ? '逐行原金额（不重新计算）' : `每个地址 ${pendingImport.fixedAmount} ${symbol}` : '沿用当前金额规则'}</strong></div>
          </div>
          <div className="import-preview-addresses">{(pendingImport?.hadAmounts ? pendingImport.rows.split('\n') : incomingLines).slice(0, 3).map((row, index) => <code key={`${index}-${row}`}>{row}</code>)}</div>
          <p className="hint">{appendBlockedReason || (mode === 'per-row' ? '追加会保留当前清单和文件中的逐行金额。' : '追加保留当前金额规则；替换会应用文件中的金额。')}</p>
          </> : null}
          <DialogFooter>
            <Button variant="outline" type="button" onClick={() => { closeImport(); setImportMessage('已取消导入，当前清单保持原样'); }}>取消</Button>
            {addresses.trim() ? <Button variant="outline" type="button" disabled={controlsDisabled || !pendingImport || Boolean(appendBlockedReason) || walletRows.length + newImportCount > 5000} onClick={() => applyImport(true)}>追加到当前清单</Button> : null}
            <Button type="button" disabled={controlsDisabled || !pendingImport} onClick={() => applyImport(false)}>{addresses.trim() ? '替换当前清单' : '确认导入清单'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {walletRows.length ? <div aria-label="已导入收款钱包" className="recipient-wallet-browser">
        <div className="recipient-wallet-search">
          <Input aria-label="搜索收款钱包" type="search" placeholder="搜索钱包地址" value={walletQuery} disabled={controlsDisabled} onChange={event => { setWalletQuery(event.target.value); setVisibleWalletCount(recipientBatchSize); }} />
          <span className="hint">本次发送 {selectedWalletCount} / {walletRows.length} 个钱包</span>
        </div>
        <div aria-label="收款钱包列表控制" className="recipient-wallet-toolbar">
          <Button disabled={controlsDisabled} size="sm" type="button" variant="ghost" onClick={() => {
            setImportUndo(null); onDirty?.(); setExcludedKeys(selectedWalletCount === walletRows.length ? new Set(walletRows.map(wallet => wallet.key)) : new Set());
          }}>{selectedWalletCount === walletRows.length ? "取消全选" : "全选"}</Button>
          {walletQuery ? <Button disabled={controlsDisabled || !filteredWallets.length} size="sm" type="button" variant="ghost" onClick={() => {
            setImportUndo(null); onDirty?.(); setExcludedKeys(current => new Set([...current].filter(key => !filteredWallets.some(wallet => wallet.key === key))));
          }}>选择搜索结果 ({filteredWallets.length})</Button> : null}
          <ConfirmActionDialog confirmLabel={`删除 ${selectedWalletCount} 个钱包`} description="已选收款钱包将从清单移除，需重新导入才能恢复。" disabled={controlsDisabled || !selectedWalletCount} onConfirm={() => removeWallets(new Set(walletRows.filter(wallet => !excludedKeys.has(wallet.key)).map(wallet => wallet.key)))} title={`删除 ${selectedWalletCount} 个已选钱包？`} triggerLabel={`删除选中 (${selectedWalletCount})`} triggerSize="sm" triggerVariant="ghost" />
        </div>
        <div className="recipient-wallet-list" role="list">
          {visibleWallets.map(wallet => <div className="recipient-wallet-row" role="listitem" key={`${wallet.key}-${wallet.index}`}>
            <Checkbox aria-label={`选择收款钱包 ${wallet.address}`} checked={!excludedKeys.has(wallet.key)} disabled={controlsDisabled} onCheckedChange={checked => changeWalletSelection(wallet.key, Boolean(checked))} />
            <code title={wallet.address}>{wallet.address}</code>
            <span className="recipient-wallet-amount">{wallet.amount ? `${wallet.amount} ${symbol}` : "金额待设置"}</span>
            <Button aria-label={`移除收款钱包 ${wallet.address}`} disabled={controlsDisabled} size="sm" type="button" variant="ghost" onClick={() => removeWallets(new Set([wallet.key]))}>移除</Button>
          </div>)}
        </div>
        {!filteredWallets.length ? <p className="hint">没有匹配的钱包</p> : null}
        {filteredWallets.length > visibleWalletCount ? <Button type="button" variant="outline" size="sm" onClick={() => setVisibleWalletCount(count => count + recipientBatchSize)}>加载更多钱包 ({visibleWallets.length} / {filteredWallets.length})</Button> : null}
        <p className="hint">仅向勾选的钱包发送，取消勾选会保留钱包和金额。</p>
      </div> : null}

      {unavailableMessage ? (
        <div className="distribution-generator__notice"><span>金额生成暂不可用</span><HelpTooltip label="金额生成说明">{unavailableMessage}</HelpTooltip></div>
      ) : null}

      <DistributionListEditor
        addressInputRef={addressInputRef}
        collapseAddressInput
        addressEditorOpen={addressEditorOpen}
        onAddressEditorOpenChange={setAddressEditorOpen}
        addressPlaceholder={addressKind === "evm"
          ? "0x0000000000000000000000000000000000000001\n0x0000000000000000000000000000000000000002"
          : "11111111111111111111111111111111\nBPFLoader1111111111111111111111111111111111"}
        addresses={addresses}
        disabled={controlsDisabled}
        fixedAmount={fixedAmount}
        fixedAmountStep={fixedStep}
        generationDisabled={generationDisabled}
        idPrefix={instanceId}
        maxAmount={maxAmount}
        minAmount={minAmount}
        mode={mode}
        onAddressesChange={updateAddresses}
        onFixedAmountChange={(value) => updateValue(setFixedAmount, value)}
        onMaxAmountChange={(value) => updateValue(setMaxAmount, value)}
        onMinAmountChange={(value) => updateValue(setMinAmount, value)}
        onModeChange={(nextMode) => {
          if (nextMode === mode) return;
          cancelPendingImport();
          setImportUndo(null);
          setImportMessage("");
          if (nextMode === "per-row") {
            const generatedAmounts = new Map(fullResult.output.split('\n').map(row => [getDuplicateAddressKey(row.split(',')[0], addressKind), row]));
            onDirty?.();
            setAddresses(addresses.split('\n').map(row => row.trim() ? generatedAmounts.get(getDuplicateAddressKey(row.trim(), addressKind)) || `${row.trim()},` : '').join('\n'));
            setMode("per-row");
          } else {
            const nextAddresses = mode === "per-row" ? addresses.split('\n').map(row => sourceAddress(row, mode)).join('\n') : addresses;
            setAddresses(nextAddresses);
            setMode(nextMode);
            if (nextMode === "random") regenerateRandomAmounts(nextAddresses);
            else onDirty?.();
          }
        }}
        randomAmountStep={randomStep}
        symbol={symbol}
      />

      {result.issues.length > 0 || result.duplicates > 0 ? (
        <div aria-live="polite" className="distribution-generator__notice" data-tone="error">
          <span>{result.invalid > 0 ? `${result.invalid} 处需修正` : result.issues.length ? "金额设置需修正" : ""}{result.invalid > 0 && result.duplicates > 0 ? " · " : ""}{result.duplicates > 0 ? `${result.duplicates} 个重复地址` : ""}</span>
          <HelpTooltip label="清单问题详情"><div>{result.issues.map((issue) => <p key={issue}>{issue}</p>)}{result.duplicates > 0 ? <p>发现 {result.duplicates} 个重复地址，请先去重后再发送。</p> : null}</div></HelpTooltip>
        </div>
      ) : null}
    </section>
  );
}
