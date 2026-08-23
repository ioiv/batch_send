import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createWalletClient,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseUnits,
  zeroAddress,
  type Address
} from "viem";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { EvmGasBadge, EvmGasSettings } from "../components/EvmGasControl";
import { CollectionResults } from "../components/CollectionResults";
import { NftAssetInput } from "../components/NftAssetInput";
import { NftInventoryReview } from "../components/NftInventoryReview";
import { SearchableSelect, type SearchableSelectOption } from "../components/SearchableSelect";
import {
  SecretKeyInput,
  type SecretKeyInputHandle,
  type WalletExecutionItem
} from "../components/SecretKeyInput";
import { ToolPageLayout, type WorkbenchStatus } from "../components/ToolPageLayout";
import {
  AdvancedSettings,
  ConfirmActionDialog,
  ExecutionProgress,
  ReviewPanel,
  WorkbenchPanel
} from "../components/WorkbenchPrimitives";
import { useEvmGas } from "../hooks/useEvmGas";
import {
  executeEvmCollectionPlan,
  erc20CollectionAbi,
  parseEvmCollectionAssets,
  parseEvmPrivateKeyInput,
  planEvmCollection,
  readErc20Metadata,
  type EvmCollectionAccount,
  type EvmCollectionAsset,
  type EvmCollectionPlanItem,
  type EvmCollectionProgress,
  type EvmCollectionResult,
  type EvmCollectionStandard
} from "../lib/evm-collection";
import { resolveCollectionAmount, type CollectionAmountPolicy } from "../lib/collection-amount";
import {
  mapWithCollectionConcurrency,
  waitForCollectionDelay
} from "../lib/collection-execution";
import {
  assertEvmRpcNetwork,
  createEvmPublicClient,
  getEvmDistributionNetworks,
  getEvmExplorerUrl,
  getEvmNetworkConfig,
  getPreferredEvmDistributionNetwork,
  isEvmNativeCurrencyEnabled,
  rememberPreferredEvmDistributionNetwork,
  toEvmChain,
  type EvmChainConfig,
  type EvmDistributionNetworkId,
  type EvmNativeCurrency
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
import { discoverErc1155AssetsByTransfer } from "../lib/erc1155-transfer-discovery";
import { mergeNftAssetInput } from "../lib/nft-asset-input";
import {
  getSettledNftAssetKeys,
  reconcileNftContractInventory,
  removeValidNftInventoryAssets
} from "../lib/nft-inventory";
import { inspectNftContract, type NftContractInspection } from "../lib/nft-contract-inspection";
import { getPreferredRpcEndpoint, isRpcEndpoint, rememberRpcEndpoint } from "../lib/rpc-preferences";

type CollectionStage = "editing" | "scanning" | "ready" | "running" | "complete" | "error";
type NftSourceInputMode = "keys" | "readonly";

type PendingNftDiscovery = {
  assets: Array<{ contractAddress: string; tokenId: bigint }>;
  complete: boolean;
  contractAddress: string;
  kind: "enumerable" | "indexer" | "transfer";
  latestBlock?: bigint;
  scope?: Erc721TransferDiscoveryScope;
  standard: "erc721" | "erc1155";
};

type PendingNftHistoryScan = {
  contractAddress: string;
  deploymentBlock: bigint;
  fallbackDiscovery: PendingNftDiscovery | null;
  indexedIssues: string[];
  ownerAddresses: string[];
  snapshotBlock: bigint;
  sourceIssues: string[];
  standard: "erc721" | "erc1155";
};

type ArchivedCollectionRound = {
  message: string;
  results: CollectionDisplayResult[];
  sequence: number;
};

type AmountMode = CollectionAmountPolicy["mode"];

type Erc20TokenPreview = {
  address: Address;
  decimals?: number;
  message?: string;
  name?: string;
  status: "error" | "ready";
  symbol?: string;
};

type TokenRecognitionState = {
  items: Erc20TokenPreview[];
  message: string;
  status: "error" | "idle" | "loading" | "ready";
};

type AddressBalanceAsset = {
  amount: string;
  contractAddress?: Address;
  symbol: string;
};

type AddressBalanceRow = {
  address: Address;
  assets: AddressBalanceAsset[];
  label: string;
};

type AddressBalanceState = {
  message: string;
  rows: AddressBalanceRow[];
  status: "error" | "idle" | "loading" | "ready";
};

const emptyTokenRecognitionState: TokenRecognitionState = {
  items: [],
  message: "",
  status: "idle"
};

const emptyAddressBalanceState: AddressBalanceState = {
  message: "",
  rows: [],
  status: "idle"
};

const maximumAutomaticTokenMetadata = 50;

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

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
  preflight: "检查中",
  ready: "等待确认",
  running: "执行中",
  success: "本轮完成",
  uncertain: "需核对链上状态"
};

const amountModeLabels: Record<AmountMode, string> = {
  all: "全部数量",
  fixed: "固定数量",
  percentage: "百分比数量",
  random: "随机数量"
};

function shorten(value: string, edge = 6) {
  return value.length > edge * 2 + 1 ? `${value.slice(0, edge)}…${value.slice(-edge)}` : value;
}

