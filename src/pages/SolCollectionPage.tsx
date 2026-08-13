import { useMemo, useRef, useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import { CollectionIntro, CollectionSafetyNote } from "../components/CollectionIntro";
import { CollectionResults } from "../components/CollectionResults";
import { SearchableSelect, type SearchableSelectOption } from "../components/SearchableSelect";
import { SecretKeyInput, type SecretKeyInputHandle } from "../components/SecretKeyInput";
import { SiteFooter } from "../components/SiteFooter";
import { SiteHeader } from "../components/SiteHeader";
import { formatLamports, parseSolToLamports } from "../lib/amount";
import type { CollectionDisplayResult, CollectionResultStatus } from "../lib/collection-results";
import {
  collectSolFromSources,
  parseSolanaSourceKeys,
  type SolCollectionItemResult,
  type SolCollectionProgress
} from "../lib/sol-collection";
import {
  assertSolanaRpcNetwork,
  getExplorerUrl,
  getNetworkConfig,
  solanaNetworks,
  type SolanaNetworkId
} from "../lib/solana";

type CollectionStage = "editing" | "ready" | "running" | "complete" | "error";

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
  const [confirmed, setConfirmed] = useState(false);
  const keyInputRef = useRef<SecretKeyInputHandle>(null);
  const selectedNetwork = getNetworkConfig(networkId);
  const running = stage === "running";

  const networkOptions = useMemo<SearchableSelectOption<SolanaNetworkId>[]>(() => (
    solanaNetworks.map((network) => ({
      keywords: [network.id, "Solana"],
      label: network.label,
      meta: network.id,
      value: network.id
    }))
  ), []);

  const invalidateConfirmation = (clearResults = true) => {
    if (running) return;
    setStage("editing");
    setConfirmed(false);
    setMessage("");
    setIssues([]);
    if (clearResults) setResults([]);
  };

  const prepareCollection = () => {
    if (running) return;
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

    if (nextIssues.length || reserveLamports === null || minCollectionLamports === null) {
      setIssues(nextIssues);
      setStage("error");
      setMessage("请修正输入后重新检查");
      return;
    }

    setIssues([]);
    setConfirmed(false);
    setResults(parsedSources.sources.map((source) => ({
      address: source.address,
      amount: "待计算",
      asset: "SOL",
      label: source.label,
      message: "将在执行时读取余额、计算手续费与可归集金额",
      status: source.address === normalizedTarget ? "skipped" : "pending"
    })));
    setStage("ready");
    setMessage(`已解析 ${parsedSources.sources.length} 个来源地址。下一步将在每笔签名前读取实时余额与手续费。`);
  };

  const executeCollection = async () => {
    if (stage !== "ready" || !confirmed) return;
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

    const connection = new Connection(rpcEndpoint.trim(), "confirmed");
    setStage("running");
    setConfirmed(false);
    setMessage("正在校验 RPC 网络；校验通过后才会读取余额和签名");

    try {
      await assertSolanaRpcNetwork(connection, networkId);
    } catch (error) {
      setStage("error");
      setMessage(error instanceof Error && error.message.includes("RPC 网络不匹配")
        ? error.message
        : "无法确认 RPC 所属网络，已阻止归集");
      return;
    }

    keyInputRef.current?.clear();
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
      setMessage(`执行结束：${success} 笔成功，${skipped} 笔跳过${failed ? `，${failed} 笔失败` : ""}`);
    } catch {
      setStage("error");
      setMessage("归集流程意外中断；请先按已显示的交易哈希核对链上状态，再决定是否重试");
    }
  };

  return (
    <div className="site-page collection-page">
      <SiteHeader currentToolId="sol-collection" />
      <main className="shell collection-shell" id="main">
        <CollectionIntro
          chainLabel={selectedNetwork.label}
          description="逐来源钱包读取实时余额和网络费，扣除自定义保留金额后，用本地签名将可归集 SOL 转入目标地址。"
          eyebrow="Many to one · Solana"
          title="SOL 批量归集"
        />

        <div className="workspace collection-workspace">
          <section className="panel" aria-labelledby="sol-collection-config-title">
            <div className="panel-header">
              <div>
                <h2 className="panel-title" id="sol-collection-config-title">归集配置</h2>
                <p className="panel-note">执行开始后密钥输入框会立即清空；每个来源钱包独立签名、提交和确认。</p>
              </div>
            </div>
            <div className="form collection-form">
              <div className="collection-config-grid">
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
                <div className="field full">
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
                <div className="field full">
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
                  <p className="hint">余额减去实时手续费和保留金额后，低于此阈值的来源会跳过。</p>
                </div>
              </div>

              <SecretKeyInput disabled={running} mode="solana" onDirty={() => invalidateConfirmation()} ref={keyInputRef} />

              {issues.length ? (
                <ul className="collection-issue-list" aria-label="输入问题" role="alert">
                  {issues.map((issue, index) => <li key={`${issue}-${index}`}>{issue}</li>)}
                </ul>
              ) : null}

              {message ? (
                <div className="collection-inline-status" data-status={stage === "error" ? "error" : stage === "complete" ? "success" : stage} aria-live="polite">
                  <strong>{stage === "ready" ? "等待最终确认" : stage === "complete" ? "任务已结束" : "任务状态"}</strong>
                  <p>{message}</p>
                </div>
              ) : null}

              {stage === "ready" ? (
                <div className="collection-final-confirm">
                  <strong>准备处理 {results.length} 个来源钱包</strong>
                  <p>目标：{targetAddress}</p>
                  <label className="collection-confirm-check">
                    <input checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} type="checkbox" />
                    <span>我已核对网络、目标地址、保留金额和来源地址，并理解已提交交易不可撤销。</span>
                  </label>
                </div>
              ) : null}

              <div className="actions collection-actions">
                <button className="button ghost" disabled={running} onClick={() => {
                  keyInputRef.current?.clear();
                  setTargetAddress("");
                  setReserveAmount("0.002");
                  setMinimumAmount("0.001");
                  setResults([]);
                  setIssues([]);
                  setMessage("");
                  setConfirmed(false);
                  setStage("editing");
                }} type="button">清空任务</button>
                {stage === "ready" ? (
                  <button className="button primary" disabled={!confirmed} onClick={executeCollection} type="button">确认并开始归集</button>
                ) : (
                  <button className="button primary" disabled={running} onClick={prepareCollection} type="button">检查来源钱包</button>
                )}
              </div>

              <CollectionSafetyNote>
                <p>主网默认每个来源保留 0.002 SOL。把保留金额设为 0 可能使来源钱包无法继续发起交易。</p>
              </CollectionSafetyNote>
            </div>
          </section>

          <CollectionResults
            emptyMessage="填写目标地址和来源钱包后，先生成不含密钥的地址预览。余额和手续费会在执行时读取。"
            exportFilename="sol-collection-results.csv"
            results={results}
          />
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
