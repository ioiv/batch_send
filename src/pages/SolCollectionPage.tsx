import { useCallback, useMemo, useRef, useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import { CollectionSafetyNote } from "../components/CollectionIntro";
import { CollectionResults } from "../components/CollectionResults";
import { SearchableSelect, type SearchableSelectOption } from "../components/SearchableSelect";
import { SecretKeyInput, type SecretKeyInputHandle } from "../components/SecretKeyInput";
import { ToolPageLayout, type ToolPageStep, type ToolPageStepState } from "../components/ToolPageLayout";
import { formatLamports, parseSolToLamports } from "../lib/amount";
import type { CollectionDisplayResult, CollectionResultStatus } from "../lib/collection-results";
import { validateSolCollectionWorkload } from "../lib/collection-workload";
import {
  collectSolFromSources,
  parseSolanaSourceKeys,
  preflightSolCollectionSources,
  type SolCollectionItemResult,
  type SolCollectionPreflightItem,
  type SolCollectionPreflightResult,
  type SolCollectionProgress
} from "../lib/sol-collection";
import {
  assertSolanaRpcNetwork,
  getExplorerUrl,
  getNetworkConfig,
  solanaNetworks,
  type SolanaNetworkId
} from "../lib/solana";

type CollectionStage = "editing" | "checking" | "ready" | "running" | "complete" | "error";

const solCollectionSteps: ToolPageStep[] = [
  { label: "配置来源", description: "设置网络、保留额与目标" },
  { label: "检查预览", description: "解析来源并核对地址" },
  { label: "确认归集", description: "读取费用、签名并确认" }
];

function validatePublicKey(value: string) {
  try {
    return new PublicKey(value).toBase58();
  } catch {
    return "";
  }
}

function itemToDisplay(item: SolCollectionItemResult, networkId: SolanaNetworkId): CollectionDisplayResult {
  return {
    address: item.address,
    amount: item.transferLamports > 0n ? formatLamports(item.transferLamports) : "0",
    asset: "SOL",
    ...(item.signature ? {
      explorerUrl: getExplorerUrl(item.signature, networkId),
      hash: item.signature
    } : {}),
    label: item.label,
    message: item.message,
    status: item.status === "success" ? "success" : item.status === "skipped" ? "skipped" : "error"
  };
}

function preflightItemToDisplay(item: SolCollectionPreflightItem): CollectionDisplayResult {
  return {
    address: item.address,
    amount: item.transferLamports > 0n ? formatLamports(item.transferLamports) : "0",
    asset: "SOL",
    label: item.label,
    message: item.status === "ready"
      ? `${item.message} · 预计归集 ${formatLamports(item.transferLamports)} SOL`
      : item.message,
    status: item.status === "ready" ? "pending" : item.status
  };
}

function progressStatus(phase: SolCollectionProgress["phase"]): CollectionResultStatus {
  if (phase === "preparing") return "scanning";
  if (phase === "submitted") return "confirming";
  if (phase === "success") return "success";
  if (phase === "skipped") return "skipped";
  return "error";
}

export function SolCollectionPage() {
  const [networkId, setNetworkId] = useState<SolanaNetworkId>("mainnet-beta");
  const [rpcEndpoint, setRpcEndpoint] = useState(getNetworkConfig("mainnet-beta").endpoint);
  const [targetAddress, setTargetAddress] = useState("");
  const [reserveAmount, setReserveAmount] = useState("0.002");
  const [minimumAmount, setMinimumAmount] = useState("0.001");
  const [stage, setStage] = useState<CollectionStage>("editing");
  const [message, setMessage] = useState("");
  const [issues, setIssues] = useState<string[]>([]);
  const [results, setResults] = useState<CollectionDisplayResult[]>([]);
  const [preflight, setPreflight] = useState<SolCollectionPreflightResult | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [errorStep, setErrorStep] = useState<0 | 1 | 2>(0);
  const [keyImporting, setKeyImporting] = useState(false);
  const [sourceKeyLineCount, setSourceKeyLineCount] = useState(0);
  const [keysCleared, setKeysCleared] = useState(false);
  const keyInputRef = useRef<SecretKeyInputHandle>(null);
  const keyImportingRef = useRef(false);
  const operationRef = useRef(false);
  const selectedNetwork = getNetworkConfig(networkId);
  const targetIsValid = Boolean(validatePublicKey(targetAddress.trim()));
  const sourceSigningReady = sourceKeyLineCount > 0 || stage === "ready" || stage === "running" || stage === "complete";
  const settingsReady = Boolean(rpcEndpoint.trim())
    && (reserveAmount.trim() === "0" || parseSolToLamports(reserveAmount) !== null)
    && (minimumAmount.trim() === "0" || parseSolToLamports(minimumAmount) !== null);
  const readinessCount = [sourceSigningReady, targetIsValid, settingsReady].filter(Boolean).length;
  const taskRunning = stage === "running" || stage === "checking";
  const running = taskRunning || keyImporting;
  const activeStep = stage === "error" ? errorStep : stage === "editing" ? 0 : stage === "checking" || stage === "ready" ? 1 : 2;
  const stepStates: ToolPageStepState[] | undefined = stage === "complete"
    ? ["complete", "complete", "complete"]
    : stage === "error"
      ? solCollectionSteps.map((_, index) => index < errorStep ? "complete" : index === errorStep ? "error" : "upcoming")
      : undefined;

  const handleKeyImportingChange = useCallback((importing: boolean) => {
    keyImportingRef.current = importing;
    setKeyImporting(importing);
  }, []);

  const networkOptions = useMemo<SearchableSelectOption<SolanaNetworkId>[]>(() => (
    solanaNetworks.map((network) => ({
      keywords: [network.id, "Solana"],
      label: network.label,
      meta: network.id,
      value: network.id
    }))
  ), []);

  const invalidateConfirmation = (clearResults = true) => {
    if (operationRef.current || taskRunning) return;
    setStage("editing");
    setErrorStep(0);
    setConfirmed(false);
    setMessage("");
    setIssues([]);
    setPreflight(null);
    if (clearResults) setResults([]);
  };

  const prepareCollection = async () => {
    if (operationRef.current || keyImportingRef.current || running) return;
    operationRef.current = true;
    const nextIssues: string[] = [];
    const normalizedTarget = validatePublicKey(targetAddress.trim());
    if (!normalizedTarget) nextIssues.push("目标地址不是有效的 Solana 地址");
    if (!rpcEndpoint.trim()) nextIssues.push("请输入可用的 RPC 地址");

    const reserveLamports = reserveAmount.trim() === "0" ? 0n : parseSolToLamports(reserveAmount);
    const minCollectionLamports = minimumAmount.trim() === "0" ? 0n : parseSolToLamports(minimumAmount);
    if (reserveLamports === null) nextIssues.push("保留金额需要是 0 或最多 9 位小数的正数");
    if (minCollectionLamports === null) nextIssues.push("最小归集金额需要是 0 或最多 9 位小数的正数");

    const parsedSources = parseSolanaSourceKeys(keyInputRef.current?.read() || "");
    if (!parsedSources.sources.length) nextIssues.push("至少需要一个有效的来源钱包私钥");
    parsedSources.errors.forEach((error) => nextIssues.push(error.message));
    parsedSources.duplicates.forEach((duplicate) => (
      nextIssues.push(`密钥第 ${duplicate.duplicateLine} 行与第 ${duplicate.originalLine} 行地址重复`)
    ));
    nextIssues.push(...validateSolCollectionWorkload(parsedSources.sources.length));

    if (nextIssues.length || reserveLamports === null || minCollectionLamports === null) {
      operationRef.current = false;
      setIssues(nextIssues);
      setPreflight(null);
      setStage("error");
      setErrorStep(0);
      setMessage("请修正输入后重新检查");
      return;
    }

    setIssues([]);
    setConfirmed(false);
    setPreflight(null);
    setResults(parsedSources.sources.map((source) => ({
      address: source.address,
      amount: "读取中",
      asset: "SOL",
      label: source.label,
      message: "正在只读检查余额、手续费和可归集金额",
      status: source.address === normalizedTarget ? "skipped" : "pending"
    })));
    setStage("checking");
    setErrorStep(0);
    setMessage(`正在对 ${parsedSources.sources.length} 个来源地址执行只读预检，不会签名或提交交易。`);

    const connection = new Connection(rpcEndpoint.trim(), "confirmed");
    try {
      await assertSolanaRpcNetwork(connection, networkId);
      const nextPreflight = await preflightSolCollectionSources({
        connection,
        destination: normalizedTarget,
        minCollectionLamports,
        reserveLamports,
        sources: parsedSources.sources
      });
      setPreflight(nextPreflight);
      setResults(nextPreflight.items.map(preflightItemToDisplay));

      if (nextPreflight.errorSources > 0) {
        setStage("error");
        setErrorStep(1);
        setMessage(`${nextPreflight.errorSources} 个来源预检失败。请检查 RPC 后重试；尚未签名或提交任何交易。`);
        return;
      }
      if (nextPreflight.executableSources === 0) {
        setStage("error");
        setErrorStep(1);
        setMessage("没有满足余额、手续费、保留额和最小金额条件的来源钱包，未执行任何交易。");
        return;
      }

      setStage("ready");
      setErrorStep(0);
      setMessage(`只读预检完成：${nextPreflight.executableSources} 个来源可归集，${nextPreflight.skippedSources} 个将跳过。`);
    } catch (error) {
      setStage("error");
      setErrorStep(1);
      setMessage(error instanceof Error && error.message.includes("RPC 网络不匹配")
        ? error.message
        : "只读预检失败，请检查 RPC 后重试；尚未签名或提交任何交易。");
    } finally {
      operationRef.current = false;
    }
  };

  const executeCollection = async () => {
    if (operationRef.current || keyImportingRef.current || stage !== "ready" || !confirmed) return;
    const normalizedTarget = validatePublicKey(targetAddress.trim());
    const reserveLamports = reserveAmount.trim() === "0" ? 0n : parseSolToLamports(reserveAmount);
    const minCollectionLamports = minimumAmount.trim() === "0" ? 0n : parseSolToLamports(minimumAmount);
    if (!normalizedTarget || reserveLamports === null || minCollectionLamports === null) {
      invalidateConfirmation(false);
      setStage("error");
      setErrorStep(1);
      setMessage("配置已发生变化，请重新检查");
      return;
    }

    const parsedSources = parseSolanaSourceKeys(keyInputRef.current?.read() || "");
    if (!parsedSources.sources.length || parsedSources.errors.length || parsedSources.duplicates.length) {
      setStage("error");
      setErrorStep(1);
      setMessage("来源钱包内容已变化，请重新检查");
      return;
    }

    operationRef.current = true;
    const connection = new Connection(rpcEndpoint.trim(), "confirmed");
    setStage("running");
    setConfirmed(false);
    setMessage("正在校验 RPC 网络；校验通过后才会读取余额和签名");

    try {
      await assertSolanaRpcNetwork(connection, networkId);
    } catch (error) {
      setStage("error");
      setErrorStep(2);
      setMessage(error instanceof Error && error.message.includes("RPC 网络不匹配")
        ? error.message
        : "无法确认 RPC 所属网络，已阻止归集");
      operationRef.current = false;
      return;
    }

    keyInputRef.current?.clear();
    setKeysCleared(true);

    setMessage(`正在处理 ${parsedSources.sources.length} 个来源钱包；已提交的交易请勿盲目重试`);

    const updateProgress = (progress: SolCollectionProgress) => {
      setResults((current) => current.map((result) => {
        if (result.address !== progress.address) return result;
        return {
          ...result,
          amount: progress.transferLamports > 0n ? formatLamports(progress.transferLamports) : result.amount,
          ...(progress.signature ? {
            explorerUrl: getExplorerUrl(progress.signature, networkId),
            hash: progress.signature
          } : {}),
          message: progress.phase === "preparing"
            ? "正在读取余额并估算手续费"
            : progress.phase === "submitted"
              ? "交易已提交，正在等待链上确认"
              : progress.phase === "success"
                ? "归集成功"
                : progress.phase === "skipped"
                  ? "该来源已跳过"
                  : "处理失败；若已显示交易哈希，请先查链上状态",
          status: progressStatus(progress.phase)
        };
      }));
    };

    try {
      const collectionResults = await collectSolFromSources({
        connection,
        destination: normalizedTarget,
        minCollectionLamports,
        onProgress: updateProgress,
        reserveLamports,
        sources: parsedSources.sources
      });
      setResults(collectionResults.map((item) => itemToDisplay(item, networkId)));
      const success = collectionResults.filter((item) => item.status === "success").length;
      const skipped = collectionResults.filter((item) => item.status === "skipped").length;
      const failed = collectionResults.filter((item) => item.status === "error").length;
      setStage("complete");
      setMessage(`执行结束：${success} 笔成功，${skipped} 笔跳过${failed ? `，${failed} 笔失败` : ""}。来源密钥已从页面清除。`);
    } catch {
      setStage("error");
      setErrorStep(2);
      setMessage("归集流程意外中断；来源密钥已清除，请先按已显示的交易哈希核对链上状态，再决定是否创建新任务");
    } finally {
      operationRef.current = false;
    }
  };

  return (
    <ToolPageLayout
      activeStep={activeStep}
      categoryHref="/#collection"
      categoryLabel="资产归集"
      currentToolId="sol-collection"
      description="批量归集 SOL，自动扣除手续费与保留额。"
      eyebrow="Many to one · Solana"
      mainClassName="collection-shell collection-page"
      meta={<><span className="pill network-pill">{selectedNetwork.label}</span><span className="pill">密钥仅在本地内存</span></>}
      stepStates={stepStates}
      steps={solCollectionSteps}
      title="SOL 归集"
    >
        <div className={`workspace collection-workspace${results.length ? " has-results" : ""}`}>
          <section className="panel collection-workbench-panel" aria-labelledby="sol-collection-config-title">
            <div className="panel-header">
              <div>
                <h2 className="panel-title" id="sol-collection-config-title">批量归集工作台</h2>
              </div>
              <span className="collection-ready-count" aria-label={`已准备 ${readinessCount} / 3 项`}>
                {readinessCount}/3
              </span>
            </div>
            <div className="form collection-form">
              <section className="collection-source-section collection-source-board" aria-labelledby="sol-collection-source-title">
                <header className="collection-section-heading">
                  <span className="collection-section-index" aria-hidden="true">01</span>
                  <div className="collection-section-copy">
                    <h3 id="sol-collection-source-title">来源钱包</h3>
                  </div>
                  <span className="pill" data-ready={sourceSigningReady ? "true" : "false"}>
                    {sourceKeyLineCount ? `${sourceKeyLineCount} 行密钥待校验` : sourceSigningReady ? "预检已载入" : "等待来源密钥"}
                  </span>
                </header>

                <SecretKeyInput
                  disabled={taskRunning}
                  mode="solana"
                  onDirty={() => {
                    setKeysCleared(false);
                    invalidateConfirmation();
                  }}
                  onImportingChange={handleKeyImportingChange}
                  onLineCountChange={setSourceKeyLineCount}
                  ref={keyInputRef}
                />
              </section>

              <CollectionResults
                embedded
                emptyMessage="预检后显示钱包与金额。"
                emptyTitle="等待预检"
                exportFilename="sol-collection-results.csv"
                results={results}
                title="钱包清单"
              />

              <div className="collection-settings-grid">
                <section className="collection-flow-section collection-network-section" aria-labelledby="sol-collection-network-title">
                  <header className="collection-section-heading">
                    <span className="collection-section-index" aria-hidden="true">02</span>
                    <div className="collection-section-copy">
                      <h3 id="sol-collection-network-title">网络与节点</h3>
                    </div>
                    <span className="pill">{selectedNetwork.label}</span>
                  </header>

                  <div className="field">
                    <label htmlFor="sol-collection-network">网络</label>
                    <SearchableSelect
                      disabled={running}
                      id="sol-collection-network"
                      listboxLabel="Solana 归集网络"
                      onChange={(value) => {
                        setNetworkId(value);
                        setRpcEndpoint(getNetworkConfig(value).endpoint);
                        invalidateConfirmation();
                      }}
                      options={networkOptions}
                      searchable={false}
                      triggerLabel="选择 Solana 网络"
                      value={networkId}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="sol-collection-rpc">RPC 地址</label>
                    <input
                      disabled={running}
                      id="sol-collection-rpc"
                      onChange={(event) => {
                        setRpcEndpoint(event.target.value);
                        invalidateConfirmation();
                      }}
                      spellCheck={false}
                      type="url"
                      value={rpcEndpoint}
                    />
                  </div>
                </section>

                <section className="collection-flow-section collection-target-section" aria-labelledby="sol-collection-target-title">
                  <header className="collection-section-heading">
                    <span className="collection-section-index" aria-hidden="true">03</span>
                    <div className="collection-section-copy">
                      <h3 id="sol-collection-target-title">目标与金额</h3>
                    </div>
                    <span className="pill" data-ready={targetIsValid ? "true" : "false"}>
                      {targetIsValid ? "目标有效" : "等待目标地址"}
                    </span>
                  </header>

                  <div className="field full">
                    <label htmlFor="sol-collection-target">目标钱包</label>
                    <input
                      autoCapitalize="none"
                      autoComplete="off"
                      disabled={running}
                      id="sol-collection-target"
                      onChange={(event) => {
                        setTargetAddress(event.target.value);
                        invalidateConfirmation();
                      }}
                      placeholder="Solana 地址"
                      spellCheck={false}
                      value={targetAddress}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="sol-collection-reserve">每个钱包保留 SOL</label>
                    <input
                      disabled={running}
                      id="sol-collection-reserve"
                      inputMode="decimal"
                      min="0"
                      onChange={(event) => {
                        setReserveAmount(event.target.value);
                        invalidateConfirmation();
                      }}
                      step="0.000001"
                      type="number"
                      value={reserveAmount}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="sol-collection-minimum">最小可归集金额</label>
                    <input
                      disabled={running}
                      id="sol-collection-minimum"
                      inputMode="decimal"
                      min="0"
                      onChange={(event) => {
                        setMinimumAmount(event.target.value);
                        invalidateConfirmation();
                      }}
                      step="0.000001"
                      type="number"
                      value={minimumAmount}
                    />
                    <p className="hint">低于阈值的来源会跳过。</p>
                  </div>
                </section>
              </div>

              <section className="collection-command-panel collection-command-panel--inline" aria-labelledby="sol-collection-command-title">
                <div className="panel-header">
                  <div>
                    <h3 className="panel-title" id="sol-collection-command-title">检查并执行</h3>
                  </div>
                </div>
                <div className="collection-command-body">
                  {issues.length ? (
                    <ul className="collection-issue-list" aria-label="输入问题" role="alert">
                      {issues.map((issue, index) => <li key={`${issue}-${index}`}>{issue}</li>)}
                    </ul>
                  ) : null}

                  {message ? (
                    <div className="collection-inline-status" data-status={stage === "error" ? "error" : stage === "complete" ? "success" : stage} aria-live={stage === "error" ? "assertive" : "polite"} role={stage === "error" ? "alert" : "status"}>
                      <strong>{stage === "checking" ? "正在只读预检" : stage === "ready" ? "等待最终确认" : stage === "complete" ? "任务已结束" : "任务状态"}</strong>
                      <p>{message}</p>
                    </div>
                  ) : null}

                  {stage === "ready" && preflight ? (
                    <div className="collection-final-confirm">
                      <strong>最终确认：将从 {preflight.executableSources} 个来源发起归集</strong>
                      <div className="summary-list">
                        <div><span>目标地址</span><strong>{targetAddress}</strong></div>
                        <div><span>来源检查</span><strong>{results.length} 个</strong></div>
                        <div><span>预计执行</span><strong>{preflight.executableSources} 笔</strong></div>
                        <div><span>预计跳过</span><strong>{preflight.skippedSources} 个</strong></div>
                        <div><span>预计归集</span><strong>{formatLamports(preflight.totalTransferLamports)} SOL</strong></div>
                        <div><span>预计总手续费</span><strong>{formatLamports(preflight.estimatedNetworkFeeLamports)} SOL</strong></div>
                        <div><span>每钱包保留</span><strong>{reserveAmount || "0"} SOL</strong></div>
                      </div>
                      <label className="collection-confirm-check">
                        <input checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} type="checkbox" />
                        <span>我已核对上方只读预检结果、目标地址和跳过项，并理解余额与手续费会在签名前再次读取。</span>
                      </label>
                    </div>
                  ) : null}

                  <div className="actions collection-actions">
                    <button className="button danger" disabled={running} onClick={() => {
                      const hasTaskContent = Boolean(targetAddress.trim() || keyInputRef.current?.read().trim() || results.length);
                      if (hasTaskContent && !window.confirm("确认清空当前归集任务？来源密钥和预检结果将无法恢复。")) return;
                      keyInputRef.current?.clear();
                      setTargetAddress("");
                      setReserveAmount("0.002");
                      setMinimumAmount("0.001");
                      setResults([]);
                      setPreflight(null);
                      setKeysCleared(false);
                      setIssues([]);
                      setMessage("");
                      setConfirmed(false);
                      setStage("editing");
                      setErrorStep(0);
                    }} type="button">清空任务</button>
                    {stage === "ready" ? (
                      <button className="button primary" disabled={!confirmed || running} onClick={executeCollection} type="button">确认并开始归集</button>
                    ) : stage === "running" || stage === "checking" ? (
                      <button className="button primary" disabled type="button">{stage === "checking" ? "只读预检中" : "归集中"}</button>
                    ) : keysCleared ? (
                      <button className="button primary" onClick={() => keyInputRef.current?.focus()} type="button">重新导入来源密钥</button>
                    ) : (
                      <button className="button primary" disabled={running} onClick={prepareCollection} type="button">检查余额与费用</button>
                    )}
                  </div>

                  <CollectionSafetyNote>
                    <p>保留额为 0 可能使钱包无法继续交易。</p>
                  </CollectionSafetyNote>
                </div>
              </section>
            </div>
          </section>
        </div>
    </ToolPageLayout>
  );
}
