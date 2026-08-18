import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DistributionListGenerator } from "../components/DistributionListGenerator";
import { DistributionReview } from "../components/DistributionReview";
import { Metric } from "../components/Metric";
import { SearchableSelect, type SearchableSelectOption } from "../components/SearchableSelect";
import { ToolPageLayout, type ToolPageStep, type ToolPageStepState } from "../components/ToolPageLayout";
import { WalletConnectionControl } from "../components/WalletConnectionControl";
import { useSolanaWallet } from "../hooks/useSolanaWallet";
import { shortenAddress } from "../lib/address";
import { formatLamports, formatLamportsForDisplay } from "../lib/amount";
import { getInitialDistributionInput, parseDistribution } from "../lib/distribution";
import { importDistributionInput, type GeneratedDistributionList } from "../lib/distribution-generator";
import {
  Connection,
  createSendProgress,
  createTransferTransaction,
  estimateTransactionFeesLamports,
  getBalanceLamports,
  getEstimatedTransferChunks,
  getExplorerUrl,
  getNetworkConfig,
  getTransactionErrorMessage,
  initialSendState,
  planTransferChunks,
  sendWalletTransaction,
  solanaNetworks,
  type SendOptions,
  type SolanaNetworkId,
  type TransactionSignature
} from "../lib/solana";

type BalanceLookupState = {
  message: string;
  status: "idle" | "loading" | "success" | "error";
  valueLamports: bigint | null;
};

type DistributionPreflightState = {
  balanceLamports: bigint | null;
  estimatedFeeLamports: bigint | null;
  message: string;
  requiredLamports: bigint | null;
  status: "idle" | "loading" | "success" | "error";
  transactionCount: number;
};

const solDistributionSteps: ToolPageStep[] = [
  { label: "准备", description: "连接钱包并整理清单" },
  { label: "确认", description: "核对网络、金额和批次" },
  { label: "批量发送", description: "签名并跟踪链上结果" }
];

const initialBalanceLookupState: BalanceLookupState = {
  message: "",
  status: "idle",
  valueLamports: null
};

const initialDistributionPreflightState: DistributionPreflightState = {
  balanceLamports: null,
  estimatedFeeLamports: null,
  message: "",
  requiredLamports: null,
  status: "idle",
  transactionCount: 0
};

const initialGeneratedList: GeneratedDistributionList = {
  duplicates: 0,
  invalid: 0,
  issues: [],
  output: "",
  total: "0",
  totalUnits: 0n,
  validCount: 0
};

const solanaNetworkOptions: SearchableSelectOption<SolanaNetworkId>[] = solanaNetworks.map((network) => ({
  keywords: [network.id],
  label: network.label,
  meta: network.id,
  value: network.id
}));

function getBalanceLookupErrorMessage(error: unknown) {
  const detail = error && typeof error === "object" && "message" in error ? String((error as { message?: unknown }).message || "") : String(error || "");

  if (/403|429|failed to fetch|network|fetch|timeout/i.test(detail)) return "余额读取失败，请更换 RPC 后重试";
  return detail ? `余额读取失败：${detail}` : "余额读取失败，请稍后重试";
}

