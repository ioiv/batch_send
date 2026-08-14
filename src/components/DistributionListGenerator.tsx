import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { getDuplicateAddressKey, type AddressKind } from "../lib/address";
import {
  dedupeDistributionAddresses,
  generateDistributionList,
  getDistributionAmountStep,
  importDistributionFileText,
  type DistributionAmountMode,
  type GeneratedDistributionList
} from "../lib/distribution-generator";
import {
  beginLocalFileImport,
  cancelLocalFileImport,
  isCurrentLocalFileImport,
  type LocalFileImportEpoch
} from "../lib/local-file-import";

type DistributionListGeneratorProps = {
  addressKind: AddressKind;
  decimals: number;
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

export function DistributionListGenerator({
  addressKind,
  decimals,
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
  const statusLabel = unavailableMessage
    ? "等待资产精度"
    : result.invalid > 0
    ? `${result.invalid} 处需修正`
    : result.duplicates > 0
      ? `${result.duplicates} 个重复地址`
      : result.validCount > 0
        ? `${result.validCount} 个地址已就绪`
        : "等待地址";
  const statusClassName = unavailableMessage
    ? ""
    : result.invalid > 0 || result.duplicates > 0
      ? " error"
      : result.validCount > 0
        ? " ready"
        : "";

  useEffect(() => {
    onResultChange(result);
  }, [onResultChange, result]);

  useEffect(() => {
    if (disabled) cancelPendingImport();
  }, [cancelPendingImport, disabled]);

  useEffect(() => () => {
    cancelLocalFileImport(importEpochRef.current);
  }, []);

  const regenerateRandomAmounts = () => {
    cancelPendingImport();
    onDirty?.();
    setRandomEntropies(extendRandomEntropies(addresses, addressKind, new Map()));
  };

  const updateValue = (setter: (value: string) => void, value: string) => {
    cancelPendingImport();
    onDirty?.();
    setter(value);
  };

  const updateAddresses = (value: string, cancelImport = true) => {
    if (cancelImport) cancelPendingImport();
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
      if (!imported.addresses) {
        setImportMessage("文件中没有可导入的地址");
        return;
      }
      if (imported.truncated) {
        setImportMessage("文件超过 5000 行，为避免金额或收款人被静默丢弃，请拆分后重新导入");
        return;
      }
      if (imported.invalidRows > 0) {
        setImportMessage(`文件有 ${imported.invalidRows} 行列数或引号不正确，未修改当前清单`);
        return;
      }
      if (imported.hasMixedAmounts) {
        setImportMessage("检测到逐行不同金额；当前工具只支持统一金额或随机区间，未修改当前清单");
        return;
      }

      updateAddresses(imported.addresses, false);
      if (imported.hadAmounts && imported.fixedAmount) {
        setMode("fixed");
        setFixedAmount(imported.fixedAmount);
      }
      const importedCount = imported.addresses.split("\n").length;
      setImportMessage(imported.hadAmounts
        ? `已导入 ${importedCount} 个地址及统一金额 ${imported.fixedAmount}`
        : `已导入 ${importedCount} 个地址`);
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

  return (
    <section
      aria-disabled={controlsDisabled || undefined}
      className={`distribution-generator${controlsDisabled ? " disabled" : ""}${generationDisabled ? " generation-disabled" : ""}`}
      aria-label="批量金额清单生成器"
    >
      <div className="generator-heading">
        <label htmlFor={`${instanceId}-addresses`}>收款地址</label>
        <div className="generator-heading-actions">
          <input
            accept=".txt,.csv,text/plain,text/csv"
            className="sr-only"
            disabled={controlsDisabled}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              void importAddressFile(file);
            }}
            ref={fileInputRef}
            tabIndex={-1}
            type="file"
          />
          <button
            className="button ghost generator-import-button"
            disabled={controlsDisabled}
            onClick={() => fileInputRef.current?.click()}
            type="button"
          >导入 TXT/CSV</button>
          <span className={`pill generator-status${statusClassName}`} aria-live="polite">
            {statusLabel}
          </span>
        </div>
      </div>

      {importMessage ? <p className="hint generator-import-message" role="status">{importMessage}</p> : null}

      {unavailableMessage ? (
        <div className="notice compact-notice">
          <strong>金额生成暂不可用</strong>
          <span>{unavailableMessage}</span>
        </div>
      ) : null}

      <div className="field">
        <textarea
          className="address-only-input"
          disabled={controlsDisabled}
          id={`${instanceId}-addresses`}
          placeholder={addressKind === "evm"
            ? "0x0000000000000000000000000000000000000001\n0x0000000000000000000000000000000000000002"
            : "11111111111111111111111111111111\nBPFLoader1111111111111111111111111111111111"}
          spellCheck={false}
          value={addresses}
          onChange={(event) => updateAddresses(event.target.value)}
        />
      </div>

      <div className="mode-row generator-mode-row" role="radiogroup" aria-label="批量金额模式">
        <label className="mode">
          <span className="mode-head">
            <input
              checked={mode === "fixed"}
              disabled={controlsDisabled || generationDisabled}
              name={`${instanceId}-amount-mode`}
              type="radio"
              value="fixed"
              onChange={() => {
                onDirty?.();
                setMode("fixed");
              }}
            />
            固定金额
          </span>
        </label>
        <label className="mode">
          <span className="mode-head">
            <input
              checked={mode === "random"}
              disabled={controlsDisabled || generationDisabled}
              name={`${instanceId}-amount-mode`}
              type="radio"
              value="random"
              onChange={() => {
                setMode("random");
                regenerateRandomAmounts();
              }}
            />
            随机区间
          </span>
        </label>
      </div>

      {mode === "fixed" ? (
        <div className="amount-grid generator-amount-grid fixed">
          <div className="field">
            <label htmlFor={`${instanceId}-fixed-amount`}>每个地址的金额（{symbol}）</label>
            <input
              disabled={controlsDisabled || generationDisabled}
              id={`${instanceId}-fixed-amount`}
              min="0"
              step={fixedStep}
              type="number"
              value={fixedAmount}
              onChange={(event) => updateValue(setFixedAmount, event.target.value)}
            />
          </div>
        </div>
      ) : (
        <div className="amount-grid generator-amount-grid random">
          <div className="field">
            <label htmlFor={`${instanceId}-min-amount`}>随机最小值（{symbol}）</label>
            <input
              disabled={controlsDisabled || generationDisabled}
              id={`${instanceId}-min-amount`}
              min="0"
              step={randomStep}
              type="number"
              value={minAmount}
              onChange={(event) => updateValue(setMinAmount, event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor={`${instanceId}-max-amount`}>随机最大值（{symbol}）</label>
            <input
              disabled={controlsDisabled || generationDisabled}
              id={`${instanceId}-max-amount`}
              min="0"
              step={randomStep}
              type="number"
              value={maxAmount}
              onChange={(event) => updateValue(setMaxAmount, event.target.value)}
            />
          </div>
        </div>
      )}

      <div className="actions generator-actions">
        <div className="action-group">
          {mode === "random" ? (
            <button
              className="button ghost"
              disabled={controlsDisabled || generationDisabled || !result.output}
              type="button"
              onClick={regenerateRandomAmounts}
            >重新随机</button>
          ) : null}
          <button
            className="button ghost"
            disabled={controlsDisabled || result.duplicates === 0}
            type="button"
            onClick={() => updateAddresses(dedupeDistributionAddresses(addresses, addressKind))}
          >去重</button>
          <button
            className="button danger"
            disabled={controlsDisabled || !addresses.trim()}
            type="button"
            onClick={() => {
              updateAddresses("");
              setRandomEntropies(new Map());
            }}
          >清空</button>
        </div>
      </div>

      <div className="invalid-list" aria-live="polite">
        {result.issues.slice(0, 5).map((issue) => <div key={issue}>{issue}</div>)}
        {result.duplicates > 0 ? <div>发现 {result.duplicates} 个重复地址，请先去重后再发送。</div> : null}
      </div>
    </section>
  );
}
