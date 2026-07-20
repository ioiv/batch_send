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

export type EvmNetworkId =
  | "ethereum"
  | "optimism"
  | "bsc"
  | "gnosis"
  | "polygon"
  | "base"
  | "arbitrum"
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

export type EvmSendState = {
  hash: Hash | "";
  message: string;
  status: "idle" | "preparing" | "awaiting-wallet" | "confirming" | "success" | "error";
};

export const disperseContractAddress = "0xd15fE25eD0Dba12fE05e7029C88b10C25e8880E3";
export const disperseContractRuntimeCodeHash = "0xc0a38c227d2c70248fc51ed0dd3a72df3adf5b41494c7f3cc19c16c38523244d";

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
    label: "Sepolia",
    nativeCurrency: { decimals: 18, name: "Sepolia Ether", symbol: "ETH" },
    rpcEndpoint: rpcConfig.evm.sepolia
  }
];

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

export function formatWeiForDisplay(value: bigint, decimals = 18, maxFractionDigits = 4) {
  const [integer, fraction = ""] = formatWei(value, decimals).split(".");
  if (maxFractionDigits <= 0 || !fraction) return integer;

  const displayFraction = fraction.slice(0, maxFractionDigits).replace(/0+$/, "");
  return displayFraction ? `${integer}.${displayFraction}` : integer;
}

export function getEvmAssetSymbol(mode: EvmAssetMode, network: EvmNetworkConfig, token?: EvmTokenDetails | null) {
  return mode === "token" ? token?.symbol || "TOKEN" : network.nativeCurrency.symbol;
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
  if (/RPC 网络不匹配|分发合约未部署|分发合约字节码不匹配|Token 合约未部署|Token 余额不足|Token 授权交易已上链但执行失败/i.test(detail)) return detail;
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

function createEvmPublicClient(network: EvmNetworkConfig, rpcEndpoint: string) {
  return createPublicClient({
    chain: toChain(network, rpcEndpoint),
    transport: http(rpcEndpoint)
  });
}

async function assertEvmRpcNetwork(publicClient: ReturnType<typeof createEvmPublicClient>, network: EvmNetworkConfig) {
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

  const hash = await walletClient.writeContract({
    abi: disperseAbi,
    account,
    address: network.disperseContractAddress,
    args: [recipients, values],
    functionName: "disperseEther",
    value: totalWei
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error("EVM 分发交易已上链但执行失败");
  }
  return { hash, receipt };
}

export async function sendEvmTokenDistribution({
  from,
  network,
  onStep,
  provider,
  rows,
  rpcEndpoint,
  token
}: {
  from: string;
  network: EvmNetworkConfig;
  onStep?: (step: EvmTokenDistributionStep) => void;
  provider: EvmWalletProvider;
  rows: EvmDistributionRow[];
  rpcEndpoint: string;
  token: EvmTokenDetails;
}) {
  const chain = toChain(network, rpcEndpoint);
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

  onStep?.({
    needsApproval,
    totalTransactions,
    type: "allowance-checked"
  });

  if (needsApproval) {
    const approvalHash = await walletClient.writeContract({
      abi: erc20Abi,
      account,
      address: tokenAddress,
      args: [network.disperseContractAddress, totalWei],
      functionName: "approve"
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
  }

  const hash = await walletClient.writeContract({
    abi: disperseAbi,
    account,
    address: network.disperseContractAddress,
    args: [tokenAddress, recipients, values],
    functionName: "disperseToken"
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

  return { hash, hashes, receipt };
}
