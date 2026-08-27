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
import { HelpTooltip } from "../components/HelpTooltip";
import { EvmGasBadge, EvmGasSettings } from "../components/EvmGasControl";
import { CollectionResults } from "../components/CollectionResults";
import { NftAssetInput } from "../components/NftAssetInput";
import { SearchableSelect, type SearchableSelectOption } from "../components/SearchableSelect";
import {
  SecretKeyInput,
  type SecretKeyInputHandle,
  type WalletExecutionItem
} from "../components/SecretKeyInput";
import { ToolPageLayout, type WorkbenchStatus } from "../components/ToolPageLayout";
import {
  AdvancedSettings,
  CollectionExecutionControls,
  ConfirmActionDialog,
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
import { selectErc721CollectionPlan } from "../lib/erc721-collection-selection";
import {
  CollectionPauseController,
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
import {
  sanitizeRoundArchiveText,
  type CollectionDisplayResult,
  type CollectionResultStatus
} from "../lib/collection-results";
import { maximumEvmCollectionChecks, validateEvmCollectionWorkload } from "../lib/collection-workload";
import { discoverEnumerableErc721Assets } from "../lib/erc721-discovery";
import {
  discoverErc721AssetsByTokenRange,
  type Erc721TokenRangeDiscoveryResult
} from "../lib/erc721-token-range-discovery";
import { mergeNftAssetInput } from "../lib/nft-asset-input";
import {
  getStoredOpenSeaApiKey,
  rememberOpenSeaApiKey
} from "../lib/opensea-key-preference";
import {
  discoverNftAssetsFromCandidates,
  getOpenSeaChainIdentifier,
  type Erc1155CandidateHolding
} from "../lib/nft-candidate-discovery";
import {
  getSettledNftAssetKeys,
  reconcileNftContractInventory,
  removeValidNftInventoryAssets
} from "../lib/nft-inventory";
import { inspectNftContract, type NftContractInspection } from "../lib/nft-contract-inspection";
import { getPreferredRpcEndpoint, isRpcEndpoint, rememberRpcEndpoint } from "../lib/rpc-preferences";

type CollectionStage = "editing" | "scanning" | "ready" | "running" | "complete" | "error";

type PendingNftDiscovery = {
  assets: Array<{ contractAddress: string; ownerAddress?: string; tokenId: bigint }>;
  complete: boolean;
  contractAddress: string;
  holdings?: Erc1155CandidateHolding[];
  kind: "candidate-scan" | "enumerable" | "token-range";
  standard: "erc721" | "erc1155";
};

type PendingNftTokenScan = {
  contractAddress: string;
  ownerAddresses: string[];
  seedAssets: Array<{ contractAddress: string; ownerAddress?: string; tokenId: bigint }>;
  snapshotBlock: bigint;
  sourceIssues: string[];
};

type ArchivedCollectionRound = {
  message: string;
  requiresAcknowledgement: boolean;
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

function mergeNftCandidateAssets(
  ...groups: ReadonlyArray<ReadonlyArray<{
    contractAddress: string;
    ownerAddress?: string;
    tokenId: bigint;
  }>>
) {
  const assets = new Map<string, {
    contractAddress: string;
    ownerAddress?: string;
    tokenId: bigint;
  }>();
  for (const group of groups) {
    for (const asset of group) {
      assets.set(`${asset.contractAddress.toLowerCase()}:${asset.tokenId}`, asset);
    }
  }
  return [...assets.values()].sort((left, right) => (
    left.tokenId < right.tokenId ? -1 : left.tokenId > right.tokenId ? 1 : 0
  ));
}

export function getEvmCollectionWorkbenchStatus(
  stage: CollectionStage,
  results: readonly CollectionDisplayResult[]
): WorkbenchStatus {
  const hasFailure = results.some((result) => result.status === "error");
  const hasUncertain = results.some((result) => (
    result.uncertain || (result.status === "error" && Boolean(result.hash) && result.retryable !== true)
  ));
  if (stage === "scanning") return "preflight";
  if (stage === "ready") return "ready";
  if (stage === "running") return "running";
  if (stage === "error") return hasUncertain ? "uncertain" : "error";
  if (stage === "complete") {
    if (hasUncertain) return "uncertain";
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
  success: "已完成",
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

function groupNftWalletStatuses(results: readonly CollectionDisplayResult[]) {
  return groupWalletStatuses(results);
}

export function parseErc721CollectionLimit(value: string) {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const amount = Number(trimmed);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
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
    executionId: item.id,
    label: item.label,
    message: item.message,
    retryable: item.status === "failed",
    status: item.status === "ready" ? "pending" : item.status === "skipped" ? "skipped" : "error",
    uncertain: false
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
    executionId: result.id,
    ...(result.hash ? { explorerUrl: explorerUrl(result.hash), hash: result.hash } : {}),
    label: result.label,
    message: result.message,
    retryable: result.retryable,
    status: result.status === "success" ? "success" : result.status === "skipped" ? "skipped" : "error",
    uncertain: Boolean(result.uncertain)
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
  const [openSeaApiKey, setOpenSeaApiKey] = useState(getStoredOpenSeaApiKey);
  const [openSeaKeyVisible, setOpenSeaKeyVisible] = useState(false);
  const [sourceKeyLineCount, setSourceKeyLineCount] = useState(0);
  const [discoveryIssues, setDiscoveryIssues] = useState<string[]>([]);
  const [discoveryMessage, setDiscoveryMessage] = useState("");
  const [contractInspection, setContractInspection] = useState<NftContractInspection | null>(null);
  const [pendingDiscovery, setPendingDiscovery] = useState<PendingNftDiscovery | null>(null);
  const [pendingTokenScan, setPendingTokenScan] = useState<PendingNftTokenScan | null>(null);
  const [tokenRangeStart, setTokenRangeStart] = useState("");
  const [tokenRangeEnd, setTokenRangeEnd] = useState("");
  const [discoveryComplete, setDiscoveryComplete] = useState(false);
  const [discoveryRunning, setDiscoveryRunning] = useState(false);
  const [assetImporting, setAssetImporting] = useState(false);
  const [keyImporting, setKeyImporting] = useState(false);
  const [amountMode, setAmountMode] = useState<AmountMode>("all");
  const [percentageAmount, setPercentageAmount] = useState("100");
  const [fixedAmount, setFixedAmount] = useState("0.1");
  const [randomMinimum, setRandomMinimum] = useState("0.01");
  const [randomMaximum, setRandomMaximum] = useState("0.1");
  const [nftAmountMode, setNftAmountMode] = useState<"all" | "fixed">("all");
  const [nftFixedAmount, setNftFixedAmount] = useState("1");
  const [concurrency, setConcurrency] = useState("3");
  const [minimumDelay, setMinimumDelay] = useState("0");
  const [maximumDelay, setMaximumDelay] = useState("0");
  const [maxFeeAmount, setMaxFeeAmount] = useState(() => getDefaultEvmCollectionFeeCap(initialNetwork));
  const [nftStandard, setNftStandard] = useState<"erc721" | "erc1155">("erc721");
  const [nftInputResetNonce, setNftInputResetNonce] = useState(0);
  const [stage, setStage] = useState<CollectionStage>("editing");
  const [paused, setPaused] = useState(false);
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
  const pauseControllerRef = useRef(new CollectionPauseController());
  const planRef = useRef<EvmCollectionPlanItem[]>([]);
  const retryPlanRef = useRef<EvmCollectionPlanItem[]>([]);
  const discoveryAbortRef = useRef<AbortController | null>(null);
  const openSeaApiKeyRef = useRef(openSeaApiKey);
  const tokenMetadataCacheRef = useRef(new Map<string, Erc20TokenPreview>());
  const tokenRecognitionRequestRef = useRef(0);
  const selectedNetwork = getEvmNetworkConfig(networkId, networks);
  const openSeaChain = getOpenSeaChainIdentifier(selectedNetwork.chainId);
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
  const targetIsValid = isAddress(targetAddress.trim()) && getAddress(targetAddress.trim()) !== zeroAddress;
  const discoveryContractIsValid = isAddress(discoveryContract.trim())
    && getAddress(discoveryContract.trim()) !== zeroAddress;
  const sourceKeysReady = sourceKeyLineCount > 0;
  const discoverySourceReady = sourceKeysReady;
  const maximumFeeAmount = parsePositiveFeeAmount(maxFeeAmount, selectedNetwork.nativeCurrency.decimals);
  const defaultMaximumFeeAmount = getDefaultEvmCollectionFeeCap(selectedNetwork);
  const nativeCurrencyEnabled = isEvmNativeCurrencyEnabled(selectedNetwork);
  const transactionRunning = stage === "running";
  const operationRunning = transactionRunning || discoveryRunning;
  const running = operationRunning || assetImporting || keyImporting;
  const hasSubmittedHash = results.some((result) => Boolean(result.hash));
  const controlsLocked = running;
  const workbenchStatus = getEvmCollectionWorkbenchStatus(stage, results);
  const completedResultCount = results.filter((result) => (
    result.status === "success" || result.status === "error" || result.status === "skipped"
  )).length;
  const retryableCount = retryPlanRef.current.length;
  const walletStatuses = useMemo(() => fixedStandard === "nft"
    ? groupNftWalletStatuses(results)
    : groupWalletStatuses(results), [fixedStandard, results]);
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
      discoveryAbortRef.current?.abort();
      openSeaApiKeyRef.current = "";
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
      setPendingTokenScan(null);
      const storedOpenSeaApiKey = getStoredOpenSeaApiKey();
      openSeaApiKeyRef.current = storedOpenSeaApiKey;
      setOpenSeaApiKey(storedOpenSeaApiKey);
      discoveryAbortRef.current?.abort();
      discoveryAbortRef.current = null;
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
      pauseControllerRef.current.resume();
      discoveryAbortRef.current?.abort();
      openSeaApiKeyRef.current = "";
      planRef.current = [];
    };
  }, []);

  useEffect(() => {
    openSeaApiKeyRef.current = openSeaApiKey;
  }, [openSeaApiKey]);

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

  const archiveCurrentRound = (removeSettledNfts = false) => {
    if (!results.length || (stage !== "complete" && stage !== "error")) return false;
    const requiresAcknowledgement = workbenchStatus === "uncertain"
      || results.some((result) => result.uncertain);
    setArchivedRound({
      message: sanitizeRoundArchiveText(message || "任务已结束"),
      requiresAcknowledgement,
      results: results.map((result) => ({
        ...result,
        message: sanitizeRoundArchiveText(result.message)
      })),
      sequence: roundSequence
    });
    if (removeSettledNfts && fixedStandard === "nft") {
      const settledAssetKeys = getSettledNftAssetKeys(results);
      if (settledAssetKeys.size) {
        const nextNftInput = removeValidNftInventoryAssets(assetInput, nftStandard, settledAssetKeys);
        setNftAssetInputs((current) => ({ ...current, [nftStandard]: nextNftInput }));
      }
    }
    if (fixedStandard === "nft") {
      setNftAssetInputs({ erc721: "", erc1155: "" });
      setDiscoveryComplete(false);
    }
    balanceRequestRef.current += 1;
    planRef.current = [];
    retryPlanRef.current = [];
    setResults([]);
    setAddressBalances(emptyAddressBalanceState);
    setRoundSequence((current) => current + 1);
    setStage("editing");
    return true;
  };

  const invalidatePlan = (
    clearResults = true,
    preserveDiscovery = false,
    clearAddressBalances = true
  ) => {
    if (operationRef.current || transactionRunning) return;
    const archived = archiveCurrentRound();
    planRef.current = [];
    retryPlanRef.current = [];
    if (clearAddressBalances && fixedStandard === "erc20") {
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
    if (clearResults && !archived) setResults([]);
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
    setPendingTokenScan(null);
    setTokenRangeStart("");
    setTokenRangeEnd("");
    setDiscoveryComplete(false);
    setContractInspection(null);
    if (fixedStandard === "nft") {
      setNftAssetInputs({ erc721: "", erc1155: "" });
      setAddressBalances(emptyAddressBalanceState);
    }
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
    if (fixedStandard === "nft" && nftStandard === "erc721" && nftAmountMode === "fixed") {
      const fixedTotal = parseErc721CollectionLimit(nftFixedAmount);
      if (fixedTotal === null) nextIssues.push("ERC721 指定数量需要是大于 0 的整数");
      else if (fixedTotal > parsedAssets.validAssets.length) {
        nextIssues.push(`指定数量不能大于当前资产总量 ${parsedAssets.validAssets.length}`);
      }
    }
    const executionSettings = getExecutionSettings();
    if (!executionSettings) nextIssues.push("并发需要为 1–20，随机延迟需要为 0–300 秒且最大值不小于最小值");
    return { executionSettings, nextIssues, parsedAccounts, parsedAssets };
  };

  const addDiscoveredAssets = (discovery: PendingNftDiscovery, allowPartial = false) => {
    if (!discovery.complete && !allowPartial) return false;
    if (!discovery.complete && !discovery.assets.length) return false;

    const nextInventory = discovery.complete
      ? reconcileNftContractInventory({
          assetInput: "",
          contractAddress: discovery.contractAddress,
          standard: discovery.standard,
          tokenIds: discovery.assets.map((asset) => asset.tokenId)
        })
      : {
          ...mergeNftAssetInput(
            "",
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
      setDiscoveryMessage("识别结果未保存：当前持仓保持不变，请按提示分批处理");
      return false;
    }

    const selectedAccounts = parseEvmPrivateKeyInput(keyInputRef.current?.read() || "").accounts;
    const holdingsByOwner = new Map<string, { tokenIds: Set<string>; units: bigint }>(
      selectedAccounts.map((account) => [
        account.address.toLowerCase(),
        { tokenIds: new Set<string>(), units: 0n }
      ])
    );
    if (discovery.standard === "erc1155" && discovery.holdings?.length) {
      discovery.holdings.forEach((holding) => {
        const summary = holdingsByOwner.get(holding.ownerAddress.toLowerCase());
        if (!summary) return;
        summary.tokenIds.add(holding.tokenId.toString());
        summary.units += holding.balance;
      });
    } else {
      discovery.assets.forEach((asset) => {
        const ownerAddress = asset.ownerAddress
          || (selectedAccounts.length === 1 ? selectedAccounts[0].address : "");
        const summary = holdingsByOwner.get(ownerAddress.toLowerCase());
        if (!summary) return;
        summary.tokenIds.add(asset.tokenId.toString());
        if (discovery.standard === "erc721") summary.units += 1n;
      });
    }
    const recognizedTotal = discovery.assets.length;
    const recognizedUnits = [...holdingsByOwner.values()].reduce((sum, summary) => sum + summary.units, 0n);
    const standardLabel = discovery.standard.toUpperCase();

    planRef.current = [];
    retryPlanRef.current = [];
    setIssues([]);
    setMessage("");
    setStage("editing");
    setResults([]);
    setNftStandard(discovery.standard);
    setNftAssetInputs((current) => ({ ...current, [discovery.standard]: nextInventory.serialized }));
    if (discovery.standard === "erc721") {
      setNftFixedAmount((current) => {
        const fixedTotal = parseErc721CollectionLimit(current);
        return fixedTotal !== null && fixedTotal <= recognizedTotal
          ? current
          : String(Math.max(1, recognizedTotal));
      });
    }
    setAddressBalances({
      message: discovery.standard === "erc1155"
        ? `已识别 ${recognizedTotal} 个可归集 ERC1155 Token ID，共 ${recognizedUnits} 份`
        : `已识别 ${recognizedTotal} 个可归集 ERC721`,
      rows: selectedAccounts.map((account) => ({
        address: account.address,
        assets: [{
          amount: discovery.standard === "erc1155"
            ? `${holdingsByOwner.get(account.address.toLowerCase())?.tokenIds.size || 0} ID / ${holdingsByOwner.get(account.address.toLowerCase())?.units || 0n}`
            : String(holdingsByOwner.get(account.address.toLowerCase())?.tokenIds.size || 0),
          contractAddress: getAddress(discovery.contractAddress),
          symbol: standardLabel
        }],
        label: account.label
      })),
      status: "ready"
    });
    setPendingDiscovery(null);
    setPendingTokenScan(null);
    setTokenRangeStart("");
    setTokenRangeEnd("");
    setDiscoveryComplete(true);
    setDiscoveryIssues(Array.from(new Set(nextInventory.issues.map((issue) => issue.message))));
    if (discovery.complete) {
      const inventoryCount = discovery.assets.length;
      setDiscoveryMessage(inventoryCount
        ? discovery.standard === "erc1155"
          ? `持仓识别完成：${selectedAccounts.length} 个已选钱包中共有 ${recognizedTotal} 个 ERC1155 Token ID，合计 ${recognizedUnits} 份`
          : `持仓识别完成：${selectedAccounts.length} 个已选钱包中共有 ${recognizedTotal} 个可归集 ERC721`
        : `持仓识别完成：已选钱包当前没有该合约的可归集 ${standardLabel}`);
    } else {
      setDiscoveryMessage(
        nextInventory.added
          ? `已识别 ${recognizedTotal} 个经链上验证的 ${standardLabel}${discovery.standard === "erc1155" ? ` Token ID，合计 ${recognizedUnits} 份` : ""}`
            + (nextInventory.duplicates ? `，跳过 ${nextInventory.duplicates} 个重复项` : "")
            + "；当前结果可能未覆盖完整持仓"
          : `部分识别完成；没有新增的可归集 ${standardLabel}`
      );
    }
    return true;
  };

  const handleTokenRangeResult = (
    result: Erc721TokenRangeDiscoveryResult,
    scan: PendingNftTokenScan,
    seedAssets: ReadonlyArray<{
      contractAddress: string;
      ownerAddress?: string;
      tokenId: bigint;
    }> = scan.seedAssets
  ) => {
    const resultIssues = result.issues.map((issue) => issue.message);
    setDiscoveryIssues([...scan.sourceIssues, ...resultIssues]);
    const mergedAssets = mergeNftCandidateAssets(seedAssets, result.assets);
    const discovery: PendingNftDiscovery = {
      assets: mergedAssets,
      complete: result.complete,
      contractAddress: scan.contractAddress,
      kind: "token-range",
      standard: "erc721"
    };

    if (result.complete) {
      addDiscoveredAssets(discovery);
      return;
    }

    setPendingTokenScan({ ...scan, seedAssets: mergedAssets });
    setTokenRangeStart(result.range?.fromTokenId.toString() || "");
    setTokenRangeEnd(result.range?.toTokenId.toString() || "");
    if (mergedAssets.length) setPendingDiscovery(discovery);

    const expected = result.expectedBalance === null ? "未知" : result.expectedBalance.toString();
    if (!result.range) {
      setDiscoveryMessage(
        `索引与 Transfer 事件尚未找全持仓${mergedAssets.length ? `，已验证 ${mergedAssets.length} 个 Token ID` : ""}`
          + "；合约没有可用计数器，请填写 Token ID 起止范围继续探测。"
      );
    } else if (result.issues.some((issue) => issue.code === "range-limit-exceeded")) {
      setDiscoveryMessage(
        `合约推算范围为 ${result.range.fromTokenId}–${result.range.toTokenId}，超出单轮 RPC 上限，请缩小范围分段探测。`
      );
    } else {
      setDiscoveryMessage(
        `已直接探测 ${result.scanned} 个 Token ID，累计验证 ${mergedAssets.length} / ${expected} 个当前持仓；请调整范围继续探测。`
      );
    }
  };

  const discoverOwnedNft = async () => {
    if (operationRef.current || assetImportingRef.current || keyImportingRef.current
      || running || fixedStandard !== "nft") return;

    archiveCurrentRound(true);
    planRef.current = [];
    retryPlanRef.current = [];
    setResults([]);
    setIssues([]);
    setMessage("");
    setStage("editing");

    setDiscoveryIssues([]);
    setDiscoveryMessage("");
    setPendingDiscovery(null);
    setPendingTokenScan(null);
    setTokenRangeStart("");
    setTokenRangeEnd("");
    setDiscoveryComplete(false);
    if (assetInput.trim()) {
      const existingAssets = parseEvmCollectionAssets(assetInput, nftStandard);
      if (existingAssets.rows.some((row) => row.status === "invalid")) {
        setDiscoveryMessage("当前识别结果格式异常，请重新输入合约后再识别；旧结果不会被覆盖");
        return;
      }
    }
    if (!isAddress(discoveryContract.trim())) {
      setDiscoveryMessage("请输入有效的 NFT 合约地址");
      return;
    }

    const parsedAccounts = parseEvmPrivateKeyInput(keyInputRef.current?.read() || "");
    const ownerAddresses = parsedAccounts.accounts.map((account) => account.address);
    const sourceIssues = parsedAccounts.issues.map((issue) => (
      "密钥第 " + issue.line + " 行：" + issue.message
    ));

    if (!ownerAddresses.length) {
      setDiscoveryIssues(sourceIssues);
      setDiscoveryMessage("请先导入并勾选至少一个有效来源钱包；识别持仓只读取地址，不会提交交易");
      keyInputRef.current?.focus();
      return;
    }
    if (parsedAccounts.invalid) {
      setDiscoveryIssues(sourceIssues);
      setDiscoveryMessage("来源私钥中有错误。为避免漏扫钱包，请修正后再自动识别");
      return;
    }
    const discoveryWorkloadIssues = validateEvmCollectionWorkload({
      accountCount: ownerAddresses.length,
      assetCount: 1,
      standard: nftStandard
    });
    if (discoveryWorkloadIssues.length) {
      setDiscoveryIssues([...sourceIssues, ...discoveryWorkloadIssues]);
      setDiscoveryMessage("来源钱包数量超过自动发现的安全上限，已在发起 RPC 前阻止");
      return;
    }
    const abortController = new AbortController();
    discoveryAbortRef.current = abortController;
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
      if (abortController.signal.aborted) throw new Error("Token ID 识别已停止");
      setContractInspection(inspection);
      if (inspection.standard === "unknown") {
        setDiscoveryIssues([...sourceIssues, ...inspection.issues]);
        setDiscoveryMessage("该地址没有通过 ERC721 / ERC1155 标准识别，未修改持仓结果");
        return;
      }
      setNftStandard(inspection.standard);
      let candidateSourceIssues = [...sourceIssues, ...inspection.issues];
      if (inspection.standard === "erc721") {
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
        if (abortController.signal.aborted) throw new Error("Token ID 识别已停止");
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
              + "。确认后按钱包汇总该部分持仓。"
          );
          return;
        }
        candidateSourceIssues = [...sourceIssues, ...enumerableIssues];
      }

      setDiscoveryIssues(candidateSourceIssues);
      setDiscoveryMessage(openSeaApiKeyRef.current.trim() && openSeaChain
        ? "正在通过 OpenSea 获取候选 Token ID…"
        : "正在扫描 Transfer 事件获取候选 Token ID…");
      const candidateResult = await discoverNftAssetsFromCandidates({
        chainId: selectedNetwork.chainId,
        contractAddress: inspection.address,
        onProgress: (progress) => setDiscoveryMessage(progress.message),
        openSeaApiKey: openSeaApiKeyRef.current,
        ownerAddresses,
        publicClient,
        signal: abortController.signal,
        snapshotBlock: inspection.snapshotBlock,
        standard: inspection.standard
      });
      if (abortController.signal.aborted) throw new Error("Token ID 识别已停止");
      const candidateIssues = candidateResult.issues.map((issue) => issue.message);
      const candidateDiscovery: PendingNftDiscovery = {
        assets: candidateResult.assets,
        complete: candidateResult.complete,
        contractAddress: inspection.address,
        holdings: candidateResult.holdings,
        kind: "candidate-scan",
        standard: inspection.standard
      };
      setDiscoveryIssues([...candidateSourceIssues, ...candidateIssues]);
      if (candidateResult.complete) {
        addDiscoveredAssets(candidateDiscovery);
        return;
      }
      if (inspection.standard === "erc1155") {
        if (candidateResult.assets.length) {
          setPendingDiscovery(candidateDiscovery);
          setDiscoveryMessage(
            `已通过 balanceOfBatch 验证 ${candidateResult.assets.length} 个 ERC1155 Token ID；事件历史未完整覆盖，请确认只使用该部分结果，或通过手工 / 文件补充。`
          );
        } else {
          setDiscoveryMessage("ERC1155 事件历史未完整覆盖，且没有发现余额大于 0 的候选 Token ID；请通过手工 / 文件提供已知 ID。");
        }
        return;
      }
      setDiscoveryMessage("索引与事件尚未完成余额对账，正在使用 Token ID 范围做最后兜底…");
      const scan: PendingNftTokenScan = {
        contractAddress: getAddress(discoveryContract.trim()),
        ownerAddresses,
        seedAssets: candidateResult.assets,
        snapshotBlock: inspection.snapshotBlock,
        sourceIssues: [...candidateSourceIssues, ...candidateIssues]
      };
      const rangeResult = await discoverErc721AssetsByTokenRange({
        contractAddress: scan.contractAddress,
        onProgress: (progress) => {
          if (progress.stage === "reading-balances") {
            setDiscoveryMessage("正在读取来源钱包的 ERC721 balanceOf…");
          } else if (progress.stage === "detecting-range") {
            setDiscoveryMessage("正在读取 totalSupply 与常见铸造计数器…");
          } else {
            setDiscoveryMessage(
              `正在直接调用 ownerOf · ${progress.scanned}/${progress.total || "—"} · 已找到 ${progress.discovered} 个`
            );
          }
        },
        ownerAddresses,
        publicClient,
        signal: abortController.signal,
        snapshotBlock: inspection.snapshotBlock
      });
      handleTokenRangeResult(rangeResult, scan);
      return;
    } catch (error) {
      if (isAbortError(error, abortController.signal)) {
        setDiscoveryMessage("Token ID 识别已停止，现有持仓结果未修改。可以直接再次识别。");
        return;
      }
      const detail = error instanceof Error ? error.message : "RPC 请求失败";
      setDiscoveryMessage(detail.includes("RPC 网络不匹配")
        ? detail
        : "自动识别失败，请检查网络、RPC 与合约；现有持仓结果没有被修改");
    } finally {
      if (discoveryAbortRef.current === abortController) discoveryAbortRef.current = null;
      operationRef.current = false;
      setDiscoveryRunning(false);
      setStage((current) => current === "scanning" ? "editing" : current);
    }
  };

  const runPendingTokenScan = async () => {
    if (!pendingTokenScan || operationRef.current || running) return;
    if (!/^\d+$/.test(tokenRangeStart.trim()) || !/^\d+$/.test(tokenRangeEnd.trim())) {
      setDiscoveryMessage("请输入有效的 Token ID 起止范围");
      return;
    }
    const fromTokenId = BigInt(tokenRangeStart.trim());
    const toTokenId = BigInt(tokenRangeEnd.trim());
    if (toTokenId < fromTokenId) {
      setDiscoveryMessage("Token ID 结束值不能小于起始值");
      return;
    }
    const abortController = new AbortController();
    discoveryAbortRef.current = abortController;
    operationRef.current = true;
    setDiscoveryRunning(true);
    setStage("scanning");
    setPendingDiscovery(null);
    setDiscoveryIssues(pendingTokenScan.sourceIssues);
    setDiscoveryMessage(`正在通过 ownerOf 直接探测 Token ID ${fromTokenId}–${toTokenId}…`);

    try {
      const publicClient = createEvmPublicClient(selectedNetwork, effectiveRpcEndpoint);
      await assertEvmRpcNetwork(publicClient, selectedNetwork);
      const rangeResult = await discoverErc721AssetsByTokenRange({
        contractAddress: pendingTokenScan.contractAddress,
        fromTokenId,
        onProgress: (progress) => {
          if (progress.stage !== "scanning-token-ids") return;
          setDiscoveryMessage(
            `正在直接调用 ownerOf · ${progress.scanned}/${progress.total || "—"} · 已找到 ${progress.discovered} 个`
          );
        },
        ownerAddresses: pendingTokenScan.ownerAddresses,
        publicClient,
        signal: abortController.signal,
        snapshotBlock: pendingTokenScan.snapshotBlock,
        toTokenId
      });
      handleTokenRangeResult(rangeResult, pendingTokenScan);
    } catch (error) {
      if (isAbortError(error, abortController.signal)) {
        setDiscoveryMessage("Token ID 探测已停止，现有持仓结果未修改；可调整范围后重新探测。");
        return;
      }
      const detail = error instanceof Error ? error.message : "RPC 请求失败";
      setDiscoveryMessage(detail.includes("RPC 网络不匹配")
        ? detail
        : "Token ID 探测失败，请检查 RPC 后重试；现有持仓结果没有被修改");
    } finally {
      if (discoveryAbortRef.current === abortController) discoveryAbortRef.current = null;
      operationRef.current = false;
      setDiscoveryRunning(false);
      setStage((current) => current === "scanning" ? "editing" : current);
    }
  };

  const cancelNftDiscovery = () => {
    if (discoveryRunning) {
      if (!discoveryAbortRef.current || discoveryAbortRef.current.signal.aborted) return;
      discoveryAbortRef.current.abort();
      setDiscoveryMessage("正在停止 Token ID 探测；已读取的数据不会写入持仓结果…");
      return;
    }
    if (!pendingTokenScan) return;
    setDiscoveryMessage("已取消 Token ID 范围探测，现有持仓结果未修改。");
    setPendingTokenScan(null);
    setTokenRangeStart("");
    setTokenRangeEnd("");
  };

  const applyPendingDiscovery = (allowPartial = false) => {
    if (!pendingDiscovery || operationRef.current || running) return;
    if (!pendingDiscovery.complete && !allowPartial) {
      setDiscoveryMessage("这是部分发现结果。请先确认仅归集已验证项目，或调整 Token ID 范围继续探测。");
      return;
    }
    addDiscoveredAssets(pendingDiscovery, allowPartial);
  };

  const handlePausedChange = (nextPaused: boolean) => {
    if (!transactionRunning) return;
    if (nextPaused) pauseControllerRef.current.pause();
    else pauseControllerRef.current.resume();
    setPaused(nextPaused);
    setMessage(nextPaused
      ? "已请求暂停：当前正在提交或确认的交易会安全完成，之后不再启动新的钱包或归集项"
      : "已继续归集，正在启动后续钱包与归集项");
  };

  const executeCollection = async (retryIds?: readonly string[]) => {
    if (operationRef.current || assetImportingRef.current || keyImportingRef.current || running) return;
    const retryOnly = retryIds !== undefined;
    const requestedRetryIds = new Set(retryIds || []);
    const allRetryablePlan = retryPlanRef.current;
    const retryPlan = retryOnly
      ? allRetryablePlan.filter((item) => requestedRetryIds.has(item.id))
      : [];
    const untouchedRetryPlan = retryOnly
      ? allRetryablePlan.filter((item) => !requestedRetryIds.has(item.id))
      : [];
    const prepared = validateCollectionInputs();
    const gasSettings = gas.gasSettings;
    const maxFeePerTransactionWei = parseMaximumFee();
    if (prepared.nextIssues.length || !gasSettings || maxFeePerTransactionWei === null
      || !prepared.executionSettings || (retryOnly && !retryPlan.length)) {
      setIssues(prepared.nextIssues.length ? prepared.nextIssues : ["没有可重试的失败项"]);
      setStage("error");
      setMessage("请修正设置后再执行，当前钱包与配置均已保留");
      return;
    }
    const target = getAddress(targetAddress.trim());
    operationRef.current = true;
    pauseControllerRef.current.resume();
    setPaused(false);
    retryPlanRef.current = untouchedRetryPlan;
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
        ? {
            ...result,
            hash: undefined,
            explorerUrl: undefined,
            message: "等待重试",
            retryable: false,
            status: "pending",
            uncertain: false
          }
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
          : nftStandard === "erc1155"
            ? ownershipPlan
            : selectErc721CollectionPlan(
                ownershipPlan,
                prepared.parsedAccounts.accounts,
                nftAmountMode === "fixed" ? parseErc721CollectionLimit(nftFixedAmount) : null
              );
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
          await pauseControllerRef.current.waitUntilResumed();
          await waitForCollectionDelay(prepared.executionSettings!);
          await pauseControllerRef.current.waitUntilResumed();
          return executeEvmCollectionPlan({
            gasSettings,
            getWalletClient: (account) => createWalletClient({
              account,
              chain,
              transport: http(effectiveRpcEndpoint)
            }),
            maxFeePerTransactionWei,
            onProgress: updateProgress,
            pauseControl: pauseControllerRef.current,
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
      retryPlanRef.current = [
        ...untouchedRetryPlan,
        ...executionPlan.filter((item) => resultById.get(item.id)?.retryable)
      ];
      const success = executionResults.filter((result) => result.status === "success").length;
      const failed = executionResults.filter((result) => result.status === "failed").length;
      setStage("complete");
      setMessage(`归集完成：${success} 项确认成功${failed ? `，${failed} 项失败` : ""}`
        + (retryPlanRef.current.length ? `；${retryPlanRef.current.length} 项可直接重试` : ""));
    } catch (error) {
      retryPlanRef.current = [
        ...untouchedRetryPlan,
        ...executionPlan.filter((item) => item.status === "ready" && !submittedIds.has(item.id))
      ];
      const affectedIds = new Set(executionPlan.map((item) => item.id));
      setResults((current) => current.map((result, index) => {
        const item = planRef.current[index];
        if (!item || !affectedIds.has(item.id)) return result;
        const uncertain = submittedIds.has(item.id) || Boolean(result.hash);
        return {
          ...result,
          message: uncertain
            ? "交易已提交但确认状态不确定，请根据哈希核对链上状态"
            : "执行在提交前中断，可安全重试",
          retryable: !uncertain && item.status === "ready",
          status: "error",
          uncertain
        };
      }));
      setStage("error");
      const detail = error instanceof Error ? error.message : "RPC 请求失败";
      setMessage(detail.includes("RPC 网络不匹配")
        ? detail
        : "归集流程中断，钱包与设置均已保留，可直接重试；已显示哈希的项目请先核对链上状态");
    } finally {
      operationRef.current = false;
      pauseControllerRef.current.resume();
      setPaused(false);
    }
  };

  const clearWorkbench = () => {
    pauseControllerRef.current.resume();
    setPaused(false);
    keyInputRef.current?.clear();
    balanceRequestRef.current += 1;
    tokenRecognitionRequestRef.current += 1;
    planRef.current = [];
    retryPlanRef.current = [];
    setErc20AssetInput("");
    setNftAssetInputs({ erc721: "", erc1155: "" });
    setDiscoveryContract("");
    setPendingDiscovery(null);
    setPendingTokenScan(null);
    setTokenRangeStart("");
    setTokenRangeEnd("");
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
    setNftAmountMode("all");
    setNftFixedAmount("1");
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

  const parsedNftFixedAmount = parseErc721CollectionLimit(nftFixedAmount);
  const nftAmountPolicyValid = nftStandard === "erc1155" || nftAmountMode === "all"
    || (parsedNftFixedAmount !== null && parsedNftFixedAmount <= parsedAssetCount);
  const amountPolicyValid = fixedStandard === "nft"
    ? nftAmountPolicyValid
    : Boolean(parseEvmAmountPolicy({
        decimals: selectedNetwork.nativeCurrency.decimals,
        fixedAmount,
        mode: amountMode,
        percentageAmount,
        randomMaximum,
        randomMinimum
      }));
  const executionSettingsValid = getExecutionSettings() !== null;
  const rpcEndpointValid = isRpcEndpoint(effectiveRpcEndpoint);
  const executableAssetCount = parsedAssetCount;
  const canStart = targetIsValid && sourceKeyLineCount > 0 && executableAssetCount > 0
    && Boolean(gas.gasSettings) && maximumFeeAmount !== null && amountPolicyValid
    && executionSettingsValid && rpcEndpointValid && !running
    && !archivedRound?.requiresAcknowledgement;
  const parsedTokenRangeStart = /^\d+$/.test(tokenRangeStart.trim())
    ? BigInt(tokenRangeStart.trim())
    : null;
  const parsedTokenRangeEnd = /^\d+$/.test(tokenRangeEnd.trim())
    ? BigInt(tokenRangeEnd.trim())
    : null;
  const tokenRangeSize = parsedTokenRangeStart !== null && parsedTokenRangeEnd !== null
    && parsedTokenRangeEnd >= parsedTokenRangeStart
    ? parsedTokenRangeEnd - parsedTokenRangeStart + 1n
    : null;
  const tokenRangeRpcLimit = pendingTokenScan
    ? BigInt(Math.max(0, maximumEvmCollectionChecks - pendingTokenScan.ownerAddresses.length))
    : 0n;
  const tokenRangeValid = Boolean(
    pendingTokenScan
    && tokenRangeSize !== null
    && tokenRangeSize <= tokenRangeRpcLimit
  );

  return (
    <ToolPageLayout
      actions={(
        <>
          <EvmGasBadge gas={gas} />
          <Badge variant="outline">{selectedNetwork.label}</Badge>
          <ConfirmActionDialog
            confirmLabel="确认清空"
            description={hasSubmittedHash || archivedRound?.results.some((result) => Boolean(result.hash))
              ? "当前记录包含已提交的交易哈希。清空前请先核对链上状态；清空后无法恢复。"
              : "来源密钥、持仓识别结果、归集设置和历史记录将从页面清除。"}
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
        ? "Token ID 探测中"
        : evmStatusLabels[workbenchStatus]}
      title={fixedStandard === "erc20" ? "EVM 代币归集" : "EVM NFT 归集"}
    >
      <div className={"workspace collection-workspace" + (results.length ? " has-results" : "")}>
        <WorkbenchPanel
          actions={fixedStandard === "nft" ? (
            <Field className="nft-opensea-key">
              <FieldLabel htmlFor="nft-opensea-api-key">OpenSea Key</FieldLabel>
              <div
                className="nft-opensea-key__control"
                title={!openSeaChain ? "当前网络不支持 OpenSea；Key 仅保存，持仓识别使用 RPC。" : undefined}
              >
                <Input
                  autoCapitalize="none"
                  autoComplete="off"
                  aria-describedby="nft-opensea-api-key-note"
                  className="nft-opensea-key__input"
                  data-masked={!openSeaKeyVisible || undefined}
                  disabled={controlsLocked}
                  id="nft-opensea-api-key"
                  maxLength={512}
                  onChange={(event) => {
                    openSeaApiKeyRef.current = event.target.value;
                    setOpenSeaApiKey(event.target.value);
                    rememberOpenSeaApiKey(event.target.value);
                  }}
                  placeholder={openSeaChain ? "可选" : "仅保存，当前链使用 RPC"}
                  spellCheck={false}
                  type="text"
                  value={openSeaApiKey}
                />
                <Button
                  aria-label={openSeaKeyVisible ? "隐藏 OpenSea Key" : "显示 OpenSea Key"}
                  aria-pressed={openSeaKeyVisible}
                  className="nft-opensea-key__visibility"
                  disabled={controlsLocked}
                  onClick={() => setOpenSeaKeyVisible((visible) => !visible)}
                  size="xs"
                  type="button"
                  variant="ghost"
                >
                  {openSeaKeyVisible ? "隐藏" : "显示"}
                </Button>
              </div>
              <span className="sr-only" id="nft-opensea-api-key-note">
                {openSeaChain
                  ? "用于 OpenSea 持仓识别，可选。"
                  : "当前网络不支持 OpenSea；Key 仅保存，持仓识别使用 RPC。"}
              </span>
            </Field>
          ) : undefined}
          className="collection-workbench-panel"
          footer={(
            <div className="actions collection-actions">
              {stage === "running" ? (
                <CollectionExecutionControls
                  current={completedResultCount}
                  label="EVM 归集进度"
                  onPausedChange={handlePausedChange}
                  paused={paused}
                  total={results.length}
                />
              ) : retryableCount ? (
                <ConfirmActionDialog
                  confirmLabel={`重试 ${retryableCount} 个失败项`}
                  description="只重试尚未提交或已明确执行失败的项目；状态不确定的交易不会自动重发。"
                  disabled={running}
                  onConfirm={() => executeCollection(retryPlanRef.current.map((item) => item.id))}
                  title="确认重试失败项？"
                  triggerLabel={`重试失败项 (${retryableCount})`}
                  triggerVariant="outline"
                />
              ) : results.length && (stage === "complete" || stage === "error") ? (
                <span className="hint" role="status">
                  {workbenchStatus === "uncertain"
                    ? "可继续编辑或识别；原交易需先核对，新的写入任务会在归档确认后开放。"
                    : "可直接修改设置或再次识别，当前结果会自动移入下方记录。"}
                </span>
              ) : (
                <ConfirmActionDialog
                  confirmLabel="确认并开始归集"
                  description={(
                    <div className="summary-list">
                      <div><span>网络</span><strong>{selectedNetwork.label}</strong></div>
                      <div><span>目标地址</span><strong className="mono">{targetAddress || "—"}</strong></div>
                      <div><span>来源钱包</span><strong>{sourceKeyLineCount} 个已选择</strong></div>
                      <div>
                        <span>{fixedStandard === "nft" ? "已识别持仓" : "资产项"}</span>
                        <strong>{fixedStandard === "nft" ? `${parsedAssetCount} 个 Token ID` : parsedAssetCount}</strong>
                      </div>
                      <div><span>归集数量</span><strong>{fixedStandard === "nft"
                        ? nftStandard === "erc1155" || nftAmountMode === "all" ? "全部余额" : `${nftFixedAmount} 个（所有钱包合计）`
                        : amountModeLabels[amountMode]}</strong></div>
                      <div><span>并发</span><strong>{concurrency}</strong></div>
                      <div><span>随机延迟</span><strong>{minimumDelay}–{maximumDelay} 秒</strong></div>
                      <div><span>单笔最高网络费</span><strong>{maxFeeAmount} {selectedNetwork.nativeCurrency.symbol}</strong></div>
                    </div>
                  )}
                  disabled={!canStart}
                  onConfirm={() => executeCollection()}
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
              <SecretKeyInput
                compactStatuses
                disabled={controlsLocked || assetImporting}
                mode="evm"
                onDirty={() => {
                  setPendingDiscovery(null);
                  setPendingTokenScan(null);
                  setTokenRangeStart("");
                  setTokenRangeEnd("");
                  setDiscoveryComplete(false);
                  setNftAssetInputs({ erc721: "", erc1155: "" });
                  setAddressBalances(emptyAddressBalanceState);
                  invalidatePlan();
                }}
                onImportingChange={handleKeyImportingChange}
                onLineCountChange={setSourceKeyLineCount}
                ref={keyInputRef}
                walletBalances={walletBalances}
                walletStatuses={walletStatuses}
              />
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
                  autoDiscovery={(
                    <section aria-labelledby="nft-discovery-title" className="nft-discovery-card">
                      <div className="nft-discovery-card__bar">
                        <div className="nft-discovery-card__title">
                          <h4 id="nft-discovery-title">持仓识别</h4>
                          <Badge variant="outline">
                            {discoveryComplete ? `${parsedAssetCount} 个 ${nftStandard.toUpperCase()} Token ID` : "OpenSea + RPC 复核"}
                          </Badge>
                        </div>
                        <Button
                          disabled={!discoveryRunning && (controlsLocked || !discoveryContractIsValid || !discoverySourceReady)}
                          onClick={() => discoveryRunning ? cancelNftDiscovery() : void discoverOwnedNft()}
                          size="sm"
                          type="button"
                          variant={discoveryRunning ? "outline" : "default"}
                        >
                          {discoveryRunning
                            ? "停止识别"
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

                      {pendingTokenScan ? (
                        <Alert className="nft-token-scan" data-scanning={discoveryRunning || undefined}>
                          <AlertTitle>直接探测 Token ID</AlertTitle>
                          <AlertDescription>
                            <p>
                              OpenSea 与 Transfer 事件仍未完成余额对账。页面会在固定快照区块对指定范围调用
                              <code> ownerOf </code>，并用来源地址的 <code>balanceOf</code> 继续复核。
                            </p>
                            <div className="nft-token-scan__range" aria-label="Token ID 探测范围">
                              <div>
                                <span>快照区块</span>
                                <strong>{pendingTokenScan.snapshotBlock.toLocaleString()}</strong>
                              </div>
                              <div>
                                <span>预计 ownerOf</span>
                                <strong>{tokenRangeSize?.toLocaleString() || "—"} 次</strong>
                              </div>
                              <div><span>单轮上限</span><strong>{tokenRangeRpcLimit.toLocaleString()} 次</strong></div>
                            </div>
                            <div className="nft-token-scan__fields">
                              <Field data-invalid={tokenRangeStart.trim() && parsedTokenRangeStart === null ? true : undefined}>
                                <FieldLabel htmlFor="nft-token-range-start">起始 Token ID</FieldLabel>
                                <Input
                                  aria-invalid={tokenRangeStart.trim() && parsedTokenRangeStart === null ? true : undefined}
                                  disabled={discoveryRunning}
                                  id="nft-token-range-start"
                                  inputMode="numeric"
                                  min="0"
                                  onChange={(event) => setTokenRangeStart(event.target.value)}
                                  step="1"
                                  type="number"
                                  value={tokenRangeStart}
                                />
                              </Field>
                              <Field data-invalid={tokenRangeEnd.trim() && parsedTokenRangeEnd === null ? true : undefined}>
                                <FieldLabel htmlFor="nft-token-range-end">结束 Token ID</FieldLabel>
                                <Input
                                  aria-invalid={tokenRangeEnd.trim() && parsedTokenRangeEnd === null ? true : undefined}
                                  disabled={discoveryRunning}
                                  id="nft-token-range-end"
                                  inputMode="numeric"
                                  min="0"
                                  onChange={(event) => setTokenRangeEnd(event.target.value)}
                                  step="1"
                                  type="number"
                                  value={tokenRangeEnd}
                                />
                              </Field>
                            </div>
                            <FieldDescription>
                              范围命中全部来源余额后会自动停止；找不全时只展示已验证结果，不会删除旧清单项。
                            </FieldDescription>
                            {!tokenRangeValid ? (
                              <FieldError>请输入有效范围，且单轮 ownerOf 调用不能超过 {tokenRangeRpcLimit.toLocaleString()} 次</FieldError>
                            ) : null}
                            <div className="nft-token-scan__actions">
                              <Button
                                disabled={discoveryRunning || !tokenRangeValid}
                                onClick={() => void runPendingTokenScan()}
                                size="sm"
                                type="button"
                              >
                                {discoveryRunning ? "正在探测" : "探测 Token ID"}
                              </Button>
                              <Button
                                onClick={cancelNftDiscovery}
                                size="sm"
                                type="button"
                                variant="ghost"
                              >{discoveryRunning ? "停止探测" : "取消"}</Button>
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
                              confirmLabel="确认使用部分结果"
                              description="只会使用当前已验证的 Token ID；未覆盖的资产不会自动归集，需另行核对。"
                              disabled={controlsLocked}
                              onConfirm={() => applyPendingDiscovery(true)}
                              title="使用部分识别结果？"
                              triggerLabel="确认使用部分结果"
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
                  key={nftInputResetNonce}
                  onChange={(value) => {
                    setCurrentAssetInput(value);
                    invalidatePlan();
                  }}
                  onContractAddressChange={(value) => {
                    setDiscoveryContract(value);
                    setNftAssetInputs({ erc721: "", erc1155: "" });
                    setAddressBalances(emptyAddressBalanceState);
                    setPendingDiscovery(null);
                    setPendingTokenScan(null);
                    setTokenRangeStart("");
                    setTokenRangeEnd("");
                    setDiscoveryComplete(false);
                    setContractInspection(null);
                    setDiscoveryMessage("");
                    setDiscoveryIssues([]);
                    invalidatePlan();
                  }}
                  onImportingChange={handleAssetImportingChange}
                  onStandardChange={(nextStandard) => {
                    setNftStandard(nextStandard);
                    if (nextStandard === "erc1155") setNftAmountMode("all");
                    setAddressBalances(emptyAddressBalanceState);
                    setPendingDiscovery(null);
                    setPendingTokenScan(null);
                    setDiscoveryComplete(false);
                    setDiscoveryMessage("");
                    setDiscoveryIssues([]);
                    invalidatePlan();
                  }}
                  standard={nftStandard}
                  value={assetInput}
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
                    setPendingTokenScan(null);
                    setTokenRangeStart("");
                    setTokenRangeEnd("");
                    setDiscoveryComplete(false);
                    setContractInspection(null);
                    if (fixedStandard === "nft") {
                      setNftAssetInputs({ erc721: "", erc1155: "" });
                      setAddressBalances(emptyAddressBalanceState);
                    }
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

            {fixedStandard === "nft" ? (
              nftStandard === "erc1155" ? (
                <Field>
                  <div className="flex w-fit items-center gap-1">
                    <FieldLabel>归集数量</FieldLabel>
                    <HelpTooltip label="归集数量说明">
                      归集每个已选来源钱包中、每个已列出 Token ID 的全部实时余额。余额会在提交前重新读取。
                    </HelpTooltip>
                  </div>
                  <Badge variant="outline">归集全部余额</Badge>
                  <FieldDescription>
                    ERC1155 暂不提供“指定总数量”，避免在多个钱包和 Token ID 之间产生不明确的份数分配。
                  </FieldDescription>
                </Field>
              ) : (
                <Field data-invalid={!nftAmountPolicyValid ? true : undefined}>
                  <div className="flex w-fit items-center gap-1">
                    <FieldLabel>归集数量</FieldLabel>
                    <HelpTooltip label="归集数量说明">
                      归集全部：归集所有已识别的 ERC721；指定总数量：从已选钱包合计归集 N 个，不足则全部归集。
                    </HelpTooltip>
                  </div>
                  <Tabs
                    onValueChange={(value) => {
                      setNftAmountMode(value as "all" | "fixed");
                      invalidatePlan();
                    }}
                    value={nftAmountMode}
                  >
                    <TabsList aria-label="ERC721 归集数量模式">
                      <TabsTrigger disabled={controlsLocked} value="all">归集全部</TabsTrigger>
                      <TabsTrigger disabled={controlsLocked || parsedAssetCount === 0} value="fixed">指定总数量</TabsTrigger>
                    </TabsList>
                  </Tabs>
                  {nftAmountMode === "fixed" ? (
                    <Input
                      aria-label="ERC721 归集总数量"
                      disabled={controlsLocked || parsedAssetCount === 0}
                      inputMode="numeric"
                      max={Math.max(1, parsedAssetCount)}
                      min="1"
                      onChange={(event) => {
                        setNftFixedAmount(event.target.value);
                        invalidatePlan();
                      }}
                      step="1"
                      type="number"
                      value={nftFixedAmount}
                    />
                  ) : null}
                  {!nftAmountPolicyValid ? (
                    <FieldError>请输入 1–{parsedAssetCount} 的整数</FieldError>
                  ) : null}
                </Field>
              )
            ) : null}

            <div className="field-row execution-settings-row">
              <Field>
                <div className="flex w-fit items-center gap-1">
                  <FieldLabel htmlFor="evm-collection-concurrency">并发钱包数</FieldLabel>
                  {fixedStandard === "nft" ? (
                    <HelpTooltip label="并发钱包数说明">
                      可按 RPC 承载能力自行设置；高于已选钱包数时只执行现有钱包，不会产生额外任务。
                    </HelpTooltip>
                  ) : null}
                </div>
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

          </div>
        </WorkbenchPanel>
        {archivedRound ? (
          <ReviewPanel
            actions={archivedRound.requiresAcknowledgement ? (
              <ConfirmActionDialog
                confirmLabel="确认已核对"
                description="仅确认你已通过交易哈希核对记录中的链上状态；这不会重试或撤销原交易。确认后才允许提交新的写入任务。"
                onConfirm={() => setArchivedRound((current) => current ? {
                  ...current,
                  requiresAcknowledgement: false
                } : current)}
                title="已核对记录中的链上状态？"
                triggerLabel="已核对，开始新任务"
                triggerVariant="outline"
              />
            ) : null}
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
            title="归集记录"
          >
            <p className="collection-round-archive__message">{archivedRound.message}</p>
            <CollectionResults
              embedded
              exportFilename={`${currentToolId}-records.csv`}
              results={archivedRound.results}
              title="交易明细"
            />
          </ReviewPanel>
        ) : null}
      </div>
    </ToolPageLayout>
  );
}
