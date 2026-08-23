import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  SecretKeyInput,
  type SecretKeyInputHandle,
  type WalletExecutionItem
} from "../components/SecretKeyInput";
import { SearchableSelect, type SearchableSelectOption } from "../components/SearchableSelect";
import { ToolPageLayout, type WorkbenchStatus } from "../components/ToolPageLayout";
import { CollectionResults } from "../components/CollectionResults";
import {
  AdvancedSettings,
  ConfirmActionDialog,
  ExecutionProgress,
  ReviewPanel,
  WorkbenchPanel
} from "../components/WorkbenchPrimitives";
import { formatLamports, parseSolToLamports } from "../lib/amount";
import type { CollectionAmountPolicy } from "../lib/collection-amount";
import {
  sanitizeRoundArchiveText,
  type CollectionDisplayResult,
  type CollectionResultStatus
} from "../lib/collection-results";
import { validateSolCollectionWorkload } from "../lib/collection-workload";
import { getPreferredRpcEndpoint, isRpcEndpoint, rememberRpcEndpoint } from "../lib/rpc-preferences";
import {
  collectSolFromSources,
  parseSolanaSourceKeys,
  type SolCollectionItemResult,
  type SolCollectionProgress,
  type SolCollectionSource
} from "../lib/sol-collection";
import {
  assertSolanaRpcNetwork,
  getExplorerUrl,
  getNetworkConfig,
  solanaNetworks,
  type SolanaNetworkId
} from "../lib/solana";

type CollectionStage = "checking" | "complete" | "editing" | "error" | "ready" | "running";
type AmountMode = CollectionAmountPolicy["mode"];

type ArchivedSolCollectionRound = {
  message: string;
  requiresAcknowledgement: boolean;
  results: CollectionDisplayResult[];
  sequence: number;
};

export function getSolCollectionWorkbenchStatus(
  stage: CollectionStage,
  results: readonly CollectionDisplayResult[]
): WorkbenchStatus {
  const hasFailure = results.some((result) => result.status === "error");
  const hasUncertain = results.some((result) => (
    result.uncertain || (result.status === "error" && Boolean(result.hash) && result.retryable !== true)
  ));
  if (stage === "checking") return "preflight";
  if (stage === "ready") return "ready";
  if (stage === "running") return "running";
  if (stage === "error") return hasUncertain ? "uncertain" : "error";
  if (stage === "complete") {
    if (hasUncertain) return "uncertain";
    return hasFailure ? "error" : "success";
  }
  return "editing";
}

const solStatusLabels: Record<WorkbenchStatus, string> = {
  editing: "编辑中",
  error: "需要处理",
  preflight: "检查中",
  ready: "等待确认",
  running: "执行中",
  success: "已完成",
  uncertain: "部分交易需核对"
};

const amountModeLabels: Record<AmountMode, string> = {
  all: "全部数量",
  fixed: "固定数量",
  percentage: "百分比数量",
  random: "随机数量"
};

function validatePublicKey(value: string) {
  try {
    return new PublicKey(value).toBase58();
  } catch {
    return "";
  }
}

function parsePercentageBps(value: string) {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const bps = BigInt(match[1]) * 100n + BigInt((match[2] || "").padEnd(2, "0"));
  return bps > 0n && bps <= 10_000n ? bps : null;
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
    retryable: item.status === "error" && item.retryable,
    status: item.status === "success" ? "success" : item.status === "skipped" ? "skipped" : "error",
    uncertain: item.status === "error" && Boolean(item.signature) && !item.retryable
  };
}

function progressStatus(phase: SolCollectionProgress["phase"]): CollectionResultStatus {
  if (phase === "preparing") return "scanning";
  if (phase === "submitted") return "confirming";
  if (phase === "success") return "success";
  if (phase === "skipped") return "skipped";
  return "error";
}

function groupWalletStatuses(results: readonly CollectionDisplayResult[]) {
  const grouped: Record<string, WalletExecutionItem[]> = {};
  results.forEach((result) => {
    const key = result.address.toLowerCase();
    if (!key || key === "—") return;
    (grouped[key] ||= []).push({
      amount: result.amount,
      asset: result.asset,
      explorerUrl: result.explorerUrl,
      hash: result.hash,
      message: result.message,
      status: result.status
    });
  });
  return grouped;
}

