import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseAbi,
  parseUnits,
  type Address,
  type Chain,
  type Hash,
  type Hex
} from "viem";
import { rpcConfig } from "../config/rpc";
import type { EvmWalletProvider } from "../hooks/useEvmWallet";
import { getDuplicateAddressKey } from "./address";
import {
  autoEvmGasSettings,
  getEvmFeeCapPerGas,
  getEvmFeeRequest,
  resolveEvmFeeQuote,
  type EvmFeeQuote,
  type EvmGasSettings
} from "./evm-gas";

export type EvmNetworkId =
  | "ethereum"
  | "bsc"
  | "base"
  | "robinhood"
  | "arbitrum"
  | "polygon"
  | "optimism"
  | "avalanche"
  | "hyperliquid"
  | "monad"
  | "gnosis"
  | "sepolia"
  | "hoodi"
  | "bscTestnet"
  | "baseSepolia"
  | "arbitrumSepolia"
  | "optimismSepolia"
  | "polygonAmoy"
  | "avalancheFuji"
  | "monadTestnet";

export type EvmDistributionNetworkId = EvmNetworkId | `custom-${number}`;

export type EvmDistributionRow = {
  address: string;
  amountRaw: string;
  line: number;
  problems: string[];
  status: "valid" | "invalid";
  valueWei: bigint;
};

export type ParseEvmDistributionResult = {
  cleanRows: string[];
  duplicates: number;
  invalid: number;
  rows: EvmDistributionRow[];
  total: string;
  totalWei: bigint;
  validRows: EvmDistributionRow[];
};

export type EvmNativeCurrency = {
  decimals: number;
  name: string;
  symbol: string;
};

export type EvmNativeCurrencyMetadata = {
  confirmedAt: string;
  source: "built-in" | "viem" | "manual" | "unavailable";
  sourceVersion: string;
  status: "confirmed" | "unconfirmed";
};

export type EvmChainConfig = {
  blockExplorerUrl: string;
  chainId: number;
  label: string;
  nativeCurrency: EvmNativeCurrency;
  nativeCurrencyMetadata?: EvmNativeCurrencyMetadata;
  rpcEndpoint: string;
};

export type EvmNetworkConfig = EvmChainConfig & {
  disperseContractAddress: Address;
  id: EvmDistributionNetworkId;
};

export type EvmAssetMode = "native" | "token";

export type EvmTokenDetails = {
  address: Address;
  decimals: number;
  name: string;
  symbol: string;
};

export type EvmTokenDistributionStep =
  | { needsApproval: boolean; totalTransactions: number; type: "allowance-checked" }
  | { hash: Hash; totalTransactions: 2; type: "approval-submitted" }
  | { hash: Hash; totalTransactions: 2; type: "approval-confirmed" }
  | { hash: Hash; hashes: Hash[]; totalTransactions: number; type: "distribution-submitted" }
  | { hash: Hash; hashes: Hash[]; totalTransactions: number; type: "distribution-confirmed" };

export type EvmDistributionPreflightResult = {
  assetBalanceWei: bigint;
  estimatedNetworkFeeWei: bigint;
  feeEstimateBasis: "rpc" | "conservative";
  feeQuote: EvmFeeQuote;
  nativeBalanceWei: bigint;
  needsApproval: boolean;
  requiredNativeWei: bigint;
  totalTransactions: number;
};

export type EvmSendState = {
  hash: Hash | "";
  message: string;
  status: "idle" | "preparing" | "awaiting-wallet" | "confirming" | "success" | "error";
};

export const disperseContractAddress = "0xd15fE25eD0Dba12fE05e7029C88b10C25e8880E3";
export const disperseContractRuntimeCodeHash = "0xc0a38c227d2c70248fc51ed0dd3a72df3adf5b41494c7f3cc19c16c38523244d";
export const unconfirmedEvmNativeCurrency: EvmNativeCurrency = {
  decimals: 0,
  name: "Unconfirmed base unit",
  symbol: "base units"
};

