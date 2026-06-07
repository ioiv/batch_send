import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { shortenAddress } from "../lib/address";

export type EvmWalletStatus = "idle" | "connecting" | "connected" | "missing" | "error";

export type EvmWalletProvider = {
  isCoinbaseWallet?: boolean;
  isMetaMask?: boolean;
  isOkxWallet?: boolean;
  isPhantom?: boolean;
  isRabby?: boolean;
  isTrust?: boolean;
  providers?: EvmWalletProvider[];
  request: (request: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: "accountsChanged" | "chainChanged" | "disconnect", listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: "accountsChanged" | "chainChanged" | "disconnect", listener: (...args: unknown[]) => void) => void;
};

export type DetectedEvmWallet = {
  id: string;
  installUrl: string;
  name: string;
  priority: number;
  provider: EvmWalletProvider;
};

export type EvmWalletChoice = Omit<DetectedEvmWallet, "provider">;

type Eip6963ProviderDetail = {
  info?: {
    icon?: string;
    name?: string;
    rdns?: string;
    uuid?: string;
  };
  provider?: EvmWalletProvider;
};

declare global {
  interface Window {
    coinbaseWalletExtension?: EvmWalletProvider;
    ethereum?: EvmWalletProvider;
    rabby?: EvmWalletProvider;
    trustwallet?: EvmWalletProvider;
  }

  interface WindowEventMap {
    "eip6963:announceProvider": CustomEvent<Eip6963ProviderDetail>;
  }
}

const evmWalletInstallUrl = "https://metamask.io/download/";
const evmWalletSelectionStorageKey = "sol-batch-send.evm-wallet-id";
const evmWalletManualDisconnectStorageKey = "sol-batch-send.evm-wallet-manual-disconnect";

function readStoredEvmWalletId() {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(evmWalletSelectionStorageKey) || "";
  } catch {
    return "";
  }
}

function writeStoredEvmWalletId(walletId: string) {
  if (typeof window === "undefined") return;
  try {
    if (walletId) {
      window.localStorage.setItem(evmWalletSelectionStorageKey, walletId);
    } else {
      window.localStorage.removeItem(evmWalletSelectionStorageKey);
    }
  } catch {
    // Some embedded browsers disable localStorage.
  }
}

function readManualEvmDisconnect() {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(evmWalletManualDisconnectStorageKey) === "1";
  } catch {
    return false;
  }
}

function writeManualEvmDisconnect(disconnected: boolean) {
  if (typeof window === "undefined") return;
  try {
    if (disconnected) {
      window.localStorage.setItem(evmWalletManualDisconnectStorageKey, "1");
    } else {
      window.localStorage.removeItem(evmWalletManualDisconnectStorageKey);
    }
  } catch {
    // Some embedded browsers disable localStorage.
  }
}

function getMissingWalletMessage() {
  if (typeof window === "undefined") return "未检测到 EVM 钱包";
  const { hostname, protocol } = window.location;
  const canInject = protocol === "https:" || hostname === "localhost" || hostname === "127.0.0.1";
  return canInject ? "未检测到 MetaMask / OKX / Rabby / Phantom 等 EVM 钱包" : "请通过 localhost 或 HTTPS 打开页面";
}

function getEvmWalletErrorMessage(error: unknown) {
  const detail = error && typeof error === "object" && "message" in error ? String((error as { message?: unknown }).message || "") : "";
  const code = error && typeof error === "object" && "code" in error ? Number((error as { code?: unknown }).code) : 0;

  if (code === 4001 || /reject|declin|cancel/i.test(detail)) return "用户取消了钱包连接";
  if (/already pending/i.test(detail)) return "钱包正在处理上一次连接请求";
  return "EVM 钱包连接失败，请稍后重试";
}

function isEvmProvider(provider?: EvmWalletProvider | null): provider is EvmWalletProvider {
  return Boolean(provider && typeof provider.request === "function");
}

