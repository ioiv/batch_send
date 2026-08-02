import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEvmDistributionNetwork,
  disperseContractAddress,
  disperseContractRuntimeCodeHash,
  ensureEvmNetwork,
  evmNetworks,
  formatWeiForDisplay,
  getEvmAssetSymbol,
  getEvmBalanceLookupErrorMessage,
  getEvmDistributionNetworks,
  getEvmExplorerUrl,
  getEvmNativeCurrencyMetadata,
  getEvmTransactionErrorMessage,
  getPreferredEvmDistributionNetwork,
  getVerifiedEvmDistributionChainIds,
  hasExpectedDisperseContractCode,
  isEvmNativeCurrencyEnabled,
  isValidEvmAddress,
  mergeEvmDistributionNetworks,
  parseEvmDistribution,
  registerVerifiedEvmDistributionNetwork,
  removeVerifiedEvmDistributionNetwork,
  sendEvmNativeDistribution
} from "./evm";

const addressOne = "0x00000000000000000000000000000000000000aa";
const addressOneMixedCase = "0x00000000000000000000000000000000000000AA";
const addressTwo = "0x0000000000000000000000000000000000000002";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseEvmDistribution", () => {
  it("parses EVM rows and totals wei with 18 decimals", () => {
    const parsed = parseEvmDistribution(`${addressOne},1\n${addressTwo},0.000000000000000001`);

    expect(parsed.validRows).toHaveLength(2);
    expect(parsed.invalid).toBe(0);
    expect(parsed.duplicates).toBe(0);
    expect(parsed.totalWei).toBe(1_000_000_000_000_000_001n);
    expect(parsed.total).toBe("1.000000000000000001");
  });

  it("parses token rows using the selected token decimals", () => {
    const parsed = parseEvmDistribution(`${addressOne},1.234567\n${addressTwo},0.000001`, 6);

    expect(parsed.validRows).toHaveLength(2);
    expect(parsed.invalid).toBe(0);
    expect(parsed.totalWei).toBe(1_234_568n);
    expect(parsed.total).toBe("1.234568");
  });

  it("rejects invalid addresses, malformed rows, and bad amounts", () => {
    const parsed = parseEvmDistribution([
      `${addressOne},0`,
      `${addressTwo}`,
      "not-an-address,1",
      `${addressTwo},1.0000000000000000001`
    ].join("\n"));

    expect(parsed.validRows).toHaveLength(0);
    expect(parsed.invalid).toBe(4);
    expect(parsed.rows.map((row) => row.status)).toEqual(["invalid", "invalid", "invalid", "invalid"]);
    expect(parsed.rows.flatMap((row) => row.problems)).toEqual(expect.arrayContaining([
      "EVM 地址格式不正确",
      "格式需要刚好包含一个逗号",
      "金额需要大于 0"
    ]));
  });

  it("marks duplicate EVM addresses case-insensitively", () => {
    const parsed = parseEvmDistribution(`${addressOne},1\n${addressOneMixedCase},2\n${addressTwo},3`);

    expect(parsed.duplicates).toBe(1);
    expect(parsed.invalid).toBe(1);
    expect(parsed.validRows.map((row) => row.address)).toEqual([addressOne, addressTwo]);
    expect(parsed.totalWei).toBe(4_000_000_000_000_000_000n);
  });
});