export const evmNetworks: EvmNetworkConfig[] = [
  {
    blockExplorerUrl: "https://etherscan.io",
    chainId: 1,
    disperseContractAddress,
    id: "ethereum",
    label: "Ethereum",
    nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
    rpcEndpoint: rpcConfig.evm.ethereum
  },
  {
    blockExplorerUrl: "https://bscscan.com",
    chainId: 56,
    disperseContractAddress,
    id: "bsc",
    label: "BNB Chain",
    nativeCurrency: { decimals: 18, name: "BNB", symbol: "BNB" },
    rpcEndpoint: rpcConfig.evm.bsc
  },
  {
    blockExplorerUrl: "https://basescan.org",
    chainId: 8453,
    disperseContractAddress,
    id: "base",
    label: "Base",
    nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
    rpcEndpoint: rpcConfig.evm.base
  },
  {
    blockExplorerUrl: "https://robinhoodchain.blockscout.com",
    chainId: 4663,
    disperseContractAddress,
    id: "robinhood",
    label: "Robinhood Chain",
    nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
    rpcEndpoint: rpcConfig.evm.robinhood
  },
  {
    blockExplorerUrl: "https://arbiscan.io",
    chainId: 42161,
    disperseContractAddress,
    id: "arbitrum",
    label: "Arbitrum",
    nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
    rpcEndpoint: rpcConfig.evm.arbitrum
  },
  {
    blockExplorerUrl: "https://polygonscan.com",
    chainId: 137,
    disperseContractAddress,
    id: "polygon",
    label: "Polygon",
    nativeCurrency: { decimals: 18, name: "POL", symbol: "POL" },
    rpcEndpoint: rpcConfig.evm.polygon
  },
  {
    blockExplorerUrl: "https://optimistic.etherscan.io",
    chainId: 10,
    disperseContractAddress,
    id: "optimism",
    label: "Optimism",
    nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
    rpcEndpoint: rpcConfig.evm.optimism
  },
  {
    blockExplorerUrl: "https://snowtrace.io",
    chainId: 43114,
    disperseContractAddress,
    id: "avalanche",
    label: "Avalanche",
    nativeCurrency: { decimals: 18, name: "Avalanche", symbol: "AVAX" },
    rpcEndpoint: rpcConfig.evm.avalanche
  },
  {
    blockExplorerUrl: "https://hyperevmscan.io",
    chainId: 999,
    disperseContractAddress,
    id: "hyperliquid",
    label: "Hyperliquid",
    nativeCurrency: { decimals: 18, name: "HYPE", symbol: "HYPE" },
    rpcEndpoint: rpcConfig.evm.hyperliquid
  },
  {
    blockExplorerUrl: "https://monadvision.com",
    chainId: 143,
    disperseContractAddress,
    id: "monad",
    label: "Monad",
    nativeCurrency: { decimals: 18, name: "Monad", symbol: "MON" },
    rpcEndpoint: rpcConfig.evm.monad
  },
  {
    blockExplorerUrl: "https://gnosisscan.io",
    chainId: 100,
    disperseContractAddress,
    id: "gnosis",
    label: "Gnosis",
    nativeCurrency: { decimals: 18, name: "xDAI", symbol: "xDAI" },
    rpcEndpoint: rpcConfig.evm.gnosis
  },
  {
    blockExplorerUrl: "https://sepolia.etherscan.io",
    chainId: 11155111,
    disperseContractAddress,
    id: "sepolia",
    label: "Ethereum Sepolia",
    nativeCurrency: { decimals: 18, name: "Sepolia Ether", symbol: "ETH" },
    rpcEndpoint: rpcConfig.evm.sepolia
  },
  {
    blockExplorerUrl: "https://hoodi.etherscan.io",
    chainId: 560048,
    disperseContractAddress,
    id: "hoodi",
    label: "Ethereum Hoodi",
    nativeCurrency: { decimals: 18, name: "Hoodi Ether", symbol: "ETH" },
    rpcEndpoint: rpcConfig.evm.hoodi
  },
  {
    blockExplorerUrl: "https://testnet.bscscan.com",
    chainId: 97,
    disperseContractAddress,
    id: "bscTestnet",
    label: "BNB Chain Testnet",
    nativeCurrency: { decimals: 18, name: "Testnet BNB", symbol: "tBNB" },
    rpcEndpoint: rpcConfig.evm.bscTestnet
  },
  {
    blockExplorerUrl: "https://sepolia.basescan.org",
    chainId: 84532,
    disperseContractAddress,
    id: "baseSepolia",
    label: "Base Sepolia",
    nativeCurrency: { decimals: 18, name: "Sepolia Ether", symbol: "ETH" },
    rpcEndpoint: rpcConfig.evm.baseSepolia
  },
  {
    blockExplorerUrl: "https://sepolia.arbiscan.io",
    chainId: 421614,
    disperseContractAddress,
    id: "arbitrumSepolia",
    label: "Arbitrum Sepolia",
    nativeCurrency: { decimals: 18, name: "Arbitrum Sepolia Ether", symbol: "ETH" },
    rpcEndpoint: rpcConfig.evm.arbitrumSepolia
  },
  {
    blockExplorerUrl: "https://optimism-sepolia.blockscout.com",
    chainId: 11155420,
    disperseContractAddress,
    id: "optimismSepolia",
    label: "Optimism Sepolia",
    nativeCurrency: { decimals: 18, name: "Sepolia Ether", symbol: "ETH" },
    rpcEndpoint: rpcConfig.evm.optimismSepolia
  },
  {
    blockExplorerUrl: "https://amoy.polygonscan.com",
    chainId: 80002,
    disperseContractAddress,
    id: "polygonAmoy",
    label: "Polygon Amoy",
    nativeCurrency: { decimals: 18, name: "POL", symbol: "POL" },
    rpcEndpoint: rpcConfig.evm.polygonAmoy
  },
  {
    blockExplorerUrl: "https://testnet.snowtrace.io",
    chainId: 43113,
    disperseContractAddress,
    id: "avalancheFuji",
    label: "Avalanche Fuji",
    nativeCurrency: { decimals: 18, name: "Avalanche Fuji", symbol: "AVAX" },
    rpcEndpoint: rpcConfig.evm.avalancheFuji
  },
  {
    blockExplorerUrl: "https://testnet.monadexplorer.com",
    chainId: 10143,
    disperseContractAddress,
    id: "monadTestnet",
    label: "Monad Testnet",
    nativeCurrency: { decimals: 18, name: "Testnet MON Token", symbol: "MON" },
    rpcEndpoint: rpcConfig.evm.monadTestnet
  }
];

const verifiedEvmNetworksStorageKey = "batch-send.verified-evm-networks.v3";
const preferredEvmNetworkStorageKey = "batch-send.preferred-evm-network.v1";

function getHttpsRpcHostname(rpcEndpoint: string) {
  try {
    const url = new URL(rpcEndpoint);
    return url.protocol === "https:" ? url.hostname.toLowerCase() : "";
  } catch {
    return "";
  }
}

