import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EvmGasBadge, EvmGasSettings } from "../components/EvmGasControl";
import { EvmWalletConnectionControl } from "../components/EvmWalletConnectionControl";
import { SearchableSelect } from "../components/SearchableSelect";
import { ToolPageLayout, type WorkbenchStatus } from "../components/ToolPageLayout";
import {
  AdvancedSettings,
  ConfirmActionDialog,
  ExecutionProgress,
  ReviewPanel,
  ResultTable,
  WorkbenchPanel
} from "../components/WorkbenchPrimitives";
import { useEvmGas } from "../hooks/useEvmGas";
import { useEvmWallet } from "../hooks/useEvmWallet";
import { shortenAddress } from "../lib/address";
import {
  createXContractAddress,
  deployDisperseContract,
  disperseDeploymentCheckDefinitions,
  DisperseDeploymentValidationError,
  finalizeDisperseDeploymentNetwork,
  getDisperseDeploymentErrorMessage,
  getDisperseDeploymentExplorerUrl,
  resolveDisperseDeploymentNetwork,
  runDisperseDeploymentValidation,
  type DisperseDeploymentCheck,
  type DisperseDeploymentNetworkMetadataCandidate,
  type DisperseDeploymentNetworkDiscovery,
  type DisperseDeploymentPreflight
} from "../lib/createx";
import {
  disperseContractAddress,
  evmNetworks,
  formatWeiForDisplay,
  getEvmNativeCurrencyMetadata,
  isEvmNativeCurrencyEnabled,
  registerVerifiedEvmDistributionNetwork,
  unconfirmedEvmNativeCurrency,
  type EvmChainConfig,
  type EvmDistributionNetworkId
} from "../lib/evm";

type DeploymentPageStatus =
  | "idle"
  | "validating"
  | "ready"
  | "awaiting-wallet"
  | "confirming"
  | "success"
  | "already-deployed"
  | "error";

export function getDeploymentSafetyState(status: DeploymentPageStatus, hash: string) {
  const deploymentComplete = status === "success" || status === "already-deployed";
  const submittedButUncertain = status === "error" && Boolean(hash);
  const workbenchStatus: WorkbenchStatus = submittedButUncertain
    ? "uncertain"
    : deploymentComplete
      ? "success"
      : status === "error"
        ? "error"
        : status === "validating"
          ? "preflight"
          : status === "ready"
            ? "ready"
            : status === "awaiting-wallet" || status === "confirming"
              ? "running"
              : "editing";

  return {
    canRetryValidation: (status === "idle" || status === "error") && !submittedButUncertain && !deploymentComplete,
    deploymentComplete,
    submittedButUncertain,
    workbenchStatus
  };
}

type DeploymentPageState = {
  checks: DisperseDeploymentCheck[];
  contextKey: string;
  hash: string;
  message: string;
  network: EvmChainConfig | null;
  preflight: DisperseDeploymentPreflight | null;
  status: DeploymentPageStatus;
};

type DistributionRegistrationState = {
  message: string;
  status: "idle" | "success" | "error";
};

type CustomNetworkMetadataState = {
  chainName: string;
  nativeCurrencyDecimals: string;
  nativeCurrencyName: string;
  nativeCurrencySymbol: string;
};

const initialDeploymentState: DeploymentPageState = {
  checks: [],
  contextKey: "",
  hash: "",
  message: "",
  network: null,
  preflight: null,
  status: "idle"
};

const initialDistributionRegistrationState: DistributionRegistrationState = {
  message: "",
  status: "idle"
};

const initialCustomNetworkMetadataState: CustomNetworkMetadataState = {
  chainName: "",
  nativeCurrencyDecimals: "",
  nativeCurrencyName: "",
  nativeCurrencySymbol: ""
};

function customNetworkMetadataIsComplete(metadata: CustomNetworkMetadataState) {
  const decimals = metadata.nativeCurrencyDecimals.trim();
  return Boolean(
    metadata.chainName.trim()
    && metadata.nativeCurrencyName.trim()
    && metadata.nativeCurrencySymbol.trim()
    && /^\d+$/.test(decimals)
    && Number(decimals) <= 255
  );
}

function getPendingCheckDetail(id: DisperseDeploymentCheck["id"], status: DeploymentPageStatus) {
  if (id === "receipt" || id === "runtime") return "部署交易确认后执行";
  if (status === "validating") return "等待前序校验";
  return "—";
}

