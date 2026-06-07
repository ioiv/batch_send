import { afterEach, describe, expect, it } from "vitest";
import {
  getPreferredWallet,
  getSolanaWallets,
  getWalletAddressText,
  waitForConnectedAddress,
  type SolanaWalletProvider
} from "./useSolanaWallet";

const walletAddress = "9YcQwQ6kR4pYc5v2yAf9hWeXvX5gK2oA9rRk2mL3pZqE";

function makeProvider(flags: Partial<SolanaWalletProvider> = {}): SolanaWalletProvider {
  return {
    connect: async () => undefined,
    ...flags
  };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
});

describe("getWalletAddressText", () => {
  it("reads addresses from common Solana wallet result shapes", () => {
    expect(getWalletAddressText({ publicKey: { toBase58: () => walletAddress, toString: () => walletAddress } })).toBe(walletAddress);
    expect(getWalletAddressText({ address: walletAddress })).toBe(walletAddress);
    expect(getWalletAddressText({ account: { public_key: walletAddress } })).toBe(walletAddress);
    expect(getWalletAddressText({ accounts: [{ address: walletAddress }] })).toBe(walletAddress);
  });
});

describe("waitForConnectedAddress", () => {
  it("waits for wallets that populate publicKey after connect resolves", async () => {
    const provider: SolanaWalletProvider = {
      connect: async () => undefined,
      publicKey: null
    };

    globalThis.setTimeout(() => {
      provider.publicKey = { toBase58: () => walletAddress, toString: () => walletAddress };
    }, 20);

    await expect(waitForConnectedAddress(provider)).resolves.toBe(walletAddress);
  });

  it("can read getAccount when publicKey is not exposed", async () => {
    const provider: SolanaWalletProvider = {
      connect: async () => undefined,
      getAccount: () => ({ address: walletAddress })
    };

    await expect(waitForConnectedAddress(provider)).resolves.toBe(walletAddress);
  });
});

describe("getSolanaWallets", () => {
  it("lists distinct injected wallets and defaults to Phantom when several extensions are installed", () => {
    const phantom = makeProvider({ isPhantom: true });
    const okx = makeProvider({ isOkxWallet: true });
    const solflare = makeProvider({ isSolflare: true });

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { hostname: "localhost", protocol: "http:" },
        okxwallet: { solana: okx },
        phantom: { solana: phantom },
        solana: okx,
        solflare
      }
    });

    const wallets = getSolanaWallets() || [];

    expect(wallets.map((wallet) => wallet.id)).toEqual(["phantom", "okx", "solflare"]);
    expect(getPreferredWallet(wallets)?.id).toBe("phantom");
    expect(getPreferredWallet(wallets, "okx")?.provider).toBe(okx);
  });
});