function isValidEvmNativeCurrency(value: unknown): value is EvmChainConfig["nativeCurrency"] {
  if (!value || typeof value !== "object") return false;
  const nativeCurrency = value as Partial<EvmChainConfig["nativeCurrency"]>;
  return typeof nativeCurrency.name === "string"
    && Boolean(nativeCurrency.name.trim())
    && typeof nativeCurrency.symbol === "string"
    && Boolean(nativeCurrency.symbol.trim())
    && typeof nativeCurrency.decimals === "number"
    && Number.isInteger(nativeCurrency.decimals)
    && nativeCurrency.decimals >= 0
    && nativeCurrency.decimals <= 255;
}

function isValidEvmNativeCurrencyMetadata(value: unknown): value is EvmNativeCurrencyMetadata {
  if (!value || typeof value !== "object") return false;
  const metadata = value as Partial<EvmNativeCurrencyMetadata>;
  return (metadata.status === "confirmed" || metadata.status === "unconfirmed")
    && (metadata.source === "built-in"
      || metadata.source === "viem"
      || metadata.source === "manual"
      || metadata.source === "unavailable")
    && typeof metadata.sourceVersion === "string"
    && typeof metadata.confirmedAt === "string"
    && (metadata.status === "unconfirmed" || Boolean(metadata.confirmedAt));
}

function getBuiltInNativeCurrencyMetadata(): EvmNativeCurrencyMetadata {
  return {
    confirmedAt: "built-in",
    source: "built-in",
    sourceVersion: "app",
    status: "confirmed"
  };
}

export function getEvmNativeCurrencyMetadata(network: EvmChainConfig): EvmNativeCurrencyMetadata {
  if (network.nativeCurrencyMetadata) return network.nativeCurrencyMetadata;
  if (evmNetworks.some((configuredNetwork) => configuredNetwork.chainId === network.chainId)) {
    return getBuiltInNativeCurrencyMetadata();
  }
  return {
    confirmedAt: "",
    source: "unavailable",
    sourceVersion: "",
    status: "unconfirmed"
  };
}

export function isEvmNativeCurrencyEnabled(network: EvmChainConfig) {
  const metadata = getEvmNativeCurrencyMetadata(network);
  return metadata.status === "confirmed"
    && metadata.source !== "unavailable"
    && isValidEvmNativeCurrency(network.nativeCurrency);
}

function isStoredEvmNetwork(value: unknown): value is EvmNetworkConfig {
  if (!value || typeof value !== "object") return false;
  const network = value as Partial<EvmNetworkConfig>;
  return typeof network.id === "string"
    && typeof network.chainId === "number"
    && Number.isSafeInteger(network.chainId)
    && network.chainId > 0
    && typeof network.label === "string"
    && Boolean(network.label.trim())
    && typeof network.rpcEndpoint === "string"
    && Boolean(getHttpsRpcHostname(network.rpcEndpoint))
    && typeof network.blockExplorerUrl === "string"
    && (!network.blockExplorerUrl || network.blockExplorerUrl.startsWith("https://"))
    && network.disperseContractAddress?.toLowerCase() === disperseContractAddress.toLowerCase()
    && isValidEvmNativeCurrency(network.nativeCurrency)
    && isValidEvmNativeCurrencyMetadata(network.nativeCurrencyMetadata);
}

function readStoredEvmNetworks() {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(verifiedEvmNetworksStorageKey) || "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter(isStoredEvmNetwork) : [];
  } catch {
    return [];
  }
}

export function createEvmDistributionNetwork(network: EvmChainConfig): EvmNetworkConfig {
  if (!isValidEvmNativeCurrency(network.nativeCurrency)) {
    throw new Error("EVM 原生币元数据不完整");
  }
  const configuredNetwork = evmNetworks.find((item) => item.chainId === network.chainId);
  const nativeCurrencyMetadata = network.nativeCurrencyMetadata
    || (configuredNetwork ? getBuiltInNativeCurrencyMetadata() : {
      confirmedAt: "",
      source: "unavailable" as const,
      sourceVersion: "",
      status: "unconfirmed" as const
    });
  if (!isValidEvmNativeCurrencyMetadata(nativeCurrencyMetadata)) {
    throw new Error("EVM 原生币确认记录不完整");
  }
  return {
    blockExplorerUrl: (network.blockExplorerUrl || configuredNetwork?.blockExplorerUrl || "").trim().replace(/\/+$/, ""),
    chainId: network.chainId,
    disperseContractAddress,
    id: configuredNetwork?.id || `custom-${network.chainId}`,
    label: network.label || configuredNetwork?.label || `EVM Chain ${network.chainId}`,
    nativeCurrency: network.nativeCurrency,
    nativeCurrencyMetadata,
    rpcEndpoint: network.rpcEndpoint.trim()
  };
}

export function mergeEvmDistributionNetworks(verifiedNetworks: EvmNetworkConfig[]): EvmNetworkConfig[] {
  const verifiedByChainId = new Map<number, EvmNetworkConfig>();
  verifiedNetworks.forEach((network) => verifiedByChainId.set(network.chainId, network));
  const uniqueVerifiedNetworks = [...verifiedByChainId.values()];
  const configuredChainIds = new Set(evmNetworks.map((network) => network.chainId));
  const configuredNetworks: EvmNetworkConfig[] = evmNetworks.map((network) => {
    const verifiedNetwork = verifiedByChainId.get(network.chainId);
    return verifiedNetwork
      ? { ...network, ...verifiedNetwork, disperseContractAddress: network.disperseContractAddress, id: network.id }
      : network;
  });
  const customNetworks = uniqueVerifiedNetworks.filter((network) => !configuredChainIds.has(network.chainId));
  const seenChainIds = new Set<number>();
  return [...configuredNetworks, ...customNetworks].filter((network) => {
    if (seenChainIds.has(network.chainId)) return false;
    seenChainIds.add(network.chainId);
    return true;
  });
}

