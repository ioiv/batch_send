import { useCallback, useEffect, useMemo, useState } from "react";
import type { SendOptions, Transaction, TransactionSignature } from "@solana/web3.js";
import { shortenAddress } from "../lib/address";

export type WalletStatus = "idle" | "connecting" | "connected" | "missing" | "error";

export type SolanaPublicKey = {
  toBase58?: () => string;
  toString: () => string;
};

type WalletAccountLike = {
  address?: string | null;
  publicKey?: SolanaPublicKey | string | null;
  public_key?: string | null;
};

export type WalletConnectResult = WalletAccountLike & {
  account?: WalletAccountLike | string | null;
  accounts?: Array<WalletAccountLike | string> | null;
  publicKey?: SolanaPublicKey | string | null;
};

export type SolanaWalletProvider = {
  isCoinbaseWallet?: boolean;
  isPhantom?: boolean;
  isSolflare?: boolean;
  isBackpack?: boolean;
  isOkxWallet?: boolean;
  isConnected?: boolean;
  publicKey?: SolanaPublicKey | string | null;
  connect: (options?: { onlyIfTrusted?: boolean }) => Promise<WalletConnectResult | void>;
  disconnect?: () => Promise<void> | void;
  getAccount?: () => WalletAccountLike | string | null | Promise<WalletAccountLike | string | null>;
  signAndSendTransaction?: (transaction: Transaction, options?: SendOptions) => Promise<{ signature?: TransactionSignature } | TransactionSignature>;
  signAllTransactions?: (transactions: Transaction[]) => Promise<Transaction[]>;
  signTransaction?: (transaction: Transaction) => Promise<Transaction>;
  on?: (event: "connect" | "disconnect" | "accountChanged", listener: (...args: unknown[]) => void) => void;
  off?: (event: "connect" | "disconnect" | "accountChanged", listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: "connect" | "disconnect" | "accountChanged", listener: (...args: unknown[]) => void) => void;
};

export type DetectedWallet = {
  id: string;
  installUrl: string;
  name: string;
  priority: number;
  provider: SolanaWalletProvider;
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
  }
}

const walletInstallUrl = "https://phantom.app/download";
const walletConnectionTimeoutMs = 45_000;
const walletAddressSettleMs = 1_500;
const walletAddressPollIntervalMs = 100;

function isSolanaProvider(provider?: SolanaWalletProvider | null): provider is SolanaWalletProvider {
  return Boolean(provider && typeof provider.connect === "function");
}

function addWalletCandidate(wallets: DetectedWallet[], candidate: DetectedWallet) {
  if (!isSolanaProvider(candidate.provider)) return;
  if (wallets.some((wallet) => wallet.provider === candidate.provider || wallet.id === candidate.id)) return;
  wallets.push(candidate);
}

