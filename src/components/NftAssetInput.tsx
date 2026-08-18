import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  mergeNftAssetInput,
  parseNftAssetFile,
  type NftAssetInputIssue
} from "../lib/nft-asset-input";
import {
  beginLocalFileImport,
  cancelLocalFileImport,
  isCurrentLocalFileImport,
  type LocalFileImportEpoch
} from "../lib/local-file-import";

const maximumNftAssetFileBytes = 512 * 1024;
const nftAssetFileTypes = new Set(["", "application/csv", "application/vnd.ms-excel", "text/csv", "text/plain"]);

export type NftAssetInputMode = "auto" | "manual" | "file" | "advanced";

const manualNftAssetInputModes: Array<{
  label: string;
  value: NftAssetInputMode;
}> = [
  { value: "manual", label: "手动添加" },
  { value: "file", label: "文件导入" },
  { value: "advanced", label: "高级编辑" }
];

const autoNftAssetInputMode = {
  value: "auto" as const,
  label: "自动识别"
};

export function NftAssetInput({
  autoDiscovery,
  children,
  contractAddress,
  contractStatus = "empty",
  defaultMode = "manual",
  disabled,
  onChange,
  onContractAddressChange,
  onImportingChange,
  value
}: {
  autoDiscovery?: ReactNode;
  children?: ReactNode;
  contractAddress: string;
  contractStatus?: "empty" | "invalid" | "valid";
  defaultMode?: NftAssetInputMode;
  disabled?: boolean;
  onChange: (value: string) => void;
  onContractAddressChange: (value: string) => void;
  onImportingChange?: (importing: boolean) => void;
  value: string;
}) {
  const disabledRef = useRef(Boolean(disabled));
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importEpochRef = useRef<LocalFileImportEpoch>({ current: 0 });
  const importingRef = useRef(false);
  const modeGroupId = useId();
  const [tokenExpression, setTokenExpression] = useState("");
  const [issues, setIssues] = useState<NftAssetInputIssue[]>([]);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState("");
  const autoDiscoveryPanel = autoDiscovery ?? children;
  const [mode, setMode] = useState<NftAssetInputMode>(() => (
    defaultMode === "auto" && !autoDiscoveryPanel ? "manual" : defaultMode
  ));
  const availableModes = useMemo(() => (
    autoDiscoveryPanel ? [autoNftAssetInputMode, ...manualNftAssetInputModes] : manualNftAssetInputModes
  ), [autoDiscoveryPanel]);
  disabledRef.current = Boolean(disabled);

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

  useEffect(() => {
    if (disabled) cancelPendingImport();
  }, [cancelPendingImport, disabled]);

  useEffect(() => {
    if (mode === "auto" && !autoDiscoveryPanel) setMode("manual");
  }, [autoDiscoveryPanel, mode]);

  useEffect(() => () => {
    cancelLocalFileImport(importEpochRef.current);
    if (importingRef.current) {
      importingRef.current = false;
      onImportingChange?.(false);
    }
  }, [onImportingChange]);

  const addExpression = () => {
    cancelPendingImport();
    const merged = mergeNftAssetInput(value, contractAddress, tokenExpression);
    setIssues(merged.issues);
    if (merged.issues.some((issue) => issue.severity === "error")) {
      setMessage("请修正合约地址或 Token ID 后再加入");
      return;
    }

    onChange(merged.serialized);
    setTokenExpression("");
    setMessage(merged.added
      ? `已加入 ${merged.added} 个 NFT${merged.duplicates ? `，跳过 ${merged.duplicates} 个重复项` : ""}`
      : "没有新增资产，输入项已存在于清单中");
  };

  const importAssetFile = async (file: File | undefined) => {
    if (!file) return;
    const requestId = beginLocalFileImport(importEpochRef.current);
    setImportActive(true);
    setIssues([]);
    setMessage("正在本地读取 NFT 资产清单…");
    try {
      if (file.size > maximumNftAssetFileBytes) {
        setIssues([]);
        setMessage("文件不能超过 512 KB");
        return;
      }
      if (!/\.(?:txt|csv)$/i.test(file.name) || !nftAssetFileTypes.has(file.type.trim().toLowerCase())) {
        setIssues([]);
        setMessage("仅支持 TXT 或 CSV 文件");
        return;
      }
      const fileText = await file.text();
      if (!isCurrentLocalFileImport(importEpochRef.current, requestId) || disabledRef.current) return;
      const parsed = parseNftAssetFile(fileText);
      setIssues(parsed.issues);
      if (!parsed.valid) {
        setMessage("文件中没有可导入的 NFT 资产");
        return;
      }
      if (parsed.truncated || parsed.issues.some((issue) => issue.severity === "error")) {
        setMessage(`文件有 ${parsed.invalid} 行需要修正，为避免静默丢失资产，未修改当前清单`);
        return;
      }

      const existing = value.trim() ? parseNftAssetFile(value) : null;
      if (existing?.issues.some((issue) => issue.severity === "error")) {
        setIssues(existing.issues);
        setMessage("当前资产清单仍有错误，请先修正后再导入文件");
        return;
      }
      const combined = parseNftAssetFile([existing?.serialized, parsed.serialized].filter(Boolean).join("\n"));
      if (combined.truncated || combined.issues.some((issue) => issue.severity === "error")) {
        setIssues(combined.issues);
        setMessage("合并后超过 1000 个 NFT 的单次安全上限，未修改当前清单；请分批执行");
        return;
      }
      onChange(combined.serialized);
      setIssues([...parsed.issues, ...combined.issues.filter((issue) => issue.code === "duplicate-row")]);
      const added = combined.valid - (existing?.valid || 0);
      const duplicates = parsed.duplicates + combined.duplicates;
      setMessage(added
        ? `已从文件加入 ${added} 个资产${duplicates ? `，跳过 ${duplicates} 个重复项` : ""}`
        : "文件中的资产已全部存在于当前清单");
    } catch {
      if (isCurrentLocalFileImport(importEpochRef.current, requestId)) {
        setIssues([]);
        setMessage("文件读取失败，请使用 UTF-8 编码的 TXT 或 CSV");
      }
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
      if (isCurrentLocalFileImport(importEpochRef.current, requestId)) setImportActive(false);
    }
  };

  const controlsDisabled = Boolean(disabled) || importing;

  const selectMode = (nextMode: NftAssetInputMode) => {
    if (mode === nextMode) return;
    cancelPendingImport();
    setIssues([]);
    setMessage("");
    setMode(nextMode);
  };

  return (
    <section aria-busy={importing || undefined} className="nft-asset-builder" aria-labelledby="nft-asset-builder-title">
      <h3 className="sr-only" id="nft-asset-builder-title">NFT 资产</h3>

      <div className="field nft-contract-field" data-status={contractStatus}>
        <div className="nft-field-label-row">
          <label htmlFor="nft-quick-contract">NFT 合约</label>
          <span aria-live="polite" className="nft-field-status">
            {contractStatus === "valid" ? "地址格式有效" : contractStatus === "invalid" ? "地址格式不正确" : "等待输入"}
          </span>
        </div>
        <div className="nft-contract-control">
          <input
            aria-describedby={`${modeGroupId}-contract-help`}
            aria-invalid={contractStatus === "invalid" ? true : undefined}
            autoCapitalize="none"
            autoComplete="off"
            disabled={controlsDisabled}
            id="nft-quick-contract"
            onChange={(event) => {
              cancelPendingImport();
              onContractAddressChange(event.target.value);
            }}
            placeholder="0x…"
            spellCheck={false}
            value={contractAddress}
          />
          <span aria-hidden="true" className="nft-contract-state-mark">
            {contractStatus === "valid" ? "✓" : contractStatus === "invalid" ? "×" : "0x"}
          </span>
        </div>
        <p className="hint" id={`${modeGroupId}-contract-help`}>
          {mode === "auto" || mode === "manual"
            ? "用于自动识别与手动添加；切换方式不会清空地址。"
            : "文件与高级模式按每行读取合约地址；此处地址仅在切回自动或手动时使用。"}
        </p>
      </div>

      <fieldset className="nft-mode-picker">
        <legend>添加方式</legend>
        <div className="nft-mode-tabs" role="tablist" aria-label="NFT 添加方式">
          {availableModes.map((option) => (
            <button
              aria-controls={`${modeGroupId}-${option.value}-panel`}
              aria-selected={mode === option.value}
              className={mode === option.value ? "is-active" : undefined}
              disabled={controlsDisabled}
              id={`${modeGroupId}-${option.value}-tab`}
              key={option.value}
              onClick={() => selectMode(option.value)}
              role="tab"
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      </fieldset>

      <input
        accept=".txt,.csv,text/plain,text/csv"
        disabled={controlsDisabled}
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          void importAssetFile(file);
        }}
        ref={fileInputRef}
        type="file"
      />

      {mode === "auto" && autoDiscoveryPanel ? (
        <div
          aria-labelledby={`${modeGroupId}-auto-tab`}
          id={`${modeGroupId}-auto-panel`}
          role="tabpanel"
        >
          {autoDiscoveryPanel}
        </div>
      ) : null}

      {mode === "manual" ? (
        <div
          aria-labelledby={`${modeGroupId}-manual-tab`}
          className="nft-asset-builder-fields"
          id={`${modeGroupId}-manual-panel`}
          role="tabpanel"
        >
          <div className="field">
            <label htmlFor="nft-token-expression">Token ID / 区间</label>
            <input
              disabled={controlsDisabled}
              id="nft-token-expression"
              onChange={(event) => {
                cancelPendingImport();
                setTokenExpression(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addExpression();
                }
              }}
              placeholder="例如 1, 3, 8-12"
              spellCheck={false}
              value={tokenExpression}
            />
          </div>
          <button className="button primary nft-add-button" disabled={controlsDisabled || !contractAddress.trim() || !tokenExpression.trim()} onClick={addExpression} type="button">
            加入清单
          </button>
        </div>
      ) : null}

      {mode === "file" ? (
        <div
          aria-labelledby={`${modeGroupId}-file-tab`}
          className="form"
          id={`${modeGroupId}-file-panel`}
          role="tabpanel"
        >
          <p className="hint" id={`${modeGroupId}-file-help`}>
            每行填写 NFT 合约地址和 Token ID。文件仅在当前页面本地解析，支持 TXT、CSV，最大 512 KB。
          </p>
          <div className="nft-discovery-action">
            <button
              aria-describedby={`${modeGroupId}-file-help`}
              className="button primary"
              disabled={controlsDisabled}
              onClick={() => fileInputRef.current?.click()}
              type="button"
            >
              {importing ? "正在导入" : "选择 TXT/CSV 文件"}
            </button>
          </div>
        </div>
      ) : null}

      {mode === "advanced" ? (
        <div
          aria-labelledby={`${modeGroupId}-advanced-tab`}
          className="field"
          id={`${modeGroupId}-advanced-panel`}
          role="tabpanel"
        >
          <label htmlFor="nft-asset-raw-input">原始资产清单</label>
          <textarea
            aria-describedby={`${modeGroupId}-advanced-help`}
            className="collection-asset-textarea"
            disabled={controlsDisabled}
            id="nft-asset-raw-input"
            onChange={(event) => {
              cancelPendingImport();
              setIssues([]);
              setMessage("");
              onChange(event.target.value);
            }}
            placeholder={"每行一个 NFT\n0x合约地址,Token ID"}
            spellCheck={false}
            value={value}
          />
          <p className="hint" id={`${modeGroupId}-advanced-help`}>
            适合粘贴或修正规范化清单；每行格式为“合约地址,Token ID”。
          </p>
        </div>
      ) : null}

      {message ? <p className="hint" role="status">{message}</p> : null}
      {issues.length ? (
        <ul className="nft-asset-builder-issues" role="alert">
          {issues.slice(0, 5).map((issue, index) => <li key={`${issue.code}-${issue.line || issue.item || index}`}>{issue.message}</li>)}
        </ul>
      ) : null}
    </section>
  );
}
