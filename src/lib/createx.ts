import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeAbiParameters,
  formatUnits,
  getAddress,
  getCreate2Address,
  http,
  keccak256,
  parseAbi,
  parseEventLogs,
  slice,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type TransactionReceipt
} from "viem";
import viemPackage from "viem/package.json";
import type { EvmWalletProvider } from "../hooks/useEvmWallet";
import {
  createEvmPublicClient,
  disperseContractAddress,
  disperseContractRuntimeCodeHash,
  ensureEvmNetwork,
  evmNetworks,
  isEvmNativeCurrencyEnabled,
  toEvmChain,
  unconfirmedEvmNativeCurrency,
  type EvmNativeCurrency,
  type EvmNativeCurrencyMetadata,
  type EvmChainConfig
} from "./evm";
import {
  autoEvmGasSettings,
  getEvmFeeCapPerGas,
  getEvmFeeRequest,
  resolveEvmFeeQuote,
  type EvmFeeParameters,
  type EvmGasSettings
} from "./evm-gas";

const deploymentNetworkMetadata: EvmChainConfig[] = [
  {
    blockExplorerUrl: "https://explorer.arc.io",
    chainId: 5042,
    label: "Arc Mainnet",
    nativeCurrency: { decimals: 18, name: "USD Coin", symbol: "USDC" },
    rpcEndpoint: ""
  },
  {
    blockExplorerUrl: "https://testnet.arcscan.app",
    chainId: 5042002,
    label: "Arc Testnet",
    nativeCurrency: { decimals: 18, name: "USD Coin", symbol: "USDC" },
    rpcEndpoint: ""
  }
];

export const createXContractAddress = "0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed" as const;
export const createXContractRuntimeCodeHash = "0xbd8a7ea8cfca7b4e5f5041d7d4b17bc317c5ce42cfbc42066a00cf26b43eb53f" as const;
export const viemChainRegistryVersion = viemPackage.version;

// Exact deployCreate2 inputs recovered from the matching Ethereum and Base deployments:
// Ethereum 0x66a4f4e092c49ff34bc398a89140d6c952dc3986e9ac80548bd5f4f6c2bcc277
// Base    0x973b5b54434b179a47d2d14c4536e00c06a4d98ce82ce99014d56eb331b20889
export const disperseContractRawSalt = "0xfd73487f4e6544007a3ce4000000000000000000000000000000000000000000" as const;
export const disperseContractGuardedSalt = "0x19cd5d46c8b63947efed82be23a93bbadbbae17233ffcfd997e76f1d685ae907" as const;
export const disperseContractInitCodeHash = "0xe6f14431f428093244b0ab2395af461c71dda8dbc08e254772cad420928499ad" as const;
export const disperseSaltSenderPrefix = "0xfd73487f4e6544007a3ce4000000000000000000" as const;

export const disperseContractInitCode = "0x608060405234801561001057600080fd5b506106f4806100206000396000f300608060405260043610610057576000357c0100000000000000000000000000000000000000000000000000000000900463ffffffff16806351ba162c1461005c578063c73a2d60146100cf578063e63d38ed14610142575b600080fd5b34801561006857600080fd5b506100cd600480360381019080803573ffffffffffffffffffffffffffffffffffffffff169060200190929190803590602001908201803590602001919091929391929390803590602001908201803590602001919091929391929390505050610188565b005b3480156100db57600080fd5b50610140600480360381019080803573ffffffffffffffffffffffffffffffffffffffff169060200190929190803590602001908201803590602001919091929391929390803590602001908201803590602001919091929391929390505050610309565b005b6101866004803603810190808035906020019082018035906020019190919293919293908035906020019082018035906020019190919293919293905050506105b0565b005b60008090505b84849050811015610301578573ffffffffffffffffffffffffffffffffffffffff166323b872dd3387878581811015156101c457fe5b9050602002013573ffffffffffffffffffffffffffffffffffffffff1686868681811015156101ef57fe5b905060200201356040518463ffffffff167c0100000000000000000000000000000000000000000000000000000000028152600401808473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1681526020018373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1681526020018281526020019350505050602060405180830381600087803b1580156102ae57600080fd5b505af11580156102c2573d6000803e3d6000fd5b505050506040513d60208110156102d857600080fd5b810190808051906020019092919050505015156102f457600080fd5b808060010191505061018e565b505050505050565b60008060009150600090505b8585905081101561034657838382818110151561032e57fe5b90506020020135820191508080600101915050610315565b8673ffffffffffffffffffffffffffffffffffffffff166323b872dd3330856040518463ffffffff167c0100000000000000000000000000000000000000000000000000000000028152600401808473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1681526020018373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1681526020018281526020019350505050602060405180830381600087803b15801561041d57600080fd5b505af1158015610431573d6000803e3d6000fd5b505050506040513d602081101561044757600080fd5b8101908080519060200190929190505050151561046357600080fd5b600090505b858590508110156105a7578673ffffffffffffffffffffffffffffffffffffffff1663a9059cbb878784818110151561049d57fe5b9050602002013573ffffffffffffffffffffffffffffffffffffffff1686868581811015156104c857fe5b905060200201356040518363ffffffff167c0100000000000000000000000000000000000000000000000000000000028152600401808373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200182815260200192505050602060405180830381600087803b15801561055457600080fd5b505af1158015610568573d6000803e3d6000fd5b505050506040513d602081101561057e57600080fd5b8101908080519060200190929190505050151561059a57600080fd5b8080600101915050610468565b50505050505050565b600080600091505b858590508210156106555785858381811015156105d157fe5b9050602002013573ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff166108fc858585818110151561061557fe5b905060200201359081150290604051600060405180830381858888f19350505050158015610647573d6000803e3d6000fd5b5081806001019250506105b8565b3073ffffffffffffffffffffffffffffffffffffffff1631905060008111156106c0573373ffffffffffffffffffffffffffffffffffffffff166108fc829081150290604051600060405180830381858888f193505050501580156106be573d6000803e3d6000fd5b505b5050505050505600a165627a7a723058204f25a733917e0bf639cd1e101d55bd927f843fb395fb2a963a7909c09ae023ed0029" as const;

