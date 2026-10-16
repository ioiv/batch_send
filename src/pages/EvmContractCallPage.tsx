import { useEffect, useMemo, useRef, useState } from "react";
import { computeAddress, parseUnits } from "ethers";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HelpTooltip } from "../components/HelpTooltip";
import { RpcSettings } from "../components/RpcSettings";
import { SearchableSelect } from "../components/SearchableSelect";
import { SecretKeyInput, SourceWalletHelp, type SecretKeyInputHandle, type WalletExecutionItem } from "../components/SecretKeyInput";
import { ToolPageLayout, type WorkbenchStatus } from "../components/ToolPageLayout";
import { ActionBar, AdvancedSettings, ExecutionProgress, WorkbenchPanel, WorkbenchSection, WorkbenchSummary } from "../components/WorkbenchPrimitives";
import { EvmContractCallResults } from "../components/EvmContractCallResults";
import { focusWorkflowField, WorkflowFeedback } from "../components/WorkflowFeedback";
import { getEvmDistributionNetworks, getPreferredEvmDistributionNetwork } from "../lib/evm";
import {
  disposeEvmContractCallBatch, executeEvmContractCallBatch, fillEvmCalldataTemplate,
  inspectEvmContractCallTarget, prepareEvmContractCallBatch, retryEvmContractCallBatch,
  maximumEvmContractCalls, maximumEvmContractCallsPerWallet,
  validateEvmContractCallConfig, type EvmContractCallBatch, type EvmContractCallConfig, type EvmContractCallRow
} from "../lib/evm-contract-call";
import "./evm-contract-call.css";

const statusLabels: Record<EvmContractCallRow["status"], string> = {
  pending: "待发送", preparing: "准备交易", signing: "本地签名", sending: "提交中",
  submitted: "已提交", failed: "失败", unknown: "待核对", cancelled: "未发送"
};
const terminalStatuses = new Set<EvmContractCallRow["status"]>(["submitted", "failed", "unknown", "cancelled"]);
type ResultNetwork = { label: string; symbol: string; explorer?: string };
type PublicRound = { rows: EvmContractCallRow[]; config: EvmContractCallConfig; network: ResultNetwork };
type FieldIssue = { message: string; target: string };

