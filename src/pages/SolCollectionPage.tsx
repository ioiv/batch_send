import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  SecretKeyInput,
  type SecretKeyInputHandle,
  type WalletExecutionItem
} from "../components/SecretKeyInput";
import { SearchableSelect, type SearchableSelectOption } from "../components/SearchableSelect";
import { ToolPageLayout, type WorkbenchStatus } from "../components/ToolPageLayout";
import { CollectionResults } from "../components/CollectionResults";
import {
  AdvancedSettings,
  CollectionExecutionControls,
  ConfirmActionDialog,
  ReviewPanel,
  WorkbenchPanel
} from "../components/WorkbenchPrimitives";
import { formatLamports, formatLamportsForDisplay, parseSolToLamports } from "../lib/amount";
import type { CollectionAmountPolicy } from "../lib/collection-amount";
import { CollectionPauseController } from "../lib/collection-execution";
import {
  sanitizeRoundArchiveText,
  type CollectionDisplayResult,
  type CollectionResultStatus
} from "../lib/collection-results";
import {
  validateSolCollectionWorkload,
  validateSolTokenCollectionWorkload
} from "../lib/collection-workload";
import { getPreferredRpcEndpoint, isRpcEndpoint, rememberRpcEndpoint } from "../lib/rpc-preferences";
import {
  collectSolFromSources,
  parseSolanaSourceKeys,
  type SolCollectionItemResult,
  type SolCollectionProgress,
  type SolCollectionSource
} from "../lib/sol-collection";
import {
  collectSolTokenJobs,
  createSolTokenCollectionJobs,
  discoverSolanaHoldings,
  formatSolTokenAmount,
  inspectSolTokenMints,
  type SolanaHoldingsResult,
  type SolTokenAssetHolding,
  type SolTokenCollectionJob,
  type SolTokenCollectionProgress,
  type SolTokenCollectionResult,
  type SolTokenMintInspection
} from "../lib/sol-token-collection";
import {
  assertSolanaRpcNetwork,
  getExplorerUrl,
  getNetworkConfig,
  solanaNetworks,
  type SolanaNetworkId
} from "../lib/solana";

type CollectionStage = "checking" | "complete" | "editing" | "error" | "ready" | "running";
type AmountMode = CollectionAmountPolicy["mode"];
type SolCollectionAssetMode = "native" | "spl";
type SolHoldingsStatus = "error" | "idle" | "loading" | "ready";
type SolTokenRecognitionState = {
  items: SolTokenMintInspection[];
  message: string;
  status: "error" | "idle" | "loading" | "ready";
};

type ArchivedSolCollectionRound = {
  message: string;
  requiresAcknowledgement: boolean;
  results: CollectionDisplayResult[];
  sequence: number;
};

export function getSolCollectionWorkbenchStatus(
  stage: CollectionStage,
  results: readonly CollectionDisplayResult[]
): WorkbenchStatus {
  const hasFailure = results.some((result) => result.status === "error");
  const hasUncertain = results.some((result) => (
    result.uncertain || (result.status === "error" && Boolean(result.hash) && result.retryable !== true)
  ));
  if (stage === "checking") return "preflight";
  if (stage === "ready") return "ready";
  if (stage === "running") return "running";
  if (stage === "error") return hasUncertain ? "uncertain" : "error";
  if (stage === "complete") {
    if (hasUncertain) return "uncertain";
    return hasFailure ? "error" : "success";
  }
  return "editing";
}

const solStatusLabels: Record<WorkbenchStatus, string> = {
  editing: "编辑中",
  error: "需要处理",
  preflight: "检查中",
  ready: "等待确认",
  running: "执行中",
  success: "已完成",
  uncertain: "部分交易需核对"
};

const amountModeLabels: Record<AmountMode, string> = {
  all: "全部数量",
  fixed: "固定数量",
  percentage: "百分比数量",
  random: "随机数量"
};

const maximumSolTokenMintInputEntries = 1_000;
const maximumSolTokenMintAddressLength = 64;
const maximumAutomaticSolTokenMetadata = 50;
const emptySolTokenRecognitionState: SolTokenRecognitionState = {
  items: [],
  message: "",
  status: "idle"
};

function validatePublicKey(value: string) {
  if (value.length > maximumSolTokenMintAddressLength) return "";
  try {
    return new PublicKey(value).toBase58();
  } catch {
    return "";
  }
}

function parsePercentageBps(value: string) {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const bps = BigInt(match[1]) * 100n + BigInt((match[2] || "").padEnd(2, "0"));
  return bps > 0n && bps <= 10_000n ? bps : null;
}

function itemToDisplay(item: SolCollectionItemResult, networkId: SolanaNetworkId): CollectionDisplayResult {
  return {
    address: item.address,
    amount: item.transferLamports > 0n ? formatLamports(item.transferLamports) : "0",
    asset: "SOL",
    ...(item.signature ? {
      explorerUrl: getExplorerUrl(item.signature, networkId),
      hash: item.signature
    } : {}),
    label: item.label,
    message: item.message,
    retryable: item.status === "error" && item.retryable,
    status: item.status === "success" ? "success" : item.status === "skipped" ? "skipped" : "error",
    uncertain: item.status === "error" && Boolean(item.signature) && !item.retryable
  };
}

function shortenSolanaAddress(value: string) {
  return value.length > 18 ? `${value.slice(0, 6)}…${value.slice(-6)}` : value;
}

type ParsedSolTokenMintRow = {
  line: number;
  mintAddress: string | null;
  problem?: string;
  status: "duplicate" | "empty" | "invalid" | "valid";
  value: string;
};

function parseSolTokenMintInput(input: string) {
  const rows: ParsedSolTokenMintRow[] = [];
  const mintAddresses: string[] = [];
  const seen = new Map<string, number>();
  const inputValues = input.split(/\r?\n/);
  const limitIssue = inputValues.length > maximumSolTokenMintInputEntries
    ? `Token 清单一次最多 ${maximumSolTokenMintInputEntries} 行，请拆分任务`
    : "";
  const values = inputValues.slice(0, maximumSolTokenMintInputEntries);

  (values.length ? values : [""]).forEach((rawValue, index) => {
    const value = rawValue.trim();
    if (!value) {
      rows.push({ line: index + 1, mintAddress: null, status: "empty", value: rawValue });
      return;
    }
    const mintAddress = validatePublicKey(value);
    if (!mintAddress) {
      rows.push({
        line: index + 1,
        mintAddress: null,
        problem: value.length > maximumSolTokenMintAddressLength ? "Mint 地址过长" : "Mint 地址无效",
        status: "invalid",
        value: rawValue
      });
      return;
    }
    const originalLine = seen.get(mintAddress);
    if (originalLine !== undefined) {
      rows.push({
        line: index + 1,
        mintAddress,
        problem: `与第 ${originalLine} 行重复`,
        status: "duplicate",
        value: rawValue
      });
      return;
    }
    seen.set(mintAddress, index + 1);
    mintAddresses.push(mintAddress);
    rows.push({ line: index + 1, mintAddress, status: "valid", value: rawValue });
  });

  return {
    limitIssue,
    mintAddresses,
    rows,
    valid: !limitIssue && rows.every((row) => row.status === "empty" || row.status === "valid")
  };
}

function scopeSolanaHoldings(
  result: SolanaHoldingsResult,
  mintAddresses: readonly string[]
): SolanaHoldingsResult {
  const selected = new Set(mintAddresses);
  const holdings = result.holdings.filter((holding) => selected.has(holding.mintAddress));
  const wallets = result.wallets.map((wallet) => ({
    ...wallet,
    tokenAccounts: wallet.tokenAccounts.filter((holding) => selected.has(holding.mintAddress))
  }));
  return {
    ...result,
    holdings,
    readyTokenAccountCount: holdings.filter((holding) => holding.status === "ready").length,
    tokenAccountCount: holdings.length,
    wallets
  };
}

function solTokenAssetKey(holding: Pick<SolTokenAssetHolding, "mintAddress" | "programId">) {
  return `${holding.programId}:${holding.mintAddress}`;
}

