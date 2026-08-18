import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DistributionListGenerator } from "../components/DistributionListGenerator";
import { DistributionReview } from "../components/DistributionReview";
import { EvmWalletConnectionControl } from "../components/EvmWalletConnectionControl";
import { Metric } from "../components/Metric";
import { SearchableSelect } from "../components/SearchableSelect";
import { ToolPageLayout, type ToolPageStep, type ToolPageStepState } from "../components/ToolPageLayout";
import { useEvmWallet } from "../hooks/useEvmWallet";
import { shortenAddress } from "../lib/address";
import { getInitialDistributionInput, type DistributionRow } from "../lib/distribution";
import { importDistributionInput, type GeneratedDistributionList } from "../lib/distribution-generator";
import {
  ensureEvmNetwork,
  formatWei,
  formatWeiForDisplay,
  getEvmAssetSymbol,
  getEvmBalanceLookupErrorMessage,
  getEvmDistributionNetworks,
  getEvmExplorerUrl,
  getEvmNativeBalance,
  getEvmNetworkConfig,
  getPreferredEvmDistributionNetwork,
  getVerifiedEvmDistributionChainIds,
  getEvmTokenBalance,
  getEvmTokenDetails,
  getEvmTokenLookupErrorMessage,
  getEvmTransactionErrorMessage,
  isValidEvmAddress,
  isEvmNativeCurrencyEnabled,
  parseEvmDistribution,
  preflightEvmDistribution,
  rememberPreferredEvmDistributionNetwork,
  removeVerifiedEvmDistributionNetwork,
  sendEvmNativeDistribution,
  sendEvmTokenDistribution,
  type EvmAssetMode,
  type EvmDistributionNetworkId,
  type EvmDistributionPreflightResult,
  type EvmTokenDetails,
  type EvmTokenDistributionStep
} from "../lib/evm";

const evmDistributionSteps: ToolPageStep[] = [
  { label: "准备", description: "选择资产并整理清单" },
  { label: "确认", description: "核对网络、授权和总额" },
  { label: "批量发送", description: "签名并跟踪交易结果" }
];
import { createSendProgress, initialSendState } from "../lib/solana";

type TokenLookupState = {
  details: EvmTokenDetails | null;
  message: string;
  requestKey: string;
  status: "idle" | "loading" | "success" | "error";
};

type BalanceLookupState = {
  message: string;
  status: "idle" | "loading" | "success" | "error";
  valueWei: bigint | null;
};

type EvmDistributionPreflightState = {
  message: string;
  result: EvmDistributionPreflightResult | null;
  status: "idle" | "loading" | "success" | "error";
};

const initialTokenLookupState: TokenLookupState = {
  details: null,
  message: "",
  requestKey: "",
  status: "idle"
};

const initialBalanceLookupState: BalanceLookupState = {
  message: "",
  status: "idle",
  valueWei: null
};