function getProviderName(provider: EvmWalletProvider) {
  if (provider.isOkxWallet) return "OKX Wallet";
  if (provider.isRabby) return "Rabby";
  if (provider.isCoinbaseWallet) return "Coinbase Wallet";
  if (provider.isTrust) return "Trust Wallet";
  if (provider.isPhantom) return "Phantom";
  if (provider.isMetaMask) return "MetaMask";
  return "EVM 钱包";
}

function getKnownWalletName(id: string) {
  if (id === "metamask") return "MetaMask";
  if (id === "okx") return "OKX Wallet";
  if (id === "rabby") return "Rabby";
  if (id === "coinbase") return "Coinbase Wallet";
  if (id === "trust") return "Trust Wallet";
  if (id === "phantom") return "Phantom";
  return "EVM 钱包";
}

function getEip6963Id(detail: Eip6963ProviderDetail) {
  const rdns = detail.info?.rdns?.toLowerCase() || "";
  const name = detail.info?.name?.toLowerCase() || "";
  if (rdns.includes("metamask") || name.includes("metamask")) return "metamask";
  if (rdns.includes("okx") || name.includes("okx")) return "okx";
  if (rdns.includes("rabby") || name.includes("rabby")) return "rabby";
  if (rdns.includes("coinbase") || name.includes("coinbase")) return "coinbase";
  if (rdns.includes("trust") || name.includes("trust")) return "trust";
  if (rdns.includes("phantom") || name.includes("phantom")) return "phantom";
  return detail.info?.uuid || rdns || name || "evm";
}

function getEip6963Priority(id: string) {
  if (id === "metamask") return 10;
  if (id === "okx") return 20;
  if (id === "rabby") return 30;
  if (id === "coinbase") return 40;
  if (id === "trust") return 50;
  if (id === "phantom") return 60;
  return 90;
}

function getInstallUrl(id: string) {
  if (id === "okx") return "https://www.okx.com/web3";
  if (id === "rabby") return "https://rabby.io/";
  if (id === "coinbase") return "https://www.coinbase.com/wallet/downloads";
  if (id === "trust") return "https://trustwallet.com/browser-extension";
  if (id === "phantom") return "https://phantom.app/download";
  return evmWalletInstallUrl;
}

function getOkxEvmProvider() {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { okxwallet?: { ethereum?: EvmWalletProvider } }).okxwallet?.ethereum;
}

function addWalletCandidate(wallets: DetectedEvmWallet[], candidate: DetectedEvmWallet) {
  if (!isEvmProvider(candidate.provider)) return;
  if (wallets.some((wallet) => wallet.provider === candidate.provider || wallet.id === candidate.id)) return;
  wallets.push(candidate);
}

function getWalletFromProvider(provider: EvmWalletProvider, fallbackId = "evm", fallbackName?: string): DetectedEvmWallet {
  if (fallbackId !== "evm") {
    return {
      id: fallbackId,
      installUrl: getInstallUrl(fallbackId),
      name: fallbackName || getKnownWalletName(fallbackId),
      priority: getEip6963Priority(fallbackId),
      provider
    };
  }

  if (provider.isOkxWallet) return { id: "okx", installUrl: "https://www.okx.com/web3", name: "OKX Wallet", priority: 20, provider };
  if (provider.isRabby) return { id: "rabby", installUrl: "https://rabby.io/", name: "Rabby", priority: 30, provider };
  if (provider.isCoinbaseWallet) return { id: "coinbase", installUrl: "https://www.coinbase.com/wallet/downloads", name: "Coinbase Wallet", priority: 40, provider };
  if (provider.isTrust) return { id: "trust", installUrl: "https://trustwallet.com/browser-extension", name: "Trust Wallet", priority: 50, provider };
  if (provider.isPhantom) return { id: "phantom", installUrl: "https://phantom.app/download", name: "Phantom", priority: 60, provider };
  if (provider.isMetaMask) return { id: "metamask", installUrl: evmWalletInstallUrl, name: "MetaMask", priority: 10, provider };
  return { id: fallbackId, installUrl: getInstallUrl(fallbackId), name: fallbackName || getProviderName(provider), priority: getEip6963Priority(fallbackId), provider };
}