function isOptionalHttpsUrl(value: string) {
  if (!value) return true;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function EvmContractDeployPage() {
  const [networkSource, setNetworkSource] = useState<"known" | "custom">("known");
  const [knownNetworkId, setKnownNetworkId] = useState<EvmDistributionNetworkId>(evmNetworks[0].id);
  const [rpcEndpoint, setRpcEndpoint] = useState(evmNetworks[0].rpcEndpoint);
  const [blockExplorerUrl, setBlockExplorerUrl] = useState(evmNetworks[0].blockExplorerUrl);
  const [networkDiscovery, setNetworkDiscovery] = useState<DisperseDeploymentNetworkDiscovery | null>(null);
  const [manualMetadataOverride, setManualMetadataOverride] = useState(false);
  const [nativeMetadataConfirmed, setNativeMetadataConfirmed] = useState(false);
  const [selectedMetadataCandidateKey, setSelectedMetadataCandidateKey] = useState("");
  const [customNetworkMetadata, setCustomNetworkMetadata] = useState<CustomNetworkMetadataState>(initialCustomNetworkMetadataState);
  const [deploymentState, setDeploymentState] = useState<DeploymentPageState>(initialDeploymentState);
  const [distributionChainName, setDistributionChainName] = useState("");
  const [distributionRegistration, setDistributionRegistration] = useState<DistributionRegistrationState>(initialDistributionRegistrationState);
  const wallet = useEvmWallet();

  const knownNetworkOptions = useMemo(() => evmNetworks.map((network) => ({
    keywords: [network.id, network.nativeCurrency.name, network.nativeCurrency.symbol],
    label: network.label,
    meta: String(network.chainId),
    value: network.id
  })), []);
  const selectedKnownNetwork = useMemo(
    () => evmNetworks.find((network) => network.id === knownNetworkId) || evmNetworks[0],
    [knownNetworkId]
  );

  const effectiveRpcEndpoint = rpcEndpoint.trim();
  const effectiveBlockExplorerUrl = blockExplorerUrl.trim().replace(/\/+$/, "");
  const blockExplorerUrlIsValid = isOptionalHttpsUrl(effectiveBlockExplorerUrl);
  const gasNetwork = useMemo<EvmChainConfig>(() => {
    if (networkSource === "known" || !networkDiscovery) return selectedKnownNetwork;
    return {
      blockExplorerUrl: networkDiscovery.blockExplorerUrl,
      chainId: networkDiscovery.chainId,
      label: networkDiscovery.label,
      nativeCurrency: networkDiscovery.nativeCurrency || unconfirmedEvmNativeCurrency,
      rpcEndpoint: networkDiscovery.rpcEndpoint
    };
  }, [networkDiscovery, networkSource, selectedKnownNetwork]);
  const gas = useEvmGas({
    enabled: networkSource === "known" || Boolean(networkDiscovery),
    network: gasNetwork,
    rpcEndpoint: effectiveRpcEndpoint
  });
  const gasContextKey = gas.settingsKey;
  const metadataContextKey = [
    customNetworkMetadata.chainName.trim(),
    customNetworkMetadata.nativeCurrencyName.trim(),
    customNetworkMetadata.nativeCurrencySymbol.trim(),
    customNetworkMetadata.nativeCurrencyDecimals.trim()
  ].join("|");
  const contextKey = `${wallet.address.toLowerCase()}|${effectiveRpcEndpoint}|${effectiveBlockExplorerUrl}|${manualMetadataOverride}|${nativeMetadataConfirmed}|${selectedMetadataCandidateKey}|${metadataContextKey}|${gasContextKey}`;
  const latestContextKeyRef = useRef(contextKey);
  const operationIdRef = useRef(0);
  useLayoutEffect(() => {
    latestContextKeyRef.current = contextKey;
  }, [contextKey]);
  const stateIsCurrent = deploymentState.contextKey === contextKey;
  const status = stateIsCurrent ? deploymentState.status : "idle";
  const checks = stateIsCurrent ? deploymentState.checks : [];
  const preflight = stateIsCurrent ? deploymentState.preflight : null;
  const hash = stateIsCurrent ? deploymentState.hash : "";
  const message = stateIsCurrent ? deploymentState.message : initialDeploymentState.message;
  const network = stateIsCurrent ? deploymentState.network : null;
  const displayNetwork = network || networkDiscovery || (networkSource === "known" ? selectedKnownNetwork : null);
  const automaticRegistryMetadata = networkDiscovery?.metadataSource === "viem"
    && networkDiscovery.metadataStatus === "suggested"
    && networkDiscovery.nativeCurrency
    && !manualMetadataOverride
    ? networkDiscovery
    : null;
  const automaticRegistryCurrency = automaticRegistryMetadata?.nativeCurrency || null;
  const metadataConflict = networkDiscovery?.metadataStatus === "conflict" ? networkDiscovery : null;
  const metadataUnavailable = networkDiscovery?.metadataStatus === "unavailable" ? networkDiscovery : null;
  const customMetadataReady = customNetworkMetadataIsComplete(customNetworkMetadata);
  const provider = wallet.getProvider();
  const busy = status === "validating" || status === "awaiting-wallet" || status === "confirming";
  const safetyState = getDeploymentSafetyState(status, hash);
  const submittedButUncertain = safetyState.submittedButUncertain;
  const canValidate = wallet.connected
    && Boolean(wallet.address)
    && Boolean(provider)
    && Boolean(effectiveRpcEndpoint)
    && blockExplorerUrlIsValid
    && Boolean(gas.gasSettings)
    && !busy;
  const canDeploy = canValidate && status === "ready";
  const deploymentComplete = safetyState.deploymentComplete;
  const configurationLocked = busy || deploymentComplete || submittedButUncertain;
  const explorerUrl = hash && network ? getDisperseDeploymentExplorerUrl(hash, network) : "";
  const nativeCurrencyEnabled = network ? isEvmNativeCurrencyEnabled(network) : false;
  const nativeCurrencyMetadata = network ? getEvmNativeCurrencyMetadata(network) : null;
  const estimatedFee = preflight && preflight.estimatedFee > 0n && network
    ? nativeCurrencyEnabled
      ? `${formatWeiForDisplay(preflight.estimatedFee, network.nativeCurrency.decimals, 8)} ${network.nativeCurrency.symbol}`
      : `${preflight.estimatedFee.toLocaleString()} base units`
    : "--";
  const workbenchStatus = safetyState.workbenchStatus;
  const workbenchStatusLabel = submittedButUncertain
    ? "交易状态待确认"
    : status === "already-deployed"
      ? "合约已存在"
      : status === "awaiting-wallet"
        ? "等待钱包签名"
        : status === "confirming"
          ? "链上验证中"
          : undefined;
  const reviewHasRisk = status === "error";
  const reviewShouldOpen = reviewHasRisk || Boolean(hash);
  const reviewSummaryLabel = submittedButUncertain
    ? "链上状态待核对"
    : status === "already-deployed"
      ? "合约已存在"
      : status === "success"
        ? "部署完成"
        : status === "ready"
          ? "校验通过"
          : status === "validating"
            ? `校验中 · ${checks.length}/${disperseDeploymentCheckDefinitions.length}`
            : status === "awaiting-wallet"
              ? "等待钱包签名"
              : status === "confirming"
                ? "链上验证中"
                : status === "error"
                  ? "校验未通过"
                  : "尚未校验";

  const isOperationCurrent = (operationId: number, expectedContextKey: string) => (
    operationIdRef.current === operationId && latestContextKeyRef.current === expectedContextKey
  );

  const resetDeploymentState = () => {
    operationIdRef.current += 1;
    setDeploymentState(initialDeploymentState);
    setDistributionChainName("");
    setDistributionRegistration(initialDistributionRegistrationState);
  };

  const resetDiscoveredNetwork = () => {
    setNetworkDiscovery(null);
    setManualMetadataOverride(false);
    setNativeMetadataConfirmed(false);
    setSelectedMetadataCandidateKey("");
    setCustomNetworkMetadata(initialCustomNetworkMetadataState);
    resetDeploymentState();
  };

  const selectKnownNetwork = (nextNetworkId: EvmDistributionNetworkId) => {
    const nextNetwork = evmNetworks.find((item) => item.id === nextNetworkId) || evmNetworks[0];
    setKnownNetworkId(nextNetwork.id);
    setRpcEndpoint(nextNetwork.rpcEndpoint);
    setBlockExplorerUrl(nextNetwork.blockExplorerUrl);
    resetDiscoveredNetwork();
  };

  const selectNetworkSource = (nextSource: "known" | "custom") => {
    if (nextSource === networkSource) return;
    setNetworkSource(nextSource);
    if (nextSource === "known") {
      const nextNetwork = evmNetworks.find((item) => item.id === knownNetworkId) || evmNetworks[0];
      setRpcEndpoint(nextNetwork.rpcEndpoint);
      setBlockExplorerUrl(nextNetwork.blockExplorerUrl);
    } else {
      setRpcEndpoint("");
      setBlockExplorerUrl("");
    }
    resetDiscoveredNetwork();
  };

  const enableManualMetadataOverride = () => {
    if (!networkDiscovery) return;
    setCustomNetworkMetadata({
      chainName: networkDiscovery.label,
      nativeCurrencyDecimals: networkDiscovery.nativeCurrency ? String(networkDiscovery.nativeCurrency.decimals) : "",
      nativeCurrencyName: networkDiscovery.nativeCurrency?.name || "",
      nativeCurrencySymbol: networkDiscovery.nativeCurrency?.symbol || ""
    });
    setManualMetadataOverride(true);
    setNativeMetadataConfirmed(false);
    setSelectedMetadataCandidateKey("");
    resetDeploymentState();
  };

  const restoreAutomaticMetadata = () => {
    setManualMetadataOverride(false);
    setNativeMetadataConfirmed(false);
    setSelectedMetadataCandidateKey("");
    setCustomNetworkMetadata(initialCustomNetworkMetadataState);
    resetDeploymentState();
  };

  const confirmManualMetadata = () => {
    if (!customMetadataReady) return;
    setNativeMetadataConfirmed(true);
    resetDeploymentState();
  };

  const selectMetadataCandidate = (candidate: DisperseDeploymentNetworkMetadataCandidate) => {
    setCustomNetworkMetadata({
      chainName: candidate.label,
      nativeCurrencyDecimals: String(candidate.nativeCurrency.decimals),
      nativeCurrencyName: candidate.nativeCurrency.name,
      nativeCurrencySymbol: candidate.nativeCurrency.symbol
    });
    setManualMetadataOverride(true);
    setNativeMetadataConfirmed(true);
    setSelectedMetadataCandidateKey(candidate.key);
    resetDeploymentState();
  };

  const updateCurrentOperation = (
    operationId: number,
    expectedContextKey: string,
    update: (current: DeploymentPageState) => DeploymentPageState
  ) => {
    if (!isOperationCurrent(operationId, expectedContextKey)) return;
    setDeploymentState((current) => (
      isOperationCurrent(operationId, expectedContextKey) && current.contextKey === expectedContextKey
        ? update(current)
        : current
    ));
  };

  const updateChecks = (
    nextChecks: DisperseDeploymentCheck[],
    expectedContextKey: string,
    operationId: number
  ) => {
    updateCurrentOperation(operationId, expectedContextKey, (current) => ({ ...current, checks: nextChecks }));
  };

  const runValidation = async () => {
    const walletProvider = wallet.getProvider();
    const gasSettings = gas.gasSettings;
    if (!wallet.connected || !wallet.address || !walletProvider || !gasSettings) return;

    const expectedContextKey = contextKey;
    const operationId = operationIdRef.current + 1;
    operationIdRef.current = operationId;
    setDistributionChainName("");
    setDistributionRegistration(initialDistributionRegistrationState);
    setDeploymentState({
      checks: [],
      contextKey: expectedContextKey,
      hash: "",
      message: "正在从 RPC 读取 Chain ID",
      network: null,
      preflight: null,
      status: "validating"
    });

    try {
      const discoveredNetwork = await resolveDisperseDeploymentNetwork(effectiveRpcEndpoint);
      if (!isOperationCurrent(operationId, expectedContextKey)) return;
      setNetworkDiscovery(discoveredNetwork);

      const resolvedNetwork = finalizeDisperseDeploymentNetwork(
        discoveredNetwork,
        effectiveBlockExplorerUrl || discoveredNetwork.blockExplorerUrl,
        {
          manualMetadata: customNetworkMetadata,
          nativeCurrencyConfirmed: nativeMetadataConfirmed,
          selectedCandidateKey: selectedMetadataCandidateKey,
          useManualMetadata: manualMetadataOverride
        }
      );

      setDistributionChainName(resolvedNetwork.label);
      updateCurrentOperation(operationId, expectedContextKey, (current) => ({
        ...current,
        message: isEvmNativeCurrencyEnabled(resolvedNetwork)
          ? `已识别 ${resolvedNetwork.label}，正在检查 CreateX 与目标合约`
          : `已识别 Chain ID ${resolvedNetwork.chainId}；原生币暂未开放，继续检查部署与 Token 分发条件`,
        network: resolvedNetwork
      }));

      const nextPreflight = await runDisperseDeploymentValidation({
        account: wallet.address,
        gasSettings,
        network: resolvedNetwork,
        onChecks: (nextChecks) => updateChecks(nextChecks, expectedContextKey, operationId),
        provider: walletProvider,
        rpcEndpoint: effectiveRpcEndpoint,
        shouldContinue: () => isOperationCurrent(operationId, expectedContextKey)
      });

      if (!isOperationCurrent(operationId, expectedContextKey)) return;
      setDeploymentState({
        checks: nextPreflight.checks,
        contextKey: expectedContextKey,
        hash: "",
        message: nextPreflight.status === "already-deployed"
          ? `${resolvedNetwork.label} 已经部署并通过官方 runtime hash 校验`
          : "全部部署前校验通过",
        network: resolvedNetwork,
        preflight: nextPreflight,
        status: nextPreflight.status === "already-deployed" ? "already-deployed" : "ready"
      });
    } catch (error) {
      updateCurrentOperation(operationId, expectedContextKey, (current) => ({
        ...current,
        checks: error instanceof DisperseDeploymentValidationError ? error.checks : current.checks,
        message: getDisperseDeploymentErrorMessage(error),
        preflight: null,
        status: "error"
      }));
    }
  };

  const deployContract = async () => {
    const walletProvider = wallet.getProvider();
    const gasSettings = gas.gasSettings;
    if (!canDeploy || !wallet.address || !walletProvider || !network || !gasSettings) return;

    const expectedContextKey = contextKey;
    const operationId = operationIdRef.current + 1;
    operationIdRef.current = operationId;
    setDeploymentState((current) => ({
      ...current,
      contextKey: expectedContextKey,
      hash: "",
      message: "签名前正在重新执行全部部署校验",
      status: "validating"
    }));

    try {
      const result = await deployDisperseContract({
        account: wallet.address,
        gasSettings,
        network,
        onChecks: (nextChecks) => updateChecks(nextChecks, expectedContextKey, operationId),
        shouldContinue: () => isOperationCurrent(operationId, expectedContextKey),
        onStage: (stage) => {
          if (stage.type === "awaiting-wallet") {
            updateCurrentOperation(operationId, expectedContextKey, (current) => ({
              ...current,
              message: "校验通过，请在钱包中确认零转账金额的 CreateX 部署调用",
              preflight: stage.preflight,
              status: "awaiting-wallet"
            }));
            return;
          }

          if (stage.type === "submitted") {
            updateCurrentOperation(operationId, expectedContextKey, (current) => ({
              ...current,
              hash: stage.hash,
              message: "部署交易已提交，正在等待链上确认",
              status: "confirming"
            }));
            return;
          }

          if (stage.type === "confirmed") {
            updateCurrentOperation(operationId, expectedContextKey, (current) => ({
              ...current,
              hash: stage.hash,
              message: "交易回执和 CreateX 事件已通过，正在校验最终 runtime hash",
              status: "confirming"
            }));
            return;
          }

          updateCurrentOperation(operationId, expectedContextKey, (current) => ({
            ...current,
            hash: stage.hash,
            message: "Disperse 已部署并通过最终 runtime hash 校验",
            status: "confirming"
          }));
        },
        provider: walletProvider,
        rpcEndpoint: effectiveRpcEndpoint
      });

      if (!isOperationCurrent(operationId, expectedContextKey)) return;
      if (result.alreadyDeployed) {
        setDeploymentState({
          checks: result.preflight.checks,
          contextKey: expectedContextKey,
          hash: "",
          message: `${network.label} 已经部署并通过官方 runtime hash 校验`,
          network,
          preflight: result.preflight,
          status: "already-deployed"
        });
        return;
      }

      updateCurrentOperation(operationId, expectedContextKey, (current) => ({
        ...current,
        checks: result.preflight.checks,
        hash: result.hash,
        message: "Disperse 已部署，交易回执、事件和官方 runtime hash 全部通过",
        preflight: result.preflight,
        status: "success"
      }));
    } catch (error) {
      updateCurrentOperation(operationId, expectedContextKey, (current) => ({
        ...current,
        checks: error instanceof DisperseDeploymentValidationError ? error.checks : current.checks,
        message: getDisperseDeploymentErrorMessage(error),
        status: "error"
      }));
    }
  };

  const addToEvmDistribution = () => {
    const chainName = distributionChainName.trim();
    if (!deploymentComplete || !network) return;
    if (!chainName) {
      setDistributionRegistration({ message: "请先填写链名称", status: "error" });
      return;
    }

    const registeredNetwork = registerVerifiedEvmDistributionNetwork({ ...network, label: chainName });
    setDistributionRegistration(registeredNetwork
      ? {
          message: isEvmNativeCurrencyEnabled(registeredNetwork)
            ? `${chainName} · Chain ID ${network.chainId} 已添加，可分发 Token 和 ${registeredNetwork.nativeCurrency.symbol}`
            : `${chainName} · Chain ID ${network.chainId} 已添加，当前仅开放 Token 分发`,
          status: "success"
        }
      : { message: "浏览器未能保存链配置，请检查本地存储权限", status: "error" });
  };

  return (
    <ToolPageLayout
      actions={(
        <>
          <EvmGasBadge gas={gas} />
          <EvmWalletConnectionControl disabled={configurationLocked} wallet={wallet} />
          {status !== "idle" ? (
            <ConfirmActionDialog
              confirmLabel="新建部署任务"
              description={hash
                ? "当前任务已产生交易哈希。请先核验链上状态；清空只会删除本地任务记录，不会撤销交易，也不代表可以安全重试。"
                : "当前部署校验与本地结果将被清除，网络选择将保留。"}
              disabled={busy}
              onConfirm={resetDeploymentState}
              title="清空并新建部署任务？"
              triggerLabel="新建部署任务"
              triggerVariant="destructive"
            />
          ) : null}
        </>
      )}
      className="page-deploy"
      currentToolId="evm-contract-deploy"
      status={workbenchStatus}
      statusLabel={workbenchStatusLabel}
      title="CreateX 合约部署"
    >
      <div className="workbench-grid">
        <WorkbenchPanel
          actions={<Badge variant="outline">{displayNetwork ? `${displayNetwork.label} · ${displayNetwork.chainId}` : "网络待校验"}</Badge>}
          className="deploy-panel"
          footer={(
            <div className="actions">
              <span className="hint" role="status">{!wallet.connected ? "请连接部署钱包" : !effectiveRpcEndpoint ? "请输入 HTTPS RPC" : status === "ready" ? "部署参数已就绪" : ""}</span>
              <div className="action-group">
                {safetyState.canRetryValidation ? (
                  <Button disabled={!canValidate || deploymentComplete} onClick={() => void runValidation()} type="button">
                    {status === "error" ? "重新校验" : "校验部署条件"}
                  </Button>
                ) : null}
                {busy ? <Button disabled type="button">{status === "validating" ? "校验中" : status === "awaiting-wallet" ? "等待钱包签名" : "链上验证中"}</Button> : null}
                {status === "ready" && network && preflight ? (
                  <>
                    <ConfirmActionDialog
                      confirmLabel="签名并部署"
                      description={(
                        <div className="summary-list">
                          <div><span>网络</span><strong>{network.label} · {network.chainId}</strong></div>
                          <div><span>部署方式</span><strong>CreateX.deployCreate2(bytes32,bytes)</strong></div>
                          <div><span>CreateX</span><strong title={createXContractAddress}>{shortenAddress(createXContractAddress)}</strong></div>
                          <div><span>目标地址</span><strong title={disperseContractAddress}>{disperseContractAddress}</strong></div>
                          <div><span>交易 value</span><strong>0</strong></div>
                          <div><span>Gas 估算</span><strong>{preflight.estimatedGas.toLocaleString()}</strong></div>
                          <div><span>Gas 上限</span><strong>{preflight.gasLimit.toLocaleString()}</strong></div>
                          <div><span>执行费上限</span><strong>{estimatedFee}</strong></div>
                        </div>
                      )}
                      disabled={!canDeploy}
                      onConfirm={deployContract}
                      title="确认 CreateX 部署"
                      triggerLabel="确认部署"
                    />
                    <Button disabled={busy} onClick={() => void runValidation()} type="button" variant="outline">重新校验</Button>
                  </>
                ) : null}
              </div>
            </div>
          )}
          title="部署配置"
        >
          <Tabs
            aria-label="网络来源"
            onValueChange={(value) => {
              if (value === "known" || value === "custom") selectNetworkSource(value);
            }}
            value={networkSource}
          >
            <TabsList>
              <TabsTrigger disabled={configurationLocked} value="known">已知网络</TabsTrigger>
              <TabsTrigger disabled={configurationLocked} value="custom">自定义 RPC</TabsTrigger>
            </TabsList>
            <TabsContent value="known">
              <Field>
                <FieldLabel htmlFor="deployKnownNetwork">网络</FieldLabel>
                <SearchableSelect
                  disabled={configurationLocked}
                  emptyMessage="未找到匹配的 EVM 链"
                  id="deployKnownNetwork"
                  listboxLabel="已知 EVM 网络"
                  metaLabel="Chain ID"
                  metaPrefix="ID "
                  onChange={selectKnownNetwork}
                  options={knownNetworkOptions}
                  placeholder="搜索链名称或 Chain ID"
                  searchLabel="搜索已知 EVM 网络"
                  value={knownNetworkId}
                />
              </Field>
            </TabsContent>
            <TabsContent value="custom">
              <Field>
                <FieldLabel htmlFor="deployCustomRpcEndpoint">HTTPS RPC</FieldLabel>
                <Input
                  autoComplete="off"
                  disabled={configurationLocked}
                  id="deployCustomRpcEndpoint"
                  inputMode="url"
                  onChange={(event) => {
                    setRpcEndpoint(event.target.value);
                    resetDiscoveredNetwork();
                  }}
                  placeholder="https://your-evm-rpc.example"
                  spellCheck={false}
                  type="url"
                  value={rpcEndpoint}
                />
              </Field>
            </TabsContent>
          </Tabs>

          <AdvancedSettings disabled={configurationLocked} label="RPC、Gas、浏览器与链元数据">
            <EvmGasSettings
              disabled={configurationLocked}
              gas={gas}
              onSettingsChange={resetDeploymentState}
            />
            {networkSource === "known" ? (
              <Field>
                <FieldLabel htmlFor="deployKnownRpcEndpoint">HTTPS RPC</FieldLabel>
                <Input
                  autoComplete="off"
                  disabled={configurationLocked}
                  id="deployKnownRpcEndpoint"
                  inputMode="url"
                  readOnly
                  spellCheck={false}
                  type="url"
                  value={rpcEndpoint}
                />
              </Field>
            ) : null}
            <Field data-invalid={!blockExplorerUrlIsValid || undefined}>
              <FieldLabel htmlFor="deployBlockExplorerUrl">区块浏览器地址</FieldLabel>
              <Input
                aria-invalid={!blockExplorerUrlIsValid || undefined}
                autoComplete="off"
                disabled={configurationLocked}
                id="deployBlockExplorerUrl"
                inputMode="url"
                onChange={(event) => {
                  setBlockExplorerUrl(event.target.value);
                  resetDeploymentState();
                }}
                placeholder="https://scan.example.com"
                spellCheck={false}
                type="url"
                value={blockExplorerUrl}
              />
              {!blockExplorerUrlIsValid ? <FieldError>区块浏览器地址必须是 HTTPS URL</FieldError> : null}
            </Field>

            {automaticRegistryMetadata && automaticRegistryCurrency ? (
              <Alert>
                <AlertTitle>已匹配 {automaticRegistryMetadata.label}</AlertTitle>
                <AlertDescription>
                  <div className="summary-list">
                    <div><span>原生币</span><strong>{automaticRegistryCurrency.symbol} · {automaticRegistryCurrency.decimals} decimals</strong></div>
                    <div><span>来源</span><strong>viem {automaticRegistryMetadata.sourceVersion}</strong></div>
                  </div>
                </AlertDescription>
                <Button disabled={configurationLocked} onClick={enableManualMetadataOverride} type="button" variant="outline">手动修改</Button>
              </Alert>
            ) : null}

            {metadataConflict && !manualMetadataOverride ? (
              <>
                <Alert variant="destructive">
                  <AlertTitle>原生币元数据存在冲突</AlertTitle>
                  <AlertDescription>请选择一项或手动填写。</AlertDescription>
                </Alert>
                <ResultTable<DisperseDeploymentNetworkMetadataCandidate>
                  caption="原生币元数据候选"
                  columns={[
                    { header: "网络", key: "network", render: (candidate) => candidate.label },
                    { header: "原生币", key: "currency", render: (candidate) => `${candidate.nativeCurrency.symbol} · ${candidate.nativeCurrency.decimals}` },
                    {
                      header: "操作",
                      key: "action",
                      render: (candidate) => (
                        <Button
                          aria-label={`选择并确认 ${candidate.label} ${candidate.nativeCurrency.symbol}`}
                          disabled={configurationLocked}
                          onClick={() => selectMetadataCandidate(candidate)}
                          size="sm"
                          type="button"
                          variant="outline"
                        >选择并确认</Button>
                      )
                    }
                  ]}
                  getRowKey={(candidate) => candidate.key}
                  rows={metadataConflict.metadataCandidates}
                />
                <Button disabled={configurationLocked} onClick={enableManualMetadataOverride} type="button" variant="outline">手动填写</Button>
              </>
            ) : null}

            {metadataUnavailable && !manualMetadataOverride ? (
              <Alert>
                <AlertTitle>未找到原生币元数据</AlertTitle>
                <AlertDescription>Chain ID {metadataUnavailable.chainId} 当前仅注册 Token 分发能力。</AlertDescription>
                <Button disabled={configurationLocked} onClick={enableManualMetadataOverride} type="button" variant="outline">配置原生币</Button>
              </Alert>
            ) : null}

            {networkDiscovery && manualMetadataOverride ? (
              <FieldGroup aria-label="自定义链元数据">
                <div className="field-row">
                  <Field>
                    <FieldLabel htmlFor="customChainName">链名称</FieldLabel>
                    <Input
                      autoComplete="off"
                      disabled={configurationLocked}
                      id="customChainName"
                      onChange={(event) => {
                        setCustomNetworkMetadata((current) => ({ ...current, chainName: event.target.value }));
                        setNativeMetadataConfirmed(false);
                        setSelectedMetadataCandidateKey("");
                        resetDeploymentState();
                      }}
                      placeholder={`EVM Chain ${networkDiscovery.chainId}`}
                      type="text"
                      value={customNetworkMetadata.chainName}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="nativeCurrencyName">原生币名称</FieldLabel>
                    <Input
                      autoComplete="off"
                      disabled={configurationLocked}
                      id="nativeCurrencyName"
                      onChange={(event) => {
                        setCustomNetworkMetadata((current) => ({ ...current, nativeCurrencyName: event.target.value }));
                        setNativeMetadataConfirmed(false);
                        setSelectedMetadataCandidateKey("");
                        resetDeploymentState();
                      }}
                      type="text"
                      value={customNetworkMetadata.nativeCurrencyName}
                    />
                  </Field>
                </div>
                <div className="field-row">
                  <Field>
                    <FieldLabel htmlFor="nativeCurrencySymbol">原生币符号</FieldLabel>
                    <Input
                      autoComplete="off"
                      disabled={configurationLocked}
                      id="nativeCurrencySymbol"
                      onChange={(event) => {
                        setCustomNetworkMetadata((current) => ({ ...current, nativeCurrencySymbol: event.target.value }));
                        setNativeMetadataConfirmed(false);
                        setSelectedMetadataCandidateKey("");
                        resetDeploymentState();
                      }}
                      type="text"
                      value={customNetworkMetadata.nativeCurrencySymbol}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="nativeCurrencyDecimals">原生币 decimals</FieldLabel>
                    <Input
                      disabled={configurationLocked}
                      id="nativeCurrencyDecimals"
                      inputMode="numeric"
                      max="255"
                      min="0"
                      onChange={(event) => {
                        setCustomNetworkMetadata((current) => ({ ...current, nativeCurrencyDecimals: event.target.value }));
                        setNativeMetadataConfirmed(false);
                        setSelectedMetadataCandidateKey("");
                        resetDeploymentState();
                      }}
                      step="1"
                      type="number"
                      value={customNetworkMetadata.nativeCurrencyDecimals}
                    />
                  </Field>
                </div>
                <div className="action-group">
                  {!nativeMetadataConfirmed ? (
                    <Button disabled={configurationLocked || !customMetadataReady} onClick={confirmManualMetadata} type="button">确认原生币元数据</Button>
                  ) : <Badge variant="outline">原生币元数据已确认</Badge>}
                  <Button disabled={configurationLocked} onClick={restoreAutomaticMetadata} type="button" variant="outline">
                    {networkDiscovery.metadataStatus === "suggested" ? "恢复注册表建议" : "暂不配置原生币"}
                  </Button>
                </div>
              </FieldGroup>
            ) : null}
          </AdvancedSettings>

          {message ? (
            <Alert variant={status === "error" ? "destructive" : "default"}>
              <AlertTitle>{status === "ready"
                ? "部署校验通过"
                : status === "success"
                  ? "部署与 runtime 验证完成"
                  : status === "already-deployed"
                    ? "合约已存在"
                    : status === "error"
                      ? submittedButUncertain ? "交易状态待确认" : "部署已阻断"
                      : "部署处理中"}</AlertTitle>
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          ) : null}

          {hash ? (
            <div className="summary-list" aria-label="部署交易">
              <div>
                <span>交易哈希</span>
                <strong title={hash}>{explorerUrl
                  ? <a href={explorerUrl} rel="noreferrer" target="_blank">{shortenAddress(hash)}</a>
                  : shortenAddress(hash)}</strong>
              </div>
            </div>
          ) : null}

          {submittedButUncertain ? (
            <Alert>
              <AlertTitle>禁止直接重试部署</AlertTitle>
              <AlertDescription>交易已提交。请先在区块浏览器或 RPC 中核对哈希与目标地址状态。</AlertDescription>
            </Alert>
          ) : null}

          {deploymentComplete && network ? (
            <FieldGroup aria-label="加入 EVM 分发">
              <Field data-invalid={distributionRegistration.status === "error" || undefined}>
                <FieldLabel htmlFor="distributionChainName">EVM 分发链名称</FieldLabel>
                <Input
                  aria-invalid={distributionRegistration.status === "error" || undefined}
                  id="distributionChainName"
                  onChange={(event) => {
                    setDistributionChainName(event.target.value);
                    setDistributionRegistration(initialDistributionRegistrationState);
                  }}
                  placeholder={network.label}
                  type="text"
                  value={distributionChainName}
                />
                {distributionRegistration.status === "error" ? <FieldError>{distributionRegistration.message}</FieldError> : null}
              </Field>
              <div className="summary-list">
                <div><span>Chain ID</span><strong>{network.chainId}</strong></div>
                <div><span>分发能力</span><strong>{nativeCurrencyEnabled ? `Token + ${network.nativeCurrency.symbol}` : "仅 Token"}</strong></div>
                <div><span>原生币依据</span><strong>{nativeCurrencyMetadata?.source === "viem"
                  ? `viem ${nativeCurrencyMetadata.sourceVersion}`
                  : nativeCurrencyMetadata?.source === "manual"
                    ? "用户手动确认"
                    : nativeCurrencyMetadata?.source === "built-in"
                      ? "项目内置配置"
                      : "未配置"}</strong></div>
              </div>
              <div className="action-group">
                <Button disabled={!distributionChainName.trim()} onClick={addToEvmDistribution} type="button">加入 EVM 分发</Button>
                <a className={buttonVariants({ variant: "outline" })} href="/evm/">前往 EVM 分发</a>
              </div>
              {distributionRegistration.status === "success" ? (
                <Alert>
                  <AlertTitle>链配置已加入</AlertTitle>
                  <AlertDescription>{distributionRegistration.message}</AlertDescription>
                </Alert>
              ) : null}
            </FieldGroup>
          ) : null}
        </WorkbenchPanel>

        <ReviewPanel
          autoOpen={reviewShouldOpen}
          className="deployment-review"
          stateKey={`${status}:${hash ? "submitted" : "local"}`}
          summary={<Badge variant={reviewHasRisk ? "destructive" : "outline"}>{reviewSummaryLabel}</Badge>}
          title="部署校验"
        >
          {busy ? <ExecutionProgress current={checks.length} label="部署校验进度" total={disperseDeploymentCheckDefinitions.length} /> : null}
          {preflight?.status === "ready" ? (
            <div className="summary-list" aria-label="Gas 预检结果">
              <div><span>Gas 估算</span><strong>{preflight.estimatedGas.toLocaleString()}</strong></div>
              <div><span>Gas 上限</span><strong>{preflight.gasLimit.toLocaleString()}</strong></div>
              <div><span>执行费上限</span><strong>{estimatedFee}</strong></div>
            </div>
          ) : null}
          <ResultTable<{ detail: string; id: DisperseDeploymentCheck["id"]; label: string; status: DisperseDeploymentCheck["status"] | "pending" }>
            caption="CreateX 部署校验结果"
            columns={[
              { header: "检查项", key: "label", render: (row) => row.label },
              {
                header: "状态",
                key: "status",
                render: (row) => <Badge variant={row.status === "fail" ? "destructive" : row.status === "skipped" ? "secondary" : "outline"}>{row.status === "pass" ? "通过" : row.status === "fail" ? "失败" : row.status === "skipped" ? "跳过" : "待检查"}</Badge>
              },
              { header: "详情", key: "detail", render: (row) => <span title={row.detail}>{row.detail}</span> }
            ]}
            getRowKey={(row) => row.id}
            rows={disperseDeploymentCheckDefinitions.map((definition) => {
              const check = checks.find((item) => item.id === definition.id);
              return {
                detail: check?.detail || getPendingCheckDetail(definition.id, status),
                id: definition.id,
                label: definition.label,
                status: check?.status || "pending"
              };
            })}
          />
        </ReviewPanel>
      </div>
    </ToolPageLayout>
  );
}
