import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DistributionListGenerator } from "../components/DistributionListGenerator";
import { EvmGasBadge, EvmGasSettings } from "../components/EvmGasControl";
import { EvmWalletConnectionControl } from "../components/EvmWalletConnectionControl";
import { SearchableSelect } from "../components/SearchableSelect";
import { ToolPageLayout, type WorkbenchStatus } from "../components/ToolPageLayout";
import {
  ConfirmActionDialog,
  ExecutionProgress,
  ReviewPanel,
  ResultTable,
  WorkbenchPanel
} from "../components/WorkbenchPrimitives";
import { useEvmWallet } from "../hooks/useEvmWallet";
import { useEvmGas } from "../hooks/useEvmGas";
import { shortenAddress } from "../lib/address";
import { getInitialDistributionInput, type DistributionRow } from "../lib/distribution";
import { importDistributionInput, type GeneratedDistributionList } from "../lib/distribution-generator";
import {
  assertEvmWalletContext,
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

export function getEvmDistributionSafetyState({
  preflightStatus,
  sendStatus,
  signatureCount
}: {
  preflightStatus: EvmDistributionPreflightState["status"];
  sendStatus: "idle" | "preparing" | "awaiting-wallet" | "confirming" | "success" | "error";
  signatureCount: number;
}) {
  const unresolvedSubmission = sendStatus === "error" && signatureCount > 0;
  const workbenchStatus: WorkbenchStatus = unresolvedSubmission
    ? "uncertain"
    : sendStatus === "success"
      ? "success"
      : sendStatus === "error" || preflightStatus === "error"
        ? "error"
        : sendStatus === "preparing" || sendStatus === "awaiting-wallet" || sendStatus === "confirming"
          ? "running"
          : preflightStatus === "loading"
            ? "preflight"
            : preflightStatus === "success"
              ? "ready"
              : "editing";

  return {
    canRetryInPlace: sendStatus === "error" && !unresolvedSubmission,
    unresolvedSubmission,
    workbenchStatus
  };
}

export async function runEvmDistributionSigningGate<Result>({
  preflight,
  sign
}: {
  preflight: () => Promise<Result>;
  sign: (result: Result) => Promise<void>;
}) {
  const freshPreflight = await preflight();
  await sign(freshPreflight);
}

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
  const [mixedAmountWarningVisible, setMixedAmountWarningVisible] = useState(initialDistribution.hasMixedAmounts);
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

  const handleGeneratorDirty = useCallback(() => {
    setMixedAmountWarningVisible(false);
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
  const gas = useEvmGas({
    network: selectedNetwork,
    rpcEndpoint: effectiveRpcEndpoint
  });
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
  const safetyState = getEvmDistributionSafetyState({
    preflightStatus: preflightState.status,
    sendStatus: sendState.status,
    signatureCount: sendState.signatures.length
  });
  const unresolvedSubmission = safetyState.unresolvedSubmission;
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
    && Boolean(gas.gasSettings)
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
  const generatorUnavailableMessage = assetMode === "token" && !tokenDetails
    ? tokenLookup.status === "loading"
      ? "正在读取 Token 精度，完成后即可按该资产生成金额。"
      : "请先识别 Token 合约。"
    : "";
  const readinessMessage = !wallet.connected || !wallet.getProvider()
    ? "请先连接发送钱包"
    : listImporting
      ? "正在导入清单，请稍候"
      : !gas.gasSettings
        ? "请填写有效的自定义 Gas Price"
        : !assetReady
          ? assetMode === "token" ? "请先填写并成功识别 Token 合约地址" : "当前链尚未开放原生币分发"
          : generatedList.invalid > 0 || parsed.invalid > 0
            ? `请先修正 ${invalidCount} 处清单错误`
            : generatedList.duplicates > 0 || parsed.duplicates > 0
              ? `请先处理 ${duplicateCount} 个重复地址`
              : parsed.validRows.length === 0
                ? "请先添加至少 1 个有效收款地址"
                : "清单可预检";
  const pageStatus = safetyState.workbenchStatus;
  const pageStatusLabel = unresolvedSubmission
    ? "已提交，待核对"
    : sendState.status === "preparing"
      ? "签名前复检"
      : sendState.status === "awaiting-wallet"
      ? "等待钱包签名"
      : sendState.status === "confirming"
        ? "链上确认中"
        : preflighting
          ? "预检中"
          : undefined;
  const reviewHasRisk = unresolvedSubmission || sendFailed || preflightFailed;
  const reviewShouldOpen = reviewHasRisk || sendState.signatures.length > 0;
  const reviewSummaryLabel = unresolvedSubmission
    ? "链上状态待核对"
    : sendComplete
      ? `已完成 · ${sendState.signatures.length} 笔`
      : sendFailed
        ? "执行失败"
        : preflightFailed
          ? "预检未通过"
          : sending
            ? "执行中"
            : preflighting
              ? "预检中"
              : showFinalSummary
                ? `预检通过 · ${preflightState.result?.totalTransactions || 0} 笔`
                : reviewRows.length
                  ? `清单 ${reviewRows.length} 项`
                  : "尚无清单";

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
    const gasSettings = gas.gasSettings;
    if (sendOperationRef.current || listImportingRef.current || !readyToSend || !wallet.address || !gasSettings) return;
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
        gasSettings,
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
    const gasSettings = gas.gasSettings;
    if (sendOperationRef.current || listImportingRef.current || !readyToSend || !walletProvider || !wallet.address || !showFinalSummary || sendState.status !== "idle" || !gasSettings) return;
    sendOperationRef.current = true;
    let observedSignatures: string[] = [];
    let observedProgress = createSendProgress(1);
    let freshPreflightCompleted = false;

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
      await runEvmDistributionSigningGate({
        preflight: () => preflightEvmDistribution({
          assetMode,
          from: wallet.address,
          gasSettings,
          network: selectedNetwork,
          rows: parsed.validRows,
          rpcEndpoint: effectiveRpcEndpoint,
          token: tokenDetails
        }),
        sign: async (freshPreflight) => {
          await assertEvmWalletContext({
            account: wallet.address,
            network: selectedNetwork,
            provider: walletProvider
          });
          freshPreflightCompleted = true;
          setPreflightState({
            message: "签名前复检通过",
            result: freshPreflight,
            status: "success"
          });
          setNativeBalanceLookup({ message: "", status: "success", valueWei: freshPreflight.nativeBalanceWei });
          if (assetMode === "token") {
            setTokenBalanceLookup({ message: "", status: "success", valueWei: freshPreflight.assetBalanceWei });
          }

          setSendState({
            message: `请在 EVM 钱包中确认 ${selectedNetwork.label} ${assetSymbol} 分发交易`,
            progress: createSendProgress(freshPreflight.totalTransactions),
            signatures: [],
            status: "awaiting-wallet"
          });

          if (assetMode === "token") {
            if (!tokenDetails) throw new Error("请先填写并读取 ERC20 Token 合约地址");

            const { hashes } = await sendEvmTokenDistribution({
              feeQuote: freshPreflight.feeQuote,
              from: wallet.address,
              gasSettings,
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
            feeQuote: freshPreflight.feeQuote,
            from: wallet.address,
            gasSettings,
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
        }
      });
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
      if (!freshPreflightCompleted) {
        setPreflightState({
          message: baseMessage,
          result: null,
          status: "error"
        });
      }
    } finally {
      sendOperationRef.current = false;
    }
  };

  const startNewDistribution = () => {
    setGeneratorRevision((value) => value + 1);
    setGeneratedInput("");
    setGeneratedList(initialGeneratedList);
    setMixedAmountWarningVisible(false);
    resetConfirmation();
  };

  return (
    <ToolPageLayout
      actions={(
        <>
          <EvmGasBadge gas={gas} />
          <EvmWalletConnectionControl disabled={pageControlsLocked} wallet={wallet} />
        </>
      )}
      className="page-distributor"
      currentToolId="evm-distribution"
      stickyActions
      status={pageStatus}
      statusLabel={pageStatusLabel}
      title="EVM 批量分发"
    >
      <div className="workbench-grid">
        <WorkbenchPanel
          actions={<Badge variant="outline">{selectedNetwork.label} · {assetSymbol}</Badge>}
          className="input-panel"
          footer={(
            <div className="actions">
              <span className="hint" role="status">{readinessMessage}</span>
              <div className="action-group">
                {!sendComplete && !sendFailed && !sending ? (
                  <Button
                    disabled={!readyToSend}
                    onClick={() => void prepareDistribution()}
                    type="button"
                    variant={showFinalSummary ? "outline" : "default"}
                  >{preflighting ? "预检中" : showFinalSummary || preflightFailed ? "重新预检" : listImporting ? "正在导入清单" : "运行预检"}</Button>
                ) : null}
                {sending ? <Button disabled type="button">{sendState.status === "preparing" ? "签名前复检" : sendState.status === "awaiting-wallet" ? "等待钱包签名" : "链上确认中"}</Button> : null}
                {showFinalSummary ? (
                  <ConfirmActionDialog
                    confirmLabel={preflightState.result?.needsApproval ? "授权并分发" : "签名并分发"}
                    description={(
                      <div className="summary-list">
                        <div><span>网络</span><strong>{selectedNetwork.label} · {selectedNetwork.chainId}</strong></div>
                        <div><span>资产</span><strong>{assetMode === "token" && tokenDetails ? `${tokenDetails.symbol} · ${shortenAddress(tokenDetails.address)}` : assetSymbol}</strong></div>
                        <div><span>收款地址</span><strong>{parsed.validRows.length}</strong></div>
                        <div><span>分发总额</span><strong>{parsed.total} {assetSymbol}</strong></div>
                        <div><span>资产余额</span><strong>{formatWei(preflightState.result?.assetBalanceWei ?? 0n, assetDecimals)} {assetSymbol}</strong></div>
                        <div><span>发送账户</span><strong className="address" title={wallet.address}>{shortenAddress(wallet.address)}</strong></div>
                        <div><span>{preflightState.result?.feeEstimateBasis === "conservative" ? "保守预估网络费" : "预估网络费"}</span><strong>{formatWei(preflightState.result?.estimatedNetworkFeeWei ?? 0n, selectedNetwork.nativeCurrency.decimals)} {selectedNetwork.nativeCurrency.symbol}</strong></div>
                        <div><span>授权</span><strong>{preflightState.result?.needsApproval ? "1 次 Token 授权" : "无需授权"}</strong></div>
                        {preflightState.result?.needsApproval ? (
                          <div><span>授权后复检</span><strong>余额、授权与 Gas 通过后才分发</strong></div>
                        ) : null}
                        <div><span>钱包确认</span><strong>{preflightState.result?.totalTransactions ?? 0} 次</strong></div>
                        <div><span>地址抽样</span><strong>{parsed.validRows.slice(0, 3).map((row) => shortenAddress(row.address)).join(" / ")}</strong></div>
                      </div>
                    )}
                    disabled={!readyToSend}
                    onConfirm={sendDistribution}
                    title="确认 EVM 分发"
                    triggerLabel="确认分发"
                  />
                ) : null}
                {safetyState.canRetryInPlace ? (
                  <Button onClick={resetConfirmation} type="button" variant="outline">返回修改并重新预检</Button>
                ) : null}
                {sendComplete || unresolvedSubmission ? (
                  sendState.signatures.length > 0 ? (
                    <ConfirmActionDialog
                      confirmLabel="清空并开始新任务"
                      description="当前任务已产生交易哈希。清空只会从当前视图移除清单与哈希，不会撤销链上交易；请先核验链上记录，不得将原任务直接重试。"
                      disabled={sending}
                      onConfirm={startNewDistribution}
                      title="清空并新建分发任务？"
                      triggerLabel="清空清单并开始新任务"
                      triggerVariant="destructive"
                    />
                  ) : (
                    <Button onClick={startNewDistribution} type="button" variant="destructive">清空清单并开始新任务</Button>
                  )
                ) : null}
              </div>
            </div>
          )}
          title="分发配置"
        >
          {mixedAmountWarningVisible ? (
            <Alert>
              <AlertTitle>旧清单金额未导入</AlertTitle>
              <AlertDescription>已保留收款地址，请重新设置金额。</AlertDescription>
            </Alert>
          ) : null}

          <div className="evm-network-row" aria-label="网络与 RPC">
            <Field>
              <div className="evm-network-label-row">
                <FieldLabel htmlFor="networkId">网络</FieldLabel>
                <span className="evm-network-chain-id">Chain ID <strong>{selectedNetwork.chainId}</strong></span>
              </div>
              <SearchableSelect
                disabled={pageControlsLocked}
                emptyMessage="未找到匹配的 EVM 链"
                id="networkId"
                listboxLabel="EVM 链"
                metaLabel="Chain ID"
                metaPrefix="ID "
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
            </Field>
            <Field>
              <FieldLabel htmlFor="rpcEndpoint">RPC</FieldLabel>
              <Input
                autoComplete="off"
                disabled={pageControlsLocked}
                id="rpcEndpoint"
                onChange={(event) => {
                  setRpcEndpoint(event.target.value);
                  setTokenLookup(initialTokenLookupState);
                  resetConfirmation();
                }}
                spellCheck={false}
                type="url"
                value={rpcEndpoint}
              />
            </Field>
          </div>

          {!nativeCurrencyEnabled ? (
            <Alert>
              <AlertTitle>仅开放 Token 分发</AlertTitle>
              <AlertDescription>当前链的原生币元数据未确认。 <a href="/evm/deploy/">前往 CreateX 部署</a></AlertDescription>
            </Alert>
          ) : null}

          <Tabs
            aria-label="资产类型"
            onValueChange={(nextMode) => {
              if (nextMode !== "native" && nextMode !== "token") return;
              if (nextMode === "native" && !nativeCurrencyEnabled) return;
              setAssetMode(nextMode);
              setTokenLookup(initialTokenLookupState);
              resetConfirmation();
            }}
            value={assetMode}
          >
            <TabsList>
              <TabsTrigger disabled={pageControlsLocked || !nativeCurrencyEnabled} value="native">原生币</TabsTrigger>
              <TabsTrigger disabled={pageControlsLocked} value="token">Token</TabsTrigger>
            </TabsList>
            <TabsContent value="native">
              <div className="summary-list" aria-label="原生币余额">
                <div><span>{selectedNetwork.nativeCurrency.symbol}</span><strong>{nativeBalanceDescription || nativeBalance}</strong></div>
              </div>
              {nativeBalanceLookup.status === "error" ? (
                <Alert variant="destructive">
                  <AlertTitle>钱包余额读取失败</AlertTitle>
                  <AlertDescription>{nativeBalanceLookup.message}</AlertDescription>
                  <Button onClick={() => setBalanceRefreshNonce((value) => value + 1)} type="button" variant="outline">重试读取</Button>
                </Alert>
              ) : null}
            </TabsContent>
            <TabsContent value="token">
              <Field data-invalid={tokenLookup.status === "error" || undefined}>
                <FieldLabel htmlFor="tokenAddress">Token 合约地址</FieldLabel>
                <Input
                  aria-invalid={tokenLookup.status === "error" || undefined}
                  autoComplete="off"
                  disabled={pageControlsLocked}
                  id="tokenAddress"
                  onChange={(event) => {
                    setTokenAddress(event.target.value);
                    setTokenLookup(initialTokenLookupState);
                    resetConfirmation();
                  }}
                  placeholder="0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
                  spellCheck={false}
                  type="text"
                  value={tokenAddress}
                />
                {tokenLookup.status === "error" ? <FieldError>{tokenLookup.message}</FieldError> : null}
              </Field>
              {tokenDetails ? (
                <div className="summary-list" aria-label="Token 信息">
                  <div><span>{tokenDetails.name}</span><strong>{tokenDetails.symbol} · {tokenDetails.decimals} decimals</strong></div>
                  <div><span>钱包余额</span><strong className={tokenBalanceClassName} title={tokenBalanceHint || undefined}>{tokenBalanceDescription || tokenBalance}</strong></div>
                </div>
              ) : null}
              {tokenLookup.status === "error" ? (
                <Button onClick={() => setTokenLookupRefreshNonce((value) => value + 1)} type="button" variant="outline">重新识别</Button>
              ) : null}
              {tokenDetails && tokenBalanceLookup.status === "error" ? (
                <Alert variant="destructive">
                  <AlertTitle>Token 余额读取失败</AlertTitle>
                  <AlertDescription>{tokenBalanceLookup.message}</AlertDescription>
                  <Button onClick={() => setBalanceRefreshNonce((value) => value + 1)} type="button" variant="outline">重试读取</Button>
                </Alert>
              ) : null}
            </TabsContent>
          </Tabs>

          <DistributionListGenerator
            key={`evm-distribution-${generatorRevision}`}
            addressKind="evm"
            decimals={assetDecimals}
            disabled={controlsLocked}
            generationDisabled={Boolean(generatorUnavailableMessage)}
            initialAddresses={generatorRevision === 0 ? initialDistribution.addresses : ""}
            initialFixedAmount={generatorRevision === 0 && initialDistribution.hadAmounts ? initialDistribution.fixedAmount : "0.1"}
            onDirty={handleGeneratorDirty}
            onImportingChange={handleListImportingChange}
            onResultChange={handleGeneratedListChange}
            symbol={assetSymbol}
            unavailableMessage={generatorUnavailableMessage}
            validateAddress={isValidEvmAddress}
          />

          <div className="action-group" aria-label="分发统计">
            <Badge variant="outline">有效 {parsed.validRows.length}</Badge>
            <Badge variant="outline">合计 {parsed.total} {assetSymbol}</Badge>
            <Badge variant={invalidCount > 0 ? "destructive" : "outline"}>需修正 {invalidCount}</Badge>
            <Badge variant={duplicateCount > 0 ? "destructive" : "outline"}>重复 {duplicateCount}</Badge>
          </div>

          {networkState.verifiedChainIds.includes(selectedNetwork.chainId) ? (
            <ConfirmActionDialog
              confirmLabel="移除链配置"
              description={(
                <div className="summary-list">
                  <div><span>网络</span><strong>{selectedNetwork.label}</strong></div>
                  <div><span>Chain ID</span><strong>{selectedNetwork.chainId}</strong></div>
                </div>
              )}
              disabled={pageControlsLocked}
              onConfirm={removeSelectedVerifiedNetwork}
              title="移除此链配置"
              triggerLabel="移除此链配置"
              triggerVariant="destructive"
            />
          ) : null}

          <EvmGasSettings
            disabled={pageControlsLocked}
            feeEstimate={preflightState.result ? `${formatWei(preflightState.result.estimatedNetworkFeeWei, selectedNetwork.nativeCurrency.decimals)} ${selectedNetwork.nativeCurrency.symbol}` : "预检后显示"}
            gas={gas}
            onSettingsChange={resetConfirmation}
          />
        </WorkbenchPanel>

        <ReviewPanel
          autoOpen={reviewShouldOpen}
          className="review-panel"
          stateKey={`${preflightState.status}:${sendState.status}:${sendState.signatures.length > 0 ? "submitted" : "local"}`}
          summary={<Badge variant={reviewHasRisk ? "destructive" : "outline"}>{reviewSummaryLabel}</Badge>}
          title={sendState.signatures.length > 0 || sendComplete || sendFailed ? "分发结果" : confirmVisible ? "预检结果" : "清单预览"}
        >
          {preflightState.status !== "idle" && sendState.status === "idle" ? (
            <Alert variant={preflightFailed ? "destructive" : "default"}>
              <AlertTitle>{preflightFailed ? "预检未通过" : preflighting ? "正在预检" : "预检通过"}</AlertTitle>
              <AlertDescription>{preflightState.message}</AlertDescription>
            </Alert>
          ) : null}
          {sendState.status !== "idle" ? (
            <Alert variant={sendFailed ? "destructive" : "default"}>
              <AlertTitle>{sendComplete ? "分发已完成" : sendFailed ? "分发未完成" : sendState.status === "awaiting-wallet" ? "等待钱包签名" : "交易处理中"}</AlertTitle>
              <AlertDescription>{sendState.message}</AlertDescription>
            </Alert>
          ) : null}
          {preflightState.result ? (
            <div className="summary-list" aria-label="预检摘要">
              <div><span>资产余额</span><strong>{formatWei(preflightState.result.assetBalanceWei, assetDecimals)} {assetSymbol}</strong></div>
              <div><span>网络费</span><strong>{formatWei(preflightState.result.estimatedNetworkFeeWei, selectedNetwork.nativeCurrency.decimals)} {selectedNetwork.nativeCurrency.symbol}</strong></div>
              <div><span>授权 / 交易</span><strong>{preflightState.result.needsApproval ? "1" : "0"} / {preflightState.result.totalTransactions}</strong></div>
            </div>
          ) : null}
          {sendState.progress.total > 0 ? (
            <>
              <ExecutionProgress current={sendState.progress.confirmed} label="交易确认进度" total={sendState.progress.total} />
              <div className="action-group" aria-label="交易进度详情">
                <Badge variant="outline">已签名 {sendState.progress.signed}/{sendState.progress.total}</Badge>
                <Badge variant="outline">已提交 {sendState.progress.submitted}/{sendState.progress.total}</Badge>
              </div>
            </>
          ) : null}
          {sendState.signatures.length > 0 ? (
            <ResultTable<{ hash: string; index: number }>
              caption="EVM 分发交易结果"
              columns={[
                {
                  header: "交易",
                  key: "type",
                  render: (row) => sendState.progress.total === 2 && row.index === 0 ? "授权" : "分发"
                },
                {
                  header: "哈希",
                  key: "hash",
                  render: (row) => {
                    const explorerUrl = getEvmExplorerUrl(row.hash, selectedNetwork);
                    return explorerUrl
                      ? <a className="hash" href={explorerUrl} rel="noreferrer" target="_blank" title={row.hash}>{shortenAddress(row.hash)}</a>
                      : <span className="hash" title={row.hash}>{shortenAddress(row.hash)}</span>;
                  }
                },
                {
                  header: "状态",
                  key: "status",
                  render: (row) => {
                    const confirmed = sendComplete || row.index < sendState.progress.confirmed;
                    return <Badge variant={sendFailed && !confirmed ? "destructive" : "outline"}>{confirmed ? "已确认" : sendFailed ? "待核对" : "已提交"}</Badge>;
                  }
                }
              ]}
              getRowKey={(row) => row.hash}
              rows={sendState.signatures.map((hash, index) => ({ hash, index }))}
            />
          ) : (
            <ResultTable<DistributionRow>
              caption="EVM 分发清单预览与预检结果"
              columns={[
                {
                  header: "地址",
                  key: "address",
                  render: (row) => <span className="address" title={row.address}>{shortenAddress(row.address)}</span>
                },
                {
                  header: "金额",
                  key: "amount",
                  render: (row) => <span className="amount">{formatWei(row.lamports, assetDecimals)} {assetSymbol}</span>
                },
                {
                  header: "状态",
                  key: "status",
                  render: (row) => {
                    const rowBlocked = row.status !== "valid" || preflightFailed || sendFailed;
                    const label = row.status !== "valid"
                      ? "需修正"
                      : preflightFailed || sendFailed
                        ? "已阻断"
                        : preflighting
                          ? "预检中"
                          : sending
                            ? "处理中"
                            : preflightState.status === "success"
                              ? "可发送"
                              : "待预检";
                    return <Badge variant={rowBlocked ? "destructive" : "outline"}>{label}</Badge>;
                  }
                }
              ]}
              emptyLabel="暂无清单"
              getRowKey={(row) => `${row.line}-${row.address}`}
              rows={reviewRows}
            />
          )}
          {unresolvedSubmission ? (
            <Alert>
              <AlertTitle>不可安全整批重试</AlertTitle>
              <AlertDescription>已有交易提交到链上。请先核对交易哈希，再创建空白任务。</AlertDescription>
            </Alert>
          ) : null}
        </ReviewPanel>
      </div>
    </ToolPageLayout>
  );
}