export function getEvmWallets(eip6963Wallets: DetectedEvmWallet[] = []) {
  if (typeof window === "undefined") return [];
  const wallets: DetectedEvmWallet[] = [];
  const hasEip6963Wallets = eip6963Wallets.length > 0;
  const hasEip6963MetaMask = eip6963Wallets.some((wallet) => wallet.id === "metamask");

  eip6963Wallets.forEach((wallet) => addWalletCandidate(wallets, wallet));

  if (isEvmProvider(window.ethereum)) {
    const providers = Array.isArray(window.ethereum.providers) ? window.ethereum.providers : [window.ethereum];
    providers.forEach((provider) => {
      const wallet = getWalletFromProvider(provider);
      if (wallet.id === "metamask" && hasEip6963Wallets && !hasEip6963MetaMask) return;
      addWalletCandidate(wallets, wallet);
    });
  }

  const okxProvider = getOkxEvmProvider();
  if (isEvmProvider(okxProvider)) addWalletCandidate(wallets, getWalletFromProvider(okxProvider, "okx", "OKX Wallet"));
  if (isEvmProvider(window.coinbaseWalletExtension)) addWalletCandidate(wallets, getWalletFromProvider(window.coinbaseWalletExtension, "coinbase", "Coinbase Wallet"));
  if (isEvmProvider(window.rabby)) addWalletCandidate(wallets, getWalletFromProvider(window.rabby, "rabby", "Rabby"));
  if (isEvmProvider(window.trustwallet)) addWalletCandidate(wallets, getWalletFromProvider(window.trustwallet, "trust", "Trust Wallet"));

  return wallets.sort((left, right) => left.priority - right.priority);
}

export function getPreferredEvmWallet(wallets: DetectedEvmWallet[], preferredWalletId?: string) {
  return wallets.find((wallet) => wallet.id === preferredWalletId)
    || wallets[0]
    || null;
}

function getPreferredEvmWalletChoice(wallets: EvmWalletChoice[], preferredWalletId?: string) {
  return wallets.find((wallet) => wallet.id === preferredWalletId)
    || wallets[0]
    || null;
}

function getWalletChoices(wallets: DetectedEvmWallet[]): EvmWalletChoice[] {
  return wallets.map(({ id, installUrl, name, priority }) => ({ id, installUrl, name, priority }));
}

function normalizeAccount(value: unknown) {
  return typeof value === "string" ? value : "";
}

export async function getConnectedEvmWallet(wallets: DetectedEvmWallet[], preferredWalletId?: string) {
  const preferredWallet = getPreferredEvmWallet(wallets, preferredWalletId);
  const orderedWallets = preferredWallet
    ? [preferredWallet, ...wallets.filter((wallet) => wallet.provider !== preferredWallet.provider)]
    : wallets;

  for (const wallet of orderedWallets) {
    try {
      const result = await wallet.provider.request({ method: "eth_accounts" });
      const accounts = Array.isArray(result) ? result : [];
      const address = normalizeAccount(accounts[0]);
      if (address) return { address, wallet };
    } catch {
      // Keep scanning other injected providers.
    }
  }

  return null;
}

