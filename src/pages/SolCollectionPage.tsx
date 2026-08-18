import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { CollectionResults } from "../components/CollectionResults";
import { SearchableSelect, type SearchableSelectOption } from "../components/SearchableSelect";
import { SecretKeyInput, type SecretKeyInputHandle } from "../components/SecretKeyInput";
import { ToolPageLayout, type WorkbenchStatus } from "../components/ToolPageLayout";
import {
  AdvancedSettings,
  ConfirmActionDialog,
  ExecutionProgress,
  WorkbenchPanel
} from "../components/WorkbenchPrimitives";
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

export function getSolCollectionWorkbenchStatus(
  stage: CollectionStage,
  results: readonly CollectionDisplayResult[]
): WorkbenchStatus {
  const hasHash = results.some((result) => Boolean(result.hash));
  const hasFailure = results.some((result) => result.status === "error");
  if (stage === "checking") return "preflight";
  if (stage === "ready") return "ready";
  if (stage === "running") return "running";
  if (stage === "error") return hasHash ? "uncertain" : "error";
  if (stage === "complete") {
    if (hasFailure && hasHash) return "uncertain";
    return hasFailure ? "error" : "success";
  }
  return "editing";
}

const solStatusLabels: Record<WorkbenchStatus, string> = {
  editing: "编辑中",
  error: "需要处理",
  preflight: "预检中",
  ready: "等待确认",
  running: "执行中",
  success: "已完成",
  uncertain: "需核对链上状态"
};

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
  const [keyImporting, setKeyImporting] = useState(false);
  const [keysCleared, setKeysCleared] = useState(false);
  const keyInputRef = useRef<SecretKeyInputHandle>(null);
  const keyImportingRef = useRef(false);
  const operationRef = useRef(false);
  const selectedNetwork = getNetworkConfig(networkId);
  const targetIsValid = Boolean(validatePublicKey(targetAddress.trim()));
  const taskRunning = stage === "running" || stage === "checking";
  const running = taskRunning || keyImporting;
  const hasSubmittedHash = results.some((result) => Boolean(result.hash));
  const controlsLocked = running || hasSubmittedHash;
  const workbenchStatus = getSolCollectionWorkbenchStatus(stage, results);
  const completedResultCount = results.filter((result) => (
    result.status === "success" || result.status === "error" || result.status === "skipped"
  )).length;

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

  useEffect(() => {
    const resetRestoredPage = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      setResults([]);
      setIssues([]);
      setPreflight(null);
      setKeysCleared(true);
      setMessage("页面从历史记录恢复，签名材料已清除；请重新预检");
      setStage("editing");
    };
    window.addEventListener("pageshow", resetRestoredPage);
    return () => window.removeEventListener("pageshow", resetRestoredPage);
  }, []);

  const invalidateConfirmation = (clearResults = true) => {
    if (operationRef.current || taskRunning) return;
    setStage("editing");
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
      setMessage("请修正输入后重新检查");
      return;
    }

    setIssues([]);
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
        setMessage(`${nextPreflight.errorSources} 个来源预检失败。请检查 RPC 后重试；尚未签名或提交任何交易。`);
        return;
      }
      if (nextPreflight.executableSources === 0) {
        setStage("error");
        setMessage("没有满足余额、手续费、保留额和最小金额条件的来源钱包，未执行任何交易。");
        return;
      }

      setStage("ready");
      setMessage(`只读预检完成：${nextPreflight.executableSources} 个来源可归集，${nextPreflight.skippedSources} 个将跳过。`);
    } catch (error) {
      setStage("error");
      setMessage(error instanceof Error && error.message.includes("RPC 网络不匹配")
        ? error.message
        : "只读预检失败，请检查 RPC 后重试；尚未签名或提交任何交易。");
    } finally {
      operationRef.current = false;
    }
  };

  const executeCollection = async () => {
    if (operationRef.current || keyImportingRef.current || stage !== "ready") return;
    const normalizedTarget = validatePublicKey(targetAddress.trim());
    const reserveLamports = reserveAmount.trim() === "0" ? 0n : parseSolToLamports(reserveAmount);
    const minCollectionLamports = minimumAmount.trim() === "0" ? 0n : parseSolToLamports(minimumAmount);
    if (!normalizedTarget || reserveLamports === null || minCollectionLamports === null) {
      invalidateConfirmation(false);
      setStage("error");
      setMessage("配置已发生变化，请重新检查");
      return;
    }

    const parsedSources = parseSolanaSourceKeys(keyInputRef.current?.read() || "");
    if (!parsedSources.sources.length || parsedSources.errors.length || parsedSources.duplicates.length) {
      setStage("error");
      setMessage("来源钱包内容已变化，请重新检查");
      return;
    }

    operationRef.current = true;
    const connection = new Connection(rpcEndpoint.trim(), "confirmed");
    setStage("running");
    setMessage("正在校验 RPC 网络；校验通过后才会读取余额和签名");

    try {
      await assertSolanaRpcNetwork(connection, networkId);
    } catch (error) {
      setStage("error");
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
      setMessage("归集流程意外中断；来源密钥已清除，请先按已显示的交易哈希核对链上状态，再决定是否创建新任务");
    } finally {
      operationRef.current = false;
    }
  };

  const resetTask = () => {
    keyInputRef.current?.clear();
    setTargetAddress("");
    setReserveAmount("0.002");
    setMinimumAmount("0.001");
    setResults([]);
    setPreflight(null);
    setKeysCleared(false);
    setIssues([]);
    setMessage("");
    setStage("editing");
  };

  return (
    <ToolPageLayout
      actions={(
        <>
          <Badge variant="outline">{selectedNetwork.label}</Badge>
          <ConfirmActionDialog
            confirmLabel="清空任务"
            description={hasSubmittedHash
              ? "当前结果包含已提交的交易哈希。清空前请先核对链上状态；清空后本页记录无法恢复。"
              : "来源密钥、目标地址和当前预检结果将从页面清除。"}
            disabled={running}
            onConfirm={resetTask}
            title="清空当前 SOL 归集任务？"
            triggerLabel="清空任务"
            triggerVariant="destructive"
          />
        </>
      )}
      className="collection-shell collection-page"
      currentToolId="sol-collection"
      status={workbenchStatus}
      statusLabel={solStatusLabels[workbenchStatus]}
      title="SOL 归集"
    >
      <div className={`workspace collection-workspace${results.length ? " has-results" : ""}`}>
        <WorkbenchPanel
          className="collection-workbench-panel"
          footer={(
            <div className="actions collection-actions">
              {stage === "ready" && preflight ? (
                <ConfirmActionDialog
                  confirmLabel="确认并开始归集"
                  description={(
                    <div className="summary-list">
                      <div><span>网络</span><strong>{selectedNetwork.label}</strong></div>
                      <div><span>目标地址</span><strong className="mono">{targetAddress}</strong></div>
                      <div><span>预计执行</span><strong>{preflight.executableSources} 笔</strong></div>
                      <div><span>预计跳过</span><strong>{preflight.skippedSources} 个</strong></div>
                      <div><span>预计归集</span><strong>{formatLamports(preflight.totalTransferLamports)} SOL</strong></div>
                      <div><span>预计总手续费</span><strong>{formatLamports(preflight.estimatedNetworkFeeLamports)} SOL</strong></div>
                      <div><span>每钱包保留</span><strong>{reserveAmount || "0"} SOL</strong></div>
                    </div>
                  )}
                  disabled={running}
                  onConfirm={executeCollection}
                  title="确认 SOL 归集？"
                  triggerLabel="确认并开始归集"
                />
              ) : stage === "checking" || stage === "running" ? (
                <Button disabled type="button">{stage === "checking" ? "预检中" : "归集中"}</Button>
              ) : hasSubmittedHash ? (
                <Button disabled type="button">请先核对链上结果</Button>
              ) : keysCleared ? (
                <Button onClick={() => keyInputRef.current?.focus()} type="button">重新导入来源密钥</Button>
              ) : (
                <Button disabled={running} onClick={() => void prepareCollection()} type="button">预检余额与费用</Button>
              )}
            </div>
          )}
          title="归集设置"
        >
          <div className="form collection-form">
            <Field data-invalid={targetAddress.trim() && !targetIsValid ? true : undefined}>
              <FieldLabel htmlFor="sol-collection-target">目标钱包</FieldLabel>
              <Input
                aria-invalid={targetAddress.trim() && !targetIsValid ? true : undefined}
                autoCapitalize="none"
                autoComplete="off"
                disabled={controlsLocked}
                id="sol-collection-target"
                onChange={(event) => {
                  setTargetAddress(event.target.value);
                  invalidateConfirmation();
                }}
                placeholder="Solana 地址"
                spellCheck={false}
                value={targetAddress}
              />
              {targetAddress.trim() && !targetIsValid ? <FieldError>请输入有效的 Solana 地址</FieldError> : null}
            </Field>

            <SecretKeyInput
              disabled={controlsLocked}
              mode="solana"
              onDirty={() => {
                setKeysCleared(false);
                invalidateConfirmation();
              }}
              onImportingChange={handleKeyImportingChange}
              ref={keyInputRef}
            />

            <Field>
              <FieldLabel htmlFor="sol-collection-network">网络</FieldLabel>
              <SearchableSelect
                disabled={controlsLocked}
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
            </Field>

            <AdvancedSettings disabled={controlsLocked} label="RPC 与金额设置">
              <Field>
                <FieldLabel htmlFor="sol-collection-rpc">RPC 地址</FieldLabel>
                <Input
                  disabled={controlsLocked}
                  id="sol-collection-rpc"
                  onChange={(event) => {
                    setRpcEndpoint(event.target.value);
                    invalidateConfirmation();
                  }}
                  spellCheck={false}
                  type="url"
                  value={rpcEndpoint}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="sol-collection-reserve">每个钱包保留 SOL</FieldLabel>
                <Input
                  disabled={controlsLocked}
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
                {(reserveAmount.trim() !== "0" && parseSolToLamports(reserveAmount) === null)
                  ? <FieldError>请输入 0 或最多 9 位小数的正数</FieldError>
                  : null}
              </Field>
              <Field>
                <FieldLabel htmlFor="sol-collection-minimum">最小可归集金额</FieldLabel>
                <Input
                  disabled={controlsLocked}
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
                {(minimumAmount.trim() !== "0" && parseSolToLamports(minimumAmount) === null)
                  ? <FieldError>请输入 0 或最多 9 位小数的正数</FieldError>
                  : <FieldDescription className="sr-only">低于该金额的来源会跳过</FieldDescription>}
              </Field>
            </AdvancedSettings>

            {issues.length ? (
              <Alert variant="destructive">
                <AlertTitle>输入有误</AlertTitle>
                <AlertDescription>
                  <ul aria-label="输入问题">
                    {issues.map((issue, index) => <li key={`${issue}-${index}`}>{issue}</li>)}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : null}

            {message ? (
              <Alert aria-live={workbenchStatus === "error" || workbenchStatus === "uncertain" ? "assertive" : "polite"} variant={workbenchStatus === "error" || workbenchStatus === "uncertain" ? "destructive" : "default"}>
                <AlertTitle>{solStatusLabels[workbenchStatus]}</AlertTitle>
                <AlertDescription>{message}</AlertDescription>
              </Alert>
            ) : null}

            {stage === "running" ? (
              <ExecutionProgress current={completedResultCount} label="SOL 归集进度" total={preflight?.executableSources || results.length} />
            ) : null}
          </div>
        </WorkbenchPanel>

        <WorkbenchPanel className="collection-results-panel" title="预检与结果">
          <CollectionResults
            embedded
            emptyMessage="预检后显示钱包与金额。"
            emptyTitle="等待预检"
            exportFilename="sol-collection-results.csv"
            results={results}
            title="钱包与金额"
          />
        </WorkbenchPanel>
      </div>
    </ToolPageLayout>
  );
}