const createXAbi = parseAbi([
  "event ContractCreation(address indexed newContract, bytes32 indexed salt)",
  "function computeCreate2Address(bytes32 salt, bytes32 initCodeHash) view returns (address computedAddress)",
  "function deployCreate2(bytes32 salt, bytes initCode) payable returns (address newContract)"
]);

export type ContractCodeState = "absent" | "expected" | "unexpected";

export type DisperseDeploymentCheckId =
  | "artifacts"
  | "rpc"
  | "wallet"
  | "factory"
  | "address"
  | "target"
  | "simulation"
  | "balance"
  | "receipt"
  | "runtime";

export type DisperseDeploymentCheck = {
  detail: string;
  id: DisperseDeploymentCheckId;
  label: string;
  status: "pass" | "fail" | "skipped";
};

export const disperseDeploymentCheckDefinitions: Array<Pick<DisperseDeploymentCheck, "id" | "label">> = [
  { id: "artifacts", label: "固定部署产物" },
  { id: "rpc", label: "RPC 与 Chain ID" },
  { id: "wallet", label: "钱包网络" },
  { id: "factory", label: "CreateX 官方字节码" },
  { id: "address", label: "CREATE2 预计算地址" },
  { id: "target", label: "目标地址状态" },
  { id: "simulation", label: "部署调用模拟" },
  { id: "balance", label: "Gas 余额" },
  { id: "receipt", label: "交易回执事件" },
  { id: "runtime", label: "部署后 runtime" }
];

export type DisperseDeploymentPreflight = {
  checks: DisperseDeploymentCheck[];
  estimatedFee: bigint;
  estimatedGas: bigint;
  feeCapPerGas: bigint;
  feeParameters: DisperseDeploymentFeeParameters | null;
  gasLimit: bigint;
  status: "ready" | "already-deployed";
  targetState: ContractCodeState;
};

export type DisperseDeploymentFeeParameters = EvmFeeParameters;

export type DisperseDeploymentNetworkDiscovery = {
  blockExplorerUrl: string;
  chainId: number;
  label: string;
  metadataCandidates: DisperseDeploymentNetworkMetadataCandidate[];
  metadataSource: "built-in" | "viem" | "unavailable";
  metadataStatus: "confirmed" | "suggested" | "conflict" | "unavailable";
  nativeCurrency: EvmChainConfig["nativeCurrency"] | null;
  sourceVersion: string;
  rpcEndpoint: string;
};

export type DisperseDeploymentNetworkMetadataCandidate = {
  blockExplorerUrl: string;
  key: string;
  label: string;
  nativeCurrency: EvmNativeCurrency;
};

export type DisperseDeploymentNetworkMetadataInput = {
  chainName: string;
  nativeCurrencyDecimals: number | string;
  nativeCurrencyName: string;
  nativeCurrencySymbol: string;
};

export type FinalizeDisperseDeploymentNetworkOptions = {
  manualMetadata?: DisperseDeploymentNetworkMetadataInput;
  nativeCurrencyConfirmed?: boolean;
  selectedCandidateKey?: string;
  useManualMetadata?: boolean;
};

export type DisperseDeploymentStage =
  | { preflight: DisperseDeploymentPreflight; type: "awaiting-wallet" }
  | { hash: Hash; type: "submitted" }
  | { hash: Hash; receipt: TransactionReceipt; type: "confirmed" }
  | { hash: Hash; receipt: TransactionReceipt; type: "verified" };