const initialDistributionPreflightState: EvmDistributionPreflightState = {
  message: "",
  result: null,
  status: "idle"
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

export function EvmBatchDistributorPage() {
  const [networkState, setNetworkState] = useState(() => {
    const networks = getEvmDistributionNetworks();
    return {
      networks,
      selected: getPreferredEvmDistributionNetwork(networks),
      verifiedChainIds: getVerifiedEvmDistributionChainIds()
    };
  });
  const [initialDistribution] = useState(() => importDistributionInput(getInitialDistributionInput()));
  const [generatedInput, setGeneratedInput] = useState("");
  const [generatedList, setGeneratedList] = useState<GeneratedDistributionList>(initialGeneratedList);
  const [assetMode, setAssetMode] = useState<EvmAssetMode>(() => (
    isEvmNativeCurrencyEnabled(networkState.selected) ? "native" : "token"
  ));
  const [confirmVisible, setConfirmVisible] = useState(false);
  const [networkId, setNetworkId] = useState<EvmDistributionNetworkId>(networkState.selected.id);
  const [rpcEndpoint, setRpcEndpoint] = useState(networkState.selected.rpcEndpoint);
  const [sendState, setSendState] = useState(initialSendState);
  const [preflightState, setPreflightState] = useState<EvmDistributionPreflightState>(initialDistributionPreflightState);
  const [tokenAddress, setTokenAddress] = useState("");
  const [tokenLookup, setTokenLookup] = useState<TokenLookupState>(initialTokenLookupState);
  const [tokenLookupRefreshNonce, setTokenLookupRefreshNonce] = useState(0);
  const [nativeBalanceLookup, setNativeBalanceLookup] = useState<BalanceLookupState>(initialBalanceLookupState);
  const [tokenBalanceLookup, setTokenBalanceLookup] = useState<BalanceLookupState>(initialBalanceLookupState);
  const [balanceRefreshNonce, setBalanceRefreshNonce] = useState(0);
  const [listImporting, setListImporting] = useState(false);
  const [generatorRevision, setGeneratorRevision] = useState(0);
  const confirmationRef = useRef<HTMLDivElement>(null);
  const listImportingRef = useRef(false);
  const preflightEpochRef = useRef(0);
  const sendOperationRef = useRef(false);
  const wallet = useEvmWallet();

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

  const selectedNetwork = useMemo(
    () => getEvmNetworkConfig(networkId, networkState.networks),
    [networkId, networkState.networks]
  );
  const networkOptions = useMemo(() => networkState.networks.map((network) => ({
    keywords: [network.id, network.nativeCurrency.name, network.nativeCurrency.symbol],
    label: network.label,
    meta: String(network.chainId),
    value: network.id
  })), [networkState.networks]);
  const effectiveRpcEndpoint = rpcEndpoint.trim() || selectedNetwork.rpcEndpoint;
  const nativeCurrencyEnabled = isEvmNativeCurrencyEnabled(selectedNetwork);
  const tokenAddressInput = tokenAddress.trim();
  const tokenRequestKey = assetMode === "token" && tokenAddressInput
    ? `${selectedNetwork.chainId}|${effectiveRpcEndpoint}|${tokenAddressInput.toLowerCase()}`
    : "";
  const tokenDetails = assetMode === "token" && tokenLookup.requestKey === tokenRequestKey
    ? tokenLookup.details
    : null;
  const assetDecimals = assetMode === "token" ? tokenDetails?.decimals ?? 18 : selectedNetwork.nativeCurrency.decimals;
  const assetSymbol = getEvmAssetSymbol(assetMode, selectedNetwork, tokenDetails);
  const input = assetMode === "token" && !tokenDetails ? "" : generatedInput;
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
  const preflighting = preflightState.status === "loading";
  const preflightFailed = preflightState.status === "error";
  const sendComplete = sendState.status === "success";
  const sendFailed = sendState.status === "error";
  const unresolvedSubmission = sendFailed && sendState.signatures.length > 0;
  const controlsLocked = preflighting || sending || sendComplete || sendFailed;
  const pageControlsLocked = controlsLocked || listImporting;
  const assetReady = assetMode === "native"
    ? nativeCurrencyEnabled
    : tokenLookup.status === "success" && Boolean(tokenDetails);
  const generatedListReady = generatedList.invalid === 0 && generatedList.duplicates === 0;
  const readyToSend = wallet.connected
    && Boolean(wallet.getProvider())
    && assetReady
    && generatedListReady
    && parsed.validRows.length > 0
    && parsed.invalid === 0
    && !preflighting
    && !sending
    && !sendComplete
    && !sendFailed
    && !listImporting;
  const invalidCount = parsed.invalid + generatedList.invalid;
  const duplicateCount = Math.max(parsed.duplicates, generatedList.duplicates);
  const nativeBalance = !nativeCurrencyEnabled
    ? "未开放"
    : nativeBalanceLookup.status === "success" && nativeBalanceLookup.valueWei !== null
    ? formatWeiForDisplay(nativeBalanceLookup.valueWei, selectedNetwork.nativeCurrency.decimals)
    : nativeBalanceLookup.status === "loading"
      ? "读取中"
      : wallet.connected
        ? "--"
        : "未连接";
  const nativeBalanceDescription = !nativeCurrencyEnabled
    ? "元数据待确认"
    : nativeBalanceLookup.status === "success"
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
  const showFinalSummary = confirmVisible && sendState.status === "idle" && preflightState.status === "success" && Boolean(preflightState.result);
  const confirmationStatus = sendState.status !== "idle"
    ? sendState.status
    : preflightFailed
      ? "error"
      : preflighting
        ? "preparing"
        : "idle";
  const sendButtonLabel = sending
    ? sendState.status === "preparing"
      ? "准备中"
      : sendState.status === "confirming"
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
  const generatorUnavailableMessage = assetMode === "token" && !tokenDetails
    ? tokenLookup.status === "loading"
      ? "正在读取 Token 精度，完成后即可按该资产生成金额。"
      : "请先识别 Token 合约。"
    : "";
  const readinessMessage = !wallet.connected || !wallet.getProvider()
    ? "请先连接发送钱包"
    : listImporting
      ? "正在导入清单，请稍候"
      : !assetReady
        ? assetMode === "token" ? "请先填写并成功识别 Token 合约地址" : "当前链尚未开放原生币分发"
        : generatedList.invalid > 0 || parsed.invalid > 0
          ? `请先修正 ${invalidCount} 处清单错误`
          : generatedList.duplicates > 0 || parsed.duplicates > 0
            ? `请先处理 ${duplicateCount} 个重复地址`
            : parsed.validRows.length === 0
              ? "请先添加至少 1 个有效收款地址"
              : "下一步：只读预检，不会签名";

  const removeSelectedVerifiedNetwork = () => {
    if (!removeVerifiedEvmDistributionNetwork(selectedNetwork.chainId)) return;

    const networks = getEvmDistributionNetworks();
    const nextSelected = getPreferredEvmDistributionNetwork(networks);
    setNetworkState({
      networks,
      selected: nextSelected,
      verifiedChainIds: getVerifiedEvmDistributionChainIds()
    });
    setNetworkId(nextSelected.id);
    setRpcEndpoint(nextSelected.rpcEndpoint);
    setAssetMode(isEvmNativeCurrencyEnabled(nextSelected) ? "native" : "token");
    setTokenLookup(initialTokenLookupState);
    resetConfirmation();
  };

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
        requestKey: tokenRequestKey,
        status: "error"
      });
      return;
    }

    let active = true;
    setTokenLookup({
      details: null,
      message: "正在读取 Token 信息",
      requestKey: tokenRequestKey,
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
        requestKey: tokenRequestKey,
        status: "success"
      });
    }).catch((error) => {
      if (!active) return;
      setTokenLookup({
        details: null,
        message: getEvmTokenLookupErrorMessage(error),
        requestKey: tokenRequestKey,
        status: "error"
      });
    });

    return () => {
      active = false;
    };
  }, [assetMode, effectiveRpcEndpoint, selectedNetwork, tokenAddressInput, tokenLookupRefreshNonce, tokenRequestKey]);

  useEffect(() => {
    if (!nativeCurrencyEnabled) {
      setNativeBalanceLookup({
        message: "确认原生币元数据后显示余额",
        status: "idle",
        valueWei: null
      });
      return;
    }

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
  }, [balanceRefreshNonce, effectiveRpcEndpoint, nativeCurrencyEnabled, selectedNetwork, wallet.address, wallet.connected]);

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

  const prepareDistribution = async () => {
    if (sendOperationRef.current || listImportingRef.current || !readyToSend || !wallet.address) return;
    sendOperationRef.current = true;
    const preflightEpoch = ++preflightEpochRef.current;
    setConfirmVisible(true);
    setPreflightState({
      message: `正在读取 ${assetSymbol} 余额、授权额度并估算网络费`,
      result: null,
      status: "loading"
    });

    try {
      const result = await preflightEvmDistribution({
        assetMode,
        from: wallet.address,
        network: selectedNetwork,
        rows: parsed.validRows,
        rpcEndpoint: effectiveRpcEndpoint,
        token: tokenDetails
      });
      if (preflightEpochRef.current !== preflightEpoch) return;
      setPreflightState({
        message: "只读预检已通过；下方按钮才会请求钱包确认",
        result,
        status: "success"
      });
      setNativeBalanceLookup({ message: "", status: "success", valueWei: result.nativeBalanceWei });
      if (assetMode === "token") {
        setTokenBalanceLookup({ message: "", status: "success", valueWei: result.assetBalanceWei });
      }
    } catch (error) {
      if (preflightEpochRef.current !== preflightEpoch) return;
      setPreflightState({
        message: getEvmTransactionErrorMessage(error),
        result: null,
        status: "error"
      });
    } finally {
      sendOperationRef.current = false;
    }
  };

  const sendDistribution = async () => {
    const walletProvider = wallet.getProvider();
    if (sendOperationRef.current || listImportingRef.current || !readyToSend || !walletProvider || !wallet.address || !showFinalSummary || sendState.status !== "idle") return;
    sendOperationRef.current = true;
    let observedSignatures: string[] = [];
    let observedProgress = createSendProgress(1);

    const observeTokenStep = (step: EvmTokenDistributionStep) => {
      if (step.type === "allowance-checked") {
        observedProgress = createSendProgress(step.totalTransactions);
      } else if (step.type === "approval-submitted") {
        observedSignatures = [step.hash];
        observedProgress = createSendProgress(step.totalTransactions, 1, 1, 0);
      } else if (step.type === "approval-confirmed") {
        observedSignatures = [step.hash];
        observedProgress = createSendProgress(step.totalTransactions, 1, 1, 1);
      } else {
        const confirmed = step.type === "distribution-confirmed"
          ? step.totalTransactions
          : step.totalTransactions === 2 ? 1 : 0;
        observedSignatures = [...step.hashes];
        observedProgress = createSendProgress(
          step.totalTransactions,
          step.totalTransactions,
          step.totalTransactions,
          confirmed
        );
      }
      handleTokenStep(step);
    };

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
          onStep: observeTokenStep,
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

      if (!nativeCurrencyEnabled) {
        throw new Error("原生币元数据尚未确认，当前链只允许 Token 分发");
      }

      const { hash } = await sendEvmNativeDistribution({
        from: wallet.address,
        network: selectedNetwork,
        onSubmitted: (submittedHash) => {
          observedSignatures = [submittedHash];
          observedProgress = createSendProgress(1, 1, 1, 0);
          setSendState({
            message: "交易已提交，等待链上确认",
            progress: observedProgress,
            signatures: [submittedHash],
            status: "confirming"
          });
        },
        provider: walletProvider,
        rows: parsed.validRows,
        rpcEndpoint: effectiveRpcEndpoint
      });

      setSendState({
        message: "EVM 原生币分发交易已确认",
        progress: createSendProgress(1, 1, 1, 1),
        signatures: [hash],
        status: "success"
      });
      setBalanceRefreshNonce((value) => value + 1);
    } catch (error) {
      const baseMessage = getEvmTransactionErrorMessage(error);
      const message = observedSignatures.length > 0
        ? `${baseMessage}。检测到 ${observedSignatures.length} 笔已提交交易，请先检查链上记录，避免重复发送。`
        : baseMessage;
      setSendState({
        message,
        progress: observedProgress,
        signatures: observedSignatures,
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
      currentToolId="evm-distribution"
      description="批量发送原生币或 ERC20。"
      eyebrow="One to many · EVM"
      mainClassName="page-distributor"
      meta={<><span className="pill network-pill">{selectedNetwork.label}</span><span className="pill">{assetSymbol}</span></>}
      stepStates={stepStates}
      steps={evmDistributionSteps}
      title="EVM 批量分发"
    >
        <section className="workspace batch-workspace">
          <section className="panel input-panel" aria-labelledby="list-title">
            <div className="panel-header">
              <div>
                <h2 className="panel-title" id="list-title">EVM 分发清单</h2>
              </div>
              <span className="pill network-pill">{selectedNetwork.label} · {assetSymbol}</span>
            </div>

            <div className="form">
              <EvmWalletConnectionControl disabled={pageControlsLocked} wallet={wallet} />

              {initialDistribution.hasMixedAmounts ? (
                <div className="notice compact-notice">
                  <strong>旧清单金额未导入</strong>
                  <span>已保留收款地址，请重新设置统一金额或随机区间。</span>
                </div>
              ) : null}

              <div className="transaction-options compact-route" aria-label="链路配置">
                <div className="mode-row asset-mode-row" aria-label="资产类型">
                  <label className={`mode asset-mode ${assetMode === "native" ? "selected" : ""}${nativeCurrencyEnabled ? "" : " disabled"}`}>
                    <span className="mode-head">
                      <input
                        type="radio"
                        name="assetMode"
                        checked={assetMode === "native"}
                        disabled={pageControlsLocked || !nativeCurrencyEnabled}
                        onChange={() => {
                          setAssetMode("native");
                          setTokenLookup(initialTokenLookupState);
                          resetConfirmation();
                        }}
                      />
                      原生币
                    </span>
                    <span className="asset-mode-meta">
                      <span>{nativeCurrencyEnabled ? selectedNetwork.nativeCurrency.symbol : "未确认"}</span>
                      {nativeBalanceDescription ? <span className="asset-mode-balance">{nativeBalanceDescription}</span> : null}
                    </span>
                  </label>
                  <label className={`mode asset-mode ${assetMode === "token" ? "selected" : ""}`}>
                    <span className="mode-head">
                      <input
                        type="radio"
                        name="assetMode"
                        checked={assetMode === "token"}
                        disabled={pageControlsLocked}
                        onChange={() => {
                          setAssetMode("token");
                          setTokenLookup(initialTokenLookupState);
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
                    <SearchableSelect
                      disabled={pageControlsLocked}
                      emptyMessage="未找到匹配的 EVM 链"
                      id="networkId"
                      listboxLabel="EVM 链"
                      metaLabel="Chain ID"
                      metaPrefix="ID"
                      onChange={(nextNetworkId) => {
                        const nextNetwork = getEvmNetworkConfig(nextNetworkId, networkState.networks);
                        setNetworkId(nextNetworkId);
                        setRpcEndpoint(nextNetwork.rpcEndpoint);
                        if (!isEvmNativeCurrencyEnabled(nextNetwork)) setAssetMode("token");
                        setTokenLookup(initialTokenLookupState);
                        rememberPreferredEvmDistributionNetwork(nextNetworkId);
                        resetConfirmation();
                      }}
                      options={networkOptions}
                      placeholder="搜索链名称或 Chain ID"
                      searchLabel="搜索 EVM 链名称或 Chain ID"
                      value={networkId}
                    />
                  </div>
                  <div className="field route-card rpc-field">
                    <label htmlFor="rpcEndpoint">RPC</label>
                    <input disabled={pageControlsLocked} id="rpcEndpoint" type="url" value={rpcEndpoint} onChange={(event) => {
                      setRpcEndpoint(event.target.value);
                      setTokenLookup(initialTokenLookupState);
                      resetConfirmation();
                    }} />
                  </div>
                </div>
                {!nativeCurrencyEnabled ? (
                  <div className="notice">
                    <strong>当前链仅开放 Token 分发</strong>
                    <span>原生币元数据未确认，仅可分发 Token。</span>
                    <a href="/evm/deploy/">前往部署页确认原生币元数据</a>
                  </div>
                ) : null}
                {networkState.verifiedChainIds.includes(selectedNetwork.chainId) ? (
                  <div className="action-group network-config-actions">
                    <button className="button ghost" disabled={pageControlsLocked} type="button" onClick={removeSelectedVerifiedNetwork}>移除此链配置</button>
                  </div>
                ) : null}
                {assetMode === "token" ? (
                  <div className="token-config">
                    <div className="field route-card token-address-field">
                      <label htmlFor="tokenAddress">Token 合约地址</label>
                      <input
                        id="tokenAddress"
                        disabled={pageControlsLocked}
                        type="text"
                        value={tokenAddress}
                        onChange={(event) => {
                          setTokenAddress(event.target.value);
                          setTokenLookup(initialTokenLookupState);
                          resetConfirmation();
                        }}
                        placeholder="0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
                      />
                    </div>
                  </div>
                ) : null}
              </div>
              {assetMode === "token" && tokenLookup.status === "error" ? (
                <div className="notice compact-notice" role="alert">
                  <strong>未能识别 Token</strong>
                  <span>{tokenLookup.message}</span>
                  <div className="action-group">
                    <button className="button ghost" type="button" onClick={() => setTokenLookupRefreshNonce((value) => value + 1)}>重新识别</button>
                  </div>
                </div>
              ) : null}
              {assetMode === "native" && nativeBalanceLookup.status === "error" ? (
                <div className="notice compact-notice" role="alert">
                  <strong>未能读取钱包余额</strong>
                  <span>{nativeBalanceLookup.message}</span>
                  <div className="action-group">
                    <button className="button ghost" type="button" onClick={() => setBalanceRefreshNonce((value) => value + 1)}>重试读取</button>
                  </div>
                </div>
              ) : null}
              {assetMode === "token" && tokenDetails && tokenBalanceLookup.status === "error" ? (
                <div className="notice compact-notice" role="alert">
                  <strong>未能读取 Token 余额</strong>
                  <span>{tokenBalanceLookup.message}</span>
                  <div className="action-group">
                    <button className="button ghost" type="button" onClick={() => setBalanceRefreshNonce((value) => value + 1)}>重试读取</button>
                  </div>
                </div>
              ) : null}

              <DistributionListGenerator
                key={`evm-distribution-${generatorRevision}`}
                addressKind="evm"
                decimals={assetDecimals}
                disabled={controlsLocked}
                generationDisabled={Boolean(generatorUnavailableMessage)}
                initialAddresses={generatorRevision === 0 ? initialDistribution.addresses : ""}
                initialFixedAmount={generatorRevision === 0 && initialDistribution.hadAmounts ? initialDistribution.fixedAmount : "0.1"}
                onDirty={resetConfirmation}
                onImportingChange={handleListImportingChange}
                onResultChange={handleGeneratedListChange}
                symbol={assetSymbol}
                unavailableMessage={generatorUnavailableMessage}
                validateAddress={isValidEvmAddress}
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
              <Metric value={parsed.total} label={`合计 ${assetSymbol}`} />
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
              <DistributionReview
                rows={reviewRows}
                formatAmount={(row) => `${formatWei(row.lamports, assetDecimals)} ${assetSymbol}`}
              />
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
                      <div><span>资产类型</span><strong>{assetMode === "token" && tokenDetails ? `${tokenDetails.symbol} · ${shortenAddress(tokenDetails.address)}` : assetSymbol}</strong></div>
                      <div><span>RPC</span><strong>{effectiveRpcEndpoint}</strong></div>
                      <div><span>收款人数</span><strong>{parsed.validRows.length}</strong></div>
                      <div><span>总额</span><strong>{parsed.total} {assetSymbol}</strong></div>
                      <div><span>钱包资产余额</span><strong>{formatWei(preflightState.result?.assetBalanceWei ?? 0n, assetDecimals)} {assetSymbol}</strong></div>
                      <div><span>{preflightState.result?.feeEstimateBasis === "conservative" ? "保守预估网络费" : "预估网络费"}</span><strong>{formatWei(preflightState.result?.estimatedNetworkFeeWei ?? 0n, selectedNetwork.nativeCurrency.decimals)} {selectedNetwork.nativeCurrency.symbol}</strong></div>
                      <div><span>授权检查</span><strong>{preflightState.result?.needsApproval ? "需要 1 次 Token 授权" : "无需额外授权"}</strong></div>
                      <div><span>预计钱包确认</span><strong>{preflightState.result?.totalTransactions ?? 0} 次</strong></div>
                      <div><span>前 3 个地址</span><strong>{parsed.validRows.slice(0, 3).map((row) => shortenAddress(row.address)).join(" / ")}</strong></div>
                    </div>
                  ) : (
                    <span>{sendState.status === "idle"
                      ? preflightState.message
                      : sendState.message || `合计 ${parsed.total} ${assetSymbol}，网络 ${selectedNetwork.label}。`}</span>
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
                        const label = sendState.progress.total === 2 && index === 0 ? "授权" : "分发";
                        const explorerUrl = getEvmExplorerUrl(signature, selectedNetwork);
                        return (
                          explorerUrl
                            ? <a key={signature} href={explorerUrl} target="_blank" rel="noreferrer">{label}: {shortenAddress(signature)}</a>
                            : <span key={signature}>{label}: {shortenAddress(signature)} · 当前链未配置区块浏览器</span>
                        );
                      })}
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
