import { useEffect, useMemo, useState } from "react";
import { BrandHeader, NavLinks, SkipLink } from "../components/BrandHeader";
import { DistributionReview } from "../components/DistributionReview";
import { EvmWalletConnectionControl } from "../components/EvmWalletConnectionControl";
import { Metric } from "../components/Metric";
import { useEvmWallet } from "../hooks/useEvmWallet";
import { shortenAddress } from "../lib/address";
import { getInitialDistributionInput, type DistributionRow } from "../lib/distribution";
import {
  ensureEvmNetwork,
  evmNetworks,
  formatWei,
  getEvmExplorerUrl,
  getEvmNetworkConfig,
  getEvmTransactionErrorMessage,
  parseEvmDistribution,
  sendEvmNativeDistribution,
  type EvmNetworkId
} from "../lib/evm";
import { createSendProgress, initialSendState } from "../lib/solana";

export function EvmBatchDistributorPage() {
  const [input, setInput] = useState(() => getInitialDistributionInput());
  const [confirmVisible, setConfirmVisible] = useState(false);
  const [networkId, setNetworkId] = useState<EvmNetworkId>("ethereum");
  const [rpcEndpoint, setRpcEndpoint] = useState(getEvmNetworkConfig("ethereum").rpcEndpoint);
  const [sendState, setSendState] = useState(initialSendState);
  const wallet = useEvmWallet();

  const selectedNetwork = useMemo(() => getEvmNetworkConfig(networkId), [networkId]);
  const effectiveRpcEndpoint = rpcEndpoint.trim() || selectedNetwork.rpcEndpoint;
  const parsed = useMemo(() => parseEvmDistribution(input, selectedNetwork.nativeCurrency.decimals), [input, selectedNetwork.nativeCurrency.decimals]);
  const reviewRows = useMemo<DistributionRow[]>(() => parsed.rows.map((row) => ({
    address: row.address,
    amount: Number(row.amountRaw),
    amountRaw: row.amountRaw,
    lamports: row.valueWei,
    line: row.line,
    problems: row.problems,
    status: row.status
  })), [parsed.rows]);
  const sending = sendState.status === "preparing" || sendState.status === "awaiting-wallet" || sendState.status === "confirming";
  const readyToSend = wallet.connected && Boolean(wallet.getProvider()) && parsed.validRows.length > 0 && parsed.invalid === 0 && !sending;
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

  const sendDistribution = async () => {
    const walletProvider = wallet.getProvider();
    if (!readyToSend || !walletProvider || !wallet.address || !confirmVisible) return;

    setSendState({
      message: "正在检查 EVM 网络和余额",
      progress: createSendProgress(1),
      signatures: [],
      status: "preparing"
    });

    try {
      await ensureEvmNetwork(walletProvider, selectedNetwork, effectiveRpcEndpoint);

      setSendState({
        message: `请在 EVM 钱包中确认 ${selectedNetwork.label} 分发交易`,
        progress: createSendProgress(1),
        signatures: [],
        status: "awaiting-wallet"
      });

      const { hash } = await sendEvmNativeDistribution({
        from: wallet.address,
        network: selectedNetwork,
        provider: walletProvider,
        rows: parsed.validRows,
        rpcEndpoint: effectiveRpcEndpoint
      });

      setSendState({
        message: "交易已提交，等待链上确认",
        progress: createSendProgress(1, 1, 1, 0),
        signatures: [hash],
        status: "confirming"
      });

      setSendState({
        message: "EVM 分发交易已确认",
        progress: createSendProgress(1, 1, 1, 1),
        signatures: [hash],
        status: "success"
      });
    } catch (error) {
      setSendState({
        message: getEvmTransactionErrorMessage(error),
        progress: createSendProgress(1),
        signatures: [],
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
          eyebrow="evm distributor"
          title="EVM 原生币批量分发"
          subtitle="粘贴 `EVM地址,金额` 格式，先校验总额、重复项和金额，再连接 EVM 钱包进入确认。"
          nav={<NavLinks current="evmDistributor" />}
        />

        <section className="workspace batch-workspace">
          <section className="panel input-panel" aria-labelledby="list-title">
            <div className="panel-header">
              <div>
                <h2 className="panel-title" id="list-title">EVM 分发清单</h2>
                <p className="panel-note">每行必须是 `地址,金额`，金额单位按当前网络原生币处理。</p>
              </div>
              <span className="pill network-pill">{selectedNetwork.label}</span>
            </div>

            <div className="form">
              <div className="batch-command">
                <div className="command-copy">
                  <span className="eyebrow">wallet gate</span>
                  <strong>{wallet.connected ? "钱包已连接" : wallet.status === "connecting" ? "等待钱包确认" : "连接 EVM 钱包"}</strong>
                  <span>{wallet.connected ? wallet.statusText : wallet.message || "连接后会解锁确认分发。"}</span>
                </div>
                <EvmWalletConnectionControl wallet={wallet} />
              </div>

              <div className="transaction-options compact-route" aria-label="链路配置">
                <div className="route-fields evm-route-fields">
                  <div className="field route-card network-field">
                    <label htmlFor="networkId">网络选择</label>
                    <select id="networkId" value={networkId} onChange={(event) => {
                      const nextNetworkId = event.target.value as EvmNetworkId;
                      setNetworkId(nextNetworkId);
                      setRpcEndpoint(getEvmNetworkConfig(nextNetworkId).rpcEndpoint);
                      resetConfirmation();
                    }}>
                      {evmNetworks.map((network) => (
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
                </div>
              </div>

              <div className="field">
                <label htmlFor="distributionInput">地址,金额</label>
                <p className="hint">示例：0x742d35Cc6634C0532925a3b844Bc454e4438f44e,0.1。当前单位：{selectedNetwork.nativeCurrency.symbol}。</p>
                <textarea
                  id="distributionInput"
                  spellCheck={false}
                  value={input}
                  onChange={(event) => {
                    setInput(event.target.value);
                    resetConfirmation();
                  }}
                  placeholder={"0x0000000000000000000000000000000000000001,0.1\n0x0000000000000000000000000000000000000002,0.2"}
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
              <Metric value={parsed.total} label={`合计 ${selectedNetwork.nativeCurrency.symbol}`} />
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
              <DistributionReview
                rows={reviewRows}
                formatAmount={(row) => `${formatWei(row.lamports, selectedNetwork.nativeCurrency.decimals)} ${selectedNetwork.nativeCurrency.symbol}`}
              />
              {confirmVisible ? (
                <div className={`confirm transaction-status ${sendState.status}`}>
                  <strong>{showFinalSummary ? "最终确认摘要" : sendState.status === "success" ? "分发交易已确认" : sendState.status === "error" ? "分发交易未完成" : `准备向 ${parsed.validRows.length} 个地址分发`}</strong>
                  {showFinalSummary ? (
                    <div className="summary-list">
                      <div><span>网络选择</span><strong>{selectedNetwork.label}</strong></div>
                      <div><span>RPC</span><strong>{effectiveRpcEndpoint}</strong></div>
                      <div><span>收款人数</span><strong>{parsed.validRows.length}</strong></div>
                      <div><span>总额</span><strong>{parsed.total} {selectedNetwork.nativeCurrency.symbol}</strong></div>
                      <div><span>前 3 个地址</span><strong>{parsed.validRows.slice(0, 3).map((row) => shortenAddress(row.address)).join(" / ")}</strong></div>
                    </div>
                  ) : (
                    <span>{sendState.message || `合计 ${parsed.total} ${selectedNetwork.nativeCurrency.symbol}，网络 ${selectedNetwork.label}。`}</span>
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
                        <a key={signature} href={getEvmExplorerUrl(signature, selectedNetwork)} target="_blank" rel="noreferrer">
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