function solTokenAssetLabel({
  mintAddress,
  program
}: Pick<SolTokenAssetHolding, "mintAddress" | "program">) {
  return `${program === "token-2022" ? "Token-2022" : "SPL"} ${shortenSolanaAddress(mintAddress)}`;
}

function solTokenExecutionLabel({
  mintAddress,
  program,
  sourceTokenAccount
}: Pick<SolTokenCollectionJob, "mintAddress" | "program" | "sourceTokenAccount">) {
  return `${solTokenAssetLabel({ mintAddress, program })} · 账户 ${shortenSolanaAddress(sourceTokenAccount)}`;
}

function buildSolWalletBalances(holdings: SolanaHoldingsResult | null) {
  const rows: Record<string, Array<{ amount: string; contractAddress?: string; symbol: string }>> = {};
  holdings?.wallets.forEach((wallet) => {
    const balances: Array<{ amount: string; contractAddress?: string; symbol: string }> = [{
      amount: wallet.nativeBalanceLamports === null
        ? "读取失败"
        : formatLamportsForDisplay(wallet.nativeBalanceLamports, 4),
      symbol: "SOL"
    }];
    const grouped = new Map<string, { amount: bigint; decimals: number | null; holding: SolTokenAssetHolding }>();
    wallet.tokenAccounts.forEach((holding) => {
      const key = solTokenAssetKey(holding);
      const current = grouped.get(key) || { amount: 0n, decimals: holding.decimals, holding };
      current.amount += holding.amount;
      if (current.decimals === null && holding.decimals !== null) current.decimals = holding.decimals;
      grouped.set(key, current);
    });
    [...grouped.entries()].slice(0, 8).forEach(([key, entry]) => balances.push({
      amount: entry.decimals === null
        ? `${entry.amount.toString()} 原始单位`
        : formatSolTokenAmount(entry.amount, entry.decimals),
      contractAddress: key,
      symbol: solTokenAssetLabel(entry.holding)
    }));
    if (grouped.size > 8) balances.push({
      amount: `+${grouped.size - 8}`,
      contractAddress: "additional-sol-token-holdings",
      symbol: "更多清单内 Token"
    });
    rows[wallet.address.toLowerCase()] = balances;
  });
  return rows;
}

function solTokenItemToDisplay(
  item: SolTokenCollectionResult,
  job: SolTokenCollectionJob,
  networkId: SolanaNetworkId
): CollectionDisplayResult {
  const feeSuffix = item.status === "success" && item.transferFeeAmount > 0n
    ? `；预计到账 ${formatSolTokenAmount(item.receivedAmount, job.decimals)}，Token 费 ${formatSolTokenAmount(item.transferFeeAmount, job.decimals)}`
    : "";
  return {
    address: item.sourceAddress,
    amount: formatSolTokenAmount(item.amount, job.decimals),
    asset: solTokenExecutionLabel({
      mintAddress: item.mintAddress,
      program: item.program,
      sourceTokenAccount: item.sourceTokenAccount
    }),
    assetKey: `${item.programId}:${item.mintAddress}`,
    executionId: item.id,
    ...(item.signature ? {
      explorerUrl: getExplorerUrl(item.signature, networkId),
      hash: item.signature
    } : {}),
    label: job.source.label,
    message: `${item.message}${feeSuffix}`,
    retryable: item.status === "error" && item.retryable,
    status: item.status === "success" ? "success" : item.status === "skipped" ? "skipped" : "error",
    uncertain: item.uncertain
  };
}

function unavailableSolTokenHoldingToDisplay(
  holding: SolTokenAssetHolding
): CollectionDisplayResult {
  return {
    address: holding.sourceAddress,
    amount: holding.decimals === null
      ? `${holding.amount.toString()} 原始单位`
      : formatSolTokenAmount(holding.amount, holding.decimals),
    asset: `${solTokenAssetLabel(holding)} · 账户 ${shortenSolanaAddress(holding.sourceTokenAccount)}`,
    assetKey: `${holding.programId}:${holding.mintAddress}`,
    executionId: holding.id,
    label: holding.label,
    message: holding.unsupportedReason || "Mint 信息未验证，未加入归集计划",
    retryable: false,
    status: "error",
    uncertain: false
  };
}

function progressStatus(phase: SolCollectionProgress["phase"]): CollectionResultStatus {
  if (phase === "preparing") return "scanning";
  if (phase === "submitted") return "confirming";
  if (phase === "success") return "success";
  if (phase === "skipped") return "skipped";
  return "error";
}

