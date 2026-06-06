import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Buffer } from "buffer";
import {
  clusterApiUrl,
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  type SendOptions,
  type TransactionSignature
} from "@solana/web3.js";
import "./app.css";
import "../warm-ivory.css";

globalThis.Buffer = globalThis.Buffer || Buffer;

type ReviewStatus = "valid" | "warn" | "invalid";
type WalletStatus = "idle" | "connecting" | "connected" | "missing" | "error";
type DistributionSendStatus = "idle" | "preparing" | "awaiting-wallet" | "confirming" | "success" | "error";
type SolanaPublicKey = {
  toBase58?: () => string;
  toString: () => string;
};
type WalletConnectResult = {
  publicKey?: SolanaPublicKey | string | null;
};
type SolanaWalletProvider = {
  isPhantom?: boolean;
  isSolflare?: boolean;
  isBackpack?: boolean;
  isOkxWallet?: boolean;
  isConnected?: boolean;
  publicKey?: SolanaPublicKey | string | null;
  connect: (options?: { onlyIfTrusted?: boolean }) => Promise<WalletConnectResult | void>;
  disconnect?: () => Promise<void> | void;
  signAndSendTransaction?: (transaction: Transaction, options?: SendOptions) => Promise<{ signature?: TransactionSignature } | TransactionSignature>;
  signAllTransactions?: (transactions: Transaction[]) => Promise<Transaction[]>;
  signTransaction?: (transaction: Transaction) => Promise<Transaction>;
  on?: (event: "connect" | "disconnect" | "accountChanged", listener: (...args: unknown[]) => void) => void;
  off?: (event: "connect" | "disconnect" | "accountChanged", listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: "connect" | "disconnect" | "accountChanged", listener: (...args: unknown[]) => void) => void;
};
type DetectedWallet = {
  id: string;
  name: string;
  provider: SolanaWalletProvider;
  priority: number;
  installUrl: string;
};
type SolanaNetworkId = "mainnet-beta" | "devnet" | "testnet";
type DistributionSendState = {
  message: string;
  signatures: TransactionSignature[];
  status: DistributionSendStatus;
};

declare global {
  interface Window {
    phantom?: {
      solana?: SolanaWalletProvider;
    };
    okxwallet?: {
      solana?: SolanaWalletProvider;
    };
    solflare?: SolanaWalletProvider;
    backpack?: SolanaWalletProvider | {
      solana?: SolanaWalletProvider;
    };
    solana?: SolanaWalletProvider;
    __solBatchSendRoot?: Root;
  }
}

const solanaAddressPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const evmAddressPattern = /^0x[a-fA-F0-9]{40}$/;
const walletInstallUrl = "https://phantom.app/download";
const walletConnectionTimeoutMs = 45_000;
const fallbackTransfersPerTransaction = 8;
const solanaLegacyTransactionSizeLimitBytes = 1232;
const transactionEstimateSenderAddress = "BPFLoader1111111111111111111111111111111111";
const transactionEstimateBlockhash = "11111111111111111111111111111111";
const lamportsPerSolBigInt = BigInt(LAMPORTS_PER_SOL);
const distributionListQueryParam = "list";
const distributionTransferQueryParam = "from";
const distributionTransferSource = "format-generator";
const distributionTransferStorageKey = "sol_batch_send.generated_distribution";
const maxDistributionUrlQueryLength = 1800;
const solanaNetworks: Array<{ endpoint: string; id: SolanaNetworkId; label: string }> = [
  { endpoint: "https://mainnet.helius-rpc.com/?api-key=7e5a91f2-b7f1-40c6-a9eb-12f67d18e5d1", id: "mainnet-beta", label: "Mainnet" },
  { endpoint: "https://devnet.helius-rpc.com/?api-key=7e5a91f2-b7f1-40c6-a9eb-12f67d18e5d1", id: "devnet", label: "Devnet" },
  { endpoint: clusterApiUrl("testnet"), id: "testnet", label: "Testnet" }
];
const initialSendState: DistributionSendState = {
  message: "",
  signatures: [],
  status: "idle"
};

function formatSol(value: number) {
  return Number(value.toFixed(4)).toString();
}

function getNetworkConfig(networkId: SolanaNetworkId) {
  return solanaNetworks.find((network) => network.id === networkId) || solanaNetworks[0];
}

function getExplorerUrl(signature: TransactionSignature, networkId: SolanaNetworkId) {
  const cluster = networkId === "mainnet-beta" ? "" : `?cluster=${networkId}`;
  return `https://solscan.io/tx/${signature}${cluster}`;
}

function formatLamports(lamports: bigint) {
  const whole = lamports / lamportsPerSolBigInt;
  const fraction = lamports % lamportsPerSolBigInt;
  if (fraction === 0n) return whole.toString();
  const fractionText = fraction.toString().padStart(9, "0").replace(/0+$/, "");
  return `${whole}.${fractionText}`;
}

function parseSolToLamports(value: string) {
  const match = value.trim().match(/^(\d+)(?:\.(\d{0,9}))?$/);
  if (!match) return null;

  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] || "").padEnd(9, "0"));
  const lamports = whole * lamportsPerSolBigInt + fraction;
  return lamports > 0n ? lamports : null;
}

function isValidSolanaAddress(address: string) {
  if (!solanaAddressPattern.test(address)) return false;
  try {
    return new PublicKey(address).toBase58() === address;
  } catch {
    return false;
  }
}

function getListAddressKind(address: string) {
  if (isValidSolanaAddress(address)) return "solana";
  if (evmAddressPattern.test(address)) return "evm";
  return null;
}

function getDuplicateAddressKey(address: string, kind: "solana" | "evm") {
  return kind === "evm" ? address.toLowerCase() : address;
}

function chunkRows<T>(rows: T[], chunkSize: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += chunkSize) {
    chunks.push(rows.slice(index, index + chunkSize));
  }
  return chunks;
}

function isSolanaProvider(provider?: SolanaWalletProvider | null): provider is SolanaWalletProvider {
  return Boolean(provider && typeof provider.connect === "function");
}

