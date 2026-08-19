import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createWalletClient, formatUnits, getAddress, http, isAddress, parseUnits, zeroAddress } from "viem";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { CollectionResults } from "../components/CollectionResults";
import { EvmGasBadge, EvmGasSettings } from "../components/EvmGasControl";
import { NftAssetInput } from "../components/NftAssetInput";
import { NftInventoryReview } from "../components/NftInventoryReview";
import { SearchableSelect, type SearchableSelectOption } from "../components/SearchableSelect";
import { SecretKeyInput, type SecretKeyInputHandle } from "../components/SecretKeyInput";
import { ToolPageLayout, type WorkbenchStatus } from "../components/ToolPageLayout";
import {
  AdvancedSettings,
  ConfirmActionDialog,
  ExecutionProgress,
  WorkbenchPanel
} from "../components/WorkbenchPrimitives";
import { useEvmGas } from "../hooks/useEvmGas";
import {
  executeEvmCollectionPlan,
  parseEvmCollectionAssets,
  parseEvmPrivateKeyInput,
  planEvmCollection,
  preflightEvmCollectionPlan,
  type EvmCollectionAccount,
  type EvmCollectionAsset,
  type EvmCollectionPreflightResult,
  type EvmCollectionPlanItem,
  type EvmCollectionProgress,
  type EvmCollectionResult,
  type EvmCollectionStandard
} from "../lib/evm-collection";
import {
  assertEvmRpcNetwork,
  createEvmPublicClient,
  getEvmDistributionNetworks,
  getEvmExplorerUrl,
  getEvmNetworkConfig,
  getPreferredEvmDistributionNetwork,
  rememberPreferredEvmDistributionNetwork,
  toEvmChain,
  type EvmDistributionNetworkId
} from "../lib/evm";
import type { CollectionDisplayResult, CollectionResultStatus } from "../lib/collection-results";
import { validateEvmCollectionWorkload } from "../lib/collection-workload";
import { discoverEnumerableErc721Assets } from "../lib/erc721-discovery";
import { verifyErc721IndexedCandidates } from "../lib/erc721-candidate-verification";
import {
  discoverBlockscoutErc721Candidates,
  resolveBlockscoutDeploymentBlock
} from "../lib/blockscout-nft-discovery";
import {
  discoverErc721AssetsByTransfer,
  findErc721DeploymentBlock,
  type Erc721TransferDiscoveryScope
} from "../lib/erc721-transfer-discovery";
import { mergeNftAssetInput } from "../lib/nft-asset-input";
import { inspectNftContract, type NftContractInspection } from "../lib/nft-contract-inspection";

type CollectionStage = "editing" | "scanning" | "ready" | "running" | "complete" | "error";
type NftDiscoveryMode = "auto" | "enumerable" | "transfer";
type NftSourceInputMode = "keys" | "readonly";

type PendingNftDiscovery = {
  assets: Array<{ contractAddress: string; tokenId: bigint }>;
  complete: boolean;
  kind: "enumerable" | "indexer" | "transfer";
  latestBlock?: bigint;
  scope?: Erc721TransferDiscoveryScope;
};

type CollectionPreflightSummary = Pick<
  EvmCollectionPreflightResult,
  "estimatedNetworkFee" | "executableTransactions"
>;

export function getEvmCollectionWorkbenchStatus(
  stage: CollectionStage,
  results: readonly CollectionDisplayResult[]
): WorkbenchStatus {
  const hasHash = results.some((result) => Boolean(result.hash));
  const hasFailure = results.some((result) => result.status === "error");
  if (stage === "scanning") return "preflight";
  if (stage === "ready") return "ready";
  if (stage === "running") return "running";
  if (stage === "error") return hasHash ? "uncertain" : "error";
  if (stage === "complete") {
    if (hasFailure && hasHash) return "uncertain";
    return hasFailure ? "error" : "success";
  }
  return "editing";
}

const evmStatusLabels: Record<WorkbenchStatus, string> = {
  editing: "编辑中",
  error: "需要处理",
  preflight: "预检中",
  ready: "等待确认",
  running: "执行中",
  success: "已完成",
  uncertain: "需核对链上状态"
};

function shorten(value: string, edge = 6) {
  return value.length > edge * 2 + 1 ? `${value.slice(0, edge)}…${value.slice(-edge)}` : value;
}

function parseDiscoveryAddressInput(value: string) {
  const ownerAddresses: string[] = [];
  const issues: string[] = [];
  const seen = new Set<string>();
  const entries = value.split(/[\s,;]+/).map((entry) => entry.trim()).filter(Boolean);

  entries.forEach((entry, index) => {
    if (!isAddress(entry) || getAddress(entry) === zeroAddress) {
      issues.push("只读来源第 " + (index + 1) + " 项不是有效的 EVM 地址");
      return;
    }
    const address = getAddress(entry);
    if (seen.has(address.toLowerCase())) return;
    seen.add(address.toLowerCase());
    ownerAddresses.push(address);
  });
  return { issues, ownerAddresses };
}

function parseDiscoveryStartBlock(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return { value: null as bigint | null };
  if (!/^\d+$/.test(trimmed)) return { issue: "起始区块只能填写非负整数", value: null as bigint | null };
  try {
    return { value: BigInt(trimmed) };
  } catch {
    return { issue: "起始区块格式不正确", value: null as bigint | null };
  }
}

function parsePositiveFeeAmount(value: string, decimals: number) {
  try {
    const parsed = parseUnits(value.trim(), decimals);
    return parsed > 0n ? parsed : null;
  } catch {
    return null;
  }
}

function getAssetName(item: EvmCollectionPlanItem) {
  if (item.asset.standard === "erc20") {
    return item.metadata?.symbol || `ERC20 ${shorten(item.asset.contractAddress, 4)}`;
  }
  return `${item.asset.standard.toUpperCase()} #${item.asset.tokenId} · ${shorten(item.asset.contractAddress, 4)}`;
}

function getBlockscoutBaseUrl(blockExplorerUrl: string) {
  try {
    const url = new URL(blockExplorerUrl);
    return url.protocol === "https:" && url.hostname.toLowerCase().includes("blockscout") ? url.origin : "";
  } catch {
    return "";
  }
}

function getFormattedAmount(item: Pick<EvmCollectionPlanItem, "amount" | "asset" | "metadata">) {
  if (item.asset.standard === "erc20") {
    return formatUnits(item.amount, item.metadata?.decimals ?? 0);
  }
  return item.amount.toString();
}

function planItemToDisplay(item: EvmCollectionPlanItem): CollectionDisplayResult {
  return {
    address: item.address || "—",
    amount: getFormattedAmount(item),
    asset: getAssetName(item),
    label: item.label,
    message: item.message,
    status: item.status === "ready" ? "pending" : item.status === "skipped" ? "skipped" : "error"
  };
}

function resultToDisplay(
  item: EvmCollectionPlanItem,
  result: EvmCollectionResult,
  explorerUrl: (hash: string) => string
): CollectionDisplayResult {
  return {
    address: result.address || "—",
    amount: getFormattedAmount({ amount: result.amount, asset: result.asset, metadata: item.metadata }),
    asset: getAssetName(item),
    ...(result.hash ? { explorerUrl: explorerUrl(result.hash), hash: result.hash } : {}),
    label: result.label,
    message: result.message,
    status: result.status === "success" ? "success" : result.status === "skipped" ? "skipped" : "error"
  };
}