function solTokenProgressStatus(phase: SolTokenCollectionProgress["phase"]): CollectionResultStatus {
  if (phase === "preparing") return "scanning";
  if (phase === "submitted") return "confirming";
  if (phase === "success") return "success";
  if (phase === "skipped") return "skipped";
  return "error";
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

export function SolCollectionPage() {
  const initialNetworkId: SolanaNetworkId = "mainnet-beta";
  const [networkId, setNetworkId] = useState<SolanaNetworkId>(initialNetworkId);
  const [rpcEndpoint, setRpcEndpoint] = useState(() => getPreferredRpcEndpoint(
    "solana",
    initialNetworkId,
    getNetworkConfig(initialNetworkId).endpoint
  ));
  const [tokenMintInput, setTokenMintInput] = useState("");
  const [tokenMintInputMessage, setTokenMintInputMessage] = useState("");
  const [tokenRecognition, setTokenRecognition] = useState<SolTokenRecognitionState>(
    emptySolTokenRecognitionState
  );
  const [targetAddress, setTargetAddress] = useState("");
  const [amountMode, setAmountMode] = useState<AmountMode>("all");
  const [percentageAmount, setPercentageAmount] = useState("100");
  const [fixedAmount, setFixedAmount] = useState("0.1");
  const [randomMinimum, setRandomMinimum] = useState("0.01");
  const [randomMaximum, setRandomMaximum] = useState("0.1");
  const [reserveAmount, setReserveAmount] = useState("0");
  const [minimumAmount, setMinimumAmount] = useState("0");
  const [concurrency, setConcurrency] = useState("3");
  const [minimumDelay, setMinimumDelay] = useState("0");
  const [maximumDelay, setMaximumDelay] = useState("0");
  const [sourceCount, setSourceCount] = useState(0);
  const [stage, setStage] = useState<CollectionStage>("editing");
  const [paused, setPaused] = useState(false);
  const [message, setMessage] = useState("");
  const [issues, setIssues] = useState<string[]>([]);
  const [results, setResults] = useState<CollectionDisplayResult[]>([]);
  const [archivedRound, setArchivedRound] = useState<ArchivedSolCollectionRound | null>(null);
  const [roundSequence, setRoundSequence] = useState(1);
  const [keyImporting, setKeyImporting] = useState(false);
  const [holdings, setHoldings] = useState<SolanaHoldingsResult | null>(null);
  const [holdingsStatus, setHoldingsStatus] = useState<SolHoldingsStatus>("idle");
  const [holdingsMessage, setHoldingsMessage] = useState("");
  const [holdingsIssues, setHoldingsIssues] = useState<string[]>([]);
  const keyInputRef = useRef<SecretKeyInputHandle>(null);
  const keyImportingRef = useRef(false);
  const holdingsRequestRef = useRef(0);
  const tokenRecognitionRequestRef = useRef(0);
  const tokenMetadataCacheRef = useRef(new Map<string, SolTokenMintInspection>());
  const operationRef = useRef(false);
  const pauseControllerRef = useRef(new CollectionPauseController());
  const retrySourcesRef = useRef<SolCollectionSource[]>([]);
  const retryTokenJobsRef = useRef<SolTokenCollectionJob[]>([]);
  const selectedNetwork = getNetworkConfig(networkId);
  const parsedTokenMints = useMemo(() => parseSolTokenMintInput(tokenMintInput), [tokenMintInput]);
  const tokenInputRows = useMemo(
    () => parsedTokenMints.rows.map((row) => row.value),
    [parsedTokenMints]
  );
  const assetMode: SolCollectionAssetMode = tokenMintInput.trim() ? "spl" : "native";
  const normalizedTarget = validatePublicKey(targetAddress.trim());
  const taskRunning = stage === "running";
  const running = taskRunning || keyImporting;
  const hasSubmittedHash = results.some((result) => Boolean(result.hash));
  const hasRecordedHash = hasSubmittedHash || Boolean(archivedRound?.results.some((result) => result.hash));
  const controlsLocked = running;
  const workbenchStatus = getSolCollectionWorkbenchStatus(stage, results);
  const completedResultCount = results.filter((result) => (
    result.status === "success" || result.status === "error" || result.status === "skipped"
  )).length;
  const retryableCount = retrySourcesRef.current.length + retryTokenJobsRef.current.length;
  const walletStatuses = useMemo(() => groupWalletStatuses(results), [results]);
  const walletBalances = useMemo(() => buildSolWalletBalances(holdings), [holdings]);
  const recognizedTokenByMint = useMemo(() => new Map(
    tokenRecognition.items.map((item) => [item.mintAddress, item] as const)
  ), [tokenRecognition.items]);

  const networkOptions = useMemo<SearchableSelectOption<SolanaNetworkId>[]>(() => (
    solanaNetworks.map((network) => ({
      keywords: [network.id, "Solana"],
      label: network.label,
      meta: network.id,
      value: network.id
    }))
  ), []);

  const handleKeyImportingChange = useCallback((importing: boolean) => {
    keyImportingRef.current = importing;
    setKeyImporting(importing);
  }, []);

  const invalidateHoldings = useCallback(() => {
    holdingsRequestRef.current += 1;
    setHoldings(null);
    setHoldingsStatus("idle");
    setHoldingsMessage("");
    setHoldingsIssues([]);
  }, []);

  const expireHoldingsSnapshot = useCallback(() => {
    holdingsRequestRef.current += 1;
    setHoldings(null);
    setHoldingsStatus("idle");
    setHoldingsIssues([]);
    setHoldingsMessage("余额快照已因执行而失效；可再次查看，下一轮执行仍会即时重读");
  }, []);

  useEffect(() => {
    const discardSigningMaterial = () => {
      retrySourcesRef.current = [];
      retryTokenJobsRef.current = [];
      holdingsRequestRef.current += 1;
    };
    const resetRestoredPage = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      retrySourcesRef.current = [];
      retryTokenJobsRef.current = [];
      holdingsRequestRef.current += 1;
      setHoldings(null);
      setHoldingsStatus("idle");
      setHoldingsMessage("");
      setHoldingsIssues([]);
      setResults([]);
      setIssues([]);
      setMessage("页面从历史记录恢复，来源密钥已按安全策略清除，请重新导入");
      setStage("editing");
    };
    window.addEventListener("pagehide", discardSigningMaterial);
    window.addEventListener("pageshow", resetRestoredPage);
    return () => {
      holdingsRequestRef.current += 1;
      window.removeEventListener("pagehide", discardSigningMaterial);
      window.removeEventListener("pageshow", resetRestoredPage);
      pauseControllerRef.current.resume();
    };
  }, []);

  useEffect(() => {
    if (!tokenMintInput.trim()) {
      tokenRecognitionRequestRef.current += 1;
      setTokenRecognition(emptySolTokenRecognitionState);
      return;
    }
    if (!parsedTokenMints.mintAddresses.length || !isRpcEndpoint(rpcEndpoint)) {
      tokenRecognitionRequestRef.current += 1;
      setTokenRecognition({
        items: [],
        message: parsedTokenMints.rows.some((row) => row.status === "invalid")
          ? "Token 清单包含无效 Mint 地址"
          : "请先填写有效 RPC 地址",
        status: "error"
      });
      return;
    }

    const limitedMints = parsedTokenMints.mintAddresses.slice(0, maximumAutomaticSolTokenMetadata);
    const recognitionScope = `${networkId}:${rpcEndpoint.trim()}`;
    const getCacheKey = (mintAddress: string) => `${recognitionScope}:${mintAddress}`;
    const cachedItems = limitedMints.flatMap((mintAddress) => {
      const cached = tokenMetadataCacheRef.current.get(getCacheKey(mintAddress));
      return cached ? [cached] : [];
    });
    const missingMints = limitedMints.filter(
      (mintAddress) => !tokenMetadataCacheRef.current.has(getCacheKey(mintAddress))
    );
    const describeItems = (items: readonly SolTokenMintInspection[]) => {
      const failed = items.filter((item) => item.status === "unverified").length;
      const unsupported = items.filter((item) => item.status === "unsupported").length;
      if (parsedTokenMints.mintAddresses.length > limitedMints.length) {
        return `已自动识别前 ${limitedMints.length} 个 Token；其余将在执行时验证`;
      }
      if (failed || unsupported) {
        return `${items.length - failed - unsupported} 个可归集，${unsupported} 个不支持，${failed} 个识别失败`;
      }
      return `${items.length} 个 Token 已识别`;
    };

    if (!missingMints.length) {
      tokenRecognitionRequestRef.current += 1;
      setTokenRecognition({
        items: cachedItems,
        message: describeItems(cachedItems),
        status: cachedItems.some((item) => item.status === "unverified") ? "error" : "ready"
      });
      return;
    }

    const requestId = tokenRecognitionRequestRef.current + 1;
    tokenRecognitionRequestRef.current = requestId;
    setTokenRecognition({
      items: cachedItems,
      message: `正在识别 ${missingMints.length} 个新 Token…`,
      status: "loading"
    });
    const timeoutId = window.setTimeout(() => {
      void (async () => {
        try {
          const connection = new Connection(rpcEndpoint.trim(), "confirmed");
          await assertSolanaRpcNetwork(connection, networkId);
          const fetchedItems = await inspectSolTokenMints({
            connection,
            mintAddresses: missingMints
          });
          if (tokenRecognitionRequestRef.current !== requestId) return;
          fetchedItems.forEach((item) => {
            if (item.status !== "unverified") {
              tokenMetadataCacheRef.current.set(getCacheKey(item.mintAddress), item);
            }
          });
          const fetchedByMint = new Map(
            fetchedItems.map((item) => [item.mintAddress, item] as const)
          );
          const items = limitedMints.flatMap((mintAddress) => {
            const item = tokenMetadataCacheRef.current.get(getCacheKey(mintAddress))
              || fetchedByMint.get(mintAddress);
            return item ? [item] : [];
          });
          setTokenRecognition({
            items,
            message: describeItems(items),
            status: items.some((item) => item.status === "unverified") ? "error" : "ready"
          });
        } catch {
          if (tokenRecognitionRequestRef.current !== requestId) return;
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
  }, [networkId, parsedTokenMints, rpcEndpoint, tokenMintInput]);

  const handlePausedChange = (nextPaused: boolean) => {
    if (!taskRunning) return;
    if (nextPaused) pauseControllerRef.current.pause();
    else pauseControllerRef.current.resume();
    setPaused(nextPaused);
    setMessage(nextPaused
      ? "已请求暂停：当前正在提交或确认的交易会安全完成，之后不再启动新的钱包"
      : "已继续归集，正在启动后续钱包");
  };

  const archiveCurrentRound = () => {
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
    retrySourcesRef.current = [];
    retryTokenJobsRef.current = [];
    setResults([]);
    setRoundSequence((current) => current + 1);
    setStage("editing");
    return true;
  };

  const invalidateTask = (clearResults = true) => {
    if (operationRef.current || taskRunning) return;
    const archived = archiveCurrentRound();
    retrySourcesRef.current = [];
    retryTokenJobsRef.current = [];
    setStage("editing");
    setMessage("");
    setIssues([]);
    if (clearResults && !archived) setResults([]);
  };

  const updateTokenMintRows = (rows: string[]) => {
    if (rows.length > maximumSolTokenMintInputEntries) {
      setTokenMintInputMessage(`Token 清单一次最多 ${maximumSolTokenMintInputEntries} 行，本次修改未应用`);
      return;
    }
    if (rows.some((row) => row.trim().length > maximumSolTokenMintAddressLength)) {
      setTokenMintInputMessage(`Mint 地址最多 ${maximumSolTokenMintAddressLength} 个字符，本次修改未应用`);
      return;
    }
    setTokenMintInputMessage("");
    setTokenMintInput(rows.length ? rows.join("\n") : "");
    invalidateTask();
    invalidateHoldings();
  };

  const getAmountPolicy = (): CollectionAmountPolicy | null => {
    if (amountMode === "all") return { mode: "all" };
    if (amountMode === "percentage") {
      const percentageBps = parsePercentageBps(percentageAmount);
      return percentageBps === null ? null : { mode: "percentage", percentageBps };
    }
    if (amountMode === "fixed") {
      const amount = parseSolToLamports(fixedAmount);
      return amount && amount > 0n ? { amount, mode: "fixed" } : null;
    }
    const minAmount = parseSolToLamports(randomMinimum);
    const maxAmount = parseSolToLamports(randomMaximum);
    return minAmount && maxAmount && minAmount > 0n && maxAmount >= minAmount
      ? { maxAmount, minAmount, mode: "random" }
      : null;
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

  const discoverHoldings = async () => {
    if (operationRef.current || keyImportingRef.current || running) return;
    const parsedSources = parseSolanaSourceKeys(keyInputRef.current?.read() || "");
    const nextIssues: string[] = [];
    if (!isRpcEndpoint(rpcEndpoint)) nextIssues.push("请输入以 http:// 或 https:// 开头的有效 RPC 地址");
    if (!parsedSources.sources.length) nextIssues.push("请勾选至少一个有效的来源钱包");
    parsedSources.errors.forEach((error) => nextIssues.push(error.message));
    parsedSources.duplicates.forEach((duplicate) => (
      nextIssues.push(`密钥第 ${duplicate.duplicateLine} 行与第 ${duplicate.originalLine} 行地址重复`)
    ));
    parsedTokenMints.rows.forEach((row) => {
      if (row.status === "invalid" || row.status === "duplicate") {
        nextIssues.push(`Token 清单第 ${row.line} 行：${row.problem}`);
      }
    });
    if (parsedTokenMints.limitIssue) nextIssues.push(parsedTokenMints.limitIssue);
    nextIssues.push(...(assetMode === "spl"
      ? validateSolTokenCollectionWorkload(parsedSources.sources.length, parsedTokenMints.mintAddresses.length)
      : validateSolCollectionWorkload(parsedSources.sources.length)));
    if (nextIssues.length) {
      setHoldings(null);
      setHoldingsStatus("error");
      setHoldingsIssues(nextIssues);
      setHoldingsMessage("请先修正来源钱包或 RPC 设置");
      return;
    }

    invalidateTask();
    const requestId = holdingsRequestRef.current + 1;
    holdingsRequestRef.current = requestId;
    setHoldings(null);
    setHoldingsStatus("loading");
    setHoldingsIssues([]);
    setHoldingsMessage(assetMode === "spl"
      ? `正在读取 ${parsedSources.sources.length} 个钱包的 SOL 与清单内 SPL Token…`
      : `正在读取 ${parsedSources.sources.length} 个钱包的 SOL 余额…`);
    try {
      const connection = new Connection(rpcEndpoint.trim(), "confirmed");
      await assertSolanaRpcNetwork(connection, networkId);
      const discovered = scopeSolanaHoldings(await discoverSolanaHoldings({
        connection,
        mintAddresses: parsedTokenMints.mintAddresses,
        sources: parsedSources.sources
      }), parsedTokenMints.mintAddresses);
      if (holdingsRequestRef.current !== requestId) return;
      setHoldings(discovered);
      setHoldingsStatus("ready");
      setHoldingsIssues([
        ...discovered.issues,
        ...[...new Set(discovered.holdings
          .filter((holding) => holding.status !== "ready")
          .map((holding) => (
            `${shortenSolanaAddress(holding.mintAddress)}：${holding.unsupportedReason || "Mint 信息未验证"}`
          )))]
      ]);
      setHoldingsMessage(assetMode === "spl"
        ? `已读取 ${discovered.wallets.length} 个钱包：清单内发现 ${discovered.tokenAccountCount} 个非零 Token 账户，`
          + `${discovered.readyTokenAccountCount} 个可归集`
          + (!discovered.tokenInventoryComplete
            ? "；Token 持仓清单不完整，当前结果仅供展示"
            : discovered.partial ? "；部分原生余额读取失败或资产仅供展示" : "")
        : `已读取 ${discovered.wallets.length} 个钱包的 SOL 余额`
          + (discovered.partial ? "；部分余额读取失败" : ""));
    } catch (error) {
      if (holdingsRequestRef.current !== requestId) return;
      setHoldings(null);
      setHoldingsStatus("error");
      setHoldingsIssues([]);
      setHoldingsMessage(error instanceof Error && error.message.includes("RPC 网络不匹配")
        ? error.message
        : "持仓识别失败，请检查 RPC 后重试；未签名或提交任何交易");
    }
  };

  const validateAndReadSources = () => {
    const nextIssues: string[] = [];
    if (!normalizedTarget) nextIssues.push("目标地址不是有效的 Solana 地址");
    if (assetMode === "spl" && normalizedTarget
      && !PublicKey.isOnCurve(new PublicKey(normalizedTarget).toBytes())) {
      nextIssues.push("SPL Token 归集目标必须是可签名的钱包地址");
    }
    if (!isRpcEndpoint(rpcEndpoint)) nextIssues.push("请输入以 http:// 或 https:// 开头的有效 RPC 地址");
    const amountPolicy = assetMode === "native" ? getAmountPolicy() : { mode: "all" } as const;
    if (assetMode === "native" && !amountPolicy) nextIssues.push("归集数量设置无效，请检查当前数量模式");
    const reserveLamports = assetMode === "native"
      ? reserveAmount.trim() === "0" ? 0n : parseSolToLamports(reserveAmount)
      : 0n;
    const minCollectionLamports = assetMode === "native"
      ? minimumAmount.trim() === "0" ? 0n : parseSolToLamports(minimumAmount)
      : 0n;
    if (assetMode === "native" && reserveLamports === null) {
      nextIssues.push("保留金额需要是 0 或最多 9 位小数的正数");
    }
    if (assetMode === "native" && minCollectionLamports === null) {
      nextIssues.push("最小归集金额需要是 0 或最多 9 位小数的正数");
    }
    const executionSettings = getExecutionSettings();
    if (!executionSettings) nextIssues.push("并发需要为 1–20，随机延迟需要为 0–300 秒且最大值不小于最小值");
    const parsedSources = parseSolanaSourceKeys(keyInputRef.current?.read() || "");
    if (!parsedSources.sources.length) nextIssues.push("请勾选至少一个有效的来源钱包");
    parsedSources.errors.forEach((error) => nextIssues.push(error.message));
    parsedSources.duplicates.forEach((duplicate) => (
      nextIssues.push(`密钥第 ${duplicate.duplicateLine} 行与第 ${duplicate.originalLine} 行地址重复`)
    ));
    parsedTokenMints.rows.forEach((row) => {
      if (row.status === "invalid" || row.status === "duplicate") {
        nextIssues.push(`Token 清单第 ${row.line} 行：${row.problem}`);
      }
    });
    if (parsedTokenMints.limitIssue) nextIssues.push(parsedTokenMints.limitIssue);
    nextIssues.push(...(assetMode === "spl"
      ? validateSolTokenCollectionWorkload(parsedSources.sources.length, parsedTokenMints.mintAddresses.length)
      : validateSolCollectionWorkload(parsedSources.sources.length)));
    if (assetMode === "spl" && !parsedTokenMints.mintAddresses.length) {
      nextIssues.push("请至少填写一个有效的 SPL Token Mint 地址");
    }
    return {
      amountPolicy,
      executionSettings,
      issues: nextIssues,
      minCollectionLamports,
      parsedTokenMints,
      parsedSources,
      reserveLamports
    };
  };

  const executeNativeCollection = async (retryOnly = false) => {
    if (operationRef.current || keyImportingRef.current || running) return;
    const prepared = validateAndReadSources();
    const sources = retryOnly ? retrySourcesRef.current : prepared.parsedSources.sources;
    if (prepared.issues.length || prepared.amountPolicy === null || prepared.executionSettings === null
      || prepared.reserveLamports === null || prepared.minCollectionLamports === null || !sources.length) {
      setIssues(prepared.issues.length ? prepared.issues : ["没有可重试的失败钱包"]);
      setStage("error");
      setMessage("请修正设置后再执行，当前钱包与配置均已保留");
      return;
    }

    operationRef.current = true;
    pauseControllerRef.current.resume();
    setPaused(false);
    retrySourcesRef.current = [];
    retryTokenJobsRef.current = [];
    setIssues([]);
    setStage("running");
    setMessage(retryOnly
      ? `正在重试 ${sources.length} 个失败钱包`
      : `已确认，正在按并发 ${prepared.executionSettings.concurrency} 执行；余额与费用会在每笔发送前即时读取`);
    const initial = sources.map((source): CollectionDisplayResult => ({
      address: source.address,
      amount: "—",
      asset: "SOL",
      label: source.label,
      message: retryOnly ? "等待重试" : "等待执行",
      status: "pending"
    }));
    setResults((current) => retryOnly
      ? current.map((result) => initial.find((item) => item.address === result.address) || result)
      : initial);

    const connection = new Connection(rpcEndpoint.trim(), "confirmed");
    const submittedAddresses = new Set<string>();
    try {
      await assertSolanaRpcNetwork(connection, networkId);
      const updateProgress = (progress: SolCollectionProgress) => {
        if (progress.signature) submittedAddresses.add(progress.address);
        setResults((current) => current.map((result) => {
          if (result.address !== progress.address) return result;
          return {
            ...result,
            amount: progress.transferLamports > 0n ? formatLamports(progress.transferLamports) : result.amount,
            ...(progress.signature ? {
              explorerUrl: getExplorerUrl(progress.signature, networkId),
              hash: progress.signature
            } : {}),
            message: progress.phase === "preparing"
              ? "正在读取余额并估算手续费"
              : progress.phase === "submitted"
                ? "交易已提交，正在等待链上确认"
                : progress.phase === "success"
                  ? "归集成功"
                  : progress.phase === "skipped"
                    ? "该来源已跳过"
                    : "处理失败，请查看具体原因",
            status: progressStatus(progress.phase)
          };
        }));
      };
      const collectionResults = await collectSolFromSources({
        amountPolicy: prepared.amountPolicy,
        connection,
        destination: normalizedTarget,
        executionSettings: prepared.executionSettings,
        minCollectionLamports: prepared.minCollectionLamports,
        onProgress: updateProgress,
        pauseControl: pauseControllerRef.current,
        reserveLamports: prepared.reserveLamports,
        sources
      });
      const displayResults = collectionResults.map((item) => itemToDisplay(item, networkId));
      setResults((current) => retryOnly
        ? current.map((result) => displayResults.find((item) => item.address === result.address) || result)
        : displayResults);
      const retryableAddresses = new Set(collectionResults
        .filter((item) => item.status === "error" && item.retryable)
        .map((item) => item.address));
      retrySourcesRef.current = sources.filter((source) => retryableAddresses.has(source.address));
      const success = collectionResults.filter((item) => item.status === "success").length;
      const skipped = collectionResults.filter((item) => item.status === "skipped").length;
      const failed = collectionResults.filter((item) => item.status === "error").length;
      setStage("complete");
      setMessage(`归集完成：${success} 笔成功，${skipped} 笔跳过${failed ? `，${failed} 笔失败` : ""}`
        + (retrySourcesRef.current.length ? `；${retrySourcesRef.current.length} 笔可直接重试` : ""));
    } catch (error) {
      retrySourcesRef.current = sources.filter((source) => !submittedAddresses.has(source.address));
      const sourceAddresses = new Set(sources.map((source) => source.address));
      setResults((current) => current.map((result) => {
        if (!sourceAddresses.has(result.address)) return result;
        const uncertain = submittedAddresses.has(result.address) || Boolean(result.hash);
        return {
          ...result,
          message: uncertain
            ? "交易已提交但确认状态不确定，请根据签名核对链上状态"
            : "执行在提交前中断，可安全重试",
          retryable: !uncertain,
          status: "error",
          uncertain
        };
      }));
      setStage("error");
      setMessage(error instanceof Error && error.message.includes("RPC 网络不匹配")
        ? error.message
        : "归集流程中断，钱包与设置均已保留，可直接重试；已显示签名的项目请先核对链上状态");
    } finally {
      expireHoldingsSnapshot();
      operationRef.current = false;
      pauseControllerRef.current.resume();
      setPaused(false);
    }
  };

  const executeTokenCollection = async (retryOnly = false) => {
    if (operationRef.current || keyImportingRef.current || running) return;
    const prepared = validateAndReadSources();
    let jobs = retryOnly ? retryTokenJobsRef.current : [];
    let nonExecutableResults: CollectionDisplayResult[] = [];
    if (prepared.issues.length || prepared.executionSettings === null || (retryOnly && !jobs.length)) {
      setIssues(prepared.issues.length ? prepared.issues : ["没有可重试的失败 Token 账户"]);
      setStage("error");
      setMessage("请修正设置后再执行，当前钱包与 Token 清单均已保留");
      return;
    }

    operationRef.current = true;
    pauseControllerRef.current.resume();
    setPaused(false);
    retrySourcesRef.current = [];
    retryTokenJobsRef.current = [];
    setIssues([]);
    setStage("running");
    setMessage(retryOnly
      ? `正在重试 ${jobs.length} 个失败 Token 账户`
      : `已确认，正在读取 ${prepared.parsedTokenMints.mintAddresses.length} 个 Token 的实时持仓并生成归集计划`);
    if (retryOnly) {
      const initial = jobs.map((job): CollectionDisplayResult => ({
        address: job.sourceAddress,
        amount: formatSolTokenAmount(job.amount, job.decimals),
        asset: solTokenExecutionLabel(job),
        assetKey: `${job.programId}:${job.mintAddress}`,
        executionId: job.id,
        label: job.source.label,
        message: "等待重试",
        status: "pending"
      }));
      setResults((current) => current.map((result) => (
        initial.find((item) => item.executionId === result.executionId) || result
      )));
    } else {
      setResults(prepared.parsedSources.sources.map((source): CollectionDisplayResult => ({
        address: source.address,
        amount: "—",
        asset: "SPL Token",
        label: source.label,
        message: "正在读取清单内 Token 余额",
        status: "scanning"
      })));
    }

    const connection = new Connection(rpcEndpoint.trim(), "confirmed");
    const submittedJobIds = new Set<string>();
    try {
      await assertSolanaRpcNetwork(connection, networkId);
      if (!retryOnly) {
        const scopedHoldings = scopeSolanaHoldings(await discoverSolanaHoldings({
          connection,
          mintAddresses: prepared.parsedTokenMints.mintAddresses,
          sources: prepared.parsedSources.sources
        }), prepared.parsedTokenMints.mintAddresses);
        if (!scopedHoldings.tokenInventoryComplete) {
          throw new Error("Token 持仓清单读取不完整，请更换或检查 RPC 后重试");
        }
        setHoldings(scopedHoldings);
        setHoldingsStatus("ready");
        setHoldingsIssues([
          ...scopedHoldings.issues,
          ...[...new Set(scopedHoldings.holdings
            .filter((holding) => holding.status !== "ready")
            .map((holding) => (
              `${shortenSolanaAddress(holding.mintAddress)}：${holding.unsupportedReason || "Mint 信息未验证"}`
            )))]
        ]);
        setHoldingsMessage(
          `已读取 ${scopedHoldings.wallets.length} 个钱包：清单内发现 ${scopedHoldings.tokenAccountCount} 个非零 Token 账户，`
          + `${scopedHoldings.readyTokenAccountCount} 个可归集`
        );
        nonExecutableResults = scopedHoldings.holdings
          .filter((holding) => holding.status !== "ready")
          .map(unavailableSolTokenHoldingToDisplay);
        const holdingIds = new Set(scopedHoldings.holdings
          .filter((holding) => holding.status === "ready")
          .map((holding) => holding.id));
        jobs = createSolTokenCollectionJobs({
          destination: normalizedTarget,
          holdings: scopedHoldings.holdings,
          selectedHoldingIds: holdingIds,
          sources: prepared.parsedSources.sources
        });
        if (!jobs.length) {
          setResults(nonExecutableResults);
          setStage("error");
          setMessage(nonExecutableResults.length
            ? "Token 清单内的非零持仓均不可归集，已逐项显示原因"
            : "Token 清单内没有可归集的非零余额");
          return;
        }
        setMessage(`已生成 ${jobs.length} 个 Token 账户任务；每笔都会重查余额、Mint、扩展、ATA、网络费和租金`);
        setResults([
          ...nonExecutableResults,
          ...jobs.map((job): CollectionDisplayResult => ({
            address: job.sourceAddress,
            amount: formatSolTokenAmount(job.amount, job.decimals),
            asset: solTokenExecutionLabel(job),
            assetKey: `${job.programId}:${job.mintAddress}`,
            executionId: job.id,
            label: job.source.label,
            message: "等待执行",
            status: "pending"
          }))
        ]);
      }
      const updateProgress = (progress: SolTokenCollectionProgress) => {
        if (progress.signature) submittedJobIds.add(progress.id);
        setResults((current) => current.map((result) => {
          if (result.executionId !== progress.id) return result;
          return {
            ...result,
            amount: progress.amount > 0n
              ? formatSolTokenAmount(progress.amount, progress.decimals)
              : result.amount,
            ...(progress.signature ? {
              explorerUrl: getExplorerUrl(progress.signature, networkId),
              hash: progress.signature
            } : {}),
            message: progress.phase === "preparing"
              ? "正在重查 Token 账户、Mint、目标 ATA 与原生 SOL 费用"
              : progress.phase === "submitted"
                ? "交易已提交，正在等待链上确认"
                : progress.phase === "success"
                  ? "归集成功"
                  : progress.phase === "skipped"
                    ? "该 Token 账户已安全跳过"
                    : "处理失败，请查看具体原因",
            status: solTokenProgressStatus(progress.phase)
          };
        }));
      };
      const collectionResults = await collectSolTokenJobs({
        connection,
        executionSettings: prepared.executionSettings,
        jobs,
        onProgress: updateProgress,
        pauseControl: pauseControllerRef.current
      });
      const jobsById = new Map(jobs.map((job) => [job.id, job]));
      const displayResults = collectionResults.map((item) => (
        solTokenItemToDisplay(item, jobsById.get(item.id) as SolTokenCollectionJob, networkId)
      ));
      setResults((current) => retryOnly
        ? current.map((result) => displayResults.find((item) => (
          item.executionId === result.executionId
        )) || result)
        : [...nonExecutableResults, ...displayResults]);
      const retryableIds = new Set(collectionResults
        .filter((item) => item.status === "error" && item.retryable && !item.uncertain)
        .map((item) => item.id));
      retryTokenJobsRef.current = jobs.filter((job) => retryableIds.has(job.id));
      const success = collectionResults.filter((item) => item.status === "success").length;
      const skipped = collectionResults.filter((item) => item.status === "skipped").length;
      const failed = collectionResults.filter((item) => item.status === "error").length
        + nonExecutableResults.length;
      setStage("complete");
      setMessage(`SPL Token 归集完成：${success} 笔成功，${skipped} 笔跳过${failed ? `，${failed} 笔失败` : ""}`
        + (retryTokenJobsRef.current.length ? `；${retryTokenJobsRef.current.length} 笔可直接重试` : ""));
    } catch (error) {
      retryTokenJobsRef.current = jobs.filter((job) => !submittedJobIds.has(job.id));
      const jobIds = new Set(jobs.map((job) => job.id));
      if (!jobs.length) setResults([]);
      else setResults((current) => current.map((result) => {
          if (!result.executionId || !jobIds.has(result.executionId)) return result;
          const uncertain = submittedJobIds.has(result.executionId) || Boolean(result.hash);
          return {
            ...result,
            message: uncertain
              ? "交易已提交但确认状态不确定，请根据签名核对链上状态"
              : "执行在提交前中断，可安全重试",
            retryable: !uncertain,
            status: "error",
            uncertain
          };
        }));
      setStage("error");
      const detail = error instanceof Error ? error.message : "";
      setMessage(detail.includes("RPC 网络不匹配")
        || detail.includes("Token 持仓清单")
        || detail.includes("没有可归集")
        ? detail
        : "SPL Token 归集流程中断；已显示签名的项目请先核对链上状态");
    } finally {
      expireHoldingsSnapshot();
      operationRef.current = false;
      pauseControllerRef.current.resume();
      setPaused(false);
    }
  };

  const executeCollection = (retryOnly = false) => (
    assetMode === "spl" ? executeTokenCollection(retryOnly) : executeNativeCollection(retryOnly)
  );

  const resetTask = () => {
    pauseControllerRef.current.resume();
    setPaused(false);
    keyInputRef.current?.clear();
    retrySourcesRef.current = [];
    retryTokenJobsRef.current = [];
    holdingsRequestRef.current += 1;
    setTokenMintInput("");
    setTokenMintInputMessage("");
    setTargetAddress("");
    setAmountMode("all");
    setPercentageAmount("100");
    setFixedAmount("0.1");
    setRandomMinimum("0.01");
    setRandomMaximum("0.1");
    setReserveAmount("0");
    setMinimumAmount("0");
    setConcurrency("3");
    setMinimumDelay("0");
    setMaximumDelay("0");
    setHoldings(null);
    setHoldingsStatus("idle");
    setHoldingsMessage("");
    setHoldingsIssues([]);
    setResults([]);
    setArchivedRound(null);
    setRoundSequence(1);
    setIssues([]);
    setMessage("");
    setStage("editing");
  };

  const amountPolicyValid = getAmountPolicy() !== null;
  const executionSettingsValid = getExecutionSettings() !== null;
  const rpcEndpointValid = isRpcEndpoint(rpcEndpoint);
  const splTargetValid = assetMode !== "spl" || !normalizedTarget
    || PublicKey.isOnCurve(new PublicKey(normalizedTarget).toBytes());
  const knownTokenInventoryUnavailable = holdingsStatus === "ready" && Boolean(holdings)
    && (!holdings?.tokenInventoryComplete
      || Boolean(holdings?.tokenAccountCount && !holdings.readyTokenAccountCount));
  const canStart = Boolean(normalizedTarget && sourceCount && rpcEndpointValid
    && (assetMode === "native"
      ? amountPolicyValid
      : splTargetValid && parsedTokenMints.valid && parsedTokenMints.mintAddresses.length > 0
        && !knownTokenInventoryUnavailable)
    && executionSettingsValid && !running
    && !archivedRound?.requiresAcknowledgement);

  return (
    <ToolPageLayout
      actions={(
        <>
          <Badge variant="outline">{selectedNetwork.label}</Badge>
          <ConfirmActionDialog
            confirmLabel="确认清空"
            description={hasRecordedHash
              ? "当前钱包行包含已提交的交易。清空前请先核对链上状态；清空后本页记录无法恢复。"
              : "来源密钥、目标地址、当前执行状态和历史记录将从页面清除。"}
            disabled={running}
            onConfirm={resetTask}
            title="清空 SOL / SPL Token 归集工作台？"
            triggerLabel="清空工作台"
            triggerVariant="destructive"
          />
        </>
      )}
      className="collection-shell collection-page"
      currentToolId="sol-collection"
      status={workbenchStatus}
      statusLabel={solStatusLabels[workbenchStatus]}
      title="SOL / SPL Token 归集"
    >
      <div className="workspace collection-workspace">
        <WorkbenchPanel
          className="collection-workbench-panel"
          footer={(
            <div className="actions collection-actions">
              {stage === "running" ? (
                <CollectionExecutionControls
                  current={completedResultCount}
                  label={assetMode === "spl" ? "SPL Token 归集进度" : "SOL 归集进度"}
                  onPausedChange={handlePausedChange}
                  paused={paused}
                  total={results.length}
                />
              ) : retryableCount ? (
                <ConfirmActionDialog
                  confirmLabel={`重试 ${retryableCount} 个失败${assetMode === "spl" ? "账户" : "钱包"}`}
                  description="只重试尚未提交或已明确执行失败的项目；状态不确定的交易不会自动重发。"
                  disabled={running}
                  onConfirm={() => executeCollection(true)}
                  title="确认重试失败项？"
                  triggerLabel={`重试失败项 (${retryableCount})`}
                  triggerVariant="outline"
                />
              ) : results.length && (stage === "complete" || stage === "error") ? (
                <p className="collection-terminal-hint">
                  {workbenchStatus === "uncertain"
                    ? "可直接编辑设置；当前结果会移入下方记录。核对链上状态后才可开始新的写入任务。"
                    : "任务已结束。直接修改任一设置即可继续，当前结果会移入下方记录。"}
                </p>
              ) : (
                <ConfirmActionDialog
                  confirmLabel="确认并开始归集"
                  description={(
                    <div className="summary-list">
                      <div><span>网络</span><strong>{selectedNetwork.label}</strong></div>
                      <div><span>目标地址</span><strong className="mono">{targetAddress || "—"}</strong></div>
                      <div><span>来源钱包</span><strong>{sourceCount} 个已选择</strong></div>
                      <div><span>资产项</span><strong>{assetMode === "spl"
                        ? `${parsedTokenMints.mintAddresses.length} 个 SPL Token`
                        : "SOL"}</strong></div>
                      <div><span>归集数量</span><strong>{assetMode === "spl"
                        ? "清单内 Token 全部实时余额"
                        : amountModeLabels[amountMode]}</strong></div>
                      <div><span>并发</span><strong>{concurrency}</strong></div>
                      <div><span>随机延迟</span><strong>{minimumDelay}–{maximumDelay} 秒</strong></div>
                    </div>
                  )}
                  disabled={!canStart}
                  onConfirm={() => executeCollection(false)}
                  title={assetMode === "spl" ? "确认 SPL Token 归集？" : "确认 SOL 归集？"}
                  triggerLabel="确认并开始归集"
                />
              )}
            </div>
          )}
          title="归集设置"
        >
          <div className="form collection-form">
            <SecretKeyInput
              disabled={controlsLocked}
              mode="solana"
              onDirty={() => { invalidateTask(); invalidateHoldings(); }}
              onImportingChange={handleKeyImportingChange}
              onLineCountChange={setSourceCount}
              ref={keyInputRef}
              walletBalances={walletBalances}
              walletStatuses={walletStatuses}
            />

            <Field>
              <FieldLabel htmlFor="sol-collection-token-0">Token 清单</FieldLabel>
              <div className="erc20-token-editor">
                {tokenInputRows.map((row, index) => {
                  const parsedRow = parsedTokenMints.rows[index];
                  const mintAddress = parsedRow?.mintAddress;
                  const preview = mintAddress ? recognizedTokenByMint.get(mintAddress) : undefined;
                  const matchedHoldings = mintAddress
                    ? holdings?.holdings.filter((holding) => holding.mintAddress === mintAddress) || []
                    : [];
                  const recognitionLabel = !row.trim()
                    ? "SPL"
                    : parsedRow?.status === "invalid"
                      ? "地址无效"
                      : parsedRow?.status === "duplicate"
                        ? "地址重复"
                        : preview?.status === "ready"
                          ? preview.program === "token-2022" ? "Token-2022" : "SPL"
                          : preview?.status === "unsupported"
                            ? "不支持"
                            : preview?.status === "unverified"
                              ? "识别失败"
                              : tokenRecognition.status === "loading" || holdingsStatus === "loading"
                          ? "查询中"
                          : matchedHoldings.length
                            ? matchedHoldings.some((holding) => holding.program === "token-2022")
                              ? "Token-2022"
                              : "SPL"
                            : holdingsStatus === "ready" ? "无持仓" : "SPL";
                  const recognitionStatus = !row.trim()
                    ? "idle"
                    : parsedRow?.status === "invalid" || parsedRow?.status === "duplicate"
                      ? "error"
                      : preview?.status === "ready"
                        ? "ready"
                        : preview?.status === "unsupported" || preview?.status === "unverified"
                          ? "error"
                          : tokenRecognition.status === "loading" || holdingsStatus === "loading"
                        ? "loading"
                        : matchedHoldings.length ? "ready" : "idle";
                  const tokenLocked = preview?.status === "ready";
                  return (
                    <div
                      className="erc20-token-row"
                      data-locked={tokenLocked || undefined}
                      data-status={recognitionStatus}
                      key={index}
                    >
                      <Input
                        aria-describedby={`sol-collection-token-status-${index}`}
                        aria-label={index === 0 ? "Token 清单" : `Token 地址 ${index + 1}`}
                        autoCapitalize="none"
                        autoComplete="off"
                        disabled={controlsLocked}
                        id={`sol-collection-token-${index}`}
                        maxLength={maximumSolTokenMintAddressLength}
                        onChange={(event) => {
                          if (tokenLocked) return;
                          const nextRows = [...tokenInputRows];
                          nextRows[index] = event.target.value;
                          updateTokenMintRows(nextRows);
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
                          updateTokenMintRows([
                            ...tokenInputRows.slice(0, index),
                            ...pastedRows,
                            ...tokenInputRows.slice(index + 1)
                          ]);
                        }}
                        placeholder="Mint 地址"
                        readOnly={tokenLocked}
                        spellCheck={false}
                        title={tokenLocked ? "Token 已添加；如需更换，请删除后重新添加" : undefined}
                        value={row}
                      />
                      <span
                        aria-live="polite"
                        className="erc20-token-symbol"
                        data-status={recognitionStatus}
                        id={`sol-collection-token-status-${index}`}
                        title={parsedRow?.problem || preview?.unsupportedReason
                          || (preview?.decimals !== null && preview?.decimals !== undefined
                            ? `${recognitionLabel} · ${preview.decimals} 位小数`
                            : mintAddress || recognitionLabel)}
                      >
                        {recognitionLabel}
                      </span>
                      {tokenInputRows.length > 1 || row.trim() ? (
                        <Button
                          aria-label={`删除 Token 地址 ${index + 1}`}
                          disabled={controlsLocked}
                          onClick={() => updateTokenMintRows(
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
                  disabled={controlsLocked || tokenInputRows.length >= maximumSolTokenMintInputEntries}
                  onClick={() => {
                    const nextIndex = tokenInputRows.length;
                    updateTokenMintRows([...tokenInputRows, ""]);
                    window.requestAnimationFrame(() => {
                      document.getElementById(`sol-collection-token-${nextIndex}`)?.focus();
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
                可选；留空则归集 SOL，填写后归集列出的 SPL Token（支持 Token-2022）。
              </FieldDescription>
              {tokenRecognition.message ? (
                <p
                  aria-live="polite"
                  className="address-balance-control__status"
                  data-status={tokenRecognition.status}
                  role="status"
                >
                  {tokenRecognition.message}
                </p>
              ) : null}
              {tokenMintInputMessage || parsedTokenMints.limitIssue ? (
                <FieldError>{tokenMintInputMessage || parsedTokenMints.limitIssue}</FieldError>
              ) : null}
              <div aria-label="地址余额查询" className="address-balance-control">
                <Button
                  disabled={controlsLocked || holdingsStatus === "loading" || sourceCount === 0
                    || !rpcEndpointValid || !parsedTokenMints.valid}
                  onClick={() => void discoverHoldings()}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {holdingsStatus === "loading" ? "查询中" : "查看地址余额"}
                </Button>
                {holdingsMessage ? (
                  <p
                    aria-live="polite"
                    className="address-balance-control__status"
                    data-status={holdingsStatus}
                    role="status"
                  >
                    {holdingsMessage}
                  </p>
                ) : null}
              </div>
              {holdingsIssues.length ? (
                <Alert variant={holdingsStatus === "error" ? "destructive" : "default"}>
                  <AlertDescription>
                    <ul>{holdingsIssues.slice(0, 8).map((issue) => <li key={issue}>{issue}</li>)}</ul>
                  </AlertDescription>
                </Alert>
              ) : null}
            </Field>

            <Field data-invalid={targetAddress.trim() && (!normalizedTarget || !splTargetValid) ? true : undefined}>
              <FieldLabel htmlFor="sol-collection-target">目标钱包</FieldLabel>
              <Input
                aria-invalid={targetAddress.trim() && (!normalizedTarget || !splTargetValid) ? true : undefined}
                autoCapitalize="none"
                autoComplete="off"
                disabled={controlsLocked}
                id="sol-collection-target"
                onChange={(event) => { setTargetAddress(event.target.value); invalidateTask(); }}
                placeholder="Solana 地址"
                spellCheck={false}
                value={targetAddress}
              />
              {targetAddress.trim() && !normalizedTarget ? <FieldError>请输入有效的 Solana 地址</FieldError> : null}
              {targetAddress.trim() && normalizedTarget && !splTargetValid ? (
                <FieldError>SPL Token 归集目标必须是可签名的钱包地址</FieldError>
              ) : null}
            </Field>

            <h3 className="collection-config-heading">归集配置</h3>

            <Field>
              <FieldLabel htmlFor="sol-collection-network">网络</FieldLabel>
              <SearchableSelect
                disabled={controlsLocked}
                id="sol-collection-network"
                listboxLabel="Solana 归集网络"
                onChange={(value) => {
                  const nextNetwork = getNetworkConfig(value);
                  setNetworkId(value);
                  setRpcEndpoint(getPreferredRpcEndpoint("solana", value, nextNetwork.endpoint));
                  invalidateTask();
                  invalidateHoldings();
                }}
                options={networkOptions}
                searchable={false}
                triggerLabel="选择 Solana 网络"
                value={networkId}
              />
            </Field>

            {assetMode === "native" ? <Field data-invalid={!amountPolicyValid ? true : undefined}>
              <FieldLabel>归集数量</FieldLabel>
              <Tabs onValueChange={(value) => { setAmountMode(value as AmountMode); invalidateTask(); }} value={amountMode}>
                <TabsList aria-label="SOL 归集数量模式">
                  {Object.entries(amountModeLabels).map(([value, label]) => (
                    <TabsTrigger disabled={controlsLocked} key={value} value={value}>{label}</TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
              {amountMode === "percentage" ? (
                <Input aria-label="归集百分比" disabled={controlsLocked} inputMode="decimal" max="100" min="0.01" onChange={(event) => { setPercentageAmount(event.target.value); invalidateTask(); }} step="0.01" type="number" value={percentageAmount} />
              ) : amountMode === "fixed" ? (
                <Input aria-label="每钱包固定归集数量" disabled={controlsLocked} inputMode="decimal" min="0" onChange={(event) => { setFixedAmount(event.target.value); invalidateTask(); }} step="0.000001" type="number" value={fixedAmount} />
              ) : amountMode === "random" ? (
                <div className="amount-grid">
                  <Input aria-label="随机最小数量" disabled={controlsLocked} inputMode="decimal" min="0" onChange={(event) => { setRandomMinimum(event.target.value); invalidateTask(); }} step="0.000001" type="number" value={randomMinimum} />
                  <Input aria-label="随机最大数量" disabled={controlsLocked} inputMode="decimal" min="0" onChange={(event) => { setRandomMaximum(event.target.value); invalidateTask(); }} step="0.000001" type="number" value={randomMaximum} />
                </div>
              ) : null}
              {!amountPolicyValid ? <FieldError>请填写有效数量；百分比为 0.01–100，随机最大值不能小于最小值</FieldError> : null}
            </Field> : (
              <Alert>
                <AlertTitle>SPL Token 数量</AlertTitle>
                <AlertDescription>
                  每个已选 Token Account 归集执行时的全部可用余额；来源 SOL 仅用于网络费和必要的目标 ATA 租金。
                </AlertDescription>
              </Alert>
            )}

            <AdvancedSettings
              disabled={controlsLocked}
              label={assetMode === "spl" ? "RPC 与执行设置" : "RPC、保留金额与执行设置"}
            >
              <Field data-invalid={!rpcEndpointValid ? true : undefined}>
                <FieldLabel htmlFor="sol-collection-rpc">RPC 地址</FieldLabel>
                <Input
                  aria-invalid={!rpcEndpointValid ? true : undefined}
                  disabled={controlsLocked}
                  id="sol-collection-rpc"
                  onBlur={() => rememberRpcEndpoint("solana", networkId, rpcEndpoint)}
                  onChange={(event) => {
                    setRpcEndpoint(event.target.value);
                    invalidateTask();
                    invalidateHoldings();
                  }}
                  spellCheck={false}
                  type="url"
                  value={rpcEndpoint}
                />
                {!rpcEndpointValid ? <FieldError>请输入以 http:// 或 https:// 开头的有效 RPC 地址</FieldError> : null}
              </Field>
              {assetMode === "native" ? <div className="field-row">
                <Field>
                  <FieldLabel htmlFor="sol-collection-reserve">每钱包保留 SOL</FieldLabel>
                  <Input disabled={controlsLocked} id="sol-collection-reserve" inputMode="decimal" min="0" onChange={(event) => { setReserveAmount(event.target.value); invalidateTask(); }} step="0.000001" type="number" value={reserveAmount} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="sol-collection-minimum">最小归集金额</FieldLabel>
                  <Input disabled={controlsLocked} id="sol-collection-minimum" inputMode="decimal" min="0" onChange={(event) => { setMinimumAmount(event.target.value); invalidateTask(); }} step="0.000001" type="number" value={minimumAmount} />
                </Field>
              </div> : null}
              <div className="field-row execution-settings-row">
                <Field>
                  <FieldLabel htmlFor="sol-collection-concurrency">并发钱包数</FieldLabel>
                  <Input disabled={controlsLocked} id="sol-collection-concurrency" inputMode="numeric" max="20" min="1" onChange={(event) => { setConcurrency(event.target.value); invalidateTask(); }} step="1" type="number" value={concurrency} />
                </Field>
                <Field>
                  <FieldLabel>随机延迟（秒）</FieldLabel>
                  <div className="amount-grid compact-range">
                    <Input aria-label="随机延迟最小秒数" disabled={controlsLocked} inputMode="decimal" min="0" onChange={(event) => { setMinimumDelay(event.target.value); invalidateTask(); }} step="0.1" type="number" value={minimumDelay} />
                    <Input aria-label="随机延迟最大秒数" disabled={controlsLocked} inputMode="decimal" min="0" onChange={(event) => { setMaximumDelay(event.target.value); invalidateTask(); }} step="0.1" type="number" value={maximumDelay} />
                  </div>
                </Field>
              </div>
              {!executionSettingsValid ? <FieldError>并发为 1–20；延迟为 0–300 秒，且最大值不能小于最小值</FieldError> : null}
            </AdvancedSettings>

            {issues.length ? (
              <Alert variant="destructive"><AlertTitle>输入有误</AlertTitle><AlertDescription><ul>{issues.map((issue, index) => <li key={`${issue}-${index}`}>{issue}</li>)}</ul></AlertDescription></Alert>
            ) : null}
            {message ? (
              <Alert aria-live={workbenchStatus === "error" || workbenchStatus === "uncertain" ? "assertive" : "polite"} variant={workbenchStatus === "error" || workbenchStatus === "uncertain" ? "destructive" : "default"}>
                <AlertTitle>{solStatusLabels[workbenchStatus]}</AlertTitle><AlertDescription>{message}</AlertDescription>
              </Alert>
            ) : null}
          </div>
        </WorkbenchPanel>
        {archivedRound ? (
          <ReviewPanel
            actions={archivedRound.requiresAcknowledgement ? (
              <ConfirmActionDialog
                confirmLabel="确认已核对"
                description="仅确认你已根据交易签名核对记录中的链上状态；这不会重试或撤销原交易。确认后才允许提交新的写入任务。"
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
              exportFilename="sol-collection-records.csv"
              results={archivedRound.results}
              title="交易明细"
            />
          </ReviewPanel>
        ) : null}
      </div>
    </ToolPageLayout>
  );
}
