import { describe, expect, it } from "vitest";
import { disperseContractAddress, disperseContractRuntimeCodeHash, evmNetworks, formatWeiForDisplay, getEvmAssetSymbol, getEvmBalanceLookupErrorMessage, getEvmTransactionErrorMessage, hasExpectedDisperseContractCode, isValidEvmAddress, parseEvmDistribution } from "./evm";

const addressOne = "0x00000000000000000000000000000000000000aa";
const addressOneMixedCase = "0x00000000000000000000000000000000000000AA";
const addressTwo = "0x0000000000000000000000000000000000000002";

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
