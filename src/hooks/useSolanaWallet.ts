import { useCallback, useEffect, useMemo, useState } from "react";
import type { SendOptions, Transaction, TransactionSignature } from "@solana/web3.js";
import { shortenAddress } from "../lib/address";

export type WalletStatus = "idle" | "connecting" | "connected" | "missing" | "error";

export type SolanaPublicKey = {
  toBase58?: () => string;
  toString: () => string;
};

export type WalletConnectResult = {
  publicKey?: SolanaPublicKey | string | null;
};

export type SolanaWalletProvider = {
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

export type DetectedWallet = {
  id: string;
  name: string;
  provider: SolanaWalletProvider;
  priority: number;
  installUrl: string;
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

function getWalletErrorMessage(error: unknown) {
  const detail = error && typeof error === "object" && "message" in error ? String((error as { message?: unknown }).message || "") : "";
  const code = error && typeof error === "object" && "code" in error ? Number((error as { code?: unknown }).code) : 0;

  if (code === 4001 || /reject|declin|cancel/i.test(detail)) return "用户取消了钱包连接";
  if (/already pending/i.test(detail)) return "钱包正在处理上一次连接请求";
  if (/timeout/i.test(detail)) return "钱包确认超时，请重新点击连接";
  return "钱包连接失败，请稍后重试";
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

export type SolanaWalletState = ReturnType<typeof useSolanaWallet>;