export function useEvmWallet() {
  const eip6963WalletsRef = useRef<DetectedEvmWallet[]>([]);
  const walletProvidersRef = useRef<Map<string, EvmWalletProvider>>(new Map());
  const selectedProviderRef = useRef<EvmWalletProvider | null>(null);
  const activeProviderRef = useRef<EvmWalletProvider | null>(null);
  const manuallyDisconnectedRef = useRef(readManualEvmDisconnect());
  const [eip6963Revision, setEip6963Revision] = useState(0);
  const [wallets, setWallets] = useState<EvmWalletChoice[]>([]);
  const [selectedWalletId, setSelectedWalletId] = useState(readStoredEvmWalletId);
  const [providerName, setProviderName] = useState("EVM 钱包");
  const [address, setAddress] = useState("");
  const [chainIdHex, setChainIdHex] = useState("");
  const [status, setStatus] = useState<EvmWalletStatus>("idle");
  const [message, setMessage] = useState("");
  const [activeWalletId, setActiveWalletId] = useState("");

  const selectedWallet = useMemo(() => getPreferredEvmWalletChoice(wallets, selectedWalletId), [selectedWalletId, wallets]);

  const refreshWallets = useCallback(() => {
    const detectedWallets = getEvmWallets(eip6963WalletsRef.current);
    const preferredWallet = getPreferredEvmWallet(detectedWallets, selectedWalletId);
    walletProvidersRef.current = new Map(detectedWallets.map((wallet) => [wallet.id, wallet.provider]));
    setWallets(getWalletChoices(detectedWallets));
    setSelectedWalletId((current) => getPreferredEvmWallet(detectedWallets, current)?.id || preferredWallet?.id || "");
    if (!activeWalletId) {
      selectedProviderRef.current = preferredWallet?.provider || null;
      setProviderName(preferredWallet?.name || "EVM 钱包");
    }

    if (!detectedWallets.length) {
      setAddress("");
      setActiveWalletId("");
      selectedProviderRef.current = null;
      activeProviderRef.current = null;
      walletProvidersRef.current = new Map();
      setProviderName("EVM 钱包");
      setChainIdHex("");
      setStatus("missing");
      setMessage(getMissingWalletMessage());
    } else {
      setStatus((current) => current === "missing" ? "idle" : current);
      setMessage((current) => current === getMissingWalletMessage() ? "" : current);
    }
    return detectedWallets;
  }, [activeWalletId, eip6963Revision, selectedWalletId]);

  const selectWallet = useCallback((walletId: string) => {
    writeStoredEvmWalletId(walletId);
    setSelectedWalletId(walletId);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    const handleProviderAnnounce = (event: CustomEvent<Eip6963ProviderDetail>) => {
      const detail = event.detail;
      if (!isEvmProvider(detail.provider)) return;
      const id = getEip6963Id(detail);
      const wallet = getWalletFromProvider(detail.provider, id, detail.info?.name);
      const currentWallets = eip6963WalletsRef.current;
      if (currentWallets.some((item) => item.provider === wallet.provider || item.id === wallet.id)) return;
      eip6963WalletsRef.current = [...currentWallets, wallet];
      setEip6963Revision((current) => current + 1);
    };
    window.addEventListener("eip6963:announceProvider", handleProviderAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));

    return () => window.removeEventListener("eip6963:announceProvider", handleProviderAnnounce);
  }, []);

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
    if (activeWalletId) return;
    selectedProviderRef.current = selectedWallet ? walletProvidersRef.current.get(selectedWallet.id) || null : null;
    setProviderName(selectedWallet?.name || "EVM 钱包");
  }, [activeWalletId, selectedWallet]);

  useEffect(() => {
    if (activeWalletId || status === "connecting" || manuallyDisconnectedRef.current) return undefined;
    const detectedWallets = getEvmWallets(eip6963WalletsRef.current);
    if (!detectedWallets.length) return undefined;

    let cancelled = false;
    void getConnectedEvmWallet(detectedWallets, selectedWalletId).then((connectedWallet) => {
      if (cancelled || !connectedWallet) return;
      const { address: nextAddress, wallet } = connectedWallet;
      selectedProviderRef.current = wallet.provider;
      activeProviderRef.current = wallet.provider;
      writeStoredEvmWalletId(wallet.id);
      setSelectedWalletId(wallet.id);
      setProviderName(wallet.name);
      setActiveWalletId(wallet.id);
      setAddress(nextAddress);
      setStatus("connected");
      setMessage("钱包已连接");
    });

    return () => {
      cancelled = true;
    };
  }, [activeWalletId, selectedWalletId, status, wallets]);

  useEffect(() => {
    const provider = activeWalletId ? activeProviderRef.current : selectedProviderRef.current;
    if (!provider) {
      setChainIdHex("");
      return;
    }
    const handleChainChanged = (...args: unknown[]) => {
      setChainIdHex(typeof args[0] === "string" ? args[0] : "");
    };

    provider.on?.("chainChanged", handleChainChanged);
    provider.request({ method: "eth_chainId" }).then((result) => {
      setChainIdHex(typeof result === "string" ? result : "");
    }).catch(() => undefined);

    return () => {
      provider.removeListener?.("chainChanged", handleChainChanged);
    };
  }, [activeWalletId, selectedWalletId, wallets]);

  useEffect(() => {
    const provider = activeProviderRef.current;
    if (!provider || !activeWalletId) return;

    const handleAccountsChanged = (...args: unknown[]) => {
      const accounts = Array.isArray(args[0]) ? args[0] : [];
      const nextAddress = normalizeAccount(accounts[0]);
      setAddress(nextAddress);
      setStatus(nextAddress ? "connected" : "idle");
      setMessage(nextAddress ? "钱包已连接" : "钱包账户已断开");
    };
    const handleDisconnect = () => {
      setAddress("");
      setActiveWalletId("");
      setStatus("idle");
      setMessage("钱包已断开");
    };

    provider.on?.("accountsChanged", handleAccountsChanged);
    provider.on?.("disconnect", handleDisconnect);

    return () => {
      provider.removeListener?.("accountsChanged", handleAccountsChanged);
      provider.removeListener?.("disconnect", handleDisconnect);
    };
  }, [activeWalletId]);

  const connectWallet = useCallback(async (walletId?: string) => {
    const detectedWallets = refreshWallets();
    const wallet = getPreferredEvmWallet(detectedWallets, walletId || selectedWalletId);
    if (!wallet) {
      setStatus("missing");
      setMessage(getMissingWalletMessage());
      window.open(evmWalletInstallUrl, "_blank", "noopener,noreferrer");
      return;
    }

    const { name, provider: walletProvider } = wallet;
    setSelectedWalletId(wallet.id);
    writeStoredEvmWalletId(wallet.id);
    selectedProviderRef.current = walletProvider;
    activeProviderRef.current = walletProvider;
    setProviderName(name);
    setActiveWalletId(wallet.id);
    setStatus("connecting");
    setMessage(`请在 ${name} 中确认连接`);

    try {
      const result = await walletProvider.request({ method: "eth_requestAccounts" });
      const accounts = Array.isArray(result) ? result : [];
      const nextAddress = normalizeAccount(accounts[0]);
      if (!nextAddress) throw new Error("Wallet returned no account");
      manuallyDisconnectedRef.current = false;
      writeManualEvmDisconnect(false);
      setAddress(nextAddress);
      setStatus("connected");
      setMessage("钱包已连接");
    } catch (error) {
      setAddress("");
      activeProviderRef.current = null;
      setActiveWalletId("");
      setStatus("error");
      setMessage(getEvmWalletErrorMessage(error));
    }
  }, [refreshWallets, selectedWalletId]);

  const disconnectWallet = useCallback(() => {
    manuallyDisconnectedRef.current = true;
    writeManualEvmDisconnect(true);
    setAddress("");
    activeProviderRef.current = null;
    setActiveWalletId("");
    setStatus(selectedProviderRef.current || walletProvidersRef.current.size > 0 ? "idle" : "missing");
    setMessage("钱包已断开");
  }, []);

  const getProvider = useCallback(() => activeProviderRef.current, []);

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
    chainIdHex,
    connectWallet,
    connected,
    disconnectWallet,
    getProvider,
    message,
    providerName,
    selectedWalletId,
    selectWallet,
    status,
    statusText,
    wallets
  };
}

export type EvmWalletState = ReturnType<typeof useEvmWallet>;