export function getEvmDistributionNetworks() {
  return mergeEvmDistributionNetworks(readStoredEvmNetworks());
}

export function getVerifiedEvmDistributionChainIds() {
  return readStoredEvmNetworks().map((network) => network.chainId);
}

export function getPreferredEvmDistributionNetwork(networks: EvmNetworkConfig[]) {
  if (typeof window === "undefined") return networks[0] || evmNetworks[0];
  try {
    const preferredNetworkId = window.localStorage.getItem(preferredEvmNetworkStorageKey) || "";
    return networks.find((network) => network.id === preferredNetworkId) || networks[0] || evmNetworks[0];
  } catch {
    return networks[0] || evmNetworks[0];
  }
}

export function rememberPreferredEvmDistributionNetwork(networkId: EvmDistributionNetworkId) {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(preferredEvmNetworkStorageKey, networkId);
    return true;
  } catch {
    return false;
  }
}

export function registerVerifiedEvmDistributionNetwork(network: EvmChainConfig) {
  if (typeof window === "undefined") return null;
  try {
    const distributionNetwork = createEvmDistributionNetwork(network);
    const storedNetworks = readStoredEvmNetworks();
    const nextStoredNetworks = [
      ...storedNetworks.filter((item) => item.chainId !== distributionNetwork.chainId),
      distributionNetwork
    ];
    window.localStorage.setItem(verifiedEvmNetworksStorageKey, JSON.stringify(nextStoredNetworks));
    window.localStorage.setItem(preferredEvmNetworkStorageKey, distributionNetwork.id);
    return distributionNetwork;
  } catch {
    return null;
  }
}

export function removeVerifiedEvmDistributionNetwork(chainId: number) {
  if (typeof window === "undefined") return false;
  try {
    const storedNetworks = readStoredEvmNetworks();
    const removedNetwork = storedNetworks.find((network) => network.chainId === chainId);
    if (!removedNetwork) return false;
    const nextStoredNetworks = storedNetworks.filter((network) => network.chainId !== chainId);
    window.localStorage.setItem(verifiedEvmNetworksStorageKey, JSON.stringify(nextStoredNetworks));
    if (window.localStorage.getItem(preferredEvmNetworkStorageKey) === removedNetwork.id) {
      window.localStorage.setItem(preferredEvmNetworkStorageKey, evmNetworks[0].id);
    }
    return true;
  } catch {
    return false;
  }
}

export const initialEvmSendState: EvmSendState = {
  hash: "",
  message: "",
  status: "idle"
};

const disperseAbi = parseAbi([
  "function disperseEther(address[] recipients, uint256[] values) payable",
  "function disperseToken(address token, address[] recipients, uint256[] values)"
]);

const erc20Abi = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)"
]);

export function toEvmChain(config: EvmChainConfig, rpcEndpoint: string): Chain {
  return {
    blockExplorers: {
      default: {
        name: config.label,
        url: config.blockExplorerUrl
      }
    },
    id: config.chainId,
    name: config.label,
    nativeCurrency: config.nativeCurrency,
    rpcUrls: {
      default: {
        http: [rpcEndpoint]
      }
    }
  };
}

export function getEvmNetworkConfig(networkId: EvmDistributionNetworkId, networks = evmNetworks) {
  return networks.find((network) => network.id === networkId) || networks[0] || evmNetworks[0];
}

export function formatWei(value: bigint, decimals = 18) {
  return formatUnits(value, decimals).replace(/\.0$/, "");
}

export function formatWeiForDisplay(value: bigint, decimals = 18, maxFractionDigits = 4) {
  const [integer, fraction = ""] = formatWei(value, decimals).split(".");
  if (maxFractionDigits <= 0 || !fraction) return integer;

  const displayFraction = fraction.slice(0, maxFractionDigits).replace(/0+$/, "");
  return displayFraction ? `${integer}.${displayFraction}` : integer;
}

export function getEvmAssetSymbol(mode: EvmAssetMode, network: EvmNetworkConfig, token?: EvmTokenDetails | null) {
  if (mode === "token") return token?.symbol || "TOKEN";
  return isEvmNativeCurrencyEnabled(network) ? network.nativeCurrency.symbol : "原生币未开放";
}

export function isValidEvmAddress(value: string) {
  return isAddress(value);
}

