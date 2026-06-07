import { useEffect, useMemo, useState } from "react";
import { BrandHeader, NavLinks, SkipLink } from "../components/BrandHeader";
import { DistributionReview } from "../components/DistributionReview";
import { Metric } from "../components/Metric";
import { WalletConnectionControl } from "../components/WalletConnectionControl";
import { useSolanaWallet } from "../hooks/useSolanaWallet";
import { shortenAddress } from "../lib/address";
import { formatLamports, formatLamportsForDisplay } from "../lib/amount";
import { getInitialDistributionInput, parseDistribution } from "../lib/distribution";
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

const initialBalanceLookupState: BalanceLookupState = {
  message: "",
  status: "idle",
  valueLamports: null
};

function getBalanceLookupErrorMessage(error: unknown) {
  const detail = error && typeof error === "object" && "message" in error ? String((error as { message?: unknown }).message || "") : String(error || "");

  if (/403|429|failed to fetch|network|fetch|timeout/i.test(detail)) return "余额读取失败，请更换 RPC 后重试";
  return detail ? `余额读取失败：${detail}` : "余额读取失败，请稍后重试";
}

export function BatchDistributorPage() {
  const [input, setInput] = useState(() => getInitialDistributionInput());
  const [confirmVisible, setConfirmVisible] = useState(false);
  const [networkId, setNetworkId] = useState<SolanaNetworkId>("mainnet-beta");
  const [rpcEndpoint, setRpcEndpoint] = useState(getNetworkConfig("mainnet-beta").endpoint);
  const [sendState, setSendState] = useState(initialSendState);
  const [balanceLookup, setBalanceLookup] = useState<BalanceLookupState>(initialBalanceLookupState);
  const [balanceRefreshNonce, setBalanceRefreshNonce] = useState(0);
  const wallet = useSolanaWallet();

  const parsed = useMemo(() => parseDistribution(input), [input]);
  const selectedNetwork = useMemo(() => getNetworkConfig(networkId), [networkId]);
  const effectiveRpcEndpoint = rpcEndpoint.trim() || selectedNetwork.endpoint;
  const estimatedChunks = useMemo(() => getEstimatedTransferChunks(parsed.validRows, wallet.address), [parsed.validRows, wallet.address]);
  const transactionCount = estimatedChunks.length;
  const sending = sendState.status === "preparing" || sendState.status === "awaiting-wallet" || sendState.status === "confirming";
  const readyToSend = wallet.connected && Boolean(wallet.provider) && parsed.validRows.length > 0 && parsed.invalid === 0 && !sending;
  const walletBalance = balanceLookup.status === "success" && balanceLookup.valueLamports !== null
    ? formatLamportsForDisplay(balanceLookup.valueLamports)
    : balanceLookup.status === "loading"
      ? "读取中"
      : wallet.connected
        ? "--"
        : "未连接";
  const showFinalSummary = confirmVisible && sendState.status === "idle";
  const sendButtonLabel = sending
    ? sendState.status === "confirming"
      ? "链上确认中"
      : "等待钱包确认"
    : confirmVisible
      ? "确认并签名"
      : "发送前确认";

  const resetConfirmation = () => {
    setConfirmVisible(false);
    setSendState(initialSendState);
  };

  useEffect(() => {
    resetConfirmation();
  }, [wallet.address, wallet.connected]);

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

  const sendDistribution = async () => {
    if (!readyToSend || !wallet.provider || !wallet.address || !confirmVisible) return;

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

          await connection.confirmTransaction({
            blockhash: latestBlockhash.blockhash,
            lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
            signature: signatures[index]
          }, "confirmed");
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

          await connection.confirmTransaction({
            blockhash: currentBlockhash.blockhash,
            lastValidBlockHeight: currentBlockhash.lastValidBlockHeight,
            signature
          }, "confirmed");
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
    }
  };

  const handlePrimaryAction = () => {
    if (!readyToSend) return;
    if (!confirmVisible) {
      setConfirmVisible(true);
      setSendState(initialSendState);
      return;
    }
    void sendDistribution();
  };

  return (
    <>
      <SkipLink />
      <main className="shell tool-shell page-distributor" id="main">
        <BrandHeader
          eyebrow="solana distributor"
          title="Solana 批量分发"
          subtitle="粘贴 `Solana地址,金额` 格式，先校验总额、重复项和金额，再连接 Solana 钱包进入确认。"
          nav={<NavLinks current="distributor" />}
        />

        <section className="workspace batch-workspace">
          <section className="panel input-panel" aria-labelledby="list-title">
            <div className="panel-header">
              <div>
                <h2 className="panel-title" id="list-title">Solana 分发清单</h2>
                <p className="panel-note">每行必须是 `地址,金额`，金额单位固定为 SOL。</p>
              </div>
              <span className="pill network-pill">{selectedNetwork.label}</span>
            </div>

            <div className="form">
              <div className="batch-command">
                <div className="command-copy">
                  <span className="eyebrow">wallet gate</span>
                  <strong>{wallet.connected ? "钱包已连接" : wallet.status === "connecting" ? "等待钱包确认" : "连接 Solana 钱包"}</strong>
                  <span>{wallet.connected ? wallet.statusText : wallet.message || "连接后会解锁确认分发。"}</span>
                </div>
                <WalletConnectionControl wallet={wallet} />
              </div>

              <div className="transaction-options compact-route" aria-label="链路配置">
                <div className="route-fields sol-route-fields">
                  <div className="field route-card network-field">
                    <label htmlFor="networkId">网络选择</label>
                    <select id="networkId" value={networkId} onChange={(event) => {
                      const nextNetworkId = event.target.value as SolanaNetworkId;
                      setNetworkId(nextNetworkId);
                      setRpcEndpoint(getNetworkConfig(nextNetworkId).endpoint);
                      resetConfirmation();
                    }}>
                      {solanaNetworks.map((network) => (
                        <option key={network.id} value={network.id}>{network.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="field route-card rpc-field">
                    <label htmlFor="rpcEndpoint">RPC</label>
                    <input id="rpcEndpoint" type="url" value={rpcEndpoint} onChange={(event) => {
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

              <div className="field">
                <label htmlFor="distributionInput">地址,金额</label>
                <p className="hint">示例：7hQm...SxyQ,0.1。逗号前后有空格也可以，当前单位：SOL。</p>
                <textarea
                  id="distributionInput"
                  spellCheck={false}
                  value={input}
                  onChange={(event) => {
                    setInput(event.target.value);
                    resetConfirmation();
                  }}
                  placeholder={"7hQmJpYvKq2ms2uUpu2f4pCmJfM7m2HJ9dXkR4g3SxyQ,0.1\n9YcQwQ6kR4pYc5v2yAf9hWeXvX5gK2oA9rRk2mL3pZqE,0.1"}
                />
              </div>
              <div className="actions">
                <div className="action-group">
                  <button className="button primary" type="button" disabled={!readyToSend} onClick={handlePrimaryAction}>{sendButtonLabel}</button>
                  {showFinalSummary ? (
                    <button className="button ghost" type="button" onClick={resetConfirmation}>返回修改</button>
                  ) : null}
                  <button className="button danger" type="button" onClick={() => {
                    setInput("");
                    resetConfirmation();
                  }}>清空</button>
                </div>
              </div>
            </div>

            <div className="stats" aria-label="分发统计">
              <Metric value={String(parsed.validRows.length)} label="有效收款地址" />
              <Metric value={parsed.total} label="合计 SOL" />
              <Metric value={String(parsed.invalid)} label="需修正" />
              <Metric value={String(parsed.duplicates)} label="重复地址" />
            </div>
          </section>

          <aside className="panel review-panel" aria-labelledby="review-title">
            <div className="panel-header">
              <div>
                <h2 className="panel-title" id="review-title">发送前检查</h2>
                <p className="panel-note">只在没有错误且钱包已连接时允许确认分发。</p>
              </div>
            </div>
            <div className="form">
              <DistributionReview rows={parsed.rows} />
              {confirmVisible ? (
                <div className={`confirm transaction-status ${sendState.status}`}>
                  <strong>{showFinalSummary ? "最终确认摘要" : sendState.status === "success" ? "分发交易已确认" : sendState.status === "error" ? "分发交易未完成" : `准备向 ${parsed.validRows.length} 个地址分发`}</strong>
                  {showFinalSummary ? (
                    <div className="summary-list">
                      <div><span>网络选择</span><strong>{selectedNetwork.label}</strong></div>
                      <div><span>RPC</span><strong>{effectiveRpcEndpoint}</strong></div>
                      <div><span>收款人数</span><strong>{parsed.validRows.length}</strong></div>
                      <div><span>总额</span><strong>{parsed.total} SOL</strong></div>
                      <div><span>预计交易数</span><strong>{transactionCount || 0}</strong></div>
                      <div><span>前 3 个地址</span><strong>{parsed.validRows.slice(0, 3).map((row) => shortenAddress(row.address)).join(" / ")}</strong></div>
                    </div>
                  ) : (
                    <span>{sendState.message || `合计 ${parsed.total} SOL，网络 ${selectedNetwork.label}，共 ${transactionCount || 0} 笔交易。`}</span>
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
                </div>
              ) : null}
            </div>
          </aside>
        </section>
      </main>
    </>
  );
}
