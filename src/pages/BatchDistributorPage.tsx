import { RpcSettings } from "../components/RpcSettings";
import { WorkflowFeedback } from "../components/WorkflowFeedback";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CompactNotice, NoticeTitle, NoticeDetail } from "../components/CompactNotice";
import { HelpTooltip } from "../components/HelpTooltip";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { DistributionListGenerator, type DistributionListGeneratorHandle } from "../components/DistributionListGenerator";
import { DistributionSummary } from "../components/DistributionSummary";
import { SearchableSelect, type SearchableSelectOption } from "../components/SearchableSelect";
import { ToolPageLayout, type WorkbenchStatus } from "../components/ToolPageLayout";
import { WalletConnectionControl } from "../components/WalletConnectionControl";
import { TaskHistoryPanel } from "../components/TaskHistoryPanel";
import { useTaskHistory } from "../hooks/useTaskHistory";
import {
  ActionBar,
  WorkbenchSection,
  ConfirmActionDialog,
  ExecutionProgress,
  ReviewPanel,
  ResultTable,
  WorkbenchPanel
} from "../components/WorkbenchPrimitives";
import { useSolanaWallet } from "../hooks/useSolanaWallet";
import { shortenAddress } from "../lib/address";
import { formatLamports, formatLamportsForDisplay } from "../lib/amount";
import { getInitialDistributionInput, parseDistribution, type DistributionRow } from "../lib/distribution";
import { importDistributionInput, type GeneratedDistributionList } from "../lib/distribution-generator";
import { sanitizeRoundArchiveText, type CollectionDisplayResult } from "../lib/collection-results";
import {
  Connection,
  assertSolanaRpcNetwork,
  createSendProgress,
  createTransferTransaction,
  estimateTransactionFeesLamports,
  getBalanceLamports,
  getEstimatedTransferChunks,
  getExplorerUrl,
  getNetworkConfig,
  getTransactionErrorMessage,
  initialSendState,
  planTransferChunks,
  sendWalletTransaction,
  solanaNetworks,
  type SendOptions,
  type SolanaNetworkId,
  type TransactionSignature
} from "../lib/solana";

type BalanceLookupState = {
  message: string;
  status: "idle" | "loading" | "success" | "error";
  valueLamports: bigint | null;
};

type DistributionPreflightState = {
  balanceLamports: bigint | null;
  estimatedFeeLamports: bigint | null;
  message: string;
  requiredLamports: bigint | null;
  status: "idle" | "loading" | "success" | "error";
  transactionCount: number;
};

type ArchivedDistributionRound = {
  historyRecordId?: string;
  message: string;
  networkId: SolanaNetworkId;
  networkLabel: string;
  requiresAcknowledgement: boolean;
  sequence: number;
  signatures: TransactionSignature[];
  status: "error" | "success";
  transactions: SolanaDistributionTransaction[];
};

export type SolanaDistributionTransaction = {
  rows: DistributionRow[];
  signature?: string;
  status: "not-submitted" | "pending" | "confirmed" | "failed";
};

export function getUnsentSolanaDistribution(transactions: SolanaDistributionTransaction[]) {
  return transactions
    .filter((transaction) => transaction.status === "not-submitted" || transaction.status === "failed")
    .flatMap((transaction) => transaction.rows)
    .map((row) => `${row.address},${row.amountRaw}`)
    .join("\n");
}

function downloadUnsentDistribution(transactions: SolanaDistributionTransaction[]) {
  const content = getUnsentSolanaDistribution(transactions);
  if (!content) return;
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "sol-unsent-distribution.csv";
  anchor.click();
  URL.revokeObjectURL(url);
}

function transactionStatusLabel(status: SolanaDistributionTransaction["status"]) {
  return status === "confirmed" ? "已确认" : status === "failed" ? "失败（未转出）" : status === "pending" ? "待核对" : "未提交";
}

function solanaHistoryResults(transactions: SolanaDistributionTransaction[], networkId: SolanaNetworkId): CollectionDisplayResult[] {
  return transactions.flatMap((transaction) => transaction.rows.map((row) => ({
    address: row.address,
    amount: row.amountRaw,
    asset: "SOL",
    explorerUrl: transaction.signature ? getExplorerUrl(transaction.signature, networkId) : undefined,
    hash: transaction.signature,
    message: transactionStatusLabel(transaction.status),
    retryable: transaction.status === "failed" || transaction.status === "not-submitted",
    status: transaction.status === "confirmed" ? "success" : transaction.status === "failed" ? "error" : transaction.status === "not-submitted" ? "skipped" : "confirming",
    uncertain: transaction.status === "pending"
  })));
}

function isWalletCancellation(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? Number(error.code) : 0;
  const detail = error instanceof Error ? error.message : String(error || "");
  return code === 4001 || /reject|declin|cancel|用户取消/i.test(detail);
}

const initialBalanceLookupState: BalanceLookupState = {
  message: "",
  status: "idle",
  valueLamports: null
};

