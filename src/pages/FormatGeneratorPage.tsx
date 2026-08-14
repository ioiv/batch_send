import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Metric } from "../components/Metric";
import { ToolPageLayout, type ToolPageStep } from "../components/ToolPageLayout";
import { copyText } from "../lib/clipboard";
import { getDuplicateAddressKey, getListAddressKind } from "../lib/address";
import { formatLamports, formatLamportsForDisplay, getSolAmountFractionDigits, getSolAmountStepLamports, parseSolToLamports, randomLamportsInStepRange } from "../lib/amount";
import { getDistributionTargetPage, getDistributionTransferHref } from "../lib/distribution";
import { importDistributionFileText } from "../lib/distribution-generator";
import {
  beginLocalFileImport,
  cancelLocalFileImport,
  isCurrentLocalFileImport,
  type LocalFileImportEpoch
} from "../lib/local-file-import";

const formatSteps: ToolPageStep[] = [
  { label: "输入地址", description: "粘贴并校验收款地址" },
  { label: "生成清单", description: "设置金额并整理格式" },
  { label: "进入分发", description: "复制或带入发送工具" }
];

const distributionFileTypes = new Set(["", "application/csv", "application/vnd.ms-excel", "text/csv", "text/plain"]);

export function FormatGeneratorPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importEpochRef = useRef<LocalFileImportEpoch>({ current: 0 });
  const [addresses, setAddresses] = useState("");
  const [mode, setMode] = useState<"fixed" | "random">("fixed");
  const [fixedAmount, setFixedAmount] = useState("0.1");
  const [minAmount, setMinAmount] = useState("0.5");
  const [maxAmount, setMaxAmount] = useState("1");
  const [copyLabel, setCopyLabel] = useState("复制结果");
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
        issues.push(mode === "fixed" ? "固定金额需要大于 0，最多 9 位小数" : "随机区间需要大于 0，最大值不能小于最小值，并且至少覆盖当前金额精度");
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

  const isMixedList = result.solanaCount > 0 && result.evmCount > 0;
  const distributionTargetPage = getDistributionTargetPage(result.output);
  const resultNote = isMixedList
    ? "请拆成 Solana 和 EVM 两份清单后分别进入对应分发页。"
    : result.evmCount > 0
      ? "复制后可直接粘贴到 EVM 分发页，也可以直接跳转。"
      : "复制后可直接粘贴到 SOL 分发页，也可以直接跳转。";

  const cancelPendingImport = useCallback(() => {
    cancelLocalFileImport(importEpochRef.current);
    setImporting(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  useEffect(() => () => {
    cancelLocalFileImport(importEpochRef.current);
  }, []);

  const updateAndRegenerate = (setter: (value: string) => void, value: string) => {
    cancelPendingImport();
    setter(value);
    setGenerationNonce((current) => current + 1);
    setCopyLabel("复制结果");
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

  const copyOutput = async () => {
    if (!result.output) return;
    await copyText(result.output);
    setCopyLabel("已复制");
    window.setTimeout(() => setCopyLabel("复制结果"), 1200);
  };

  const goToDistributor = () => {
    if (!result.output || !distributionTargetPage) return;
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
      setCopyLabel("复制结果");
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

  const activeStep = result.output ? 2 : addresses.trim() ? 1 : 0;

  return (
    <ToolPageLayout
      activeStep={activeStep}
      categoryHref="/#utility"
      categoryLabel="数据工具"
      currentToolId="format-generator"
      description="粘贴地址、设置统一或随机金额，生成可直接导入 SOL 与 EVM 批量发送工具的清单。"
      eyebrow="List builder · SOL & EVM"
      mainClassName="page-format"
      meta={<><span className="pill">本地生成</span><span className="pill">不连接钱包</span></>}
      steps={formatSteps}
      title="分发格式生成"
    >
        <section className="workspace flow-workspace">
          <section className="panel input-panel" aria-labelledby="input-title">
            <div className="panel-header">
              <div>
                <h2 className="panel-title" id="input-title">地址与金额</h2>
                <p className="panel-note">每行一个地址；空行会自动忽略。</p>
              </div>
              <div className="panel-header-actions">
                <input
                  accept=".txt,.csv,text/plain,text/csv"
                  className="sr-only"
                  disabled={importing}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = "";
                    void importAddressFile(file);
                  }}
                  ref={fileInputRef}
                  tabIndex={-1}
                  type="file"
                />
                <button className="button ghost compact-button" disabled={importing} onClick={() => fileInputRef.current?.click()} type="button">
                  {importing ? "正在导入" : "导入 TXT/CSV"}
                </button>
              </div>
            </div>

            <div className="form">
              <div className="field">
                <label htmlFor="addresses">地址列表</label>
                <p className="hint">支持粘贴多行地址，会做基础格式校验和重复项统计。</p>
                <textarea
                  id="addresses"
                  spellCheck={false}
                  value={addresses}
                  onChange={(event) => updateAndRegenerate(setAddresses, event.target.value)}
                  placeholder={"7hQmJpYvKq2ms2uUpu2f4pCmJfM7m2HJ9dXkR4g3SxyQ\n0x742d35Cc6634C0532925a3b844Bc454e4438f44e"}
                />
              </div>
              {importMessage ? <p className="hint" role="status">{importMessage}</p> : null}

              <div className="mode-row" role="radiogroup" aria-label="金额模式">
                <label className="mode">
                  <span className="mode-head">
                    <input type="radio" name="amountMode" value="fixed" checked={mode === "fixed"} onChange={() => setMode("fixed")} />
                    固定金额
                  </span>
                </label>
                <label className="mode">
                  <span className="mode-head">
                    <input type="radio" name="amountMode" value="random" checked={mode === "random"} onChange={() => {
                      setMode("random");
                      setGenerationNonce((current) => current + 1);
                    }} />
                    随机区间
                  </span>
                </label>
              </div>

              <div className="amount-grid">
                <div className="field">
                  <label htmlFor="fixedAmount">固定金额</label>
                  <input id="fixedAmount" type="number" min="0" step={fixedAmountStep} value={fixedAmount} onChange={(event) => updateAndRegenerate(setFixedAmount, event.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="minAmount">随机最小值</label>
                  <input id="minAmount" type="number" min="0" step={randomAmountStep} value={minAmount} onChange={(event) => updateAndRegenerate(setMinAmount, event.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="maxAmount">随机最大值</label>
                  <input id="maxAmount" type="number" min="0" step={randomAmountStep} value={maxAmount} onChange={(event) => updateAndRegenerate(setMaxAmount, event.target.value)} />
                </div>
              </div>

              <div className="actions">
                <div className="action-group">
                  <button
                    className="button primary"
                    type="button"
                    disabled={!result.output || !distributionTargetPage}
                    title={isMixedList ? "同一清单不能同时进入 SOL 和 EVM 分发页，请先拆分。" : undefined}
                    onClick={goToDistributor}
                  >
                    去分发
                  </button>
                  <button className="button ghost" type="button" disabled={!addresses.trim()} onClick={dedupeAddresses}>去重</button>
                  <button className="button ghost" type="button" onClick={() => updateAndRegenerate(setAddresses, "")}>清空</button>
                </div>
                <button className="button" type="button" disabled={!result.output} onClick={copyOutput}>{copyLabel}</button>
              </div>
            </div>

            <div className="stats" aria-label="生成统计">
              <Metric value={String(result.validCount)} label="有效收款地址" />
              <Metric value={result.total} label="合计金额" />
              <Metric value={String(result.invalid)} label="需修正" />
              <Metric value={String(result.duplicates)} label="重复地址" />
            </div>
          </section>

          <aside className="panel output-panel" aria-labelledby="result-title">
            <div className="panel-header">
              <div>
                <h2 className="panel-title" id="result-title">生成结果</h2>
                <p className="panel-note">{resultNote}</p>
              </div>
              <span className="pill">{mode === "fixed" ? "固定金额" : "随机区间"}</span>
            </div>
            <div className="form">
              <div className="result" aria-live="polite">
                {result.output ? <pre>{result.output}</pre> : <div className="empty">生成后会显示为：<br />地址,金额</div>}
              </div>
              <div className="invalid-list">
                {result.issues.slice(0, 5).map((issue) => (
                  <div key={issue}>{issue}</div>
                ))}
              </div>
            </div>
          </aside>
        </section>
    </ToolPageLayout>
  );
}
