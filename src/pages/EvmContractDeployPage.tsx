import { useLayoutEffect, useRef, useState } from "react";
import { BrandHeader, NavLinks, SkipLink } from "../components/BrandHeader";
import { EvmWalletConnectionControl } from "../components/EvmWalletConnectionControl";
import { useEvmWallet } from "../hooks/useEvmWallet";
import { shortenAddress } from "../lib/address";
import {
  createXContractAddress,
  deployDisperseContract,
  disperseDeploymentCheckDefinitions,
  DisperseDeploymentValidationError,
  getDisperseDeploymentErrorMessage,
  getDisperseDeploymentExplorerUrl,
  resolveDisperseDeploymentNetwork,
  runDisperseDeploymentValidation,
  type DisperseDeploymentCheck,
  type DisperseDeploymentPreflight
} from "../lib/createx";
import {
  disperseContractAddress,
  formatWeiForDisplay,
  registerVerifiedEvmDistributionNetwork,
  type EvmChainConfig
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

const initialDeploymentState: DeploymentPageState = {
  checks: [],
  contextKey: "",
  hash: "",
  message: "填写可信的 HTTPS RPC 并连接钱包后，先执行部署前校验。",
  network: null,
  preflight: null,
  status: "idle"
};

const initialDistributionRegistrationState: DistributionRegistrationState = {
  message: "",
  status: "idle"
};

function getPendingCheckDetail(id: DisperseDeploymentCheck["id"], status: DeploymentPageStatus) {
  if (id === "receipt" || id === "runtime") return "部署交易确认后执行";
  if (status === "validating") return "等待前序校验";
  return "尚未校验";
}

function getCheckMark(status?: DisperseDeploymentCheck["status"]) {
  if (status === "pass") return "✓";
  if (status === "fail") return "×";
  if (status === "skipped") return "–";
  return "·";
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
  const [rpcEndpoint, setRpcEndpoint] = useState("");
  const [blockExplorerUrl, setBlockExplorerUrl] = useState("");
  const [deploymentState, setDeploymentState] = useState<DeploymentPageState>(initialDeploymentState);
  const [distributionChainName, setDistributionChainName] = useState("");
  const [distributionRegistration, setDistributionRegistration] = useState<DistributionRegistrationState>(initialDistributionRegistrationState);
  const wallet = useEvmWallet();

  const effectiveRpcEndpoint = rpcEndpoint.trim();
  const effectiveBlockExplorerUrl = blockExplorerUrl.trim().replace(/\/+$/, "");
  const blockExplorerUrlIsValid = isOptionalHttpsUrl(effectiveBlockExplorerUrl);
  const contextKey = `${wallet.address.toLowerCase()}|${effectiveRpcEndpoint}|${effectiveBlockExplorerUrl}`;
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
  const provider = wallet.getProvider();
  const busy = status === "validating" || status === "awaiting-wallet" || status === "confirming";
  const canValidate = wallet.connected
    && Boolean(wallet.address)
    && Boolean(provider)
    && Boolean(effectiveRpcEndpoint)
    && blockExplorerUrlIsValid
    && !busy;
  const canDeploy = canValidate && status === "ready";
  const deploymentComplete = status === "success" || status === "already-deployed";
  const explorerUrl = hash && network ? getDisperseDeploymentExplorerUrl(hash, network) : "";
  const estimatedFee = preflight && preflight.estimatedFee > 0n && network
    ? `${formatWeiForDisplay(preflight.estimatedFee, network.nativeCurrency.decimals, 8)} ${network.nativeCurrency.symbol}`
    : "--";

  const isOperationCurrent = (operationId: number, expectedContextKey: string) => (
    operationIdRef.current === operationId && latestContextKeyRef.current === expectedContextKey
  );

  const resetDeploymentState = () => {
    operationIdRef.current += 1;
    setDeploymentState(initialDeploymentState);
    setDistributionChainName("");
    setDistributionRegistration(initialDistributionRegistrationState);
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
    if (!wallet.connected || !wallet.address || !walletProvider) return;

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
      const resolvedNetwork = {
        ...discoveredNetwork,
        blockExplorerUrl: effectiveBlockExplorerUrl || discoveredNetwork.blockExplorerUrl
      };
      if (!isOperationCurrent(operationId, expectedContextKey)) return;
      updateCurrentOperation(operationId, expectedContextKey, (current) => ({
        ...current,
        message: `已识别 ${resolvedNetwork.label}，正在检查 CreateX 与目标合约`,
        network: resolvedNetwork
      }));

      const nextPreflight = await runDisperseDeploymentValidation({
        account: wallet.address,
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
          : "全部部署前校验通过。下一步会在签名前再执行一次完整校验。",
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
    if (!canDeploy || !wallet.address || !walletProvider || !network) return;

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
        network,
        onChecks: (nextChecks) => updateChecks(nextChecks, expectedContextKey, operationId),
        shouldContinue: () => isOperationCurrent(operationId, expectedContextKey),
        onStage: (stage) => {
          if (stage.type === "awaiting-wallet") {
            updateCurrentOperation(operationId, expectedContextKey, (current) => ({
              ...current,
              message: "校验通过，请在钱包中确认零转账金额的 CreateX 部署调用",
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
      ? { message: `${chainName} · Chain ID ${network.chainId} 已添加到 EVM 分发`, status: "success" }
      : { message: "浏览器未能保存链配置，请检查本地存储权限", status: "error" });
  };

  const primaryButtonLabel = !wallet.connected
    ? "先连接钱包"
    : status === "validating"
      ? "校验中"
      : status === "awaiting-wallet"
        ? "等待钱包确认"
        : status === "confirming"
          ? "等待链上确认"
          : status === "ready"
            ? "确认并部署"
            : status === "success"
              ? "部署完成"
              : status === "already-deployed"
                ? "已经部署"
                : status === "error"
                  ? "重新校验"
                  : "校验部署条件";

  return (
    <>
      <SkipLink />
      <main className="shell tool-shell page-deploy" id="main">
        <BrandHeader
          eyebrow="deterministic deploy"
          title="Disperse 合约部署"
          subtitle="填写可信的 HTTPS RPC，通过 canonical CreateX 校验并部署固定合约；页面不接触私钥。"
          nav={<NavLinks current="evmDeploy" />}
        />

        <section className="workspace deploy-workspace">
          <section className="panel deploy-panel" aria-labelledby="deploy-title">
            <div className="panel-header">
              <div>
                <h2 className="panel-title" id="deploy-title">部署配置</h2>
                <p className="panel-note">Chain ID 会从 RPC 自动识别，目标地址、salt 和 initCode 固定不可编辑。</p>
              </div>
              <span className="pill network-pill">{network ? `${network.label} · ${network.chainId}` : "RPC 自动识别"}</span>
            </div>

            <div className="form">
              <div className="batch-command">
                <div className="command-copy">
                  <span className="eyebrow">wallet gate</span>
                  <strong>{wallet.connected ? "部署钱包已连接" : wallet.status === "connecting" ? "等待钱包确认" : "连接 EVM 钱包"}</strong>
                  <span>{wallet.connected ? wallet.statusText : wallet.message || "连接后会按 RPC 的 Chain ID 切换网络、校验并签署部署交易。"}</span>
                </div>
                <EvmWalletConnectionControl wallet={wallet} />
              </div>

              <div className="transaction-options deployment-route" aria-label="部署 RPC 配置">
                <div className="route-fields deploy-route-fields">
                  <div className="field route-card rpc-field">
                    <label htmlFor="deployRpcEndpoint">主 HTTPS RPC</label>
                    <input
                      id="deployRpcEndpoint"
                      type="url"
                      inputMode="url"
                      autoComplete="off"
                      placeholder="https://your-evm-rpc.example"
                      value={rpcEndpoint}
                      disabled={busy}
                      onChange={(event) => {
                        setRpcEndpoint(event.target.value);
                        resetDeploymentState();
                      }}
                    />
                  </div>
                  <div className="field route-card rpc-field">
                    <label htmlFor="deployBlockExplorerUrl">区块浏览器地址（可选）</label>
                    <input
                      id="deployBlockExplorerUrl"
                      type="url"
                      inputMode="url"
                      autoComplete="off"
                      placeholder="https://scan.example.com"
                      value={blockExplorerUrl}
                      disabled={busy}
                      aria-invalid={!blockExplorerUrlIsValid}
                      onChange={(event) => {
                        setBlockExplorerUrl(event.target.value);
                        resetDeploymentState();
                      }}
                    />
                  </div>
                </div>
                <p className={`hint deployment-rpc-hint${blockExplorerUrlIsValid ? "" : " error"}`}>
                  {blockExplorerUrlIsValid
                    ? "部署校验和交易确认都使用主 RPC；区块浏览器留空时使用内置地址。"
                    : "区块浏览器地址必须是有效的 HTTPS URL。"}
                </p>
              </div>

              <div className="deployment-contract-card" aria-label="固定部署参数">
                <div className="summary-list">
                  <div><span>部署方式</span><strong>CreateX.deployCreate2(bytes32,bytes)</strong></div>
                  <div><span>CreateX</span><strong title={createXContractAddress}>{shortenAddress(createXContractAddress)}</strong></div>
                  <div><span>目标地址</span><strong title={disperseContractAddress}>{disperseContractAddress}</strong></div>
                  <div><span>交易 value</span><strong>0 {network?.nativeCurrency.symbol || "原生代币"}</strong></div>
                  <div><span>协议手续费</span><strong>无，仅支付网络 Gas</strong></div>
                </div>
              </div>

              <div className={`confirm transaction-status deployment-status ${status}`} aria-live="polite">
                <strong>{status === "ready"
                  ? "部署前校验通过"
                  : status === "success"
                    ? "部署与最终校验完成"
                    : status === "already-deployed"
                      ? "官方合约已经存在"
                      : status === "error"
                        ? "校验或部署未完成"
                        : busy
                          ? "正在处理部署流程"
                          : "尚未执行部署校验"}</strong>
                <span>{message}</span>
                {preflight?.status === "ready" ? (
                  <div className="summary-list deployment-estimate">
                    <div><span>最高 Gas 估算</span><strong>{preflight.estimatedGas.toLocaleString()}</strong></div>
                    <div><span>安全 Gas 上限</span><strong>{preflight.gasLimit.toLocaleString()}</strong></div>
                    <div><span>费用安全上限</span><strong>{estimatedFee}</strong></div>
                  </div>
                ) : null}
                {hash && explorerUrl ? (
                  <div className="signature-list">
                    <a href={explorerUrl} target="_blank" rel="noreferrer">部署交易：{shortenAddress(hash)}</a>
                  </div>
                ) : null}
              </div>

              {deploymentComplete && network ? (
                <div className="deployment-contract-card distribution-registration-card" aria-label="添加到 EVM 分发">
                  <div className="field">
                    <label htmlFor="distributionChainName">链名称</label>
                    <input
                      id="distributionChainName"
                      type="text"
                      value={distributionChainName}
                      placeholder={`例如：${network.label}`}
                      onChange={(event) => {
                        setDistributionChainName(event.target.value);
                        setDistributionRegistration(initialDistributionRegistrationState);
                      }}
                    />
                  </div>
                  <p className="hint">Chain ID {network.chainId}。点击“添加到 EVM 分发”后，将保存链名称、主 RPC 和区块浏览器地址。</p>
                  {distributionRegistration.message ? (
                    <p className={`hint distribution-registration-message ${distributionRegistration.status}`} role="status">{distributionRegistration.message}</p>
                  ) : null}
                </div>
              ) : null}

              <div className="actions">
                <div className="action-group">
                  <button
                    className="button primary"
                    type="button"
                    disabled={!canValidate || deploymentComplete}
                    onClick={() => {
                      if (canDeploy) void deployContract();
                      else void runValidation();
                    }}
                  >
                    {primaryButtonLabel}
                  </button>
                  {status === "ready" ? (
                    <button className="button ghost" type="button" disabled={busy} onClick={() => void runValidation()}>重新校验</button>
                  ) : null}
                  {deploymentComplete ? (
                    <button className="button primary" type="button" disabled={!distributionChainName.trim()} onClick={addToEvmDistribution}>添加到 EVM 分发</button>
                  ) : null}
                  {deploymentComplete ? <a className="button ghost" href="/evm/">前往 EVM 分发</a> : null}
                </div>
              </div>
            </div>
          </section>

          <aside className="panel review-panel deployment-review" aria-labelledby="deployment-checks-title">
            <div className="panel-header">
              <div>
                <h2 className="panel-title" id="deployment-checks-title">部署校验</h2>
                <p className="panel-note">任何一项失败都会阻止签名；签名前会重新检查，确认后再验 runtime。</p>
              </div>
            </div>
            <div className="form">
              <div className="deployment-check-list">
                {disperseDeploymentCheckDefinitions.map((definition) => {
                  const check = checks.find((item) => item.id === definition.id);
                  const checkStatus = check?.status || "pending";
                  return (
                    <div className={`deployment-check ${checkStatus}`} key={definition.id}>
                      <span className="deployment-check-mark" aria-hidden="true">{getCheckMark(check?.status)}</span>
                      <span className="deployment-check-copy">
                        <strong>{definition.label}</strong>
                        <span>{check?.detail || getPendingCheckDetail(definition.id, status)}</span>
                      </span>
                    </div>
                  );
                })}
              </div>

              <div className="notice deployment-safety-note">
                <strong>签名前核对</strong>
                <span>钱包弹窗的交互地址必须是 {createXContractAddress}，发送金额必须为 0。页面不会要求 Token 授权。</span>
              </div>
            </div>
          </aside>
        </section>
      </main>
    </>
  );
}
