import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseAbi,
  parseUnits,
  type Address,
  type Chain,
  type Hash
} from "viem";
import type { EvmWalletProvider } from "../hooks/useEvmWallet";
import { getDuplicateAddressKey } from "./address";

export type EvmNetworkId =
  | "ethereum"
  | "optimism"
  | "bsc"
  | "gnosis"
  | "polygon"
  | "fantom"
  | "moonbeam"
  | "moonriver"
  | "base"
  | "arbitrum"
  | "avalanche"
  | "sepolia";

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

export type EvmNetworkConfig = {
  blockExplorerUrl: string;
  chainId: number;
  disperseContractAddress: Address;
  id: EvmNetworkId;
  label: string;
  nativeCurrency: {
    decimals: number;
    name: string;
    symbol: string;
  };
  rpcEndpoint: string;
};

export type EvmSendState = {
  hash: Hash | "";
  message: string;
  status: "idle" | "preparing" | "awaiting-wallet" | "confirming" | "success" | "error";
};

export const disperseContractAddress = "0xd152f549545093347a162dce210e7293f1452150";

export const evmNetworks: EvmNetworkConfig[] = [
  {
    blockExplorerUrl: "https://etherscan.io",
    chainId: 1,
    disperseContractAddress,
    id: "ethereum",
    label: "Ethereum",
    nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
    rpcEndpoint: "https://rpc.ankr.com/eth"
  },
  {
    blockExplorerUrl: "https://optimistic.etherscan.io",
    chainId: 10,
    disperseContractAddress,
    id: "optimism",
    label: "Optimism",
    nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
    rpcEndpoint: "https://mainnet.optimism.io"
  },
  {
    blockExplorerUrl: "https://bscscan.com",
    chainId: 56,
    disperseContractAddress,
    id: "bsc",
    label: "BNB Chain",
    nativeCurrency: { decimals: 18, name: "BNB", symbol: "BNB" },
    rpcEndpoint: "https://bsc-dataseed.binance.org"
  },
  {
    blockExplorerUrl: "https://gnosisscan.io",
    chainId: 100,
    disperseContractAddress,
    id: "gnosis",
    label: "Gnosis",
    nativeCurrency: { decimals: 18, name: "xDAI", symbol: "xDAI" },
    rpcEndpoint: "https://rpc.gnosischain.com"
  },
  {
    blockExplorerUrl: "https://polygonscan.com",
    chainId: 137,
    disperseContractAddress,
    id: "polygon",
    label: "Polygon",
    nativeCurrency: { decimals: 18, name: "POL", symbol: "POL" },
    rpcEndpoint: "https://polygon-rpc.com"
  },
  {
    blockExplorerUrl: "https://ftmscan.com",
    chainId: 250,
    disperseContractAddress,
    id: "fantom",
    label: "Fantom",
    nativeCurrency: { decimals: 18, name: "Fantom", symbol: "FTM" },
    rpcEndpoint: "https://rpcapi.fantom.network"
  },
  {
    blockExplorerUrl: "https://moonbeam.moonscan.io",
    chainId: 1284,
    disperseContractAddress,
    id: "moonbeam",
    label: "Moonbeam",
    nativeCurrency: { decimals: 18, name: "Glimmer", symbol: "GLMR" },
    rpcEndpoint: "https://rpc.api.moonbeam.network"
  },
  {
    blockExplorerUrl: "https://moonriver.moonscan.io",
    chainId: 1285,
    disperseContractAddress,
    id: "moonriver",
    label: "Moonriver",
    nativeCurrency: { decimals: 18, name: "Moonriver", symbol: "MOVR" },
    rpcEndpoint: "https://rpc.api.moonriver.moonbeam.network"
  },
  {
    blockExplorerUrl: "https://basescan.org",
    chainId: 8453,
    disperseContractAddress,
    id: "base",
    label: "Base",
    nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
    rpcEndpoint: "https://mainnet.base.org"
  },
  {
    blockExplorerUrl: "https://arbiscan.io",
    chainId: 42161,
    disperseContractAddress,
    id: "arbitrum",
    label: "Arbitrum",
    nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
    rpcEndpoint: "https://arb1.arbitrum.io/rpc"
  },
  {
    blockExplorerUrl: "https://snowtrace.io",
    chainId: 43114,
    disperseContractAddress,
    id: "avalanche",
    label: "Avalanche",
    nativeCurrency: { decimals: 18, name: "Avalanche", symbol: "AVAX" },
    rpcEndpoint: "https://api.avax.network/ext/bc/C/rpc"
  },
  {
    blockExplorerUrl: "https://sepolia.etherscan.io",
    chainId: 11155111,
    disperseContractAddress,
    id: "sepolia",
    label: "Sepolia",
    nativeCurrency: { decimals: 18, name: "Sepolia Ether", symbol: "ETH" },
    rpcEndpoint: "https://rpc.sepolia.org"
  }
];

