import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DistributionListEditor } from "../components/DistributionListEditor";
import { ToolPageLayout, type WorkbenchStatus } from "../components/ToolPageLayout";
import { ResultTable, WorkbenchPanel } from "../components/WorkbenchPrimitives";
import { copyText } from "../lib/clipboard";
import { getDuplicateAddressKey, getListAddressKind } from "../lib/address";
import {
  formatLamports,
  formatLamportsForDisplay,
  getSolAmountFractionDigits,
  getSolAmountStepLamports,
  parseSolToLamports,
  randomLamportsInStepRange
} from "../lib/amount";
import { evmDistributionPage, getDistributionTargetPage, getDistributionTransferHref } from "../lib/distribution";
import { importDistributionFileText, type DistributionAmountMode } from "../lib/distribution-generator";
import {
  beginLocalFileImport,
  cancelLocalFileImport,
  isCurrentLocalFileImport,
  type LocalFileImportEpoch
} from "../lib/local-file-import";

const distributionFileTypes = new Set(["", "application/csv", "application/vnd.ms-excel", "text/csv", "text/plain"]);

export function getFormatOutputGate({
  duplicates,
  invalid,
  output
}: {
  duplicates: number;
  invalid: number;
  output: string;
}) {
  const blockers = [
    invalid > 0 ? `${invalid} 条输入需要修正` : "",
    duplicates > 0 ? `${duplicates} 个重复地址需要去重` : ""
  ].filter(Boolean);
  const blocked = blockers.length > 0;

  return {
    blocked,
    canUseOutput: Boolean(output) && !blocked,
    message: blocked
      ? `${blockers.join("，")}。为避免漏发或重复发送，处理完成前不能复制或进入分发。`
      : ""
  };
}

type PreviewRow = {
  address: string;
  amount: string;
};