type RunDisperseDeploymentValidationArgs = {
  account: string;
  gasSettings?: EvmGasSettings;
  network: EvmChainConfig;
  onChecks?: (checks: DisperseDeploymentCheck[]) => void;
  provider: EvmWalletProvider;
  rpcEndpoint: string;
  shouldContinue?: () => boolean;
};

type DeployDisperseContractArgs = RunDisperseDeploymentValidationArgs & {
  onStage?: (stage: DisperseDeploymentStage) => void;
};

export class DisperseDeploymentValidationError extends Error {
  checks: DisperseDeploymentCheck[];

  constructor(message: string, checks: DisperseDeploymentCheck[]) {
    super(message);
    this.name = "DisperseDeploymentValidationError";
    this.checks = checks;
  }
}

function upsertCheck(checks: DisperseDeploymentCheck[], check: DisperseDeploymentCheck) {
  const nextChecks = checks.filter((item) => item.id !== check.id);
  const order = new Map(disperseDeploymentCheckDefinitions.map((definition, index) => [definition.id, index]));
  return [...nextChecks, check].sort((left, right) => (order.get(left.id) || 0) - (order.get(right.id) || 0));
}

function createCheckReporter(onChecks?: (checks: DisperseDeploymentCheck[]) => void) {
  let checks: DisperseDeploymentCheck[] = [];

  const report = (check: DisperseDeploymentCheck) => {
    checks = upsertCheck(checks, check);
    onChecks?.([...checks]);
  };

  const fail = (id: DisperseDeploymentCheckId, label: string, detail: string): never => {
    report({ detail, id, label, status: "fail" });
    throw new DisperseDeploymentValidationError(detail, [...checks]);
  };

  return {
    fail,
    getChecks: () => [...checks],
    report
  };
}

function getErrorDetail(error: unknown) {
  return error && typeof error === "object" && "message" in error
    ? String((error as { message?: unknown }).message || "")
    : String(error || "");
}

function parseWalletChainId(value: unknown) {
  if (typeof value !== "string" || !/^0x[\da-f]+$/i.test(value)) return Number.NaN;
  return Number.parseInt(value, 16);
}

function assertHttpsRpcEndpoint(rpcEndpoint: string) {
  let url: URL;
  try {
    url = new URL(rpcEndpoint);
  } catch {
    throw new Error("RPC 地址格式不正确");
  }
  if (url.protocol !== "https:") throw new Error("部署 RPC 必须使用 HTTPS 地址");
}

function formatNativeAmount(value: bigint, network: EvmChainConfig) {
  if (!isEvmNativeCurrencyEnabled(network)) return `${value.toLocaleString()} base units`;
  const formatted = formatUnits(value, network.nativeCurrency.decimals);
  const [integer, fraction = ""] = formatted.split(".");
  const shortFraction = fraction.slice(0, 8).replace(/0+$/, "");
  return `${shortFraction ? `${integer}.${shortFraction}` : integer} ${network.nativeCurrency.symbol}`;
}

export function getBufferedDeploymentGasLimit(estimatedGas: bigint) {
  return (estimatedGas * 120n + 99n) / 100n;
}

async function getDeploymentFeeParameters(
  publicClient: ReturnType<typeof createEvmPublicClient>,
  gasSettings: EvmGasSettings
): Promise<DisperseDeploymentFeeParameters> {
  const quote = await resolveEvmFeeQuote(publicClient, gasSettings);
  return quote.type === "eip1559"
    ? {
        maxFeePerGas: quote.maxFeePerGas,
        maxPriorityFeePerGas: quote.maxPriorityFeePerGas,
        type: "eip1559"
      }
    : { gasPrice: quote.gasPrice, type: "legacy" };
}

function hasExpectedContractCreationEvent(receipt: TransactionReceipt) {
  const creationEvents = parseEventLogs({
    abi: createXAbi,
    eventName: "ContractCreation",
    logs: receipt.logs,
    strict: true
  });
  const creationEvent = creationEvents.find((event) => event.address.toLowerCase() === createXContractAddress.toLowerCase());
  return Boolean(
    creationEvent
    && creationEvent.args.newContract.toLowerCase() === disperseContractAddress.toLowerCase()
    && creationEvent.args.salt.toLowerCase() === disperseContractGuardedSalt.toLowerCase()
  );
}

export function getDisperseDeploymentNetworkForChainId(
  chainId: number,
  rpcEndpoint: string
): DisperseDeploymentNetworkDiscovery {
  const knownNetwork = deploymentNetworkMetadata.find((network) => network.chainId === chainId)
    || evmNetworks.find((network) => network.chainId === chainId);
  if (knownNetwork) {
    return {
      blockExplorerUrl: knownNetwork.blockExplorerUrl,
      chainId,
      label: knownNetwork.label,
      metadataCandidates: [],
      metadataSource: "built-in",
      metadataStatus: "confirmed",
      nativeCurrency: knownNetwork.nativeCurrency,
      sourceVersion: "app",
      rpcEndpoint
    };
  }

  return {
    blockExplorerUrl: "",
    chainId,
    label: `EVM Chain ${chainId}`,
    metadataCandidates: [],
    metadataSource: "unavailable",
    metadataStatus: "unavailable",
    nativeCurrency: null,
    sourceVersion: "",
    rpcEndpoint
  };
}

