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
import { CollectionResults } from "../components/CollectionResults";
import { EvmGasBadge, EvmGasSettings } from "../components/EvmGasControl";
import { NftAssetInput } from "../components/NftAssetInput";
import { NftInventoryReview } from "../components/NftInventoryReview";
import { SearchableSelect, type SearchableSelectOption } from "../components/SearchableSelect";
import { SecretKeyInput, type SecretKeyInputHandle } from "../components/SecretKeyInput";
import { ToolPageLayout, type WorkbenchStatus } from "../components/ToolPageLayout";
import {
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
  preflightEvmCollectionPlan,
  readErc20Metadata,
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
  isEvmNativeCurrencyEnabled,
  rememberPreferredEvmDistributionNetwork,
  toEvmChain,
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
import { mergeNftAssetInput } from "../lib/nft-asset-input";
import { inspectNftContract, type NftContractInspection } from "../lib/nft-contract-inspection";

type CollectionStage = "editing" | "scanning" | "ready" | "running" | "complete" | "error";
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

function parsePositiveFeeAmount(value: string, decimals: number) {
  try {
    const parsed = parseUnits(value.trim(), decimals);
    return parsed > 0n ? parsed : null;
  } catch {
    return null;
  }
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

function planItemToDisplay(
  item: EvmCollectionPlanItem,
  nativeCurrency: EvmNativeCurrency
): CollectionDisplayResult {
  return {
    address: item.address || "—",
    amount: getFormattedAmount(item, nativeCurrency),
    asset: getAssetName(item, nativeCurrency),
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
  const [rpcEndpoint, setRpcEndpoint] = useState(initialNetwork.rpcEndpoint);
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
  const [tokenRecognition, setTokenRecognition] = useState<TokenRecognitionState>(emptyTokenRecognitionState);
  const [addressBalances, setAddressBalances] = useState<AddressBalanceState>(emptyAddressBalanceState);
  const keyInputRef = useRef<SecretKeyInputHandle>(null);
  const assetImportingRef = useRef(false);
  const balanceRequestRef = useRef(0);
  const keyImportingRef = useRef(false);
  const operationRef = useRef(false);
  const planRef = useRef<EvmCollectionPlanItem[]>([]);
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
  const readyCount = planRef.current.filter((item) => item.status === "ready").length;
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
  const nativeCurrencyEnabled = isEvmNativeCurrencyEnabled(selectedNetwork);
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
  const reviewErrorCount = results.filter((result) => result.status === "error").length;
  const reviewHasRisk = workbenchStatus === "error" || workbenchStatus === "uncertain" || reviewErrorCount > 0;
  const reviewShouldOpen = hasSubmittedHash || (reviewHasRisk && results.length > 0);
  const reviewSummaryLabel = workbenchStatus === "ready" && reviewErrorCount > 0
    ? `部分通过 · ${reviewErrorCount} 项需处理`
    : workbenchStatus === "ready"
      ? `预检通过 · ${readyTransactionCount} 笔`
      : workbenchStatus === "editing"
        ? results.length ? `${results.length} 项待查看` : "尚未预检"
        : workbenchStatus === "success"
          ? `已完成 · ${results.length} 项`
          : `${evmStatusLabels[workbenchStatus]}${results.length ? ` · ${results.length} 项` : ""}`;
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
          ? `已识别前 ${limitedAssets.length} 个 Token；其余将在预检时读取`
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
              ? `已识别前 ${limitedAssets.length} 个 Token；其余将在预检时读取`
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
    setPreflightSummary(null);
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
    setRpcEndpoint(nextNetwork.rpcEndpoint);
    setPendingDiscovery(null);
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
    if (standard === "native" && !nativeCurrencyEnabled) {
      nextIssues.push("当前网络的原生币元数据尚未确认，请填写 Token 合约地址或先确认网络信息");
    }

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
      setResults(ownershipPlan.map((item) => planItemToDisplay(item, selectedNetwork.nativeCurrency)));
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
      setResults(plan.map((item) => planItemToDisplay(item, selectedNetwork.nativeCurrency)));

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

  const addDiscoveredAssets = (discovery: PendingNftDiscovery, allowPartial = false) => {
    if (!discovery.complete && !allowPartial) return false;
    const contractAddress = discovery.assets[0]?.contractAddress;
    if (!contractAddress) return false;

    const tokenExpression = discovery.assets.map((asset) => asset.tokenId.toString()).join(",");
    const merged = mergeNftAssetInput(assetInput, contractAddress, tokenExpression);
    const mergeErrors = merged.issues.filter((issue) => issue.severity === "error");
    if (mergeErrors.length) {
      setDiscoveryIssues((current) => [
        ...current,
        ...mergeErrors.map((issue) => issue.message)
      ]);
      setDiscoveryMessage("发现结果未加入清单：现有清单保持不变，请按提示分批处理");
      return false;
    }

    planRef.current = [];
    setPreflightSummary(null);
    setIssues([]);
    setMessage("");
    setStage("editing");
    setResults([]);
    setCurrentAssetInput(merged.serialized);
    setPendingDiscovery(null);
    setDiscoveryIssues((current) => Array.from(new Set([
      ...current,
      ...merged.issues.map((issue) => issue.message)
    ])));
    setDiscoveryMessage(
      merged.added
        ? "已识别并自动加入 " + merged.added + " 个 NFT"
          + (merged.duplicates ? "，跳过 " + merged.duplicates + " 个重复项" : "")
        : "识别完成；发现的 NFT 已全部在待归集资产中"
    );
    return true;
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
        if (!enumerable.assets.length) {
          setDiscoveryMessage(enumerable.issues[0]?.message || "来源钱包在该合约中没有可枚举的 NFT");
          return;
        }
        const discovery: PendingNftDiscovery = {
          assets: enumerable.assets,
          complete: enumerableComplete,
          kind: "enumerable"
        };
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
            if (!verified.assets.length) {
              setDiscoveryMessage("公开索引与链上余额已完成对账；这些来源钱包当前未持有该 NFT");
              return;
            }
            addDiscoveredAssets({
              assets: verified.assets,
              complete: true,
              kind: "indexer",
              latestBlock: verified.snapshotBlock ?? undefined
            });
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
      const scope: Erc721TransferDiscoveryScope = "full-history";
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
      const completedDiscovery: PendingNftDiscovery = {
        assets: transferDiscovery.assets,
        complete: transferDiscovery.complete,
        kind: "transfer",
        latestBlock: transferDiscovery.latestBlock,
        scope: transferDiscovery.scope
      };
      if (transferDiscovery.complete) {
        addDiscoveredAssets(completedDiscovery);
        return;
      }
      setPendingDiscovery(completedDiscovery);
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
    addDiscoveredAssets(pendingDiscovery, allowPartial);
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
      setResults(executionPlan.map((item) => planItemToDisplay(item, selectedNetwork.nativeCurrency)));

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
        resultToDisplay(
          executionPlan[index],
          result,
          selectedNetwork.nativeCurrency,
          (hash) => getEvmExplorerUrl(hash, selectedNetwork)
        )
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
    balanceRequestRef.current += 1;
    tokenRecognitionRequestRef.current += 1;
    planRef.current = [];
    setErc20AssetInput("");
    setNftAssetInputs({ erc721: "", erc1155: "" });
    setDiscoveryContract("");
    setDiscoverySourceInput("");
    setSourceInputMode("readonly");
    setPendingDiscovery(null);
    setContractInspection(null);
    setDiscoveryIssues([]);
    setDiscoveryMessage("");
    setNftStandard("erc721");
    setNftInputResetNonce((current) => current + 1);
    setTargetAddress("");
    setMaxFeeAmount("0.01");
    setResults([]);
    setAddressBalances(emptyAddressBalanceState);
    setTokenRecognition(emptyTokenRecognitionState);
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
      stickyActions
      status={workbenchStatus}
      statusLabel={evmStatusLabels[workbenchStatus]}
      title={fixedStandard === "erc20" ? "EVM 代币归集" : "EVM NFT 归集"}
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
            {fixedStandard === "erc20" ? (
              <SecretKeyInput
                disabled={controlsLocked || assetImporting}
                mode="evm"
                onDirty={(reason, address) => {
                  setKeysCleared(false);
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
              />
            ) : null}

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
                  </TabsContent>
                </Tabs>
              </>
            ) : null}

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
                  autoOnly={standard === "erc721"}
                  autoDiscovery={standard === "erc721" ? (
                    <section aria-labelledby="nft-discovery-title" className="nft-discovery-card">
                      <div className="nft-discovery-card__bar">
                        <h4 id="nft-discovery-title">自动识别</h4>
                        <Button
                          disabled={controlsLocked || !discoveryContractIsValid || !discoverySourceReady}
                          onClick={() => void discoverOwnedErc721()}
                          size="sm"
                          type="button"
                        >
                          {discoveryRunning ? "正在识别" : "识别持仓"}
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

              </>
            )}

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
              <Field>
                <FieldLabel htmlFor="evm-collection-rpc">RPC</FieldLabel>
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
            </div>

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

            <EvmGasSettings
              disabled={controlsLocked}
              gas={gas}
              onSettingsChange={() => invalidatePlan()}
            />

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

        <ReviewPanel
          autoOpen={reviewShouldOpen}
          className="collection-results-panel"
          stateKey={`${stage}:${reviewHasRisk ? "risk" : "safe"}:${hasSubmittedHash ? "submitted" : "local"}`}
          summary={<Badge variant={reviewHasRisk ? "destructive" : "outline"}>{reviewSummaryLabel}</Badge>}
          title="预检与结果"
        >
          <CollectionResults
            embedded
            emptyMessage="预检后显示资产与交易。"
            emptyTitle="等待预检"
            exportFilename={currentToolId + "-results.csv"}
            results={results}
            title={fixedStandard === "nft"
              ? "NFT 归集结果"
              : standard === "native"
                ? `${selectedNetwork.nativeCurrency.symbol} 归集结果`
                : "ERC20 归集结果"}
          />
        </ReviewPanel>
      </div>
    </ToolPageLayout>
  );
}