function noticeMessage(error: unknown) {
  return (error instanceof Error ? error.message : "任务执行失败，请检查设置后重试")
    .replace(/https?:\/\/[^\s<>"')]+/gi, "[RPC 已隐藏]")
    .replace(/\b(?:0x)?[a-f\d]{64,}\b/gi, "[敏感数据已隐藏]").slice(0, 400);
}

function issueTarget(message: string) {
  if (/执行次数|调用总数|调用数据总量/.test(message)) return "contract-call-count";
  if (/私钥|钱包|密钥/.test(message)) return "source-wallet-import";
  if (/合约地址|零地址|未部署|合约代码|目标地址/.test(message)) return "contract-call-to";
  if (/calldata|模板|占位符/.test(message)) return "contract-call-data";
  if (/Gas Limit/.test(message)) return "contract-call-gas-limit";
  if (/Gas Price/.test(message)) return "contract-call-gas-price";
  if (/线程|并发/.test(message)) return "contract-call-concurrency";
  if (/间隔|延迟/.test(message)) return "contract-call-delay-min";
  if (/随机数|随机整数/.test(message)) return "contract-call-id-min";
  if (/金额/.test(message)) return "contract-call-amount";
  return "contract-call-rpc";
}

function issueSummary(target: string) {
  const labels: Record<string, string> = {
    "source-wallet-import": "来源钱包",
    "contract-call-to": "合约地址",
    "contract-call-data": "调用数据",
    "contract-call-rpc": "RPC 节点",
    "contract-call-amount": "附带金额",
    "contract-call-amount-min": "附带金额",
    "contract-call-id-min": "随机整数范围",
    "contract-call-concurrency": "同时执行钱包数",
    "contract-call-count": "每钱包执行次数",
    "contract-call-delay-min": "任务间隔",
    "contract-call-gas-limit": "Gas Limit",
    "contract-call-gas-price": "Gas Price"
  };
  const label = labels[target] || "调用设置";
  return `请修正${/^[a-z]/i.test(label) ? " " : ""}${label}`;
}

function formatAmount(wei: bigint) {
  const text = wei.toString().padStart(19, "0");
  const fraction = text.slice(-18).replace(/0+$/, "");
  return `${text.slice(0, -18)}${fraction ? `.${fraction}` : ""}`;
}

function downloadResults(rows: readonly EvmContractCallRow[], config: EvmContractCallConfig, network: ResultNetwork) {
  const cell = (value: unknown) => {
    const raw = String(value ?? "");
    return `"${(/^(?:[=+@\-\t\r\n]|\s+[=+@-])/.test(raw) ? `'${raw}` : raw).replace(/"/g, '""')}"`;
  };
  const csv = [
    ["序号", "钱包地址", "合约地址", "原生币金额", "value (wei)", "randomId", "状态", "交易哈希", "说明", "calldata", "网络", "备注", "钱包序号", "执行序号", "每钱包执行次数"],
    ...rows.map(row => [row.index + 1, row.address, config.contractAddress, formatAmount(row.amountWei), row.amountWei, row.randomId, statusLabels[row.status], row.hash, row.message, row.calldata, network.label, row.label, row.walletIndex + 1, row.callIndex, row.callsPerWallet])
  ].map(row => row.map(cell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url; link.download = `evm-contract-calls-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function EvmContractCallPage() {
  const keyInput = useRef<SecretKeyInputHandle>(null);
  const templateInput = useRef<HTMLTextAreaElement>(null);
  const preparedBatch = useRef<EvmContractCallBatch | null>(null);
  const resultConfig = useRef<EvmContractCallConfig | null>(null);
  const continuingRound = useRef<PublicRound | null>(null);
  const controller = useRef<AbortController | null>(null);
  const inspection = useRef<AbortController | null>(null);
  const revision = useRef(0);
  const mounted = useRef(true);
  const resultAnchor = useRef<HTMLDivElement>(null);
  const [networks] = useState(() => getEvmDistributionNetworks().filter(network => network.nativeCurrency.decimals === 18));
  const [networkId, setNetworkId] = useState<string>(() => getPreferredEvmDistributionNetwork(networks).id);
  const selectedNetwork = networks.find(network => network.id === networkId);
  const [rpcEndpoint, setRpcEndpoint] = useState(() => getPreferredEvmDistributionNetwork(networks).rpcEndpoint);
  const [contractAddress, setContractAddress] = useState("");
  const [calldataTemplate, setCalldataTemplate] = useState("");
  const [amountMode, setAmountMode] = useState<"none" | "fixed" | "random">("none");
  const [fixedAmount, setFixedAmount] = useState("0");
  const [amountMin, setAmountMin] = useState("0");
  const [amountMax, setAmountMax] = useState("0");
  const [randomIdMin, setRandomIdMin] = useState("0");
  const [randomIdMax, setRandomIdMax] = useState("1000000");
  const [taskNum, setTaskNum] = useState("3");
  const [callsPerWallet, setCallsPerWallet] = useState("1");
  const [delayMode, setDelayMode] = useState<"fixed" | "random">("fixed");
  const [delayMin, setDelayMin] = useState("0");
  const [delayMax, setDelayMax] = useState("1000");
  const [gasLimit, setGasLimit] = useState("");
  const [gasPriceGwei, setGasPriceGwei] = useState("");
  const [walletCount, setWalletCount] = useState(0);
  const [walletCompact, setWalletCompact] = useState(false);
  const [sampleAddress, setSampleAddress] = useState("");
  const [importing, setImporting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [editing, setEditing] = useState(true);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState("");
  const [issue, setIssue] = useState<FieldIssue | null>(null);
  const [rows, setRows] = useState<EvmContractCallRow[]>([]);
  const [resultNetwork, setResultNetwork] = useState<ResultNetwork>({ label: "", symbol: "原生币" });
  const [lastRound, setLastRound] = useState<PublicRound | null>(null);
  const [uncertainAcknowledged, setUncertainAcknowledged] = useState(false);
  const writingBlocked = Boolean(lastRound?.rows.some(row => row.status === "unknown") && !uncertainAcknowledged);
  const usesRandomId = /\{(?:randomId|randowId)\}/.test(calldataTemplate);
  const locked = running || importing;
  const networkOptions = useMemo(() => [
    ...networks.map(network => ({ value: network.id as string, label: network.label, meta: String(network.chainId), keywords: [network.nativeCurrency.symbol] })),
    { value: "custom-rpc", label: "自定义 RPC", meta: "自动识别网络" }
  ], [networks]);

  useEffect(() => {
    mounted.current = true;
    const stop = () => {
      revision.current += 1;
      inspection.current?.abort(); inspection.current = null;
      controller.current?.abort();
      if (preparedBatch.current) disposeEvmContractCallBatch(preparedBatch.current);
      preparedBatch.current = null;
      setReady(false); setChecking(false); setEditing(true); setSampleAddress("");
    };
    window.addEventListener("pagehide", stop);
    return () => {
      mounted.current = false; revision.current += 1;
      window.removeEventListener("pagehide", stop);
      inspection.current?.abort(); controller.current?.abort();
      if (preparedBatch.current) disposeEvmContractCallBatch(preparedBatch.current);
      preparedBatch.current = null;
    };
  }, []);

  useEffect(() => {
    if (!running) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running]);

  const invalidate = () => {
    revision.current += 1;
    inspection.current?.abort(); inspection.current = null;
    if (preparedBatch.current) disposeEvmContractCallBatch(preparedBatch.current);
    preparedBatch.current = null;
    continuingRound.current = null;
    setReady(false); setChecking(false); setNotice(""); setIssue(null);
    setRows(current => current.every(row => row.status === "pending") ? [] : current);
  };
  const update = (setter: (value: string) => void, value: string) => { invalidate(); setter(value); };
  const walletDirty = (reason: "import" | "remove" | "selection") => {
    invalidate();
    setEditing(true);
    if (reason === "import") setWalletCompact(true);
    const first = keyInput.current?.read().split(/\r?\n/)[0]?.trim() || "";
    const key = first.slice(first.indexOf(",") + 1).trim();
    try { setSampleAddress(key ? computeAddress(key.startsWith("0x") ? key : `0x${key}`) : ""); }
    catch { setSampleAddress(""); }
  };
  const showIssue = (error: unknown) => {
    const message = noticeMessage(error);
    let target = issueTarget(message);
    if (target === "contract-call-amount" && amountMode === "random") target = "contract-call-amount-min";
    if (!editing) { setNotice(message); return; }
    if (target === "source-wallet-import") setWalletCompact(false);
    setIssue({ message, target });
    focusWorkflowField(target);
  };
  const errorFor = (id: string) => issue?.target === id ? issue.message : undefined;
  const fieldError = (id: string) => errorFor(id) ? <FieldError id={`${id}-error`}>{errorFor(id)}</FieldError> : null;
  const focusResults = () => requestAnimationFrame(() => {
    resultAnchor.current?.scrollIntoView?.({ block: "start", behavior: "auto" });
    resultAnchor.current?.focus({ preventScroll: true });
  });
  const makeConfig = (): EvmContractCallConfig => ({
    contractAddress, calldataTemplate, rpcEndpoint, expectedChainId: selectedNetwork?.chainId,
    amount: { mode: amountMode === "random" ? "random" : "fixed", fixed: amountMode === "none" ? "0" : fixedAmount, min: amountMin, max: amountMax },
    randomId: { min: usesRandomId ? randomIdMin : "0", max: usesRandomId ? randomIdMax : "0" },
    callsPerWallet: callsPerWallet.trim() ? Number(callsPerWallet) : Number.NaN,
    taskNum: taskNum.trim() ? Number(taskNum) : Number.NaN,
    delay: { mode: delayMode, minMs: delayMin.trim() ? Number(delayMin) : Number.NaN, maxMs: delayMode === "fixed" ? Number(delayMin) : delayMax.trim() ? Number(delayMax) : Number.NaN },
    gasLimit: gasLimit.trim() || undefined, gasPriceGwei: gasPriceGwei.trim() || undefined
  });

  const check = async (retry = false) => {
    if (locked || writingBlocked || inspection.current || controller.current) return;
    const previous = retry ? lastRound : null;
    if (retry && !previous) return;
    invalidate();
    const checkRevision = revision.current;
    const abort = new AbortController();
    inspection.current = abort; setChecking(true);
    try {
      if (!keyInput.current?.read().trim()) throw new Error("请至少导入并选择一个有效的钱包");
      const config = previous ? { ...previous.config } : makeConfig();
      validateEvmContractCallConfig(config);
      if (!previous && walletCount * (config.callsPerWallet ?? 1) > maximumEvmContractCalls) {
        throw new Error(`调用总数不能超过 ${maximumEvmContractCalls} 笔，请减少钱包数或每钱包执行次数`);
      }
      const { chainId } = await inspectEvmContractCallTarget(config, { signal: abort.signal });
      if (!mounted.current || abort.signal.aborted || checkRevision !== revision.current) return;
      const pinnedConfig = { ...config, expectedChainId: chainId };
      const batch = previous
        ? retryEvmContractCallBatch(keyInput.current?.read() || "", pinnedConfig, previous.rows)
        : prepareEvmContractCallBatch(keyInput.current?.read() || "", pinnedConfig);
      const knownNetwork = networks.find(network => network.chainId === chainId);
      const network = { label: `${knownNetwork?.label || "自定义网络"} · ${chainId}`, symbol: knownNetwork?.nativeCurrency.symbol || "原生币", explorer: knownNetwork?.blockExplorerUrl };
      preparedBatch.current = batch; resultConfig.current = batch.config;
      continuingRound.current = previous;
      setResultNetwork(network); setRows(batch.rows.map(row => ({ ...row })));
      setReady(true); setEditing(false); setIssue(null);
      setNotice(previous ? `${retryActionLabel}，沿用各笔原金额、随机整数和调用数据。` : "网络与目标合约已核对。每笔金额和调用数据已固定；同一钱包依次发送。");
      focusResults();
    } catch (error) {
      if (mounted.current && !abort.signal.aborted && checkRevision === revision.current) showIssue(error);
    } finally {
      if (inspection.current === abort) { inspection.current = null; if (mounted.current) setChecking(false); }
    }
  };

  const execute = async () => {
    const batch = preparedBatch.current;
    if (!batch || !ready || locked || writingBlocked || controller.current || inspection.current) return;
    const originalRound = continuingRound.current;
    const abort = new AbortController();
    const executionRevision = revision.current;
    controller.current = abort;
    const isCurrentExecution = () => mounted.current && controller.current === abort && revision.current === executionRevision;
    setReady(false); setRunning(true); setStopping(false); setIssue(null);
    setNotice("正在逐笔本地签名并提交交易，同一钱包依次发送，请保持页面打开。");
    try {
      const finalRows = await executeEvmContractCallBatch(batch, {
        signal: abort.signal,
        onUpdate: row => { if (isCurrentExecution()) setRows(current => current.map(item => item.id === row.id ? { ...row } : item)); }
      });
      if (isCurrentExecution()) {
        const updates = new Map(finalRows.map(row => [row.id, row]));
        const roundRows = originalRound ? originalRound.rows.map(row => updates.get(row.id) || row) : finalRows;
        if (finalRows.some(row => row.status === "unknown" && !originalRound?.rows.some(previous => previous.status === "unknown" && previous.id === row.id && previous.hash === row.hash))) setUncertainAcknowledged(false);
        setRows(roundRows);
        setLastRound({ rows: roundRows.map(row => ({ ...row })), config: batch.config, network: resultNetwork });
        const count = (status: EvmContractCallRow["status"]) => roundRows.filter(row => row.status === status).length;
        setNotice(`本轮结束：已提交 ${count("submitted")}，失败 ${count("failed")}，待核对 ${count("unknown")}，未发送 ${count("cancelled")}。`);
      }
    } catch (error) { if (isCurrentExecution()) setNotice(noticeMessage(error)); }
    finally {
      disposeEvmContractCallBatch(batch);
      if (preparedBatch.current === batch) preparedBatch.current = null;
      if (controller.current === abort) {
        continuingRound.current = null;
        controller.current = null;
        if (mounted.current) { setRunning(false); setStopping(false); }
      }
    }
  };

  const returnToEdit = () => {
    if (running || checking) return;
    invalidate();
    // Finished calls remain in lastRound; a new task has no execution state.
    setRows([]);
    resultConfig.current = null;
    setStopping(false);
    setEditing(true);
    focusWorkflowField("contract-call-to");
  };
  const insertToken = (token: string) => {
    if (locked) return;
    const input = templateInput.current;
    const start = input && input.selectionStart > 1 ? input.selectionStart : calldataTemplate.length;
    const end = Math.max(start, input?.selectionEnd ?? start);
    const value = `{${token}}`;
    update(setCalldataTemplate, `${calldataTemplate.slice(0, start)}${value}${calldataTemplate.slice(end)}`);
    requestAnimationFrame(() => { input?.focus(); input?.setSelectionRange(start + value.length, start + value.length); });
  };
  const sample = useMemo(() => {
    if (!sampleAddress || !calldataTemplate.trim()) return "";
    try { return fillEvmCalldataTemplate({ template: calldataTemplate, address: sampleAddress, amountWei: parseUnits(amountMode === "none" ? "0" : amountMode === "fixed" ? fixedAmount : amountMin, 18), randomId: BigInt(usesRandomId ? randomIdMin : "0") }); }
    catch { return ""; }
  }, [sampleAddress, calldataTemplate, amountMode, fixedAmount, amountMin, usesRandomId, randomIdMin]);
  const completed = rows.filter(row => terminalStatuses.has(row.status)).length;
  const unknown = rows.some(row => row.status === "unknown");
  const failed = rows.some(row => row.status === "failed");
  const cancelled = rows.filter(row => row.status === "cancelled").length;
  const retryRows = lastRound?.rows.filter(row => (row.status === "failed" || row.status === "cancelled") && row.hash === null) || [];
  const retryCount = retryRows.length;
  const retryFailedCount = retryRows.filter(row => row.status === "failed").length;
  const retryUnsentCount = retryCount - retryFailedCount;
  const retryActionLabel = [
    retryFailedCount ? `重试 ${retryFailedCount} 笔失败` : "",
    retryUnsentCount ? `继续 ${retryUnsentCount} 笔未发送` : ""
  ].filter(Boolean).join("并");
  const status: WorkbenchStatus = checking ? "preflight" : running ? "running" : editing ? issue ? "error" : "editing" : ready ? "ready" : unknown ? "uncertain" : failed ? "error" : "success";
  const statusLabel = checking ? "检查网络与合约" : running ? stopping ? "正在停止" : `提交中 ${completed} / ${rows.length}` : editing ? issue ? "需要完善" : undefined : ready ? "待核对" : unknown ? "有交易待核对" : failed ? "部分调用失败" : cancelled === rows.length ? "已停止" : "提交结束";
  const walletStatuses = useMemo(() => {
    const statuses: Record<string, WalletExecutionItem[]> = {};
    rows.forEach(row => {
      const key = row.address.toLowerCase();
      (statuses[key] ||= []).push({
        asset: row.callsPerWallet > 1 ? `合约调用 · 第 ${row.callIndex} / ${row.callsPerWallet} 次` : "合约调用", amount: `${formatAmount(row.amountWei)} ${resultNetwork.symbol}`,
        status: row.status === "submitted" ? "confirming" : row.status === "unknown" ? "uncertain" : row.status === "failed" ? "error" : row.status === "cancelled" ? "skipped" : row.status === "sending" || row.status === "signing" ? "submitting" : "pending",
        message: row.message, hash: row.hash || undefined,
        explorerUrl: row.hash && resultNetwork.explorer ? `${resultNetwork.explorer.replace(/\/$/, "")}/tx/${row.hash}` : undefined
      });
    });
    return statuses;
  }, [rows, resultNetwork]);
  const configuredCalls = Number(callsPerWallet);
  const validCallCount = Boolean(callsPerWallet.trim()) && Number.isInteger(configuredCalls) && configuredCalls >= 1 && configuredCalls <= maximumEvmContractCallsPerWallet;
  const plannedCallCount = validCallCount ? walletCount * configuredCalls : null;
  const settingsSummary = `同时执行 ${taskNum || "—"} 个钱包 · ${delayMin === "0" && delayMode === "fixed" ? "无间隔" : delayMode === "random" ? "随机间隔" : `${delayMin} ms 间隔`} · Gas ${gasLimit || gasPriceGwei ? "手动" : "自动"}`;
  const advancedIssue = Boolean(issue && /concurrency|delay|gas/.test(issue.target));

  return <ToolPageLayout currentToolId="evm-contract-call" title="EVM 合约批量调用" status={status} statusLabel={statusLabel}>
    <div className="workspace contract-call-workspace">
      <div hidden={!editing}>
        <WorkbenchPanel segmented title="调用设置" footer={<ActionBar
          summary={<WorkbenchSummary items={[{ label: "已选钱包", value: walletCount }, { label: "每钱包执行", value: validCallCount ? `${configuredCalls} 次` : "—" }, { label: "总调用", value: plannedCallCount === null ? "—" : `${plannedCallCount} 笔` }, { label: "网络", value: selectedNetwork ? `${selectedNetwork.label} · ${selectedNetwork.chainId}` : "自动识别" }]} />}
          feedback={issue ? <WorkflowFeedback requirement={{ message: issueSummary(issue.target), targetId: issue.target, actionLabel: "定位问题" }} /> : checking ? <p className="contract-call-notice" role="status">正在检查网络与目标合约…</p> : writingBlocked ? <p className="contract-call-notice" role="status">上一轮有交易待核对，请先查看上一轮结果。</p> : undefined}
        >
          {checking ? <Button type="button" variant="outline" onClick={invalidate}>取消检查</Button> : null}
          {lastRound ? <Button type="button" variant="outline" disabled={locked || checking} onClick={() => { setRows(lastRound.rows); resultConfig.current = lastRound.config; setResultNetwork(lastRound.network); setEditing(false); setReady(false); setNotice(""); focusResults(); }}>查看上一轮结果</Button> : null}
          <Button disabled={locked || checking || writingBlocked} onClick={() => void check()} type="button">{checking ? "检查中…" : "核对并发送"}</Button>
        </ActionBar>}>
          <div className="form workbench-form">
            <WorkbenchSection title="来源钱包" actions={<>{walletCount > 0 ? <Button size="sm" variant="ghost" type="button" aria-expanded={!walletCompact} onClick={() => setWalletCompact(value => !value)} disabled={running || checking}>{walletCompact ? "管理钱包" : "收起钱包"}</Button> : null}<SourceWalletHelp /></>}>
              {walletCompact && walletCount > 0 ? <div className="contract-call-wallet-summary"><span>已选 {walletCount} 个钱包</span>{sampleAddress ? <span><code>{sampleAddress.slice(0, 10)}…{sampleAddress.slice(-8)}</code>{walletCount > 1 ? ` 等 ${walletCount} 个` : null}</span> : null}</div> : null}
              <div hidden={walletCompact && walletCount > 0}>
              <SecretKeyInput hideHeading mode="evm" ref={keyInput} disabled={running || checking} onDirty={walletDirty} onLineCountChange={setWalletCount} onImportingChange={setImporting} walletStatuses={walletStatuses} />
              </div>
              {fieldError("source-wallet-import")}
            </WorkbenchSection>
            <WorkbenchSection title="合约与调用内容">
              <div className="config-grid">
                <Field><FieldLabel htmlFor="contract-call-network">网络</FieldLabel>
                  <SearchableSelect id="contract-call-network" searchLabel="选择调用网络" triggerLabel="选择调用网络" listboxLabel="调用网络" options={networkOptions} value={networkId} disabled={locked}
                    onChange={value => { invalidate(); setNetworkId(value); setRpcEndpoint(networks.find(network => network.id === value)?.rpcEndpoint || ""); }} />
                </Field>
                <Field><FieldLabel htmlFor="contract-call-to">合约地址</FieldLabel>
                  <Input id="contract-call-to" autoComplete="off" spellCheck={false} placeholder="0x…" disabled={locked} value={contractAddress} onChange={event => update(setContractAddress, event.target.value)} aria-invalid={Boolean(errorFor("contract-call-to"))} aria-describedby={errorFor("contract-call-to") ? "contract-call-to-error" : undefined} />{fieldError("contract-call-to")}
                </Field>
                <div className="config-grid__full"><RpcSettings endpoint={rpcEndpoint} disabled={locked} invalid={!selectedNetwork || Boolean(errorFor("contract-call-rpc"))}>
                  <Field><FieldLabel htmlFor="contract-call-rpc">RPC 节点</FieldLabel><Input id="contract-call-rpc" type="url" autoComplete="off" spellCheck={false} placeholder="https://…" disabled={locked} value={rpcEndpoint} onChange={event => update(setRpcEndpoint, event.target.value)} aria-invalid={Boolean(errorFor("contract-call-rpc"))} aria-describedby="contract-call-rpc-help" />
                    <FieldDescription id="contract-call-rpc-help">{selectedNetwork ? `发送前自动核对 Chain ID ${selectedNetwork.chainId}。` : "自动识别 Chain ID；原生币金额按 18 位小数处理。"}</FieldDescription>{fieldError("contract-call-rpc")}
                  </Field>
                </RpcSettings></div>
                <Field className="config-grid__full">
                  <div className="contract-call-editor-heading"><FieldLabel htmlFor="contract-call-data">调用数据</FieldLabel><div className="contract-call-token-actions" aria-label="插入占位符">
                    <Button type="button" size="sm" variant="ghost" disabled={locked} onMouseDown={event => event.preventDefault()} onClick={() => insertToken("address")}>＋ 钱包地址</Button>
                    <Button type="button" size="sm" variant="ghost" disabled={locked} onMouseDown={event => event.preventDefault()} onClick={() => insertToken("random")}>＋ 金额</Button>
                    <Button type="button" size="sm" variant="ghost" disabled={locked} onMouseDown={event => event.preventDefault()} onClick={() => insertToken("randomId")}>＋ 随机整数</Button>
                    <HelpTooltip label="调用数据与占位符">支持原始十六进制 calldata。{"{address}"} 为当前钱包地址，{"{random}"} 为附带金额（wei），{"{randomId}"} 为随机整数（兼容旧写法 {"{randowId}"}）。占位符去除 0x，左补零为 64 位十六进制；同笔内重复占位符使用相同值。</HelpTooltip>
                  </div></div>
                  <Textarea ref={templateInput} id="contract-call-data" className="contract-call-template mono" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="粘贴 0x 开头的调用数据，或插入占位符" disabled={locked} value={calldataTemplate} onChange={event => update(setCalldataTemplate, event.target.value)} aria-invalid={Boolean(errorFor("contract-call-data"))} aria-describedby={errorFor("contract-call-data") ? "contract-call-data-error" : undefined} />{fieldError("contract-call-data")}
                  {sample ? <details className="contract-call-sample"><summary>查看首个钱包替换示例{amountMode === "random" || usesRandomId ? "（范围下限）" : ""}</summary><code>{sample}</code></details> : null}
                </Field>
                <Field className="config-grid__full"><FieldLabel htmlFor="contract-call-count">每钱包执行次数</FieldLabel>
                  <Input id="contract-call-count" className="contract-call-count" type="number" inputMode="numeric" min="1" max={maximumEvmContractCallsPerWallet} step="1" disabled={locked} value={callsPerWallet} onChange={event => update(setCallsPerWallet, event.target.value)} aria-invalid={Boolean(errorFor("contract-call-count"))} aria-describedby={errorFor("contract-call-count") ? "contract-call-count-error" : "contract-call-count-help"} />
                  <FieldDescription id="contract-call-count-help">同一钱包依次执行，每次单独支付金额和网络费；每钱包最多 {maximumEvmContractCallsPerWallet} 次。</FieldDescription>{fieldError("contract-call-count")}
                </Field>
                <Field className="config-grid__full"><FieldLabel>每笔附带原生币{selectedNetwork ? `（${selectedNetwork.nativeCurrency.symbol}）` : ""}</FieldLabel>
                  <Tabs value={amountMode} onValueChange={value => { invalidate(); setAmountMode(value as typeof amountMode); }}><TabsList aria-label="交易金额模式">
                    <TabsTrigger value="none" disabled={locked}>不附带金额</TabsTrigger><TabsTrigger value="fixed" disabled={locked}>固定金额</TabsTrigger><TabsTrigger value="random" disabled={locked}>随机金额</TabsTrigger>
                  </TabsList></Tabs>
                  {amountMode !== "none" && calldataTemplate.includes("{random}") ? <FieldDescription>此金额同时用于交易 value 和模板中的 {"{random}"}。</FieldDescription> : null}
                </Field>
                {amountMode === "fixed" ? <Field className="config-grid__full"><FieldLabel htmlFor="contract-call-amount">每笔固定金额</FieldLabel><Input id="contract-call-amount" inputMode="decimal" disabled={locked} value={fixedAmount} onChange={event => update(setFixedAmount, event.target.value)} aria-invalid={Boolean(errorFor("contract-call-amount"))} />{fieldError("contract-call-amount")}</Field> : null}
                {amountMode === "random" ? <>
                  <Field><FieldLabel htmlFor="contract-call-amount-min">每笔最小金额</FieldLabel><Input id="contract-call-amount-min" inputMode="decimal" disabled={locked} value={amountMin} onChange={event => update(setAmountMin, event.target.value)} aria-invalid={Boolean(errorFor("contract-call-amount-min"))} />{fieldError("contract-call-amount-min")}</Field>
                  <Field><FieldLabel htmlFor="contract-call-amount-max">每笔最大金额</FieldLabel><Input id="contract-call-amount-max" inputMode="decimal" disabled={locked} value={amountMax} onChange={event => update(setAmountMax, event.target.value)} /></Field>
                </> : null}
                {usesRandomId ? <>
                  <Field><FieldLabel htmlFor="contract-call-id-min">随机整数最小值</FieldLabel><Input id="contract-call-id-min" inputMode="numeric" disabled={locked} value={randomIdMin} onChange={event => update(setRandomIdMin, event.target.value)} aria-invalid={Boolean(errorFor("contract-call-id-min"))} />{fieldError("contract-call-id-min")}</Field>
                  <Field><FieldLabel htmlFor="contract-call-id-max">随机整数最大值</FieldLabel><Input id="contract-call-id-max" inputMode="numeric" disabled={locked} value={randomIdMax} onChange={event => update(setRandomIdMax, event.target.value)} /></Field>
                </> : null}
                <div className="config-grid__full"><AdvancedSettings label="高级设置" disabled={locked} summary={settingsSummary} invalid={advancedIssue}>
                  <div className="config-grid">
                    <Field><FieldLabel htmlFor="contract-call-concurrency">同时执行钱包数</FieldLabel><Input id="contract-call-concurrency" type="number" min="1" max="20" step="1" disabled={locked} value={taskNum} onChange={event => update(setTaskNum, event.target.value)} aria-invalid={Boolean(errorFor("contract-call-concurrency"))} />{fieldError("contract-call-concurrency")}</Field>
                    <Field><FieldLabel>任务间隔</FieldLabel><Tabs value={delayMode} onValueChange={value => { invalidate(); setDelayMode(value as typeof delayMode); }}><TabsList aria-label="任务间隔模式"><TabsTrigger value="fixed" disabled={locked}>固定间隔</TabsTrigger><TabsTrigger value="random" disabled={locked}>随机间隔</TabsTrigger></TabsList></Tabs></Field>
                    <Field><FieldLabel htmlFor="contract-call-delay-min">{delayMode === "fixed" ? "间隔（毫秒）" : "最小间隔（毫秒）"}</FieldLabel><Input id="contract-call-delay-min" type="number" min="0" max="300000" step="1" disabled={locked} value={delayMin} onChange={event => update(setDelayMin, event.target.value)} aria-invalid={Boolean(errorFor("contract-call-delay-min"))} />{fieldError("contract-call-delay-min")}</Field>
                    {delayMode === "random" ? <Field><FieldLabel htmlFor="contract-call-delay-max">最大间隔（毫秒）</FieldLabel><Input id="contract-call-delay-max" type="number" min="0" max="300000" step="1" disabled={locked} value={delayMax} onChange={event => update(setDelayMax, event.target.value)} /></Field> : null}
                    <Field><FieldLabel htmlFor="contract-call-gas-limit">Gas Limit</FieldLabel><Input id="contract-call-gas-limit" placeholder="自动估算 + 20%" inputMode="numeric" disabled={locked} value={gasLimit} onChange={event => update(setGasLimit, event.target.value)} aria-invalid={Boolean(errorFor("contract-call-gas-limit"))} />{fieldError("contract-call-gas-limit")}</Field>
                    <Field><FieldLabel htmlFor="contract-call-gas-price">Gas Price（Gwei）</FieldLabel><Input id="contract-call-gas-price" placeholder="自动获取" inputMode="decimal" disabled={locked} value={gasPriceGwei} onChange={event => update(setGasPriceGwei, event.target.value)} aria-invalid={Boolean(errorFor("contract-call-gas-price"))} />{fieldError("contract-call-gas-price")}</Field>
                    <FieldDescription className="config-grid__full">间隔按每个执行线程计算，包含同一钱包的多次调用；Gas 留空即可自动估算。</FieldDescription>
                  </div>
                </AdvancedSettings></div>
              </div>
            </WorkbenchSection>
          </div>
        </WorkbenchPanel>
      </div>
      {!editing && rows.length && resultConfig.current ? <div ref={resultAnchor} tabIndex={-1} className="contract-call-result-anchor">
        <EvmContractCallResults rows={rows} callsPerWallet={resultConfig.current.callsPerWallet} contractAddress={resultConfig.current.contractAddress} networkLabel={resultNetwork.label} nativeSymbol={resultNetwork.symbol} explorerBaseUrl={resultNetwork.explorer} phase={ready ? "review" : running ? "running" : "result"} notice={notice}
          onExport={() => downloadResults(rows, resultConfig.current!, resultNetwork)}
          footer={<ActionBar feedback={!ready && !running && lastRound?.rows.some(row => row.status === "unknown") ? <label className="contract-call-acknowledgment"><Checkbox checked={uncertainAcknowledged} onCheckedChange={value => setUncertainAcknowledged(value === true)} /><span>我已核对待核对交易的链上结果</span></label> : undefined}>
            {running ? <><ExecutionProgress current={completed} total={rows.length} label="提交进度" /><Button disabled={stopping} onClick={() => { setStopping(true); controller.current?.abort(); }} type="button" variant="outline">{stopping ? "正在停止" : "停止后续任务"}</Button></> : ready ? <>
              <Button disabled={checking} onClick={returnToEdit} type="button" variant="outline">返回修改</Button><Button disabled={locked || checking || writingBlocked} onClick={() => void execute()} type="button">确认发送 {rows.length} 笔</Button>
            </> : <>
              <Button disabled={checking || locked} onClick={returnToEdit} type="button" variant={retryCount > 0 ? "outline" : "default"}>开始新一轮</Button>
              {checking ? <Button type="button" variant="outline" onClick={invalidate}>取消检查</Button> : null}
              {retryCount > 0 ? <Button disabled={checking || locked || writingBlocked} onClick={() => void check(true)} type="button">{checking ? "检查中…" : retryActionLabel}</Button> : null}
            </>}
          </ActionBar>} />
      </div> : null}
    </div>
  </ToolPageLayout>;
}