const initialDistributionPreflightState: DistributionPreflightState = {
  balanceLamports: null,
  estimatedFeeLamports: null,
  message: "",
  requiredLamports: null,
  status: "idle",
  transactionCount: 0
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

const maximumBatchSignTransactions = 20;
const invalidRpcEndpointMessage = "RPC 地址无效：请输入完整的 HTTP 或 HTTPS 地址";

const solanaNetworkOptions: SearchableSelectOption<SolanaNetworkId>[] = solanaNetworks.map((network) => ({
  keywords: [network.id],
  label: network.label,
  meta: network.id,
  value: network.id
}));

function getBalanceLookupErrorMessage(error: unknown) {
  const detail = error && typeof error === "object" && "message" in error ? String((error as { message?: unknown }).message || "") : String(error || "");

  if (/403|429|failed to fetch|network|fetch|timeout/i.test(detail)) return "余额读取失败，请更换 RPC 后重试";
  return detail ? `余额读取失败：${detail}` : "余额读取失败，请稍后重试";
}

function isValidRpcEndpoint(endpoint: string) {
  try {
    const url = new URL(endpoint);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}

export function BatchDistributorPage() {
  const [initialDistribution] = useState(() => importDistributionInput(getInitialDistributionInput()));
  const [mixedAmountWarningVisible, setMixedAmountWarningVisible] = useState(initialDistribution.hasMixedAmounts);
  const [generatedInput, setGeneratedInput] = useState("");
  const [generatedList, setGeneratedList] = useState<GeneratedDistributionList>(initialGeneratedList);
  const [confirmVisible, setConfirmVisible] = useState(false);
  const [networkId, setNetworkId] = useState<SolanaNetworkId>("mainnet-beta");
  const [rpcEndpoint, setRpcEndpoint] = useState(getNetworkConfig("mainnet-beta").endpoint);
  const [sendState, setSendState] = useState(initialSendState);
  const [transactionResults, setTransactionResults] = useState<SolanaDistributionTransaction[]>([]);
  const [archivedRound, setArchivedRound] = useState<ArchivedDistributionRound | null>(null);
  const [roundSequence, setRoundSequence] = useState(1);
  const [preflightState, setPreflightState] = useState<DistributionPreflightState>(initialDistributionPreflightState);
  const [balanceLookup, setBalanceLookup] = useState<BalanceLookupState>(initialBalanceLookupState);
  const [balanceRefreshNonce, setBalanceRefreshNonce] = useState(0);
  const [listImporting, setListImporting] = useState(false);
  const listImportingRef = useRef(false);
  const generatorRef = useRef<DistributionListGeneratorHandle>(null);
  const preflightEpochRef = useRef(0);
  const sendOperationRef = useRef(false);
  const previousWalletRef = useRef("");
  const terminalArchivedRef = useRef(false);
  const resetForEditRef = useRef<() => void>(() => {});
  const wallet = useSolanaWallet();

  const handleListImportingChange = useCallback((importing: boolean) => {
    listImportingRef.current = importing;
    setListImporting(importing);
  }, []);

  const resetConfirmation = useCallback(() => {
    preflightEpochRef.current += 1;
    setConfirmVisible(false);
    setPreflightState(initialDistributionPreflightState);
    setSendState(initialSendState);
    setTransactionResults([]);
  }, []);

  const parsed = useMemo(() => parseDistribution(generatedInput), [generatedInput]);
  const selectedNetwork = useMemo(() => getNetworkConfig(networkId), [networkId]);
  const effectiveRpcEndpoint = rpcEndpoint.trim() || selectedNetwork.endpoint;
  const rpcEndpointValid = isValidRpcEndpoint(effectiveRpcEndpoint);
  const estimatedChunks = useMemo(() => getEstimatedTransferChunks(parsed.validRows, wallet.address), [parsed.validRows, wallet.address]);
  const transactionCount = estimatedChunks.length;
  const sending = sendState.status === "preparing" || sendState.status === "awaiting-wallet" || sendState.status === "confirming";
  const preflighting = preflightState.status === "loading";
  const preflightFailed = preflightState.status === "error";
  const sendComplete = sendState.status === "success";
  const sendFailed = sendState.status === "error";
  const unresolvedSubmission = sendFailed && transactionResults.some((transaction) => transaction.status === "pending");
  const unsentDistribution = getUnsentSolanaDistribution(transactionResults);
  const controlsLocked = preflighting || sending;
  const pageControlsLocked = controlsLocked || listImporting;
  const generatedListReady = generatedList.invalid === 0 && generatedList.duplicates === 0;
  const invalidCount = parsed.invalid + generatedList.invalid;
  const duplicateCount = Math.max(parsed.duplicates, generatedList.duplicates);
  const walletBalance = balanceLookup.status === "success" && balanceLookup.valueLamports !== null
    ? formatLamportsForDisplay(balanceLookup.valueLamports)
    : balanceLookup.status === "loading"
      ? "读取中"
      : wallet.connected
        ? "--"
        : "未连接";
  const showFinalSummary = confirmVisible && sendState.status === "idle" && preflightState.status === "success";
  const taskNetwork = useMemo(() => ({ kind: "solana" as const, id: networkId, label: selectedNetwork.label }), [networkId, selectedNetwork.label]);
  const historyResults = useMemo(() => sendState.status === "idle" ? [] : solanaHistoryResults(transactionResults, networkId), [networkId, sendState.status, transactionResults]);
  const taskHistory = useTaskHistory({ toolId: "sol-distribution", label: "SOL 批量分发", network: taskNetwork, results: historyResults, busy: sending || preflighting, roundKey: roundSequence });
  const readyToSend = wallet.connected && Boolean(wallet.provider) && rpcEndpointValid && generatedListReady && parsed.validRows.length > 0 && parsed.invalid === 0 && !preflighting && !sending && !sendComplete && !sendFailed && !listImporting && !taskHistory.needsRecoveryReview && !archivedRound?.requiresAcknowledgement;
  useEffect(() => {
    if (!archivedRound?.requiresAcknowledgement || !archivedRound.historyRecordId) return;
    const record = taskHistory.records.find((item) => item.id === archivedRound.historyRecordId);
    if (record && (record.acknowledgedAt || !record.results.some((result) => result.uncertain || ["submitting", "confirming"].includes(result.status)))) {
      setArchivedRound((current) => current ? { ...current, requiresAcknowledgement: false } : current);
    }
  }, [archivedRound, taskHistory.records]);
  const readinessMessage = taskHistory.needsRecoveryReview
    ? "请先在可恢复任务记录中核对之前提交的交易"
    : archivedRound?.requiresAcknowledgement
    ? "请先核对分发记录中的链上状态"
    : !wallet.connected || !wallet.provider
    ? "请先连接发送钱包"
    : listImporting
      ? "正在导入清单，请稍候"
      : !rpcEndpointValid
        ? invalidRpcEndpointMessage
        : generatedList.invalid > 0 || parsed.invalid > 0
          ? `请先修正 ${invalidCount} 处清单错误`
          : generatedList.duplicates > 0 || parsed.duplicates > 0
            ? `请先处理 ${duplicateCount} 个重复地址`
            : parsed.validRows.length === 0
              ? "请先添加至少 1 个有效收款地址"
              : "清单已就绪";

  const archiveTerminalRound = useCallback(() => {
    if (terminalArchivedRef.current || (!sendComplete && !sendFailed)) return false;
    terminalArchivedRef.current = true;
    setArchivedRound({
      historyRecordId: taskHistory.currentRecordId,
      message: sanitizeRoundArchiveText(sendState.message),
      networkId,
      networkLabel: selectedNetwork.label,
      requiresAcknowledgement: unresolvedSubmission,
      sequence: roundSequence,
      signatures: [...sendState.signatures],
      status: sendComplete ? "success" : "error",
      transactions: transactionResults.map((transaction) => ({ ...transaction, rows: [...transaction.rows] }))
    });
    setRoundSequence((current) => current + 1);
    return true;
  }, [networkId, roundSequence, selectedNetwork.label, sendComplete, sendFailed, sendState.message, sendState.signatures, taskHistory.currentRecordId, transactionResults, unresolvedSubmission]);

  const resetForEdit = useCallback(() => {
    if (sending || preflighting) return;
    archiveTerminalRound();
    resetConfirmation();
  }, [archiveTerminalRound, preflighting, resetConfirmation, sending]);
  resetForEditRef.current = resetForEdit;

  const handleGeneratedListChange = useCallback((result: GeneratedDistributionList) => {
    setGeneratedList(result);
    setGeneratedInput(result.output);
    resetForEditRef.current();
  }, []);

  const handleGeneratorDirty = useCallback(() => {
    setMixedAmountWarningVisible(false);
    resetForEditRef.current();
  }, []);

  useEffect(() => {
    const walletIdentity = `${wallet.connected ? "connected" : "disconnected"}:${wallet.address || ""}`;
    if (!previousWalletRef.current) {
      previousWalletRef.current = walletIdentity;
      return;
    }
    if (previousWalletRef.current === walletIdentity) return;
    previousWalletRef.current = walletIdentity;
    resetForEdit();
    // Only wallet identity changes should trigger this effect. Execution-state changes must retain their result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet.address, wallet.connected]);

  useEffect(() => {
    if (!wallet.connected || !wallet.address) {
      setBalanceLookup({
        message: "连接钱包后显示余额",
        status: "idle",
        valueLamports: null
      });
      return;
    }

    if (!rpcEndpointValid) {
      setBalanceLookup({
        message: invalidRpcEndpointMessage,
        status: "error",
        valueLamports: null
      });
      return;
    }

    let active = true;
    setBalanceLookup({
      message: "正在读取钱包余额",
      status: "loading",
      valueLamports: null
    });

    void (async () => {
      try {
        const connection = new Connection(effectiveRpcEndpoint, "confirmed");
        await assertSolanaRpcNetwork(connection, networkId);
        const valueLamports = await getBalanceLamports(connection, wallet.address);
        if (!active) return;
        setBalanceLookup({
          message: "",
          status: "success",
          valueLamports
        });
      } catch (error) {
        if (!active) return;
        setBalanceLookup({
          message: getBalanceLookupErrorMessage(error),
          status: "error",
          valueLamports: null
        });
      }
    })();

    return () => {
      active = false;
    };
  }, [balanceRefreshNonce, effectiveRpcEndpoint, networkId, rpcEndpointValid, wallet.address, wallet.connected]);

  const prepareDistribution = async () => {
    if (sendOperationRef.current || listImportingRef.current || !readyToSend || !wallet.address) return;
    if (taskHistory.checkRecoveryReview()) return;
    terminalArchivedRef.current = false;
    sendOperationRef.current = true;
    const preflightEpoch = ++preflightEpochRef.current;
    setConfirmVisible(false);
    setPreflightState({
      ...initialDistributionPreflightState,
      message: "正在读取余额并估算全部交易手续费",
      status: "loading"
    });

    try {
      const connection = new Connection(effectiveRpcEndpoint, "confirmed");
      await assertSolanaRpcNetwork(connection, networkId);
      const latestBlockhash = await connection.getLatestBlockhash("confirmed");
      const chunks = planTransferChunks(parsed.validRows, wallet.address, latestBlockhash.blockhash);
      const transactions = chunks.map((chunk) => createTransferTransaction(wallet.address!, chunk, latestBlockhash.blockhash));
      const [estimatedFeeLamports, balanceLamports] = await Promise.all([
        estimateTransactionFeesLamports(connection, transactions),
        getBalanceLamports(connection, wallet.address)
      ]);
      if (preflightEpochRef.current !== preflightEpoch) return;
      if (taskHistory.checkRecoveryReview()) throw new Error("请先在可恢复任务记录中核对之前提交的交易");

      const requiredLamports = parsed.totalLamports + estimatedFeeLamports;
      if (balanceLamports < requiredLamports) {
        setPreflightState({
          balanceLamports,
          estimatedFeeLamports,
          message: `余额不足：预计共需 ${formatLamports(requiredLamports)} SOL，当前余额 ${formatLamports(balanceLamports)} SOL`,
          requiredLamports,
          status: "error",
          transactionCount: transactions.length
        });
        return;
      }

      setBalanceLookup({ message: "", status: "success", valueLamports: balanceLamports });
      setPreflightState({
        balanceLamports,
        estimatedFeeLamports,
        message: "检查通过，请核对本次分发后确认签名",
        requiredLamports,
        status: "success",
        transactionCount: transactions.length
      });
      setConfirmVisible(true);
    } catch (error) {
      if (preflightEpochRef.current !== preflightEpoch) return;
      setPreflightState({
        ...initialDistributionPreflightState,
        message: error instanceof Error && error.message.includes("RPC 网络不匹配")
          ? error.message
          : getTransactionErrorMessage(error),
        status: "error"
      });
    } finally {
      sendOperationRef.current = false;
    }
  };

  const sendDistribution = async () => {
    if (sendOperationRef.current || listImportingRef.current || !readyToSend || !wallet.provider || !wallet.address || !showFinalSummary || sendState.status !== "idle") return;
    if (taskHistory.checkRecoveryReview()) return;
    sendOperationRef.current = true;

    const sendOptions: SendOptions = {
      preflightCommitment: "confirmed",
      skipPreflight: false
    };
    const signatures: TransactionSignature[] = [];
    let signedCount = 0;
    let confirmedCount = 0;
    let plannedTransactionCount = transactionCount;
    let transactionResultsSnapshot: SolanaDistributionTransaction[] = parsed.validRows.length
      ? [{ rows: [...parsed.validRows], status: "not-submitted" }]
      : [];
    const updateTransaction = (index: number, update: Partial<SolanaDistributionTransaction>) => {
      transactionResultsSnapshot = transactionResultsSnapshot.map((transaction, transactionIndex) => (
        transactionIndex === index ? { ...transaction, ...update } : transaction
      ));
      setTransactionResults(transactionResultsSnapshot);
      taskHistory.captureResults(solanaHistoryResults(transactionResultsSnapshot, networkId));
    };
    setTransactionResults(transactionResultsSnapshot);
    taskHistory.captureResults(solanaHistoryResults(transactionResultsSnapshot, networkId));

    setSendState({
      message: "正在计算最少交易数量",
      progress: createSendProgress(plannedTransactionCount),
      signatures: [],
      status: "preparing"
    });

    try {
      const connection = new Connection(effectiveRpcEndpoint, "confirmed");
      await assertSolanaRpcNetwork(connection, networkId);
      const planningBlockhash = await connection.getLatestBlockhash("confirmed");
      const chunks = planTransferChunks(parsed.validRows, wallet.address, planningBlockhash.blockhash);
      transactionResultsSnapshot = chunks.map((rows) => ({ rows: [...rows], status: "not-submitted" }));
      setTransactionResults(transactionResultsSnapshot);
      taskHistory.captureResults(solanaHistoryResults(transactionResultsSnapshot, networkId));
      const transactions = chunks.map((chunk) => createTransferTransaction(wallet.address, chunk, planningBlockhash.blockhash));
      plannedTransactionCount = transactions.length;
      const progress = () => createSendProgress(plannedTransactionCount, signedCount, signatures.length, confirmedCount);

      setSendState({
        message: `已压缩为 ${transactions.length} 笔交易，正在预估手续费和检查余额`,
        progress: progress(),
        signatures: [],
        status: "preparing"
      });

      const [estimatedFeeLamports, balanceLamports] = await Promise.all([
        estimateTransactionFeesLamports(connection, transactions),
        getBalanceLamports(connection, wallet.address)
      ]);
      const requiredLamports = parsed.totalLamports + estimatedFeeLamports;

      if (balanceLamports < requiredLamports) {
        throw new Error(`钱包余额不足：本次需要约 ${formatLamports(requiredLamports)} SOL（分发 ${parsed.total} SOL + 预估手续费 ${formatLamports(estimatedFeeLamports)} SOL），当前余额 ${formatLamports(balanceLamports)} SOL`);
      }

      const canBatchSign = transactions.length > 1 && typeof wallet.provider.signAllTransactions === "function";

      setSendState({
        message: `余额与费用检查通过：分发 ${parsed.total} SOL，预估手续费 ${formatLamports(estimatedFeeLamports)} SOL`,
        progress: progress(),
        signatures: [],
        status: "preparing"
      });

      if (canBatchSign && wallet.provider.signAllTransactions) {
        const batchCount = Math.ceil(chunks.length / maximumBatchSignTransactions);

        for (let batchStart = 0; batchStart < chunks.length; batchStart += maximumBatchSignTransactions) {
          const batchNumber = Math.floor(batchStart / maximumBatchSignTransactions) + 1;
          const batchChunks = chunks.slice(batchStart, batchStart + maximumBatchSignTransactions);
          const currentBlockhash = await connection.getLatestBlockhash("confirmed");
          const batchTransactions = batchChunks.map((chunk) => createTransferTransaction(wallet.address, chunk, currentBlockhash.blockhash));

          setSendState({
            message: `请在 ${wallet.providerName} 中签名第 ${batchNumber}/${batchCount} 批（${batchTransactions.length} 笔）`,
            progress: progress(),
            signatures: [...signatures],
            status: "awaiting-wallet"
          });

          if (taskHistory.checkRecoveryReview()) throw new Error("请先在可恢复任务记录中核对之前提交的交易");
          const signedTransactions = await wallet.provider.signAllTransactions(batchTransactions);
          if (signedTransactions.length !== batchTransactions.length) throw new Error("钱包返回的签名交易数量不一致");
          signedCount += signedTransactions.length;

          setSendState({
            message: `已签名 ${signedCount}/${plannedTransactionCount} 笔交易，正在提交第 ${batchNumber}/${batchCount} 批`,
            progress: progress(),
            signatures: [...signatures],
            status: "confirming"
          });

          const batchSignatures: TransactionSignature[] = [];
          for (let index = 0; index < signedTransactions.length; index += 1) {
            const transactionNumber = batchStart + index + 1;
            setSendState({
              message: `已签名 ${signedCount}/${plannedTransactionCount}，正在提交第 ${transactionNumber}/${plannedTransactionCount} 笔交易`,
              progress: progress(),
              signatures: [...signatures],
              status: "confirming"
            });

            // A transport failure can happen after broadcast, before a signature is returned.
            if (taskHistory.checkRecoveryReview()) throw new Error("请先在可恢复任务记录中核对之前提交的交易");
            updateTransaction(transactionNumber - 1, { status: "pending" });
            const signature = await connection.sendRawTransaction(signedTransactions[index].serialize(), sendOptions);
            updateTransaction(transactionNumber - 1, { signature });
            batchSignatures.push(signature);
            signatures.push(signature);

            setSendState({
              message: `已提交 ${signatures.length}/${plannedTransactionCount} 笔交易，等待链上确认`,
              progress: progress(),
              signatures: [...signatures],
              status: "confirming"
            });
          }

          for (let index = 0; index < batchSignatures.length; index += 1) {
            const transactionNumber = batchStart + index + 1;
            setSendState({
              message: `已提交 ${signatures.length}/${plannedTransactionCount} 笔交易，正在确认第 ${transactionNumber}/${plannedTransactionCount} 笔`,
              progress: progress(),
              signatures: [...signatures],
              status: "confirming"
            });

            const confirmation = await connection.confirmTransaction({
              blockhash: currentBlockhash.blockhash,
              lastValidBlockHeight: currentBlockhash.lastValidBlockHeight,
              signature: batchSignatures[index]
            }, "confirmed");
            if (confirmation.value.err) {
              updateTransaction(transactionNumber - 1, { status: "failed" });
              throw new Error(`第 ${transactionNumber} 笔交易链上执行失败：${JSON.stringify(confirmation.value.err)}`);
            }
            updateTransaction(transactionNumber - 1, { status: "confirmed" });
            confirmedCount += 1;

            setSendState({
              message: `已确认 ${confirmedCount}/${plannedTransactionCount} 笔交易`,
              progress: progress(),
              signatures: [...signatures],
              status: "confirming"
            });
          }
        }
      } else {
        for (let index = 0; index < chunks.length; index += 1) {
          const chunk = chunks[index];
          const currentBlockhash = await connection.getLatestBlockhash("confirmed");
          const transaction = createTransferTransaction(wallet.address, chunk, currentBlockhash.blockhash);

          setSendState({
            message: `请在 ${wallet.providerName} 中签名第 ${index + 1}/${chunks.length} 笔交易`,
            progress: progress(),
            signatures: [...signatures],
            status: "awaiting-wallet"
          });

          if (taskHistory.checkRecoveryReview()) throw new Error("请先在可恢复任务记录中核对之前提交的交易");
          updateTransaction(index, { status: "pending" });
          let signature: TransactionSignature;
          try {
            signature = await sendWalletTransaction(wallet.provider, transaction, connection);
          } catch (error) {
            if (isWalletCancellation(error)) updateTransaction(index, { status: "not-submitted" });
            throw error;
          }
          updateTransaction(index, { signature });
          signedCount = Math.max(signedCount, index + 1);
          signatures.push(signature);

          setSendState({
            message: `第 ${index + 1}/${chunks.length} 笔交易已签名并提交，等待链上确认`,
            progress: progress(),
            signatures: [...signatures],
            status: "confirming"
          });

          const confirmation = await connection.confirmTransaction({
            blockhash: currentBlockhash.blockhash,
            lastValidBlockHeight: currentBlockhash.lastValidBlockHeight,
            signature
          }, "confirmed");
          if (confirmation.value.err) {
            updateTransaction(index, { status: "failed" });
            throw new Error(`第 ${index + 1} 笔交易链上执行失败：${JSON.stringify(confirmation.value.err)}`);
          }
          updateTransaction(index, { status: "confirmed" });
          confirmedCount += 1;

          setSendState({
            message: `已确认 ${confirmedCount}/${plannedTransactionCount} 笔交易`,
            progress: progress(),
            signatures: [...signatures],
            status: "confirming"
          });
        }
      }

      setSendState({
        message: `已完成 ${signatures.length} 笔交易确认`,
        progress: createSendProgress(plannedTransactionCount, signedCount, signatures.length, confirmedCount),
        signatures,
        status: "success"
      });
      setBalanceRefreshNonce((value) => value + 1);
    } catch (error) {
      const baseMessage = getTransactionErrorMessage(error);
      const pendingCount = transactionResultsSnapshot.filter((transaction) => transaction.status === "pending").length;
      const unsentCount = transactionResultsSnapshot
        .filter((transaction) => transaction.status === "not-submitted" || transaction.status === "failed")
        .reduce((total, transaction) => total + transaction.rows.length, 0);
      const partialMessage = `${baseMessage}。${confirmedCount} 笔已确认${pendingCount ? `，${pendingCount} 笔待核对，请先检查链上记录` : ""}${unsentCount ? `；${unsentCount} 个地址确定未转出，可导出原金额清单` : ""}。`;

      setSendState({
        message: partialMessage,
        progress: createSendProgress(plannedTransactionCount, signedCount, signatures.length, confirmedCount),
        signatures,
        status: "error"
      });
    } finally {
      sendOperationRef.current = false;
    }
  };

  const pageStatus: WorkbenchStatus = taskHistory.needsRecoveryReview || unresolvedSubmission
    ? "uncertain"
    : sendComplete
      ? "success"
      : sendFailed || preflightFailed
        ? "error"
        : sending
          ? "running"
          : preflighting
            ? "preflight"
            : showFinalSummary || readyToSend
              ? "ready"
              : "editing";
  const pageStatusLabel = taskHistory.needsRecoveryReview
    ? "历史交易待核对"
    : unresolvedSubmission
    ? "链上待核对"
    : sendComplete
      ? "已完成"
      : sendFailed
        ? "执行失败"
        : preflightFailed
          ? "检查未通过"
          : sending
            ? sendState.status === "awaiting-wallet" ? "等待签名" : "执行中"
            : preflighting
              ? "检查中"
              : showFinalSummary
                ? "待确认"
                : readyToSend
                  ? "可分发"
                  : "编辑中";
  const resultStateLabel = (row: DistributionRow) => {
    if (row.status !== "valid") return row.problems.join(" / ") || "需修正";
    const transaction = transactionResults.find((entry) => entry.rows.some((recipient) => recipient.line === row.line && recipient.address === row.address));
    if (transaction) return transaction.status === "pending" && sending ? "签名／确认中" : transactionStatusLabel(transaction.status);
    if (sendComplete) return "已确认";
    if (sendFailed) return "未完成";
    if (sending) return "处理中";
    if (showFinalSummary) return "待确认";
    if (preflighting) return "检查中";
    return "待分发";
  };
  const statusTitle = unresolvedSubmission
    ? "链上状态待确认"
    : sendComplete
      ? "分发完成"
      : sendFailed
        ? "分发未完成"
        : preflightFailed
          ? "检查未通过"
          : sending
            ? "正在执行"
            : preflighting
              ? "检查中"
              : showFinalSummary
                ? "待确认"
                : "清单状态";
  const statusMessage = taskHistory.needsRecoveryReview
    ? readinessMessage
    : sendState.status !== "idle"
    ? sendState.message
    : preflighting || preflightFailed || showFinalSummary
      ? preflightState.message
      : balanceLookup.status === "error" ? balanceLookup.message : readinessMessage;
  const reviewHasRisk = unresolvedSubmission || sendFailed || preflightFailed;
  const reviewShouldOpen = reviewHasRisk;
  const confirmationSummaryRows = [
    { label: "网络", value: selectedNetwork.label },
    { label: "RPC", value: effectiveRpcEndpoint },
    { label: "收款地址", value: String(parsed.validRows.length) },
    { label: "分发总额", value: `${parsed.total} SOL` },
    { label: "预估手续费", value: `${formatLamports(preflightState.estimatedFeeLamports || 0n)} SOL` },
    { label: "预计总扣款", value: `${formatLamports(preflightState.requiredLamports || parsed.totalLamports)} SOL` },
    { label: "钱包余额", value: `${formatLamports(preflightState.balanceLamports || 0n)} SOL` },
    { label: "预计交易数", value: String(preflightState.transactionCount) },
    { label: "地址抽样", value: parsed.validRows.slice(0, 3).map((row) => shortenAddress(row.address)).join(" / ") }
  ];

  const taskRecords = (<>

          <div className="flex min-w-0 flex-col gap-4">
            <ResultTable
              caption="SOL 分发清单状态"
              columns={[
                {
                  header: "地址",
                  key: "address",
                  render: (row) => <span className="font-mono">{row.address || "--"}</span>
                },
                {
                  header: "金额",
                  key: "amount",
                  render: (row) => <span className="font-mono tabular-nums">{row.amountRaw || "--"} SOL</span>
                },
                {
                  header: "状态",
                  key: "status",
                  render: (row) => <Badge variant="outline">{resultStateLabel(row)}</Badge>
                },
                {
                  header: "交易",
                  key: "transaction",
                  render: (row) => {
                    const transaction = transactionResults.find((entry) => entry.rows.some((recipient) => recipient.line === row.line && recipient.address === row.address));
                    return transaction?.signature
                      ? <a className="hash" href={getExplorerUrl(transaction.signature, networkId)} rel="noreferrer" target="_blank" title={transaction.signature}>{shortenAddress(transaction.signature)}</a>
                      : "—";
                  }
                }
              ]}
              emptyLabel="暂无清单"
              getRowKey={(row, index) => `${row.line}-${row.address}-${index}`}
              rows={parsed.rows}
            />



            {sendState.progress.total > 0 ? (
              <div className="flex flex-col gap-2">
                <ExecutionProgress
                  current={sendState.progress.confirmed}
                  label="链上确认进度"
                  total={sendState.progress.total}
                />
                <div className="flex flex-wrap gap-2" aria-label="交易进度详情">
                  <Badge variant="outline">已签名 {sendState.progress.signed}/{sendState.progress.total}</Badge>
                  <Badge variant="outline">已提交 {sendState.progress.submitted}/{sendState.progress.total}</Badge>
                  <Badge variant="outline">已确认 {sendState.progress.confirmed}/{sendState.progress.total}</Badge>
                </div>
              </div>
            ) : null}

            {sendState.signatures.length > 0 ? (
              <div className="flex flex-wrap gap-2" aria-label="交易哈希">
                {sendState.signatures.map((signature, index) => (
                  <a
                    className={buttonVariants({ variant: "outline" })}
                    href={getExplorerUrl(signature, networkId)}
                    key={signature}
                    rel="noreferrer"
                    target="_blank"
                  >
                    交易 {index + 1}: {shortenAddress(signature)}
                  </a>
                ))}
              </div>
            ) : null}


          </div>
  </>);

  const taskActions = (
        <ActionBar
          details={taskRecords}
          detailsAutoOpen={reviewShouldOpen}
          detailsStateKey={`${preflightState.status}:${sendState.status}:${sendState.signatures.length > 0 ? "submitted" : "local"}`}
          summary={(
            <DistributionSummary
              details={(
                <div className="summary-list">
                  <div><span>预计交易</span><strong>{preflightState.status === "success" ? preflightState.transactionCount : transactionCount || 0}</strong></div>
                  <div><span>钱包余额</span><strong>{walletBalance}{wallet.connected && balanceLookup.status === "success" ? " SOL" : ""}</strong></div>
                  {preflightState.requiredLamports !== null ? <div><span>预计总扣款</span><strong>{formatLamports(preflightState.requiredLamports)} SOL</strong></div> : null}
                </div>
              )}
              rows={[
                { label: "有效地址", value: parsed.validRows.length },
                { label: "合计金额", value: `${parsed.total} SOL` },
                ...(invalidCount > 0 ? [{ alert: true, label: "需修正", onClick: () => generatorRef.current?.focusProblem("invalid"), value: invalidCount }] : []),
                ...(duplicateCount > 0 ? [{ alert: true, label: "重复地址", onClick: () => generatorRef.current?.focusProblem("duplicate"), value: duplicateCount }] : []),
                { label: "预估手续费", value: preflightState.estimatedFeeLamports === null ? "—" : `${formatLamports(preflightState.estimatedFeeLamports)} SOL` }
              ]}
            />
          )}
          secondaryActions={<>
            {balanceLookup.status === "error" ? <Button disabled={pageControlsLocked} onClick={() => setBalanceRefreshNonce((value) => value + 1)} type="button" variant="outline">重试读取</Button> : null}
            {preflightFailed && sendState.status === "idle" ? <Button onClick={resetConfirmation} type="button" variant="outline">返回修改</Button> : null}
          </>}
          feedback={(
            <div className="distribution-status" role={sendFailed || preflightFailed || balanceLookup.status === "error" ? "alert" : "status"} aria-live={sendFailed || preflightFailed || balanceLookup.status === "error" ? "assertive" : "polite"}>
              <Badge variant={sendFailed || preflightFailed ? "destructive" : "outline"}>{statusTitle}</Badge>
              <WorkflowFeedback requirement={{ message: statusMessage, targetId: !sending && !preflighting && !sendComplete && !sendFailed && !showFinalSummary && !archivedRound?.requiresAcknowledgement && !listImporting && !readyToSend ? (taskHistory.needsRecoveryReview ? "task-history-review" : !wallet.connected ? "wallet-connection" : !rpcEndpointValid ? "rpcEndpoint" : "distribution-input") : undefined }} />
              {statusMessage.length > 56 ? <HelpTooltip label="执行状态详情">{statusMessage}</HelpTooltip> : null}
              {unresolvedSubmission ? <HelpTooltip label="禁止直接重试">已有交易提交到链上，请核对交易哈希后再开始新任务。</HelpTooltip> : null}
            </div>
          )}
        >
          <div className="action-group">
            {!sendComplete && !sendFailed && !sending ? (
              <Button id="sol-distribution-start" size="lg" disabled={!readyToSend || confirmVisible} onClick={() => void prepareDistribution()} type="button">
                {preflighting ? "检查中" : listImporting ? "正在导入清单" : "开始分发"}
              </Button>
            ) : null}
            {sending ? <Button size="lg" disabled type="button">{sendState.status === "preparing" ? "检查中" : sendState.status === "awaiting-wallet" ? "等待钱包签名" : "链上确认中"}</Button> : null}
            {showFinalSummary ? (
              <>
                <ConfirmActionDialog
                  open={showFinalSummary}
                  onOpenChange={setConfirmVisible}
                  returnFocusId="sol-distribution-start"
                  hideTrigger
                  triggerSize="lg"
                  confirmLabel="确认并签名"
                  description={(
                    <ResultTable
                      caption="SOL 分发确认摘要"
                      columns={[
                        { header: "项目", key: "label", render: (row) => row.label },
                        { header: "值", key: "value", render: (row) => <span className="font-mono">{row.value}</span> }
                      ]}
                      getRowKey={(row) => row.label}
                      rows={confirmationSummaryRows}
                    />
                  )}
                  disabled={!readyToSend}
                  onConfirm={sendDistribution}
                  title="确认 SOL 批量分发"
                  triggerLabel="确认并签名"
                />
              </>
            ) : null}
            {sendComplete || sendFailed ? (
              <>
                {sendFailed && unsentDistribution ? <Button onClick={() => downloadUnsentDistribution(transactionResults)} size="lg" type="button" variant="outline">导出未发送清单（原金额）</Button> : null}
                {/* Ending a round must not depend on finding a setting to edit;
                    the list stays for the next round. */}
                <Button size="lg" onClick={resetForEdit} type="button">开始新一轮分发</Button>
              </>
            ) : null}
          </div>
        </ActionBar>
  );

  return (
    <ToolPageLayout
      actions={<Badge variant="outline">{selectedNetwork.label}</Badge>}
      className="page-distributor"
      currentToolId="sol-distribution"
      walletControl={<WalletConnectionControl disabled={pageControlsLocked} wallet={wallet} />}
      status={pageStatus}
      statusLabel={pageStatusLabel}
      title="SOL 批量分发"
    >
      <div className="workbench-grid">
        <WorkbenchPanel
          footer={taskActions}
          className="min-w-0"
          segmented
          title="批量分发"
        >
          <div className="form workbench-form">
            {mixedAmountWarningVisible ? (
              <CompactNotice>
                <NoticeTitle>旧清单金额未导入</NoticeTitle>
                <NoticeDetail>已保留收款地址，请重新设置金额。</NoticeDetail>
              </CompactNotice>
            ) : null}



            <WorkbenchSection className="workbench-form__primary">
              <DistributionListGenerator
                controlRef={generatorRef}
                addressKind="solana"
                decimals={9}
                disabled={controlsLocked}
                initialAddresses={initialDistribution.addresses}
                initialFixedAmount={initialDistribution.hadAmounts ? initialDistribution.fixedAmount : "0.1"}
                onDirty={handleGeneratorDirty}
                onImportingChange={handleListImportingChange}
                onResultChange={handleGeneratedListChange}
                symbol="SOL"
              />
            </WorkbenchSection>

            <WorkbenchSection className="workbench-form__secondary" title="网络与钱包">
              <div className="network-rpc-row" aria-label="网络与 RPC">
                <Field>
                  <FieldLabel htmlFor="networkId">网络</FieldLabel>
                  <SearchableSelect
                    disabled={pageControlsLocked}
                    emptyMessage="未找到匹配的 Solana 网络"
                    id="networkId"
                    listboxLabel="Solana 网络"
                    metaLabel="网络标识"
                    metaPrefix="Cluster "
                    onChange={(nextNetworkId) => {
                      resetForEdit();
                      setNetworkId(nextNetworkId);
                      setRpcEndpoint(getNetworkConfig(nextNetworkId).endpoint);
                    }}
                    options={solanaNetworkOptions}
                    searchable={false}
                    value={networkId}
                  />
                </Field>
                <RpcSettings endpoint={effectiveRpcEndpoint} disabled={pageControlsLocked} invalid={!rpcEndpointValid}>
                <Field data-invalid={!rpcEndpointValid || undefined}>
                  <FieldLabel htmlFor="rpcEndpoint">RPC</FieldLabel>
                  <Input
                    aria-invalid={!rpcEndpointValid}
                    disabled={pageControlsLocked}
                    id="rpcEndpoint"
                    aria-describedby={!rpcEndpointValid ? "rpc-endpoint-error" : undefined}
                    onChange={(event) => {
                      resetForEdit();
                      setRpcEndpoint(event.target.value);
                    }}
                    type="url"
                    value={rpcEndpoint}
                  />
                  {!rpcEndpointValid ? <FieldError id="rpc-endpoint-error">请输入有效的 HTTP(S) RPC 地址</FieldError> : null}
                </Field>
                </RpcSettings>
              </div>
            </WorkbenchSection>
          </div>
        </WorkbenchPanel>

        {archivedRound ? (
          <ReviewPanel
            actions={archivedRound.requiresAcknowledgement ? (
              <ConfirmActionDialog
                confirmLabel="确认已核对"
                description="仅确认你已根据交易签名核对记录中的链上状态；这不会重试或撤销原交易。"
                onConfirm={() => {
                  setArchivedRound((current) => current ? { ...current, requiresAcknowledgement: false } : current);
                  const record = taskHistory.records.find((item) => item.id === archivedRound.historyRecordId);
                  if (record) taskHistory.updateRecord({ ...record, acknowledgedAt: new Date().toISOString() });
                }}
                title="已核对记录中的链上状态？"
                triggerLabel="已核对，开始新任务"
                triggerVariant="outline"
              />
            ) : null}
            className="min-w-0 collection-round-archive"
            stateKey={archivedRound.sequence}
            summary={<Badge variant={archivedRound.requiresAcknowledgement ? "destructive" : "outline"}>{archivedRound.status === "success" ? "已完成" : "需处理"} · {archivedRound.signatures.length} 笔</Badge>}
            title="分发记录"
          >
            <div className="flex min-w-0 flex-col gap-3">
              <p>{archivedRound.message}</p>
              <Badge className="w-fit" variant="outline">{archivedRound.networkLabel}</Badge>
              {getUnsentSolanaDistribution(archivedRound.transactions) ? <Button className="w-fit" onClick={() => downloadUnsentDistribution(archivedRound.transactions)} type="button" variant="outline">导出未发送清单（原金额）</Button> : null}
              <ResultTable
                caption="本轮收款地址结果"
                columns={[
                  { header: "地址", key: "address", render: (row) => <span className="address">{row.address}</span> },
                  { header: "金额", key: "amount", render: (row) => `${row.amountRaw} SOL` },
                  { header: "状态", key: "status", render: (row) => <Badge variant="outline">{transactionStatusLabel(row.transactionStatus)}</Badge> }
                ]}
                getRowKey={(row) => `${row.line}-${row.address}`}
                rows={archivedRound.transactions.flatMap((transaction) => transaction.rows.map((row) => ({ ...row, transactionStatus: transaction.status })))}
              />
              {archivedRound.signatures.length ? (
                <div className="flex flex-wrap gap-2" aria-label="分发交易哈希">
                  {archivedRound.signatures.map((signature, index) => (
                    <a
                      className={buttonVariants({ variant: "outline" })}
                      href={getExplorerUrl(signature, archivedRound.networkId)}
                      key={signature}
                      rel="noreferrer"
                      target="_blank"
                    >交易 {index + 1}: {shortenAddress(signature)}</a>
                  ))}
                </div>
              ) : null}
            </div>
          </ReviewPanel>
        ) : null}
      </div>
      <TaskHistoryPanel history={taskHistory} network={taskNetwork} rpcEndpoint={effectiveRpcEndpoint} busy={sending || preflighting} />
    </ToolPageLayout>
  );
}