function addWalletCandidate(wallets: DetectedWallet[], candidate: DetectedWallet) {
  if (!isSolanaProvider(candidate.provider)) return;
  if (wallets.some((wallet) => wallet.provider === candidate.provider || wallet.id === candidate.id)) return;
  wallets.push(candidate);
}

function getBackpackProvider(): SolanaWalletProvider | undefined {
  const backpack = window.backpack;
  if (!backpack) return undefined;
  if (isSolanaProvider(backpack as SolanaWalletProvider)) return backpack as SolanaWalletProvider;
  return (backpack as { solana?: SolanaWalletProvider }).solana;
}

function getWalletsFromSolanaProvider(provider: SolanaWalletProvider, wallets: DetectedWallet[]) {
  if (provider.isPhantom) {
    addWalletCandidate(wallets, {
      id: "phantom",
      installUrl: walletInstallUrl,
      name: "Phantom",
      priority: 10,
      provider
    });
    return;
  }

  if (provider.isSolflare) {
    addWalletCandidate(wallets, {
      id: "solflare",
      installUrl: "https://solflare.com/download",
      name: "Solflare",
      priority: 30,
      provider
    });
    return;
  }

  if (provider.isBackpack) {
    addWalletCandidate(wallets, {
      id: "backpack",
      installUrl: "https://backpack.app/download",
      name: "Backpack",
      priority: 40,
      provider
    });
    return;
  }

  addWalletCandidate(wallets, {
    id: "solana",
    installUrl: walletInstallUrl,
    name: "Solana 钱包",
    priority: 90,
    provider
  });
}

function getSolanaWallets() {
  if (typeof window === "undefined") return null;
  const wallets: DetectedWallet[] = [];
  const phantom = window.phantom?.solana;
  const okx = window.okxwallet?.solana;
  const solflare = window.solflare;
  const backpack = getBackpackProvider();

  if (phantom?.isPhantom) {
    addWalletCandidate(wallets, {
      id: "phantom",
      installUrl: walletInstallUrl,
      name: "Phantom",
      priority: 10,
      provider: phantom
    });
  }

  if (isSolanaProvider(okx)) {
    addWalletCandidate(wallets, {
      id: "okx",
      installUrl: "https://www.okx.com/web3",
      name: "OKX Wallet",
      priority: 20,
      provider: okx
    });
  }

  if (isSolanaProvider(solflare)) {
    addWalletCandidate(wallets, {
      id: "solflare",
      installUrl: "https://solflare.com/download",
      name: "Solflare",
      priority: 30,
      provider: solflare
    });
  }

  if (isSolanaProvider(backpack)) {
    addWalletCandidate(wallets, {
      id: "backpack",
      installUrl: "https://backpack.app/download",
      name: "Backpack",
      priority: 40,
      provider: backpack
    });
  }

  if (isSolanaProvider(window.solana)) getWalletsFromSolanaProvider(window.solana, wallets);

  return wallets.sort((left, right) => left.priority - right.priority);
}

function getPreferredWallet(wallets: DetectedWallet[], preferredWalletId?: string) {
  return wallets.find((wallet) => wallet.id === preferredWalletId)
    || wallets.find((wallet) => getPublicKeyText(wallet.provider.publicKey) || wallet.provider.isConnected)
    || wallets[0]
    || null;
}

function getMissingWalletMessage() {
  if (typeof window === "undefined") return "未检测到浏览器钱包";
  const { hostname, protocol } = window.location;
  const canInject = protocol === "https:" || hostname === "localhost" || hostname === "127.0.0.1";
  return canInject ? "未检测到 Phantom / OKX 钱包" : "请通过 localhost 或 HTTPS 打开页面";
}

function getPublicKeyText(publicKey?: SolanaPublicKey | string | null) {
  if (typeof publicKey === "string") return publicKey;
  const text = publicKey?.toBase58?.() || publicKey?.toString?.() || "";
  return text && text !== "[object Object]" ? text : "";
}

function shortenAddress(address: string) {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

function getWalletErrorMessage(error: unknown) {
  const detail = error && typeof error === "object" && "message" in error ? String((error as { message?: unknown }).message || "") : "";
  const code = error && typeof error === "object" && "code" in error ? Number((error as { code?: unknown }).code) : 0;

  if (code === 4001 || /reject|declin|cancel/i.test(detail)) return "用户取消了钱包连接";
  if (/already pending/i.test(detail)) return "钱包正在处理上一次连接请求";
  if (/timeout/i.test(detail)) return "钱包确认超时，请重新点击连接";
  return "钱包连接失败，请稍后重试";
}

function getTransactionErrorMessage(error: unknown) {
  const detail = error && typeof error === "object" && "message" in error ? String((error as { message?: unknown }).message || "") : String(error || "");
  const code = error && typeof error === "object" && "code" in error ? Number((error as { code?: unknown }).code) : 0;

  if (code === 4001 || /reject|declin|cancel/i.test(detail)) return "用户取消了交易确认";
  if (/403|429|failed to fetch|network|fetch/i.test(detail)) return "RPC 请求失败，请更换 RPC 后重试";
  if (/insufficient|Attempt to debit|0x1/i.test(detail)) return "钱包余额不足，无法完成本次分发";
  if (/blockhash|expired/i.test(detail)) return "交易区块哈希已过期，请重新提交";
  if (/too large|encoding overruns|transaction too large/i.test(detail)) return "单笔交易过大，请减少本次清单数量";
  if (/timeout/i.test(detail)) return "交易确认超时，请稍后检查链上状态";
  return detail ? `交易发送失败：${detail}` : "交易发送失败，请稍后重试";
}

function connectWithTimeout(provider: SolanaWalletProvider) {
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error("Wallet connection timeout")), walletConnectionTimeoutMs);
  });

  return Promise.race([provider.connect(), timeout]).finally(() => {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  });
}

function getSignatureFromResult(result: { signature?: TransactionSignature } | TransactionSignature) {
  if (typeof result === "string") return result;
  if (result.signature) return result.signature;
  throw new Error("Wallet returned no transaction signature");
}