export const initialEvmSendState: EvmSendState = {
  hash: "",
  message: "",
  status: "idle"
};

const disperseAbi = parseAbi([
  "function disperseEther(address[] recipients, uint256[] values) payable"
]);

function toChain(config: EvmNetworkConfig, rpcEndpoint: string): Chain {
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

export function getEvmNetworkConfig(networkId: EvmNetworkId) {
  return evmNetworks.find((network) => network.id === networkId) || evmNetworks[0];
}

export function formatWei(value: bigint, decimals = 18) {
  return formatUnits(value, decimals).replace(/\.0$/, "");
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

    try {
      valueWei = parseUnits(amountRaw, decimals);
      if (valueWei <= 0n) problems.push("金额需要大于 0");
    } catch {
      problems.push(`金额需要大于 0，最多 ${decimals} 位小数`);
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
  return `${network.blockExplorerUrl}/tx/${hash}`;
}

export function getEvmTransactionErrorMessage(error: unknown) {
  const detail = error && typeof error === "object" && "message" in error ? String((error as { message?: unknown }).message || "") : String(error || "");
  const code = error && typeof error === "object" && "code" in error ? Number((error as { code?: unknown }).code) : 0;

  if (code === 4001 || /reject|declin|cancel/i.test(detail)) return "用户取消了交易确认";
  if (/insufficient|exceeds balance|not enough funds/i.test(detail)) return "钱包余额不足，无法完成本次分发";
  if (/chain|network|unsupported/i.test(detail)) return "钱包网络切换失败，请检查网络配置";
  if (/failed to fetch|network|fetch|timeout/i.test(detail)) return "RPC 请求失败，请更换 RPC 后重试";
  return detail ? `EVM 分发失败：${detail}` : "EVM 分发失败，请稍后重试";
}

export async function ensureEvmNetwork(provider: EvmWalletProvider, network: EvmNetworkConfig, rpcEndpoint: string) {
  const chainIdHex = `0x${network.chainId.toString(16)}`;

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainIdHex }]
    });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? Number((error as { code?: unknown }).code) : 0;
    if (code !== 4902) throw error;

    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{
        blockExplorerUrls: [network.blockExplorerUrl],
        chainId: chainIdHex,
        chainName: network.label,
        nativeCurrency: network.nativeCurrency,
        rpcUrls: [rpcEndpoint]
      }]
    });
  }
}

export async function sendEvmNativeDistribution({
  from,
  provider,
  rows,
  rpcEndpoint,
  network
}: {
  from: string;
  network: EvmNetworkConfig;
  provider: EvmWalletProvider;
  rows: EvmDistributionRow[];
  rpcEndpoint: string;
}) {
  const chain = toChain(network, rpcEndpoint);
  const publicClient = createPublicClient({
    chain,
    transport: http(rpcEndpoint)
  });
  const walletClient = createWalletClient({
    chain,
    transport: custom(provider)
  });
  const account = getAddress(from);
  const recipients = rows.map((row) => getAddress(row.address));
  const values = rows.map((row) => row.valueWei);
  const totalWei = values.reduce((total, value) => total + value, 0n);
  const balance = await publicClient.getBalance({ address: account });

  if (balance < totalWei) {
    throw new Error(`钱包余额不足：本次至少需要 ${formatWei(totalWei, network.nativeCurrency.decimals)} ${network.nativeCurrency.symbol}，当前余额 ${formatWei(balance, network.nativeCurrency.decimals)} ${network.nativeCurrency.symbol}`);
  }

  const hash = await walletClient.writeContract({
    abi: disperseAbi,
    account,
    address: network.disperseContractAddress,
    args: [recipients, values],
    functionName: "disperseEther",
    value: totalWei
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return { hash, receipt };
}