function getProgressStatus(stage: EvmCollectionProgress["stage"]): CollectionResultStatus {
  if (stage === "simulating" || stage === "estimating") return "scanning";
  if (stage === "ready") return "pending";
  if (stage === "submitting") return "submitting";
  if (stage === "confirming") return "confirming";
  if (stage === "success") return "success";
  if (stage === "skipped") return "skipped";
  return "error";
}

function getCollectionPlanInputs(plan: readonly EvmCollectionPlanItem[]) {
  const accountsByAddress = new Map<string, EvmCollectionAccount>();
  const assetsByKey = new Map<string, EvmCollectionAsset>();

  plan.forEach((item, index) => {
    assetsByKey.set(item.asset.key, item.asset);
    if (!item.account || !item.address) return;
    const address = getAddress(item.address);
    if (getAddress(item.account.address) !== address || accountsByAddress.has(address.toLowerCase())) return;
    accountsByAddress.set(address.toLowerCase(), {
      account: item.account,
      address,
      label: item.label,
      line: index + 1
    });
  });

  return {
    accounts: [...accountsByAddress.values()],
    assets: [...assetsByKey.values()]
  };
}

function getCollectionPlanSafetyFingerprint(item: EvmCollectionPlanItem) {
  const tokenId = item.asset.standard === "erc20" ? "" : item.asset.tokenId.toString();
  return [
    item.id,
    item.address?.toLowerCase() || "",
    item.asset.standard,
    item.asset.contractAddress.toLowerCase(),
    tokenId,
    item.amount.toString(),
    item.status
  ].join("|");
}

export function hasEvmCollectionPlanDrift(
  previousPlan: readonly EvmCollectionPlanItem[],
  freshPlan: readonly EvmCollectionPlanItem[]
) {
  if (previousPlan.length !== freshPlan.length) return true;
  const previousFingerprints = previousPlan.map(getCollectionPlanSafetyFingerprint).sort();
  const freshFingerprints = freshPlan.map(getCollectionPlanSafetyFingerprint).sort();
  return previousFingerprints.some((fingerprint, index) => fingerprint !== freshFingerprints[index]);
}