async function sendWalletTransaction(provider: SolanaWalletProvider, transaction: Transaction, connection: Connection) {
  const sendOptions: SendOptions = {
    preflightCommitment: "confirmed",
    skipPreflight: false
  };

  if (provider.signAndSendTransaction) {
    return getSignatureFromResult(await provider.signAndSendTransaction(transaction, sendOptions));
  }

  if (provider.signTransaction) {
    const signedTransaction = await provider.signTransaction(transaction);
    return connection.sendRawTransaction(signedTransaction.serialize(), sendOptions);
  }

  throw new Error("当前钱包不支持交易签名");
}

function useSolanaWallet() {
  const [wallets, setWallets] = useState<DetectedWallet[]>([]);
  const [selectedWalletId, setSelectedWalletId] = useState("");
  const [provider, setProvider] = useState<SolanaWalletProvider | null>(null);
  const [providerName, setProviderName] = useState("Solana 钱包");
  const [address, setAddress] = useState("");
  const [status, setStatus] = useState<WalletStatus>("idle");
  const [message, setMessage] = useState("");

  const selectedWallet = useMemo(() => getPreferredWallet(wallets, selectedWalletId), [selectedWalletId, wallets]);

  const refreshWallets = useCallback(() => {
    const detectedWallets = getSolanaWallets() || [];
    setWallets(detectedWallets);
    setSelectedWalletId((current) => getPreferredWallet(detectedWallets, current)?.id || "");
    if (!detectedWallets.length) {
      setProvider(null);
      setProviderName("Solana 钱包");
      setStatus("missing");
      setMessage(getMissingWalletMessage());
    }
    return detectedWallets;
  }, []);

  useEffect(() => {
    refreshWallets();
    const timers = [250, 800, 1600].map((delay) => window.setTimeout(refreshWallets, delay));
    window.addEventListener("load", refreshWallets);
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      window.removeEventListener("load", refreshWallets);
    };
  }, [refreshWallets]);

  useEffect(() => {
    if (!selectedWallet) return;

    const { name, provider: walletProvider } = selectedWallet;
    setProvider(walletProvider);
    setProviderName(name);

    const syncConnectedAddress = (publicKey?: SolanaPublicKey | string | null) => {
      const nextAddress = getPublicKeyText(publicKey) || getPublicKeyText(walletProvider.publicKey);
      setAddress(nextAddress);
      setStatus(nextAddress ? "connected" : "idle");
      setMessage(nextAddress ? "钱包已连接" : "");
    };
    const handleConnect = (...args: unknown[]) => {
      syncConnectedAddress(args[0] as SolanaPublicKey | null | undefined);
    };
    const handleDisconnect = () => {
      setAddress("");
      setStatus("idle");
      setMessage("钱包已断开");
    };
    const handleAccountChanged = (...args: unknown[]) => {
      const publicKey = args[0] as SolanaPublicKey | null | undefined;
      const nextAddress = getPublicKeyText(publicKey);
      setAddress(nextAddress);
      setStatus(nextAddress ? "connected" : "idle");
      setMessage(nextAddress ? "已切换钱包账户" : "钱包账户已断开");
    };

    syncConnectedAddress(walletProvider.publicKey);
    walletProvider.on?.("connect", handleConnect);
    walletProvider.on?.("disconnect", handleDisconnect);
    walletProvider.on?.("accountChanged", handleAccountChanged);

    if (walletProvider.isPhantom && !walletProvider.publicKey) {
      walletProvider.connect({ onlyIfTrusted: true }).then((result) => {
        syncConnectedAddress(result?.publicKey || walletProvider.publicKey);
      }).catch(() => undefined);
    }

    return () => {
      walletProvider.off?.("connect", handleConnect);
      walletProvider.off?.("disconnect", handleDisconnect);
      walletProvider.off?.("accountChanged", handleAccountChanged);
      walletProvider.removeListener?.("connect", handleConnect);
      walletProvider.removeListener?.("disconnect", handleDisconnect);
      walletProvider.removeListener?.("accountChanged", handleAccountChanged);
    };
  }, [selectedWallet?.id, selectedWallet?.name, selectedWallet?.provider]);

  const connectWallet = useCallback(async () => {
    const detectedWallets = refreshWallets();
    const wallet = getPreferredWallet(detectedWallets, selectedWalletId);
    if (!wallet) {
      setStatus("missing");
      setMessage(getMissingWalletMessage());
      window.open(walletInstallUrl, "_blank", "noopener,noreferrer");
      return;
    }

    setSelectedWalletId(wallet.id);
    setProvider(wallet.provider);
    setProviderName(wallet.name);
    setStatus("connecting");
    setMessage(`请在 ${wallet.name} 中确认连接`);

    try {
      const result = await connectWithTimeout(wallet.provider);
      const nextAddress = getPublicKeyText(result?.publicKey) || getPublicKeyText(wallet.provider.publicKey);
      if (!nextAddress) throw new Error("Wallet returned no public key");
      setAddress(nextAddress);
      setStatus("connected");
      setMessage("钱包已连接");
    } catch (error) {
      setAddress("");
      setStatus("error");
      setMessage(getWalletErrorMessage(error));
    }
  }, [refreshWallets, selectedWalletId]);

  const disconnectWallet = useCallback(async () => {
    try {
      await provider?.disconnect?.();
    } finally {
      setAddress("");
      setStatus(provider ? "idle" : "missing");
      setMessage("钱包已断开");
    }
  }, [provider]);

  const connected = status === "connected" && Boolean(address);
  const statusText = connected
    ? `${providerName} · ${shortenAddress(address)}`
    : status === "connecting"
      ? "等待钱包确认"
      : status === "missing"
        ? "未检测到钱包"
        : status === "error"
          ? message
          : "钱包未连接";
  const buttonLabel = connected ? "断开钱包" : status === "connecting" ? "连接中" : status === "missing" ? "安装钱包" : "连接钱包";

  return {
    address,
    buttonLabel,
    connectWallet,
    connected,
    disconnectWallet,
    message,
    provider,
    providerName,
    selectedWalletId,
    selectWallet: setSelectedWalletId,
    status,
    statusText,
    wallets
  };
}