function getBackpackProvider(): SolanaWalletProvider | undefined {
  if (typeof window === "undefined") return undefined;
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

  if (provider.isOkxWallet) {
    addWalletCandidate(wallets, {
      id: "okx",
      installUrl: "https://www.okx.com/web3",
      name: "OKX Wallet",
      priority: 20,
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

  if (provider.isCoinbaseWallet) {
    addWalletCandidate(wallets, {
      id: "coinbase",
      installUrl: "https://www.coinbase.com/wallet/downloads",
      name: "Coinbase Wallet",
      priority: 50,
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

export function getSolanaWallets() {
  if (typeof window === "undefined") return null;
  const wallets: DetectedWallet[] = [];

  if (isSolanaProvider(window.phantom?.solana)) {
    addWalletCandidate(wallets, {
      id: "phantom",
      installUrl: walletInstallUrl,
      name: "Phantom",
      priority: 10,
      provider: window.phantom.solana
    });
  }

  if (isSolanaProvider(window.okxwallet?.solana)) {
    addWalletCandidate(wallets, {
      id: "okx",
      installUrl: "https://www.okx.com/web3",
      name: "OKX Wallet",
      priority: 20,
      provider: window.okxwallet.solana
    });
  }

  if (isSolanaProvider(window.solflare)) {
    addWalletCandidate(wallets, {
      id: "solflare",
      installUrl: "https://solflare.com/download",
      name: "Solflare",
      priority: 30,
      provider: window.solflare
    });
  }

  const backpack = getBackpackProvider();
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

export function getPreferredWallet(wallets: DetectedWallet[], preferredWalletId?: string) {
  return wallets.find((wallet) => wallet.id === preferredWalletId)
    || wallets.find((wallet) => getWalletAddressText(wallet.provider.publicKey) || wallet.provider.isConnected)
    || wallets.find((wallet) => wallet.id === "phantom")
    || wallets[0]
    || null;
}

function getMissingWalletMessage() {
  if (typeof window === "undefined") return "未检测到浏览器钱包";
  const { hostname, protocol } = window.location;
  const canInject = protocol === "https:" || hostname === "localhost" || hostname === "127.0.0.1";
  return canInject ? "未检测到 Phantom / OKX / Solflare / Backpack 钱包" : "请通过 localhost 或 HTTPS 打开页面";
}

export function getWalletAddressText(value?: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const address = getWalletAddressText(item);
      if (address) return address;
    }
    return "";
  }
  if (typeof value !== "object") return "";

  const candidate = value as WalletAccountLike & {
    account?: unknown;
    accounts?: unknown;
    selectedAccount?: unknown;
    toBase58?: unknown;
    toString?: unknown;
  };
  const base58 = typeof candidate.toBase58 === "function" ? candidate.toBase58() : "";
  if (typeof base58 === "string" && base58) return base58;

  const nestedAddress = getWalletAddressText(candidate.publicKey)
    || getWalletAddressText(candidate.address)
    || getWalletAddressText(candidate.public_key)
    || getWalletAddressText(candidate.account)
    || getWalletAddressText(candidate.selectedAccount)
    || getWalletAddressText(candidate.accounts);
  if (nestedAddress) return nestedAddress;

  const text = typeof candidate.toString === "function" ? candidate.toString() : "";
  return typeof text === "string" && text && text !== "[object Object]" ? text : "";
}

function getWalletErrorMessage(error: unknown) {
  const detail = error && typeof error === "object" && "message" in error ? String((error as { message?: unknown }).message || "") : "";
  const code = error && typeof error === "object" && "code" in error ? Number((error as { code?: unknown }).code) : 0;

  if (code === 4001 || /reject|declin|cancel/i.test(detail)) return "用户取消了钱包连接";
  if (/already pending/i.test(detail)) return "钱包正在处理上一次连接请求";
  if (/disconnected port|service worker/i.test(detail)) return "Phantom 扩展通信中断，请关闭钱包弹窗、刷新页面后重试";
  if (/returned no public key/i.test(detail)) return "钱包已响应但没有返回地址，请确认已选择 Solana 账户";
  if (/timeout/i.test(detail)) return "钱包确认超时，请在 Phantom 弹窗中点击连接；若弹窗无响应，请关闭弹窗后刷新页面";
  return "钱包连接失败，请稍后重试";
}

function connectWithTimeout(provider: SolanaWalletProvider, options?: { onlyIfTrusted?: boolean }) {
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error("Wallet connection timeout")), walletConnectionTimeoutMs);
  });

  return Promise.race([provider.connect(options), timeout]).finally(() => {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  });
}

function wait(delayMs: number) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, delayMs));
}

async function getProviderAccountText(provider: SolanaWalletProvider) {
  const publicKeyAddress = getWalletAddressText(provider.publicKey);
  if (publicKeyAddress) return publicKeyAddress;
  if (!provider.getAccount) return "";

  try {
    return getWalletAddressText(await provider.getAccount());
  } catch {
    return "";
  }
}

export async function waitForConnectedAddress(provider: SolanaWalletProvider, result?: WalletConnectResult | void) {
  const resultAddress = getWalletAddressText(result);
  if (resultAddress) return resultAddress;

  const immediateProviderAddress = await getProviderAccountText(provider);
  if (immediateProviderAddress) return immediateProviderAddress;

  const startTime = Date.now();
  while (Date.now() - startTime < walletAddressSettleMs) {
    await wait(walletAddressPollIntervalMs);
    const nextAddress = await getProviderAccountText(provider);
    if (nextAddress) return nextAddress;
  }

  return "";
}

