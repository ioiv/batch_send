import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  estimateContractGas: vi.fn(),
  getBalance: vi.fn(),
  getBlockNumber: vi.fn(),
  getChainId: vi.fn(),
  getCode: vi.fn(),
  getGasPrice: vi.fn(),
  readContract: vi.fn()
}));

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => mocks),
    keccak256: vi.fn(() => "0xc0a38c227d2c70248fc51ed0dd3a72df3adf5b41494c7f3cc19c16c38523244d")
  };
});

import { evmNetworks, getEvmNativeBalance, getEvmTokenBalance, preflightEvmDistribution, type EvmDistributionRow } from "./evm";

const from = "0x00000000000000000000000000000000000000aa";
const recipient = "0x0000000000000000000000000000000000000002";
const tokenAddress = "0x0000000000000000000000000000000000000003";
const network = evmNetworks[0];
const rows: EvmDistributionRow[] = [{
  address: recipient,
  amountRaw: "0.0000000000000001",
  line: 1,
  problems: [],
  status: "valid",
  valueWei: 100n
}];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getChainId.mockResolvedValue(network.chainId);
  mocks.getBlockNumber.mockResolvedValue(120n);
  mocks.getCode.mockResolvedValue("0x1234");
  mocks.getGasPrice.mockResolvedValue(2n);
});

describe("preflightEvmDistribution", () => {
  it("checks the next round against a block at least as new as the previous receipt", async () => {
    mocks.readContract.mockImplementation(async ({ functionName }) => functionName === "balanceOf" ? 50n : 1_000n);
    mocks.getBalance.mockResolvedValue(1_000n);
    await expect(preflightEvmDistribution({
      assetMode: "token", from, minBlockNumber: 110n, network, rows, rpcEndpoint: network.rpcEndpoint,
      token: { address: tokenAddress, decimals: 18, name: "Wrapped Ether", symbol: "WETH" }
    })).rejects.toThrow("Token 余额不足");
    expect(mocks.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "balanceOf", blockNumber: 120n }));
  });

  it("blocks the next round while the RPC is behind the confirmed transaction", async () => {
    mocks.getBlockNumber.mockResolvedValueOnce(109n);
    await expect(preflightEvmDistribution({
      assetMode: "native", from, minBlockNumber: 110n, network, rows, rpcEndpoint: network.rpcEndpoint
    })).rejects.toThrow("RPC 尚未同步至交易确认区块");
    expect(mocks.getBalance).not.toHaveBeenCalled();
  });

  it("estimates native distribution cost without requesting a wallet write", async () => {
    mocks.getBalance.mockResolvedValue(1_000n);
    mocks.estimateContractGas.mockResolvedValue(100n);

    const result = await preflightEvmDistribution({
      assetMode: "native",
      from,
      network,
      rows,
      rpcEndpoint: network.rpcEndpoint
    });

    expect(result).toEqual({
      assetBalanceWei: 1_000n,
      estimatedNetworkFeeWei: 240n,
      feeEstimateBasis: "rpc",
      feeQuote: {
        gasPrice: 2n,
        sampledAt: expect.any(Number),
        source: "rpc",
        type: "legacy"
      },
      nativeBalanceWei: 1_000n,
      needsApproval: false,
      requiredNativeWei: 340n,
      totalTransactions: 1
    });
    expect(mocks.estimateContractGas).toHaveBeenCalledWith(expect.objectContaining({ functionName: "disperseEther" }));
  });

  it("uses a custom EIP-1559 fee cap for the balance budget", async () => {
    mocks.getBalance.mockResolvedValue(1_000n);
    mocks.estimateContractGas.mockResolvedValue(100n);

    const result = await preflightEvmDistribution({
      assetMode: "native",
      from,
      gasSettings: {
        fee: {
          maxFeePerGas: 3n,
          maxPriorityFeePerGas: 1n,
          type: "eip1559"
        },
        mode: "custom"
      },
      network,
      rows,
      rpcEndpoint: network.rpcEndpoint
    });

    expect(result.estimatedNetworkFeeWei).toBe(360n);
    expect(result.feeQuote).toMatchObject({
      maxFeePerGas: 3n,
      maxPriorityFeePerGas: 1n,
      source: "custom",
      type: "eip1559"
    });
    expect(mocks.getGasPrice).not.toHaveBeenCalled();
  });

  it("reports the additional approval and uses a conservative token fee estimate", async () => {
    mocks.getBalance.mockResolvedValue(1_000_000n);
    mocks.readContract.mockImplementation(({ functionName }: { functionName: string }) => {
      if (functionName === "balanceOf") return Promise.resolve(1_000n);
      if (functionName === "allowance") return Promise.resolve(0n);
      throw new Error(`unexpected read ${functionName}`);
    });
    mocks.estimateContractGas.mockResolvedValue(50n);

    const result = await preflightEvmDistribution({
      assetMode: "token",
      from,
      network,
      rows,
      rpcEndpoint: network.rpcEndpoint,
      token: { address: tokenAddress, decimals: 6, name: "Test Token", symbol: "TEST" }
    });

    expect(result.needsApproval).toBe(true);
    expect(result.totalTransactions).toBe(2);
    expect(result.feeEstimateBasis).toBe("conservative");
    expect(result.estimatedNetworkFeeWei).toBe(444_120n);
    expect(mocks.estimateContractGas).toHaveBeenCalledTimes(1);
    expect(mocks.estimateContractGas).toHaveBeenCalledWith(expect.objectContaining({ functionName: "approve" }));
  });

  it("blocks before signing when native balance cannot cover token network fees", async () => {
    mocks.getBalance.mockResolvedValue(100n);
    mocks.readContract.mockImplementation(({ functionName }: { functionName: string }) => (
      Promise.resolve(functionName === "allowance" ? 0n : 1_000n)
    ));
    mocks.estimateContractGas.mockResolvedValue(50n);

    await expect(preflightEvmDistribution({
      assetMode: "token",
      from,
      network,
      rows,
      rpcEndpoint: network.rpcEndpoint,
      token: { address: tokenAddress, decimals: 6, name: "Test Token", symbol: "TEST" }
    })).rejects.toThrow("原生币余额不足以支付预估网络费");
  });
});

describe("confirmed distribution balance reads", () => {
  it.each(["native", "token"])("reads %s balances at a fresh explicit block", async (asset) => {
    mocks.getBalance.mockResolvedValue(12n);
    mocks.readContract.mockResolvedValue(12n);
    const options = { address: from, minBlockNumber: 110n, network, rpcEndpoint: network.rpcEndpoint };
    const balance = asset === "native" ? await getEvmNativeBalance(options) : await getEvmTokenBalance({ ...options, tokenAddress });
    expect(balance).toBe(12n);
    expect(mocks.getBlockNumber).toHaveBeenCalledWith({ cacheTime: 0 });
    expect(asset === "native" ? mocks.getBalance : mocks.readContract).toHaveBeenCalledWith(expect.objectContaining({ blockNumber: 120n }));
  });

  it.each(["native", "token"])("does not display a %s balance from before confirmation", async (asset) => {
    mocks.getBlockNumber.mockResolvedValueOnce(109n);
    const options = { address: from, minBlockNumber: 110n, network, rpcEndpoint: network.rpcEndpoint };
    await expect(asset === "native" ? getEvmNativeBalance(options) : getEvmTokenBalance({ ...options, tokenAddress }))
      .rejects.toThrow("RPC 尚未同步至交易确认区块");
    expect(mocks.getBalance).not.toHaveBeenCalled();
    expect(mocks.readContract).not.toHaveBeenCalled();
  });
});