export function SolCollectionPage() {
  const initialNetworkId: SolanaNetworkId = "mainnet-beta";
  const [networkId, setNetworkId] = useState<SolanaNetworkId>(initialNetworkId);
  const [rpcEndpoint, setRpcEndpoint] = useState(() => getPreferredRpcEndpoint(
    "solana",
    initialNetworkId,
    getNetworkConfig(initialNetworkId).endpoint
  ));
  const [targetAddress, setTargetAddress] = useState("");
  const [amountMode, setAmountMode] = useState<AmountMode>("all");
  const [percentageAmount, setPercentageAmount] = useState("100");
  const [fixedAmount, setFixedAmount] = useState("0.1");
  const [randomMinimum, setRandomMinimum] = useState("0.01");
  const [randomMaximum, setRandomMaximum] = useState("0.1");
  const [reserveAmount, setReserveAmount] = useState("0");
  const [minimumAmount, setMinimumAmount] = useState("0");
  const [concurrency, setConcurrency] = useState("3");
  const [minimumDelay, setMinimumDelay] = useState("0");
  const [maximumDelay, setMaximumDelay] = useState("0");
  const [sourceCount, setSourceCount] = useState(0);
  const [stage, setStage] = useState<CollectionStage>("editing");
  const [message, setMessage] = useState("");
  const [issues, setIssues] = useState<string[]>([]);
  const [results, setResults] = useState<CollectionDisplayResult[]>([]);
  const [archivedRound, setArchivedRound] = useState<ArchivedSolCollectionRound | null>(null);
  const [roundSequence, setRoundSequence] = useState(1);
  const [keyImporting, setKeyImporting] = useState(false);
  const keyInputRef = useRef<SecretKeyInputHandle>(null);
  const keyImportingRef = useRef(false);
  const operationRef = useRef(false);
  const retrySourcesRef = useRef<SolCollectionSource[]>([]);
  const selectedNetwork = getNetworkConfig(networkId);
  const normalizedTarget = validatePublicKey(targetAddress.trim());
  const taskRunning = stage === "running";
  const running = taskRunning || keyImporting;
  const hasSubmittedHash = results.some((result) => Boolean(result.hash));
  const hasRecordedHash = hasSubmittedHash || Boolean(archivedRound?.results.some((result) => result.hash));
  const controlsLocked = running;
  const workbenchStatus = getSolCollectionWorkbenchStatus(stage, results);
  const completedResultCount = results.filter((result) => (
    result.status === "success" || result.status === "error" || result.status === "skipped"
  )).length;
  const retryableCount = retrySourcesRef.current.length;
  const walletStatuses = useMemo(() => groupWalletStatuses(results), [results]);

  const networkOptions = useMemo<SearchableSelectOption<SolanaNetworkId>[]>(() => (
    solanaNetworks.map((network) => ({
      keywords: [network.id, "Solana"],
      label: network.label,
      meta: network.id,
      value: network.id
    }))
  ), []);

  const handleKeyImportingChange = useCallback((importing: boolean) => {
    keyImportingRef.current = importing;
    setKeyImporting(importing);
  }, []);

  useEffect(() => {
    const resetRestoredPage = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      retrySourcesRef.current = [];
      setResults([]);
      setIssues([]);
      setMessage("页面从历史记录恢复，来源密钥已按安全策略清除，请重新导入");
      setStage("editing");
    };
    window.addEventListener("pageshow", resetRestoredPage);
    return () => window.removeEventListener("pageshow", resetRestoredPage);
  }, []);

  const archiveCurrentRound = () => {
    if (!results.length || (stage !== "complete" && stage !== "error")) return false;
    const requiresAcknowledgement = workbenchStatus === "uncertain"
      || results.some((result) => result.uncertain);
    setArchivedRound({
      message: sanitizeRoundArchiveText(message || "任务已结束"),
      requiresAcknowledgement,
      results: results.map((result) => ({
        ...result,
        message: sanitizeRoundArchiveText(result.message)
      })),
      sequence: roundSequence
    });
    retrySourcesRef.current = [];
    setResults([]);
    setRoundSequence((current) => current + 1);
    setStage("editing");
    return true;
  };

  const invalidateTask = (clearResults = true) => {
    if (operationRef.current || taskRunning) return;
    const archived = archiveCurrentRound();
    retrySourcesRef.current = [];
    setStage("editing");
    setMessage("");
    setIssues([]);
    if (clearResults && !archived) setResults([]);
  };

  const getAmountPolicy = (): CollectionAmountPolicy | null => {
    if (amountMode === "all") return { mode: "all" };
    if (amountMode === "percentage") {
      const percentageBps = parsePercentageBps(percentageAmount);
      return percentageBps === null ? null : { mode: "percentage", percentageBps };
    }
    if (amountMode === "fixed") {
      const amount = parseSolToLamports(fixedAmount);
      return amount && amount > 0n ? { amount, mode: "fixed" } : null;
    }
    const minAmount = parseSolToLamports(randomMinimum);
    const maxAmount = parseSolToLamports(randomMaximum);
    return minAmount && maxAmount && minAmount > 0n && maxAmount >= minAmount
      ? { maxAmount, minAmount, mode: "random" }
      : null;
  };

  const getExecutionSettings = () => {
    const parsedConcurrency = Number(concurrency);
    const parsedMinimumDelay = Number(minimumDelay);
    const parsedMaximumDelay = Number(maximumDelay);
    if (!Number.isInteger(parsedConcurrency) || parsedConcurrency < 1 || parsedConcurrency > 20
      || !Number.isFinite(parsedMinimumDelay) || !Number.isFinite(parsedMaximumDelay)
      || parsedMinimumDelay < 0 || parsedMaximumDelay < parsedMinimumDelay || parsedMaximumDelay > 300) {
      return null;
    }
    return {
      concurrency: parsedConcurrency,
      maximumDelayMs: Math.round(parsedMaximumDelay * 1_000),
      minimumDelayMs: Math.round(parsedMinimumDelay * 1_000)
    };
  };

  const validateAndReadSources = () => {
    const nextIssues: string[] = [];
    if (!normalizedTarget) nextIssues.push("目标地址不是有效的 Solana 地址");
    if (!isRpcEndpoint(rpcEndpoint)) nextIssues.push("请输入以 http:// 或 https:// 开头的有效 RPC 地址");
    const amountPolicy = getAmountPolicy();
    if (!amountPolicy) nextIssues.push("归集数量设置无效，请检查当前数量模式");
    const reserveLamports = reserveAmount.trim() === "0" ? 0n : parseSolToLamports(reserveAmount);
    const minCollectionLamports = minimumAmount.trim() === "0" ? 0n : parseSolToLamports(minimumAmount);
    if (reserveLamports === null) nextIssues.push("保留金额需要是 0 或最多 9 位小数的正数");
    if (minCollectionLamports === null) nextIssues.push("最小归集金额需要是 0 或最多 9 位小数的正数");
    const executionSettings = getExecutionSettings();
    if (!executionSettings) nextIssues.push("并发需要为 1–20，随机延迟需要为 0–300 秒且最大值不小于最小值");
    const parsedSources = parseSolanaSourceKeys(keyInputRef.current?.read() || "");
    if (!parsedSources.sources.length) nextIssues.push("请勾选至少一个有效的来源钱包");
    parsedSources.errors.forEach((error) => nextIssues.push(error.message));
    parsedSources.duplicates.forEach((duplicate) => (
      nextIssues.push(`密钥第 ${duplicate.duplicateLine} 行与第 ${duplicate.originalLine} 行地址重复`)
    ));
    nextIssues.push(...validateSolCollectionWorkload(parsedSources.sources.length));
    return {
      amountPolicy,
      executionSettings,
      issues: nextIssues,
      minCollectionLamports,
      parsedSources,
      reserveLamports
    };
  };

  const executeCollection = async (retryOnly = false) => {
    if (operationRef.current || keyImportingRef.current || running) return;
    const prepared = validateAndReadSources();
    const sources = retryOnly ? retrySourcesRef.current : prepared.parsedSources.sources;
    if (prepared.issues.length || prepared.amountPolicy === null || prepared.executionSettings === null
      || prepared.reserveLamports === null || prepared.minCollectionLamports === null || !sources.length) {
      setIssues(prepared.issues.length ? prepared.issues : ["没有可重试的失败钱包"]);
      setStage("error");
      setMessage("请修正设置后再执行，当前钱包与配置均已保留");
      return;
    }

    operationRef.current = true;
    retrySourcesRef.current = [];
    setIssues([]);
    setStage("running");
    setMessage(retryOnly
      ? `正在重试 ${sources.length} 个失败钱包`
      : `已确认，正在按并发 ${prepared.executionSettings.concurrency} 执行；余额与费用会在每笔发送前即时读取`);
    const initial = sources.map((source): CollectionDisplayResult => ({
      address: source.address,
      amount: "—",
      asset: "SOL",
      label: source.label,
      message: retryOnly ? "等待重试" : "等待执行",
      status: "pending"
    }));
    setResults((current) => retryOnly
      ? current.map((result) => initial.find((item) => item.address === result.address) || result)
      : initial);

    const connection = new Connection(rpcEndpoint.trim(), "confirmed");
    const submittedAddresses = new Set<string>();
    try {
      await assertSolanaRpcNetwork(connection, networkId);
      const updateProgress = (progress: SolCollectionProgress) => {
        if (progress.signature) submittedAddresses.add(progress.address);
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
                    : "处理失败，请查看具体原因",
            status: progressStatus(progress.phase)
          };
        }));
      };
      const collectionResults = await collectSolFromSources({
        amountPolicy: prepared.amountPolicy,
        connection,
        destination: normalizedTarget,
        executionSettings: prepared.executionSettings,
        minCollectionLamports: prepared.minCollectionLamports,
        onProgress: updateProgress,
        reserveLamports: prepared.reserveLamports,
        sources
      });
      const displayResults = collectionResults.map((item) => itemToDisplay(item, networkId));
      setResults((current) => retryOnly
        ? current.map((result) => displayResults.find((item) => item.address === result.address) || result)
        : displayResults);
      const retryableAddresses = new Set(collectionResults
        .filter((item) => item.status === "error" && item.retryable)
        .map((item) => item.address));
      retrySourcesRef.current = sources.filter((source) => retryableAddresses.has(source.address));
      const success = collectionResults.filter((item) => item.status === "success").length;
      const skipped = collectionResults.filter((item) => item.status === "skipped").length;
      const failed = collectionResults.filter((item) => item.status === "error").length;
      setStage("complete");
      setMessage(`归集完成：${success} 笔成功，${skipped} 笔跳过${failed ? `，${failed} 笔失败` : ""}`
        + (retrySourcesRef.current.length ? `；${retrySourcesRef.current.length} 笔可直接重试` : ""));
    } catch (error) {
      retrySourcesRef.current = sources.filter((source) => !submittedAddresses.has(source.address));
      const sourceAddresses = new Set(sources.map((source) => source.address));
      setResults((current) => current.map((result) => {
        if (!sourceAddresses.has(result.address)) return result;
        const uncertain = submittedAddresses.has(result.address) || Boolean(result.hash);
        return {
          ...result,
          message: uncertain
            ? "交易已提交但确认状态不确定，请根据签名核对链上状态"
            : "执行在提交前中断，可安全重试",
          retryable: !uncertain,
          status: "error",
          uncertain
        };
      }));
      setStage("error");
      setMessage(error instanceof Error && error.message.includes("RPC 网络不匹配")
        ? error.message
        : "归集流程中断，钱包与设置均已保留，可直接重试；已显示签名的项目请先核对链上状态");
    } finally {
      operationRef.current = false;
    }
  };

  const resetTask = () => {
    keyInputRef.current?.clear();
    retrySourcesRef.current = [];
    setTargetAddress("");
    setAmountMode("all");
    setPercentageAmount("100");
    setFixedAmount("0.1");
    setRandomMinimum("0.01");
    setRandomMaximum("0.1");
    setReserveAmount("0");
    setMinimumAmount("0");
    setConcurrency("3");
    setMinimumDelay("0");
    setMaximumDelay("0");
    setResults([]);
    setArchivedRound(null);
    setRoundSequence(1);
    setIssues([]);
    setMessage("");
    setStage("editing");
  };

  const amountPolicyValid = getAmountPolicy() !== null;
  const executionSettingsValid = getExecutionSettings() !== null;
  const rpcEndpointValid = isRpcEndpoint(rpcEndpoint);
  const canStart = Boolean(normalizedTarget && sourceCount && rpcEndpointValid
    && amountPolicyValid && executionSettingsValid && !running
    && !archivedRound?.requiresAcknowledgement);

  return (
    <ToolPageLayout
      actions={(
        <>
          <Badge variant="outline">{selectedNetwork.label}</Badge>
          <ConfirmActionDialog
            confirmLabel="确认清空"
            description={hasRecordedHash
              ? "当前钱包行包含已提交的交易。清空前请先核对链上状态；清空后本页记录无法恢复。"
              : "来源密钥、目标地址、当前执行状态和历史记录将从页面清除。"}
            disabled={running}
            onConfirm={resetTask}
            title="清空 SOL 归集工作台？"
            triggerLabel="清空工作台"
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
      <div className="workspace collection-workspace">
        <WorkbenchPanel
          className="collection-workbench-panel"
          footer={(
            <div className="actions collection-actions">
              {stage === "running" ? (
                <Button disabled type="button">归集中</Button>
              ) : retryableCount ? (
                <ConfirmActionDialog
                  confirmLabel={`重试 ${retryableCount} 个失败钱包`}
                  description="只重试尚未提交或已明确执行失败的钱包；状态不确定的交易不会自动重发。"
                  disabled={running}
                  onConfirm={() => executeCollection(true)}
                  title="确认重试失败项？"
                  triggerLabel={`重试失败项 (${retryableCount})`}
                  triggerVariant="outline"
                />
              ) : results.length && (stage === "complete" || stage === "error") ? (
                <p className="collection-terminal-hint">
                  {workbenchStatus === "uncertain"
                    ? "可直接编辑设置；当前结果会移入下方记录。核对链上状态后才可开始新的写入任务。"
                    : "任务已结束。直接修改任一设置即可继续，当前结果会移入下方记录。"}
                </p>
              ) : (
                <ConfirmActionDialog
                  confirmLabel="确认并开始归集"
                  description={(
                    <div className="summary-list">
                      <div><span>网络</span><strong>{selectedNetwork.label}</strong></div>
                      <div><span>目标地址</span><strong className="mono">{targetAddress || "—"}</strong></div>
                      <div><span>来源钱包</span><strong>{sourceCount} 个已选择</strong></div>
                      <div><span>归集数量</span><strong>{amountModeLabels[amountMode]}</strong></div>
                      <div><span>并发</span><strong>{concurrency}</strong></div>
                      <div><span>随机延迟</span><strong>{minimumDelay}–{maximumDelay} 秒</strong></div>
                    </div>
                  )}
                  disabled={!canStart}
                  onConfirm={() => executeCollection(false)}
                  title="确认 SOL 归集？"
                  triggerLabel="确认并开始归集"
                />
              )}
            </div>
          )}
          title="归集设置"
        >
          <div className="form collection-form">
            <Field data-invalid={targetAddress.trim() && !normalizedTarget ? true : undefined}>
              <FieldLabel htmlFor="sol-collection-target">目标钱包</FieldLabel>
              <Input
                aria-invalid={targetAddress.trim() && !normalizedTarget ? true : undefined}
                autoCapitalize="none"
                autoComplete="off"
                disabled={controlsLocked}
                id="sol-collection-target"
                onChange={(event) => { setTargetAddress(event.target.value); invalidateTask(); }}
                placeholder="Solana 地址"
                spellCheck={false}
                value={targetAddress}
              />
              {targetAddress.trim() && !normalizedTarget ? <FieldError>请输入有效的 Solana 地址</FieldError> : null}
            </Field>

            <SecretKeyInput
              disabled={controlsLocked}
              mode="solana"
              onDirty={() => invalidateTask()}
              onImportingChange={handleKeyImportingChange}
              onLineCountChange={setSourceCount}
              ref={keyInputRef}
              walletStatuses={walletStatuses}
            />

            <h3 className="collection-config-heading">归集配置</h3>

            <Field>
              <FieldLabel htmlFor="sol-collection-network">网络</FieldLabel>
              <SearchableSelect
                disabled={controlsLocked}
                id="sol-collection-network"
                listboxLabel="Solana 归集网络"
                onChange={(value) => {
                  const nextNetwork = getNetworkConfig(value);
                  setNetworkId(value);
                  setRpcEndpoint(getPreferredRpcEndpoint("solana", value, nextNetwork.endpoint));
                  invalidateTask();
                }}
                options={networkOptions}
                searchable={false}
                triggerLabel="选择 Solana 网络"
                value={networkId}
              />
            </Field>

            <Field data-invalid={!amountPolicyValid ? true : undefined}>
              <FieldLabel>归集数量</FieldLabel>
              <Tabs onValueChange={(value) => { setAmountMode(value as AmountMode); invalidateTask(); }} value={amountMode}>
                <TabsList aria-label="SOL 归集数量模式">
                  {Object.entries(amountModeLabels).map(([value, label]) => (
                    <TabsTrigger disabled={controlsLocked} key={value} value={value}>{label}</TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
              {amountMode === "percentage" ? (
                <Input aria-label="归集百分比" disabled={controlsLocked} inputMode="decimal" max="100" min="0.01" onChange={(event) => { setPercentageAmount(event.target.value); invalidateTask(); }} step="0.01" type="number" value={percentageAmount} />
              ) : amountMode === "fixed" ? (
                <Input aria-label="每钱包固定归集数量" disabled={controlsLocked} inputMode="decimal" min="0" onChange={(event) => { setFixedAmount(event.target.value); invalidateTask(); }} step="0.000001" type="number" value={fixedAmount} />
              ) : amountMode === "random" ? (
                <div className="amount-grid">
                  <Input aria-label="随机最小数量" disabled={controlsLocked} inputMode="decimal" min="0" onChange={(event) => { setRandomMinimum(event.target.value); invalidateTask(); }} step="0.000001" type="number" value={randomMinimum} />
                  <Input aria-label="随机最大数量" disabled={controlsLocked} inputMode="decimal" min="0" onChange={(event) => { setRandomMaximum(event.target.value); invalidateTask(); }} step="0.000001" type="number" value={randomMaximum} />
                </div>
              ) : null}
              {!amountPolicyValid ? <FieldError>请填写有效数量；百分比为 0.01–100，随机最大值不能小于最小值</FieldError> : null}
            </Field>

            <AdvancedSettings disabled={controlsLocked} label="RPC、保留金额与执行设置">
              <Field data-invalid={!rpcEndpointValid ? true : undefined}>
                <FieldLabel htmlFor="sol-collection-rpc">RPC 地址</FieldLabel>
                <Input
                  aria-invalid={!rpcEndpointValid ? true : undefined}
                  disabled={controlsLocked}
                  id="sol-collection-rpc"
                  onBlur={() => rememberRpcEndpoint("solana", networkId, rpcEndpoint)}
                  onChange={(event) => { setRpcEndpoint(event.target.value); invalidateTask(); }}
                  spellCheck={false}
                  type="url"
                  value={rpcEndpoint}
                />
                {!rpcEndpointValid ? <FieldError>请输入以 http:// 或 https:// 开头的有效 RPC 地址</FieldError> : null}
              </Field>
              <div className="field-row">
                <Field>
                  <FieldLabel htmlFor="sol-collection-reserve">每钱包保留 SOL</FieldLabel>
                  <Input disabled={controlsLocked} id="sol-collection-reserve" inputMode="decimal" min="0" onChange={(event) => { setReserveAmount(event.target.value); invalidateTask(); }} step="0.000001" type="number" value={reserveAmount} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="sol-collection-minimum">最小归集金额</FieldLabel>
                  <Input disabled={controlsLocked} id="sol-collection-minimum" inputMode="decimal" min="0" onChange={(event) => { setMinimumAmount(event.target.value); invalidateTask(); }} step="0.000001" type="number" value={minimumAmount} />
                </Field>
              </div>
              <div className="field-row execution-settings-row">
                <Field>
                  <FieldLabel htmlFor="sol-collection-concurrency">并发钱包数</FieldLabel>
                  <Input disabled={controlsLocked} id="sol-collection-concurrency" inputMode="numeric" max="20" min="1" onChange={(event) => { setConcurrency(event.target.value); invalidateTask(); }} step="1" type="number" value={concurrency} />
                </Field>
                <Field>
                  <FieldLabel>随机延迟（秒）</FieldLabel>
                  <div className="amount-grid compact-range">
                    <Input aria-label="随机延迟最小秒数" disabled={controlsLocked} inputMode="decimal" min="0" onChange={(event) => { setMinimumDelay(event.target.value); invalidateTask(); }} step="0.1" type="number" value={minimumDelay} />
                    <Input aria-label="随机延迟最大秒数" disabled={controlsLocked} inputMode="decimal" min="0" onChange={(event) => { setMaximumDelay(event.target.value); invalidateTask(); }} step="0.1" type="number" value={maximumDelay} />
                  </div>
                </Field>
              </div>
              {!executionSettingsValid ? <FieldError>并发为 1–20；延迟为 0–300 秒，且最大值不能小于最小值</FieldError> : null}
            </AdvancedSettings>

            {issues.length ? (
              <Alert variant="destructive"><AlertTitle>输入有误</AlertTitle><AlertDescription><ul>{issues.map((issue, index) => <li key={`${issue}-${index}`}>{issue}</li>)}</ul></AlertDescription></Alert>
            ) : null}
            {message ? (
              <Alert aria-live={workbenchStatus === "error" || workbenchStatus === "uncertain" ? "assertive" : "polite"} variant={workbenchStatus === "error" || workbenchStatus === "uncertain" ? "destructive" : "default"}>
                <AlertTitle>{solStatusLabels[workbenchStatus]}</AlertTitle><AlertDescription>{message}</AlertDescription>
              </Alert>
            ) : null}
            {stage === "running" ? <ExecutionProgress current={completedResultCount} label="SOL 归集进度" total={results.length} /> : null}
          </div>
        </WorkbenchPanel>
        {archivedRound ? (
          <ReviewPanel
            actions={archivedRound.requiresAcknowledgement ? (
              <ConfirmActionDialog
                confirmLabel="确认已核对"
                description="仅确认你已根据交易签名核对记录中的链上状态；这不会重试或撤销原交易。确认后才允许提交新的写入任务。"
                onConfirm={() => setArchivedRound((current) => current ? {
                  ...current,
                  requiresAcknowledgement: false
                } : current)}
                title="已核对记录中的链上状态？"
                triggerLabel="已核对，开始新任务"
                triggerVariant="outline"
              />
            ) : null}
            className="collection-round-archive"
            stateKey={archivedRound.sequence}
            summary={(
              <span>
                成功 {archivedRound.results.filter((result) => result.status === "success").length}
                {" · "}需处理 {archivedRound.results.filter((result) => (
                  result.status === "error" || result.status === "skipped"
                )).length}
              </span>
            )}
            title="归集记录"
          >
            <p className="collection-round-archive__message">{archivedRound.message}</p>
            <CollectionResults
              embedded
              exportFilename="sol-collection-records.csv"
              results={archivedRound.results}
              title="交易明细"
            />
          </ReviewPanel>
        ) : null}
      </div>
    </ToolPageLayout>
  );
}