export function parseEvmDistribution(input: string, decimals = 18): ParseEvmDistributionResult {
  const lines = input.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const seen = new Set<string>();
  const rows: EvmDistributionRow[] = [];
  let totalWei = 0n;
  let invalid = 0;
  let duplicates = 0;

  lines.forEach((line, index) => {
    const parts = line.split(",").map((part) => part.trim());
    const address = parts[0] || "";
    const amountRaw = parts[1] || "";
    let valueWei = 0n;
    const problems: string[] = [];

    if (parts.length !== 2) problems.push("格式需要刚好包含一个逗号");
    if (!isAddress(address)) problems.push("EVM 地址格式不正确");

    const amountMatch = amountRaw.length <= 160 ? amountRaw.match(/^(\d+)(?:\.(\d*))?$/) : null;
    const fractionDigits = amountMatch?.[2]?.length || 0;
    const normalizedWhole = amountMatch?.[1].replace(/^0+(?=\d)/, "") || "";
    if (!amountMatch || fractionDigits > decimals || normalizedWhole.length > 78) {
      problems.push(`金额需要大于 0，最多 ${decimals} 位小数`);
    } else {
      try {
        valueWei = parseUnits(amountRaw, decimals);
        if (valueWei <= 0n) problems.push("金额需要大于 0");
        else if (valueWei > (1n << 256n) - 1n) problems.push("金额不能超过 uint256 范围");
      } catch {
        problems.push(`金额需要大于 0，最多 ${decimals} 位小数`);
      }
    }

    if (isAddress(address)) {
      const duplicateKey = getDuplicateAddressKey(address, "evm");
      if (seen.has(duplicateKey)) {
        problems.push("重复地址不可发送");
        duplicates += 1;
      }
      seen.add(duplicateKey);
    }

    if (problems.length > 0) invalid += 1;
    else totalWei += valueWei;

    rows.push({
      address,
      amountRaw,
      line: index + 1,
      problems,
      status: problems.length ? "invalid" : "valid",
      valueWei
    });
  });

  const cleanRows = rows
    .filter((row) => row.status === "valid")
    .map((row) => `${getAddress(row.address)},${formatWei(row.valueWei, decimals)}`);

  return {
    cleanRows,
    duplicates,
    invalid,
    rows,
    total: formatWei(totalWei, decimals),
    totalWei,
    validRows: rows.filter((row) => row.status === "valid")
  };
}

export function getEvmExplorerUrl(hash: string, network: EvmNetworkConfig) {
  if (!network.blockExplorerUrl) return "";
  return `${network.blockExplorerUrl.replace(/\/+$/, "")}/tx/${hash}`;
}

export function getEvmTransactionErrorMessage(error: unknown) {
  const detail = error && typeof error === "object" && "message" in error ? String((error as { message?: unknown }).message || "") : String(error || "");
  const code = error && typeof error === "object" && "code" in error ? Number((error as { code?: unknown }).code) : 0;

  if (code === 4001 || /reject|declin|cancel/i.test(detail)) return "用户取消了交易确认";
  if (/insufficient|exceeds balance|not enough funds/i.test(detail)) return "钱包余额不足，无法完成本次分发";
  if (/RPC 网络不匹配|分发合约未部署|分发合约字节码不匹配|Token 合约未部署|Token 余额不足|Token 授权交易已上链但执行失败|签名前钱包的账户或网络已改变|Token 授权后复检未通过/i.test(detail)) return detail;
  if (/revert|execution reverted|执行失败/i.test(detail)) return "EVM 分发交易执行失败，资金未按清单分发，请打开交易详情核对";
  if (/chain|network|unsupported/i.test(detail)) return "钱包网络切换失败，请检查网络配置";
  if (/failed to fetch|network|fetch|timeout/i.test(detail)) return "RPC 请求失败，请更换 RPC 后重试";
  return detail ? `EVM 分发失败：${detail}` : "EVM 分发失败，请稍后重试";
}

export function getEvmTokenLookupErrorMessage(error: unknown) {
  const detail = error && typeof error === "object" && "message" in error ? String((error as { message?: unknown }).message || "") : String(error || "");

  if (/RPC 网络不匹配|Token 合约未部署/i.test(detail)) return detail;
  if (/failed to fetch|network|fetch|timeout/i.test(detail)) return "RPC 请求失败，请更换 RPC 后重试";
  if (/decode|decimals|returned no data|call exception/i.test(detail)) return "无法读取 Token 信息，请确认地址是标准 ERC20 合约";
  return detail ? `Token 信息读取失败：${detail}` : "Token 信息读取失败，请稍后重试";
}

export function getEvmBalanceLookupErrorMessage(error: unknown) {
  const detail = error && typeof error === "object" && "message" in error ? String((error as { message?: unknown }).message || "") : String(error || "");

  if (/RPC 网络不匹配|Token 合约未部署/i.test(detail)) return detail;
  if (/failed to fetch|network|fetch|timeout/i.test(detail)) return "余额读取失败，请更换 RPC 后重试";
  return detail ? `余额读取失败：${detail}` : "余额读取失败，请稍后重试";
}

export async function ensureEvmNetwork(provider: EvmWalletProvider, network: EvmChainConfig, rpcEndpoint: string) {
  const chainIdHex = `0x${network.chainId.toString(16)}`;
  const currentChainId = await provider.request({ method: "eth_chainId" });
  if (typeof currentChainId === "string" && Number.parseInt(currentChainId, 16) === network.chainId) return;

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainIdHex }]
    });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? Number((error as { code?: unknown }).code) : 0;
    if (code !== 4902) throw error;
    if (!isEvmNativeCurrencyEnabled(network)) {
      throw new Error(`钱包尚未添加 Chain ID ${network.chainId}；请先确认原生币元数据，再由页面添加网络`);
    }

    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{
        ...(network.blockExplorerUrl ? { blockExplorerUrls: [network.blockExplorerUrl] } : {}),
        chainId: chainIdHex,
        chainName: network.label,
        nativeCurrency: network.nativeCurrency,
        rpcUrls: [rpcEndpoint]
      }]
    });
  }
}