function WalletConnectionControl({ wallet }: { wallet: ReturnType<typeof useSolanaWallet> }) {
  const stateClass = wallet.connected ? "connected" : wallet.status === "connecting" ? "pending" : wallet.status === "error" ? "error" : "";
  const handleClick = wallet.connected ? wallet.disconnectWallet : wallet.connectWallet;

  return (
    <div className="wallet">
      {wallet.wallets.length > 1 ? (
        <select
          className="wallet-select"
          aria-label="选择 Solana 钱包"
          disabled={wallet.status === "connecting"}
          value={wallet.selectedWalletId}
          onChange={(event) => wallet.selectWallet(event.target.value)}
        >
          {wallet.wallets.map((detectedWallet) => (
            <option key={detectedWallet.id} value={detectedWallet.id}>
              {detectedWallet.name}
            </option>
          ))}
        </select>
      ) : null}
      <span className={`wallet-status ${stateClass}`} aria-live="polite" title={wallet.address || wallet.message || wallet.statusText}>
        <span className="dot" aria-hidden="true" />
        <span>{wallet.statusText}</span>
      </span>
      <button className="button primary" type="button" disabled={wallet.status === "connecting"} onClick={handleClick}>
        <WalletIcon />
        <span>{wallet.buttonLabel}</span>
      </button>
    </div>
  );
}

function BrandMark() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 7.2h12l-3 3H3l3-3Z" fill="currentColor" opacity="0.92" />
      <path d="M6 13h12l-3 3H3l3-3Z" fill="currentColor" opacity="0.72" />
      <path d="M9 18.8h12l-3 3H6l3-3Z" fill="currentColor" opacity="0.5" />
    </svg>
  );
}

function WalletIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 7.5h12.5a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2.5 2.5 0 0 1-2.5-2.5v-6A2.5 2.5 0 0 1 5 7.5Z" stroke="currentColor" strokeWidth="1.8" />
      <path d="M16 13h4v3h-4a1.5 1.5 0 0 1 0-3Z" stroke="currentColor" strokeWidth="1.8" />
      <path d="M6 7.5V6.8A2.3 2.3 0 0 1 8.3 4.5h8.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function BrandHeader({
  eyebrow,
  title,
  subtitle,
  nav,
  wallet
}: {
  eyebrow?: string;
  title: string;
  subtitle?: React.ReactNode;
  nav?: React.ReactNode;
  wallet?: React.ReactNode;
}) {
  const action = wallet ?? nav;

  return (
    <header className="topbar">
      <div className="brand">
        <div className="mark" aria-hidden="true">
          <BrandMark />
        </div>
        <div className="brand-copy">
          {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
          <h1>{title}</h1>
          {subtitle ? <p className="subtitle">{subtitle}</p> : null}
        </div>
      </div>
      {action ? <div className="topbar-actions">{action}</div> : null}
    </header>
  );
}

function NavLinks({ current }: { current?: "home" | "format" | "distributor" }) {
  return (
    <nav className="nav" aria-label="页面导航">
      <a aria-current={current === "home" ? "page" : undefined} href="index.html">
        入口
      </a>
      {current !== "format" ? (
        <a href="format-generator.html">去生成</a>
      ) : (
        <a href="batch-distributor.html">去分发</a>
      )}
    </nav>
  );
}

function SkipLink() {
  return (
    <a className="skip-link" href="#main">
      跳过导航
    </a>
  );
}

async function copyText(text: string) {
  if (!text) return false;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  return false;
}

function getDistributionTransferHref(output: string) {
  const directParams = new URLSearchParams({ [distributionListQueryParam]: output });
  const directHref = `batch-distributor.html?${directParams.toString()}`;
  if (directParams.toString().length <= maxDistributionUrlQueryLength) return directHref;

  try {
    window.sessionStorage.setItem(distributionTransferStorageKey, output);
    const storageParams = new URLSearchParams({ [distributionTransferQueryParam]: distributionTransferSource });
    return `batch-distributor.html?${storageParams.toString()}`;
  } catch {
    return directHref;
  }
}

function getInitialDistributionInput() {
  const params = new URLSearchParams(window.location.search);
  const queryList = params.get(distributionListQueryParam);
  if (queryList !== null) return queryList;

  if (params.get(distributionTransferQueryParam) !== distributionTransferSource) return "";

  try {
    return window.sessionStorage.getItem(distributionTransferStorageKey) || "";
  } catch {
    return "";
  }
}

function HomePage() {
  return (
    <>
      <SkipLink />
      <main className="shell home-shell page-home" id="main">
        <BrandHeader eyebrow="solana 工具" title="批量分发工作台" />
        <section className="home" aria-labelledby="hero-title">
          <div className="hero">
            <p className="eyebrow">地址整理 / 钱包连接 / 批量分发</p>
            <h2 id="hero-title">把地址清单整理好，再按需要进入分发。</h2>
            <p className="lead">
              输入多行地址和统一金额，生成 <code>地址,金额</code> 格式；Solana 清单可继续进入钱包分发。
            </p>
            <div className="actions">
              <a className="button primary" href="format-generator.html">
                开始格式生成
              </a>
              <a className="button" href="batch-distributor.html">
                已有清单，去分发
              </a>
            </div>
          </div>
        </section>
      </main>
    </>
  );
}

function FormatGeneratorPage() {
  const [addresses, setAddresses] = useState("");
  const [mode, setMode] = useState<"fixed" | "random">("fixed");
  const [fixedAmount, setFixedAmount] = useState("0.1");
  const [minAmount, setMinAmount] = useState("0.08");
  const [maxAmount, setMaxAmount] = useState("0.12");
  const [copyLabel, setCopyLabel] = useState("复制结果");
  const [generationNonce, setGenerationNonce] = useState(1);

  const result = useMemo(() => {
    const rows = addresses.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    const seen = new Set<string>();
    const issues: string[] = [];
    const generated: string[] = [];
    let total = 0;
    let duplicates = 0;
    let evmCount = 0;

    rows.forEach((address, index) => {
      const addressKind = getListAddressKind(address);
      if (!addressKind) {
        issues.push(`第 ${index + 1} 行地址格式不正确`);
        return;
      }

      if (addressKind === "evm") evmCount += 1;

      const duplicateKey = getDuplicateAddressKey(address, addressKind);
      if (seen.has(duplicateKey)) duplicates += 1;
      seen.add(duplicateKey);

      let amount = NaN;
      if (mode === "fixed") {
        const fixed = Number(fixedAmount);
        amount = Number.isFinite(fixed) && fixed > 0 ? fixed : NaN;
      } else {
        const min = Number(minAmount);
        const max = Number(maxAmount);
        if (Number.isFinite(min) && Number.isFinite(max) && min > 0 && max > 0 && max >= min) {
          const seed = Math.sin((index + 1) * 9301 + generationNonce) * 10000;
          const ratio = seed - Math.floor(seed);
          amount = min + (max - min) * ratio;
        }
      }

      if (!Number.isFinite(amount)) {
        issues.push(mode === "fixed" ? "固定金额需要大于 0" : "随机区间需要大于 0，且最大值不能小于最小值");
        return;
      }

      const normalized = formatSol(amount);
      total += Number(normalized);
      generated.push(`${address},${normalized}`);
    });

    return {
      duplicates,
      evmCount,
      issues,
      output: generated.join("\n"),
      total,
      validCount: generated.length
    };
  }, [addresses, fixedAmount, generationNonce, maxAmount, minAmount, mode]);

  const updateAndRegenerate = (setter: (value: string) => void, value: string) => {
    setter(value);
    setGenerationNonce((current) => current + 1);
    setCopyLabel("复制结果");
  };

  const copyOutput = async () => {
    if (!result.output) return;
    await copyText(result.output);
    setCopyLabel("已复制");
    window.setTimeout(() => setCopyLabel("复制结果"), 1200);
  };

  const goToDistributor = () => {
    if (!result.output || result.evmCount > 0) return;
    window.location.href = getDistributionTransferHref(result.output);
  };

  return (
    <>
      <SkipLink />
      <main className="shell tool-shell page-format" id="main">
        <BrandHeader
          eyebrow="format generator"
          title="生成地址,金额清单"
          subtitle="输入多行地址，给每个地址分配固定金额，或在指定区间内生成随机金额。"
          nav={<NavLinks current="format" />}
        />

        <section className="workspace flow-workspace">
          <section className="panel input-panel" aria-labelledby="input-title">
            <div className="panel-header">
              <div>
                <h2 className="panel-title" id="input-title">地址与金额</h2>
                <p className="panel-note">每行一个地址；空行会自动忽略。</p>
              </div>
            </div>

            <div className="form">
              <div className="field">
                <label htmlFor="addresses">地址列表</label>
                <p className="hint">支持粘贴多行地址，会做基础格式校验和重复项统计。</p>
                <textarea
                  id="addresses"
                  spellCheck={false}
                  value={addresses}
                  onChange={(event) => updateAndRegenerate(setAddresses, event.target.value)}
                  placeholder={"7hQmJpYvKq2ms2uUpu2f4pCmJfM7m2HJ9dXkR4g3SxyQ\n0x742d35Cc6634C0532925a3b844Bc454e4438f44e"}
                />
              </div>

              <div className="mode-row" role="radiogroup" aria-label="金额模式">
                <label className="mode">
                  <span className="mode-head">
                    <input type="radio" name="amountMode" value="fixed" checked={mode === "fixed"} onChange={() => setMode("fixed")} />
                    固定金额
                  </span>
                  <span className="hint">所有地址使用同一个金额。</span>
                </label>
                <label className="mode">
                  <span className="mode-head">
                    <input type="radio" name="amountMode" value="random" checked={mode === "random"} onChange={() => {
                      setMode("random");
                      setGenerationNonce((current) => current + 1);
                    }} />
                    随机区间
                  </span>
                  <span className="hint">每个地址生成一个区间内的随机金额。</span>
                </label>
              </div>

              <div className="amount-grid">
                <div className="field">
                  <label htmlFor="fixedAmount">固定金额</label>
                  <input id="fixedAmount" type="number" min="0" step="0.0001" value={fixedAmount} onChange={(event) => updateAndRegenerate(setFixedAmount, event.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="minAmount">随机最小值</label>
                  <input id="minAmount" type="number" min="0" step="0.0001" value={minAmount} onChange={(event) => updateAndRegenerate(setMinAmount, event.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="maxAmount">随机最大值</label>
                  <input id="maxAmount" type="number" min="0" step="0.0001" value={maxAmount} onChange={(event) => updateAndRegenerate(setMaxAmount, event.target.value)} />
                </div>
              </div>

              <div className="actions">
                <div className="action-group">
                  <button className="button primary" type="button" onClick={() => setGenerationNonce((current) => current + 1)}>生成清单</button>
                  <button
                    className="button"
                    type="button"
                    disabled={!result.output || result.evmCount > 0}
                    title={result.evmCount > 0 ? "分发页只支持 Solana 地址；EVM 清单请复制使用。" : undefined}
                    onClick={goToDistributor}
                  >
                    去分发
                  </button>
                  <button className="button ghost" type="button" onClick={() => updateAndRegenerate(setAddresses, "")}>清空</button>
                </div>
                <button className="button" type="button" disabled={!result.output} onClick={copyOutput}>{copyLabel}</button>
              </div>
            </div>

            <div className="stats" aria-label="生成统计">
              <Metric value={String(result.validCount)} label="有效地址" />
              <Metric value={formatSol(result.total)} label="统计总额" />
              <Metric value={String(result.duplicates)} label="重复地址" />
            </div>
          </section>

          <aside className="panel output-panel" aria-labelledby="result-title">
            <div className="panel-header">
              <div>
                <h2 className="panel-title" id="result-title">生成结果</h2>
                <p className="panel-note">{result.evmCount > 0 ? "EVM 清单可复制到外部流程使用。" : "复制后可直接粘贴到分发页。"}</p>
              </div>
              <span className="pill">{mode === "fixed" ? "固定金额" : "随机区间"}</span>
            </div>
            <div className="form">
              <div className="result" aria-live="polite">
                {result.output ? <pre>{result.output}</pre> : <div className="empty">生成后会显示为：<br />地址,金额</div>}
              </div>
              <div className="notice">
                <strong>金额统计会按生成后的每行金额计算。</strong>
                <span>随机金额会保留 4 位小数，避免生成过长的小数尾巴。</span>
              </div>
              <div className="invalid-list">
                {result.issues.slice(0, 5).map((issue) => (
                  <div key={issue}>{issue}</div>
                ))}
              </div>
            </div>
          </aside>
        </section>
      </main>
    </>
  );
}

function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

type DistributionRow = {
  line: number;
  address: string;
  amount: number;
  amountRaw: string;
  lamports: bigint;
  status: ReviewStatus;
  problems: string[];
};

function parseDistribution(input: string) {
  const lines = input.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const seen = new Set<string>();
  const rows: DistributionRow[] = [];
  let totalLamports = 0n;
  let invalid = 0;
  let duplicates = 0;

  lines.forEach((line, index) => {
    const parts = line.split(",").map((part) => part.trim());
    const address = parts[0] || "";
    const amountRaw = parts[1] || "";
    const amount = Number(amountRaw);
    const lamports = parseSolToLamports(amountRaw);
    const problems: string[] = [];

    if (parts.length !== 2) problems.push("格式需要刚好包含一个逗号");
    if (!isValidSolanaAddress(address)) problems.push("地址格式不正确");
    if (!lamports) problems.push("金额需要大于 0，最多 9 位小数");
    if (seen.has(address)) {
      problems.push("重复地址");
      duplicates += 1;
    }
    seen.add(address);

    if (problems.length > 0) invalid += 1;
    else totalLamports += lamports || 0n;

    rows.push({
      line: index + 1,
      address,
      amount,
      amountRaw,
      lamports: lamports || 0n,
      status: problems.length ? (problems.includes("重复地址") ? "warn" : "invalid") : "valid",
      problems
    });
  });

  const cleanRows = rows
    .filter((row) => row.status === "valid")
    .map((row) => `${row.address},${formatLamports(row.lamports)}`);

  return {
    cleanRows,
    duplicates,
    invalid,
    rows,
    total: formatLamports(totalLamports),
    totalLamports,
    validRows: rows.filter((row) => row.status === "valid")
  };
}

function createTransferTransaction(senderAddress: string, rows: DistributionRow[], blockhash: string) {
  const feePayer = new PublicKey(senderAddress);
  const transaction = new Transaction();

  rows.forEach((row) => {
    transaction.add(SystemProgram.transfer({
      fromPubkey: feePayer,
      lamports: row.lamports,
      toPubkey: new PublicKey(row.address)
    }));
  });

  transaction.feePayer = feePayer;
  transaction.recentBlockhash = blockhash;

  return transaction;
}

function getTransactionSize(transaction: Transaction) {
  return transaction.serialize({
    requireAllSignatures: false,
    verifySignatures: false
  }).length;
}

function canFitTransferRows(senderAddress: string, rows: DistributionRow[], blockhash = transactionEstimateBlockhash) {
  try {
    return getTransactionSize(createTransferTransaction(senderAddress, rows, blockhash)) <= solanaLegacyTransactionSizeLimitBytes;
  } catch {
    return false;
  }
}

function planTransferChunks(rows: DistributionRow[], senderAddress: string, blockhash = transactionEstimateBlockhash) {
  const chunks: DistributionRow[][] = [];
  let currentChunk: DistributionRow[] = [];

  rows.forEach((row) => {
    const candidateChunk = [...currentChunk, row];

    if (canFitTransferRows(senderAddress, candidateChunk, blockhash)) {
      currentChunk = candidateChunk;
      return;
    }

    if (currentChunk.length === 0) {
      throw new Error("单笔转账指令过大，无法构造交易");
    }

    chunks.push(currentChunk);
    currentChunk = [row];

    if (!canFitTransferRows(senderAddress, currentChunk, blockhash)) {
      throw new Error("单笔转账指令过大，无法构造交易");
    }
  });

  if (currentChunk.length > 0) chunks.push(currentChunk);
  return chunks;
}

function getEstimatedTransferChunks(rows: DistributionRow[], senderAddress?: string) {
  try {
    return planTransferChunks(rows, senderAddress || transactionEstimateSenderAddress);
  } catch {
    return chunkRows(rows, fallbackTransfersPerTransaction);
  }
}

function BatchDistributorPage() {
  const [input, setInput] = useState(() => getInitialDistributionInput());
  const [confirmVisible, setConfirmVisible] = useState(false);
  const [networkId, setNetworkId] = useState<SolanaNetworkId>("mainnet-beta");
  const [rpcEndpoint, setRpcEndpoint] = useState(getNetworkConfig("mainnet-beta").endpoint);
  const [sendState, setSendState] = useState<DistributionSendState>(initialSendState);
  const wallet = useSolanaWallet();

  const parsed = useMemo(() => parseDistribution(input), [input]);
  const selectedNetwork = useMemo(() => getNetworkConfig(networkId), [networkId]);
  const estimatedChunks = useMemo(() => getEstimatedTransferChunks(parsed.validRows, wallet.address), [parsed.validRows, wallet.address]);
  const transactionCount = estimatedChunks.length;
  const sending = sendState.status === "preparing" || sendState.status === "awaiting-wallet" || sendState.status === "confirming";
  const canPrepare = wallet.connected && Boolean(wallet.provider) && parsed.validRows.length > 0 && parsed.invalid === 0 && !sending;
  const sendButtonLabel = sending
    ? sendState.status === "confirming"
      ? "链上确认中"
      : "等待钱包确认"
    : "确认分发";
  const hasRows = parsed.rows.length > 0;
  const gateClass = sendState.status === "success"
    ? "success"
    : sendState.status === "error"
      ? "error"
      : sending
        ? "pending"
        : canPrepare
          ? "ready"
          : "blocked";
  const gateTitle = sendState.status === "success"
    ? "交易已确认"
    : sendState.status === "error"
      ? "交易未完成"
      : sending
        ? sendButtonLabel
        : canPrepare
          ? "已准备发送"
          : !wallet.connected
            ? "等待钱包"
            : !hasRows
              ? "等待清单"
              : parsed.invalid > 0
                ? "需要修正"
                : "等待有效地址";
  const gateMessage = sendState.message || (canPrepare
    ? `${parsed.validRows.length} 个地址，${parsed.total} SOL，预计 ${transactionCount || 0} 笔交易；支持批量签名的钱包可一次确认。`
    : !wallet.connected
      ? wallet.message || "连接钱包后才允许确认分发。"
      : !hasRows
        ? "粘贴清单后会在这里显示发送状态。"
        : parsed.invalid > 0
          ? `还有 ${parsed.invalid} 行需要修正。`
          : "需要至少 1 个有效收款地址。");

  useEffect(() => {
    setConfirmVisible(false);
    setSendState(initialSendState);
  }, [wallet.address, wallet.connected]);

  const sendDistribution = async () => {
    if (!canPrepare || !wallet.provider || !wallet.address) return;

    const connection = new Connection(rpcEndpoint.trim() || selectedNetwork.endpoint, "confirmed");
    const sendOptions: SendOptions = {
      preflightCommitment: "confirmed",
      skipPreflight: false
    };
    const signatures: TransactionSignature[] = [];

    setConfirmVisible(true);
    setSendState({
      message: "正在计算最少交易数量",
      signatures: [],
      status: "preparing"
    });

    try {
      const latestBlockhash = await connection.getLatestBlockhash("confirmed");
      const chunks = planTransferChunks(parsed.validRows, wallet.address, latestBlockhash.blockhash);
      const transactions = chunks.map((chunk) => createTransferTransaction(wallet.address, chunk, latestBlockhash.blockhash));
      const canBatchSign = transactions.length > 1 && typeof wallet.provider.signAllTransactions === "function";

      setSendState({
        message: `已压缩为 ${transactions.length} 笔交易，每笔最多容纳 ${Math.max(...chunks.map((chunk) => chunk.length))} 个地址`,
        signatures: [],
        status: "preparing"
      });

      if (canBatchSign && wallet.provider.signAllTransactions) {
        setSendState({
          message: `请在 ${wallet.providerName} 中批量确认 ${transactions.length} 笔交易`,
          signatures: [],
          status: "awaiting-wallet"
        });

        const signedTransactions = await wallet.provider.signAllTransactions(transactions);
        if (signedTransactions.length !== transactions.length) throw new Error("钱包返回的签名交易数量不一致");

        for (let index = 0; index < signedTransactions.length; index += 1) {
          setSendState({
            message: `正在提交第 ${index + 1}/${signedTransactions.length} 笔交易`,
            signatures: [...signatures],
            status: "confirming"
          });

          const signature = await connection.sendRawTransaction(signedTransactions[index].serialize(), sendOptions);
          signatures.push(signature);
        }

        for (let index = 0; index < signatures.length; index += 1) {
          setSendState({
            message: `已提交 ${signatures.length} 笔交易，正在确认第 ${index + 1}/${signatures.length} 笔`,
            signatures: [...signatures],
            status: "confirming"
          });

          await connection.confirmTransaction({
            blockhash: latestBlockhash.blockhash,
            lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
            signature: signatures[index]
          }, "confirmed");
        }
      } else {
        for (let index = 0; index < chunks.length; index += 1) {
          const chunk = chunks[index];
          const currentBlockhash = await connection.getLatestBlockhash("confirmed");
          const transaction = createTransferTransaction(wallet.address, chunk, currentBlockhash.blockhash);

          setSendState({
            message: `请在 ${wallet.providerName} 中确认第 ${index + 1}/${chunks.length} 笔交易`,
            signatures: [...signatures],
            status: "awaiting-wallet"
          });

          const signature = await sendWalletTransaction(wallet.provider, transaction, connection);
          signatures.push(signature);

          setSendState({
            message: `第 ${index + 1}/${chunks.length} 笔交易已提交，等待链上确认`,
            signatures: [...signatures],
            status: "confirming"
          });

          await connection.confirmTransaction({
            blockhash: currentBlockhash.blockhash,
            lastValidBlockHeight: currentBlockhash.lastValidBlockHeight,
            signature
          }, "confirmed");
        }
      }

      setSendState({
        message: `已完成 ${signatures.length} 笔交易确认`,
        signatures,
        status: "success"
      });
    } catch (error) {
      setSendState({
        message: getTransactionErrorMessage(error),
        signatures,
        status: "error"
      });
    }
  };

  return (
    <>
      <SkipLink />
      <main className="shell tool-shell page-distributor" id="main">
        <BrandHeader
          eyebrow="batch distributor"
          title="读取清单并准备分发"
          subtitle="粘贴 `地址,金额` 格式，先校验总额、重复项和金额，再连接钱包进入确认。"
          nav={<NavLinks current="distributor" />}
        />

        <section className="workspace batch-workspace">
          <section className="panel input-panel" aria-labelledby="list-title">
            <div className="panel-header">
              <div>
                <h2 className="panel-title" id="list-title">分发清单</h2>
                <p className="panel-note">每行必须是 `地址,金额`，金额单位按 SOL 处理。</p>
              </div>
              <span className="pill network-pill">{selectedNetwork.label}</span>
            </div>

            <div className="form">
              <div className="batch-command">
                <div className="command-copy">
                  <span className="eyebrow">wallet gate</span>
                  <strong>{wallet.connected ? "钱包已连接" : wallet.status === "connecting" ? "等待钱包确认" : "连接钱包"}</strong>
                  <span>{wallet.connected ? wallet.statusText : wallet.message || "连接后会解锁确认分发。"}</span>
                </div>
                <WalletConnectionControl wallet={wallet} />
              </div>

              <div className={`send-gate ${gateClass}`} aria-live="polite">
                <div className="gate-orb" aria-hidden="true" />
                <div className="gate-copy">
                  <strong>{gateTitle}</strong>
                  <span>{gateMessage}</span>
                </div>
                <div className="gate-checks" aria-label="发送条件">
                  <span className={wallet.connected ? "ready" : ""}>钱包</span>
                  <span className={parsed.validRows.length ? "ready" : ""}>地址</span>
                  <span className={parsed.invalid > 0 ? "error" : hasRows ? "ready" : ""}>校验</span>
                </div>
              </div>

              <div className="transaction-options compact-route" aria-label="链路配置">
                <div className="route-fields">
                  <div className="field route-card network-field">
                    <label htmlFor="networkId">网络</label>
                    <select id="networkId" value={networkId} onChange={(event) => {
                      const nextNetworkId = event.target.value as SolanaNetworkId;
                      setNetworkId(nextNetworkId);
                      setRpcEndpoint(getNetworkConfig(nextNetworkId).endpoint);
                      setConfirmVisible(false);
                      setSendState(initialSendState);
                    }}>
                      {solanaNetworks.map((network) => (
                        <option key={network.id} value={network.id}>{network.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="field route-card rpc-field">
                    <label htmlFor="rpcEndpoint">RPC</label>
                    <input id="rpcEndpoint" type="url" value={rpcEndpoint} onChange={(event) => {
                      setRpcEndpoint(event.target.value);
                      setConfirmVisible(false);
                      setSendState(initialSendState);
                    }} />
                  </div>
                  <div className="route-card route-count">
                    <span>交易数</span>
                    <strong>{transactionCount || 0}</strong>
                  </div>
                </div>
              </div>

              <div className="field">
                <label htmlFor="distributionInput">地址,金额</label>
                <p className="hint">示例：7hQm...SxyQ,0.1。逗号前后有空格也可以。</p>
                <textarea
                  id="distributionInput"
                  spellCheck={false}
                  value={input}
                  onChange={(event) => {
                    setInput(event.target.value);
                    setConfirmVisible(false);
                    setSendState(initialSendState);
                  }}
                  placeholder={"7hQmJpYvKq2ms2uUpu2f4pCmJfM7m2HJ9dXkR4g3SxyQ,0.1\n9YcQwQ6kR4pYc5v2yAf9hWeXvX5gK2oA9rRk2mL3pZqE,0.1"}
                />
              </div>
              <div className="actions">
                <div className="action-group">
                  <button className="button primary" type="button" disabled={!canPrepare} onClick={sendDistribution}>{sendButtonLabel}</button>
                  <button className="button danger" type="button" onClick={() => {
                    setInput("");
                    setConfirmVisible(false);
                    setSendState(initialSendState);
                  }}>清空</button>
                </div>
              </div>
            </div>

            <div className="stats" aria-label="分发统计">
              <Metric value={String(parsed.validRows.length)} label="有效收款地址" />
              <Metric value={parsed.total} label="合计 SOL" />
              <Metric value={String(parsed.invalid)} label="需修正" />
              <Metric value={String(parsed.duplicates)} label="重复地址" />
            </div>
          </section>

          <aside className="panel review-panel" aria-labelledby="review-title">
            <div className="panel-header">
              <div>
                <h2 className="panel-title" id="review-title">发送前检查</h2>
                <p className="panel-note">只在没有错误且钱包已连接时允许确认分发。</p>
              </div>
            </div>
            <div className="form">
              <DistributionReview rows={parsed.rows} />
              {confirmVisible ? (
                <div className={`confirm transaction-status ${sendState.status}`}>
                  <strong>{sendState.status === "success" ? "分发交易已确认" : sendState.status === "error" ? "分发交易未完成" : `准备向 ${parsed.validRows.length} 个地址分发`}</strong>
                  <span>{sendState.message || `合计 ${parsed.total} SOL，网络 ${selectedNetwork.label}，共 ${transactionCount || 0} 笔交易。`}</span>
                  {sendState.signatures.length > 0 ? (
                    <div className="signature-list">
                      {sendState.signatures.map((signature, index) => (
                        <a key={signature} href={getExplorerUrl(signature, networkId)} target="_blank" rel="noreferrer">
                          交易 {index + 1}: {shortenAddress(signature)}
                        </a>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </aside>
        </section>
      </main>
    </>
  );
}

function DistributionReview({ rows }: { rows: DistributionRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="review-list">
        <div className="empty">粘贴清单后会显示逐行检查结果。</div>
      </div>
    );
  }

  return (
    <div className="review-list">
      {rows.slice(0, 12).map((row) => {
        const label = row.status === "valid" ? "✓" : row.status === "warn" ? "!" : "×";
        const title = row.status === "valid" ? `第 ${row.line} 行可发送` : `第 ${row.line} 行需要检查`;
        const problemText = row.problems.length ? row.problems.join(" / ") : row.address;
        const amountText = row.lamports > 0n ? `${formatLamports(row.lamports)} SOL` : "金额无效";
        return (
          <div className={`review-item ${row.status === "valid" ? "" : row.status}`} key={`${row.line}-${row.address}-${row.amountRaw}`}>
            <span className="icon">{label}</span>
            <div>
              <div className="review-title">{title}</div>
              <div className="review-meta">{problemText}</div>
            </div>
            <span className="amount-chip">{amountText}</span>
          </div>
        );
      })}
      {rows.length > 12 ? <div className="empty">还有 {rows.length - 12} 行未展开，统计已计入。</div> : null}
    </div>
  );
}

function App() {
  const page = window.location.pathname.split("/").pop() || "index.html";
  if (page === "format-generator.html") return <FormatGeneratorPage />;
  if (page === "batch-distributor.html") return <BatchDistributorPage />;
  return <HomePage />;
}

const rootElement = document.getElementById("root")!;
const root = window.__solBatchSendRoot || createRoot(rootElement);
window.__solBatchSendRoot = root;
root.render(<App />);