export function FormatGeneratorPage() {
  const addressInputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importEpochRef = useRef<LocalFileImportEpoch>({ current: 0 });
  const [addresses, setAddresses] = useState("");
  const [mode, setMode] = useState<DistributionAmountMode>("fixed");
  const [fixedAmount, setFixedAmount] = useState("0.1");
  const [minAmount, setMinAmount] = useState("0.5");
  const [maxAmount, setMaxAmount] = useState("1");
  const [copyLabel, setCopyLabel] = useState("复制结果");
  const [copyFeedback, setCopyFeedback] = useState<{ kind: "error" | "success"; message: string } | null>(null);
  const [generationNonce, setGenerationNonce] = useState(1);
  const [importMessage, setImportMessage] = useState("");
  const [importing, setImporting] = useState(false);
  const fixedAmountStep = formatLamports(getSolAmountStepLamports(fixedAmount));
  const randomAmountStepLamports = getSolAmountStepLamports(minAmount, maxAmount);
  const randomAmountStep = formatLamports(randomAmountStepLamports);

  const result = useMemo(() => {
    const rows = addresses.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    const seen = new Set<string>();
    const issues: string[] = [];
    const generated: string[] = [];
    let invalid = 0;
    const totalFractionDigits = mode === "fixed"
      ? getSolAmountFractionDigits(fixedAmount)
      : Math.max(getSolAmountFractionDigits(minAmount), getSolAmountFractionDigits(maxAmount));
    let totalLamports = 0n;
    let duplicates = 0;
    let evmCount = 0;
    let solanaCount = 0;

    rows.forEach((address, index) => {
      const addressKind = getListAddressKind(address);
      if (!addressKind) {
        issues.push(`第 ${index + 1} 行地址格式不正确`);
        invalid += 1;
        return;
      }

      if (addressKind === "evm") evmCount += 1;
      else solanaCount += 1;

      const duplicateKey = getDuplicateAddressKey(address, addressKind);
      if (seen.has(duplicateKey)) duplicates += 1;
      seen.add(duplicateKey);

      let amountLamports: bigint | null = null;
      if (mode === "fixed") {
        amountLamports = parseSolToLamports(fixedAmount);
      } else {
        const minLamports = parseSolToLamports(minAmount);
        const maxLamports = parseSolToLamports(maxAmount);
        amountLamports = minLamports && maxLamports && maxLamports >= minLamports
          ? randomLamportsInStepRange(minLamports, maxLamports, randomAmountStepLamports)
          : null;
      }

      if (!amountLamports) {
        issues.push(mode === "fixed"
          ? "固定金额需要大于 0，最多 9 位小数"
          : "随机区间需要大于 0，最大值不能小于最小值，并且至少覆盖当前金额精度");
        invalid += 1;
        return;
      }

      const normalized = formatLamports(amountLamports);
      totalLamports += amountLamports;
      generated.push(`${address},${normalized}`);
    });

    return {
      duplicates,
      evmCount,
      invalid,
      issues,
      output: generated.join("\n"),
      solanaCount,
      total: formatLamportsForDisplay(totalLamports, totalFractionDigits),
      validCount: generated.length
    };
  }, [addresses, fixedAmount, generationNonce, maxAmount, minAmount, mode, randomAmountStepLamports]);

  const previewRows = useMemo<PreviewRow[]>(() => result.output.split("\n").filter(Boolean).map((line) => {
    const separator = line.lastIndexOf(",");
    return {
      address: separator >= 0 ? line.slice(0, separator) : line,
      amount: separator >= 0 ? line.slice(separator + 1) : ""
    };
  }), [result.output]);
  const isMixedList = result.solanaCount > 0 && result.evmCount > 0;
  const distributionTargetPage = getDistributionTargetPage(result.output);
  const outputGate = getFormatOutputGate(result);
  const canUseOutput = outputGate.canUseOutput && !isMixedList;
  const hasAddressIssues = result.issues.some((issue) => /^第 \d+ 行地址格式不正确$/.test(issue));
  const resultAnnouncement = addresses.trim()
    ? `生成结果：${result.validCount} 条有效，${result.invalid} 条需修正，${result.duplicates} 条重复。`
    : "尚未输入地址。";
  const pageStatus: WorkbenchStatus = outputGate.blocked || isMixedList
    ? "error"
    : canUseOutput
      ? "ready"
      : "editing";
  const statusLabel = isMixedList
    ? "需拆分链"
    : outputGate.blocked
      ? "需修正"
      : canUseOutput
        ? "可导出"
        : "等待输入";

  const cancelPendingImport = useCallback(() => {
    cancelLocalFileImport(importEpochRef.current);
    setImporting(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  useEffect(() => () => {
    cancelLocalFileImport(importEpochRef.current);
  }, []);

  const invalidateOutputFeedback = () => {
    setCopyLabel("复制结果");
    setCopyFeedback(null);
  };

  const updateAndRegenerate = (setter: (value: string) => void, value: string) => {
    cancelPendingImport();
    setter(value);
    setGenerationNonce((current) => current + 1);
    invalidateOutputFeedback();
  };

  const changeMode = (nextMode: DistributionAmountMode) => {
    if (nextMode === mode) return;
    cancelPendingImport();
    setMode(nextMode);
    setGenerationNonce((current) => current + 1);
    invalidateOutputFeedback();
  };

  const dedupeAddresses = () => {
    const seen = new Set<string>();
    const deduped = addresses.split(/\n+/).map((line) => line.trim()).filter(Boolean).filter((address) => {
      const addressKind = getListAddressKind(address);
      const duplicateKey = addressKind ? `${addressKind}:${getDuplicateAddressKey(address, addressKind)}` : `unknown:${address}`;
      if (seen.has(duplicateKey)) return false;
      seen.add(duplicateKey);
      return true;
    });

    updateAndRegenerate(setAddresses, deduped.join("\n"));
  };

  const focusFirstInvalidInput = () => {
    if (hasAddressIssues) {
      addressInputRef.current?.focus();
      return;
    }
    document.getElementById(`format-generator-${mode === "fixed" ? "fixed" : "min"}-amount`)?.focus();
  };

  const copyOutput = async () => {
    if (!canUseOutput) return;
    const copied = await copyText(result.output);
    if (!copied) {
      setCopyLabel("重试复制");
      setCopyFeedback({
        kind: "error",
        message: "浏览器未允许访问剪贴板，请在结果表中手动复制。"
      });
      return;
    }
    setCopyLabel("已复制");
    setCopyFeedback({ kind: "success", message: "结果已复制到剪贴板。" });
    window.setTimeout(() => setCopyLabel("复制结果"), 1200);
  };

  const goToDistributor = () => {
    if (!canUseOutput || !distributionTargetPage) return;
    window.location.href = getDistributionTransferHref(result.output, distributionTargetPage);
  };

  const importAddressFile = async (file: File | undefined) => {
    if (!file) return;
    const requestId = beginLocalFileImport(importEpochRef.current);
    setImporting(true);
    setImportMessage("正在本地读取清单…");
    try {
      if (file.size > 512 * 1024) {
        setImportMessage("文件不能超过 512 KB");
        return;
      }
      if (!/\.(?:txt|csv)$/i.test(file.name) || !distributionFileTypes.has(file.type.trim().toLowerCase())) {
        setImportMessage("仅支持 TXT 或 CSV 文件");
        return;
      }
      const fileText = await file.text();
      if (!isCurrentLocalFileImport(importEpochRef.current, requestId)) return;
      const imported = importDistributionFileText(fileText);
      if (!imported.addresses) {
        setImportMessage("文件中没有可导入的地址");
        return;
      }
      if (imported.truncated || imported.invalidRows > 0) {
        setImportMessage("文件存在超限或格式错误行，为避免静默丢失，未修改当前清单");
        return;
      }
      if (imported.hasMixedAmounts) {
        setImportMessage("文件包含逐行不同金额；本页只生成统一或随机金额，未修改当前清单");
        return;
      }
      setAddresses(imported.addresses);
      if (imported.hadAmounts && imported.fixedAmount) {
        setMode("fixed");
        setFixedAmount(imported.fixedAmount);
      }
      setGenerationNonce((current) => current + 1);
      invalidateOutputFeedback();
      setImportMessage(imported.hadAmounts
        ? `已导入 ${imported.addresses.split("\n").length} 个地址及统一金额 ${imported.fixedAmount}`
        : `已导入 ${imported.addresses.split("\n").length} 个地址`);
    } catch {
      if (isCurrentLocalFileImport(importEpochRef.current, requestId)) {
        setImportMessage("文件读取失败，请使用 UTF-8 编码的 TXT 或 CSV");
      }
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
      if (isCurrentLocalFileImport(importEpochRef.current, requestId)) setImporting(false);
    }
  };

  const targetLabel = distributionTargetPage === evmDistributionPage
    ? "进入 EVM 分发"
    : distributionTargetPage
      ? "进入 SOL 分发"
      : "进入分发";

  return (
    <ToolPageLayout
      className="page-format"
      currentToolId="format-generator"
      status={pageStatus}
      statusLabel={statusLabel}
      title="分发格式生成"
    >
      <div className="workbench-grid">
        <WorkbenchPanel
          actions={(
            <>
              <Input
                accept=".txt,.csv,text/plain,text/csv"
                aria-hidden="true"
                disabled={importing}
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
              <Button disabled={importing} onClick={() => fileInputRef.current?.click()} type="button" variant="outline">
                {importing ? "正在导入" : "导入 TXT/CSV"}
              </Button>
            </>
          )}
          className="min-w-0"
          footer={(
            <div className="flex w-full flex-wrap gap-2">
              <Button disabled={!addresses.trim()} onClick={dedupeAddresses} type="button" variant="outline">去重</Button>
              <Button disabled={!addresses.trim()} onClick={() => updateAndRegenerate(setAddresses, "")} type="button" variant="destructive">清空</Button>
            </div>
          )}
          title="清单编辑"
        >
          <div className="flex min-w-0 flex-col gap-4">
            <DistributionListEditor
              addressInputRef={addressInputRef}
              addressPlaceholder={"7hQmJpYvKq2ms2uUpu2f4pCmJfM7m2HJ9dXkR4g3SxyQ\n0x742d35Cc6634C0532925a3b844Bc454e4438f44e"}
              addresses={addresses}
              fixedAmount={fixedAmount}
              fixedAmountStep={fixedAmountStep}
              idPrefix="format-generator"
              maxAmount={maxAmount}
              minAmount={minAmount}
              mode={mode}
              onAddressesChange={(value) => updateAndRegenerate(setAddresses, value)}
              onFixedAmountChange={(value) => updateAndRegenerate(setFixedAmount, value)}
              onMaxAmountChange={(value) => updateAndRegenerate(setMaxAmount, value)}
              onMinAmountChange={(value) => updateAndRegenerate(setMinAmount, value)}
              onModeChange={changeMode}
              randomAmountStep={randomAmountStep}
            />

            {importMessage ? (
              <Alert role="status">
                <AlertTitle>导入状态</AlertTitle>
                <AlertDescription>{importMessage}</AlertDescription>
              </Alert>
            ) : null}

            {outputGate.blocked ? (
              <Alert id="format-output-blocker" variant="destructive">
                <AlertTitle>请先修正清单</AlertTitle>
                <AlertDescription className="flex flex-col gap-2">
                  <span>{outputGate.message}</span>
                  <span className="flex flex-wrap gap-2">
                    {result.invalid > 0 ? (
                      <Button onClick={focusFirstInvalidInput} type="button" variant="outline">
                        {hasAddressIssues ? "修正地址" : "修正金额"}
                      </Button>
                    ) : null}
                    {result.duplicates > 0 ? (
                      <Button onClick={dedupeAddresses} type="button" variant="outline">立即去重</Button>
                    ) : null}
                  </span>
                </AlertDescription>
              </Alert>
            ) : null}

            {isMixedList ? (
              <Alert id="format-mixed-blocker" variant="destructive">
                <AlertTitle>清单包含两种生态地址</AlertTitle>
                <AlertDescription>请拆分 SOL 与 EVM 清单后再复制或进入分发。</AlertDescription>
              </Alert>
            ) : null}

            {result.issues.length > 0 ? (
              <Alert variant="destructive">
                <AlertTitle>校验结果</AlertTitle>
                <AlertDescription>
                  {result.issues.slice(0, 5).map((issue, index) => <div key={`${issue}-${index}`}>{issue}</div>)}
                </AlertDescription>
              </Alert>
            ) : null}
          </div>
        </WorkbenchPanel>

        <WorkbenchPanel
          actions={<Badge variant="outline">{mode === "fixed" ? "固定金额" : "随机区间"}</Badge>}
          className="min-w-0"
          footer={(
            <div className="flex w-full flex-wrap justify-end gap-2">
              <Button
                aria-describedby={outputGate.blocked ? "format-output-blocker" : isMixedList ? "format-mixed-blocker" : undefined}
                disabled={!canUseOutput}
                onClick={() => void copyOutput()}
                type="button"
                variant="outline"
              >{copyLabel}</Button>
              <Button
                aria-describedby={outputGate.blocked ? "format-output-blocker" : isMixedList ? "format-mixed-blocker" : undefined}
                disabled={!canUseOutput || !distributionTargetPage}
                onClick={goToDistributor}
                type="button"
              >{targetLabel}</Button>
            </div>
          )}
          title="实时预览"
        >
          <div className="flex min-w-0 flex-col gap-3">
            <p className="sr-only" aria-atomic="true" aria-live="polite">{resultAnnouncement}</p>
            <div className="flex flex-wrap gap-2" aria-label="生成统计">
              <Badge variant="outline">有效 {result.validCount}</Badge>
              <Badge variant="outline">合计 {result.total}</Badge>
              <Badge variant="outline">需修正 {result.invalid}</Badge>
              <Badge variant="outline">重复 {result.duplicates}</Badge>
            </div>
            <ResultTable
              caption="生成结果"
              columns={[
                {
                  header: "地址",
                  key: "address",
                  render: (row) => <span className="font-mono">{row.address}</span>
                },
                {
                  header: "金额",
                  key: "amount",
                  render: (row) => <span className="font-mono tabular-nums">{row.amount}</span>
                }
              ]}
              emptyLabel="暂无生成结果"
              getRowKey={(row, index) => `${row.address}-${index}`}
              rows={previewRows}
            />
            {copyFeedback ? (
              <Alert
                id="format-copy-feedback"
                role={copyFeedback.kind === "error" ? "alert" : "status"}
                variant={copyFeedback.kind === "error" ? "destructive" : "default"}
              >
                <AlertTitle>{copyFeedback.kind === "error" ? "复制失败" : "复制完成"}</AlertTitle>
                <AlertDescription>{copyFeedback.message}</AlertDescription>
              </Alert>
            ) : null}
          </div>
        </WorkbenchPanel>
      </div>
    </ToolPageLayout>
  );
}