export function useSolanaWallet() {
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
    const preferredWallet = getPreferredWallet(detectedWallets, selectedWalletId);
    setWallets(detectedWallets);
    setSelectedWalletId((current) => getPreferredWallet(detectedWallets, current)?.id || preferredWallet?.id || "");
    setProvider(preferredWallet?.provider || null);
    setProviderName(preferredWallet?.name || "Solana 钱包");

    if (!detectedWallets.length) {
      setAddress("");
      setStatus("missing");
      setMessage(getMissingWalletMessage());
    } else {
      setStatus((current) => current === "missing" ? "idle" : current);
      setMessage((current) => current === getMissingWalletMessage() ? "" : current);
    }

    return detectedWallets;
  }, [selectedWalletId]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    refreshWallets();
    const timers = [250, 800, 1600].map((delay) => window.setTimeout(refreshWallets, delay));
    window.addEventListener("load", refreshWallets);

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      window.removeEventListener("load", refreshWallets);
    };
  }, [refreshWallets]);

  useEffect(() => {
    setProvider(selectedWallet?.provider || null);
    setProviderName(selectedWallet?.name || "Solana 钱包");
  }, [selectedWallet]);

  useEffect(() => {
    if (!provider) return;

    let cancelled = false;
    const syncConnectedAddress = (publicKey?: unknown) => {
      const nextAddress = getWalletAddressText(publicKey) || getWalletAddressText(provider.publicKey);
      setAddress(nextAddress);
      setStatus((current) => nextAddress ? "connected" : current === "connecting" ? current : "idle");
      setMessage((current) => nextAddress ? "钱包已连接" : current.startsWith("请在 ") ? current : "");
    };
    const settleConnectedAddress = (publicKey?: unknown) => {
      const immediateAddress = getWalletAddressText(publicKey) || getWalletAddressText(provider.publicKey);
      syncConnectedAddress(immediateAddress);
      if (immediateAddress) return;

      void waitForConnectedAddress(provider).then((nextAddress) => {
        if (!cancelled && nextAddress) syncConnectedAddress(nextAddress);
      });
    };
    const handleConnect = (...args: unknown[]) => {
      settleConnectedAddress(args[0] as SolanaPublicKey | null | undefined);
    };
    const handleDisconnect = () => {
      setAddress("");
      setStatus("idle");
      setMessage("钱包已断开");
    };
    const handleAccountChanged = (...args: unknown[]) => {
      const nextAddress = getWalletAddressText(args[0]);
      setAddress(nextAddress);
      setStatus(nextAddress ? "connected" : "idle");
      setMessage(nextAddress ? "已切换钱包账户" : "钱包账户已断开");
    };

    settleConnectedAddress(provider.publicKey);
    provider.on?.("connect", handleConnect);
    provider.on?.("disconnect", handleDisconnect);
    provider.on?.("accountChanged", handleAccountChanged);

    return () => {
      cancelled = true;
      provider.off?.("connect", handleConnect);
      provider.off?.("disconnect", handleDisconnect);
      provider.off?.("accountChanged", handleAccountChanged);
      provider.removeListener?.("connect", handleConnect);
      provider.removeListener?.("disconnect", handleDisconnect);
      provider.removeListener?.("accountChanged", handleAccountChanged);
    };
  }, [provider]);

  const connectWallet = useCallback(async (walletId?: string) => {
    const detectedWallets = refreshWallets();
    const wallet = getPreferredWallet(detectedWallets, walletId || selectedWalletId);
    if (!wallet) {
      setStatus("missing");
      setMessage(getMissingWalletMessage());
      window.open(walletInstallUrl, "_blank", "noopener,noreferrer");
      return;
    }

    const { name, provider: walletProvider } = wallet;
    setSelectedWalletId(wallet.id);
    setProvider(walletProvider);
    setProviderName(name);
    setStatus("connecting");
    setMessage(`请在 ${name} 中确认连接`);

    try {
      const result = await connectWithTimeout(walletProvider);
      const nextAddress = await waitForConnectedAddress(walletProvider, result);
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

export type SolanaWalletState = ReturnType<typeof useSolanaWallet>;
