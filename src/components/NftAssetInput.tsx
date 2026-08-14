import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

export function NftAssetInput({
  contractAddress,
  disabled,
  onChange,
  onContractAddressChange,
  onImportingChange,
  value
}: {
  contractAddress: string;
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
  const [tokenExpression, setTokenExpression] = useState("");
  const [issues, setIssues] = useState<NftAssetInputIssue[]>([]);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState("");
  const itemCount = useMemo(() => value.trim() ? parseNftAssetFile(value).valid : 0, [value]);
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

  return (
    <section aria-busy={importing || undefined} className="nft-asset-builder" aria-labelledby="nft-asset-builder-title">
      <div className="nft-asset-builder-heading">
        <div>
          <h3 id="nft-asset-builder-title">快速添加 NFT</h3>
          <p>输入一个合约，再批量写 Token ID 或连续区间。</p>
        </div>
        <span className="pill">{itemCount ? `${itemCount} 个资产` : "清单为空"}</span>
        <input
          accept=".txt,.csv,text/plain,text/csv"
          className="sr-only"
          disabled={controlsDisabled}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            void importAssetFile(file);
          }}
          ref={fileInputRef}
          tabIndex={-1}
          type="file"
        />
        <div className="nft-asset-builder-actions">
          <button className="button ghost compact-button" disabled={controlsDisabled} onClick={() => fileInputRef.current?.click()} type="button">
            {importing ? "正在导入" : "导入 TXT/CSV"}
          </button>
        </div>
      </div>

      <div className="nft-asset-builder-fields">
        <div className="field">
          <label htmlFor="nft-quick-contract">NFT 合约</label>
          <input
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
        </div>
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

      {message ? <p className="hint" role="status">{message}</p> : null}
      {issues.length ? (
        <ul className="nft-asset-builder-issues" role="alert">
          {issues.slice(0, 5).map((issue, index) => <li key={`${issue.code}-${issue.line || issue.item || index}`}>{issue.message}</li>)}
        </ul>
      ) : null}
    </section>
  );
}
