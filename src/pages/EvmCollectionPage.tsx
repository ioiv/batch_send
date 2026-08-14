import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createWalletClient, formatUnits, getAddress, http, isAddress, parseUnits, zeroAddress } from "viem";
import { CollectionSafetyNote } from "../components/CollectionIntro";
import { CollectionResults } from "../components/CollectionResults";
import { NftAssetInput } from "../components/NftAssetInput";
import { SearchableSelect, type SearchableSelectOption } from "../components/SearchableSelect";
import { SecretKeyInput, type SecretKeyInputHandle } from "../components/SecretKeyInput";
import { ToolPageLayout, type ToolPageStep } from "../components/ToolPageLayout";
import {
  executeEvmCollectionPlan,
  parseEvmCollectionAssets,
  parseEvmPrivateKeyInput,
  planEvmCollection,
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

type CollectionStage = "editing" | "scanning" | "ready" | "running" | "complete" | "error";

const evmCollectionSteps: ToolPageStep[] = [
  { label: "配置来源", description: "选择网络、资产与目标" },
  { label: "扫描预览", description: "读取余额并模拟交易" },
  { label: "确认归集", description: "本地签名并跟踪结果" }
];

function shorten(value: string, edge = 6) {
  return value.length > edge * 2 + 1 ? `${value.slice(0, edge)}…${value.slice(-edge)}` : value;
}

function getAssetName(item: EvmCollectionPlanItem) {
  if (item.asset.standard === "erc20") {
    return item.metadata?.symbol || `ERC20 ${shorten(item.asset.contractAddress, 4)}`;
  }
  return `${item.asset.standard.toUpperCase()} #${item.asset.tokenId}`;
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
  const [assetInput, setAssetInput] = useState("");
  const [discoveryContract, setDiscoveryContract] = useState("");
  const [discoveryIssues, setDiscoveryIssues] = useState<string[]>([]);
  const [discoveryMessage, setDiscoveryMessage] = useState("");
  const [discoveryRunning, setDiscoveryRunning] = useState(false);
  const [assetImporting, setAssetImporting] = useState(false);
  const [keyImporting, setKeyImporting] = useState(false);
  const [errorStep, setErrorStep] = useState<0 | 1 | 2>(0);
  const [maxFeeAmount, setMaxFeeAmount] = useState("0.01");
  const [nftStandard, setNftStandard] = useState<"erc721" | "erc1155">("erc721");
  const [nftInputResetNonce, setNftInputResetNonce] = useState(0);
  const [stage, setStage] = useState<CollectionStage>("editing");
  const [message, setMessage] = useState("");
  const [issues, setIssues] = useState<string[]>([]);
  const [results, setResults] = useState<CollectionDisplayResult[]>([]);
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
  const readyCount = planRef.current.filter((item) => item.status === "ready").length;
  const transactionRunning = stage === "scanning" || stage === "running";
  const operationRunning = transactionRunning || discoveryRunning;
  const running = operationRunning || assetImporting || keyImporting;
  const activeStep = stage === "error"
    ? errorStep
    : stage === "editing" ? 0 : stage === "scanning" || stage === "ready" ? 1 : 2;
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

  const parseMaximumFee = () => {
    try {
      const value = parseUnits(maxFeeAmount.trim(), selectedNetwork.nativeCurrency.decimals);
      return value > 0n ? value : null;
    } catch {
      return null;
    }
  };

  const invalidatePlan = (clearResults = true) => {
    if (operationRef.current || transactionRunning) return;
    planRef.current = [];
    setConfirmed(false);
    setDiscoveryMessage("");
    setDiscoveryIssues([]);
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
    rememberPreferredEvmDistributionNetwork(value);
    invalidatePlan();
  };

  const scanAssets = async () => {
    if (operationRef.current || assetImportingRef.current || keyImportingRef.current || running) return;
    operationRef.current = true;
    setIssues([]);
    setMessage("");
    setConfirmed(false);
    planRef.current = [];
    setResults([]);

    const nextIssues: string[] = [];
    if (!isAddress(targetAddress.trim())) nextIssues.push("目标地址不是有效的 EVM 地址");
    else if (getAddress(targetAddress.trim()) === zeroAddress) nextIssues.push("目标地址不能是零地址，以免资产被销毁");
    if (!effectiveRpcEndpoint) nextIssues.push("请输入可用的 RPC 地址");
    if (parseMaximumFee() === null) nextIssues.push("单笔最大网络费需要是大于 0 的有效金额");

    const parsedAccounts = parseEvmPrivateKeyInput(keyInputRef.current?.read() || "");
    if (!parsedAccounts.accounts.length) nextIssues.push("至少需要一个有效的来源钱包私钥");
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

    if (nextIssues.length) {
      operationRef.current = false;
      setIssues(nextIssues);
      setStage("error");
      setErrorStep(0);
      setMessage("请修正输入后重新扫描");
      return;
    }

    keyInputRef.current?.clear();

    setStage("scanning");
    setMessage(`正在通过 ${selectedNetwork.label} RPC 读取资产与所有权`);

    try {
      const publicClient = createEvmPublicClient(selectedNetwork, effectiveRpcEndpoint);
      await assertEvmRpcNetwork(publicClient, selectedNetwork);
      const plan = await planEvmCollection({
        accounts: parsedAccounts.accounts,
        assets: parsedAssets.validAssets,
        publicClient
      });
      planRef.current = plan;
      setResults(plan.map(planItemToDisplay));

      const executable = plan.filter((item) => item.status === "ready").length;
      const failed = plan.filter((item) => item.status === "failed").length;
      if (!executable) {
        planRef.current = [];
        setStage("error");
        setErrorStep(1);
        setMessage(failed ? "资产检查完成，但没有可执行项；请查看失败原因" : "所有资产余额为 0 或不属于已导入钱包");
        return;
      }

      setStage("ready");
      setMessage(`扫描完成：${executable} 笔可归集，${plan.length - executable} 笔将跳过或需要修正`);
    } catch (error) {
      planRef.current = [];
      keyInputRef.current?.clear();
      setStage("error");
      setErrorStep(1);
      const detail = error instanceof Error ? error.message : "RPC 请求失败";
      setMessage(detail.includes("RPC 网络不匹配") ? detail : "资产扫描失败，请检查网络、RPC 与合约地址");
    } finally {
      operationRef.current = false;
    }
  };

  const discoverOwnedErc721 = async () => {
    if (operationRef.current || assetImportingRef.current || keyImportingRef.current
      || running || fixedStandard !== "nft" || standard !== "erc721") return;
    setDiscoveryIssues([]);
    if (assetInput.trim()) {
      const existingAssets = parseEvmCollectionAssets(assetInput, "erc721");
      if (existingAssets.rows.some((row) => row.status === "invalid")) {
        setDiscoveryMessage("当前资产清单仍有格式错误，请先修正后再自动发现，避免覆盖未完成的输入");
        return;
      }
    }
    const discoverySources = (() => {
      const parsedAccounts = parseEvmPrivateKeyInput(keyInputRef.current?.read() || "");
      return {
        issueCount: parsedAccounts.issues.length,
        ownerAddresses: parsedAccounts.accounts.map((account) => account.address)
      };
    })();
    if (!discoverySources.ownerAddresses.length) {
      setDiscoveryMessage("请先粘贴或导入至少一个有效来源钱包密钥；自动发现只读取派生地址，不会提交交易");
      keyInputRef.current?.focus();
      return;
    }
    if (!isAddress(discoveryContract.trim())) {
      setDiscoveryMessage("请输入有效的 ERC721 合约地址");
      return;
    }
    const discoveryWorkloadIssues = validateEvmCollectionWorkload({
      accountCount: discoverySources.ownerAddresses.length,
      assetCount: 1,
      standard: "erc721"
    });
    if (discoveryWorkloadIssues.length) {
      setDiscoveryIssues(discoveryWorkloadIssues);
      setDiscoveryMessage("来源钱包数量超过自动发现的安全上限，已在发起 RPC 前阻止");
      return;
    }

    operationRef.current = true;
    setDiscoveryRunning(true);
    setDiscoveryMessage(`正在检查 ERC721Enumerable 并扫描 ${discoverySources.ownerAddresses.length} 个来源地址`);
    try {
      const publicClient = createEvmPublicClient(selectedNetwork, effectiveRpcEndpoint);
      await assertEvmRpcNetwork(publicClient, selectedNetwork);
      const discovery = await discoverEnumerableErc721Assets({
        contractAddress: discoveryContract.trim(),
        onProgress: (progress) => {
          if (progress.stage === "reading-token") {
            setDiscoveryMessage(`正在扫描来源 ${progress.ownerIndex + 1}/${progress.ownerTotal} · 已发现 ${progress.discovered} 个 NFT`);
          }
        },
        ownerAddresses: discoverySources.ownerAddresses,
        publicClient
      });
      const formattedDiscoveryIssues = discovery.issues.map((issue) => (
        `${issue.ownerAddress ? `来源 ${shorten(issue.ownerAddress)}` : "合约检查"}：${issue.message}`
      ));
      if (discoverySources.issueCount) {
        formattedDiscoveryIssues.push(`密钥输入中有 ${discoverySources.issueCount} 行未通过校验，未纳入发现范围`);
      }
      setDiscoveryIssues(formattedDiscoveryIssues);
      if (!discovery.assets.length) {
        setDiscoveryMessage(discovery.issues[0]?.message || "来源钱包在该合约中没有可发现的 NFT");
        return;
      }

      const existingCount = assetInput.trim()
        ? parseEvmCollectionAssets(assetInput, "erc721").validAssets.length
        : 0;
      const discoveredLines = discovery.assets.map((asset) => `${asset.contractAddress},${asset.tokenId}`).join("\n");
      const parsedCombined = parseEvmCollectionAssets([assetInput, discoveredLines].filter(Boolean).join("\n"), "erc721");
      setAssetInput(parsedCombined.validAssets.map((asset) => (
        asset.standard === "erc721" ? `${asset.contractAddress},${asset.tokenId}` : ""
      )).filter(Boolean).join("\n"));
      planRef.current = [];
      setConfirmed(false);
      setIssues([]);
      setMessage("");
      setResults([]);
      setStage("editing");
      setErrorStep(0);
      const addedCount = Math.max(0, parsedCombined.validAssets.length - existingCount);
      const incomplete = formattedDiscoveryIssues.length > 0;
      setDiscoveryMessage(
        `已发现 ${discovery.assets.length} 个 NFT，实际新增 ${addedCount} 个${incomplete ? `；发现结果可能不完整，请核对下方 ${formattedDiscoveryIssues.length} 项提示` : ""}`
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : "RPC 请求失败";
      setDiscoveryMessage(detail.includes("RPC 网络不匹配") ? detail : "自动发现失败，请检查网络、RPC 与合约；仍可使用手工 Token ID");
    } finally {
      operationRef.current = false;
      setDiscoveryRunning(false);
    }
  };

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
    setMessage(`正在执行 ${readyCount} 笔归集；请勿关闭页面`);

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
      setMessage(`执行结束：${success} 笔确认成功${failed ? `，${failed} 笔失败` : ""}`);
    } catch {
      setStage("error");
      setErrorStep(2);
      setMessage("归集流程意外中断；请先按已显示的交易哈希核对链上状态，再决定是否重试");
    } finally {
      operationRef.current = false;
      planRef.current = [];
      setConfirmed(false);
    }
  };

  return (
    <ToolPageLayout
      activeStep={activeStep}
      categoryHref="/#collection"
      categoryLabel="资产归集"
      currentToolId={currentToolId}
      description={fixedStandard === "erc20"
        ? "批量读取来源钱包的 ERC20 余额，模拟每笔转账后再使用本地签名逐项归集。"
        : "校验 ERC721 所有权或 ERC1155 余额，模拟通过后再逐项签名归集。"}
      eyebrow={fixedStandard === "erc20" ? "Many to one · ERC20" : "Many to one · NFT"}
      mainClassName="collection-shell collection-page"
      meta={<><span className="pill network-pill">{selectedNetwork.label}</span><span className="pill">密钥仅在本地内存</span></>}
      steps={evmCollectionSteps}
      title={fixedStandard === "erc20" ? "ERC20 代币归集" : "EVM NFT 归集"}
    >
        <div className={`workspace collection-workspace${results.length ? " has-results" : ""}`}>
          <section className="panel" aria-labelledby="collection-config-title">
            <div className="panel-header">
              <div>
                <h2 className="panel-title" id="collection-config-title">归集配置</h2>
                <p className="panel-note">全部输入校验通过后密钥框会立即清空，签名对象仅保留在当前任务内存中。</p>
              </div>
            </div>
            <div className="form collection-form">
              <div className="collection-config-grid">
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
                        setNftStandard(event.target.value as "erc721" | "erc1155");
                        setNftInputResetNonce((current) => current + 1);
                        invalidatePlan();
                      }}
                      value={nftStandard}
                    >
                      <option value="erc721">ERC721</option>
                      <option value="erc1155">ERC1155</option>
                    </select>
                  </div>
                ) : null}
                <div className="field full">
                  <label htmlFor="evm-collection-rpc">RPC 地址</label>
                  <input
                    disabled={running}
                    id="evm-collection-rpc"
                    onChange={(event) => {
                      setRpcEndpoint(event.target.value);
                      invalidatePlan();
                    }}
                    spellCheck={false}
                    type="url"
                    value={rpcEndpoint}
                  />
                </div>
                <div className="field full">
                  <label htmlFor="evm-collection-target">目标钱包</label>
                  <input
                    autoCapitalize="none"
                    autoComplete="off"
                    disabled={running}
                    id="evm-collection-target"
                    onChange={(event) => {
                      setTargetAddress(event.target.value);
                      invalidatePlan();
                    }}
                    placeholder="0x…"
                    spellCheck={false}
                    value={targetAddress}
                  />
                </div>
                <div className="field full">
                  <label htmlFor="evm-collection-max-fee">
                    单笔最大网络费（{selectedNetwork.nativeCurrency.symbol}）
                  </label>
                  <input
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
                  <p className="hint">每笔交易会显式设置 Gas 限额和 Gas Price；估算超过此上限时硬性阻止提交。</p>
                </div>
              </div>

              <div className="field">
                <label htmlFor="evm-collection-assets">资产清单</label>
                {fixedStandard === "nft" ? (
                  <div className="nft-input-modes">
                    <NftAssetInput
                      contractAddress={discoveryContract}
                      disabled={operationRunning || keyImporting}
                      key={nftInputResetNonce}
                      onChange={(value) => {
                        setAssetInput(value);
                        invalidatePlan();
                      }}
                      onContractAddressChange={(value) => {
                        setDiscoveryContract(value);
                        setDiscoveryMessage("");
                        setDiscoveryIssues([]);
                      }}
                      onImportingChange={handleAssetImportingChange}
                      value={assetInput}
                    />
                    {standard === "erc721" ? (
                      <section className="nft-discovery-card" aria-labelledby="nft-discovery-title">
                        <div>
                          <h3 id="nft-discovery-title">按来源钱包自动发现</h3>
                          <p>适用于实现 ERC721Enumerable 的合约；普通 ERC721 请使用上方 Token ID。</p>
                        </div>
                        <div className="nft-discovery-action">
                          <button className="button ghost" disabled={running || !discoveryContract.trim()} onClick={() => void discoverOwnedErc721()} type="button">
                            {discoveryRunning ? "发现中" : "发现来源钱包 NFT"}
                          </button>
                        </div>
                        {discoveryMessage ? <p className="hint" role="status">{discoveryMessage}</p> : null}
                        {discoveryIssues.length ? (
                          <ul className="nft-discovery-issues" role="alert">
                            {discoveryIssues.slice(0, 8).map((issue, index) => <li key={`${issue}-${index}`}>{issue}</li>)}
                            {discoveryIssues.length > 8 ? <li>另有 {discoveryIssues.length - 8} 项提示；建议分批发现并与链上资产清单核对。</li> : null}
                          </ul>
                        ) : null}
                      </section>
                    ) : null}
                  </div>
                ) : null}
                <textarea
                  className="collection-asset-textarea"
                  disabled={running}
                  id="evm-collection-assets"
                  onChange={(event) => {
                    setAssetInput(event.target.value);
                    invalidatePlan();
                  }}
                  placeholder={standard === "erc20"
                    ? "每行一个 ERC20 合约地址\n0x…"
                    : "快速添加或导入后会生成：\nNFT 合约地址,Token ID"}
                  spellCheck={false}
                  value={assetInput}
                />
                <p className="hint">
                  {standard === "erc1155"
                    ? "ERC1155 会读取每个来源钱包的完整余额并全部归集；也可以直接编辑生成后的清单。"
                    : standard === "erc721"
                      ? "ERC721 会自动查找每个 Token ID 的实际 owner；未导入 owner 密钥的条目会跳过。"
                      : "余额为 0 的来源会跳过；当前版本按 Token 合约逐项归集。"}
                </p>
              </div>

              <SecretKeyInput
                disabled={operationRunning || assetImporting}
                mode="evm"
                onDirty={() => invalidatePlan()}
                onImportingChange={handleKeyImportingChange}
                ref={keyInputRef}
              />

              {issues.length ? (
                <ul className="collection-issue-list" aria-label="输入问题" role="alert">
                  {issues.map((issue, index) => <li key={`${issue}-${index}`}>{issue}</li>)}
                </ul>
              ) : null}

              {message ? (
                <div className="collection-inline-status" data-status={stage === "error" ? "error" : stage === "complete" ? "success" : stage} aria-live="polite">
                  <strong>{stage === "ready" ? "等待最终确认" : stage === "complete" ? "任务已结束" : "任务状态"}</strong>
                  <p>{message}</p>
                </div>
              ) : null}

              {stage === "ready" ? (
                <div className="collection-final-confirm">
                  <strong>将执行 {readyCount} 笔独立交易</strong>
                  <p>目标：{targetAddress}</p>
                  <p>
                    网络费硬上限：每笔 {maxFeeAmount} {selectedNetwork.nativeCurrency.symbol}；全部交易最多 {(() => {
                      const maximumFee = parseMaximumFee();
                      return maximumFee === null
                        ? "—"
                        : formatUnits(maximumFee * BigInt(readyCount), selectedNetwork.nativeCurrency.decimals);
                    })()} {selectedNetwork.nativeCurrency.symbol}
                  </p>
                  <label className="collection-confirm-check">
                    <input checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} type="checkbox" />
                    <span>我已核对网络、目标地址和下方资产明细，并理解交易一旦确认不可撤销。</span>
                  </label>
                </div>
              ) : null}

              <div className="actions collection-actions">
                <button className="button ghost" disabled={running} onClick={() => {
                  keyInputRef.current?.clear();
                  planRef.current = [];
                  setAssetInput("");
                  setDiscoveryContract("");
                  setDiscoveryIssues([]);
                  setDiscoveryMessage("");
                  setNftInputResetNonce((current) => current + 1);
                  setTargetAddress("");
                  setMaxFeeAmount("0.01");
                  setResults([]);
                  setIssues([]);
                  setMessage("");
                  setConfirmed(false);
                  setStage("editing");
                  setErrorStep(0);
                }} type="button">清空任务</button>
                {stage === "ready" ? (
                  <button className="button primary" disabled={!confirmed || running} onClick={executeCollection} type="button">确认并开始归集</button>
                ) : (
                  <button className="button primary" disabled={running} onClick={scanAssets} type="button">
                    {stage === "scanning" ? "正在扫描" : "扫描资产"}
                  </button>
                )}
              </div>

              <CollectionSafetyNote />
            </div>
          </section>

          <CollectionResults
            emptyMessage="填写目标地址、资产清单和来源钱包后，先扫描生成不含密钥的预览。"
            exportFilename={`${currentToolId}-results.csv`}
            results={results}
          />
        </div>
    </ToolPageLayout>
  );
}