function isAbortError(error: unknown, signal?: AbortSignal) {
  return Boolean(signal?.aborted)
    || (Boolean(error) && typeof error === "object" && (error as { name?: unknown }).name === "AbortError");
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

function parsePositiveFeeAmount(value: string, decimals: number) {
  try {
    const parsed = parseUnits(value.trim(), decimals);
    return parsed > 0n ? parsed : null;
  } catch {
    return null;
  }
}

const defaultCollectionFeeCapByChainId: Readonly<Record<number, string>> = {
  1: "0.01",
  10: "0.003",
  56: "0.01",
  100: "0.05",
  137: "0.1",
  143: "0.01",
  999: "0.01",
  4663: "0.003",
  8453: "0.003",
  10143: "0.05",
  42161: "0.003",
  43113: "0.05",
  43114: "0.01",
  80002: "0.5",
  84532: "0.01",
  421614: "0.01",
  560048: "0.05",
  11155111: "0.05",
  11155420: "0.01"
};

export function getDefaultEvmCollectionFeeCap(
  network: Pick<EvmChainConfig, "chainId" | "nativeCurrency">
) {
  const configured = defaultCollectionFeeCapByChainId[network.chainId];
  if (configured) return configured;
  const symbol = network.nativeCurrency.symbol.toUpperCase();
  if (symbol === "POL") return "0.1";
  if (symbol === "XDAI") return "0.05";
  return "0.01";
}

function getAssetName(item: EvmCollectionPlanItem, nativeCurrency: EvmNativeCurrency) {
  if (item.asset.standard === "native") return nativeCurrency.symbol;
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

function getFormattedAmount(
  item: Pick<EvmCollectionPlanItem, "amount" | "asset" | "metadata">,
  nativeCurrency: EvmNativeCurrency
) {
  if (item.asset.standard === "native") {
    return formatUnits(item.amount, nativeCurrency.decimals);
  }
  if (item.asset.standard === "erc20") {
    return formatUnits(item.amount, item.metadata?.decimals ?? 0);
  }
  return item.amount.toString();
}

function formatBalanceForDisplay(value: bigint, decimals: number) {
  const formatted = formatUnits(value, decimals);
  const [whole, fraction = ""] = formatted.split(".");
  const compactFraction = fraction.slice(0, 8).replace(/0+$/u, "");
  return compactFraction ? `${whole}.${compactFraction}` : whole;
}

function parsePercentageBps(value: string) {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const bps = BigInt(match[1]) * 100n + BigInt((match[2] || "").padEnd(2, "0"));
  return bps > 0n && bps <= 10_000n ? bps : null;
}

function parseEvmAmountPolicy({
  decimals,
  fixedAmount,
  mode,
  percentageAmount,
  randomMaximum,
  randomMinimum
}: {
  decimals: number;
  fixedAmount: string;
  mode: AmountMode;
  percentageAmount: string;
  randomMaximum: string;
  randomMinimum: string;
}): CollectionAmountPolicy | null {
  if (mode === "all") return { mode: "all" };
  if (mode === "percentage") {
    const percentageBps = parsePercentageBps(percentageAmount);
    return percentageBps === null ? null : { mode, percentageBps };
  }
  try {
    if (mode === "fixed") {
      const amount = parseUnits(fixedAmount.trim(), decimals);
      return amount > 0n ? { amount, mode } : null;
    }
    const minAmount = parseUnits(randomMinimum.trim(), decimals);
    const maxAmount = parseUnits(randomMaximum.trim(), decimals);
    return minAmount > 0n && maxAmount >= minAmount ? { maxAmount, minAmount, mode } : null;
  } catch {
    return null;
  }
}

function applyEvmAmountPolicy(
  plan: readonly EvmCollectionPlanItem[],
  nativeDecimals: number,
  settings: Omit<Parameters<typeof parseEvmAmountPolicy>[0], "decimals">
) {
  return plan.map((item) => {
    if (item.status !== "ready" || (item.asset.standard !== "native" && item.asset.standard !== "erc20")) {
      return item;
    }
    const decimals = item.asset.standard === "native" ? nativeDecimals : item.metadata?.decimals;
    if (decimals === undefined) {
      return { ...item, message: "无法确定资产精度，已跳过", status: "failed" as const };
    }
    const amountPolicy = parseEvmAmountPolicy({ ...settings, decimals });
    if (!amountPolicy) {
      return { ...item, message: "归集数量设置无效", status: "failed" as const };
    }
    if (item.asset.standard === "native") {
      return { ...item, amountPolicy, message: "等待执行时扣除网络费并计算归集数量" };
    }
    const resolved = resolveCollectionAmount(item.amount, amountPolicy);
    if (resolved.status === "skipped") {
      return { ...item, amount: 0n, message: "代币余额不足以满足归集数量设置，已跳过", status: "skipped" as const };
    }
    return { ...item, amount: resolved.amount, amountPolicy, message: "已按数量设置计算归集金额" };
  });
}

function groupWalletStatuses(results: readonly CollectionDisplayResult[]) {
  const grouped: Record<string, WalletExecutionItem[]> = {};
  results.forEach((result) => {
    const key = result.address.toLowerCase();
    if (!key || key === "—") return;
    (grouped[key] ||= []).push({
      amount: result.amount,
      asset: result.asset,
      explorerUrl: result.explorerUrl,
      hash: result.hash,
      message: result.message,
      status: result.status
    });
  });
  return grouped;
}

function planItemToDisplay(
  item: EvmCollectionPlanItem,
  nativeCurrency: EvmNativeCurrency
): CollectionDisplayResult {
  return {
    address: item.address || "—",
    amount: getFormattedAmount(item, nativeCurrency),
    asset: getAssetName(item, nativeCurrency),
    assetKey: item.asset.key,
    label: item.label,
    message: item.message,
    status: item.status === "ready" ? "pending" : item.status === "skipped" ? "skipped" : "error"
  };
}

function resultToDisplay(
  item: EvmCollectionPlanItem,
  result: EvmCollectionResult,
  nativeCurrency: EvmNativeCurrency,
  explorerUrl: (hash: string) => string
): CollectionDisplayResult {
  return {
    address: result.address || "—",
    amount: getFormattedAmount(
      { amount: result.amount, asset: result.asset, metadata: item.metadata },
      nativeCurrency
    ),
    asset: getAssetName(item, nativeCurrency),
    assetKey: item.asset.key,
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
  return [
    item.id,
    item.address?.toLowerCase() || "",
    item.asset.key,
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
  const [rpcEndpoint, setRpcEndpoint] = useState(() => getPreferredRpcEndpoint(
    "evm",
    initialNetwork.id,
    initialNetwork.rpcEndpoint
  ));
  const [targetAddress, setTargetAddress] = useState("");
  const [erc20AssetInput, setErc20AssetInput] = useState("");
  const [nftAssetInputs, setNftAssetInputs] = useState({ erc721: "", erc1155: "" });
  const [discoveryContract, setDiscoveryContract] = useState("");
  const [discoverySourceInput, setDiscoverySourceInput] = useState("");
  const [sourceInputMode, setSourceInputMode] = useState<NftSourceInputMode>("readonly");
  const [sourceKeyLineCount, setSourceKeyLineCount] = useState(0);
  const [discoveryIssues, setDiscoveryIssues] = useState<string[]>([]);
  const [discoveryMessage, setDiscoveryMessage] = useState("");
  const [contractInspection, setContractInspection] = useState<NftContractInspection | null>(null);
  const [pendingDiscovery, setPendingDiscovery] = useState<PendingNftDiscovery | null>(null);
  const [pendingHistoryScan, setPendingHistoryScan] = useState<PendingNftHistoryScan | null>(null);
  const [historyStartBlock, setHistoryStartBlock] = useState("");
  const [discoveryComplete, setDiscoveryComplete] = useState(false);
  const [discoveryRunning, setDiscoveryRunning] = useState(false);
  const [assetImporting, setAssetImporting] = useState(false);
  const [keyImporting, setKeyImporting] = useState(false);
  const [amountMode, setAmountMode] = useState<AmountMode>("all");
  const [percentageAmount, setPercentageAmount] = useState("100");
  const [fixedAmount, setFixedAmount] = useState("0.1");
  const [randomMinimum, setRandomMinimum] = useState("0.01");
  const [randomMaximum, setRandomMaximum] = useState("0.1");
  const [concurrency, setConcurrency] = useState("3");
  const [minimumDelay, setMinimumDelay] = useState("0");
  const [maximumDelay, setMaximumDelay] = useState("0");
  const [maxFeeAmount, setMaxFeeAmount] = useState(() => getDefaultEvmCollectionFeeCap(initialNetwork));
  const [nftStandard, setNftStandard] = useState<"erc721" | "erc1155">("erc721");
  const [nftInputResetNonce, setNftInputResetNonce] = useState(0);
  const [stage, setStage] = useState<CollectionStage>("editing");
  const [message, setMessage] = useState("");
  const [issues, setIssues] = useState<string[]>([]);
  const [results, setResults] = useState<CollectionDisplayResult[]>([]);
  const [archivedRound, setArchivedRound] = useState<ArchivedCollectionRound | null>(null);
  const [roundSequence, setRoundSequence] = useState(1);
  const [tokenRecognition, setTokenRecognition] = useState<TokenRecognitionState>(emptyTokenRecognitionState);
  const [addressBalances, setAddressBalances] = useState<AddressBalanceState>(emptyAddressBalanceState);
  const keyInputRef = useRef<SecretKeyInputHandle>(null);
  const assetImportingRef = useRef(false);
  const balanceRequestRef = useRef(0);
  const keyImportingRef = useRef(false);
  const operationRef = useRef(false);
  const planRef = useRef<EvmCollectionPlanItem[]>([]);
  const retryPlanRef = useRef<EvmCollectionPlanItem[]>([]);
  const historyScanAbortRef = useRef<AbortController | null>(null);
  const tokenMetadataCacheRef = useRef(new Map<string, Erc20TokenPreview>());
  const tokenRecognitionRequestRef = useRef(0);
  const selectedNetwork = getEvmNetworkConfig(networkId, networks);
  const effectiveRpcEndpoint = rpcEndpoint.trim() || selectedNetwork.rpcEndpoint;
  const gas = useEvmGas({
    network: selectedNetwork,
    rpcEndpoint: effectiveRpcEndpoint
  });
  const standard: EvmCollectionStandard = fixedStandard === "erc20"
    ? (erc20AssetInput.trim() ? "erc20" : "native")
    : nftStandard;
  const currentToolId = fixedStandard === "erc20" ? "evm-token-collection" : "evm-nft-collection";
  const assetInput = fixedStandard === "erc20" ? erc20AssetInput : nftAssetInputs[nftStandard];
  const setCurrentAssetInput = (value: string) => {
    if (fixedStandard === "erc20") {
      setErc20AssetInput(value);
      return;
    }
    setNftAssetInputs((current) => ({ ...current, [nftStandard]: value }));
  };
  const parsedAssetCount = useMemo(
    () => parseEvmCollectionAssets(assetInput, standard).validAssets.length,
    [assetInput, standard]
  );
  const walletBalances = useMemo<Record<string, AddressBalanceAsset[]>>(() => Object.fromEntries(
    addressBalances.rows.map((row) => [row.address.toLowerCase(), row.assets])
  ), [addressBalances.rows]);
  const tokenInputRows = useMemo(() => {
    const rows = erc20AssetInput.split(/\r?\n/);
    return rows.length ? rows : [""];
  }, [erc20AssetInput]);
  const recognizedTokenByAddress = useMemo(() => new Map(
    tokenRecognition.items.map((item) => [item.address.toLowerCase(), item] as const)
  ), [tokenRecognition.items]);
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
  const defaultMaximumFeeAmount = getDefaultEvmCollectionFeeCap(selectedNetwork);
  const nativeCurrencyEnabled = isEvmNativeCurrencyEnabled(selectedNetwork);
  const transactionRunning = stage === "running";
  const operationRunning = transactionRunning || discoveryRunning;
  const running = operationRunning || assetImporting || keyImporting;
  const hasSubmittedHash = results.some((result) => Boolean(result.hash));
  const controlsLocked = running || hasSubmittedHash;
  const workbenchStatus = getEvmCollectionWorkbenchStatus(stage, results);
  const completedResultCount = results.filter((result) => (
    result.status === "success" || result.status === "error" || result.status === "skipped"
  )).length;
  const retryableCount = retryPlanRef.current.length;
  const walletStatuses = useMemo(() => groupWalletStatuses(results), [results]);
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
      historyScanAbortRef.current?.abort();
      planRef.current = [];
      retryPlanRef.current = [];
    };
    const resetRestoredPage = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      planRef.current = [];
      setResults([]);
      setIssues([]);
      setDiscoveryIssues([]);
      setPendingDiscovery(null);
      setPendingHistoryScan(null);
      historyScanAbortRef.current?.abort();
      historyScanAbortRef.current = null;
      setDiscoveryComplete(false);
      retryPlanRef.current = [];
      setMessage("页面从历史记录恢复，签名材料已清除；请重新导入来源钱包");
      setStage("editing");
    };
    window.addEventListener("pagehide", discardSigningPlan);
    window.addEventListener("pageshow", resetRestoredPage);
    return () => {
      window.removeEventListener("pagehide", discardSigningPlan);
      window.removeEventListener("pageshow", resetRestoredPage);
      historyScanAbortRef.current?.abort();
      planRef.current = [];
    };
  }, []);

  useEffect(() => {
    if (fixedStandard !== "erc20" || !erc20AssetInput.trim()) {
      tokenRecognitionRequestRef.current += 1;
      setTokenRecognition(emptyTokenRecognitionState);
      return;
    }

    const parsed = parseEvmCollectionAssets(erc20AssetInput, "erc20");
    const tokenAssets = parsed.validAssets.filter((asset): asset is Extract<
      EvmCollectionAsset,
      { standard: "erc20" }
    > => asset.standard === "erc20");
    const invalidRows = parsed.rows.filter((row) => row.status === "invalid");
    if (!tokenAssets.length) {
      tokenRecognitionRequestRef.current += 1;
      setTokenRecognition({
        items: [],
        message: invalidRows.length ? `第 ${invalidRows[0].line} 行不是有效的 ERC20 合约地址` : "",
        status: "error"
      });
      return;
    }

    const limitedAssets = tokenAssets.slice(0, maximumAutomaticTokenMetadata);
    const recognitionScope = `${selectedNetwork.id}:${effectiveRpcEndpoint}`;
    const getCacheKey = (address: Address) => `${recognitionScope}:${address.toLowerCase()}`;
    const cachedItems = limitedAssets.flatMap((asset) => {
      const cached = tokenMetadataCacheRef.current.get(getCacheKey(asset.contractAddress));
      return cached ? [cached] : [];
    });
    const missingAssets = limitedAssets.filter(
      (asset) => !tokenMetadataCacheRef.current.has(getCacheKey(asset.contractAddress))
    );

    if (!missingAssets.length) {
      tokenRecognitionRequestRef.current += 1;
      const failed = cachedItems.filter((item) => item.status === "error").length;
      const truncated = tokenAssets.length > limitedAssets.length;
      setTokenRecognition({
        items: cachedItems,
        message: truncated
          ? `已识别前 ${limitedAssets.length} 个 Token；其余将在执行时读取`
          : failed ? `${cachedItems.length - failed} 个已识别，${failed} 个读取失败` : `${cachedItems.length} 个 Token 已识别`,
        status: failed === cachedItems.length ? "error" : "ready"
      });
      return;
    }

    const requestId = tokenRecognitionRequestRef.current + 1;
    tokenRecognitionRequestRef.current = requestId;
    setTokenRecognition({
      items: cachedItems,
      message: `正在识别 ${missingAssets.length} 个新 Token…`,
      status: "loading"
    });

    const timeoutId = window.setTimeout(() => {
      void (async () => {
        try {
          const publicClient = createEvmPublicClient(selectedNetwork, effectiveRpcEndpoint);
          await assertEvmRpcNetwork(publicClient, selectedNetwork);
          const fetchedItems = await mapWithConcurrency(missingAssets, 5, async (asset): Promise<Erc20TokenPreview> => {
            try {
              const metadata = await readErc20Metadata(publicClient, asset.contractAddress);
              return { ...metadata, address: metadata.contractAddress, status: "ready" };
            } catch {
              return {
                address: asset.contractAddress,
                message: "无法读取代币符号，请确认网络与合约地址",
                status: "error"
              };
            }
          });
          if (requestId !== tokenRecognitionRequestRef.current) return;
          fetchedItems.forEach((item) => {
            if (item.status === "ready") {
              tokenMetadataCacheRef.current.set(getCacheKey(item.address), item);
            }
          });
          const fetchedByAddress = new Map(
            fetchedItems.map((item) => [item.address.toLowerCase(), item] as const)
          );
          const items = limitedAssets.flatMap((asset) => {
            const item = tokenMetadataCacheRef.current.get(getCacheKey(asset.contractAddress))
              || fetchedByAddress.get(asset.contractAddress.toLowerCase());
            return item ? [item] : [];
          });
          const failed = items.filter((item) => item.status === "error").length;
          const truncated = tokenAssets.length > limitedAssets.length;
          setTokenRecognition({
            items,
            message: truncated
              ? `已识别前 ${limitedAssets.length} 个 Token；其余将在执行时读取`
              : failed ? `${items.length - failed} 个已识别，${failed} 个读取失败` : `${items.length} 个 Token 已识别`,
            status: failed === items.length ? "error" : "ready"
          });
        } catch {
          if (requestId !== tokenRecognitionRequestRef.current) return;
          setTokenRecognition({
            items: [],
            message: "Token 识别失败，请检查当前网络与 RPC",
            status: "error"
          });
        }
      })();
    }, 450);

    return () => {
      window.clearTimeout(timeoutId);
      if (tokenRecognitionRequestRef.current === requestId) tokenRecognitionRequestRef.current += 1;
    };
  }, [effectiveRpcEndpoint, erc20AssetInput, fixedStandard, selectedNetwork]);

  const parseMaximumFee = () => maximumFeeAmount;

  const invalidatePlan = (
    clearResults = true,
    preserveDiscovery = false,
    clearAddressBalances = true
  ) => {
    if (operationRef.current || transactionRunning) return;
    planRef.current = [];
    retryPlanRef.current = [];
    if (clearAddressBalances) {
      balanceRequestRef.current += 1;
      setAddressBalances(emptyAddressBalanceState);
    }
    if (!preserveDiscovery) {
      setDiscoveryMessage("");
      setDiscoveryIssues([]);
    }
    setIssues([]);
    setMessage("");
    setStage("editing");
    if (clearResults) setResults([]);
  };

  const updateErc20TokenRows = (rows: string[]) => {
    setErc20AssetInput(rows.length ? rows.join("\n") : "");
    invalidatePlan();
  };

  const selectNetwork = (value: EvmDistributionNetworkId) => {
    const nextNetwork = getEvmNetworkConfig(value, networks);
    setNetworkId(value);
    setRpcEndpoint(getPreferredRpcEndpoint("evm", value, nextNetwork.rpcEndpoint));
    setMaxFeeAmount(getDefaultEvmCollectionFeeCap(nextNetwork));
    setPendingDiscovery(null);
    setPendingHistoryScan(null);
    setHistoryStartBlock("");
    setDiscoveryComplete(false);
    setContractInspection(null);
    rememberPreferredEvmDistributionNetwork(value);
    invalidatePlan();
  };

  const viewAddressBalances = async () => {
    if (fixedStandard !== "erc20" || running) return;
    const parsedAccounts = parseEvmPrivateKeyInput(keyInputRef.current?.read() || "");
    if (!parsedAccounts.accounts.length) {
      setAddressBalances({
        message: "请先导入并勾选至少一个来源钱包",
        rows: [],
        status: "error"
      });
      return;
    }

    const parsedAssets = erc20AssetInput.trim()
      ? parseEvmCollectionAssets(erc20AssetInput, "erc20")
      : null;
    const tokenAssets = (parsedAssets?.validAssets || []).filter((asset): asset is Extract<
      EvmCollectionAsset,
      { standard: "erc20" }
    > => asset.standard === "erc20");
    const invalidAssetRow = parsedAssets?.rows.find((row) => row.status !== "valid");
    if (invalidAssetRow) {
      setAddressBalances({
        message: `Token 清单第 ${invalidAssetRow.line} 行需要修正后才能查询余额`,
        rows: [],
        status: "error"
      });
      return;
    }
    if (!tokenAssets.length && !nativeCurrencyEnabled) {
      setAddressBalances({
        message: "当前网络的原生币信息尚未确认，请先填写 Token 合约地址",
        rows: [],
        status: "error"
      });
      return;
    }

    const workloadIssues = validateEvmCollectionWorkload({
      accountCount: parsedAccounts.accounts.length,
      assetCount: tokenAssets.length + (nativeCurrencyEnabled ? 1 : 0),
      standard: tokenAssets.length ? "erc20" : "native"
    });
    if (workloadIssues.length) {
      setAddressBalances({ message: workloadIssues[0], rows: [], status: "error" });
      return;
    }

    const requestId = balanceRequestRef.current + 1;
    balanceRequestRef.current = requestId;
    setAddressBalances({
      message: `正在查询 ${parsedAccounts.accounts.length} 个地址的余额…`,
      rows: [],
      status: "loading"
    });

    try {
      const publicClient = createEvmPublicClient(selectedNetwork, effectiveRpcEndpoint);
      await assertEvmRpcNetwork(publicClient, selectedNetwork);
      const recognizedByAddress = new Map(
        tokenRecognition.items
          .filter((item) => item.status === "ready")
          .map((item) => [item.address.toLowerCase(), item] as const)
      );
      const metadata = await mapWithConcurrency(tokenAssets, 5, async (asset) => {
        const recognized = recognizedByAddress.get(asset.contractAddress.toLowerCase());
        if (recognized?.symbol && recognized.decimals !== undefined) {
          return {
            contractAddress: asset.contractAddress,
            decimals: recognized.decimals,
            symbol: recognized.symbol
          };
        }
        const resolved = await readErc20Metadata(publicClient, asset.contractAddress);
        return {
          contractAddress: resolved.contractAddress,
          decimals: resolved.decimals,
          symbol: resolved.symbol
        };
      });

      const rows = await mapWithConcurrency(parsedAccounts.accounts, 4, async (account): Promise<AddressBalanceRow> => {
        const assets: AddressBalanceAsset[] = [];
        if (nativeCurrencyEnabled) {
          const nativeBalance = await publicClient.getBalance({ address: account.address });
          assets.push({
            amount: formatBalanceForDisplay(nativeBalance, selectedNetwork.nativeCurrency.decimals),
            symbol: selectedNetwork.nativeCurrency.symbol
          });
        }
        if (tokenAssets.length) {
          const tokenBalances = await mapWithConcurrency(metadata, 5, async (token) => {
            try {
              const balance = await publicClient.readContract({
                abi: erc20CollectionAbi,
                address: token.contractAddress,
                args: [account.address],
                functionName: "balanceOf"
              });
              return {
                amount: formatBalanceForDisplay(balance, token.decimals),
                contractAddress: token.contractAddress,
                symbol: token.symbol
              } satisfies AddressBalanceAsset;
            } catch {
              return {
                amount: "读取失败",
                contractAddress: token.contractAddress,
                symbol: token.symbol
              } satisfies AddressBalanceAsset;
            }
          });
          assets.push(...tokenBalances);
        }
        return { address: account.address, assets, label: account.label };
      });
      if (requestId !== balanceRequestRef.current) return;
      setAddressBalances({
        message: `已更新 ${rows.length} 个地址的余额`,
        rows,
        status: "ready"
      });
    } catch {
      if (requestId !== balanceRequestRef.current) return;
      setAddressBalances({
        message: "地址余额查询失败，请检查当前网络、RPC 与 Token 合约",
        rows: [],
        status: "error"
      });
    }
  };

  const getExecutionSettings = () => {
    const parsedConcurrency = Number(concurrency);
    const parsedMinimumDelay = Number(minimumDelay);
    const parsedMaximumDelay = Number(maximumDelay);
    if (!Number.isInteger(parsedConcurrency) || parsedConcurrency < 1 || parsedConcurrency > 20
      || !Number.isFinite(parsedMinimumDelay) || !Number.isFinite(parsedMaximumDelay)
      || parsedMinimumDelay < 0 || parsedMaximumDelay < parsedMinimumDelay || parsedMaximumDelay > 300) {
      return null;
    }
    return {
      concurrency: parsedConcurrency,
      maximumDelayMs: Math.round(parsedMaximumDelay * 1_000),
      minimumDelayMs: Math.round(parsedMinimumDelay * 1_000)
    };
  };

  const validateCollectionInputs = () => {
    const nextIssues: string[] = [];
    if (!isAddress(targetAddress.trim())) nextIssues.push("目标地址不是有效的 EVM 地址");
    else if (getAddress(targetAddress.trim()) === zeroAddress) nextIssues.push("目标地址不能是零地址，以免资产被销毁");
    if (!isRpcEndpoint(effectiveRpcEndpoint)) nextIssues.push("请输入以 http:// 或 https:// 开头的有效 RPC 地址");
    if (!gas.gasSettings) nextIssues.push("请输入有效的自定义 Gas Price");
    if (parseMaximumFee() === null) nextIssues.push("单笔最大网络费需要是大于 0 的有效金额");
    if (standard === "native" && !nativeCurrencyEnabled) {
      nextIssues.push("当前网络的原生币元数据尚未确认，请填写 Token 合约地址或先确认网络信息");
    }

    const parsedAccounts = parseEvmPrivateKeyInput(keyInputRef.current?.read() || "");
    if (!parsedAccounts.accounts.length) nextIssues.push("请勾选至少一个有效的来源钱包");
    parsedAccounts.issues.forEach((issue) => nextIssues.push(`密钥第 ${issue.line} 行：${issue.message}`));

    const parsedAssets = parseEvmCollectionAssets(assetInput, standard);
    if (!parsedAssets.validAssets.length) nextIssues.push("至少需要一个有效的资产条目");
    parsedAssets.rows.forEach((row) => {
      if (row.status !== "valid") nextIssues.push(`资产第 ${row.line} 行：${row.problems.join("；")}`);
    });
    nextIssues.push(...validateEvmCollectionWorkload({
      accountCount: parsedAccounts.accounts.length,
      assetCount: parsedAssets.validAssets.length,
      standard
    }));
    if (fixedStandard === "erc20" && !parseEvmAmountPolicy({
      decimals: selectedNetwork.nativeCurrency.decimals,
      fixedAmount,
      mode: amountMode,
      percentageAmount,
      randomMaximum,
      randomMinimum
    })) nextIssues.push("归集数量设置无效，请检查当前数量模式");
    const executionSettings = getExecutionSettings();
    if (!executionSettings) nextIssues.push("并发需要为 1–20，随机延迟需要为 0–300 秒且最大值不小于最小值");
    return { executionSettings, nextIssues, parsedAccounts, parsedAssets };
  };

  const addDiscoveredAssets = (discovery: PendingNftDiscovery, allowPartial = false) => {
    if (!discovery.complete && !allowPartial) return false;
    if (!discovery.complete && !discovery.assets.length) return false;

    const currentInput = nftAssetInputs[discovery.standard];
    const nextInventory = discovery.complete
      ? reconcileNftContractInventory({
          assetInput: currentInput,
          contractAddress: discovery.contractAddress,
          standard: discovery.standard,
          tokenIds: discovery.assets.map((asset) => asset.tokenId)
        })
      : {
          ...mergeNftAssetInput(
            currentInput,
            discovery.contractAddress,
            discovery.assets.map((asset) => asset.tokenId.toString()).join(","),
            { standard: discovery.standard }
          ),
          removed: 0
        };
    const mergeErrors = nextInventory.issues.filter((issue) => issue.severity === "error");
    if (mergeErrors.length) {
      setDiscoveryIssues((current) => [
        ...current,
        ...mergeErrors.map((issue) => issue.message)
      ]);
      setDiscoveryMessage("发现结果未加入清单：现有清单保持不变，请按提示分批处理");
      return false;
    }

    planRef.current = [];
    retryPlanRef.current = [];
    setIssues([]);
    setMessage("");
    setStage("editing");
    setResults([]);
    setNftStandard(discovery.standard);
    setNftAssetInputs((current) => ({ ...current, [discovery.standard]: nextInventory.serialized }));
    setPendingDiscovery(null);
    setPendingHistoryScan(null);
    setHistoryStartBlock("");
    setDiscoveryComplete(true);
    setDiscoveryIssues(Array.from(new Set(nextInventory.issues.map((issue) => issue.message))));
    if (discovery.complete) {
      const inventoryCount = discovery.assets.length;
      setDiscoveryMessage(inventoryCount
        ? `持仓已更新：该合约当前有 ${inventoryCount} 个可归集 NFT`
          + (nextInventory.removed ? `，已替换 ${nextInventory.removed} 个旧清单项` : "")
        : `持仓已更新：来源地址当前没有该合约的可归集 NFT`
          + (nextInventory.removed ? `，已移除 ${nextInventory.removed} 个旧清单项` : ""));
    } else {
      setDiscoveryMessage(
        nextInventory.added
          ? `已加入 ${nextInventory.added} 个经链上验证的 NFT`
            + (nextInventory.duplicates ? `，跳过 ${nextInventory.duplicates} 个重复项` : "")
            + "；部分扫描不会移除现有清单项"
          : "部分识别完成；发现的 NFT 已全部在待归集资产中"
      );
    }
    return true;
  };

  const discoverOwnedNft = async () => {
    if (operationRef.current || assetImportingRef.current || keyImportingRef.current
      || running || fixedStandard !== "nft") return;

    setDiscoveryIssues([]);
    setDiscoveryMessage("");
    setPendingDiscovery(null);
    setPendingHistoryScan(null);
    setHistoryStartBlock("");
    setDiscoveryComplete(false);
    if (assetInput.trim()) {
      const existingAssets = parseEvmCollectionAssets(assetInput, "erc721");
      if (existingAssets.rows.some((row) => row.status === "invalid")) {
        setDiscoveryMessage("当前资产清单仍有格式错误，请先修正后再自动发现；扫描结果不会覆盖现有输入");
        return;
      }
    }
    if (!isAddress(discoveryContract.trim())) {
      setDiscoveryMessage("请输入有效的 NFT 合约地址");
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
    operationRef.current = true;
    setDiscoveryRunning(true);
    setStage("scanning");
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
        setDiscoveryIssues([...sourceIssues, ...inspection.issues]);
        setDiscoveryMessage("已识别为 ERC1155；该标准没有按钱包枚举 Token ID 的接口，正在定位可选的历史扫描范围…");

        const blockscoutBaseUrl = getBlockscoutBaseUrl(selectedNetwork.blockExplorerUrl);
        let erc1155FromBlock: bigint;
        try {
          erc1155FromBlock = await findErc721DeploymentBlock({
            contractAddress: discoveryContract.trim(),
            onProgress: () => setDiscoveryMessage("正在定位 ERC1155 合约部署区块…"),
            publicClient
          });
        } catch {
          if (!blockscoutBaseUrl) {
            setDiscoveryMessage("无法自动定位 ERC1155 部署区块；请更换支持历史查询的 RPC 后重试");
            return;
          }
          try {
            setDiscoveryMessage("当前 RPC 不支持历史代码，正在通过 Blockscout 查询 ERC1155 部署区块…");
            erc1155FromBlock = await resolveBlockscoutDeploymentBlock(
              blockscoutBaseUrl,
              discoveryContract.trim()
            );
          } catch (error) {
            const detail = error instanceof Error ? error.message : "无法查询部署区块";
            setDiscoveryIssues([...sourceIssues, "部署区块：" + detail]);
            setDiscoveryMessage("无法自动定位 ERC1155 部署区块，现有资产清单未修改");
            return;
          }
        }

        setPendingHistoryScan({
          contractAddress: getAddress(discoveryContract.trim()),
          deploymentBlock: erc1155FromBlock,
          fallbackDiscovery: null,
          indexedIssues: [],
          ownerAddresses,
          snapshotBlock: inspection.snapshotBlock,
          sourceIssues,
          standard: "erc1155"
        });
        setHistoryStartBlock(erc1155FromBlock.toString());
        setDiscoveryMessage(
          `快速识别已完成；完整识别需要读取区块 ${erc1155FromBlock}–${inspection.snapshotBlock} 的 Transfer 历史，确认后才会开始。`
        );
        return;
      }

      let indexedPartial: PendingNftDiscovery | null = null;
      let indexedIssues: string[] = [];
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
        issue.code !== "not-enumerable"
      )).map((issue) => (
        (issue.ownerAddress ? "来源 " + shorten(issue.ownerAddress) : "合约检查") + "：" + issue.message
      ));
      const notEnumerable = enumerable.issues.some((issue) => issue.code === "not-enumerable");
      const enumerableComplete = enumerable.owners.length === ownerAddresses.length
        && enumerable.owners.every((owner) => owner.status === "complete")
        && enumerable.issues.length === 0;

      if (!notEnumerable) {
        setDiscoveryIssues([...sourceIssues, ...enumerableIssues]);
        const discovery: PendingNftDiscovery = {
          assets: enumerable.assets,
          complete: enumerableComplete,
          contractAddress: getAddress(discoveryContract.trim()),
          kind: "enumerable",
          standard: "erc721"
        };
        if (!enumerable.assets.length) {
          if (enumerableComplete) addDiscoveredAssets(discovery);
          else setDiscoveryMessage(enumerable.issues[0]?.message || "来源钱包在该合约中没有可枚举的 NFT");
          return;
        }
        if (enumerableComplete) {
          addDiscoveredAssets(discovery);
          return;
        }
        setPendingDiscovery(discovery);
        setDiscoveryMessage(
          "已发现 " + enumerable.assets.length + " 个 Token ID"
            + (enumerableComplete ? "；索引枚举已完成" : "；扫描存在限制，请先核对提示")
            + "。确认后再加入资产清单。"
        );
        return;
      }
      setDiscoveryIssues([...sourceIssues, ...enumerableIssues]);
      setDiscoveryMessage("已识别为普通 ERC721，正在查询公开索引并准备链上复核…");

      const blockscoutBaseUrl = getBlockscoutBaseUrl(selectedNetwork.blockExplorerUrl);
      if (blockscoutBaseUrl) {
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
            addDiscoveredAssets({
              assets: verified.assets,
              complete: true,
              contractAddress: getAddress(discoveryContract.trim()),
              kind: "indexer",
              latestBlock: verified.snapshotBlock ?? undefined,
              standard: "erc721"
            });
            return;
          }
          if (verified.assets.length) {
            indexedPartial = {
              assets: verified.assets,
              complete: false,
              contractAddress: getAddress(discoveryContract.trim()),
              kind: "indexer",
              latestBlock: verified.snapshotBlock ?? undefined,
              standard: "erc721"
            };
          }
          setDiscoveryIssues([...sourceIssues, ...indexedIssues]);
          setDiscoveryMessage("公开索引未能完整对账，正在准备可选的 Transfer 历史扫描范围…");
        } catch (error) {
          const detail = error instanceof Error ? error.message : "Blockscout 请求失败";
          indexedIssues = ["公开索引：" + detail];
          setDiscoveryIssues([...sourceIssues, ...indexedIssues]);
          setDiscoveryMessage("公开索引不可用，正在准备可选的 Transfer 历史扫描范围…");
        }
      }

      let fromBlock: bigint;
      setDiscoveryMessage("正在定位 NFT 合约部署区块，以便从完整事件历史恢复 Token ID…");
      try {
        fromBlock = await findErc721DeploymentBlock({
          contractAddress: discoveryContract.trim(),
          onProgress: () => setDiscoveryMessage("正在定位 NFT 合约部署区块…"),
          publicClient
        });
      } catch {
        if (blockscoutBaseUrl) {
          try {
            setDiscoveryMessage("当前 RPC 不支持历史代码，正在通过 Blockscout 查询合约部署区块…");
            fromBlock = await resolveBlockscoutDeploymentBlock(
              blockscoutBaseUrl,
              discoveryContract.trim()
            );
          } catch (error) {
            const detail = error instanceof Error ? error.message : "无法查询部署区块";
            if (indexedPartial) setPendingDiscovery(indexedPartial);
            setDiscoveryIssues([...sourceIssues, ...indexedIssues, "部署区块：" + detail]);
            setDiscoveryMessage(indexedPartial
              ? "事件回溯无法自动定位部署区块；已保留链上验证过的部分候选，请核对提示后决定是否加入。"
              : "无法自动定位部署区块；请更换支持历史查询的 RPC 后重试，现有清单未修改。");
            return;
          }
        } else {
          if (indexedPartial) setPendingDiscovery(indexedPartial);
          setDiscoveryMessage(indexedPartial
            ? "事件回溯无法自动定位部署区块；已保留链上验证过的部分候选，请核对后再加入。"
            : "无法由当前 RPC 自动定位部署区块；请更换支持历史查询的 RPC 后重试。");
          return;
        }
      }

      setPendingHistoryScan({
        contractAddress: getAddress(discoveryContract.trim()),
        deploymentBlock: fromBlock,
        fallbackDiscovery: indexedPartial,
        indexedIssues,
        ownerAddresses,
        snapshotBlock: inspection.snapshotBlock,
        sourceIssues,
        standard: "erc721"
      });
      setHistoryStartBlock(fromBlock.toString());
      setDiscoveryMessage(
        `快速索引未能完整对账；如需完整识别，需要读取区块 ${fromBlock}–${inspection.snapshotBlock} 的 Transfer 历史，确认后才会开始。`
      );
      return;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "RPC 请求失败";
      setDiscoveryMessage(detail.includes("RPC 网络不匹配")
        ? detail
        : "自动发现失败，请检查网络、RPC 与合约；现有资产清单没有被修改");
    } finally {
      operationRef.current = false;
      setDiscoveryRunning(false);
      setStage((current) => current === "scanning" ? "editing" : current);
    }
  };

  const runPendingHistoryScan = async () => {
    if (!pendingHistoryScan || operationRef.current || running) return;
    const normalizedStart = historyStartBlock.trim();
    if (!/^\d+$/.test(normalizedStart)) {
      setDiscoveryMessage("请输入不小于部署区块的有效起始区块");
      return;
    }
    const fromBlock = BigInt(normalizedStart);
    if (fromBlock < pendingHistoryScan.deploymentBlock || fromBlock > pendingHistoryScan.snapshotBlock) {
      setDiscoveryMessage(
        `起始区块需在 ${pendingHistoryScan.deploymentBlock}–${pendingHistoryScan.snapshotBlock} 之间`
      );
      return;
    }

    const fullHistory = fromBlock === pendingHistoryScan.deploymentBlock;
    const abortController = new AbortController();
    historyScanAbortRef.current = abortController;
    operationRef.current = true;
    setDiscoveryRunning(true);
    setStage("scanning");
    setPendingDiscovery(null);
    setDiscoveryIssues([
      ...pendingHistoryScan.sourceIssues,
      ...pendingHistoryScan.indexedIssues
    ]);
    setDiscoveryMessage(fullHistory
      ? "已确认，正在扫描完整 Transfer 历史…"
      : `正在扫描区块 ${fromBlock}–${pendingHistoryScan.snapshotBlock}；这是有限范围结果，不会覆盖现有清单`);

    try {
      const publicClient = createEvmPublicClient(selectedNetwork, effectiveRpcEndpoint);
      await assertEvmRpcNetwork(publicClient, selectedNetwork);

      if (pendingHistoryScan.standard === "erc1155") {
        const transferDiscovery = await discoverErc1155AssetsByTransfer({
          contractAddress: pendingHistoryScan.contractAddress,
          fromBlock,
          onProgress: (progress) => {
            setDiscoveryMessage(progress.stage === "reading-events"
              ? `正在回溯 ERC1155 区块 ${progress.fromBlock}–${progress.toBlock} · 候选 ${progress.candidateCount} 个`
              : `正在快照区块 ${progress.toBlock} 复核 ${progress.candidateCount} 个 Token ID 的余额…`);
          },
          ownerAddresses: pendingHistoryScan.ownerAddresses,
          publicClient,
          signal: abortController.signal,
          toBlock: pendingHistoryScan.snapshotBlock
        });
        const complete = transferDiscovery.complete && fullHistory;
        const discovery: PendingNftDiscovery = {
          assets: transferDiscovery.assets,
          complete,
          contractAddress: pendingHistoryScan.contractAddress,
          kind: "transfer",
          latestBlock: transferDiscovery.latestBlock,
          scope: fullHistory ? "full-history" : "manual-range",
          standard: "erc1155"
        };
        setDiscoveryIssues([
          ...pendingHistoryScan.sourceIssues,
          ...transferDiscovery.issues.map((issue) => issue.message)
        ]);
        if (complete) {
          addDiscoveredAssets(discovery);
        } else if (discovery.assets.length) {
          setPendingDiscovery(discovery);
          setPendingHistoryScan(null);
          setDiscoveryMessage(
            `已验证 ${discovery.assets.length} 个仍有余额的 Token ID；这是部分结果，确认后只会追加，不会移除现有清单项。`
          );
        } else {
          setPendingHistoryScan(null);
          setDiscoveryMessage(transferDiscovery.issues[0]?.message
            || "所选区块范围内没有发现仍有余额的 ERC1155；现有清单未修改");
        }
        return;
      }

      const transferDiscovery = await discoverErc721AssetsByTransfer({
        contractAddress: pendingHistoryScan.contractAddress,
        fromBlock,
        onProgress: (progress) => {
          if (progress.stage === "reading-events") {
            setDiscoveryMessage(
              `正在回溯区块 ${progress.fromBlock}–${progress.toBlock} · 候选 ${progress.candidateCount} 个`
            );
          } else if (progress.stage === "verifying-owner") {
            setDiscoveryMessage(
              `正在快照区块 ${progress.toBlock} 验证 ${progress.candidateCount} 个 Token ID 的 ownerOf…`
            );
          }
        },
        ownerAddresses: pendingHistoryScan.ownerAddresses,
        publicClient,
        signal: abortController.signal,
        scope: fullHistory ? "full-history" : "manual-range",
        toBlock: pendingHistoryScan.snapshotBlock
      });
      const complete = transferDiscovery.complete && fullHistory;
      const discovery: PendingNftDiscovery = {
        assets: transferDiscovery.assets,
        complete,
        contractAddress: pendingHistoryScan.contractAddress,
        kind: "transfer",
        latestBlock: transferDiscovery.latestBlock,
        scope: transferDiscovery.scope,
        standard: "erc721"
      };
      setDiscoveryIssues([
        ...pendingHistoryScan.sourceIssues,
        ...pendingHistoryScan.indexedIssues,
        ...transferDiscovery.issues.map((issue) => issue.message)
      ]);
      if (complete) {
        addDiscoveredAssets(discovery);
      } else if (discovery.assets.length) {
        setPendingDiscovery(discovery);
        setPendingHistoryScan(null);
        setDiscoveryMessage(
          `已验证 ${discovery.assets.length} 个仍归属来源地址的 Token ID；这是部分结果，确认后只会追加。`
        );
      } else if (pendingHistoryScan.fallbackDiscovery) {
        setPendingDiscovery(pendingHistoryScan.fallbackDiscovery);
        setPendingHistoryScan(null);
        setDiscoveryMessage("历史扫描没有得到完整结果；已保留公开索引中经 ownerOf 验证的部分候选。");
      } else {
        setPendingHistoryScan(null);
        setDiscoveryMessage(transferDiscovery.issues[0]?.message
          || "所选区块范围内没有发现仍归属来源地址的 NFT；现有清单未修改");
      }
    } catch (error) {
      if (isAbortError(error, abortController.signal)) {
        setDiscoveryMessage("历史扫描已停止，现有资产清单未修改；可调整范围后重新扫描。");
        return;
      }
      const detail = error instanceof Error ? error.message : "RPC 请求失败";
      setDiscoveryMessage(detail.includes("RPC 网络不匹配")
        ? detail
        : "历史扫描失败，请检查 RPC 后重试；现有资产清单没有被修改");
    } finally {
      if (historyScanAbortRef.current === abortController) historyScanAbortRef.current = null;
      operationRef.current = false;
      setDiscoveryRunning(false);
      setStage((current) => current === "scanning" ? "editing" : current);
    }
  };

  const cancelPendingHistoryScan = () => {
    if (!pendingHistoryScan) return;
    if (discoveryRunning) {
      if (!historyScanAbortRef.current || historyScanAbortRef.current.signal.aborted) return;
      historyScanAbortRef.current.abort();
      setDiscoveryMessage("正在停止历史扫描；已读取的数据不会写入资产清单…");
      return;
    }
    if (pendingHistoryScan.fallbackDiscovery) {
      setPendingDiscovery(pendingHistoryScan.fallbackDiscovery);
      setDiscoveryMessage("已跳过历史扫描；可使用公开索引中经链上验证的部分结果，现有清单未修改。");
    } else {
      setDiscoveryMessage("已跳过历史扫描，现有资产清单未修改。你可以更换 RPC、缩小范围或稍后重试。");
    }
    setPendingHistoryScan(null);
    setHistoryStartBlock("");
  };

  const applyPendingDiscovery = (allowPartial = false) => {
    if (!pendingDiscovery || operationRef.current || running) return;
    if (!pendingDiscovery.complete && !allowPartial) {
      setDiscoveryMessage("这是部分发现结果。请先确认仅归集已验证项目，或修正提示后重新扫描完整历史。");
      return;
    }
    addDiscoveredAssets(pendingDiscovery, allowPartial);
  };

  const executeCollection = async (retryOnly = false) => {
    if (operationRef.current || assetImportingRef.current || keyImportingRef.current || running) return;
    const prepared = validateCollectionInputs();
    const gasSettings = gas.gasSettings;
    const maxFeePerTransactionWei = parseMaximumFee();
    if (prepared.nextIssues.length || !gasSettings || maxFeePerTransactionWei === null
      || !prepared.executionSettings || (retryOnly && !retryPlanRef.current.length)) {
      setIssues(prepared.nextIssues.length ? prepared.nextIssues : ["没有可重试的失败项"]);
      setStage("error");
      setMessage("请修正设置后再执行，当前钱包与配置均已保留");
      return;
    }
    const retryPlan = retryPlanRef.current;
    const target = getAddress(targetAddress.trim());
    operationRef.current = true;
    retryPlanRef.current = [];
    setIssues([]);
    setStage("running");
    setMessage(retryOnly
      ? "正在重试可安全重试的失败项"
      : `已确认，正在按并发 ${prepared.executionSettings.concurrency} 执行；余额与网络费会在每笔发送前即时读取`);
    let executionPlan = retryOnly ? retryPlan : [];
    const submittedIds = new Set<string>();
    if (retryOnly) {
      const retryIds = new Set(retryPlan.map((item) => item.id));
      setResults((current) => current.map((result, index) => retryIds.has(planRef.current[index]?.id)
        ? { ...result, hash: undefined, explorerUrl: undefined, message: "等待重试", status: "pending" }
        : result));
    } else {
      setResults(prepared.parsedAccounts.accounts.map((account) => ({
        address: account.address,
        amount: "—",
        asset: fixedStandard === "nft" ? nftStandard.toUpperCase() : standard === "native"
          ? selectedNetwork.nativeCurrency.symbol
          : "ERC20",
        label: account.label,
        message: "正在读取资产余额",
        status: "scanning"
      })));
    }

    const updateProgress = (progress: EvmCollectionProgress) => {
      if (progress.hash) submittedIds.add(progress.id);
      const resultIndex = planRef.current.findIndex((item) => item.id === progress.id);
      if (resultIndex < 0) return;
      setResults((current) => current.map((result, index) => {
        if (index !== resultIndex) return result;
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
      if (!retryOnly) {
        const ownershipPlan = await planEvmCollection({
          accounts: prepared.parsedAccounts.accounts,
          assets: prepared.parsedAssets.validAssets,
          publicClient
        });
        executionPlan = fixedStandard === "erc20"
          ? applyEvmAmountPolicy(ownershipPlan, selectedNetwork.nativeCurrency.decimals, {
              fixedAmount,
              mode: amountMode,
              percentageAmount,
              randomMaximum,
              randomMinimum
            })
          : ownershipPlan;
        planRef.current = executionPlan;
        setResults(executionPlan.map((item) => planItemToDisplay(item, selectedNetwork.nativeCurrency)));
      }
      const chain = toEvmChain(selectedNetwork, effectiveRpcEndpoint);
      const groups = Array.from(executionPlan.reduce((grouped, item) => {
        const key = item.address?.toLowerCase() || item.id;
        const group = grouped.get(key) || [];
        group.push(item);
        grouped.set(key, group);
        return grouped;
      }, new Map<string, EvmCollectionPlanItem[]>()).values());
      const groupedResults = await mapWithCollectionConcurrency(
        groups,
        prepared.executionSettings.concurrency,
        async (group) => {
          await waitForCollectionDelay(prepared.executionSettings!);
          return executeEvmCollectionPlan({
            gasSettings,
            getWalletClient: (account) => createWalletClient({
              account,
              chain,
              transport: http(effectiveRpcEndpoint)
            }),
            maxFeePerTransactionWei,
            onProgress: updateProgress,
            plan: group,
            publicClient,
            targetAddress: target
          });
        }
      );
      const executionResults = groupedResults.flat();
      const resultById = new Map(executionResults.map((result) => [result.id, result] as const));
      setResults((current) => planRef.current.map((item, index) => {
        const result = resultById.get(item.id);
        return result
          ? resultToDisplay(
              item,
              result,
              selectedNetwork.nativeCurrency,
              (hash) => getEvmExplorerUrl(hash, selectedNetwork)
            )
          : current[index] || planItemToDisplay(item, selectedNetwork.nativeCurrency);
      }));
      retryPlanRef.current = executionPlan.filter((item) => resultById.get(item.id)?.retryable);
      const success = executionResults.filter((result) => result.status === "success").length;
      const failed = executionResults.filter((result) => result.status === "failed").length;
      setStage("complete");
      setMessage(`本轮完成：${success} 项确认成功${failed ? `，${failed} 项失败` : ""}`
        + (retryPlanRef.current.length ? `；${retryPlanRef.current.length} 项可直接重试` : ""));
    } catch (error) {
      retryPlanRef.current = executionPlan.filter((item) => item.status === "ready" && !submittedIds.has(item.id));
      setStage("error");
      const detail = error instanceof Error ? error.message : "RPC 请求失败";
      setMessage(detail.includes("RPC 网络不匹配")
        ? detail
        : "归集流程中断，钱包与设置均已保留，可直接重试；已显示哈希的项目请先核对链上状态");
    } finally {
      operationRef.current = false;
    }
  };

  const clearWorkbench = () => {
    keyInputRef.current?.clear();
    balanceRequestRef.current += 1;
    tokenRecognitionRequestRef.current += 1;
    planRef.current = [];
    retryPlanRef.current = [];
    setErc20AssetInput("");
    setNftAssetInputs({ erc721: "", erc1155: "" });
    setDiscoveryContract("");
    setDiscoverySourceInput("");
    setSourceInputMode("readonly");
    setPendingDiscovery(null);
    setPendingHistoryScan(null);
    setHistoryStartBlock("");
    setDiscoveryComplete(false);
    setContractInspection(null);
    setDiscoveryIssues([]);
    setDiscoveryMessage("");
    setNftStandard("erc721");
    setNftInputResetNonce((current) => current + 1);
    setTargetAddress("");
    setMaxFeeAmount(defaultMaximumFeeAmount);
    setAmountMode("all");
    setPercentageAmount("100");
    setFixedAmount("0.1");
    setRandomMinimum("0.01");
    setRandomMaximum("0.1");
    setConcurrency("3");
    setMinimumDelay("0");
    setMaximumDelay("0");
    setResults([]);
    setArchivedRound(null);
    setRoundSequence(1);
    setAddressBalances(emptyAddressBalanceState);
    setTokenRecognition(emptyTokenRecognitionState);
    setIssues([]);
    setMessage("");
    setStage("editing");
  };

  const beginNextRoundWithCurrentSettings = () => {
    if (running) return;
    const settledAssetKeys = fixedStandard === "nft"
      ? getSettledNftAssetKeys(results)
      : new Set<string>();
    const nextNftInput = fixedStandard === "nft"
      ? removeValidNftInventoryAssets(assetInput, nftStandard, settledAssetKeys)
      : assetInput;
    const remainingNftCount = fixedStandard === "nft"
      ? parseEvmCollectionAssets(nextNftInput, nftStandard).validAssets.length
      : 0;

    if (results.length) {
      setArchivedRound({
        message: message || `第 ${roundSequence} 轮已结束`,
        results: results.map((result) => ({ ...result })),
        sequence: roundSequence
      });
    }
    balanceRequestRef.current += 1;
    planRef.current = [];
    retryPlanRef.current = [];
    if (fixedStandard === "nft") {
      setNftAssetInputs((current) => ({ ...current, [nftStandard]: nextNftInput }));
      setDiscoveryComplete(false);
      setPendingDiscovery(null);
      setPendingHistoryScan(null);
      setHistoryStartBlock("");
    }
    setResults([]);
    setAddressBalances(emptyAddressBalanceState);
    setIssues([]);
    setMessage(fixedStandard === "nft"
      ? settledAssetKeys.size
        ? `已归档第 ${roundSequence} 轮，并移除 ${settledAssetKeys.size} 个已明确归集的 NFT；当前保留 ${remainingNftCount} 个待处理资产，可再次识别持仓`
        : `已归档第 ${roundSequence} 轮；未明确完成的资产全部保留，可重试或再次识别持仓`
      : `已归档第 ${roundSequence} 轮；钱包、Token 与归集配置均已保留，可刷新余额后继续`);
    setRoundSequence((current) => current + 1);
    setStage("editing");
  };

  const amountPolicyValid = fixedStandard === "nft" || Boolean(parseEvmAmountPolicy({
    decimals: selectedNetwork.nativeCurrency.decimals,
    fixedAmount,
    mode: amountMode,
    percentageAmount,
    randomMaximum,
    randomMinimum
  }));
  const executionSettingsValid = getExecutionSettings() !== null;
  const rpcEndpointValid = isRpcEndpoint(effectiveRpcEndpoint);
  const canStart = targetIsValid && sourceKeyLineCount > 0 && parsedAssetCount > 0
    && Boolean(gas.gasSettings) && maximumFeeAmount !== null && amountPolicyValid
    && executionSettingsValid && rpcEndpointValid && !running;
  const parsedHistoryStartBlock = /^\d+$/.test(historyStartBlock.trim())
    ? BigInt(historyStartBlock.trim())
    : null;
  const historyRangeValid = Boolean(
    pendingHistoryScan
    && parsedHistoryStartBlock !== null
    && parsedHistoryStartBlock >= pendingHistoryScan.deploymentBlock
    && parsedHistoryStartBlock <= pendingHistoryScan.snapshotBlock
  );
  const historyRangeIsFull = Boolean(
    pendingHistoryScan && parsedHistoryStartBlock === pendingHistoryScan.deploymentBlock
  );

  return (
    <ToolPageLayout
      actions={(
        <>
          <EvmGasBadge gas={gas} />
          <Badge variant="outline">{selectedNetwork.label}</Badge>
          <ConfirmActionDialog
            confirmLabel="确认清空"
            description={hasSubmittedHash
              ? "本轮结果包含已提交的交易哈希。清空前请先核对链上状态；清空后本页记录无法恢复。"
              : "来源密钥、资产清单、归集设置和上一轮结果将从页面清除。"}
            disabled={running}
            onConfirm={clearWorkbench}
            title="清空归集工作台？"
            triggerLabel="清空工作台"
            triggerVariant="destructive"
          />
        </>
      )}
      className="collection-shell collection-page"
      currentToolId={currentToolId}
      stickyActions
      status={workbenchStatus}
      statusLabel={discoveryRunning
        ? pendingHistoryScan ? "历史扫描中" : "识别中"
        : evmStatusLabels[workbenchStatus]}
      title={fixedStandard === "erc20" ? "EVM 代币归集" : "EVM NFT 归集"}
    >
      <div className={"workspace collection-workspace" + (results.length ? " has-results" : "")}>
        <WorkbenchPanel
          actions={<Badge variant="outline">第 {roundSequence} 轮</Badge>}
          className="collection-workbench-panel"
          footer={(
            <div className="actions collection-actions">
              {stage === "running" ? (
                <Button disabled type="button">归集中</Button>
              ) : stage === "complete" && hasSubmittedHash ? (
                <>
                  {retryableCount ? (
                    <ConfirmActionDialog
                      confirmLabel={`重试 ${retryableCount} 个失败项`}
                      description="只重试尚未提交或已明确执行失败的项目；状态不确定的交易不会自动重发。"
                      disabled={running}
                      onConfirm={() => executeCollection(true)}
                      title="确认重试失败项？"
                      triggerLabel={`重试失败项 (${retryableCount})`}
                      triggerVariant="outline"
                    />
                  ) : null}
                  <Button
                    onClick={beginNextRoundWithCurrentSettings}
                    type="button"
                    variant={retryableCount ? "outline" : "default"}
                  >
                    {fixedStandard === "nft" ? "整理本轮，继续下一轮" : "继续使用当前设置"}
                  </Button>
                </>
              ) : retryableCount ? (
                <ConfirmActionDialog
                  confirmLabel={`重试 ${retryableCount} 个失败项`}
                  description="只重试尚未提交或已明确执行失败的项目；状态不确定的交易不会自动重发。"
                  disabled={running}
                  onConfirm={() => executeCollection(true)}
                  title="确认重试失败项？"
                  triggerLabel={`重试失败项 (${retryableCount})`}
                  triggerVariant="outline"
                />
              ) : hasSubmittedHash ? (
                <Button disabled type="button">需先核对链上交易</Button>
              ) : (
                <ConfirmActionDialog
                  confirmLabel="确认并开始归集"
                  description={(
                    <div className="summary-list">
                      <div><span>网络</span><strong>{selectedNetwork.label}</strong></div>
                      <div><span>目标地址</span><strong className="mono">{targetAddress || "—"}</strong></div>
                      <div><span>来源钱包</span><strong>{sourceKeyLineCount} 个已选择</strong></div>
                      <div><span>资产项</span><strong>{parsedAssetCount}</strong></div>
                      {fixedStandard === "erc20" ? <div><span>归集数量</span><strong>{amountModeLabels[amountMode]}</strong></div> : null}
                      <div><span>并发</span><strong>{concurrency}</strong></div>
                      <div><span>随机延迟</span><strong>{minimumDelay}–{maximumDelay} 秒</strong></div>
                      <div><span>单笔最高网络费</span><strong>{maxFeeAmount} {selectedNetwork.nativeCurrency.symbol}</strong></div>
                    </div>
                  )}
                  disabled={!canStart}
                  onConfirm={() => executeCollection(false)}
                  title="确认 EVM 归集？"
                  triggerLabel="确认并开始归集"
                />
              )}
            </div>
          )}
          title="归集设置"
        >
          <div className="form collection-form">
            {fixedStandard === "erc20" ? (
              <SecretKeyInput
                disabled={controlsLocked || assetImporting}
                mode="evm"
                onDirty={(reason, address) => {
                  if (reason === "remove" && address) {
                    setAddressBalances((current) => ({
                      ...current,
                      rows: current.rows.filter((row) => row.address.toLowerCase() !== address.toLowerCase())
                    }));
                  }
                  invalidatePlan(true, false, reason !== "remove");
                }}
                onImportingChange={handleKeyImportingChange}
                onLineCountChange={setSourceKeyLineCount}
                ref={keyInputRef}
                walletBalances={walletBalances}
                walletStatuses={walletStatuses}
              />
            ) : null}

            {fixedStandard === "nft" ? (
              <>
                <Tabs
                  onValueChange={(value) => {
                    const nextMode = value as NftSourceInputMode;
                    setSourceInputMode(nextMode);
                    setPendingDiscovery(null);
                    setPendingHistoryScan(null);
                    setHistoryStartBlock("");
                    setDiscoveryComplete(false);
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
                          setPendingHistoryScan(null);
                          setHistoryStartBlock("");
                          setDiscoveryComplete(false);
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
                    <SecretKeyInput
                      disabled={controlsLocked || assetImporting}
                      mode="evm"
                      onDirty={() => {
                        setPendingDiscovery(null);
                        setPendingHistoryScan(null);
                        setHistoryStartBlock("");
                        setDiscoveryComplete(false);
                        invalidatePlan();
                      }}
                      onImportingChange={handleKeyImportingChange}
                      onLineCountChange={setSourceKeyLineCount}
                      ref={keyInputRef}
                    />
                  </TabsContent>
                </Tabs>
              </>
            ) : null}

            {fixedStandard === "erc20" ? (
              <>
                <Field>
                  <FieldLabel htmlFor="evm-collection-asset-0">Token 清单</FieldLabel>
                  <div className="erc20-token-editor">
                    {tokenInputRows.map((row, index) => {
                      const trimmed = row.trim();
                      const validAddress = isAddress(trimmed) && getAddress(trimmed) !== zeroAddress;
                      const preview = validAddress
                        ? recognizedTokenByAddress.get(getAddress(trimmed).toLowerCase())
                        : undefined;
                      const recognitionLabel = !trimmed
                        ? "ERC20"
                        : !validAddress
                          ? "地址无效"
                          : preview?.status === "ready"
                            ? preview.symbol || "TOKEN"
                            : preview?.status === "error" || tokenRecognition.status === "error"
                              ? "识别失败"
                              : "识别中";
                      const recognitionStatus = !trimmed
                        ? "idle"
                        : !validAddress
                          ? "error"
                          : preview?.status === "ready"
                            ? "ready"
                            : preview?.status === "error" || tokenRecognition.status === "error"
                              ? "error"
                              : "loading";
                      const tokenLocked = preview?.status === "ready";
                      return (
                        <div
                          className="erc20-token-row"
                          data-locked={tokenLocked || undefined}
                          data-status={recognitionStatus}
                          key={index}
                        >
                          <Input
                            aria-describedby={`evm-collection-asset-status-${index}`}
                            aria-label={index === 0 ? "Token 清单" : `Token 地址 ${index + 1}`}
                            autoCapitalize="none"
                            autoComplete="off"
                            disabled={controlsLocked}
                            id={`evm-collection-asset-${index}`}
                            onChange={(event) => {
                              if (tokenLocked) return;
                              const nextRows = [...tokenInputRows];
                              nextRows[index] = event.target.value;
                              updateErc20TokenRows(nextRows);
                            }}
                            onPaste={(event) => {
                              if (tokenLocked) {
                                event.preventDefault();
                                return;
                              }
                              const pastedRows = event.clipboardData.getData("text")
                                .split(/\r?\n/)
                                .map((value) => value.trim())
                                .filter(Boolean);
                              if (pastedRows.length <= 1) return;
                              event.preventDefault();
                              updateErc20TokenRows([
                                ...tokenInputRows.slice(0, index),
                                ...pastedRows,
                                ...tokenInputRows.slice(index + 1)
                              ]);
                            }}
                            placeholder="0x…"
                            readOnly={tokenLocked}
                            spellCheck={false}
                            title={tokenLocked ? "Token 已添加；如需更换，请删除后重新添加" : undefined}
                            value={row}
                          />
                          <span
                            aria-live="polite"
                            className="erc20-token-symbol"
                            data-status={recognitionStatus}
                            id={`evm-collection-asset-status-${index}`}
                            title={preview?.name || preview?.message || recognitionLabel}
                          >
                            {recognitionLabel}
                          </span>
                          {tokenInputRows.length > 1 || trimmed ? (
                            <Button
                              aria-label={`删除 Token 地址 ${index + 1}`}
                              disabled={controlsLocked}
                              onClick={() => updateErc20TokenRows(
                                tokenInputRows.length === 1
                                  ? [""]
                                  : tokenInputRows.filter((_, rowIndex) => rowIndex !== index)
                              )}
                              size="sm"
                              type="button"
                              variant="ghost"
                            >
                              删除
                            </Button>
                          ) : null}
                        </div>
                      );
                    })}
                    <Button
                      className="erc20-token-add"
                      disabled={controlsLocked}
                      onClick={() => {
                        const nextIndex = tokenInputRows.length;
                        updateErc20TokenRows([...tokenInputRows, ""]);
                        window.requestAnimationFrame(() => {
                          document.getElementById(`evm-collection-asset-${nextIndex}`)?.focus();
                        });
                      }}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      添加 Token
                    </Button>
                  </div>
                  <FieldDescription>
                    {nativeCurrencyEnabled
                      ? `可选；留空则归集 ${selectedNetwork.nativeCurrency.symbol}，填写后归集列出的 ERC20 Token。`
                      : "当前网络的原生币信息尚未确认；请填写 ERC20 Token 合约地址。"}
                  </FieldDescription>
                  <div aria-label="地址余额查询" className="address-balance-control">
                    <Button
                      disabled={controlsLocked
                        || addressBalances.status === "loading"
                        || sourceKeyLineCount === 0
                        || !effectiveRpcEndpoint
                        || (Boolean(assetInput.trim()) && parsedAssetCount === 0)}
                      onClick={() => void viewAddressBalances()}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      {addressBalances.status === "loading" ? "查询中" : "查看地址余额"}
                    </Button>
                    {addressBalances.status === "error" ? (
                      <p
                        aria-live="polite"
                        className="address-balance-control__status"
                        data-status={addressBalances.status}
                        role="status"
                      >
                        {addressBalances.message}
                      </p>
                    ) : null}
                  </div>
                </Field>

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
              </>
            ) : (
              <>
                <NftAssetInput
                  autoOnly
                  autoDiscovery={(
                    <section aria-labelledby="nft-discovery-title" className="nft-discovery-card">
                      <div className="nft-discovery-card__bar">
                        <div className="nft-discovery-card__title">
                          <h4 id="nft-discovery-title">持仓识别</h4>
                          <Badge variant="outline">先快速识别</Badge>
                        </div>
                        <Button
                          disabled={controlsLocked || Boolean(pendingHistoryScan) || !discoveryContractIsValid || !discoverySourceReady}
                          onClick={() => void discoverOwnedNft()}
                          size="sm"
                          type="button"
                        >
                          {discoveryRunning
                            ? pendingHistoryScan ? "历史扫描中" : "快速识别中"
                            : discoveryComplete || assetInput.trim() ? "再次识别" : "识别持仓"}
                        </Button>
                      </div>

                      {contractInspection ? (
                        <div className="nft-discovery-card__contract">
                          <strong>{contractInspection.name || "NFT 合约"}</strong>
                          <Badge variant="outline">
                            {contractInspection.symbol ? contractInspection.symbol + " · " : ""}
                            {contractInspection.standard.toUpperCase()}
                          </Badge>
                          <code title={contractInspection.address}>{shorten(contractInspection.address, 6)}</code>
                        </div>
                      ) : null}

                      {pendingHistoryScan ? (
                        <Alert className="nft-history-scan" data-scanning={discoveryRunning || undefined}>
                          <AlertTitle>需要回溯 Transfer 历史</AlertTitle>
                          <AlertDescription>
                            <p>
                              {pendingHistoryScan.standard === "erc1155"
                                ? "ERC1155 没有按钱包枚举 Token ID 的标准接口，完整识别需要读取历史转账事件。"
                                : "Enumerable 与公开索引未能完整对账，历史事件是当前可用的完整识别路径。"}
                              扫描只读，不会签名或发送交易。
                            </p>
                            <div className="nft-history-scan__range" aria-label="历史扫描范围">
                              <div><span>部署区块</span><strong>{pendingHistoryScan.deploymentBlock.toLocaleString()}</strong></div>
                              <div><span>快照区块</span><strong>{pendingHistoryScan.snapshotBlock.toLocaleString()}</strong></div>
                              <div>
                                <span>预计读取</span>
                                <strong>
                                  {parsedHistoryStartBlock !== null && historyRangeValid
                                    ? (pendingHistoryScan.snapshotBlock - parsedHistoryStartBlock + 1n).toLocaleString()
                                    : "—"} 个区块
                                </strong>
                              </div>
                            </div>
                            <Field data-invalid={!historyRangeValid ? true : undefined}>
                              <FieldLabel htmlFor="nft-history-start-block">扫描起始区块</FieldLabel>
                              <Input
                                aria-invalid={!historyRangeValid ? true : undefined}
                                disabled={discoveryRunning}
                                id="nft-history-start-block"
                                inputMode="numeric"
                                min={pendingHistoryScan.deploymentBlock.toString()}
                                onChange={(event) => setHistoryStartBlock(event.target.value)}
                                step="1"
                                type="number"
                                value={historyStartBlock}
                              />
                              <FieldDescription>
                                {historyRangeIsFull
                                  ? "从部署区块开始，可用于完整对账并替换该合约的旧清单。"
                                  : "缩小范围会更快，但结果只会作为部分数据追加，不会删除旧清单项。"}
                              </FieldDescription>
                              {!historyRangeValid ? <FieldError>请输入部署区块到快照区块之间的整数</FieldError> : null}
                            </Field>
                            <div className="nft-history-scan__actions">
                              <Button
                                disabled={discoveryRunning || !historyRangeValid}
                                onClick={() => void runPendingHistoryScan()}
                                size="sm"
                                type="button"
                              >
                                {discoveryRunning ? "正在扫描" : historyRangeIsFull ? "扫描完整历史" : "扫描所选范围"}
                              </Button>
                              <Button
                                onClick={cancelPendingHistoryScan}
                                size="sm"
                                type="button"
                                variant="ghost"
                              >{discoveryRunning ? "停止扫描" : "暂不扫描"}</Button>
                              {pendingHistoryScan.fallbackDiscovery ? (
                                <ConfirmActionDialog
                                  confirmLabel="使用已验证结果"
                                  description="只会追加公开索引中已通过 ownerOf 验证的 Token ID；未覆盖的资产不会被删除。"
                                  disabled={discoveryRunning}
                                  onConfirm={() => { addDiscoveredAssets(pendingHistoryScan.fallbackDiscovery!, true); }}
                                  title="使用快速识别的部分结果？"
                                  triggerLabel={`使用已验证的 ${pendingHistoryScan.fallbackDiscovery.assets.length} 项`}
                                  triggerVariant="outline"
                                />
                              ) : null}
                            </div>
                          </AlertDescription>
                        </Alert>
                      ) : null}

                      {pendingDiscovery ? (
                        <Alert>
                          <AlertTitle>部分发现结果</AlertTitle>
                          <AlertDescription>
                            <p>{pendingDiscovery.assets.length} 个 Token ID</p>
                            <code>
                              {pendingDiscovery.assets.slice(0, 8).map((asset) => asset.tokenId.toString()).join(" · ")}
                              {pendingDiscovery.assets.length > 8 ? " · …" : ""}
                            </code>
                            <ConfirmActionDialog
                              confirmLabel="确认加入部分结果"
                              description="只会加入当前已验证的 Token ID；未覆盖的资产不会自动补入，需另行核对。"
                              disabled={controlsLocked}
                              onConfirm={() => applyPendingDiscovery(true)}
                              title="加入部分发现结果？"
                              triggerLabel="确认并加入部分结果"
                              triggerVariant="outline"
                            />
                          </AlertDescription>
                        </Alert>
                      ) : null}

                      {discoveryMessage ? (
                        <p aria-live="polite" className="nft-discovery-card__status" role="status">
                          {discoveryMessage}
                        </p>
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
                    </section>
                  )}
                  contractAddress={discoveryContract}
                  contractStatus={!discoveryContract.trim() ? "empty" : discoveryContractIsValid ? "valid" : "invalid"}
                  defaultMode="auto"
                  disabled={controlsLocked || keyImporting}
                  key={[nftInputResetNonce, standard].join("-")}
                  onChange={(value) => {
                    setCurrentAssetInput(value);
                    invalidatePlan();
                  }}
                  onContractAddressChange={(value) => {
                    setDiscoveryContract(value);
                    setPendingDiscovery(null);
                    setPendingHistoryScan(null);
                    setHistoryStartBlock("");
                    setDiscoveryComplete(false);
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
                  results={results}
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

              </>
            )}

            <h3 className="collection-config-heading">归集配置</h3>

            <div className="evm-network-row" aria-label="网络与 RPC">
              <Field>
                <div className="evm-network-label-row">
                  <FieldLabel htmlFor="evm-collection-network">网络</FieldLabel>
                  <span className="evm-network-chain-id">Chain ID <strong>{selectedNetwork.chainId}</strong></span>
                </div>
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
              <Field data-invalid={!rpcEndpointValid ? true : undefined}>
                <FieldLabel htmlFor="evm-collection-rpc">RPC</FieldLabel>
                <Input
                  aria-invalid={!rpcEndpointValid ? true : undefined}
                  disabled={controlsLocked}
                  id="evm-collection-rpc"
                  onBlur={() => rememberRpcEndpoint("evm", networkId, rpcEndpoint)}
                  onChange={(event) => {
                    setRpcEndpoint(event.target.value);
                    setPendingDiscovery(null);
                    setPendingHistoryScan(null);
                    setHistoryStartBlock("");
                    setDiscoveryComplete(false);
                    setContractInspection(null);
                    invalidatePlan();
                  }}
                  spellCheck={false}
                  type="url"
                  value={rpcEndpoint}
                />
                {!rpcEndpointValid ? <FieldError>请输入以 http:// 或 https:// 开头的有效 RPC 地址</FieldError> : null}
              </Field>
            </div>

            {fixedStandard === "erc20" ? (
              <Field data-invalid={!amountPolicyValid ? true : undefined}>
                <FieldLabel>归集数量</FieldLabel>
                <Tabs
                  onValueChange={(value) => {
                    setAmountMode(value as AmountMode);
                    invalidatePlan();
                  }}
                  value={amountMode}
                >
                  <TabsList aria-label="EVM 归集数量模式">
                    {Object.entries(amountModeLabels).map(([value, label]) => (
                      <TabsTrigger disabled={controlsLocked} key={value} value={value}>{label}</TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
                {amountMode === "percentage" ? (
                  <Input
                    aria-label="归集百分比"
                    disabled={controlsLocked}
                    inputMode="decimal"
                    max="100"
                    min="0.01"
                    onChange={(event) => { setPercentageAmount(event.target.value); invalidatePlan(); }}
                    step="0.01"
                    type="number"
                    value={percentageAmount}
                  />
                ) : amountMode === "fixed" ? (
                  <Input
                    aria-label="每钱包每资产固定归集数量"
                    disabled={controlsLocked}
                    inputMode="decimal"
                    min="0"
                    onChange={(event) => { setFixedAmount(event.target.value); invalidatePlan(); }}
                    step="0.000001"
                    type="number"
                    value={fixedAmount}
                  />
                ) : amountMode === "random" ? (
                  <div className="amount-grid">
                    <Input aria-label="随机最小数量" disabled={controlsLocked} inputMode="decimal" min="0" onChange={(event) => { setRandomMinimum(event.target.value); invalidatePlan(); }} step="0.000001" type="number" value={randomMinimum} />
                    <Input aria-label="随机最大数量" disabled={controlsLocked} inputMode="decimal" min="0" onChange={(event) => { setRandomMaximum(event.target.value); invalidatePlan(); }} step="0.000001" type="number" value={randomMaximum} />
                  </div>
                ) : null}
                {!amountPolicyValid ? <FieldError>请填写有效数量；百分比为 0.01–100，随机最大值不能小于最小值</FieldError> : null}
              </Field>
            ) : null}

            <div className="field-row execution-settings-row">
              <Field>
                <FieldLabel htmlFor="evm-collection-concurrency">并发钱包数</FieldLabel>
                <Input
                  disabled={controlsLocked}
                  id="evm-collection-concurrency"
                  inputMode="numeric"
                  max="20"
                  min="1"
                  onChange={(event) => { setConcurrency(event.target.value); invalidatePlan(); }}
                  step="1"
                  type="number"
                  value={concurrency}
                />
              </Field>
              <Field>
                <FieldLabel>随机延迟（秒）</FieldLabel>
                <div className="amount-grid compact-range">
                  <Input aria-label="随机延迟最小秒数" disabled={controlsLocked} inputMode="decimal" min="0" onChange={(event) => { setMinimumDelay(event.target.value); invalidatePlan(); }} step="0.1" type="number" value={minimumDelay} />
                  <Input aria-label="随机延迟最大秒数" disabled={controlsLocked} inputMode="decimal" min="0" onChange={(event) => { setMaximumDelay(event.target.value); invalidatePlan(); }} step="0.1" type="number" value={maximumDelay} />
                </div>
              </Field>
            </div>
            {!executionSettingsValid ? <FieldError>并发为 1–20；延迟为 0–300 秒，且最大值不能小于最小值</FieldError> : null}

            <EvmGasSettings
              disabled={controlsLocked}
              gas={gas}
              onSettingsChange={() => invalidatePlan()}
            />

            <AdvancedSettings disabled={controlsLocked} label="高级网络费保护">
              <Field data-invalid={maximumFeeAmount === null ? true : undefined}>
                <FieldLabel htmlFor="evm-collection-max-fee">
                  单笔最高网络费（{selectedNetwork.nativeCurrency.symbol}）
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
                <FieldDescription>
                  预计单笔网络费超过此值时停止提交；当前网络默认 {defaultMaximumFeeAmount} {selectedNetwork.nativeCurrency.symbol}。
                </FieldDescription>
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
                total={results.length}
              />
            ) : null}
          </div>
        </WorkbenchPanel>
        {archivedRound ? (
          <ReviewPanel
            className="collection-round-archive"
            stateKey={archivedRound.sequence}
            summary={(
              <span>
                成功 {archivedRound.results.filter((result) => result.status === "success").length}
                {" · "}需处理 {archivedRound.results.filter((result) => (
                  result.status === "error" || result.status === "skipped"
                )).length}
              </span>
            )}
            title={`上一轮结果 · 第 ${archivedRound.sequence} 轮`}
          >
            <p className="collection-round-archive__message">{archivedRound.message}</p>
            <CollectionResults
              embedded
              exportFilename={`${currentToolId}-round-${archivedRound.sequence}.csv`}
              results={archivedRound.results}
              title="交易明细"
            />
          </ReviewPanel>
        ) : null}
      </div>
    </ToolPageLayout>
  );
}