function parseEvmProviderChainId(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.trim();
  if (!/^(?:0x[\da-f]+|\d+)$/i.test(normalized)) return null;
  try {
    const parsed = Number(BigInt(normalized));
    return Number.isSafeInteger(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function assertEvmWalletContext({
  account,
  network,
  provider
}: {
  account: string;
  network: EvmChainConfig;
  provider: EvmWalletProvider;
}) {
  const [accountsValue, chainIdValue] = await Promise.all([
    provider.request({ method: "eth_accounts" }),
    provider.request({ method: "eth_chainId" })
  ]);
  const activeAccount = Array.isArray(accountsValue) && typeof accountsValue[0] === "string"
    ? accountsValue[0]
    : "";
  const expectedAccount = getAddress(account);

  if (parseEvmProviderChainId(chainIdValue) !== network.chainId
    || activeAccount.toLowerCase() !== expectedAccount.toLowerCase()) {
    throw new Error("签名前钱包的账户或网络已改变，请重新预检");
  }
}

export function createEvmPublicClient(network: EvmChainConfig, rpcEndpoint: string) {
  return createPublicClient({
    chain: toEvmChain(network, rpcEndpoint),
    transport: http(rpcEndpoint)
  });
}

export async function assertEvmRpcNetwork(publicClient: ReturnType<typeof createEvmPublicClient>, network: EvmChainConfig) {
  const rpcChainId = await publicClient.getChainId();

  if (rpcChainId !== network.chainId) {
    throw new Error(`RPC 网络不匹配：当前 RPC 是 chainId ${rpcChainId}，请选择 ${network.label} 的 RPC（chainId ${network.chainId}）`);
  }
}

async function ensureDisperseContract(publicClient: ReturnType<typeof createEvmPublicClient>, network: EvmNetworkConfig) {
  const contractCode = await publicClient.getCode({ address: network.disperseContractAddress });
  if (!contractCode || contractCode === "0x") {
    throw new Error(`${network.label} 分发合约未部署，无法在该网络分发`);
  }
  if (!hasExpectedDisperseContractCode(contractCode)) {
    throw new Error(`${network.label} 分发合约字节码不匹配，已阻止交易`);
  }
}

export function hasExpectedDisperseContractCode(contractCode: Hex) {
  return contractCode !== "0x" && keccak256(contractCode) === disperseContractRuntimeCodeHash;
}

async function ensureTokenContract(publicClient: ReturnType<typeof createEvmPublicClient>, network: EvmNetworkConfig, tokenAddress: Address) {
  const tokenCode = await publicClient.getCode({ address: tokenAddress });
  if (!tokenCode || tokenCode === "0x") {
    throw new Error(`${network.label} Token 合约未部署：${tokenAddress}`);
  }
}

async function readTokenString(
  publicClient: ReturnType<typeof createEvmPublicClient>,
  tokenAddress: Address,
  functionName: "name" | "symbol",
  fallback: string
) {
  try {
    const value = await publicClient.readContract({
      abi: erc20Abi,
      address: tokenAddress,
      functionName
    });
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
  } catch {
    return fallback;
  }
}

export async function getEvmTokenDetails({
  network,
  rpcEndpoint,
  tokenAddress
}: {
  network: EvmNetworkConfig;
  rpcEndpoint: string;
  tokenAddress: string;
}): Promise<EvmTokenDetails> {
  const address = getAddress(tokenAddress);
  const publicClient = createEvmPublicClient(network, rpcEndpoint);

  await assertEvmRpcNetwork(publicClient, network);
  await ensureTokenContract(publicClient, network, address);

  const decimals = Number(await publicClient.readContract({
    abi: erc20Abi,
    address,
    functionName: "decimals"
  }));

  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error("无法读取 Token decimals");
  }

  const [symbol, name] = await Promise.all([
    readTokenString(publicClient, address, "symbol", "TOKEN"),
    readTokenString(publicClient, address, "name", "ERC20 Token")
  ]);

  return {
    address,
    decimals,
    name,
    symbol
  };
}

export async function getEvmNativeBalance({
  address,
  network,
  rpcEndpoint
}: {
  address: string;
  network: EvmNetworkConfig;
  rpcEndpoint: string;
}) {
  const publicClient = createEvmPublicClient(network, rpcEndpoint);

  await assertEvmRpcNetwork(publicClient, network);
  return publicClient.getBalance({ address: getAddress(address) });
}

export async function getEvmTokenBalance({
  address,
  network,
  rpcEndpoint,
  tokenAddress
}: {
  address: string;
  network: EvmNetworkConfig;
  rpcEndpoint: string;
  tokenAddress: string;
}) {
  const ownerAddress = getAddress(address);
  const erc20Address = getAddress(tokenAddress);
  const publicClient = createEvmPublicClient(network, rpcEndpoint);

  await assertEvmRpcNetwork(publicClient, network);
  await ensureTokenContract(publicClient, network, erc20Address);

  return publicClient.readContract({
    abi: erc20Abi,
    address: erc20Address,
    args: [ownerAddress],
    functionName: "balanceOf"
  });
}

const fallbackTokenDistributionBaseGas = 120_000n;
const fallbackTokenDistributionGasPerRecipient = 65_000n;

function addDistributionFeeBuffer(gas: bigint, gasPrice: bigint) {
  return gas * gasPrice * 12n / 10n;
}

export async function preflightEvmDistribution({
  assetMode,
  from,
  gasSettings = autoEvmGasSettings,
  network,
  rows,
  rpcEndpoint,
  token
}: {
  assetMode: EvmAssetMode;
  from: string;
  gasSettings?: EvmGasSettings;
  network: EvmNetworkConfig;
  rows: EvmDistributionRow[];
  rpcEndpoint: string;
  token?: EvmTokenDetails | null;
}): Promise<EvmDistributionPreflightResult> {
  if (assetMode === "native" && !isEvmNativeCurrencyEnabled(network)) {
    throw new Error("原生币元数据尚未确认，已阻止原生币分发");
  }
  if (rows.length === 0) throw new Error("请先添加至少 1 个有效收款地址");

  const publicClient = createEvmPublicClient(network, rpcEndpoint);
  const account = getAddress(from);
  const recipients = rows.map((row) => getAddress(row.address));
  const values = rows.map((row) => row.valueWei);
  const totalWei = values.reduce((total, value) => total + value, 0n);

  await assertEvmRpcNetwork(publicClient, network);
  await ensureDisperseContract(publicClient, network);

  if (assetMode === "native") {
    const balance = await publicClient.getBalance({ address: account });
    if (balance < totalWei) {
      throw new Error(`钱包余额不足：分发金额需要 ${formatWei(totalWei, network.nativeCurrency.decimals)} ${network.nativeCurrency.symbol}，当前余额 ${formatWei(balance, network.nativeCurrency.decimals)} ${network.nativeCurrency.symbol}`);
    }

    const [gas, feeQuote] = await Promise.all([
      publicClient.estimateContractGas({
        abi: disperseAbi,
        account,
        address: network.disperseContractAddress,
        args: [recipients, values],
        functionName: "disperseEther",
        value: totalWei
      }),
      resolveEvmFeeQuote(publicClient, gasSettings)
    ]);
    const estimatedNetworkFeeWei = addDistributionFeeBuffer(gas, getEvmFeeCapPerGas(feeQuote));
    const requiredNativeWei = totalWei + estimatedNetworkFeeWei;
    if (balance < requiredNativeWei) {
      throw new Error(`钱包余额不足：分发与预估网络费共需 ${formatWei(requiredNativeWei, network.nativeCurrency.decimals)} ${network.nativeCurrency.symbol}，当前余额 ${formatWei(balance, network.nativeCurrency.decimals)} ${network.nativeCurrency.symbol}`);
    }

    return {
      assetBalanceWei: balance,
      estimatedNetworkFeeWei,
      feeEstimateBasis: "rpc",
      feeQuote,
      nativeBalanceWei: balance,
      needsApproval: false,
      requiredNativeWei,
      totalTransactions: 1
    };
  }

  if (!token) throw new Error("请先填写并读取 ERC20 Token 合约地址");
  const tokenAddress = getAddress(token.address);
  await ensureTokenContract(publicClient, network, tokenAddress);
  const [tokenBalance, allowance, nativeBalance, feeQuote] = await Promise.all([
    publicClient.readContract({
      abi: erc20Abi,
      address: tokenAddress,
      args: [account],
      functionName: "balanceOf"
    }),
    publicClient.readContract({
      abi: erc20Abi,
      address: tokenAddress,
      args: [account, network.disperseContractAddress],
      functionName: "allowance"
    }),
    publicClient.getBalance({ address: account }),
    resolveEvmFeeQuote(publicClient, gasSettings)
  ]);
  if (tokenBalance < totalWei) {
    throw new Error(`Token 余额不足：本次需要 ${formatWei(totalWei, token.decimals)} ${token.symbol}，当前余额 ${formatWei(tokenBalance, token.decimals)} ${token.symbol}`);
  }

  const needsApproval = allowance < totalWei;
  const approvalGas = needsApproval
    ? await publicClient.estimateContractGas({
      abi: erc20Abi,
      account,
      address: tokenAddress,
      args: [network.disperseContractAddress, totalWei],
      functionName: "approve"
    })
    : 0n;
  const distributionGas = needsApproval
    ? fallbackTokenDistributionBaseGas + BigInt(rows.length) * fallbackTokenDistributionGasPerRecipient
    : await publicClient.estimateContractGas({
      abi: disperseAbi,
      account,
      address: network.disperseContractAddress,
      args: [tokenAddress, recipients, values],
      functionName: "disperseToken"
    });
  const estimatedNetworkFeeWei = addDistributionFeeBuffer(
    approvalGas + distributionGas,
    getEvmFeeCapPerGas(feeQuote)
  );
  if (nativeBalance < estimatedNetworkFeeWei) {
    throw new Error(`原生币余额不足以支付预估网络费：需要约 ${formatWei(estimatedNetworkFeeWei, network.nativeCurrency.decimals)} ${network.nativeCurrency.symbol}，当前余额 ${formatWei(nativeBalance, network.nativeCurrency.decimals)} ${network.nativeCurrency.symbol}`);
  }

  return {
    assetBalanceWei: tokenBalance,
    estimatedNetworkFeeWei,
    feeEstimateBasis: needsApproval ? "conservative" : "rpc",
    feeQuote,
    nativeBalanceWei: nativeBalance,
    needsApproval,
    requiredNativeWei: estimatedNetworkFeeWei,
    totalTransactions: needsApproval ? 2 : 1
  };
}

export async function sendEvmNativeDistribution({
  assertWalletContext = assertEvmWalletContext,
  feeQuote,
  from,
  gasSettings = autoEvmGasSettings,
  onSubmitted,
  provider,
  rows,
  rpcEndpoint,
  network
}: {
  assertWalletContext?: typeof assertEvmWalletContext;
  feeQuote?: EvmFeeQuote;
  from: string;
  gasSettings?: EvmGasSettings;
  network: EvmNetworkConfig;
  onSubmitted?: (hash: Hash) => void;
  provider: EvmWalletProvider;
  rows: EvmDistributionRow[];
  rpcEndpoint: string;
}) {
  if (!isEvmNativeCurrencyEnabled(network)) {
    throw new Error("原生币元数据尚未确认，已阻止原生币分发");
  }
  const chain = toEvmChain(network, rpcEndpoint);
  const publicClient = createEvmPublicClient(network, rpcEndpoint);
  const walletClient = createWalletClient({
    chain,
    transport: custom(provider)
  });
  const account = getAddress(from);
  const recipients = rows.map((row) => getAddress(row.address));
  const values = rows.map((row) => row.valueWei);
  const totalWei = values.reduce((total, value) => total + value, 0n);

  await assertEvmRpcNetwork(publicClient, network);
  await ensureDisperseContract(publicClient, network);

  const balance = await publicClient.getBalance({ address: account });

  if (balance < totalWei) {
    throw new Error(`钱包余额不足：本次至少需要 ${formatWei(totalWei, network.nativeCurrency.decimals)} ${network.nativeCurrency.symbol}，当前余额 ${formatWei(balance, network.nativeCurrency.decimals)} ${network.nativeCurrency.symbol}`);
  }

  await assertWalletContext({ account, network, provider });
  const resolvedFeeQuote = feeQuote || await resolveEvmFeeQuote(publicClient, gasSettings);
  const hash = await walletClient.writeContract({
    abi: disperseAbi,
    account,
    address: network.disperseContractAddress,
    args: [recipients, values],
    functionName: "disperseEther",
    ...getEvmFeeRequest(resolvedFeeQuote),
    value: totalWei
  });
  onSubmitted?.(hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error("EVM 分发交易已上链但执行失败");
  }
  return { feeQuote: resolvedFeeQuote, hash, receipt };
}

export async function sendEvmTokenDistribution({
  assertWalletContext = assertEvmWalletContext,
  feeQuote,
  from,
  gasSettings = autoEvmGasSettings,
  network,
  onStep,
  postApprovalPreflight = preflightEvmDistribution,
  provider,
  rows,
  rpcEndpoint,
  token
}: {
  assertWalletContext?: typeof assertEvmWalletContext;
  feeQuote?: EvmFeeQuote;
  from: string;
  gasSettings?: EvmGasSettings;
  network: EvmNetworkConfig;
  onStep?: (step: EvmTokenDistributionStep) => void;
  postApprovalPreflight?: typeof preflightEvmDistribution;
  provider: EvmWalletProvider;
  rows: EvmDistributionRow[];
  rpcEndpoint: string;
  token: EvmTokenDetails;
}) {
  const chain = toEvmChain(network, rpcEndpoint);
  const publicClient = createEvmPublicClient(network, rpcEndpoint);
  const walletClient = createWalletClient({
    chain,
    transport: custom(provider)
  });
  const account = getAddress(from);
  const tokenAddress = getAddress(token.address);
  const recipients = rows.map((row) => getAddress(row.address));
  const values = rows.map((row) => row.valueWei);
  const totalWei = values.reduce((total, value) => total + value, 0n);

  await assertEvmRpcNetwork(publicClient, network);
  await ensureDisperseContract(publicClient, network);
  await ensureTokenContract(publicClient, network, tokenAddress);

  const [balance, allowance] = await Promise.all([
    publicClient.readContract({
      abi: erc20Abi,
      address: tokenAddress,
      args: [account],
      functionName: "balanceOf"
    }),
    publicClient.readContract({
      abi: erc20Abi,
      address: tokenAddress,
      args: [account, network.disperseContractAddress],
      functionName: "allowance"
    })
  ]);

  if (balance < totalWei) {
    throw new Error(`Token 余额不足：本次至少需要 ${formatWei(totalWei, token.decimals)} ${token.symbol}，当前余额 ${formatWei(balance, token.decimals)} ${token.symbol}`);
  }

  const needsApproval = allowance < totalWei;
  const totalTransactions = needsApproval ? 2 : 1;
  const hashes: Hash[] = [];
  let resolvedFeeQuote = feeQuote || await resolveEvmFeeQuote(publicClient, gasSettings);

  onStep?.({
    needsApproval,
    totalTransactions,
    type: "allowance-checked"
  });

  if (needsApproval) {
    await assertWalletContext({ account, network, provider });
    const approvalHash = await walletClient.writeContract({
      abi: erc20Abi,
      account,
      address: tokenAddress,
      args: [network.disperseContractAddress, totalWei],
      functionName: "approve",
      ...getEvmFeeRequest(resolvedFeeQuote)
    });
    hashes.push(approvalHash);
    onStep?.({
      hash: approvalHash,
      totalTransactions: 2,
      type: "approval-submitted"
    });

    const approvalReceipt = await publicClient.waitForTransactionReceipt({ hash: approvalHash });
    if (approvalReceipt.status !== "success") {
      throw new Error("Token 授权交易已上链但执行失败");
    }

    onStep?.({
      hash: approvalHash,
      totalTransactions: 2,
      type: "approval-confirmed"
    });

    await assertWalletContext({ account, network, provider });
    const freshPreflight = await postApprovalPreflight({
      assetMode: "token",
      from: account,
      gasSettings,
      network,
      rows,
      rpcEndpoint,
      token
    });
    if (freshPreflight.needsApproval) {
      throw new Error("Token 授权后复检未通过：授权额度仍不足，请核对授权交易后重新预检");
    }
    resolvedFeeQuote = freshPreflight.feeQuote;
  }

  await assertWalletContext({ account, network, provider });
  const hash = await walletClient.writeContract({
    abi: disperseAbi,
    account,
    address: network.disperseContractAddress,
    args: [tokenAddress, recipients, values],
    functionName: "disperseToken",
    ...getEvmFeeRequest(resolvedFeeQuote)
  });
  hashes.push(hash);
  onStep?.({
    hash,
    hashes: [...hashes],
    totalTransactions,
    type: "distribution-submitted"
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error("EVM 分发交易已上链但执行失败");
  }

  onStep?.({
    hash,
    hashes: [...hashes],
    totalTransactions,
    type: "distribution-confirmed"
  });

  return { feeQuote: resolvedFeeQuote, hash, hashes, receipt };
}
