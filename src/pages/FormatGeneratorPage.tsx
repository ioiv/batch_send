import { useMemo, useState } from "react";
import { BrandHeader, NavLinks, SkipLink } from "../components/BrandHeader";
import { Metric } from "../components/Metric";
import { copyText } from "../lib/clipboard";
import { getDuplicateAddressKey, getListAddressKind } from "../lib/address";
import { formatLamports, parseSolToLamports, randomLamportsInStepRange } from "../lib/amount";
import { getDistributionTransferHref } from "../lib/distribution";

export function FormatGeneratorPage() {
  const [addresses, setAddresses] = useState("");
  const [mode, setMode] = useState<"fixed" | "random">("fixed");
  const [fixedAmount, setFixedAmount] = useState("0.1");
  const [minAmount, setMinAmount] = useState("0.08");
  const [maxAmount, setMaxAmount] = useState("0.12");
  const [copyLabel, setCopyLabel] = useState("复制结果");
  const [generationNonce, setGenerationNonce] = useState(1);

  const result = useMemo(() => {
    const rows = addresses.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    const seen = new Set<string>();
    const issues: string[] = [];
    const generated: string[] = [];
    let totalLamports = 0n;
    let duplicates = 0;
    let evmCount = 0;

    rows.forEach((address, index) => {
      const addressKind = getListAddressKind(address);
      if (!addressKind) {
        issues.push(`第 ${index + 1} 行地址格式不正确`);
        return;
      }

      if (addressKind === "evm") evmCount += 1;

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
          ? randomLamportsInStepRange(minLamports, maxLamports)
          : null;
      }

      if (!amountLamports) {
        issues.push(mode === "fixed" ? "固定金额需要大于 0，最多 9 位小数" : "随机区间需要大于 0，最大值不能小于最小值，并且至少覆盖 0.0001 SOL 步进");
        return;
      }

      const normalized = formatLamports(amountLamports);
      totalLamports += amountLamports;
      generated.push(`${address},${normalized}`);
    });

    return {
      duplicates,
      evmCount,
      issues,
      output: generated.join("\n"),
      total: formatLamports(totalLamports),
      validCount: generated.length
    };
  }, [addresses, fixedAmount, generationNonce, maxAmount, minAmount, mode]);

  const updateAndRegenerate = (setter: (value: string) => void, value: string) => {
    setter(value);
    setGenerationNonce((current) => current + 1);
    setCopyLabel("复制结果");
  };

  const copyOutput = async () => {
    if (!result.output) return;
    await copyText(result.output);
    setCopyLabel("已复制");
    window.setTimeout(() => setCopyLabel("复制结果"), 1200);
  };

  const goToDistributor = () => {
    if (!result.output || result.evmCount > 0) return;
    window.location.href = getDistributionTransferHref(result.output);
  };

  return (
    <>
      <SkipLink />
      <main className="shell tool-shell page-format" id="main">
        <BrandHeader
          eyebrow="format generator"
          title="生成地址,金额清单"
          subtitle="输入多行地址，给每个地址分配固定金额，或在指定区间内生成随机金额。"
          nav={<NavLinks current="format" />}
        />

        <section className="workspace flow-workspace">
          <section className="panel input-panel" aria-labelledby="input-title">
            <div className="panel-header">
              <div>
                <h2 className="panel-title" id="input-title">地址与金额</h2>
                <p className="panel-note">每行一个地址；空行会自动忽略。</p>
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

              <div className="mode-row" role="radiogroup" aria-label="金额模式">
                <label className="mode">
                  <span className="mode-head">
                    <input type="radio" name="amountMode" value="fixed" checked={mode === "fixed"} onChange={() => setMode("fixed")} />
                    固定金额
                  </span>
                  <span className="hint">所有地址使用同一个金额。</span>
                </label>
                <label className="mode">
                  <span className="mode-head">
                    <input type="radio" name="amountMode" value="random" checked={mode === "random"} onChange={() => {
                      setMode("random");
                      setGenerationNonce((current) => current + 1);
                    }} />
                    随机区间
                  </span>
                  <span className="hint">每个地址生成一个区间内的随机金额。</span>
                </label>
              </div>

              <div className="amount-grid">
                <div className="field">
                  <label htmlFor="fixedAmount">固定金额</label>
                  <input id="fixedAmount" type="number" min="0" step="0.0001" value={fixedAmount} onChange={(event) => updateAndRegenerate(setFixedAmount, event.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="minAmount">随机最小值</label>
                  <input id="minAmount" type="number" min="0" step="0.0001" value={minAmount} onChange={(event) => updateAndRegenerate(setMinAmount, event.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="maxAmount">随机最大值</label>
                  <input id="maxAmount" type="number" min="0" step="0.0001" value={maxAmount} onChange={(event) => updateAndRegenerate(setMaxAmount, event.target.value)} />
                </div>
              </div>

              <div className="actions">
                <div className="action-group">
                  <button className="button primary" type="button" onClick={() => setGenerationNonce((current) => current + 1)}>生成清单</button>
                  <button
                    className="button"
                    type="button"
                    disabled={!result.output || result.evmCount > 0}
                    title={result.evmCount > 0 ? "分发页只支持 Solana 地址；EVM 清单请复制使用。" : undefined}
                    onClick={goToDistributor}
                  >
                    去分发
                  </button>
                  <button className="button ghost" type="button" onClick={() => updateAndRegenerate(setAddresses, "")}>清空</button>
                </div>
                <button className="button" type="button" disabled={!result.output} onClick={copyOutput}>{copyLabel}</button>
              </div>
            </div>

            <div className="stats" aria-label="生成统计">
              <Metric value={String(result.validCount)} label="有效地址" />
              <Metric value={result.total} label="统计总额" />
              <Metric value={String(result.duplicates)} label="重复地址" />
            </div>
          </section>

          <aside className="panel output-panel" aria-labelledby="result-title">
            <div className="panel-header">
              <div>
                <h2 className="panel-title" id="result-title">生成结果</h2>
                <p className="panel-note">{result.evmCount > 0 ? "EVM 清单可复制到外部流程使用。" : "复制后可直接粘贴到分发页。"}</p>
              </div>
              <span className="pill">{mode === "fixed" ? "固定金额" : "随机区间"}</span>
            </div>
            <div className="form">
              <div className="result" aria-live="polite">
                {result.output ? <pre>{result.output}</pre> : <div className="empty">生成后会显示为：<br />地址,金额</div>}
              </div>
              <div className="notice">
                <strong>金额统计按 lamports 精确累加。</strong>
                <span>随机金额使用浏览器安全随机数，并按 0.0001 SOL 步进生成。</span>
              </div>
              <div className="invalid-list">
                {result.issues.slice(0, 5).map((issue) => (
                  <div key={issue}>{issue}</div>
                ))}
              </div>
            </div>
          </aside>
        </section>
      </main>
    </>
  );
}
