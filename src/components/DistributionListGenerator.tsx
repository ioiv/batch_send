import { useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
const distributionFileTypes = new Set(["", "application/csv", "application/vnd.ms-excel", "text/csv", "text/plain"]);

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
  const [whole, fraction = ""] = value.trim().split(".");
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
  const [importUndo, setImportUndo] = useState<{ addresses: string; mode: DistributionAmountMode; fixedAmount: string; minAmount: string; maxAmount: string; randomEntropies: Map<string, bigint> } | null>(null);
  disabledRef.current = disabled;

  const setImportActive = useCallback((active: boolean) => {
    if (importingRef.current === active) return;
    importingRef.current = active;
    setImporting(active);
    onImportingChange?.(active);
  }, [onImportingChange]);

  const cancelPendingImport = useCallback(() => {
    cancelLocalFileImport(importEpochRef.current);
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
  const result = useMemo(() => generateDistributionList({
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
  const fixedStep = formatStepUnits(getDistributionAmountStep(fixedAmount, decimals), decimals);
  const randomStep = formatStepUnits(getDistributionAmountStep(minAmount, maxAmount, decimals), decimals);

  useEffect(() => {
    onResultChange(result);
  }, [onResultChange, result]);

  useEffect(() => {
    if (disabled) { cancelPendingImport(); setPendingImport(null); }
  }, [cancelPendingImport, disabled]);

  useEffect(() => () => {
    cancelLocalFileImport(importEpochRef.current);
  }, []);

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
    if (mode === "random") {
      setRandomEntropies(extendRandomEntropies(value, addressKind, randomEntropies));
    }
  };

  const importAddressFile = async (file: File | undefined) => {
    if (!file) return;
    const requestId = beginLocalFileImport(importEpochRef.current);
    setImportActive(true);
    setImportMessage("正在本地读取清单…");
    try {
      if (file.size > maximumDistributionFileBytes) {
        setImportMessage("文件不能超过 512 KB");
        return;
      }
      if (!/\.(?:txt|csv)$/i.test(file.name) || !distributionFileTypes.has(file.type.trim().toLowerCase())) {
        setImportMessage("仅支持 TXT 或 CSV 文件");
        return;
      }
      const fileText = await file.text();
      if (!isCurrentLocalFileImport(importEpochRef.current, requestId) || disabledRef.current) return;
      const imported = importDistributionFileText(fileText);
      if (imported.truncated) {
        setImportMessage("文件超过 5000 行，为避免金额或收款人被静默丢弃，请拆分后重新导入");
        return;
      }
      if (imported.invalidRows > 0) {
        setImportMessage(`文件有 ${imported.invalidRows} 行列数或引号不正确，未修改当前清单`);
        return;
      }
      if (!imported.addresses) {
        setImportMessage("文件中没有可导入的地址");
        return;
      }
      if (imported.hadAmounts) {
        const checked = generateDistributionList({ addresses: imported.rows, addressKind, decimals, mode: "per-row", validateAddress });
        if (checked.invalid > 0) {
          setImportMessage(`文件有 ${checked.invalid} 行地址或金额缺失、无效：${checked.issues[0] || "请检查清单"}。未修改当前清单`);
          return;
        }
      } else if (mode === "per-row") {
        setImportMessage("逐行金额模式需要每行提供“地址,金额”；文件未提供金额，未修改当前清单");
        return;
      }

      setPendingImport(imported);
      setImportMessage('文件已读取，请确认导入方式');
    } catch {
      if (isCurrentLocalFileImport(importEpochRef.current, requestId)) {
        setImportMessage("文件读取失败，请使用 UTF-8 编码的 TXT 或 CSV");
      }
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
      if (isCurrentLocalFileImport(importEpochRef.current, requestId)) setImportActive(false);
    }
  };

  const controlsDisabled = disabled || importing;
  const appendBlockedReason = pendingImport?.hadAmounts && mode !== "per-row" && (
    mode === "random" || pendingImport.hasMixedAmounts || comparableAmount(pendingImport.fixedAmount) !== comparableAmount(fixedAmount)
  ) ? "文件金额与当前金额规则不同，只能替换清单；这样可以保留文件原金额，也不会重算当前清单。" : "";

  const applyImport = (append: boolean) => {
    if (!pendingImport || controlsDisabled || append && appendBlockedReason) return;
    const preserveRowAmounts = pendingImport.hadAmounts && (pendingImport.hasMixedAmounts || mode === "per-row");
    const importedRows = preserveRowAmounts ? pendingImport.rows : pendingImport.addresses;
    const next = append && addresses.trim() ? `${addresses.trim()}\n${importedRows}` : importedRows;
    if (next.split(/\n/).filter(line => line.trim()).length > 5000) {
      setImportMessage('追加后超过 5000 行，请减少清单或选择替换'); return;
    }
    setImportUndo({ addresses, mode, fixedAmount, minAmount, maxAmount, randomEntropies: new Map(randomEntropies) });
    onDirty?.(); setAddresses(next);
    if (preserveRowAmounts) {
      setMode("per-row");
    } else if (!append && pendingImport.hadAmounts && pendingImport.fixedAmount) {
      setMode('fixed'); setFixedAmount(pendingImport.fixedAmount);
    } else if (mode === 'random') setRandomEntropies(extendRandomEntropies(next, addressKind, randomEntropies));
    setImportMessage(`${append ? '已追加' : '已导入'} ${pendingImport.addresses.split('\n').length} 个地址${preserveRowAmounts ? '，按逐行原金额发送' : append ? '，沿用当前金额规则' : pendingImport.hadAmounts ? `，统一金额 ${pendingImport.fixedAmount}` : ''}`);
    setPendingImport(null);
  };
  const incomingLines = pendingImport?.addresses.split('\n').filter(Boolean) || [];
  const existingKeys = new Set(addresses.split('\n').map(address => getDuplicateAddressKey(sourceAddress(address, mode), addressKind)));
  const duplicateImportCount = incomingLines.length - new Set(incomingLines.map(address => getDuplicateAddressKey(address, addressKind))).size;
  const overlappingImportCount = incomingLines.filter(address => existingKeys.has(getDuplicateAddressKey(address, addressKind))).length;
  const newImportCount = new Set(incomingLines.map(address => getDuplicateAddressKey(address, addressKind)).filter(key => !existingKeys.has(key))).size;

  useImperativeHandle(controlRef, () => ({
    focusProblem(kind) {
      const input = addressInputRef.current;
      if (!input) return;
      const sourceLines = addresses.split("\n");
      const nonemptyLines = sourceLines.map((line, index) => ({ text: line.trim(), index })).filter((line) => line.text);
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
      input.scrollIntoView?.({ block: "center", behavior: "smooth" });
      input.focus({ preventScroll: true });
      input.setSelectionRange(start, start + (sourceLines[lineIndex]?.length || 0));
    }
  }), [addressKind, addresses, mode, result.issues]);

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
          accept=".txt,.csv,text/plain,text/csv"
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
        <Button
          className="generator-import-button"
          disabled={controlsDisabled}
          onClick={() => fileInputRef.current?.click()}
          type="button"
          variant="outline"
        >导入 TXT/CSV</Button>
        {importUndo ? <Button disabled={controlsDisabled} variant="outline" type="button" onClick={() => {
          onDirty?.(); setAddresses(importUndo.addresses); setMode(importUndo.mode); setFixedAmount(importUndo.fixedAmount);
          setMinAmount(importUndo.minAmount); setMaxAmount(importUndo.maxAmount); setRandomEntropies(importUndo.randomEntropies);
          setImportUndo(null); setImportMessage('已撤销导入，恢复之前的清单和金额设置');
        }}>撤销导入</Button> : null}
        {mode === "random" ? (
          <Button disabled={controlsDisabled || generationDisabled || !result.output} onClick={() => regenerateRandomAmounts()} type="button" variant="outline">重新随机</Button>
        ) : null}
        <Button disabled={controlsDisabled || result.duplicates === 0} onClick={() => updateAddresses(dedupeDistributionAddresses(addresses, addressKind, mode))} type="button" variant="outline">去重</Button>
        <ConfirmActionDialog
          confirmLabel="确认清空"
          description={`将删除当前 ${result.validCount} 个有效地址及全部已填写内容，无法撤销。`}
          disabled={controlsDisabled || !addresses.trim()}
          onConfirm={() => { updateAddresses(""); setRandomEntropies(new Map()); }}
          title="清空收款清单？"
          triggerClassName="action-group__destructive"
          triggerLabel="清空"
          triggerVariant="destructive"
        />
        </div>
      </div>

      {importMessage ? <p className="hint generator-import-message" role="status">{importMessage}</p> : null}
      <Dialog open={Boolean(pendingImport)} onOpenChange={open => { if (!open) { setPendingImport(null); setImportMessage('已取消导入，当前清单保持原样'); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>确认导入收款清单</DialogTitle><DialogDescription>先核对清单和金额，再选择追加或替换。导入完成后可以撤销一次。</DialogDescription></DialogHeader>
          <div className="summary-list">
            <div><span>文件地址</span><strong>{incomingLines.length} 个 · 文件内重复 {duplicateImportCount} 条</strong></div>
            <div><span>与当前清单重复</span><strong>{overlappingImportCount} 条（导入后可去重）</strong></div>
            <div><span>可新增地址</span><strong>{newImportCount} 个</strong></div>
            <div><span>当前金额规则</span><strong>{mode === 'per-row' ? '逐行原金额' : mode === 'fixed' ? `每个地址 ${fixedAmount} ${symbol}` : `${minAmount}–${maxAmount} ${symbol}`}</strong></div>
            <div><span>替换后金额</span><strong>{pendingImport?.hadAmounts ? pendingImport.hasMixedAmounts || mode === 'per-row' ? '逐行原金额（不重新计算）' : `每个地址 ${pendingImport.fixedAmount} ${symbol}` : '沿用当前金额规则'}</strong></div>
          </div>
          <div className="import-preview-addresses">{(pendingImport?.hadAmounts ? pendingImport.rows.split('\n') : incomingLines).slice(0, 3).map((row, index) => <code key={`${index}-${row}`}>{row}</code>)}</div>
          <p className="hint">{appendBlockedReason || (mode === 'per-row' ? '追加会保留当前清单和文件中的逐行金额。' : '追加保留当前金额规则；替换会应用文件中的金额。')}重复地址不会自动删除。</p>
          <DialogFooter>
            <Button variant="outline" type="button" onClick={() => { setPendingImport(null); setImportMessage('已取消导入，当前清单保持原样'); }}>取消</Button>
            {addresses.trim() ? <Button variant="outline" type="button" disabled={controlsDisabled || Boolean(appendBlockedReason) || addresses.split('\n').filter(line => line.trim()).length + incomingLines.length > 5000} onClick={() => applyImport(true)}>追加到当前清单</Button> : null}
            <Button type="button" disabled={controlsDisabled} onClick={() => applyImport(false)}>{addresses.trim() ? '替换当前清单' : '确认导入清单'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {unavailableMessage ? (
        <div className="distribution-generator__notice"><span>金额生成暂不可用</span><HelpTooltip label="金额生成说明">{unavailableMessage}</HelpTooltip></div>
      ) : null}

      <DistributionListEditor
        addressInputRef={addressInputRef}
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
            const generatedAmounts = new Map(result.output.split('\n').map(row => [getDuplicateAddressKey(row.split(',')[0], addressKind), row]));
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