export async function resolveRegisteredDisperseDeploymentNetwork(
  chainId: number,
  rpcEndpoint: string
): Promise<DisperseDeploymentNetworkDiscovery | null> {
  try {
    const registeredChains = await import("viem/chains");
    const candidates = Object.entries(registeredChains).flatMap(([key, candidate]) => {
      const chain = candidate as Partial<Chain>;
      const valid = chain.id === chainId
        && typeof chain.name === "string"
        && Boolean(chain.name.trim())
        && typeof chain.nativeCurrency?.name === "string"
        && Boolean(chain.nativeCurrency.name.trim())
        && typeof chain.nativeCurrency.symbol === "string"
        && Boolean(chain.nativeCurrency.symbol.trim())
        && Number.isInteger(chain.nativeCurrency.decimals)
        && chain.nativeCurrency.decimals >= 0
        && chain.nativeCurrency.decimals <= 255;
      if (!valid) return [];
      const registeredChain = chain as Chain;
      return [{
        blockExplorerUrl: registeredChain.blockExplorers?.default.url || "",
        key,
        label: registeredChain.name.trim(),
        nativeCurrency: {
          decimals: registeredChain.nativeCurrency.decimals,
          name: registeredChain.nativeCurrency.name.trim(),
          symbol: registeredChain.nativeCurrency.symbol.trim()
        }
      } satisfies DisperseDeploymentNetworkMetadataCandidate];
    });

    if (candidates.length === 0) return null;

    const uniqueCandidates = [...new Map(candidates.map((candidate) => [
      [
        candidate.label.toLowerCase(),
        candidate.nativeCurrency.name.toLowerCase(),
        candidate.nativeCurrency.symbol.toUpperCase(),
        candidate.nativeCurrency.decimals
      ].join("|"),
      candidate
    ])).values()];
    const currencySignatures = new Set(uniqueCandidates.map((candidate) => [
      candidate.nativeCurrency.name.toLowerCase(),
      candidate.nativeCurrency.symbol.toUpperCase(),
      candidate.nativeCurrency.decimals
    ].join("|")));
    const metadataConflict = currencySignatures.size > 1;
    const selectedCandidate = uniqueCandidates[0];

    return {
      blockExplorerUrl: metadataConflict ? "" : selectedCandidate.blockExplorerUrl,
      chainId,
      label: metadataConflict ? `EVM Chain ${chainId}` : selectedCandidate.label,
      metadataCandidates: uniqueCandidates,
      metadataSource: "viem",
      metadataStatus: metadataConflict ? "conflict" : "suggested",
      nativeCurrency: metadataConflict ? null : selectedCandidate.nativeCurrency,
      sourceVersion: viemChainRegistryVersion,
      rpcEndpoint
    };
  } catch {
    return null;
  }
}