export function BatchDistributorPage() {
  const [initialDistribution] = useState(() => importDistributionInput(getInitialDistributionInput()));
  const [generatedInput, setGeneratedInput] = useState("");
  const [generatedList, setGeneratedList] = useState<GeneratedDistributionList>(initialGeneratedList);
  const [confirmVisible, setConfirmVisible] = useState(false);
  const [networkId, setNetworkId] = useState<SolanaNetworkId>("mainnet-beta");
  const [rpcEndpoint, setRpcEndpoint] = useState(getNetworkConfig("mainnet-beta").endpoint);
  const [sendState, setSendState] = useState(initialSendState);
  const [preflightState, setPreflightState] = useState<DistributionPreflightState>(initialDistributionPreflightState);
  const [balanceLookup, setBalanceLookup] = useState<BalanceLookupState>(initialBalanceLookupState);
  const [balanceRefreshNonce, setBalanceRefreshNonce] = useState(0);
  const [listImporting, setListImporting] = useState(false);
  const [generatorRevision, setGeneratorRevision] = useState(0);
  const confirmationRef = useRef<HTMLDivElement>(null);
  const listImportingRef = useRef(false);
  const preflightEpochRef = useRef(0);
  const sendOperationRef = useRef(false);
  const wallet = useSolanaWallet();

  const handleListImportingChange = useCallback((importing: boolean) => {
    listImportingRef.current = importing;
    setListImporting(importing);
  }, []);

  const resetConfirmation = useCallback(() => {
    preflightEpochRef.current += 1;
    setConfirmVisible(false);
    setPreflightState(initialDistributionPreflightState);
    setSendState(initialSendState);
  }, []);

  const handleGeneratedListChange = useCallback((result: GeneratedDistributionList) => {
    setGeneratedList(result);
    setGeneratedInput(result.output);
    resetConfirmation();
  }, [resetConfirmation]);

  const parsed = useMemo(() => parseDistribution(generatedInput), [generatedInput]);
  const selectedNetwork = useMemo(() => getNetworkConfig(networkId), [networkId]);
  const effectiveRpcEndpoint = rpcEndpoint.trim() || selectedNetwork.endpoint;
  const estimatedChunks = useMemo(() => getEstimatedTransferChunks(parsed.validRows, wallet.address), [parsed.validRows, wallet.address]);
  const transactionCount = estimatedChunks.length;
  const sending = sendState.status === "preparing" || sendState.status === "awaiting-wallet" || sendState.status === "confirming";
  const preflighting = preflightState.status === "loading";
  const preflightFailed = preflightState.status === "error";
  const sendComplete = sendState.status === "success";
  const sendFailed = sendState.status === "error";
  const unresolvedSubmission = sendFailed && sendState.signatures.length > 0;
  const controlsLocked = preflighting || sending || sendComplete || sendFailed;
  const pageControlsLocked = controlsLocked || listImporting;
  const generatedListReady = generatedList.invalid === 0 && generatedList.duplicates === 0;
  const readyToSend = wallet.connected && Boolean(wallet.provider) && generatedListReady && parsed.validRows.length > 0 && parsed.invalid === 0 && !preflighting && !sending && !sendComplete && !sendFailed && !listImporting;
  const invalidCount = parsed.invalid + generatedList.invalid;
  const duplicateCount = Math.max(parsed.duplicates, generatedList.duplicates);
  const walletBalance = balanceLookup.status === "success" && balanceLookup.valueLamports !== null
    ? formatLamportsForDisplay(balanceLookup.valueLamports)
    : balanceLookup.status === "loading"
      ? "读取中"
      : wallet.connected
        ? "--"
        : "未连接";
  const showFinalSummary = confirmVisible && sendState.status === "idle" && preflightState.status === "success";
  const confirmationStatus = sendState.status !== "idle"
    ? sendState.status
    : preflightFailed
      ? "error"
      : preflighting
        ? "preparing"
        : "idle";
  const sendButtonLabel = sending
    ? sendState.status === "confirming"
      ? "链上确认中"
      : "等待钱包确认"
    : listImporting
      ? "正在导入清单"
    : sendComplete
      ? "分发已完成"
    : sendFailed
      ? "请先核对失败结果"
    : confirmVisible
      ? "确认并签名"
      : "发送前确认";
  const readinessMessage = !wallet.connected || !wallet.provider
    ? "请先连接发送钱包"
    : listImporting
      ? "正在导入清单，请稍候"
      : generatedList.invalid > 0 || parsed.invalid > 0
        ? `请先修正 ${invalidCount} 处清单错误`
        : generatedList.duplicates > 0 || parsed.duplicates > 0
          ? `请先处理 ${duplicateCount} 个重复地址`
          : parsed.validRows.length === 0
            ? "请先添加至少 1 个有效收款地址"
            : "下一步会执行只读费用与余额预检，不会请求钱包签名";

  useEffect(() => {
    if (sending || sendComplete || sendFailed) return;
    resetConfirmation();
    // Keep an in-flight transaction locked even if the wallet changes accounts.
    // eslint/react-hooks deliberately omits `sending`: completion must not clear its result.
  }, [resetConfirmation, sendComplete, sendFailed, sending, wallet.address, wallet.connected]);

  useEffect(() => {
    if (!confirmVisible) return;
    const frame = window.requestAnimationFrame(() => confirmationRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [confirmVisible]);

  useEffect(() => {
    if (!wallet.connected || !wallet.address) {
      setBalanceLookup({
        message: "连接钱包后显示余额",
        status: "idle",
        valueLamports: null
      });
      return;
    }

    let active = true;
    setBalanceLookup({
      message: "正在读取钱包余额",
      status: "loading",
      valueLamports: null
    });

    const connection = new Connection(effectiveRpcEndpoint, "confirmed");
    void getBalanceLamports(connection, wallet.address).then((valueLamports) => {
      if (!active) return;
      setBalanceLookup({
        message: "",
        status: "success",
        valueLamports
      });
    }).catch((error) => {
      if (!active) return;
      setBalanceLookup({
        message: getBalanceLookupErrorMessage(error),
        status: "error",
        valueLamports: null
      });
    });

    return () => {
      active = false;
    };
  }, [balanceRefreshNonce, effectiveRpcEndpoint, wallet.address, wallet.connected]);

  const prepareDistribution = async () => {
    if (sendOperationRef.current || listImportingRef.current || !readyToSend || !wallet.address) return;
    sendOperationRef.current = true;
    const preflightEpoch = ++preflightEpochRef.current;
    setConfirmVisible(true);
    setPreflightState({
      ...initialDistributionPreflightState,
      message: "正在读取余额并估算全部交易手续费",
      status: "loading"
    });

    try {
      const connection = new Connection(effectiveRpcEndpoint, "confirmed");
      const latestBlockhash = await connection.getLatestBlockhash("confirmed");
      const chunks = planTransferChunks(parsed.validRows, wallet.address, latestBlockhash.blockhash);
      const transactions = chunks.map((chunk) => createTransferTransaction(wallet.address!, chunk, latestBlockhash.blockhash));
      const [estimatedFeeLamports, balanceLamports] = await Promise.all([
        estimateTransactionFeesLamports(connection, transactions),
        getBalanceLamports(connection, wallet.address)
      ]);
      if (preflightEpochRef.current !== preflightEpoch) return;

      const requiredLamports = parsed.totalLamports + estimatedFeeLamports;
      if (balanceLamports < requiredLamports) {
        setPreflightState({
          balanceLamports,
          estimatedFeeLamports,
          message: `余额不足：预计共需 ${formatLamports(requiredLamports)} SOL，当前余额 ${formatLamports(balanceLamports)} SOL`,
          requiredLamports,
          status: "error",
          transactionCount: transactions.length
        });
        return;
      }

      setBalanceLookup({ message: "", status: "success", valueLamports: balanceLamports });
      setPreflightState({
        balanceLamports,
        estimatedFeeLamports,
        message: "只读预检已通过；下方按钮才会发起钱包签名",
        requiredLamports,
        status: "success",
        transactionCount: transactions.length
      });
    } catch (error) {
      if (preflightEpochRef.current !== preflightEpoch) return;
      setPreflightState({
        ...initialDistributionPreflightState,
        message: getTransactionErrorMessage(error),
        status: "error"
      });
    } finally {
      sendOperationRef.current = false;
    }
  };

  const sendDistribution = async () => {
    if (sendOperationRef.current || listImportingRef.current || !readyToSend || !wallet.provider || !wallet.address || !showFinalSummary || sendState.status !== "idle") return;
    sendOperationRef.current = true;

    const connection = new Connection(effectiveRpcEndpoint, "confirmed");
    const sendOptions: SendOptions = {
      preflightCommitment: "confirmed",
      skipPreflight: false
    };
    const signatures: TransactionSignature[] = [];
    let signedCount = 0;
    let confirmedCount = 0;
    let plannedTransactionCount = transactionCount;

    setSendState({
      message: "正在计算最少交易数量",
      progress: createSendProgress(plannedTransactionCount),
      signatures: [],
      status: "preparing"
    });

    try {
      const latestBlockhash = await connection.getLatestBlockhash("confirmed");
      const chunks = planTransferChunks(parsed.validRows, wallet.address, latestBlockhash.blockhash);
      const transactions = chunks.map((chunk) => createTransferTransaction(wallet.address, chunk, latestBlockhash.blockhash));
      plannedTransactionCount = transactions.length;
      const progress = () => createSendProgress(plannedTransactionCount, signedCount, signatures.length, confirmedCount);

      setSendState({
        message: `已压缩为 ${transactions.length} 笔交易，正在预估手续费和检查余额`,
        progress: progress(),
        signatures: [],
        status: "preparing"
      });

      const [estimatedFeeLamports, balanceLamports] = await Promise.all([
        estimateTransactionFeesLamports(connection, transactions),
        getBalanceLamports(connection, wallet.address)
      ]);
      const requiredLamports = parsed.totalLamports + estimatedFeeLamports;

      if (balanceLamports < requiredLamports) {
        throw new Error(`钱包余额不足：本次需要约 ${formatLamports(requiredLamports)} SOL（分发 ${parsed.total} SOL + 预估手续费 ${formatLamports(estimatedFeeLamports)} SOL），当前余额 ${formatLamports(balanceLamports)} SOL`);
      }

      const canBatchSign = transactions.length > 1 && typeof wallet.provider.signAllTransactions === "function";

      setSendState({
        message: `余额预检查通过：分发 ${parsed.total} SOL，预估手续费 ${formatLamports(estimatedFeeLamports)} SOL`,
        progress: progress(),
        signatures: [],
        status: "preparing"
      });

      if (canBatchSign && wallet.provider.signAllTransactions) {
        setSendState({
          message: `请在 ${wallet.providerName} 中批量签名 ${transactions.length} 笔交易`,
          progress: progress(),
          signatures: [],
          status: "awaiting-wallet"
        });

        const signedTransactions = await wallet.provider.signAllTransactions(transactions);
        if (signedTransactions.length !== transactions.length) throw new Error("钱包返回的签名交易数量不一致");
        signedCount = signedTransactions.length;

        setSendState({
          message: `已签名 ${signedCount}/${plannedTransactionCount} 笔交易，正在提交`,
          progress: progress(),
          signatures: [],
          status: "confirming"
        });

        for (let index = 0; index < signedTransactions.length; index += 1) {
          setSendState({
            message: `已签名 ${signedCount}/${plannedTransactionCount}，正在提交第 ${index + 1}/${signedTransactions.length} 笔交易`,
            progress: progress(),
            signatures: [...signatures],
            status: "confirming"
          });

          const signature = await connection.sendRawTransaction(signedTransactions[index].serialize(), sendOptions);
          signatures.push(signature);

          setSendState({
            message: `已提交 ${signatures.length}/${plannedTransactionCount} 笔交易，等待链上确认`,
            progress: progress(),
            signatures: [...signatures],
            status: "confirming"
          });
        }

        for (let index = 0; index < signatures.length; index += 1) {
          setSendState({
            message: `已提交 ${signatures.length}/${plannedTransactionCount} 笔交易，正在确认第 ${index + 1}/${signatures.length} 笔`,
            progress: progress(),
            signatures: [...signatures],
            status: "confirming"
          });

          const confirmation = await connection.confirmTransaction({
            blockhash: latestBlockhash.blockhash,
            lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
            signature: signatures[index]
          }, "confirmed");
          if (confirmation.value.err) {
            throw new Error(`第 ${index + 1} 笔交易链上执行失败：${JSON.stringify(confirmation.value.err)}`);
          }
          confirmedCount += 1;

          setSendState({
            message: `已确认 ${confirmedCount}/${plannedTransactionCount} 笔交易`,
            progress: progress(),
            signatures: [...signatures],
            status: "confirming"
          });
        }
      } else {
        for (let index = 0; index < chunks.length; index += 1) {
          const chunk = chunks[index];
          const currentBlockhash = await connection.getLatestBlockhash("confirmed");
          const transaction = createTransferTransaction(wallet.address, chunk, currentBlockhash.blockhash);

          setSendState({
            message: `请在 ${wallet.providerName} 中签名第 ${index + 1}/${chunks.length} 笔交易`,
            progress: progress(),
            signatures: [...signatures],
            status: "awaiting-wallet"
          });

          const signature = await sendWalletTransaction(wallet.provider, transaction, connection);
          signedCount = Math.max(signedCount, index + 1);
          signatures.push(signature);

          setSendState({
            message: `第 ${index + 1}/${chunks.length} 笔交易已签名并提交，等待链上确认`,
            progress: progress(),
            signatures: [...signatures],
            status: "confirming"
          });

          const confirmation = await connection.confirmTransaction({
            blockhash: currentBlockhash.blockhash,
            lastValidBlockHeight: currentBlockhash.lastValidBlockHeight,
            signature
          }, "confirmed");
          if (confirmation.value.err) {
            throw new Error(`第 ${index + 1} 笔交易链上执行失败：${JSON.stringify(confirmation.value.err)}`);
          }
          confirmedCount += 1;

          setSendState({
            message: `已确认 ${confirmedCount}/${plannedTransactionCount} 笔交易`,
            progress: progress(),
            signatures: [...signatures],
            status: "confirming"
          });
        }
      }

      setSendState({
        message: `已完成 ${signatures.length} 笔交易确认`,
        progress: createSendProgress(plannedTransactionCount, signedCount, signatures.length, confirmedCount),
        signatures,
        status: "success"
      });
      setBalanceRefreshNonce((value) => value + 1);
    } catch (error) {
      const baseMessage = getTransactionErrorMessage(error);
      const partialMessage = signatures.length > 0
        ? `${baseMessage}。已提交 ${signatures.length}/${plannedTransactionCount || signatures.length} 笔交易，其中 ${confirmedCount} 笔已确认；请先检查链上记录，避免重复发送。`
        : baseMessage;

      setSendState({
        message: partialMessage,
        progress: createSendProgress(plannedTransactionCount, signedCount, signatures.length, confirmedCount),
        signatures,
        status: "error"
      });
    } finally {
      sendOperationRef.current = false;
    }
  };

  const handlePrimaryAction = () => {
    if (sendOperationRef.current || listImportingRef.current || !readyToSend) return;
    if (!confirmVisible) {
      void prepareDistribution();
      return;
    }
    void sendDistribution();
  };

  const startNewDistribution = () => {
    setGeneratorRevision((value) => value + 1);
    setGeneratedInput("");
    setGeneratedList(initialGeneratedList);
    resetConfirmation();
  };

  const activeStep = !confirmVisible ? 0 : sendState.status === "idle" ? 1 : 2;
  const stepStates: ToolPageStepState[] | undefined = sendComplete
    ? ["complete", "complete", "complete"]
    : sendFailed
      ? ["complete", "complete", "error"]
      : preflightFailed
        ? ["complete", "error", "upcoming"]
        : undefined;

  return (
    <ToolPageLayout
      activeStep={activeStep}
      categoryHref="/#distribution"
      categoryLabel="批量发送"
      currentToolId="sol-distribution"
      description="从一个已连接的钱包向多地址分发 SOL；先生成清单和费用预览，再统一确认签名。"
      eyebrow="One to many · Solana"
      mainClassName="page-distributor"
      meta={<><span className="pill network-pill">{selectedNetwork.label}</span><span className="pill">钱包签名</span></>}
      stepStates={stepStates}
      steps={solDistributionSteps}
      title="SOL 批量分发"
    >
        <section className="workspace batch-workspace">
          <section className="panel input-panel" aria-labelledby="list-title">
            <div className="panel-header">
              <div>
                <h2 className="panel-title" id="list-title">Solana 分发清单</h2>
              </div>
              <span className="pill network-pill">{selectedNetwork.label}</span>
            </div>

            <div className="form">
              <WalletConnectionControl disabled={pageControlsLocked} wallet={wallet} />

              {initialDistribution.hasMixedAmounts ? (
                <div className="notice compact-notice">
                  <strong>旧清单金额未导入</strong>
                  <span>已保留收款地址，请重新设置统一金额或随机区间。</span>
                </div>
              ) : null}

              <div className="transaction-options compact-route" aria-label="链路配置">
                <div className="route-fields sol-route-fields">
                  <div className="field route-card network-field">
                    <label htmlFor="networkId">网络选择</label>
                    <SearchableSelect
                      disabled={pageControlsLocked}
                      emptyMessage="未找到匹配的 Solana 网络"
                      id="networkId"
                      listboxLabel="Solana 网络"
                      metaLabel="网络标识"
                      metaPrefix="Cluster"
                      onChange={(nextNetworkId) => {
                        setNetworkId(nextNetworkId);
                        setRpcEndpoint(getNetworkConfig(nextNetworkId).endpoint);
                        resetConfirmation();
                      }}
                      options={solanaNetworkOptions}
                      searchable={false}
                      value={networkId}
                    />
                  </div>
                  <div className="field route-card rpc-field">
                    <label htmlFor="rpcEndpoint">RPC</label>
                    <input disabled={pageControlsLocked} id="rpcEndpoint" type="url" value={rpcEndpoint} onChange={(event) => {
                      setRpcEndpoint(event.target.value);
                      resetConfirmation();
                    }} />
                  </div>
                  <div className={`route-card route-summary ${balanceLookup.status}`} title={balanceLookup.message || undefined}>
                    <div>
                      <span>余额</span>
                      <span className="route-summary-value">
                        <strong>{walletBalance}</strong>
                        <small>{balanceLookup.status === "error" ? "读取失败" : "SOL"}</small>
                      </span>
                    </div>
                    <div>
                      <span>交易数</span>
                      <span className="route-summary-value">
                        <strong>{transactionCount || 0}</strong>
                        <small>笔</small>
                      </span>
                    </div>
                  </div>
                </div>
              </div>
              {balanceLookup.status === "error" ? (
                <div className="notice compact-notice" role="alert">
                  <strong>未能读取钱包余额</strong>
                  <span>{balanceLookup.message}</span>
                  <div className="action-group">
                    <button className="button ghost" type="button" onClick={() => setBalanceRefreshNonce((value) => value + 1)}>重试读取</button>
                  </div>
                </div>
              ) : null}

              <DistributionListGenerator
                key={`sol-distribution-${generatorRevision}`}
                addressKind="solana"
                decimals={9}
                disabled={controlsLocked}
                initialAddresses={generatorRevision === 0 ? initialDistribution.addresses : ""}
                initialFixedAmount={generatorRevision === 0 && initialDistribution.hadAmounts ? initialDistribution.fixedAmount : "0.1"}
                onDirty={resetConfirmation}
                onImportingChange={handleListImportingChange}
                onResultChange={handleGeneratedListChange}
                symbol="SOL"
              />
              {!confirmVisible ? <div className="actions">
                <p className="hint" role="status">{readinessMessage}</p>
                <div className="action-group">
                  <button className="button primary" type="button" disabled={!readyToSend} onClick={handlePrimaryAction}>{sendButtonLabel}</button>
                </div>
              </div> : null}
            </div>

            <div className="stats" aria-label="分发统计">
              <Metric value={String(parsed.validRows.length)} label="有效收款地址" />
              <Metric value={parsed.total} label="合计 SOL" />
              <Metric value={String(invalidCount)} label="需修正" />
              <Metric value={String(duplicateCount)} label="重复地址" />
            </div>
          </section>

          <aside className="panel review-panel" aria-labelledby="review-title">
            <div className="panel-header">
              <div>
                <h2 className="panel-title" id="review-title">发送前检查</h2>
              </div>
            </div>
            <div className="form">
              <DistributionReview rows={parsed.rows} />
              {confirmVisible ? (
                <div
                  aria-live={sendFailed || preflightFailed ? "assertive" : "polite"}
                  className={`confirm transaction-status ${confirmationStatus}`}
                  ref={confirmationRef}
                  role={sendFailed || preflightFailed ? "alert" : "status"}
                  tabIndex={-1}
                >
                  <strong>{showFinalSummary
                    ? "最终确认摘要"
                    : preflighting
                      ? "正在进行只读预检"
                      : preflightFailed && sendState.status === "idle"
                        ? "预检未通过"
                        : sendState.status === "success"
                          ? "分发交易已确认"
                          : sendState.status === "error"
                            ? "分发交易未完成"
                            : `准备向 ${parsed.validRows.length} 个地址分发`}</strong>
                  {showFinalSummary ? (
                    <div className="summary-list">
                      <div><span>网络选择</span><strong>{selectedNetwork.label}</strong></div>
                      <div><span>RPC</span><strong>{effectiveRpcEndpoint}</strong></div>
                      <div><span>收款人数</span><strong>{parsed.validRows.length}</strong></div>
                      <div><span>总额</span><strong>{parsed.total} SOL</strong></div>
                      <div><span>预估手续费</span><strong>{formatLamports(preflightState.estimatedFeeLamports || 0n)} SOL</strong></div>
                      <div><span>预计总扣款</span><strong>{formatLamports(preflightState.requiredLamports || parsed.totalLamports)} SOL</strong></div>
                      <div><span>钱包余额</span><strong>{formatLamports(preflightState.balanceLamports || 0n)} SOL</strong></div>
                      <div><span>预计交易数</span><strong>{preflightState.transactionCount}</strong></div>
                      <div><span>前 3 个地址</span><strong>{parsed.validRows.slice(0, 3).map((row) => shortenAddress(row.address)).join(" / ")}</strong></div>
                    </div>
                  ) : (
                    <span>{sendState.status === "idle"
                      ? preflightState.message
                      : sendState.message || `合计 ${parsed.total} SOL，网络 ${selectedNetwork.label}，共 ${transactionCount || 0} 笔交易。`}</span>
                  )}
                  {!showFinalSummary && sendState.progress.total > 0 ? (
                    <div className="send-progress" aria-label="发送进度">
                      <span>已签名 {sendState.progress.signed}/{sendState.progress.total}</span>
                      <span>已提交 {sendState.progress.submitted}/{sendState.progress.total}</span>
                      <span>已确认 {sendState.progress.confirmed}/{sendState.progress.total}</span>
                    </div>
                  ) : null}
                  {sendState.signatures.length > 0 ? (
                    <div className="signature-list">
                      {sendState.signatures.map((signature, index) => (
                        <a key={signature} href={getExplorerUrl(signature, networkId)} target="_blank" rel="noreferrer">
                          交易 {index + 1}: {shortenAddress(signature)}
                        </a>
                      ))}
                    </div>
                  ) : null}
                  <div className="actions confirmation-actions">
                    <div className="action-group">
                      {showFinalSummary ? (
                        <>
                          <button className="button primary" type="button" disabled={!readyToSend} onClick={handlePrimaryAction}>确认并签名</button>
                          <button className="button ghost" type="button" onClick={resetConfirmation}>返回修改</button>
                        </>
                      ) : null}
                      {preflighting ? (
                        <button className="button primary" type="button" disabled>正在只读预检</button>
                      ) : null}
                      {preflightFailed && sendState.status === "idle" ? (
                        <>
                          <button className="button primary" type="button" onClick={() => void prepareDistribution()}>重新预检</button>
                          <button className="button ghost" type="button" onClick={resetConfirmation}>返回修改</button>
                        </>
                      ) : null}
                      {sendFailed && !unresolvedSubmission ? (
                        <button className="button ghost" type="button" onClick={resetConfirmation}>返回修改并重新预检</button>
                      ) : null}
                      {sendComplete || unresolvedSubmission ? (
                        <button className="button danger" type="button" onClick={startNewDistribution}>清空清单并开始新任务</button>
                      ) : null}
                    </div>
                    {unresolvedSubmission ? (
                      <p className="hint">已有交易提交到链上。为避免重复转账，当前清单不可直接重试；请先核对上方交易记录，再创建空白任务。</p>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          </aside>
        </section>
    </ToolPageLayout>
  );
}
