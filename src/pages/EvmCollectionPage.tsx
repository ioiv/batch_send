import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createWalletClient, formatUnits, getAddress, http, isAddress, parseUnits, zeroAddress } from "viem";
import { CollectionSafetyNote } from "../components/CollectionIntro";
import { CollectionResults } from "../components/CollectionResults";
import { NftAssetInput } from "../components/NftAssetInput";
import { NftInventoryReview } from "../components/NftInventoryReview";
import { SearchableSelect, type SearchableSelectOption } from "../components/SearchableSelect";
import { SecretKeyInput, type SecretKeyInputHandle } from "../components/SecretKeyInput";
import { ToolPageLayout, type ToolPageStep, type ToolPageStepState } from "../components/ToolPageLayout";
import {
  executeEvmCollectionPlan,
  parseEvmCollectionAssets,
  parseEvmPrivateKeyInput,
  planEvmCollection,
  preflightEvmCollectionPlan,
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

const evmCollectionSteps: ToolPageStep[] = [
  { label: "导入来源", description: "选择网络并准备来源钱包" },
  { label: "核对资产", description: "读取余额并完成只读预检" },
  { label: "执行归集", description: "确认目标后本地签名" }
];

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
  const [partialDiscoveryAccepted, setPartialDiscoveryAccepted] = useState(false);
  const [discoveryRunning, setDiscoveryRunning] = useState(false);
  const [assetImporting, setAssetImporting] = useState(false);
  const [keyImporting, setKeyImporting] = useState(false);
  const [keysCleared, setKeysCleared] = useState(false);
  const [errorStep, setErrorStep] = useState<0 | 1 | 2>(0);
  const [maxFeeAmount, setMaxFeeAmount] = useState("0.01");
  const [nftStandard, setNftStandard] = useState<"erc721" | "erc1155">("erc721");
  const [nftInputResetNonce, setNftInputResetNonce] = useState(0);
  const [stage, setStage] = useState<CollectionStage>("editing");
  const [message, setMessage] = useState("");
  const [issues, setIssues] = useState<string[]>([]);
  const [results, setResults] = useState<CollectionDisplayResult[]>([]);
  const [preflightSummary, setPreflightSummary] = useState<CollectionPreflightSummary | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const keyInputRef = useRef<SecretKeyInputHandle>(null);
  const assetImportingRef = useRef(false);
  const keyImportingRef = useRef(false);
  const operationRef = useRef(false);
  const planRef = useRef<EvmCollectionPlanItem[]>([]);
  const selectedNetwork = getEvmNetworkConfig(networkId, networks);
  const effectiveRpcEndpoint = rpcEndpoint.trim() || selectedNetwork.rpcEndpoint;
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
  const sourceSigningReady = sourceKeysReady || stage === "ready" || stage === "running" || stage === "complete";
  const readonlySourcesReady = readonlySourceCount > 0 && readonlySourceIssueCount === 0;
  const discoverySourceReady = sourceInputMode === "readonly" ? readonlySourcesReady : sourceKeysReady;
  const sourceIdentityReady = sourceKeysReady || readonlySourcesReady;
  const maximumFeeAmount = parsePositiveFeeAmount(maxFeeAmount, selectedNetwork.nativeCurrency.decimals);
  const safetySettingsReady = Boolean(effectiveRpcEndpoint) && maximumFeeAmount !== null;
  const readinessTotal = fixedStandard === "nft" ? 5 : 4;
  const completedInputCount = Number(sourceSigningReady)
    + Number(parsedAssetCount > 0)
    + Number(targetIsValid)
    + Number(safetySettingsReady)
    + (fixedStandard === "nft" ? Number(sourceIdentityReady) : 0);
  const readyTransactionCount = preflightSummary?.executableTransactions ?? readyCount;
  const transactionRunning = stage === "scanning" || stage === "running";
  const operationRunning = transactionRunning || discoveryRunning;
  const running = operationRunning || assetImporting || keyImporting;
  const activeStep = stage === "error"
    ? errorStep
    : stage === "editing" ? !sourceIdentityReady ? 0 : !parsedAssetCount ? 1 : 2 : stage === "scanning" ? 1 : 2;
  const stepStates: ToolPageStepState[] | undefined = stage === "complete"
    ? ["complete", "complete", "complete"]
    : stage === "error"
      ? evmCollectionSteps.map((_, index) => index < errorStep ? "complete" : index === errorStep ? "error" : "upcoming")
      : undefined;
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
      setConfirmed(false);
      setResults([]);
      setIssues([]);
      setDiscoveryIssues([]);
      setPendingDiscovery(null);
      setPartialDiscoveryAccepted(false);
      setPreflightSummary(null);
      setMessage("页面从历史记录恢复，签名材料已清除；请重新扫描");
      setErrorStep(0);
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

  useEffect(() => {
    // A partial-discovery acknowledgement applies only to the exact result
    // currently on screen. A rescan or any edit must require it again.
    setPartialDiscoveryAccepted(false);
  }, [pendingDiscovery]);

  const parseMaximumFee = () => maximumFeeAmount;

  const invalidatePlan = (clearResults = true, preserveDiscovery = false) => {
    if (operationRef.current || transactionRunning) return;
    planRef.current = [];
    setConfirmed(false);
    setPreflightSummary(null);
    if (!preserveDiscovery) {
      setDiscoveryMessage("");
      setDiscoveryIssues([]);
    }
    setIssues([]);
    setMessage("");
    setStage("editing");
    setErrorStep(0);
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
    operationRef.current = true;
    setIssues([]);
    setMessage("");
    setConfirmed(false);
    setPreflightSummary(null);
    planRef.current = [];
    setResults([]);
    const inputToScan = assetInputOverride ?? assetInput;

    const nextIssues: string[] = [];
    if (!isAddress(targetAddress.trim())) nextIssues.push("目标地址不是有效的 EVM 地址");
    else if (getAddress(targetAddress.trim()) === zeroAddress) nextIssues.push("目标地址不能是零地址，以免资产被销毁");
    if (!effectiveRpcEndpoint) nextIssues.push("请输入可用的 RPC 地址");
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
      setErrorStep(0);
      setMessage("请修正输入后重新扫描");
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
        setErrorStep(1);
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
      setErrorStep(1);
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

  const applyPendingDiscovery = () => {
    if (!pendingDiscovery || operationRef.current || running || standard !== "erc721") return;
    if (!pendingDiscovery.complete && !partialDiscoveryAccepted) {
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

  const addPendingDiscovery = () => applyPendingDiscovery();

  const executeCollection = async () => {
    const plan = planRef.current;
    if (operationRef.current || assetImportingRef.current || keyImportingRef.current
      || stage !== "ready" || !confirmed || !plan.length || !isAddress(targetAddress.trim())) return;

    const target = getAddress(targetAddress.trim());
    const maxFeePerTransactionWei = parseMaximumFee();
    if (maxFeePerTransactionWei === null) {
      invalidatePlan(false);
      setStage("error");
      setErrorStep(1);
      setMessage("单笔最大网络费已变化，请重新扫描");
      return;
    }
    operationRef.current = true;
    setStage("running");
    setMessage(`正在执行 ${readyTransactionCount} 笔归集交易；请勿关闭页面`);

    const updateProgress = (progress: EvmCollectionProgress) => {
      setResults((current) => current.map((result, index) => {
        const planItem = plan[index];
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
      const chain = toEvmChain(selectedNetwork, effectiveRpcEndpoint);
      const executionResults = await executeEvmCollectionPlan({
        getWalletClient: (account) => createWalletClient({
          account,
          chain,
          transport: http(effectiveRpcEndpoint)
        }),
        maxFeePerTransactionWei,
        onProgress: updateProgress,
        plan,
        publicClient,
        targetAddress: target
      });
      setResults(executionResults.map((result, index) => (
        resultToDisplay(plan[index], result, (hash) => getEvmExplorerUrl(hash, selectedNetwork))
      )));
      const success = executionResults.filter((result) => result.status === "success").length;
      const failed = executionResults.filter((result) => result.status === "failed").length;
      setStage("complete");
      setMessage(`执行结束：${success} 笔确认成功${failed ? `，${failed} 笔失败` : ""}。来源密钥已从页面清除。`);
    } catch {
      setStage("error");
      setErrorStep(2);
      setMessage("归集流程意外中断；来源密钥已清除，请先按已显示的交易哈希核对链上状态，再决定是否创建新任务");
    } finally {
      operationRef.current = false;
      planRef.current = [];
      setConfirmed(false);
      setPreflightSummary(null);
    }
  };

  const focusControl = (id: string) => {
    window.requestAnimationFrame(() => {
      const element = document.getElementById(id);
      element?.scrollIntoView({ behavior: "smooth", block: "center" });
      element?.focus({ preventScroll: true });
    });
  };

  const needsDiscoverySource = fixedStandard === "nft"
    && standard === "erc721"
    && !parsedAssetCount
    && !discoverySourceReady;

  const handleGuidedAction = () => {
    if (stage === "ready") {
      if (confirmed && !running) void executeCollection();
      return;
    }
    if (running) return;
    if (needsDiscoverySource) {
      if (sourceInputMode === "readonly") focusControl("nft-discovery-sources");
      else {
        window.requestAnimationFrame(() => {
          document.getElementById("collection-source-title")?.scrollIntoView({ behavior: "smooth", block: "start" });
          keyInputRef.current?.focus();
        });
      }
      return;
    }
    if (!parsedAssetCount) {
      focusControl(fixedStandard === "nft" ? "nft-quick-contract" : "evm-collection-assets");
      return;
    }
    if (!targetIsValid) {
      focusControl("evm-collection-target");
      return;
    }
    if (!sourceKeysReady) {
      setSourceInputMode("keys");
      window.requestAnimationFrame(() => {
        document.getElementById("collection-source-title")?.scrollIntoView({ behavior: "smooth", block: "start" });
        keyInputRef.current?.focus();
      });
      return;
    }
    if (!safetySettingsReady) {
      const advancedSettings = document.querySelector<HTMLDetailsElement>(".collection-target-section details.collection-advanced");
      if (advancedSettings) advancedSettings.open = true;
      focusControl(effectiveRpcEndpoint ? "evm-collection-max-fee" : "evm-collection-rpc");
      return;
    }
    void scanAssets();
  };

  const guidedActionLabel = stage === "ready"
    ? "确认并开始归集"
    : stage === "scanning"
      ? "正在扫描与预检"
      : stage === "running"
        ? "归集中"
        : needsDiscoverySource
          ? sourceInputMode === "readonly" ? "填写只读来源地址" : "导入来源密钥"
          : !parsedAssetCount
            ? fixedStandard === "nft" ? "添加 NFT 资产" : "填写资产清单"
            : !targetIsValid
              ? "填写目标地址"
              : !sourceKeysReady
                ? keysCleared ? "重新导入来源密钥" : "导入来源密钥"
                : !safetySettingsReady
                  ? "检查 RPC / Gas 设置"
              : stage === "error" ? "重新生成归集预览" : "生成归集预览";
  const guidedActionDisabled = running || (stage === "ready" && !confirmed);

  return (
    <ToolPageLayout
      activeStep={activeStep}
      categoryHref="/#collection"
      categoryLabel="资产归集"
      currentToolId={currentToolId}
      description={fixedStandard === "erc20"
        ? "批量归集 ERC20。"
        : "归集 ERC721 或 ERC1155。"}
      eyebrow={fixedStandard === "erc20" ? "Many to one · ERC20" : "Many to one · NFT"}
      mainClassName="collection-shell collection-page"
      meta={<><span className="pill network-pill">{selectedNetwork.label}</span><span className="pill">密钥仅在本地内存</span></>}
      stepStates={stepStates}
      steps={evmCollectionSteps}
      title={fixedStandard === "erc20" ? "ERC20 代币归集" : "EVM NFT 归集"}
    >
        <div className={`workspace collection-workspace${results.length ? " has-results" : ""}`}>
          <section className="panel collection-workbench-panel" aria-labelledby="collection-config-title">
            <div className="panel-header">
              <div>
                <h2 className="panel-title" id="collection-config-title">批量归集工作台</h2>
              </div>
              <span className="collection-ready-count" aria-label={`已准备 ${completedInputCount} / ${readinessTotal} 项`}>
                {completedInputCount}/{readinessTotal}
              </span>
            </div>
            <div className="form collection-form">
              <div className="collection-mobile-guide" aria-label="归集准备进度">
                <span><strong>{completedInputCount}/{readinessTotal}</strong> 项已准备</span>
                <button
                  className="button primary"
                  disabled={guidedActionDisabled}
                  onClick={handleGuidedAction}
                  type="button"
                >{guidedActionLabel}</button>
              </div>

              {fixedStandard === "nft" ? (
                <section className="collection-source-section collection-source-board" aria-labelledby="collection-source-title">
                  <header className="collection-section-heading">
                    <span className="collection-section-index" aria-hidden="true">01</span>
                    <div className="collection-section-copy">
                      <h3 id="collection-source-title">准备来源钱包</h3>
                      <p className="hint">可先用只读地址识别；执行前需私钥。</p>
                    </div>
                    <span className="pill" data-ready={discoverySourceReady ? "true" : "false"}>
                      {sourceInputMode === "readonly"
                        ? readonlySourceIssueCount
                          ? `${readonlySourceIssueCount} 项地址需修正`
                          : readonlySourceCount ? `${readonlySourceCount} 个只读地址` : "等待只读地址"
                        : sourceKeysReady ? `${sourceKeyLineCount} 行密钥待校验` : "等待来源密钥"}
                    </span>
                  </header>

                  <div className="collection-source-mode" role="group" aria-label="来源钱包输入方式">
                    <button
                      aria-pressed={sourceInputMode === "readonly"}
                      className={sourceInputMode === "readonly" ? "is-active" : undefined}
                      disabled={running}
                      onClick={() => setSourceInputMode("readonly")}
                      type="button"
                    >
                      <strong>只读地址识别</strong>
                      <small>先看持仓，执行前再导入私钥</small>
                    </button>
                    <button
                      aria-pressed={sourceInputMode === "keys"}
                      className={sourceInputMode === "keys" ? "is-active" : undefined}
                      disabled={running}
                      onClick={() => setSourceInputMode("keys")}
                      type="button"
                    >
                      <strong>私钥归集</strong>
                      <small>本地派生地址，可识别并执行</small>
                    </button>
                  </div>

                  <div hidden={sourceInputMode !== "readonly"}>
                    <div className="field">
                      <div className="nft-field-label-row">
                        <label htmlFor="nft-discovery-sources">只读来源地址</label>
                        <span className={`nft-field-status${readonlySourceIssueCount ? " is-error" : ""}`}>
                          {readonlySourceIssueCount
                            ? `${readonlySourceIssueCount} 项需修正`
                            : readonlySourceCount ? `${readonlySourceCount} 个有效地址` : "等待输入"}
                        </span>
                      </div>
                      <textarea
                        aria-describedby="nft-discovery-sources-help"
                        aria-invalid={discoverySourceInput.trim() && readonlySourceIssueCount ? true : undefined}
                        autoCapitalize="none"
                        autoComplete="off"
                        disabled={running}
                        id="nft-discovery-sources"
                        onChange={(event) => {
                          setDiscoverySourceInput(event.target.value);
                          setPendingDiscovery(null);
                          setDiscoveryIssues([]);
                          setDiscoveryMessage("");
                        }}
                        placeholder={"每行一个来源钱包\n0x…"}
                        rows={4}
                        spellCheck={false}
                        value={discoverySourceInput}
                      />
                      <p className="hint" id="nft-discovery-sources-help">
                        {readonlySourceIssueCount
                          ? parsedReadonlySources.issues[0]
                          : "公开索引查询会暴露钱包地址与 NFT 合约；此模式不会读取或提交私钥。"}
                      </p>
                    </div>
                  </div>
                  <div hidden={sourceInputMode !== "keys"}>
                    <SecretKeyInput
                      disabled={operationRunning || assetImporting}
                      mode="evm"
                      onDirty={() => {
                        setKeysCleared(false);
                        invalidatePlan();
                      }}
                      onImportingChange={handleKeyImportingChange}
                      onLineCountChange={setSourceKeyLineCount}
                      ref={keyInputRef}
                    />
                  </div>
                </section>
              ) : null}

              {fixedStandard === "erc20" ? (
                <section className="collection-source-section collection-source-board" aria-labelledby="collection-source-title">
                  <header className="collection-section-heading">
                    <span className="collection-section-index" aria-hidden="true">01</span>
                    <div className="collection-section-copy">
                      <h3 id="collection-source-title">来源钱包</h3>
                    </div>
                    <span className="pill" data-ready={sourceSigningReady ? "true" : "false"}>
                      {sourceKeysReady ? `${sourceKeyLineCount} 行待校验` : sourceSigningReady ? "预检已载入" : "等待导入"}
                    </span>
                  </header>
                  <SecretKeyInput
                    disabled={operationRunning || assetImporting}
                    mode="evm"
                    onDirty={() => {
                      setKeysCleared(false);
                      invalidatePlan();
                    }}
                    onImportingChange={handleKeyImportingChange}
                    onLineCountChange={setSourceKeyLineCount}
                    ref={keyInputRef}
                  />
                </section>
              ) : null}

              <CollectionResults
                embedded
                emptyMessage="预检后显示结果。"
                emptyTitle="等待预检"
                exportFilename={`${currentToolId}-results.csv`}
                results={results}
                title={fixedStandard === "nft" ? "来源钱包与资产清单" : "来源钱包与代币余额"}
              />

              <div className="collection-config-primary collection-context-strip">
                <div className="field">
                  <label htmlFor="evm-collection-network">网络</label>
                  <SearchableSelect
                    disabled={running}
                    id="evm-collection-network"
                    listboxLabel="EVM 归集网络"
                    metaLabel="Chain ID"
                    onChange={selectNetwork}
                    options={networkOptions}
                    placeholder="搜索网络或 Chain ID"
                    triggerLabel="选择归集网络"
                    value={networkId}
                  />
                </div>
                {fixedStandard === "nft" ? (
                  <div className="field">
                    <label htmlFor="nft-standard">NFT 标准</label>
                    <select
                      disabled={running}
                      id="nft-standard"
                      onChange={(event) => {
                        const nextStandard = event.target.value as "erc721" | "erc1155";
                        setNftStandard(nextStandard);
                        if (nextStandard === "erc1155") setSourceInputMode("keys");
                        setNftInputResetNonce((current) => current + 1);
                        setPendingDiscovery(null);
                        setContractInspection(null);
                        invalidatePlan();
                      }}
                      value={nftStandard}
                    >
                      <option value="erc721">ERC721</option>
                      <option value="erc1155">ERC1155</option>
                    </select>
                  </div>
                ) : null}
              </div>

              <div className="collection-settings-grid">
              <section className="collection-flow-section collection-asset-section" aria-labelledby="collection-assets-title">
                <header className="collection-section-heading">
                  <span className="collection-section-index" aria-hidden="true">02</span>
                  <div className="collection-section-copy">
                    <h3 id="collection-assets-title">添加并核对资产</h3>
                  </div>
                  <span className="pill" data-ready={parsedAssetCount ? "true" : "false"}>
                    {parsedAssetCount ? `${parsedAssetCount} 项资产` : "尚未添加"}
                  </span>
                </header>

              <div className="field collection-assets-input">
                {fixedStandard !== "nft" ? <label htmlFor="evm-collection-assets">资产清单</label> : null}
                {fixedStandard === "nft" ? (
                  <div className="nft-input-modes">
                    <NftAssetInput
                      contractAddress={discoveryContract}
                      contractStatus={!discoveryContract.trim() ? "empty" : discoveryContractIsValid ? "valid" : "invalid"}
                      defaultMode={standard === "erc721" ? "auto" : "manual"}
                      disabled={operationRunning || keyImporting}
                      key={`${nftInputResetNonce}-${standard}`}
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
                    >
                    {standard === "erc721" ? (
                      <section className="nft-discovery-card" aria-labelledby="nft-discovery-title">
                        {contractInspection ? (
                          <div className="nft-contract-summary" data-status={contractInspection.standard === "unknown" ? "unsupported" : "valid"}>
                            <strong>{contractInspection.name || "已识别 NFT 合约"}</strong>
                            <span>
                              {contractInspection.symbol ? `${contractInspection.symbol} · ` : ""}
                              {contractInspection.standard.toUpperCase()}
                              {contractInspection.standard === "erc721"
                                ? contractInspection.enumerable ? " · Enumerable" : " · 普通 ERC721"
                                : ""}
                            </span>
                            <code title={contractInspection.address}>{contractInspection.address}</code>
                          </div>
                        ) : null}
                        <div className="nft-discovery-simple">
                          <div>
                            <h3 id="nft-discovery-title">从来源钱包识别 Token ID</h3>
                            <p id="nft-discovery-action-help">
                              只读操作。依次尝试原生索引、公开 Blockscout 候选和链上事件复核。
                            </p>
                          </div>
                          <button
                            aria-describedby="nft-discovery-action-help"
                            className="button primary"
                            disabled={running || !discoveryContractIsValid || !discoverySourceReady}
                            onClick={() => void discoverOwnedErc721()}
                            type="button"
                          >
                            {discoveryRunning ? "正在识别" : "识别持仓"}
                          </button>
                        </div>
                        {!discoveryContractIsValid ? (
                          <p className="hint">先填写有效的 NFT 合约地址。</p>
                        ) : !discoverySourceReady ? (
                          <p className="hint">先在“来源钱包”中准备当前模式对应的地址或密钥。</p>
                        ) : null}

                        <details className="collection-advanced">
                          <summary>发现方式与事件范围</summary>
                          <div className="collection-advanced-grid">
                            <fieldset className="nft-discovery-modes field full">
                              <legend>发现方式</legend>
                              <label className={"nft-discovery-mode" + (discoveryMode === "auto" ? " is-selected" : "")}>
                                <input
                                  checked={discoveryMode === "auto"}
                                  disabled={running}
                                  name="nft-discovery-mode"
                                  onChange={() => {
                                    setDiscoveryMode("auto");
                                    setPendingDiscovery(null);
                                    setDiscoveryIssues([]);
                                    setDiscoveryMessage("");
                                  }}
                                  type="radio"
                                />
                                <span><strong>自动</strong><small>Enumerable → Blockscout → 事件</small></span>
                              </label>
                              <label className={"nft-discovery-mode" + (discoveryMode === "enumerable" ? " is-selected" : "")}>
                                <input
                                  checked={discoveryMode === "enumerable"}
                                  disabled={running}
                                  name="nft-discovery-mode"
                                  onChange={() => {
                                    setDiscoveryMode("enumerable");
                                    setPendingDiscovery(null);
                                    setDiscoveryIssues([]);
                                    setDiscoveryMessage("");
                                  }}
                                  type="radio"
                                />
                                <span><strong>仅原生索引</strong><small>只读 ERC721Enumerable</small></span>
                              </label>
                              <label className={"nft-discovery-mode" + (discoveryMode === "transfer" ? " is-selected" : "")}>
                                <input
                                  checked={discoveryMode === "transfer"}
                                  disabled={running}
                                  name="nft-discovery-mode"
                                  onChange={() => {
                                    setDiscoveryMode("transfer");
                                    setPendingDiscovery(null);
                                    setDiscoveryIssues([]);
                                    setDiscoveryMessage("");
                                  }}
                                  type="radio"
                                />
                                <span><strong>仅事件回溯</strong><small>按 Transfer 历史恢复</small></span>
                              </label>
                            </fieldset>
                            <div className="field full">
                              <label htmlFor="nft-discovery-start-block">事件起始区块（可选）</label>
                              <input
                                disabled={running || discoveryMode === "enumerable"}
                                id="nft-discovery-start-block"
                                inputMode="numeric"
                                onChange={(event) => {
                                  setDiscoveryStartBlock(event.target.value);
                                  setPendingDiscovery(null);
                                  setDiscoveryIssues([]);
                                  setDiscoveryMessage("");
                                }}
                                placeholder="留空时自动定位合约部署区块"
                                spellCheck={false}
                                value={discoveryStartBlock}
                              />
                              <p className="hint">仅用于事件回溯；结果会标注范围。</p>
                            </div>
                          </div>
                        </details>
                        {pendingDiscovery ? (
                          <div className="nft-discovery-pending" aria-live="polite">
                            <div>
                              <span className="nft-discovery-verdict" data-complete={pendingDiscovery.complete ? "true" : "false"}>
                                {pendingDiscovery.complete
                                  ? pendingDiscovery.kind === "transfer" && pendingDiscovery.scope === "full-history"
                                    ? "完整历史已验证"
                                    : "扫描范围已验证"
                                  : "部分候选结果"}
                              </span>
                              <strong>已准备 {pendingDiscovery.assets.length} 个 Token ID</strong>
                              <p>
                                {pendingDiscovery.kind === "transfer"
                                  ? "快照区块 " + (pendingDiscovery.latestBlock?.toString() || "—")
                                    + " · " + (pendingDiscovery.scope === "full-history" ? "合约部署以来" : "指定区块范围")
                                  : pendingDiscovery.kind === "indexer"
                                    ? "Blockscout 候选 · 链上快照 " + (pendingDiscovery.latestBlock?.toString() || "—")
                                    : "通过 ERC721Enumerable 索引读取"}
                              </p>
                              <code>
                                Token ID：{pendingDiscovery.assets.slice(0, 8).map((asset) => asset.tokenId.toString()).join(" · ")}
                                {pendingDiscovery.assets.length > 8 ? " · …" : ""}
                              </code>
                            </div>
                            <div className="nft-discovery-pending-actions">
                              {!pendingDiscovery.complete ? (
                                <label className="nft-discovery-partial-confirm">
                                  <input
                                    checked={partialDiscoveryAccepted}
                                    disabled={running}
                                    onChange={(event) => setPartialDiscoveryAccepted(event.target.checked)}
                                    type="checkbox"
                                  />
                                  <span>我确认仅归集已验证的部分结果，未覆盖项目不会被静默忽略。</span>
                                </label>
                              ) : null}
                              <div>
                                <button
                                  className="button primary"
                                  disabled={running || (!pendingDiscovery.complete && !partialDiscoveryAccepted)}
                                  onClick={addPendingDiscovery}
                                  type="button"
                                >
                                  加入资产清单
                                </button>
                              </div>
                            </div>
                          </div>
                        ) : null}
                        {discoveryMessage ? <p className="hint" role="status">{discoveryMessage}</p> : null}
                        {discoveryIssues.length ? (
                          <ul className="nft-discovery-issues" role="alert">
                            {discoveryIssues.slice(0, 8).map((issue, index) => <li key={`${issue}-${index}`}>{issue}</li>)}
                            {discoveryIssues.length > 8 ? <li>另有 {discoveryIssues.length - 8} 项提示；建议分批发现并与链上资产清单核对。</li> : null}
                          </ul>
                        ) : null}
                      </section>
                    ) : null}
                    </NftAssetInput>
                  </div>
                ) : null}
                {fixedStandard !== "nft" ? (
                  <textarea
                    className="collection-asset-textarea"
                    disabled={running}
                    id="evm-collection-assets"
                    onChange={(event) => {
                      setCurrentAssetInput(event.target.value);
                      invalidatePlan();
                    }}
                    placeholder="每行一个 ERC20 合约地址\n0x…"
                    spellCheck={false}
                    value={assetInput}
                  />
                ) : null}
                <p className="hint">
                  {standard === "erc1155"
                    ? "同来源、同合约资产会合并转账。"
                    : standard === "erc721"
                      ? "没有 owner 私钥的资产会跳过。"
                      : "余额为 0 的来源会跳过。"}
                </p>
              </div>

              {fixedStandard === "nft" ? (
                <NftInventoryReview
                  assetInput={assetInput}
                  contractLabels={contractLabels}
                  disabled={running}
                  onChange={(value) => {
                    setCurrentAssetInput(value);
                    invalidatePlan();
                  }}
                  standard={standard as "erc721" | "erc1155"}
                />
              ) : null}

              </section>

              <section className="collection-flow-section collection-target-section" aria-labelledby="collection-target-title">
                <header className="collection-section-heading">
                  <span className="collection-section-index" aria-hidden="true">03</span>
                  <div className="collection-section-copy">
                    <h3 id="collection-target-title">确认目标与费用</h3>
                  </div>
                  <span className="pill" data-ready={targetIsValid ? "true" : "false"}>
                    {targetIsValid ? "目标有效" : "等待目标地址"}
                  </span>
                </header>

              <div className="field">
                <label htmlFor="evm-collection-target">归集到</label>
                <input
                  aria-describedby="evm-collection-target-help"
                  aria-invalid={targetAddress.trim() && !targetIsValid ? true : undefined}
                  autoCapitalize="none"
                  autoComplete="off"
                  disabled={running}
                  id="evm-collection-target"
                  onChange={(event) => {
                    setTargetAddress(event.target.value);
                    invalidatePlan();
                  }}
                  placeholder="目标钱包 0x…"
                  spellCheck={false}
                  value={targetAddress}
                />
                <p className="hint" id="evm-collection-target-help">
                  {targetAddress.trim() && !targetIsValid
                    ? "请输入有效的非零 EVM 地址。"
                    : "签名前会再次显示完整地址。"}
                </p>
              </div>

              <details className="collection-advanced">
                <summary>RPC 与 Gas 安全设置</summary>
                <div className="collection-advanced-grid">
                  <div className="field full">
                    <label htmlFor="evm-collection-rpc">RPC 地址</label>
                    <input
                      aria-describedby="evm-collection-rpc-help"
                      disabled={running}
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
                    <p className="hint" id="evm-collection-rpc-help">读写均使用此 RPC。</p>
                  </div>
                  <div className="field full">
                    <label htmlFor="evm-collection-max-fee">
                      单笔执行 Gas 预算上限（{selectedNetwork.nativeCurrency.symbol}）
                    </label>
                    <input
                      aria-describedby="evm-collection-max-fee-help"
                      aria-invalid={maximumFeeAmount === null ? true : undefined}
                      disabled={running}
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
                    <p className="hint" id="evm-collection-max-fee-help">
                      {maximumFeeAmount === null
                        ? "请输入大于 0 的有效预算。"
                        : "超出上限将阻止提交；L2 数据费另计。"}
                    </p>
                  </div>
                </div>
              </details>

              </section>
              </div>

            <section
              className="collection-command-panel collection-command-panel--inline"
              aria-label="归集任务操作"
              aria-labelledby="collection-command-title"
            >
              <div className="panel-header">
                <div>
                  <h3 className="panel-title" id="collection-command-title">检查并预检</h3>
                </div>
                <span className="pill">仅链上 Gas · 平台费 0</span>
                <span className="sr-only">不上传密钥、不收平台费、不调用收费归集合约</span>
              </div>
              <div className="collection-command-body">
              <ul className="collection-readiness" aria-label="预检准备项">
                {fixedStandard === "nft" ? (
                  <li data-ready={sourceIdentityReady ? "true" : "false"}>
                    <span aria-hidden="true">{sourceIdentityReady ? "✓" : "1"}</span>
                    <strong>识别来源</strong>
                  </li>
                ) : null}
                <li data-ready={parsedAssetCount ? "true" : "false"}>
                  <span aria-hidden="true">{parsedAssetCount ? "✓" : fixedStandard === "nft" ? "2" : "1"}</span>
                  <strong>{fixedStandard === "nft" ? "NFT 资产" : "ERC20 资产"}</strong>
                </li>
                <li data-ready={targetIsValid ? "true" : "false"}>
                  <span aria-hidden="true">{targetIsValid ? "✓" : fixedStandard === "nft" ? "3" : "2"}</span>
                  <strong>目标地址</strong>
                </li>
                <li data-ready={sourceSigningReady ? "true" : "false"}>
                  <span aria-hidden="true">{sourceSigningReady ? "✓" : fixedStandard === "nft" ? "4" : "3"}</span>
                  <strong>签名密钥</strong>
                </li>
                <li data-ready={safetySettingsReady ? "true" : "false"}>
                  <span aria-hidden="true">{safetySettingsReady ? "✓" : fixedStandard === "nft" ? "5" : "4"}</span>
                  <strong>RPC 与 Gas</strong>
                </li>
              </ul>

              {issues.length ? (
                <ul className="collection-issue-list" aria-label="输入问题" role="alert">
                  {issues.map((issue, index) => <li key={`${issue}-${index}`}>{issue}</li>)}
                </ul>
              ) : null}

              {message ? (
                <div className="collection-inline-status" data-status={stage === "error" ? "error" : stage === "complete" ? "success" : stage} aria-live={stage === "error" ? "assertive" : "polite"} role={stage === "error" ? "alert" : "status"}>
                  <strong>{stage === "ready" ? "等待最终确认" : stage === "complete" ? "任务已结束" : "任务状态"}</strong>
                  <p>{message}</p>
                </div>
              ) : null}

              {stage === "ready" ? (
                <div className="collection-final-confirm">
                  <strong>将执行 {readyTransactionCount} 笔交易，归集 {readyCount} 项资产</strong>
                  <p>目标：{targetAddress}</p>
                  {preflightSummary ? (
                    <p>
                      预检时预计网络费：{formatUnits(
                        preflightSummary.estimatedNetworkFee,
                        selectedNetwork.nativeCurrency.decimals
                      )} {selectedNetwork.nativeCurrency.symbol}；提交前会重新估算。
                    </p>
                  ) : null}
                  <p>
                    执行 Gas 预算上限：每笔 {maxFeeAmount} {selectedNetwork.nativeCurrency.symbol}；按交易数合计 {(() => {
                      const maximumFee = parseMaximumFee();
                      return maximumFee === null
                        ? "—"
                        : formatUnits(maximumFee * BigInt(readyTransactionCount), selectedNetwork.nativeCurrency.decimals);
                    })()} {selectedNetwork.nativeCurrency.symbol}。部分 L2 的 L1 数据费不包含在此预算中。
                  </p>
                  <label className="collection-confirm-check">
                    <input checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} type="checkbox" />
                    <span>我已核对网络、目标地址和下方资产明细，并理解交易一旦确认不可撤销。</span>
                  </label>
                </div>
              ) : null}

              <div className="actions collection-actions">
                <button className="button danger" disabled={running} onClick={() => {
                  const hasTaskContent = Boolean(targetAddress.trim() || assetInput.trim() || keyInputRef.current?.read().trim() || results.length);
                  if (hasTaskContent && !window.confirm("确认清空当前归集任务？来源密钥、资产清单和预检结果将无法恢复。")) return;
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
                  setPartialDiscoveryAccepted(false);
                  setDiscoveryIssues([]);
                  setDiscoveryMessage("");
                  setNftInputResetNonce((current) => current + 1);
                  setTargetAddress("");
                  setMaxFeeAmount("0.01");
                  setResults([]);
                  setKeysCleared(false);
                  setPreflightSummary(null);
                  setIssues([]);
                  setMessage("");
                  setConfirmed(false);
                  setStage("editing");
                  setErrorStep(0);
                }} type="button">清空任务</button>
                <button
                  aria-describedby="collection-preview-readiness"
                  className="button primary"
                  disabled={guidedActionDisabled}
                  onClick={handleGuidedAction}
                  type="button"
                >{guidedActionLabel}</button>
              </div>

              {stage !== "ready" && stage !== "running" ? (
                <p className="hint" id="collection-preview-readiness">
                  {needsDiscoverySource
                    ? sourceInputMode === "readonly"
                      ? "下一步：填写只读来源地址。"
                      : "下一步：导入来源密钥。"
                    : !parsedAssetCount
                    ? "下一步：加入有效资产。"
                    : !targetIsValid
                      ? "下一步：填写目标地址。"
                      : !sourceKeysReady
                        ? "下一步：导入 owner 私钥。"
                        : !safetySettingsReady
                          ? "下一步：检查 RPC 与 Gas。"
                      : "准备就绪，可开始预检。"}
                </p>
              ) : null}

              <CollectionSafetyNote />
            </div>
            </section>
            </div>
          </section>
        </div>
    </ToolPageLayout>
  );
}