export function finalizeDisperseDeploymentNetwork(
  discovery: DisperseDeploymentNetworkDiscovery,
  blockExplorerUrl: string,
  options: FinalizeDisperseDeploymentNetworkOptions = {}
): EvmChainConfig {
  const registryMetadataAccepted = discovery.metadataStatus === "suggested"
    && discovery.metadataSource === "viem"
    && !options.useManualMetadata;
  const nativeCurrencyConfirmed = discovery.metadataStatus === "confirmed"
    || registryMetadataAccepted
    || Boolean(options.nativeCurrencyConfirmed
      && (options.useManualMetadata || discovery.metadataStatus === "suggested"));
  const manualMetadata = options.manualMetadata;
  let label = discovery.label;
  let nativeCurrency = discovery.nativeCurrency || unconfirmedEvmNativeCurrency;
  let metadataSource: EvmNativeCurrencyMetadata["source"] = discovery.metadataSource;
  let sourceVersion = discovery.sourceVersion;

  if (options.useManualMetadata) {
    label = manualMetadata?.chainName.trim() || discovery.label;
    nativeCurrency = unconfirmedEvmNativeCurrency;
    metadataSource = "unavailable";
    sourceVersion = "";

    if (nativeCurrencyConfirmed) {
      const selectedCandidate = options.selectedCandidateKey
        ? discovery.metadataCandidates.find((candidate) => candidate.key === options.selectedCandidateKey)
        : undefined;
      if (selectedCandidate) {
        label = selectedCandidate.label;
        nativeCurrency = selectedCandidate.nativeCurrency;
        metadataSource = "viem";
        sourceVersion = discovery.sourceVersion;
      } else {
        const chainName = manualMetadata?.chainName.trim() || "";
        const nativeCurrencyName = manualMetadata?.nativeCurrencyName.trim() || "";
        const nativeCurrencySymbol = manualMetadata?.nativeCurrencySymbol.trim() || "";
        const decimalsText = String(manualMetadata?.nativeCurrencyDecimals ?? "").trim();
        const nativeCurrencyDecimals = /^\d+$/.test(decimalsText) ? Number(decimalsText) : Number.NaN;

        if (!chainName) throw new Error("请填写并确认链名称");
        if (!nativeCurrencyName) throw new Error("请填写并确认原生币名称");
        if (!nativeCurrencySymbol) throw new Error("请填写并确认原生币符号");
        if (!Number.isSafeInteger(nativeCurrencyDecimals) || nativeCurrencyDecimals < 0 || nativeCurrencyDecimals > 255) {
          throw new Error("原生币 decimals 必须是 0 到 255 的整数");
        }

        label = chainName;
        nativeCurrency = {
          decimals: nativeCurrencyDecimals,
          name: nativeCurrencyName,
          symbol: nativeCurrencySymbol
        };
        metadataSource = "manual";
        sourceVersion = "user-confirmed";
      }
    }
  }

  return {
    blockExplorerUrl: blockExplorerUrl || discovery.blockExplorerUrl,
    chainId: discovery.chainId,
    label,
    nativeCurrency,
    nativeCurrencyMetadata: {
      confirmedAt: nativeCurrencyConfirmed ? new Date().toISOString() : "",
      source: nativeCurrencyConfirmed ? metadataSource : metadataSource === "viem" ? "viem" : "unavailable",
      sourceVersion,
      status: nativeCurrencyConfirmed ? "confirmed" : "unconfirmed"
    },
    rpcEndpoint: discovery.rpcEndpoint
  };
}

export async function resolveDisperseDeploymentNetwork(rpcEndpoint: string) {
  assertHttpsRpcEndpoint(rpcEndpoint);
  const rpcClient = createPublicClient({ transport: http(rpcEndpoint) });
  const chainId = await rpcClient.getChainId();
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error(`RPC 返回了无效的 chainId：${chainId}`);
  }
  const discovery = getDisperseDeploymentNetworkForChainId(chainId, rpcEndpoint);
  if (discovery.metadataStatus === "confirmed") return discovery;
  return await resolveRegisteredDisperseDeploymentNetwork(chainId, rpcEndpoint) || discovery;
}

export function getDisperseDeploymentArtifacts() {
  const guardedSalt = keccak256(encodeAbiParameters([{ type: "bytes32" }], [disperseContractRawSalt]));
  const initCodeHash = keccak256(disperseContractInitCode);
  const runtimeCode = slice(disperseContractInitCode, 32);
  const runtimeCodeHash = keccak256(runtimeCode);
  const predictedAddress = getCreate2Address({
    bytecodeHash: initCodeHash,
    from: createXContractAddress,
    salt: guardedSalt
  });
  const valid = guardedSalt === disperseContractGuardedSalt
    && initCodeHash === disperseContractInitCodeHash
    && runtimeCodeHash === disperseContractRuntimeCodeHash
    && predictedAddress === disperseContractAddress;

  return {
    guardedSalt,
    initCodeHash,
    predictedAddress,
    runtimeCode,
    runtimeCodeHash,
    valid
  };
}

export function classifyContractCode(contractCode: Hex | undefined, expectedHash: Hex): ContractCodeState {
  if (!contractCode || contractCode === "0x") return "absent";
  return keccak256(contractCode) === expectedHash ? "expected" : "unexpected";
}

export function hasExpectedCreateXContractCode(contractCode: Hex | undefined) {
  return classifyContractCode(contractCode, createXContractRuntimeCodeHash) === "expected";
}

export function hasDisperseSaltSenderCollision(account: string) {
  return getAddress(account).toLowerCase() === disperseSaltSenderPrefix.toLowerCase();
}

export function getDisperseDeploymentExplorerUrl(hash: string, network: EvmChainConfig) {
  if (!network.blockExplorerUrl) return "";
  return `${network.blockExplorerUrl.replace(/\/+$/, "")}/tx/${hash}`;
}

export function getDisperseDeploymentErrorMessage(error: unknown) {
  if (error instanceof DisperseDeploymentValidationError) return error.message;

  const detail = getErrorDetail(error);
  const code = error && typeof error === "object" && "code" in error ? Number((error as { code?: unknown }).code) : 0;
  if (code === 4001 || /reject|declin|cancel/i.test(detail)) return "用户取消了部署交易确认";
  if (/insufficient|exceeds balance|not enough funds/i.test(detail)) return "钱包 Gas 余额不足，无法部署合约";
  if (/401|403|unauthori[sz]ed|forbidden/i.test(detail)) return "RPC 需要授权，请更换可访问的 HTTPS RPC";
  if (/execution reverted|revert/i.test(detail)) return "CreateX 部署调用执行失败；目标可能刚被部署，请重新校验";
  if (/failed to fetch|network|fetch|timeout/i.test(detail)) return "RPC 请求失败，请更换 HTTPS RPC 后重试";
  return detail ? `Disperse 部署失败：${detail}` : "Disperse 部署失败，请稍后重试";
}

