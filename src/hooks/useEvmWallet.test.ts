import { afterEach, describe, expect, it } from "vitest";
import { getConnectedEvmWallet, getEvmWallets, getPreferredEvmWallet, type EvmWalletProvider } from "./useEvmWallet";

function makeProvider(flags: Partial<EvmWalletProvider> = {}): EvmWalletProvider {
  return {
    request: async () => [],
    ...flags
  };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
});

describe("getEvmWallets", () => {
  it("lists distinct injected EVM wallets from provider arrays", () => {
    const metamask = makeProvider({ isMetaMask: true });
    const okx = makeProvider({ isOkxWallet: true });
    const rabby = makeProvider({ isRabby: true });

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        ethereum: {
          providers: [okx, metamask, rabby],
          request: async () => []
        },
        location: { hostname: "localhost", protocol: "http:" }
      }
    });

    const wallets = getEvmWallets();

    expect(wallets.map((wallet) => wallet.id)).toEqual(["metamask", "okx", "rabby"]);
    expect(getPreferredEvmWallet(wallets)?.id).toBe("metamask");
    expect(getPreferredEvmWallet(wallets, "okx")?.provider).toBe(okx);
  });

  it("does not treat Solana-only injections as EVM wallets", () => {
    const phantomEvm = makeProvider({ isPhantom: true });
    const phantomSolana = { connect: async () => undefined };

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        ethereum: {
          providers: [phantomSolana, phantomEvm],
          request: async () => []
        },
        location: { hostname: "localhost", protocol: "http:" },
        phantom: { solana: phantomSolana }
      }
    });

    const wallets = getEvmWallets();

    expect(wallets).toHaveLength(1);
    expect(wallets[0]).toMatchObject({ id: "phantom", name: "Phantom" });
    expect(wallets[0]?.provider).toBe(phantomEvm);
  });

  it("prefers wallet-specific EVM flags over MetaMask compatibility flags", () => {
    const phantom = makeProvider({ isMetaMask: true, isPhantom: true });

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        ethereum: {
          providers: [phantom],
          request: async () => []
        },
        location: { hostname: "localhost", protocol: "http:" }
      }
    });

    const wallets = getEvmWallets();

    expect(wallets).toHaveLength(1);
    expect(wallets[0]).toMatchObject({ id: "phantom", name: "Phantom" });
  });

  it("keeps EIP-6963 wallet identity when the provider also mimics MetaMask", () => {
    const phantom = makeProvider({ isMetaMask: true });

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        ethereum: {
          providers: [phantom],
          request: async () => []
        },
        location: { hostname: "localhost", protocol: "http:" }
      }
    });

    const wallets = getEvmWallets([{
      id: "phantom",
      installUrl: "https://phantom.app/download",
      name: "Phantom",
      priority: 60,
      provider: phantom
    }]);

    expect(wallets).toHaveLength(1);
    expect(wallets[0]).toMatchObject({ id: "phantom", name: "Phantom" });
  });

  it("skips top-level MetaMask-compatible providers when EIP-6963 reports the real wallet", () => {
    const okx = makeProvider();
    const topLevelOkxShim = makeProvider({ isMetaMask: true });

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        ethereum: {
          providers: [topLevelOkxShim],
          request: async () => []
        },
        location: { hostname: "localhost", protocol: "http:" }
      }
    });

    const wallets = getEvmWallets([{
      id: "okx",
      installUrl: "https://www.okx.com/web3",
      name: "OKX Wallet",
      priority: 20,
      provider: okx
    }]);

    expect(wallets.map((wallet) => wallet.id)).toEqual(["okx"]);
  });
});

describe("getConnectedEvmWallet", () => {
  it("restores the preferred authorized wallet without prompting", async () => {
    const metamask = makeProvider({
      isMetaMask: true,
      request: async ({ method }) => method === "eth_accounts" ? ["0x1111111111111111111111111111111111111111"] : []
    });
    const okx = makeProvider({
      isOkxWallet: true,
      request: async ({ method }) => method === "eth_accounts" ? ["0x2222222222222222222222222222222222222222"] : []
    });

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        ethereum: {
          providers: [metamask, okx],
          request: async () => []
        },
        location: { hostname: "localhost", protocol: "http:" }
      }
    });

    const connectedWallet = await getConnectedEvmWallet(getEvmWallets(), "okx");

    expect(connectedWallet?.wallet.id).toBe("okx");
    expect(connectedWallet?.address).toBe("0x2222222222222222222222222222222222222222");
  });

  it("continues scanning when a provider rejects eth_accounts", async () => {
    const metamask = makeProvider({
      isMetaMask: true,
      request: async ({ method }) => {
        if (method === "eth_accounts") throw new Error("provider unavailable");
        return [];
      }
    });
    const rabby = makeProvider({
      isRabby: true,
      request: async ({ method }) => method === "eth_accounts" ? ["0x3333333333333333333333333333333333333333"] : []
    });

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        ethereum: {
          providers: [metamask, rabby],
          request: async () => []
        },
        location: { hostname: "localhost", protocol: "http:" }
      }
    });

    const connectedWallet = await getConnectedEvmWallet(getEvmWallets());

    expect(connectedWallet?.wallet.id).toBe("rabby");
    expect(connectedWallet?.address).toBe("0x3333333333333333333333333333333333333333");
  });
});
