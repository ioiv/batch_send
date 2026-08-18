import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { DistributionListGenerator } from "../components/DistributionListGenerator";
import { SearchableSelect, type SearchableSelectOption } from "../components/SearchableSelect";
import { ToolPageLayout, type WorkbenchStatus } from "../components/ToolPageLayout";
import { WalletConnectionControl } from "../components/WalletConnectionControl";
import {
  AdvancedSettings,
  ConfirmActionDialog,
  ExecutionProgress,
  ResultTable,
  WorkbenchPanel
} from "../components/WorkbenchPrimitives";
import { useSolanaWallet } from "../hooks/useSolanaWallet";
import { shortenAddress } from "../lib/address";
import { formatLamports, formatLamportsForDisplay } from "../lib/amount";
import { getInitialDistributionInput, parseDistribution } from "../lib/distribution";
import { importDistributionInput, type GeneratedDistributionList } from "../lib/distribution-generator";
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
  const [preflightState, setPreflightState] = useState<DistributionPreflightState>(initialDistributionPreflightState);
  const [balanceLookup, setBalanceLookup] = useState<BalanceLookupState>(initialBalanceLookupState);
  const [balanceRefreshNonce, setBalanceRefreshNonce] = useState(0);
  const [listImporting, setListImporting] = useState(false);
  const [generatorRevision, setGeneratorRevision] = useState(0);
  const listImportingRef = useRef(false);
  const preflightEpochRef = useRef(0);
  const sendOperationRef = useRef(false);
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
  const unresolvedSubmission = sendFailed && sendState.signatures.length > 0;
  const controlsLocked = preflighting || sending || sendComplete || sendFailed;
  const pageControlsLocked = controlsLocked || listImporting;
  const generatedListReady = generatedList.invalid === 0 && generatedList.duplicates === 0;
  const readyToSend = wallet.connected && Boolean(wallet.provider) && rpcEndpointValid && generatedListReady && parsed.validRows.length > 0 && parsed.invalid === 0 && !preflighting && !sending && !sendComplete && !sendFailed && !listImporting;
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
  const readinessMessage = !wallet.connected || !wallet.provider
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
              : "清单可预检";

  useEffect(() => {
    if (sending || sendComplete || sendFailed) return;
    resetConfirmation();
    // Keep an in-flight transaction locked even if the wallet changes accounts.
    // eslint/react-hooks deliberately omits `sending`: completion must not clear its result.
  }, [resetConfirmation, sendComplete, sendFailed, sending, wallet.address, wallet.connected]);

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
    sendOperationRef.current = true;
    const preflightEpoch = ++preflightEpochRef.current;
    setConfirmVisible(true);
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
        message: "只读预检已通过；下方按钮才会发起钱包签名",
        requiredLamports,
        status: "success",
        transactionCount: transactions.length
      });
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
    sendOperationRef.current = true;

    const sendOptions: SendOptions = {
      preflightCommitment: "confirmed",
      skipPreflight: false
    };
    const signatures: TransactionSignature[] = [];
    let signedCount = 0;
    let confirmedCount = 0;
    let plannedTransactionCount = transactionCount;

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
        message: `余额预检查通过：分发 ${parsed.total} SOL，预估手续费 ${formatLamports(estimatedFeeLamports)} SOL`,
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

            const signature = await connection.sendRawTransaction(signedTransactions[index].serialize(), sendOptions);
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
              throw new Error(`第 ${transactionNumber} 笔交易链上执行失败：${JSON.stringify(confirmation.value.err)}`);
            }
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

          const signature = await sendWalletTransaction(wallet.provider, transaction, connection);
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
            throw new Error(`第 ${index + 1} 笔交易链上执行失败：${JSON.stringify(confirmation.value.err)}`);
          }
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
      const partialMessage = signatures.length > 0
        ? `${baseMessage}。已提交 ${signatures.length}/${plannedTransactionCount || signatures.length} 笔交易，其中 ${confirmedCount} 笔已确认；请先检查链上记录，避免重复发送。`
        : baseMessage;

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

  const startNewDistribution = () => {
    setGeneratorRevision((value) => value + 1);
    setGeneratedInput("");
    setGeneratedList(initialGeneratedList);
    setMixedAmountWarningVisible(false);
    resetConfirmation();
  };

  const pageStatus: WorkbenchStatus = unresolvedSubmission
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
  const pageStatusLabel = unresolvedSubmission
    ? "链上待核对"
    : sendComplete
      ? "分发完成"
      : sendFailed
        ? "执行失败"
        : preflightFailed
          ? "预检未通过"
          : sending
            ? sendState.status === "awaiting-wallet" ? "等待签名" : "执行中"
            : preflighting
              ? "预检中"
              : showFinalSummary
                ? "待确认"
                : readyToSend
                  ? "可预检"
                  : "编辑中";
  const resultStateLabel = (rowStatus: "valid" | "warn" | "invalid", problems: string[]) => {
    if (rowStatus !== "valid") return problems.join(" / ") || "需修正";
    if (unresolvedSubmission) return "链上状态待确认";
    if (sendComplete) return "已确认";
    if (sendFailed) return "未完成";
    if (sending) return "处理中";
    if (showFinalSummary) return "预检通过";
    if (preflighting) return "检查中";
    return "待预检";
  };
  const statusTitle = unresolvedSubmission
    ? "链上状态待确认"
    : sendComplete
      ? "分发完成"
      : sendFailed
        ? "分发未完成"
        : preflightFailed
          ? "预检未通过"
          : sending
            ? "正在执行"
            : preflighting
              ? "正在预检"
              : showFinalSummary
                ? "预检通过"
                : "清单状态";
  const statusMessage = sendState.status !== "idle"
    ? sendState.message
    : confirmVisible
      ? preflightState.message
      : readinessMessage;
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

  return (
    <ToolPageLayout
      actions={<Badge variant="outline">{selectedNetwork.label}</Badge>}
      className="page-distributor"
      currentToolId="sol-distribution"
      status={pageStatus}
      statusLabel={pageStatusLabel}
      title="SOL 批量分发"
    >
      <div className="workbench-grid">
        <WorkbenchPanel
          actions={<WalletConnectionControl disabled={pageControlsLocked} wallet={wallet} />}
          className="min-w-0"
          footer={(
            <div className="flex w-full flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-2" aria-label="分发统计">
                <Badge variant="outline">有效 {parsed.validRows.length}</Badge>
                <Badge variant="outline">合计 {parsed.total} SOL</Badge>
                <Badge variant="outline">需修正 {invalidCount}</Badge>
                <Badge variant="outline">重复 {duplicateCount}</Badge>
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                {!confirmVisible && !sendComplete && !sendFailed ? (
                  <Button disabled={!readyToSend} onClick={() => void prepareDistribution()} type="button">运行预检</Button>
                ) : null}
                {preflightFailed && sendState.status === "idle" ? (
                  <>
                    <Button disabled={!readyToSend} onClick={() => void prepareDistribution()} type="button">重新预检</Button>
                    <Button onClick={resetConfirmation} type="button" variant="outline">返回修改</Button>
                  </>
                ) : null}
                {showFinalSummary ? (
                  <>
                    <Button onClick={resetConfirmation} type="button" variant="outline">返回修改</Button>
                    <ConfirmActionDialog
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
                {sendFailed && !unresolvedSubmission ? (
                  <Button onClick={resetConfirmation} type="button" variant="outline">返回修改并重新预检</Button>
                ) : null}
                {sendComplete || unresolvedSubmission ? (
                  <ConfirmActionDialog
                    confirmLabel="清空并开始新任务"
                    description={(
                      <span>
                        当前任务包含已提交的交易哈希。清空会从当前视图移除这些记录；请先核对链上状态，且不要直接重试原任务。
                      </span>
                    )}
                    onConfirm={startNewDistribution}
                    title="清空当前 SOL 分发任务？"
                    triggerLabel="清空清单并开始新任务"
                    triggerVariant="destructive"
                  />
                ) : null}
              </div>
            </div>
          )}
          title="网络、钱包与清单"
        >
          <div className="flex min-w-0 flex-col gap-4">
            {mixedAmountWarningVisible ? (
              <Alert>
                <AlertTitle>旧清单金额未导入</AlertTitle>
                <AlertDescription>已保留收款地址，请重新设置金额。</AlertDescription>
              </Alert>
            ) : null}

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
                  setNetworkId(nextNetworkId);
                  setRpcEndpoint(getNetworkConfig(nextNetworkId).endpoint);
                  resetConfirmation();
                }}
                options={solanaNetworkOptions}
                searchable={false}
                value={networkId}
              />
            </Field>

            <div className="flex flex-wrap gap-2" aria-label="链路摘要">
              <Badge title={balanceLookup.message || undefined} variant="outline">
                余额 {walletBalance}{balanceLookup.status === "error" ? " · 读取失败" : wallet.connected ? " SOL" : ""}
              </Badge>
              <Badge variant="outline">预计交易 {transactionCount || 0}</Badge>
            </div>

            <AdvancedSettings disabled={pageControlsLocked}>
              <Field>
                <FieldLabel htmlFor="rpcEndpoint">RPC</FieldLabel>
                <Input
                  aria-invalid={!rpcEndpointValid}
                  disabled={pageControlsLocked}
                  id="rpcEndpoint"
                  onChange={(event) => {
                    setRpcEndpoint(event.target.value);
                    resetConfirmation();
                  }}
                  type="url"
                  value={rpcEndpoint}
                />
              </Field>
            </AdvancedSettings>

            {balanceLookup.status === "error" ? (
              <Alert variant="destructive">
                <AlertTitle>{!rpcEndpointValid ? "RPC 地址无效" : "余额读取失败"}</AlertTitle>
                <AlertDescription className="flex flex-col gap-2">
                  <span>{balanceLookup.message}</span>
                  <span>
                    <Button onClick={() => setBalanceRefreshNonce((value) => value + 1)} type="button" variant="outline">重试读取</Button>
                  </span>
                </AlertDescription>
              </Alert>
            ) : null}

            <DistributionListGenerator
              key={`sol-distribution-${generatorRevision}`}
              addressKind="solana"
              decimals={9}
              disabled={controlsLocked}
              initialAddresses={generatorRevision === 0 ? initialDistribution.addresses : ""}
              initialFixedAmount={generatorRevision === 0 && initialDistribution.hadAmounts ? initialDistribution.fixedAmount : "0.1"}
              onDirty={handleGeneratorDirty}
              onImportingChange={handleListImportingChange}
              onResultChange={handleGeneratedListChange}
              symbol="SOL"
            />
          </div>
        </WorkbenchPanel>

        <WorkbenchPanel
          actions={<Badge variant="outline">{transactionCount || 0} 笔交易</Badge>}
          className="min-w-0"
          title="预检与结果"
        >
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
                  render: (row) => <Badge variant="outline">{resultStateLabel(row.status, row.problems)}</Badge>
                }
              ]}
              emptyLabel="暂无清单"
              getRowKey={(row, index) => `${row.line}-${row.address}-${index}`}
              rows={parsed.rows}
            />

            <Alert
              aria-live={sendFailed || preflightFailed ? "assertive" : "polite"}
              role={sendFailed || preflightFailed ? "alert" : "status"}
              variant={sendFailed || preflightFailed ? "destructive" : "default"}
            >
              <AlertTitle>{statusTitle}</AlertTitle>
              <AlertDescription>{statusMessage}</AlertDescription>
            </Alert>

            {sendState.progress.total > 0 ? (
              <div className="flex flex-col gap-2">
                <ExecutionProgress
                  current={Math.max(sendState.progress.signed, sendState.progress.submitted, sendState.progress.confirmed)}
                  label="执行进度"
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

            {unresolvedSubmission ? (
              <Alert variant="destructive">
                <AlertTitle>禁止直接重试</AlertTitle>
                <AlertDescription>已有交易提交到链上。请先核对交易哈希，再创建空白任务。</AlertDescription>
              </Alert>
            ) : null}
          </div>
        </WorkbenchPanel>
      </div>
    </ToolPageLayout>
  );
}