export async function runDisperseDeploymentValidation({
  account,
  gasSettings = autoEvmGasSettings,
  network,
  onChecks,
  provider,
  rpcEndpoint,
  shouldContinue
}: RunDisperseDeploymentValidationArgs): Promise<DisperseDeploymentPreflight> {
  const reporter = createCheckReporter(onChecks);
  const assertCurrentValidationContext = () => {
    if (shouldContinue && !shouldContinue()) {
      throw new DisperseDeploymentValidationError("钱包、网络或 RPC 已改变，已取消本次部署校验", reporter.getChecks());
    }
  };
  assertCurrentValidationContext();
  const artifacts = getDisperseDeploymentArtifacts();
  if (!artifacts.valid) {
    reporter.fail("artifacts", "固定部署产物", "内置 salt、initCode 或 runtime 哈希不一致，已阻止部署");
  }
  reporter.report({
    detail: `initCode ${((disperseContractInitCode.length - 2) / 2).toLocaleString()} bytes，哈希与目标地址均匹配`,
    id: "artifacts",
    label: "固定部署产物",
    status: "pass"
  });
  assertCurrentValidationContext();

  try {
    assertHttpsRpcEndpoint(rpcEndpoint);
  } catch (error) {
    reporter.fail("rpc", "RPC 与 Chain ID", getErrorDetail(error));
  }

  const publicClient = createEvmPublicClient(network, rpcEndpoint);
  try {
    const rpcChainId = await publicClient.getChainId();
    assertCurrentValidationContext();
    if (rpcChainId !== network.chainId) {
      reporter.fail("rpc", "RPC 与 Chain ID", `RPC 返回 chainId ${rpcChainId}，配置要求 ${network.chainId}`);
    }
    reporter.report({
      detail: `${network.label} · chainId ${rpcChainId}`,
      id: "rpc",
      label: "RPC 与 Chain ID",
      status: "pass"
    });
  } catch (error) {
    if (error instanceof DisperseDeploymentValidationError) throw error;
    reporter.fail("rpc", "RPC 与 Chain ID", `无法读取 RPC 网络：${getErrorDetail(error) || "请求失败"}`);
  }

  assertCurrentValidationContext();
  try {
    await ensureEvmNetwork(provider, network, rpcEndpoint);
    assertCurrentValidationContext();
    const walletChainId = parseWalletChainId(await provider.request({ method: "eth_chainId" }));
    assertCurrentValidationContext();
    if (walletChainId !== network.chainId) {
      reporter.fail("wallet", "钱包网络", `钱包仍在 chainId ${walletChainId}，要求 ${network.chainId}`);
    }
    reporter.report({
      detail: `钱包已切换到 ${network.label}`,
      id: "wallet",
      label: "钱包网络",
      status: "pass"
    });
  } catch (error) {
    if (error instanceof DisperseDeploymentValidationError) throw error;
    reporter.fail("wallet", "钱包网络", `钱包网络切换或复核失败：${getErrorDetail(error) || "请求失败"}`);
  }

  const accountAddress = getAddress(account);
  if (hasDisperseSaltSenderCollision(accountAddress)) {
    reporter.fail("address", "CREATE2 预计算地址", "当前钱包地址与 raw salt 的 CreateX 权限前缀冲突，请更换部署钱包");
  }
  let rpcFactoryCode: Hex | undefined;
  let rpcTargetCode: Hex | undefined;
  try {
    [rpcFactoryCode, rpcTargetCode] = await Promise.all([
      publicClient.getCode({ address: createXContractAddress }),
      publicClient.getCode({ address: disperseContractAddress })
    ]);
    assertCurrentValidationContext();
  } catch (error) {
    if (error instanceof DisperseDeploymentValidationError) throw error;
    reporter.fail("factory", "CreateX 官方字节码", `通过 RPC 读取链上代码失败：${getErrorDetail(error) || "请求失败"}`);
  }

  const rpcFactoryState = classifyContractCode(rpcFactoryCode, createXContractRuntimeCodeHash);
  if (rpcFactoryState === "absent") {
    reporter.fail("factory", "CreateX 官方字节码", `${network.label} 未部署 canonical CreateX`);
  }
  if (rpcFactoryState === "unexpected") {
    reporter.fail("factory", "CreateX 官方字节码", "CreateX 地址存在代码，但官方 runtime hash 不匹配");
  }
  reporter.report({
    detail: `${createXContractAddress} · 官方 runtime hash 匹配`,
    id: "factory",
    label: "CreateX 官方字节码",
    status: "pass"
  });

  try {
    const rpcComputedAddress = await publicClient.readContract({
      abi: createXAbi,
      address: createXContractAddress,
      args: [disperseContractGuardedSalt, disperseContractInitCodeHash],
      functionName: "computeCreate2Address"
    });
    assertCurrentValidationContext();
    if (rpcComputedAddress !== disperseContractAddress
      || artifacts.predictedAddress !== disperseContractAddress) {
      reporter.fail("address", "CREATE2 预计算地址", `预计算结果 ${rpcComputedAddress}，不是固定目标 ${disperseContractAddress}`);
    }
    reporter.report({
      detail: `${disperseContractAddress} · 本地与 RPC 计算一致`,
      id: "address",
      label: "CREATE2 预计算地址",
      status: "pass"
    });
  } catch (error) {
    if (error instanceof DisperseDeploymentValidationError) throw error;
    reporter.fail("address", "CREATE2 预计算地址", `CreateX 地址计算失败：${getErrorDetail(error) || "调用失败"}`);
  }

  const rpcTargetState = classifyContractCode(rpcTargetCode, disperseContractRuntimeCodeHash);
  const targetState = rpcTargetState;
  if (targetState === "unexpected") {
    reporter.fail("target", "目标地址状态", "目标地址已有其他字节码，官方 runtime hash 不匹配，已永久阻止部署");
  }
  if (targetState === "expected") {
    reporter.report({
      detail: "目标地址已经是官方 Disperse，无需重复部署",
      id: "target",
      label: "目标地址状态",
      status: "pass"
    });
    reporter.report({ detail: "合约已部署，无需模拟", id: "simulation", label: "部署调用模拟", status: "skipped" });
    reporter.report({ detail: "合约已部署，无需检查", id: "balance", label: "Gas 余额", status: "skipped" });
    return {
      checks: reporter.getChecks(),
      estimatedFee: 0n,
      estimatedGas: 0n,
      feeCapPerGas: 0n,
      feeParameters: null,
      gasLimit: 0n,
      status: "already-deployed",
      targetState
    };
  }
  reporter.report({
    detail: `${disperseContractAddress} 当前无代码，可以部署`,
    id: "target",
    label: "目标地址状态",
    status: "pass"
  });

  let deploymentMetrics: {
    balance: bigint;
    estimatedGas: bigint;
    feeParameters: DisperseDeploymentFeeParameters;
    simulatedAddress: Address;
  } | null = null;
  try {
    const [
      simulation,
      estimatedGas,
      feeParameters,
      balance
    ] = await Promise.all([
      publicClient.simulateContract({
        abi: createXAbi,
        account: accountAddress,
        address: createXContractAddress,
        args: [disperseContractRawSalt, disperseContractInitCode],
        functionName: "deployCreate2",
        value: 0n
      }),
      publicClient.estimateContractGas({
        abi: createXAbi,
        account: accountAddress,
        address: createXContractAddress,
        args: [disperseContractRawSalt, disperseContractInitCode],
        functionName: "deployCreate2",
        value: 0n
      }),
      getDeploymentFeeParameters(publicClient, gasSettings),
      publicClient.getBalance({ address: accountAddress })
    ]);
    assertCurrentValidationContext();
    deploymentMetrics = {
      balance,
      estimatedGas,
      feeParameters,
      simulatedAddress: simulation.result
    };
  } catch (error) {
    if (error instanceof DisperseDeploymentValidationError) throw error;
    reporter.fail("simulation", "部署调用模拟", `CreateX exact-call 模拟或 Gas 估算失败：${getErrorDetail(error) || "调用失败"}`);
  }

  if (!deploymentMetrics) {
    const detail = "CreateX exact-call 模拟未返回结果";
    reporter.report({ detail, id: "simulation", label: "部署调用模拟", status: "fail" });
    throw new DisperseDeploymentValidationError(detail, reporter.getChecks());
  }

  const { balance, estimatedGas, feeParameters, simulatedAddress } = deploymentMetrics;

  if (simulatedAddress !== disperseContractAddress) {
    reporter.fail("simulation", "部署调用模拟", `模拟得到 ${simulatedAddress}，不是固定目标地址`);
  }
  reporter.report({
    detail: `exact-call 模拟成功 · 估算 ${estimatedGas.toLocaleString()} gas`,
    id: "simulation",
    label: "部署调用模拟",
    status: "pass"
  });

  const gasLimit = getBufferedDeploymentGasLimit(estimatedGas);
  const feeCapPerGas = getEvmFeeCapPerGas(feeParameters);
  const estimatedFee = gasLimit * feeCapPerGas;
  if (balance < estimatedFee) {
    reporter.fail(
      "balance",
      "Gas 余额",
      `按 20% Gas 缓冲和费用上限计算，至少需要 ${formatNativeAmount(estimatedFee, network)}，当前余额 ${formatNativeAmount(balance, network)}`
    );
  }
  reporter.report({
    detail: `请求上限 ${gasLimit.toLocaleString()} gas × ${formatNativeAmount(feeCapPerGas, network)} / gas · 当前余额 ${formatNativeAmount(balance, network)}`,
    id: "balance",
    label: "Gas 余额",
    status: "pass"
  });

  return {
    checks: reporter.getChecks(),
    estimatedFee,
    estimatedGas,
    feeCapPerGas,
    feeParameters,
    gasLimit,
    status: "ready",
    targetState
  };
}

