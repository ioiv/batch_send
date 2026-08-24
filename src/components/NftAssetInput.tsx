import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  { value: "manual", label: "手工 / 文件" }
];

const autoNftAssetInputMode = {
  value: "auto" as const,
  label: "自动识别"
};

export function NftAssetInput({
  autoOnly = false,
  autoDiscovery,
  children,
  contractAddress,
  contractStatus = "empty",
  defaultMode = "manual",
  disabled,
  onChange,
  onContractAddressChange,
  onImportingChange,
  onStandardChange,
  standard = "erc721",
  value
}: {
  autoOnly?: boolean;
  autoDiscovery?: ReactNode;
  children?: ReactNode;
  contractAddress: string;
  contractStatus?: "empty" | "invalid" | "valid";
  defaultMode?: NftAssetInputMode;
  disabled?: boolean;
  onChange: (value: string) => void;
  onContractAddressChange: (value: string) => void;
  onImportingChange?: (importing: boolean) => void;
  onStandardChange?: (standard: "erc721" | "erc1155") => void;
  standard?: "erc721" | "erc1155";
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
    (autoOnly || defaultMode === "auto") && autoDiscoveryPanel ? "auto" : "manual"
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
    if (autoOnly && autoDiscoveryPanel && mode !== "auto") {
      setMode("auto");
      return;
    }
    if (mode === "auto" && !autoDiscoveryPanel) setMode("manual");
  }, [autoDiscoveryPanel, autoOnly, mode]);

  useEffect(() => () => {
    cancelLocalFileImport(importEpochRef.current);
    if (importingRef.current) {
      importingRef.current = false;
      onImportingChange?.(false);
    }
  }, [onImportingChange]);

  const addExpression = () => {
    cancelPendingImport();
    const merged = mergeNftAssetInput(value, contractAddress, tokenExpression, { standard });
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

      <Field className="nft-contract-field" data-status={contractStatus}>
        <div className="nft-field-label-row">
          <FieldLabel htmlFor="nft-quick-contract">NFT 合约</FieldLabel>
          <Badge aria-live="polite" className="nft-field-status" variant={contractStatus === "invalid" ? "destructive" : "outline"}>
            {contractStatus === "valid" ? "地址格式有效" : contractStatus === "invalid" ? "地址格式不正确" : "等待输入"}
          </Badge>
        </div>
        <div className="nft-contract-control">
          <Input
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
        <FieldDescription className="sr-only" id={`${modeGroupId}-contract-help`}>输入 NFT 合约地址。</FieldDescription>
      </Field>

      <Input
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

      {autoOnly && autoDiscoveryPanel ? (
        <div className="nft-mode-picker">{autoDiscoveryPanel}</div>
      ) : (
        <Tabs className="nft-mode-picker" onValueChange={(nextMode) => selectMode(nextMode as NftAssetInputMode)} value={mode}>
          <TabsList aria-label="NFT 添加方式" className="nft-mode-tabs">
            {availableModes.map((option) => (
              <TabsTrigger
                disabled={controlsDisabled}
                key={option.value}
                value={option.value}
              >
                {option.label}
              </TabsTrigger>
            ))}
          </TabsList>

          {autoDiscoveryPanel ? <TabsContent value="auto">{autoDiscoveryPanel}</TabsContent> : null}

          <TabsContent className="nft-asset-builder-fields" value="manual">
            {onStandardChange ? (
              <Field>
                <FieldLabel>NFT 标准</FieldLabel>
                <Tabs
                  onValueChange={(nextStandard) => onStandardChange(nextStandard as "erc721" | "erc1155")}
                  value={standard}
                >
                  <TabsList aria-label="NFT 标准">
                    <TabsTrigger disabled={controlsDisabled} value="erc721">ERC721</TabsTrigger>
                    <TabsTrigger disabled={controlsDisabled} value="erc1155">ERC1155</TabsTrigger>
                  </TabsList>
                </Tabs>
              </Field>
            ) : null}
            <Field>
              <FieldLabel htmlFor="nft-token-expression">Token ID / 区间</FieldLabel>
              <Input
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
            </Field>
            <Button className="nft-add-button" disabled={controlsDisabled || !contractAddress.trim() || !tokenExpression.trim()} onClick={addExpression} type="button">
              加入清单
            </Button>
            <Button disabled={controlsDisabled} onClick={() => fileInputRef.current?.click()} type="button" variant="outline">
              {importing ? "正在导入" : "导入 TXT/CSV"}
            </Button>
          </TabsContent>
        </Tabs>
      )}

      {message ? <Alert><AlertDescription role="status">{message}</AlertDescription></Alert> : null}
      {issues.length ? (
        <FieldError className="nft-asset-builder-issues">
          <ul>
          {issues.slice(0, 5).map((issue, index) => <li key={`${issue.code}-${issue.line || issue.item || index}`}>{issue.message}</li>)}
          </ul>
        </FieldError>
      ) : null}
    </section>
  );
}
