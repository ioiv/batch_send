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
  formatWeiForDisplay,
  getEvmAssetSymbol,
  getEvmBalanceLookupErrorMessage,
  getEvmExplorerUrl,
  getEvmNativeBalance,
  getEvmNetworkConfig,
  getEvmTokenBalance,
  getEvmTokenDetails,
  getEvmTokenLookupErrorMessage,
  getEvmTransactionErrorMessage,
  isValidEvmAddress,
  parseEvmDistribution,
  sendEvmNativeDistribution,
  sendEvmTokenDistribution,
  type EvmAssetMode,
  type EvmNetworkId,
  type EvmTokenDetails,
  type EvmTokenDistributionStep
} from "../lib/evm";
import { createSendProgress, initialSendState } from "../lib/solana";

type TokenLookupState = {
  details: EvmTokenDetails | null;
  message: string;
  status: "idle" | "loading" | "success" | "error";
};

type BalanceLookupState = {
  message: string;
  status: "idle" | "loading" | "success" | "error";
  valueWei: bigint | null;
};

const initialTokenLookupState: TokenLookupState = {
  details: null,
  message: "",
  status: "idle"
};

const initialBalanceLookupState: BalanceLookupState = {
  message: "",
  status: "idle",
  valueWei: null
};

export function EvmBatchDistributorPage() {
  const [input, setInput] = useState(() => getInitialDistributionInput());
  const [assetMode, setAssetMode] = useState<EvmAssetMode>("native");
  const [confirmVisible, setConfirmVisible] = useState(false);
  const [networkId, setNetworkId] = useState<EvmNetworkId>("ethereum");
  const [rpcEndpoint, setRpcEndpoint] = useState(getEvmNetworkConfig("ethereum").rpcEndpoint);
  const [sendState, setSendState] = useState(initialSendState);
  const [tokenAddress, setTokenAddress] = useState("");
  const [tokenLookup, setTokenLookup] = useState<TokenLookupState>(initialTokenLookupState);
  const [nativeBalanceLookup, setNativeBalanceLookup] = useState<BalanceLookupState>(initialBalanceLookupState);
  const [tokenBalanceLookup, setTokenBalanceLookup] = useState<BalanceLookupState>(initialBalanceLookupState);
  const [balanceRefreshNonce, setBalanceRefreshNonce] = useState(0);
  const wallet = useEvmWallet();

  const selectedNetwork = useMemo(() => getEvmNetworkConfig(networkId), [networkId]);
  const effectiveRpcEndpoint = rpcEndpoint.trim() || selectedNetwork.rpcEndpoint;
  const tokenDetails = assetMode === "token" ? tokenLookup.details : null;
  const assetDecimals = assetMode === "token" ? tokenDetails?.decimals ?? selectedNetwork.nativeCurrency.decimals : selectedNetwork.nativeCurrency.decimals;
  const assetSymbol = getEvmAssetSymbol(assetMode, selectedNetwork, tokenDetails);
  const tokenAddressInput = tokenAddress.trim();
  const parsed = useMemo(() => parseEvmDistribution(input, assetDecimals), [input, assetDecimals]);
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
  const assetReady = assetMode === "native" || (tokenLookup.status === "success" && Boolean(tokenDetails));
  const readyToSend = wallet.connected && Boolean(wallet.getProvider()) && assetReady && parsed.validRows.length > 0 && parsed.invalid === 0 && !sending;
  const nativeBalance = nativeBalanceLookup.status === "success" && nativeBalanceLookup.valueWei !== null
    ? formatWeiForDisplay(nativeBalanceLookup.valueWei, selectedNetwork.nativeCurrency.decimals)
    : nativeBalanceLookup.status === "loading"
      ? "读取中"
      : wallet.connected
        ? "--"
        : "未连接";
  const nativeBalanceDescription = nativeBalanceLookup.status === "success"
    ? nativeBalance
    : nativeBalanceLookup.status === "loading"
      ? "读取中"
      : nativeBalanceLookup.status === "error"
        ? "读取失败"
        : "";
  const tokenBalance = tokenBalanceLookup.status === "success" && tokenBalanceLookup.valueWei !== null
    ? formatWeiForDisplay(tokenBalanceLookup.valueWei, tokenDetails?.decimals ?? assetDecimals)
    : tokenBalanceLookup.status === "loading"
      ? "读取中"
      : wallet.connected
        ? "--"
        : "未连接";
  const hasPendingTokenAddress = assetMode === "token" && Boolean(tokenAddressInput) && !tokenDetails;
  const tokenBalanceDescription = tokenDetails
    ? tokenBalanceLookup.status === "success"
      ? tokenBalance
      : tokenBalanceLookup.status === "loading"
        ? "读取中"
        : tokenBalanceLookup.status === "error"
          ? "读取失败"
          : ""
    : hasPendingTokenAddress && tokenLookup.status === "loading"
      ? "识别中"
      : hasPendingTokenAddress
        ? "未识别 Token"
        : "";
  const tokenBalanceStatus = hasPendingTokenAddress && tokenLookup.status !== "loading"
    ? "error"
    : hasPendingTokenAddress && tokenLookup.status === "loading"
      ? "loading"
    : tokenLookup.status === "error"
      ? "error"
      : tokenBalanceLookup.status === "error"
      ? "error"
      : tokenBalanceLookup.status === "loading"
        ? "loading"
        : "";
  const tokenBalanceHint = hasPendingTokenAddress
    ? tokenLookup.message || "未识别出 ERC20 Token，请确认合约地址和网络是否匹配"
    : tokenBalanceLookup.message;
  const tokenBalanceClassName = `asset-mode-balance${tokenBalanceStatus ? ` ${tokenBalanceStatus}` : ""}`;
  const showFinalSummary = confirmVisible && sendState.status === "idle";
  const sendButtonLabel = sending
    ? sendState.status === "preparing"
      ? "准备中"
      : sendState.status === "confirming"
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
    if (assetMode !== "token") {
      setTokenLookup(initialTokenLookupState);
      return;
    }

    if (!tokenAddressInput) {
      setTokenLookup(initialTokenLookupState);
      return;
    }

    if (!isValidEvmAddress(tokenAddressInput)) {
      setTokenLookup({
        details: null,
        message: "Token 地址格式不正确",
        status: "error"
      });
      return;
    }

    let active = true;
    setTokenLookup({
      details: null,
      message: "正在读取 Token 信息",
      status: "loading"
    });

    void getEvmTokenDetails({
      network: selectedNetwork,
      rpcEndpoint: effectiveRpcEndpoint,
      tokenAddress: tokenAddressInput
    }).then((details) => {
      if (!active) return;
      setTokenLookup({
        details,
        message: `${details.name} · ${details.decimals} decimals`,
        status: "success"
      });
    }).catch((error) => {
      if (!active) return;
      setTokenLookup({
        details: null,
        message: getEvmTokenLookupErrorMessage(error),
        status: "error"
      });
    });

    return () => {
      active = false;
    };
  }, [assetMode, effectiveRpcEndpoint, selectedNetwork, tokenAddressInput]);

  useEffect(() => {
    if (!wallet.connected || !wallet.address) {
      setNativeBalanceLookup({
        message: "连接钱包后显示余额",
        status: "idle",
        valueWei: null
      });
      return;
    }

    let active = true;
    setNativeBalanceLookup({
      message: "正在读取钱包余额",
      status: "loading",
      valueWei: null
    });

    void getEvmNativeBalance({
      address: wallet.address,
      network: selectedNetwork,
      rpcEndpoint: effectiveRpcEndpoint
    }).then((valueWei) => {
      if (!active) return;
      setNativeBalanceLookup({
        message: "",
        status: "success",
        valueWei
      });
    }).catch((error) => {
      if (!active) return;
      setNativeBalanceLookup({
        message: getEvmBalanceLookupErrorMessage(error),
        status: "error",
        valueWei: null
      });
    });

    return () => {
      active = false;
    };
  }, [balanceRefreshNonce, effectiveRpcEndpoint, selectedNetwork, wallet.address, wallet.connected]);

  useEffect(() => {
    if (!wallet.connected || !wallet.address) {
      setTokenBalanceLookup({
        message: "连接钱包后显示余额",
        status: "idle",
        valueWei: null
      });
      return;
    }

    if (!tokenDetails) {
      setTokenBalanceLookup({
        message: "Token 信息读取成功后显示余额",
        status: "idle",
        valueWei: null
      });
      return;
    }

    let active = true;
    setTokenBalanceLookup({
      message: "正在读取 Token 余额",
      status: "loading",
      valueWei: null
    });

    void getEvmTokenBalance({
      address: wallet.address,
      network: selectedNetwork,
      rpcEndpoint: effectiveRpcEndpoint,
      tokenAddress: tokenDetails.address
    }).then((valueWei) => {
      if (!active) return;
      setTokenBalanceLookup({
        message: "",
        status: "success",
        valueWei
      });
    }).catch((error) => {
      if (!active) return;
      setTokenBalanceLookup({
        message: getEvmBalanceLookupErrorMessage(error),
        status: "error",
        valueWei: null
      });
    });

    return () => {
      active = false;
    };
  }, [balanceRefreshNonce, effectiveRpcEndpoint, selectedNetwork, tokenDetails, wallet.address, wallet.connected]);

  const handleTokenStep = (step: EvmTokenDistributionStep) => {
    if (step.type === "allowance-checked") {
      setSendState({
        message: step.needsApproval
          ? `请先授权 ${parsed.total} ${assetSymbol} 给分发合约`
          : `Token 授权充足，请在钱包中确认 ${assetSymbol} 分发交易`,
        progress: createSendProgress(step.totalTransactions),
        signatures: [],
        status: "awaiting-wallet"
      });
      return;
    }

    if (step.type === "approval-submitted") {
      setSendState({
        message: "Token 授权已提交，等待链上确认",
        progress: createSendProgress(step.totalTransactions, 1, 1, 0),
        signatures: [step.hash],
        status: "confirming"
      });
      return;
    }

    if (step.type === "approval-confirmed") {
      setSendState({
        message: "Token 授权已确认，请在钱包中确认分发交易",
        progress: createSendProgress(step.totalTransactions, 1, 1, 1),
        signatures: [step.hash],
        status: "awaiting-wallet"
      });
      return;
    }

    if (step.type === "distribution-submitted") {
      const previouslyConfirmed = step.totalTransactions === 2 ? 1 : 0;
      setSendState({
        message: "Token 分发交易已提交，等待链上确认",
        progress: createSendProgress(step.totalTransactions, step.totalTransactions, step.totalTransactions, previouslyConfirmed),
        signatures: step.hashes,
        status: "confirming"
      });
      return;
    }

    setSendState({
      message: "Token 分发交易已确认",
      progress: createSendProgress(step.totalTransactions, step.totalTransactions, step.totalTransactions, step.totalTransactions),
      signatures: step.hashes,
      status: "success"
    });
  };

  const sendDistribution = async () => {
    const walletProvider = wallet.getProvider();
    if (!readyToSend || !walletProvider || !wallet.address || !confirmVisible) return;

    setSendState({
      message: `正在检查 ${assetSymbol} 网络和余额`,
      progress: createSendProgress(1),
      signatures: [],
      status: "preparing"
    });

    try {
      await ensureEvmNetwork(walletProvider, selectedNetwork, effectiveRpcEndpoint);

      setSendState({
        message: `请在 EVM 钱包中确认 ${selectedNetwork.label} ${assetSymbol} 分发交易`,
        progress: createSendProgress(1),
        signatures: [],
        status: "awaiting-wallet"
      });

      if (assetMode === "token") {
        if (!tokenDetails) throw new Error("请先填写并读取 ERC20 Token 合约地址");

        const { hashes } = await sendEvmTokenDistribution({
          from: wallet.address,
          network: selectedNetwork,
          onStep: handleTokenStep,
          provider: walletProvider,
          rows: parsed.validRows,
          rpcEndpoint: effectiveRpcEndpoint,
          token: tokenDetails
        });

        setSendState({
          message: "Token 分发交易已确认",
          progress: createSendProgress(hashes.length, hashes.length, hashes.length, hashes.length),
          signatures: hashes,
          status: "success"
        });
        setBalanceRefreshNonce((value) => value + 1);
        return;
      }

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
        message: "EVM 原生币分发交易已确认",
        progress: createSendProgress(1, 1, 1, 1),
        signatures: [hash],
        status: "success"
      });
      setBalanceRefreshNonce((value) => value + 1);
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
          title="EVM 批量分发"
          subtitle="粘贴 `EVM地址,金额` 格式，可分发原生币或指定 ERC20 Token，先校验总额、重复项和金额，再连接 EVM 钱包进入确认。"
          nav={<NavLinks current="evmDistributor" />}
        />

        <section className="workspace batch-workspace">
          <section className="panel input-panel" aria-labelledby="list-title">
            <div className="panel-header">
              <div>
                <h2 className="panel-title" id="list-title">EVM 分发清单</h2>
                <p className="panel-note">每行必须是 `地址,金额`，金额单位按当前选择的资产处理。</p>
              </div>
              <span className="pill network-pill">{selectedNetwork.label} · {assetSymbol}</span>
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
                <div className="mode-row asset-mode-row" aria-label="资产类型">
                  <label className={`mode asset-mode ${assetMode === "native" ? "selected" : ""}`}>
                    <span className="mode-head">
                      <input
                        type="radio"
                        name="assetMode"
                        checked={assetMode === "native"}
                        onChange={() => {
                          setAssetMode("native");
                          resetConfirmation();
                        }}
                      />
                      原生币
                    </span>
                    <span className="asset-mode-meta">
                      <span>{selectedNetwork.nativeCurrency.symbol}</span>
                      {nativeBalanceDescription ? <span className="asset-mode-balance">{nativeBalanceDescription}</span> : null}
                    </span>
                  </label>
                  <label className={`mode asset-mode ${assetMode === "token" ? "selected" : ""}`}>
                    <span className="mode-head">
                      <input
                        type="radio"
                        name="assetMode"
                        checked={assetMode === "token"}
                        onChange={() => {
                          setAssetMode("token");
                          resetConfirmation();
                        }}
                      />
                      Token
                    </span>
                    <span className="asset-mode-meta">
                      <span>{tokenDetails ? tokenDetails.symbol : "指定合约"}</span>
                      {tokenBalanceDescription ? (
                        <span className={tokenBalanceClassName} title={tokenBalanceHint || undefined}>{tokenBalanceDescription}</span>
                      ) : null}
                    </span>
                  </label>
                </div>
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
                {assetMode === "token" ? (
                  <div className="token-config">
                    <div className="field route-card token-address-field">
                      <label htmlFor="tokenAddress">Token 合约地址</label>
                      <input
                        id="tokenAddress"
                        type="text"
                        value={tokenAddress}
                        onChange={(event) => {
                          setTokenAddress(event.target.value);
                          resetConfirmation();
                        }}
                        placeholder="0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
                      />
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="field">
                <label htmlFor="distributionInput">地址,金额</label>
                <p className="hint">示例：0x742d35Cc6634C0532925a3b844Bc454e4438f44e,0.1。当前单位：{assetSymbol}。</p>
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
              <Metric value={parsed.total} label={`合计 ${assetSymbol}`} />
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
                formatAmount={(row) => `${formatWei(row.lamports, assetDecimals)} ${assetSymbol}`}
              />
              {confirmVisible ? (
                <div className={`confirm transaction-status ${sendState.status}`}>
                  <strong>{showFinalSummary ? "最终确认摘要" : sendState.status === "success" ? "分发交易已确认" : sendState.status === "error" ? "分发交易未完成" : `准备向 ${parsed.validRows.length} 个地址分发`}</strong>
                  {showFinalSummary ? (
                    <div className="summary-list">
                      <div><span>网络选择</span><strong>{selectedNetwork.label}</strong></div>
                      <div><span>资产类型</span><strong>{assetMode === "token" && tokenDetails ? `${tokenDetails.symbol} · ${shortenAddress(tokenDetails.address)}` : selectedNetwork.nativeCurrency.symbol}</strong></div>
                      <div><span>RPC</span><strong>{effectiveRpcEndpoint}</strong></div>
                      <div><span>收款人数</span><strong>{parsed.validRows.length}</strong></div>
                      <div><span>总额</span><strong>{parsed.total} {assetSymbol}</strong></div>
                      <div><span>前 3 个地址</span><strong>{parsed.validRows.slice(0, 3).map((row) => shortenAddress(row.address)).join(" / ")}</strong></div>
                    </div>
                  ) : (
                    <span>{sendState.message || `合计 ${parsed.total} ${assetSymbol}，网络 ${selectedNetwork.label}。`}</span>
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
                      {sendState.signatures.map((signature, index) => {
                        const label = sendState.signatures.length > 1 && index === 0 ? "授权" : "分发";
                        return (
                          <a key={signature} href={getEvmExplorerUrl(signature, selectedNetwork)} target="_blank" rel="noreferrer">
                            {label}: {shortenAddress(signature)}
                          </a>
                        );
                      })}
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