export async function deployDisperseContract({
  account,
  gasSettings = autoEvmGasSettings,
  network,
  onChecks,
  onStage,
  provider,
  rpcEndpoint,
  shouldContinue
}: DeployDisperseContractArgs) {
  const preflight = await runDisperseDeploymentValidation({
    account,
    gasSettings,
    network,
    onChecks,
    provider,
    rpcEndpoint,
    shouldContinue
  });
  if (preflight.status === "already-deployed") {
    return { alreadyDeployed: true as const, hash: "" as const, preflight, receipt: null };
  }

  const accountAddress = getAddress(account);
  const assertCurrentDeploymentContext = () => {
    if (shouldContinue && !shouldContinue()) {
      throw new DisperseDeploymentValidationError("钱包、网络或 RPC 已改变，已取消本次部署签名", preflight.checks);
    }
  };
  assertCurrentDeploymentContext();

  const [walletChainIdValue, walletAccountsValue] = await Promise.all([
    provider.request({ method: "eth_chainId" }),
    provider.request({ method: "eth_accounts" })
  ]);
  assertCurrentDeploymentContext();
  const activeWalletAccount = Array.isArray(walletAccountsValue) && typeof walletAccountsValue[0] === "string"
    ? walletAccountsValue[0]
    : "";
  if (parseWalletChainId(walletChainIdValue) !== network.chainId
    || activeWalletAccount.toLowerCase() !== accountAddress.toLowerCase()) {
    throw new DisperseDeploymentValidationError("签名前钱包的账户或网络已改变，请重新校验", preflight.checks);
  }

  const publicClient = createEvmPublicClient(network, rpcEndpoint);
  const walletClient = createWalletClient({
    chain: toEvmChain(network, rpcEndpoint),
    transport: custom(provider)
  });

  onStage?.({ preflight, type: "awaiting-wallet" });
  assertCurrentDeploymentContext();
  if (!preflight.feeParameters) {
    throw new DisperseDeploymentValidationError("部署费用参数缺失，请重新校验", preflight.checks);
  }
  const feeRequest = getEvmFeeRequest(preflight.feeParameters);
  const hash = await walletClient.writeContract({
    abi: createXAbi,
    account: accountAddress,
    address: createXContractAddress,
    args: [disperseContractRawSalt, disperseContractInitCode],
    functionName: "deployCreate2",
    gas: preflight.gasLimit,
    ...feeRequest,
    value: 0n
  });
  onStage?.({ hash, type: "submitted" });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  let checks = [...preflight.checks];
  const reportPostCheck = (check: DisperseDeploymentCheck) => {
    checks = upsertCheck(checks, check);
    onChecks?.([...checks]);
  };
  const failPostCheck = (id: DisperseDeploymentCheckId, label: string, detail: string): never => {
    reportPostCheck({ detail, id, label, status: "fail" });
    throw new DisperseDeploymentValidationError(detail, checks);
  };

  if (receipt.status !== "success") {
    failPostCheck("receipt", "交易回执事件", "RPC 返回的 receipt 状态为失败");
  }

  if (!hasExpectedContractCreationEvent(receipt)) {
    failPostCheck("receipt", "交易回执事件", "CreateX ContractCreation 事件中的目标地址或 guarded salt 不匹配");
  }
  reportPostCheck({
    detail: "交易成功，CreateX ContractCreation 事件匹配",
    id: "receipt",
    label: "交易回执事件",
    status: "pass"
  });
  onStage?.({ hash, receipt, type: "confirmed" });

  const deployedCode = await publicClient.getCode({ address: disperseContractAddress });
  if (classifyContractCode(deployedCode, disperseContractRuntimeCodeHash) !== "expected") {
    failPostCheck("runtime", "部署后 runtime", "交易成功，但部署后的官方 runtime hash 校验未通过");
  }
  reportPostCheck({
    detail: `${disperseContractRuntimeCodeHash} · 官方 runtime hash 匹配`,
    id: "runtime",
    label: "部署后 runtime",
    status: "pass"
  });
  onStage?.({ hash, receipt, type: "verified" });

  return { alreadyDeployed: false as const, hash, preflight: { ...preflight, checks }, receipt };
}