describe("evm network config", () => {
  it("formats displayed balances to at most 4 decimal places", () => {
    expect(formatWeiForDisplay(1_234_567_890_000_000_000n, 18)).toBe("1.2345");
    expect(formatWeiForDisplay(1_200_000n, 6)).toBe("1.2");
    expect(formatWeiForDisplay(42n, 0)).toBe("42");
  });

  it("orders mainnet options by current chain heat and keeps testnet last", () => {
    expect(evmNetworks.map((network) => network.id)).toEqual([
      "ethereum",
      "bsc",
      "base",
      "robinhood",
      "arbitrum",
      "polygon",
      "optimism",
      "avalanche",
      "hyperliquid",
      "monad",
      "gnosis",
      "sepolia",
      "hoodi",
      "bscTestnet",
      "baseSepolia",
      "arbitrumSepolia",
      "optimismSepolia",
      "polygonAmoy",
      "avalancheFuji",
      "monadTestnet"
    ]);
  });

  it("uses only the new deterministic Disperse contract", () => {
    expect(disperseContractAddress).toBe("0xd15fE25eD0Dba12fE05e7029C88b10C25e8880E3");
    expect(disperseContractRuntimeCodeHash).toBe("0xc0a38c227d2c70248fc51ed0dd3a72df3adf5b41494c7f3cc19c16c38523244d");
    expect(new Set(evmNetworks.map((network) => network.disperseContractAddress))).toEqual(new Set([disperseContractAddress]));
  });

  it("merges a verified custom chain into the distribution network list", () => {
    const customNetwork = createEvmDistributionNetwork({
      blockExplorerUrl: "",
      chainId: 7777777,
      label: "EVM Chain 7777777",
      nativeCurrency: { decimals: 18, name: "Native currency", symbol: "NATIVE" },
      rpcEndpoint: "https://custom.example.test"
    });

    const networks = mergeEvmDistributionNetworks([customNetwork]);

    expect(networks.at(-1)).toEqual(customNetwork);
    expect(customNetwork).toMatchObject({
      disperseContractAddress,
      id: "custom-7777777"
    });
  });

  it("preserves confirmed custom native currency decimals for distribution amounts", () => {
    const customNetwork = createEvmDistributionNetwork({
      blockExplorerUrl: "",
      chainId: 7777777,
      label: "Six Decimal Chain",
      nativeCurrency: { decimals: 6, name: "Custom Dollar", symbol: "CUSD" },
      nativeCurrencyMetadata: {
        confirmedAt: "2026-08-02T00:00:00.000Z",
        source: "manual",
        sourceVersion: "user-confirmed",
        status: "confirmed"
      },
      rpcEndpoint: "https://custom.example.test"
    });

    const parsed = parseEvmDistribution(`${addressOne},1.25`, customNetwork.nativeCurrency.decimals);

    expect(customNetwork.nativeCurrency).toEqual({ decimals: 6, name: "Custom Dollar", symbol: "CUSD" });
    expect(isEvmNativeCurrencyEnabled(customNetwork)).toBe(true);
    expect(parsed.totalWei).toBe(1_250_000n);
  });

  it("keeps explicitly unconfirmed viem metadata disabled", () => {
    const customNetwork = createEvmDistributionNetwork({
      blockExplorerUrl: "https://explorer.rsk.co",
      chainId: 30,
      label: "Rootstock Mainnet",
      nativeCurrency: { decimals: 18, name: "Rootstock Bitcoin", symbol: "RBTC" },
      nativeCurrencyMetadata: {
        confirmedAt: "",
        source: "viem",
        sourceVersion: "2.52.2",
        status: "unconfirmed"
      },
      rpcEndpoint: "https://rootstock.example.test"
    });

    expect(isEvmNativeCurrencyEnabled(customNetwork)).toBe(false);
    expect(getEvmNativeCurrencyMetadata(customNetwork)).toMatchObject({
      confirmedAt: "",
      source: "viem",
      sourceVersion: "2.52.2",
      status: "unconfirmed"
    });
  });

  it("persists an explicit unconfirmed viem status without upgrading it", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) || null,
        setItem: (key: string, value: string) => values.set(key, value)
      }
    });
    const network = createEvmDistributionNetwork({
      blockExplorerUrl: "https://explorer.rsk.co",
      chainId: 30,
      label: "Rootstock Mainnet",
      nativeCurrency: { decimals: 18, name: "Rootstock Bitcoin", symbol: "RBTC" },
      nativeCurrencyMetadata: {
        confirmedAt: "",
        source: "viem",
        sourceVersion: "2.52.2",
        status: "unconfirmed"
      },
      rpcEndpoint: "https://rootstock.example.test"
    });

    expect(registerVerifiedEvmDistributionNetwork(network)).not.toBeNull();
    expect(getEvmDistributionNetworks().find((item) => item.chainId === 30)?.nativeCurrencyMetadata).toEqual({
      confirmedAt: "",
      source: "viem",
      sourceVersion: "2.52.2",
      status: "unconfirmed"
    });
  });

  it("still blocks native sends when no metadata source exists", async () => {
    const network = createEvmDistributionNetwork({
      blockExplorerUrl: "",
      chainId: 7777777,
      label: "Unknown Chain",
      nativeCurrency: { decimals: 0, name: "Unconfirmed base unit", symbol: "base units" },
      rpcEndpoint: "https://custom.example.test"
    });

    await expect(sendEvmNativeDistribution({
      from: addressOne,
      network,
      provider: { request: vi.fn() },
      rows: [],
      rpcEndpoint: network.rpcEndpoint
    })).rejects.toThrow("原生币元数据尚未确认");
  });

  it("rejects incomplete or out-of-range custom native currency metadata", () => {
    expect(() => createEvmDistributionNetwork({
      blockExplorerUrl: "",
      chainId: 7777777,
      label: "Broken Chain",
      nativeCurrency: { decimals: -1, name: "", symbol: "" },
      rpcEndpoint: "https://custom.example.test"
    })).toThrow("EVM 原生币元数据不完整");
  });

  it("normalizes a custom explorer URL and builds transaction links", () => {
    const customNetwork = createEvmDistributionNetwork({
      blockExplorerUrl: "https://scan.example.test///",
      chainId: 7777777,
      label: "Custom EVM",
      nativeCurrency: { decimals: 18, name: "Native currency", symbol: "NATIVE" },
      rpcEndpoint: "https://custom.example.test"
    });

    expect(customNetwork.blockExplorerUrl).toBe("https://scan.example.test");
    expect(getEvmExplorerUrl("0xabc", customNetwork)).toBe("https://scan.example.test/tx/0xabc");
  });

  it("deduplicates the final distribution list by numeric chain ID and keeps the latest verified RPC", () => {
    const first = createEvmDistributionNetwork({
      blockExplorerUrl: "",
      chainId: 7777777,
      label: "Custom EVM",
      nativeCurrency: { decimals: 18, name: "Native currency", symbol: "NATIVE" },
      rpcEndpoint: "https://old.example.test"
    });
    const latest = { ...first, rpcEndpoint: "https://latest.example.test" };

    const networks = mergeEvmDistributionNetworks([first, latest]);
    const matchingNetworks = networks.filter((network) => network.chainId === 7777777);

    expect(matchingNetworks).toHaveLength(1);
    expect(matchingNetworks[0].rpcEndpoint).toBe("https://latest.example.test");
    expect(new Set(networks.map((network) => network.chainId)).size).toBe(networks.length);
  });

  it("persists a verified existing chain RPC and selects it on the distribution page", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) || null,
        setItem: (key: string, value: string) => values.set(key, value)
      }
    });
    const avalanche = evmNetworks.find((network) => network.id === "avalanche");
    expect(avalanche).toBeDefined();

    const deploymentNetwork = {
      ...avalanche!,
      rpcEndpoint: "https://verified-avalanche.example.test"
    };
    const registered = registerVerifiedEvmDistributionNetwork(deploymentNetwork);
    const networks = getEvmDistributionNetworks();
    const preferred = getPreferredEvmDistributionNetwork(networks);

    expect(registered).toMatchObject({ id: "avalanche" });
    expect(networks.find((network) => network.id === "avalanche")?.rpcEndpoint).toBe("https://verified-avalanche.example.test");
    expect(preferred.id).toBe("avalanche");
  });

  it("removes a manually registered custom chain and resets the preferred network", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) || null,
        setItem: (key: string, value: string) => values.set(key, value)
      }
    });
    const customNetwork = createEvmDistributionNetwork({
      blockExplorerUrl: "",
      chainId: 59144,
      label: "Linea",
      nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
      rpcEndpoint: "https://linea.example.test"
    });

    expect(registerVerifiedEvmDistributionNetwork(customNetwork)).not.toBeNull();
    expect(getVerifiedEvmDistributionChainIds()).toContain(59144);
    expect(removeVerifiedEvmDistributionNetwork(59144)).toBe(true);

    const networks = getEvmDistributionNetworks();
    expect(networks.some((network) => network.chainId === 59144)).toBe(false);
    expect(getVerifiedEvmDistributionChainIds()).not.toContain(59144);
    expect(getPreferredEvmDistributionNetwork(networks).id).toBe("ethereum");
  });

  it("does not expose networks where the new Disperse contract is absent", () => {
    const configuredNetworkIds = evmNetworks.map((network) => network.id) as string[];
    const unavailableNetworkIds = [
      "fantom",
      "moonriver",
      "moonbeam",
      "robinhoodTestnet",
      "hyperliquidTestnet"
    ];

    unavailableNetworkIds.forEach((networkId) => {
      expect(configuredNetworkIds).not.toContain(networkId);
    });
  });

  it("uses public HTTPS RPC endpoints only", () => {
    expect(evmNetworks.every((network) => network.rpcEndpoint.startsWith("https://"))).toBe(true);
    expect(evmNetworks.some((network) => network.rpcEndpoint.includes("192.168."))).toBe(false);
  });

  it("rejects empty or unexpected Disperse runtime bytecode", () => {
    expect(hasExpectedDisperseContractCode("0x")).toBe(false);
    expect(hasExpectedDisperseContractCode("0x00")).toBe(false);
  });

  it("keeps actionable messages for config and reverted transaction failures", () => {
    expect(getEvmTransactionErrorMessage(new Error("RPC 网络不匹配：当前 RPC 是 chainId 1"))).toContain("RPC 网络不匹配");
    expect(getEvmTransactionErrorMessage(new Error("Ethereum 分发合约字节码不匹配，已阻止交易"))).toBe("Ethereum 分发合约字节码不匹配，已阻止交易");
    expect(getEvmTransactionErrorMessage(new Error("EVM 分发交易已上链但执行失败"))).toBe("EVM 分发交易执行失败，资金未按清单分发，请打开交易详情核对");
    expect(getEvmBalanceLookupErrorMessage(new Error("failed to fetch"))).toBe("余额读取失败，请更换 RPC 后重试");
  });

  it("uses an already-selected unknown chain without requiring native metadata", async () => {
    const provider = {
      request: vi.fn().mockResolvedValue("0x76adf1")
    };
    const network = createEvmDistributionNetwork({
      blockExplorerUrl: "",
      chainId: 7777777,
      label: "EVM Chain 7777777",
      nativeCurrency: { decimals: 0, name: "Unconfirmed base unit", symbol: "base units" },
      rpcEndpoint: "https://custom.example.test"
    });

    await expect(ensureEvmNetwork(provider, network, network.rpcEndpoint)).resolves.toBeUndefined();
    expect(provider.request).toHaveBeenCalledTimes(1);
    expect(provider.request).toHaveBeenCalledWith({ method: "eth_chainId" });
  });

  it("refuses to add an unknown wallet network before native metadata is confirmed", async () => {
    const provider = {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === "eth_chainId") return "0x1";
        if (method === "wallet_switchEthereumChain") throw { code: 4902 };
        throw new Error(`unexpected method ${method}`);
      })
    };
    const network = createEvmDistributionNetwork({
      blockExplorerUrl: "",
      chainId: 7777777,
      label: "EVM Chain 7777777",
      nativeCurrency: { decimals: 0, name: "Unconfirmed base unit", symbol: "base units" },
      rpcEndpoint: "https://custom.example.test"
    });

    await expect(ensureEvmNetwork(provider, network, network.rpcEndpoint)).rejects.toThrow("请先确认原生币元数据");
    expect(provider.request).not.toHaveBeenCalledWith(expect.objectContaining({ method: "wallet_addEthereumChain" }));
  });

  it("labels native and token assets for the EVM page", () => {
    const ethereum = evmNetworks[0];

    expect(getEvmAssetSymbol("native", ethereum, null)).toBe("ETH");
    expect(getEvmAssetSymbol("token", ethereum, {
      address: "0x0000000000000000000000000000000000000001",
      decimals: 6,
      name: "USD Coin",
      symbol: "USDC"
    })).toBe("USDC");
    expect(isValidEvmAddress(addressOne)).toBe(true);
    expect(isValidEvmAddress("not-an-address")).toBe(false);
  });
});