export function EvmCollectionPage({
  fixedStandard
}: {
  fixedStandard: "erc20" | "nft";
}) {
  const networks = useMemo(() => getEvmDistributionNetworks(), []);
  const initialNetwork = useMemo(() => getPreferredEvmDistributionNetwork(networks), [networks]);
  const [networkId, setNetworkId] = useState<EvmDistributionNetworkId>(initialNetwork.id);
  const [rpcEndpoint, setRpcEndpoint] = useState(initialNetwork.rpcEndpoint);
  const [targetAddress, setTargetAddress] = useState("");
  const [erc20AssetInput, setErc20AssetInput] = useState("");
  const [nftAssetInputs, setNftAssetInputs] = useState({ erc721: "", erc1155: "" });
  const [discoveryContract, setDiscoveryContract] = useState("");
  const [discoverySourceInput, setDiscoverySourceInput] = useState("");
  const [sourceInputMode, setSourceInputMode] = useState<NftSourceInputMode>("readonly");
  const [sourceKeyLineCount, setSourceKeyLineCount] = useState(0);
  const [discoveryMode, setDiscoveryMode] = useState<NftDiscoveryMode>("auto");
  const [discoveryStartBlock, setDiscoveryStartBlock] = useState("");
  const [discoveryIssues, setDiscoveryIssues] = useState<string[]>([]);
  const [discoveryMessage, setDiscoveryMessage] = useState("");
  const [contractInspection, setContractInspection] = useState<NftContractInspection | null>(null);
  const [pendingDiscovery, setPendingDiscovery] = useState<PendingNftDiscovery | null>(null);
  const [discoveryRunning, setDiscoveryRunning] = useState(false);
  const [assetImporting, setAssetImporting] = useState(false);
  const [keyImporting, setKeyImporting] = useState(false);
  const [keysCleared, setKeysCleared] = useState(false);
  const [maxFeeAmount, setMaxFeeAmount] = useState("0.01");
  const [nftStandard, setNftStandard] = useState<"erc721" | "erc1155">("erc721");
  const [nftInputResetNonce, setNftInputResetNonce] = useState(0);
  const [stage, setStage] = useState<CollectionStage>("editing");
  const [message, setMessage] = useState("");
  const [issues, setIssues] = useState<string[]>([]);
  const [results, setResults] = useState<CollectionDisplayResult[]>([]);
  const [preflightSummary, setPreflightSummary] = useState<CollectionPreflightSummary | null>(null);
  const keyInputRef = useRef<SecretKeyInputHandle>(null);
  const assetImportingRef = useRef(false);
  const keyImportingRef = useRef(false);
  const operationRef = useRef(false);
  const planRef = useRef<EvmCollectionPlanItem[]>([]);
  const selectedNetwork = getEvmNetworkConfig(networkId, networks);
  const effectiveRpcEndpoint = rpcEndpoint.trim() || selectedNetwork.rpcEndpoint;
  const gas = useEvmGas({
    network: selectedNetwork,
    rpcEndpoint: effectiveRpcEndpoint
  });
  const standard: EvmCollectionStandard = fixedStandard === "erc20" ? "erc20" : nftStandard;
  const currentToolId = fixedStandard === "erc20" ? "evm-token-collection" : "evm-nft-collection";
  const assetInput = fixedStandard === "erc20" ? erc20AssetInput : nftAssetInputs[nftStandard];
  const setCurrentAssetInput = (value: string) => {
    if (fixedStandard === "erc20") {
      setErc20AssetInput(value);
      return;
    }
    setNftAssetInputs((current) => ({ ...current, [nftStandard]: value }));
  };
  const readyCount = planRef.current.filter((item) => item.status === "ready").length;
  const parsedAssetCount = useMemo(
    () => parseEvmCollectionAssets(assetInput, standard).validAssets.length,
    [assetInput, standard]
  );
  const parsedReadonlySources = useMemo(
    () => parseDiscoveryAddressInput(discoverySourceInput),
    [discoverySourceInput]
  );
  const readonlySourceCount = parsedReadonlySources.ownerAddresses.length;
  const readonlySourceIssueCount = parsedReadonlySources.issues.length;
  const contractLabels = useMemo(() => {
    if (!contractInspection) return new Map<string, string>();
    const label = [contractInspection.name, contractInspection.symbol].filter(Boolean).join(" · ");
    return label ? new Map([[contractInspection.address.toLowerCase(), label]]) : new Map<string, string>();
  }, [contractInspection]);
  const targetIsValid = isAddress(targetAddress.trim()) && getAddress(targetAddress.trim()) !== zeroAddress;
  const discoveryContractIsValid = isAddress(discoveryContract.trim())
    && getAddress(discoveryContract.trim()) !== zeroAddress;
  const sourceKeysReady = sourceKeyLineCount > 0;
  const readonlySourcesReady = readonlySourceCount > 0 && readonlySourceIssueCount === 0;
  const discoverySourceReady = sourceInputMode === "readonly" ? readonlySourcesReady : sourceKeysReady;
  const maximumFeeAmount = parsePositiveFeeAmount(maxFeeAmount, selectedNetwork.nativeCurrency.decimals);
  const readyTransactionCount = preflightSummary?.executableTransactions ?? readyCount;
  const transactionRunning = stage === "scanning" || stage === "running";
  const operationRunning = transactionRunning || discoveryRunning;
  const running = operationRunning || assetImporting || keyImporting;
  const hasSubmittedHash = results.some((result) => Boolean(result.hash));
  const controlsLocked = running || hasSubmittedHash;
  const workbenchStatus = getEvmCollectionWorkbenchStatus(stage, results);
  const completedResultCount = results.filter((result) => (
    result.status === "success" || result.status === "error" || result.status === "skipped"
  )).length;
  const networkOptions = useMemo<SearchableSelectOption<EvmDistributionNetworkId>[]>(() => (
    networks.map((network) => ({
      keywords: [String(network.chainId), network.nativeCurrency.symbol],
      label: network.label,
      meta: String(network.chainId),
      value: network.id
    }))
  ), [networks]);

  const handleAssetImportingChange = useCallback((importing: boolean) => {
    assetImportingRef.current = importing;
    setAssetImporting(importing);
  }, []);

  const handleKeyImportingChange = useCallback((importing: boolean) => {
    keyImportingRef.current = importing;
    setKeyImporting(importing);
  }, []);

  useEffect(() => {
    const discardSigningPlan = () => {
      planRef.current = [];
    };
    const resetRestoredPage = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      planRef.current = [];
      setResults([]);
      setIssues([]);
      setDiscoveryIssues([]);
      setPendingDiscovery(null);
      setPreflightSummary(null);
      setMessage("页面从历史记录恢复，签名材料已清除；请重新扫描");
      setStage("editing");
    };
    window.addEventListener("pagehide", discardSigningPlan);
    window.addEventListener("pageshow", resetRestoredPage);
    return () => {
      window.removeEventListener("pagehide", discardSigningPlan);
      window.removeEventListener("pageshow", resetRestoredPage);
      planRef.current = [];
    };
  }, []);

  const parseMaximumFee = () => maximumFeeAmount;

  const invalidatePlan = (clearResults = true, preserveDiscovery = false) => {
    if (operationRef.current || transactionRunning) return;
    planRef.current = [];
    setPreflightSummary(null);
    if (!preserveDiscovery) {
      setDiscoveryMessage("");
      setDiscoveryIssues([]);
    }
    setIssues([]);
    setMessage("");
    setStage("editing");
    if (clearResults) setResults([]);
  };

  const selectNetwork = (value: EvmDistributionNetworkId) => {
    const nextNetwork = getEvmNetworkConfig(value, networks);
    setNetworkId(value);
    setRpcEndpoint(nextNetwork.rpcEndpoint);
    setPendingDiscovery(null);
    setContractInspection(null);
    rememberPreferredEvmDistributionNetwork(value);
    invalidatePlan();
  };

  const scanAssets = async (assetInputOverride?: string) => {
    if (operationRef.current || assetImportingRef.current || keyImportingRef.current || running) return;
    const gasSettings = gas.gasSettings;
    operationRef.current = true;
    setIssues([]);
    setMessage("");
    setPreflightSummary(null);
    planRef.current = [];
    setResults([]);
    const inputToScan = assetInputOverride ?? assetInput;

    const nextIssues: string[] = [];
    if (!isAddress(targetAddress.trim())) nextIssues.push("目标地址不是有效的 EVM 地址");
    else if (getAddress(targetAddress.trim()) === zeroAddress) nextIssues.push("目标地址不能是零地址，以免资产被销毁");
    if (!effectiveRpcEndpoint) nextIssues.push("请输入可用的 RPC 地址");
    if (!gasSettings) nextIssues.push("请输入有效的自定义 Gas Price");
    if (parseMaximumFee() === null) nextIssues.push("单笔最大网络费需要是大于 0 的有效金额");

    const parsedAccounts = parseEvmPrivateKeyInput(keyInputRef.current?.read() || "");
    if (!parsedAccounts.accounts.length) nextIssues.push("至少需要一个有效的来源钱包私钥");
    parsedAccounts.issues.forEach((issue) => nextIssues.push(`密钥第 ${issue.line} 行：${issue.message}`));

    const parsedAssets = parseEvmCollectionAssets(inputToScan, standard);
    if (!parsedAssets.validAssets.length) nextIssues.push("至少需要一个有效的资产条目");
    parsedAssets.rows.forEach((row) => {
      if (row.status !== "valid") nextIssues.push(`资产第 ${row.line} 行：${row.problems.join("；")}`);
    });
    nextIssues.push(...validateEvmCollectionWorkload({
      accountCount: parsedAccounts.accounts.length,
      assetCount: parsedAssets.validAssets.length,
      standard
    }));

    if (nextIssues.length) {
      operationRef.current = false;
      setIssues(nextIssues);
      setStage("error");
      setMessage("请修正输入后重新扫描");
      return;
    }
    if (!gasSettings) {
      operationRef.current = false;
      return;
    }

    setStage("scanning");
    setMessage(`正在通过 ${selectedNetwork.label} RPC 读取资产、模拟交易并预检网络费`);

    try {
      const publicClient = createEvmPublicClient(selectedNetwork, effectiveRpcEndpoint);
      await assertEvmRpcNetwork(publicClient, selectedNetwork);
      const ownershipPlan = await planEvmCollection({
        accounts: parsedAccounts.accounts,
        assets: parsedAssets.validAssets,
        publicClient
      });
      setResults(ownershipPlan.map(planItemToDisplay));
      const target = getAddress(targetAddress.trim());
      const maxFeePerTransactionWei = parseMaximumFee();
      if (maxFeePerTransactionWei === null) {
        throw new Error("单笔最大网络费格式已变化");
      }
      const preflight = await preflightEvmCollectionPlan({
        gasSettings,
        maxFeePerTransactionWei,
        onProgress: (progress) => {
          if (progress.stage === "simulating" || progress.stage === "estimating") {
            setMessage(
              "正在预检 " + (progress.index + 1) + "/" + progress.total
                + " 笔归集交易：" + progress.message
            );
          }
        },
        plan: ownershipPlan,
        publicClient,
        targetAddress: target
      });
      const plan = preflight.plan;
      planRef.current = plan;
      setPreflightSummary({
        estimatedNetworkFee: preflight.estimatedNetworkFee,
        executableTransactions: preflight.executableTransactions
      });
      setResults(plan.map(planItemToDisplay));

      const executable = plan.filter((item) => item.status === "ready").length;
      const failed = plan.filter((item) => item.status === "failed").length;
      if (!executable) {
        planRef.current = [];
        setPreflightSummary(null);
        setStage("error");
        setMessage(failed
          ? "资产与交易预检完成，但没有可执行项；请查看失败原因"
          : "所有资产余额为 0 或不属于已导入钱包");
        return;
      }

      keyInputRef.current?.clear();
      setKeysCleared(true);
      setStage("ready");
      setMessage(
        "预检完成：" + executable + " 项可归集，将发送 "
          + preflight.executableTransactions + " 笔交易"
          + (plan.length - executable ? "，" + (plan.length - executable) + " 项将跳过或需要修正" : "")
      );
    } catch (error) {
      planRef.current = [];
      setPreflightSummary(null);
      setStage("error");
      const detail = error instanceof Error ? error.message : "RPC 请求失败";
      setMessage(detail.includes("RPC 网络不匹配") ? detail : "资产扫描或交易预检失败，请检查网络、RPC 与合约地址");
    } finally {
      operationRef.current = false;
    }
  };

  const discoverOwnedErc721 = async () => {
    if (operationRef.current || assetImportingRef.current || keyImportingRef.current
      || running || fixedStandard !== "nft" || standard !== "erc721") return;

    setDiscoveryIssues([]);
    setDiscoveryMessage("");
    setPendingDiscovery(null);
    if (assetInput.trim()) {
      const existingAssets = parseEvmCollectionAssets(assetInput, "erc721");
      if (existingAssets.rows.some((row) => row.status === "invalid")) {
        setDiscoveryMessage("当前资产清单仍有格式错误，请先修正后再自动发现；扫描结果不会覆盖现有输入");
        return;
      }
    }
    if (!isAddress(discoveryContract.trim())) {
      setDiscoveryMessage("请输入有效的 ERC721 合约地址");
      return;
    }

    const directSources = sourceInputMode === "readonly"
      ? parseDiscoveryAddressInput(discoverySourceInput)
      : { issues: [], ownerAddresses: [] };
    const parsedAccounts = sourceInputMode === "keys"
      ? parseEvmPrivateKeyInput(keyInputRef.current?.read() || "")
      : null;
    const ownerAddresses = directSources.ownerAddresses.length
      ? directSources.ownerAddresses
      : parsedAccounts?.accounts.map((account) => account.address) || [];
    const sourceIssues = [
      ...directSources.issues,
      ...(parsedAccounts?.issues.map((issue) => "密钥第 " + issue.line + " 行：" + issue.message) || [])
    ];
    const hasInvalidSources = directSources.issues.length > 0 || Boolean(parsedAccounts?.invalid);

    if (!ownerAddresses.length) {
      setDiscoveryIssues(sourceIssues);
      setDiscoveryMessage(sourceInputMode === "readonly"
        ? "请至少填写一个有效的只读来源地址"
        : "请先导入至少一个有效来源钱包密钥；识别持仓只读取地址，不会提交交易");
      if (sourceInputMode === "keys") keyInputRef.current?.focus();
      return;
    }
    if (hasInvalidSources) {
      setDiscoveryIssues(sourceIssues);
      setDiscoveryMessage("来源地址或私钥中有错误。为避免漏扫钱包，请修正后再自动发现");
      return;
    }
    const discoveryWorkloadIssues = validateEvmCollectionWorkload({
      accountCount: ownerAddresses.length,
      assetCount: 1,
      standard: "erc721"
    });
    if (discoveryWorkloadIssues.length) {
      setDiscoveryIssues([...sourceIssues, ...discoveryWorkloadIssues]);
      setDiscoveryMessage("来源钱包数量超过自动发现的安全上限，已在发起 RPC 前阻止");
      return;
    }
    const startBlock = parseDiscoveryStartBlock(discoveryStartBlock);
    if (startBlock.issue) {
      setDiscoveryIssues(sourceIssues);
      setDiscoveryMessage(startBlock.issue);
      return;
    }

    operationRef.current = true;
    setDiscoveryRunning(true);
    setDiscoveryMessage("正在校验网络并准备 NFT 自动发现…");
    try {
      const publicClient = createEvmPublicClient(selectedNetwork, effectiveRpcEndpoint);
      await assertEvmRpcNetwork(publicClient, selectedNetwork);
      setDiscoveryMessage("正在识别 NFT 合约标准与名称…");
      const inspection = await inspectNftContract({
        contractAddress: discoveryContract.trim(),
        publicClient
      });
      setContractInspection(inspection);
      if (inspection.standard === "unknown") {
        setDiscoveryIssues([...sourceIssues, ...inspection.issues]);
        setDiscoveryMessage("该地址没有通过 ERC721 / ERC1155 标准识别，未修改资产清单");
        return;
      }
      if (inspection.standard === "erc1155") {
        setNftStandard("erc1155");
        setPendingDiscovery(null);
        setDiscoveryIssues(sourceIssues);
        setDiscoveryMessage("已识别为 ERC1155，已切换标准；请填写 Token ID，归集时会读取每个来源的完整余额");
        return;
      }

      let indexedPartial: PendingNftDiscovery | null = null;
      let indexedIssues: string[] = [];
      if (discoveryMode !== "transfer") {
        setDiscoveryMessage("正在检查 ERC721Enumerable 并读取来源钱包持有的 Token ID…");
        const enumerable = await discoverEnumerableErc721Assets({
          contractAddress: discoveryContract.trim(),
          onProgress: (progress) => {
            if (progress.stage === "reading-token") {
              setDiscoveryMessage(
                "正在枚举来源 " + (progress.ownerIndex + 1) + "/" + progress.ownerTotal
                  + " · 已发现 " + progress.discovered + " 个 NFT"
              );
            }
          },
          ownerAddresses,
          publicClient
        });
        const enumerableIssues = enumerable.issues.filter((issue) => (
          discoveryMode === "enumerable" || issue.code !== "not-enumerable"
        )).map((issue) => (
          (issue.ownerAddress ? "来源 " + shorten(issue.ownerAddress) : "合约检查") + "：" + issue.message
        ));
        const notEnumerable = enumerable.issues.some((issue) => issue.code === "not-enumerable");
        const enumerableComplete = enumerable.owners.length === ownerAddresses.length
          && enumerable.owners.every((owner) => owner.status === "complete")
          && enumerable.issues.length === 0;

        if (discoveryMode === "enumerable" || !notEnumerable) {
          setDiscoveryIssues([...sourceIssues, ...enumerableIssues]);
          if (!enumerable.assets.length) {
            setDiscoveryMessage(enumerable.issues[0]?.message || "来源钱包在该合约中没有可枚举的 NFT");
            return;
          }
          setPendingDiscovery({
            assets: enumerable.assets,
            complete: enumerableComplete,
            kind: "enumerable"
          });
          setDiscoveryMessage(
            "已发现 " + enumerable.assets.length + " 个 Token ID"
              + (enumerableComplete ? "；索引枚举已完成" : "；扫描存在限制，请先核对提示")
              + "。确认后再加入资产清单。"
          );
          return;
        }
        setDiscoveryIssues([...sourceIssues, ...enumerableIssues]);
        setDiscoveryMessage("已识别为普通 ERC721，正在查询公开索引并准备链上复核…");
      }

      const blockscoutBaseUrl = getBlockscoutBaseUrl(selectedNetwork.blockExplorerUrl);
      if (discoveryMode === "auto" && blockscoutBaseUrl) {
        try {
          setDiscoveryMessage("正在通过该网络的公开 Blockscout 索引读取候选 Token ID…");
          const indexed = await discoverBlockscoutErc721Candidates({
            baseUrl: blockscoutBaseUrl,
            contractAddress: discoveryContract.trim(),
            ownerAddresses
          });
          indexedIssues = indexed.issues.map((issue) => (
            (issue.ownerAddress ? "来源 " + shorten(issue.ownerAddress) : "公开索引") + "：" + issue.message
          ));
          const candidates = indexed.owners.flatMap((owner) => owner.assets.map((asset) => ({
            ownerAddress: owner.ownerAddress,
            tokenId: asset.tokenId
          })));
          setDiscoveryMessage("公开索引返回候选项，正在同一链上快照执行 ownerOf / balanceOf 复核…");
          const verified = await verifyErc721IndexedCandidates({
            candidates,
            contractAddress: discoveryContract.trim(),
            ownerAddresses,
            publicClient
          });
          const verificationIssues = verified.issues.map((issue) => issue.message);
          indexedIssues = [...indexedIssues, ...verificationIssues];
          const indexedComplete = indexed.complete && verified.complete;
          if (indexedComplete) {
            setDiscoveryIssues([...sourceIssues, ...indexedIssues]);
            if (!verified.assets.length) {
              setDiscoveryMessage("公开索引与链上余额已完成对账；这些来源钱包当前未持有该 NFT");
              return;
            }
            setPendingDiscovery({
              assets: verified.assets,
              complete: true,
              kind: "indexer",
              latestBlock: verified.snapshotBlock ?? undefined
            });
            setDiscoveryMessage(
              "已发现 " + verified.assets.length
                + " 个 Token ID；公开索引仅用于找候选，最终归属已由链上 ownerOf / balanceOf 验证。"
            );
            return;
          }
          if (verified.assets.length) {
            indexedPartial = {
              assets: verified.assets,
              complete: false,
              kind: "indexer",
              latestBlock: verified.snapshotBlock ?? undefined
            };
          }
          setDiscoveryIssues([...sourceIssues, ...indexedIssues]);
          setDiscoveryMessage("公开索引未能完整对账，正在回退到 Transfer 事件历史扫描…");
        } catch (error) {
          const detail = error instanceof Error ? error.message : "Blockscout 请求失败";
          indexedIssues = ["公开索引：" + detail];
          setDiscoveryIssues([...sourceIssues, ...indexedIssues]);
          setDiscoveryMessage("公开索引不可用，正在回退到 Transfer 事件历史扫描…");
        }
      }

      let fromBlock: bigint;
      let scope: Erc721TransferDiscoveryScope;
      if (startBlock.value !== null) {
        fromBlock = startBlock.value;
        scope = "manual-range";
      } else {
        setDiscoveryMessage("正在定位 NFT 合约部署区块，以便从完整事件历史恢复 Token ID…");
        try {
          fromBlock = await findErc721DeploymentBlock({
            contractAddress: discoveryContract.trim(),
            onProgress: () => setDiscoveryMessage("正在定位 NFT 合约部署区块…"),
            publicClient
          });
          scope = "full-history";
        } catch {
          if (blockscoutBaseUrl) {
            try {
              setDiscoveryMessage("当前 RPC 不支持历史代码，正在通过 Blockscout 查询合约部署区块…");
              fromBlock = await resolveBlockscoutDeploymentBlock(
                blockscoutBaseUrl,
                discoveryContract.trim()
              );
              scope = "full-history";
            } catch (error) {
              const detail = error instanceof Error ? error.message : "无法查询部署区块";
              if (indexedPartial) setPendingDiscovery(indexedPartial);
              setDiscoveryIssues([...sourceIssues, ...indexedIssues, "部署区块：" + detail]);
              setDiscoveryMessage(indexedPartial
                ? "事件回溯无法自动定位部署区块；已保留链上验证过的部分候选，请核对提示后决定是否加入。"
                : "无法自动定位部署区块。请在高级设置填写已知起始区块后重试；现有清单未修改。");
              return;
            }
          } else {
            if (indexedPartial) setPendingDiscovery(indexedPartial);
            setDiscoveryMessage(indexedPartial
              ? "事件回溯无法自动定位部署区块；已保留链上验证过的部分候选，请核对后再加入。"
              : "无法由当前 RPC 自动定位部署区块。请填写已知的起始区块后重试，扫描结果会明确标为该区间范围。");
            return;
          }
        }
      }

      const transferDiscovery = await discoverErc721AssetsByTransfer({
        contractAddress: discoveryContract.trim(),
        fromBlock,
        onProgress: (progress) => {
          if (progress.stage === "reading-events") {
            setDiscoveryMessage(
              "正在回溯区块 " + progress.fromBlock.toString() + "–" + progress.toBlock.toString()
                + " · 候选 " + progress.candidateCount + " 个"
            );
          } else if (progress.stage === "verifying-owner") {
            setDiscoveryMessage(
              "正在快照区块 " + progress.toBlock.toString()
                + " 验证 " + progress.candidateCount + " 个 Token ID 的 ownerOf…"
            );
          }
        },
        ownerAddresses,
        publicClient,
        scope
      });
      const transferIssues = transferDiscovery.issues.map((issue) => issue.message);
      setDiscoveryIssues([...sourceIssues, ...indexedIssues, ...transferIssues]);
      if (!transferDiscovery.assets.length) {
        if (indexedPartial) {
          setPendingDiscovery(indexedPartial);
          setDiscoveryMessage("事件历史未得到完整结果；已保留经 ownerOf 验证的公开索引候选，请确认其为部分结果后再加入。");
          return;
        }
        setDiscoveryMessage(transferDiscovery.issues[0]?.message || "扫描范围内没有仍归属于这些来源地址的 NFT");
        return;
      }
      setPendingDiscovery({
        assets: transferDiscovery.assets,
        complete: transferDiscovery.complete,
        kind: "transfer",
        latestBlock: transferDiscovery.latestBlock,
        scope: transferDiscovery.scope
      });
      const coverage = transferDiscovery.scope === "full-history"
        ? "已覆盖合约部署以来的事件历史"
        : "仅覆盖指定区块范围";
      setDiscoveryMessage(
        "已发现 " + transferDiscovery.assets.length + " 个仍归属来源地址的 Token ID；"
          + coverage
          + (transferDiscovery.complete ? "，并已在同一快照区块完成 ownerOf / balanceOf 对账。" : "，但扫描为部分结果，请先核对提示。")
          + " 确认后再加入资产清单。"
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : "RPC 请求失败";
      setDiscoveryMessage(detail.includes("RPC 网络不匹配")
        ? detail
        : "自动发现失败，请检查网络、RPC 与合约；现有资产清单没有被修改");
    } finally {
      operationRef.current = false;
      setDiscoveryRunning(false);
    }
  };

  const applyPendingDiscovery = (allowPartial = false) => {
    if (!pendingDiscovery || operationRef.current || running || standard !== "erc721") return;
    if (!pendingDiscovery.complete && !allowPartial) {
      setDiscoveryMessage("这是部分发现结果。请先确认仅归集已验证项目，或修正提示后重新扫描完整历史。");
      return;
    }
    const contractAddress = pendingDiscovery.assets[0]?.contractAddress;
    if (!contractAddress) return;
    const tokenExpression = pendingDiscovery.assets.map((asset) => asset.tokenId.toString()).join(",");
    const merged = mergeNftAssetInput(assetInput, contractAddress, tokenExpression);
    const mergeErrors = merged.issues.filter((issue) => issue.severity === "error");
    if (mergeErrors.length) {
      setDiscoveryIssues(mergeErrors.map((issue) => issue.message));
      setDiscoveryMessage("发现结果未加入清单：现有清单保持不变，请按提示分批处理");
      return;
    }
    invalidatePlan(true, true);
    setCurrentAssetInput(merged.serialized);
    setPendingDiscovery(null);
    setDiscoveryIssues(merged.issues.map((issue) => issue.message));
    setDiscoveryMessage(
      merged.added
        ? "已将 " + merged.added + " 个自动发现的 NFT 加入清单"
          + (merged.duplicates ? "，跳过 " + merged.duplicates + " 个重复项" : "")
        : "自动发现的 NFT 已全部存在于当前清单"
    );
  };

  const executeCollection = async () => {
    const plan = planRef.current;
    if (operationRef.current || assetImportingRef.current || keyImportingRef.current
      || stage !== "ready" || !plan.length || !isAddress(targetAddress.trim())) return;

    const gasSettings = gas.gasSettings;
    if (!gasSettings) {
      invalidatePlan(false);
      setStage("error");
      setMessage("Gas 设置已变化，请填写有效值后重新扫描");
      return;
    }
    const target = getAddress(targetAddress.trim());
    const maxFeePerTransactionWei = parseMaximumFee();
    if (maxFeePerTransactionWei === null) {
      invalidatePlan(false);
      setStage("error");
      setMessage("单笔最大网络费已变化，请重新扫描");
      return;
    }
    operationRef.current = true;
    setStage("running");
    setMessage("签名前正在重新检查网络、资产余额、所有权、模拟与 Gas");
    let executionPlan = plan;
    let signingStarted = false;

    const updateProgress = (progress: EvmCollectionProgress) => {
      setResults((current) => current.map((result, index) => {
        const planItem = executionPlan[index];
        if (!planItem || planItem.id !== progress.id) return result;
        return {
          ...result,
          ...(progress.hash ? {
            explorerUrl: getEvmExplorerUrl(progress.hash, selectedNetwork),
            hash: progress.hash
          } : {}),
          message: progress.message,
          status: getProgressStatus(progress.stage)
        };
      }));
    };

    try {
      const publicClient = createEvmPublicClient(selectedNetwork, effectiveRpcEndpoint);
      await assertEvmRpcNetwork(publicClient, selectedNetwork);
      const freshInputs = getCollectionPlanInputs(plan);
      const freshOwnershipPlan = await planEvmCollection({
        accounts: freshInputs.accounts,
        assets: freshInputs.assets,
        publicClient
      });
      const freshPreflight = await preflightEvmCollectionPlan({
        gasSettings,
        maxFeePerTransactionWei,
        plan: freshOwnershipPlan,
        publicClient,
        targetAddress: target
      });
      executionPlan = freshPreflight.plan;
      setPreflightSummary({
        estimatedNetworkFee: freshPreflight.estimatedNetworkFee,
        executableTransactions: freshPreflight.executableTransactions
      });
      setResults(executionPlan.map(planItemToDisplay));

      if (hasEvmCollectionPlanDrift(plan, executionPlan)) {
        setStage("error");
        setMessage("签名前检查发现资产余额、所有权或可执行交易已变化，已阻止签名；请重新导入密钥并预检");
        return;
      }

      const chain = toEvmChain(selectedNetwork, effectiveRpcEndpoint);
      signingStarted = true;
      const executionResults = await executeEvmCollectionPlan({
        gasSettings,
        getWalletClient: (account) => createWalletClient({
          account,
          chain,
          transport: http(effectiveRpcEndpoint)
        }),
        maxFeePerTransactionWei,
        onProgress: updateProgress,
        plan: executionPlan,
        publicClient,
        targetAddress: target
      });
      setResults(executionResults.map((result, index) => (
        resultToDisplay(executionPlan[index], result, (hash) => getEvmExplorerUrl(hash, selectedNetwork))
      )));
      const success = executionResults.filter((result) => result.status === "success").length;
      const failed = executionResults.filter((result) => result.status === "failed").length;
      setStage("complete");
      setMessage(`执行结束：${success} 笔确认成功${failed ? `，${failed} 笔失败` : ""}。来源密钥已从页面清除。`);
    } catch {
      setStage("error");
      setMessage(signingStarted
        ? "归集流程意外中断；来源密钥已清除，请先按已显示的交易哈希核对链上状态，再决定是否创建新任务"
        : "签名前复检失败，未请求任何签名；请检查网络、余额、所有权与 Gas 后重新预检");
    } finally {
      operationRef.current = false;
      planRef.current = [];
      setPreflightSummary(null);
    }
  };

  const focusKeyInput = () => {
    if (fixedStandard === "nft") setSourceInputMode("keys");
    window.requestAnimationFrame(() => keyInputRef.current?.focus());
  };

  const resetTask = () => {
    keyInputRef.current?.clear();
    planRef.current = [];
    setErc20AssetInput("");
    setNftAssetInputs({ erc721: "", erc1155: "" });
    setDiscoveryContract("");
    setDiscoverySourceInput("");
    setSourceInputMode("readonly");
    setDiscoveryMode("auto");
    setDiscoveryStartBlock("");
    setPendingDiscovery(null);
    setContractInspection(null);
    setDiscoveryIssues([]);
    setDiscoveryMessage("");
    setNftStandard("erc721");
    setNftInputResetNonce((current) => current + 1);
    setTargetAddress("");
    setMaxFeeAmount("0.01");
    setResults([]);
    setKeysCleared(false);
    setPreflightSummary(null);
    setIssues([]);
    setMessage("");
    setStage("editing");
  };

  return (
    <ToolPageLayout
      actions={(
        <>
          <EvmGasBadge gas={gas} />
          <Badge variant="outline">{selectedNetwork.label}</Badge>
          <ConfirmActionDialog
            confirmLabel="清空任务"
            description={hasSubmittedHash
              ? "当前结果包含已提交的交易哈希。清空前请先核对链上状态；清空后本页记录无法恢复。"
              : "来源密钥、资产清单和当前预检结果将从页面清除。"}
            disabled={running}
            onConfirm={resetTask}
            title="清空当前归集任务？"
            triggerLabel="清空任务"
            triggerVariant="destructive"
          />
        </>
      )}
      className="collection-shell collection-page"
      currentToolId={currentToolId}
      status={workbenchStatus}
      statusLabel={evmStatusLabels[workbenchStatus]}
      title={fixedStandard === "erc20" ? "ERC20 代币归集" : "EVM NFT 归集"}
    >
      <div className={"workspace collection-workspace" + (results.length ? " has-results" : "")}>
        <WorkbenchPanel
          className="collection-workbench-panel"
          footer={(
            <div className="actions collection-actions">
              {stage === "ready" ? (
                <ConfirmActionDialog
                  confirmLabel="确认并开始归集"
                  description={(
                    <div className="summary-list">
                      <div><span>网络</span><strong>{selectedNetwork.label}</strong></div>
                      <div><span>目标地址</span><strong className="mono">{targetAddress}</strong></div>
                      <div><span>归集资产</span><strong>{readyCount} 项</strong></div>
                      <div><span>预计交易</span><strong>{readyTransactionCount} 笔</strong></div>
                      {preflightSummary ? (
                        <div>
                          <span>预检网络费</span>
                          <strong>
                            {formatUnits(
                              preflightSummary.estimatedNetworkFee,
                              selectedNetwork.nativeCurrency.decimals
                            )} {selectedNetwork.nativeCurrency.symbol}
                          </strong>
                        </div>
                      ) : null}
                      <div>
                        <span>单笔网络费预算上限</span>
                        <strong>{maxFeeAmount} {selectedNetwork.nativeCurrency.symbol}</strong>
                      </div>
                    </div>
                  )}
                  disabled={running}
                  onConfirm={executeCollection}
                  title="确认 EVM 归集？"
                  triggerLabel="确认并开始归集"
                />
              ) : stage === "scanning" || stage === "running" ? (
                <Button disabled type="button">{stage === "scanning" ? "预检中" : "归集中"}</Button>
              ) : hasSubmittedHash ? (
                <Button disabled type="button">请先核对链上结果</Button>
              ) : keysCleared ? (
                <Button onClick={focusKeyInput} type="button">重新导入来源密钥</Button>
              ) : (
                <Button disabled={running || !gas.gasSettings} onClick={() => void scanAssets()} type="button">预检资产与费用</Button>
              )}
            </div>
          )}
          title="归集设置"
        >
          <div className="form collection-form">
            {fixedStandard === "nft" ? (
              <>
                <Tabs
                  onValueChange={(value) => {
                    const nextMode = value as NftSourceInputMode;
                    setSourceInputMode(nextMode);
                    setPendingDiscovery(null);
                    setDiscoveryIssues([]);
                    setDiscoveryMessage("");
                    invalidatePlan();
                  }}
                  value={sourceInputMode}
                >
                  <TabsList aria-label="来源模式">
                    <TabsTrigger disabled={controlsLocked} value="readonly">只读地址</TabsTrigger>
                    <TabsTrigger disabled={controlsLocked} value="keys">来源密钥</TabsTrigger>
                  </TabsList>
                  <TabsContent value="readonly">
                    <Field data-invalid={discoverySourceInput.trim() && readonlySourceIssueCount ? true : undefined}>
                      <FieldLabel htmlFor="nft-discovery-sources">只读来源地址</FieldLabel>
                      <Textarea
                        aria-invalid={discoverySourceInput.trim() && readonlySourceIssueCount ? true : undefined}
                        autoCapitalize="none"
                        autoComplete="off"
                        disabled={controlsLocked}
                        id="nft-discovery-sources"
                        onChange={(event) => {
                          setDiscoverySourceInput(event.target.value);
                          setPendingDiscovery(null);
                          setDiscoveryIssues([]);
                          setDiscoveryMessage("");
                          invalidatePlan();
                        }}
                        placeholder="0x…"
                        rows={4}
                        spellCheck={false}
                        value={discoverySourceInput}
                      />
                      {readonlySourceIssueCount ? <FieldError>{parsedReadonlySources.issues[0]}</FieldError> : null}
                    </Field>
                  </TabsContent>
                  <TabsContent value="keys">
                    <span className="sr-only">来源密钥输入位于目标地址之后</span>
                  </TabsContent>
                </Tabs>
              </>
            ) : null}

            <Field>
              <FieldLabel htmlFor="evm-collection-network">网络</FieldLabel>
              <SearchableSelect
                disabled={controlsLocked}
                id="evm-collection-network"
                listboxLabel="EVM 归集网络"
                metaLabel="Chain ID"
                onChange={selectNetwork}
                options={networkOptions}
                placeholder="搜索网络或 Chain ID"
                triggerLabel="选择归集网络"
                value={networkId}
              />
            </Field>

            {fixedStandard === "nft" ? (
              <Field>
                <FieldLabel>NFT 标准</FieldLabel>
                <Tabs
                  onValueChange={(value) => {
                    const nextStandard = value as "erc721" | "erc1155";
                    setNftStandard(nextStandard);
                    if (nextStandard === "erc1155") setSourceInputMode("keys");
                    setNftInputResetNonce((current) => current + 1);
                    setPendingDiscovery(null);
                    setContractInspection(null);
                    invalidatePlan();
                  }}
                  value={nftStandard}
                >
                  <TabsList aria-label="NFT 标准">
                    <TabsTrigger disabled={controlsLocked} value="erc721">ERC721</TabsTrigger>
                    <TabsTrigger disabled={controlsLocked} value="erc1155">ERC1155</TabsTrigger>
                  </TabsList>
                </Tabs>
              </Field>
            ) : null}

            {fixedStandard === "erc20" ? (
              <>
                <Field data-invalid={targetAddress.trim() && !targetIsValid ? true : undefined}>
                  <FieldLabel htmlFor="evm-collection-target">目标地址</FieldLabel>
                  <Input
                    aria-invalid={targetAddress.trim() && !targetIsValid ? true : undefined}
                    autoCapitalize="none"
                    autoComplete="off"
                    disabled={controlsLocked}
                    id="evm-collection-target"
                    onChange={(event) => {
                      setTargetAddress(event.target.value);
                      invalidatePlan();
                    }}
                    placeholder="0x…"
                    spellCheck={false}
                    value={targetAddress}
                  />
                  {targetAddress.trim() && !targetIsValid ? <FieldError>请输入有效的非零 EVM 地址</FieldError> : null}
                </Field>
                <Field>
                  <FieldLabel htmlFor="evm-collection-assets">Token 清单</FieldLabel>
                  <Textarea
                    className="collection-asset-textarea"
                    disabled={controlsLocked}
                    id="evm-collection-assets"
                    onChange={(event) => {
                      setCurrentAssetInput(event.target.value);
                      invalidatePlan();
                    }}
                    placeholder="0x…"
                    spellCheck={false}
                    value={assetInput}
                  />
                </Field>
                <SecretKeyInput
                  disabled={controlsLocked || assetImporting}
                  mode="evm"
                  onDirty={() => {
                    setKeysCleared(false);
                    invalidatePlan();
                  }}
                  onImportingChange={handleKeyImportingChange}
                  onLineCountChange={setSourceKeyLineCount}
                  ref={keyInputRef}
                />
              </>
            ) : (
              <>
                <NftAssetInput
                  autoDiscovery={standard === "erc721" ? (
                    <WorkbenchPanel className="nft-discovery-card" title="自动识别">
                      {contractInspection ? (
                        <Alert>
                          <AlertTitle>{contractInspection.name || "NFT 合约"}</AlertTitle>
                          <AlertDescription>
                            <Badge variant="outline">
                              {contractInspection.symbol ? contractInspection.symbol + " · " : ""}
                              {contractInspection.standard.toUpperCase()}
                            </Badge>
                            <code>{contractInspection.address}</code>
                          </AlertDescription>
                        </Alert>
                      ) : null}

                      <Button
                        disabled={controlsLocked || !discoveryContractIsValid || !discoverySourceReady}
                        onClick={() => void discoverOwnedErc721()}
                        type="button"
                      >
                        {discoveryRunning ? "正在识别" : "识别持仓"}
                      </Button>

                      <AdvancedSettings disabled={controlsLocked} label="发现方式与事件范围">
                        <Field>
                          <FieldLabel>发现方式</FieldLabel>
                          <Tabs
                            onValueChange={(value) => {
                              setDiscoveryMode(value as NftDiscoveryMode);
                              setPendingDiscovery(null);
                              setDiscoveryIssues([]);
                              setDiscoveryMessage("");
                              invalidatePlan();
                            }}
                            value={discoveryMode}
                          >
                            <TabsList aria-label="NFT 发现方式">
                              <TabsTrigger value="auto">自动</TabsTrigger>
                              <TabsTrigger value="enumerable">原生索引</TabsTrigger>
                              <TabsTrigger value="transfer">事件回溯</TabsTrigger>
                            </TabsList>
                          </Tabs>
                        </Field>
                        <Field>
                          <FieldLabel htmlFor="nft-discovery-start-block">事件起始区块</FieldLabel>
                          <Input
                            disabled={controlsLocked || discoveryMode === "enumerable"}
                            id="nft-discovery-start-block"
                            inputMode="numeric"
                            onChange={(event) => {
                              setDiscoveryStartBlock(event.target.value);
                              setPendingDiscovery(null);
                              setDiscoveryIssues([]);
                              setDiscoveryMessage("");
                              invalidatePlan();
                            }}
                            placeholder="自动定位"
                            spellCheck={false}
                            value={discoveryStartBlock}
                          />
                        </Field>
                      </AdvancedSettings>

                      {pendingDiscovery ? (
                        <Alert>
                          <AlertTitle>
                            {pendingDiscovery.complete ? "发现结果已验证" : "部分发现结果"}
                          </AlertTitle>
                          <AlertDescription>
                            <p>{pendingDiscovery.assets.length} 个 Token ID</p>
                            <code>
                              {pendingDiscovery.assets.slice(0, 8).map((asset) => asset.tokenId.toString()).join(" · ")}
                              {pendingDiscovery.assets.length > 8 ? " · …" : ""}
                            </code>
                            {pendingDiscovery.complete ? (
                              <Button
                                disabled={controlsLocked}
                                onClick={() => applyPendingDiscovery()}
                                type="button"
                              >
                                加入资产清单
                              </Button>
                            ) : (
                              <ConfirmActionDialog
                                confirmLabel="确认加入部分结果"
                                description="只会加入当前已验证的 Token ID；未覆盖的资产不会自动补入，需另行核对。"
                                disabled={controlsLocked}
                                onConfirm={() => applyPendingDiscovery(true)}
                                title="加入部分发现结果？"
                                triggerLabel="确认并加入部分结果"
                                triggerVariant="outline"
                              />
                            )}
                          </AlertDescription>
                        </Alert>
                      ) : null}

                      {discoveryMessage ? (
                        <Alert aria-live="polite">
                          <AlertTitle>识别状态</AlertTitle>
                          <AlertDescription>{discoveryMessage}</AlertDescription>
                        </Alert>
                      ) : null}

                      {discoveryIssues.length ? (
                        <Alert variant="destructive">
                          <AlertTitle>识别提示</AlertTitle>
                          <AlertDescription>
                            <ul>
                              {discoveryIssues.slice(0, 8).map((issue, index) => (
                                <li key={issue + "-" + index}>{issue}</li>
                              ))}
                            </ul>
                          </AlertDescription>
                        </Alert>
                      ) : null}
                    </WorkbenchPanel>
                  ) : undefined}
                  contractAddress={discoveryContract}
                  contractStatus={!discoveryContract.trim() ? "empty" : discoveryContractIsValid ? "valid" : "invalid"}
                  defaultMode={standard === "erc721" ? "auto" : "manual"}
                  disabled={controlsLocked || keyImporting}
                  key={[nftInputResetNonce, standard].join("-")}
                  onChange={(value) => {
                    setCurrentAssetInput(value);
                    invalidatePlan();
                  }}
                  onContractAddressChange={(value) => {
                    setDiscoveryContract(value);
                    setPendingDiscovery(null);
                    setContractInspection(null);
                    setDiscoveryMessage("");
                    setDiscoveryIssues([]);
                    invalidatePlan();
                  }}
                  onImportingChange={handleAssetImportingChange}
                  value={assetInput}
                />

                <NftInventoryReview
                  assetInput={assetInput}
                  contractLabels={contractLabels}
                  disabled={controlsLocked}
                  onChange={(value) => {
                    setCurrentAssetInput(value);
                    invalidatePlan();
                  }}
                  standard={standard as "erc721" | "erc1155"}
                />

                <Field data-invalid={targetAddress.trim() && !targetIsValid ? true : undefined}>
                  <FieldLabel htmlFor="evm-collection-target">目标地址</FieldLabel>
                  <Input
                    aria-invalid={targetAddress.trim() && !targetIsValid ? true : undefined}
                    autoCapitalize="none"
                    autoComplete="off"
                    disabled={controlsLocked}
                    id="evm-collection-target"
                    onChange={(event) => {
                      setTargetAddress(event.target.value);
                      invalidatePlan();
                    }}
                    placeholder="0x…"
                    spellCheck={false}
                    value={targetAddress}
                  />
                  {targetAddress.trim() && !targetIsValid ? <FieldError>请输入有效的非零 EVM 地址</FieldError> : null}
                </Field>

                {sourceInputMode === "keys" ? (
                  <SecretKeyInput
                    disabled={controlsLocked || assetImporting}
                    mode="evm"
                    onDirty={() => {
                      setKeysCleared(false);
                      invalidatePlan();
                    }}
                    onImportingChange={handleKeyImportingChange}
                    onLineCountChange={setSourceKeyLineCount}
                    ref={keyInputRef}
                  />
                ) : null}
              </>
            )}

            <AdvancedSettings disabled={controlsLocked} label="RPC 与 Gas 设置">
              <EvmGasSettings
                disabled={controlsLocked}
                gas={gas}
                onSettingsChange={() => invalidatePlan()}
              />
              <Field>
                <FieldLabel htmlFor="evm-collection-rpc">RPC 地址</FieldLabel>
                <Input
                  disabled={controlsLocked}
                  id="evm-collection-rpc"
                  onChange={(event) => {
                    setRpcEndpoint(event.target.value);
                    setPendingDiscovery(null);
                    setContractInspection(null);
                    invalidatePlan();
                  }}
                  spellCheck={false}
                  type="url"
                  value={rpcEndpoint}
                />
                <FieldDescription className="sr-only">读写均使用此 RPC</FieldDescription>
              </Field>
              <Field data-invalid={maximumFeeAmount === null ? true : undefined}>
                <FieldLabel htmlFor="evm-collection-max-fee">
                  单笔网络费预算上限（{selectedNetwork.nativeCurrency.symbol}）
                </FieldLabel>
                <Input
                  aria-invalid={maximumFeeAmount === null ? true : undefined}
                  disabled={controlsLocked}
                  id="evm-collection-max-fee"
                  inputMode="decimal"
                  min="0"
                  onChange={(event) => {
                    setMaxFeeAmount(event.target.value);
                    invalidatePlan();
                  }}
                  step="0.000001"
                  type="number"
                  value={maxFeeAmount}
                />
                {maximumFeeAmount === null ? <FieldError>请输入大于 0 的有效金额</FieldError> : null}
              </Field>
            </AdvancedSettings>

            {issues.length ? (
              <Alert variant="destructive">
                <AlertTitle>输入有误</AlertTitle>
                <AlertDescription>
                  <ul aria-label="输入问题">
                    {issues.map((issue, index) => <li key={issue + "-" + index}>{issue}</li>)}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : null}

            {message ? (
              <Alert
                aria-live={workbenchStatus === "error" || workbenchStatus === "uncertain" ? "assertive" : "polite"}
                variant={workbenchStatus === "error" || workbenchStatus === "uncertain" ? "destructive" : "default"}
              >
                <AlertTitle>{evmStatusLabels[workbenchStatus]}</AlertTitle>
                <AlertDescription>{message}</AlertDescription>
              </Alert>
            ) : null}

            {stage === "running" ? (
              <ExecutionProgress
                current={completedResultCount}
                label="EVM 归集进度"
                total={readyTransactionCount || results.length}
              />
            ) : null}
          </div>
        </WorkbenchPanel>

        <WorkbenchPanel className="collection-results-panel" title="预检与结果">
          <CollectionResults
            embedded
            emptyMessage="预检后显示资产与交易。"
            emptyTitle="等待预检"
            exportFilename={currentToolId + "-results.csv"}
            results={results}
            title={fixedStandard === "nft" ? "NFT 归集结果" : "ERC20 归集结果"}
          />
        </WorkbenchPanel>
      </div>
    </ToolPageLayout>
  );
}
