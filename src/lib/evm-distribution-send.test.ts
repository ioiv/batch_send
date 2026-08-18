import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EvmWalletProvider } from "../hooks/useEvmWallet";

const clientMocks = vi.hoisted(() => ({
  createPublicClient: vi.fn(),
  createWalletClient: vi.fn()
}));

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: clientMocks.createPublicClient,
    createWalletClient: clientMocks.createWalletClient,
    keccak256: vi.fn(() => "0xc0a38c227d2c70248fc51ed0dd3a72df3adf5b41494c7f3cc19c16c38523244d")
  };
});

import {
  assertEvmWalletContext,
  evmNetworks,
  sendEvmNativeDistribution,
  sendEvmTokenDistribution,
  type EvmDistributionPreflightResult,
  type EvmDistributionRow,
  type EvmTokenDistributionStep
} from "./evm";

const account = "0x00000000000000000000000000000000000000aa";
const checksummedAccount = "0x00000000000000000000000000000000000000AA";
const otherAccount = "0x00000000000000000000000000000000000000bb";
const recipient = "0x0000000000000000000000000000000000000002";
const tokenAddress = "0x0000000000000000000000000000000000000003";
const approvalHash = `0x${"a".repeat(64)}` as const;
const distributionHash = `0x${"b".repeat(64)}` as const;
const network = evmNetworks[0];
const rows: EvmDistributionRow[] = [{
  address: recipient,
  amountRaw: "0.0000000000000001",
  line: 1,
  problems: [],
  status: "valid",
  valueWei: 100n
}];
const token = {
  address: tokenAddress,
  decimals: 6,
  name: "Test Token",
  symbol: "TEST"
} as const;

function makeProvider({
  activeAccount = account,
  chainId = network.chainId
}: {
  activeAccount?: string;
  chainId?: number;
} = {}) {
  return {
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method === "eth_accounts") return [activeAccount];
      if (method === "eth_chainId") return `0x${chainId.toString(16)}`;
      throw new Error(`unexpected provider request: ${method}`);
    })
  } as unknown as EvmWalletProvider;
}

function makeHarness({
  allowance = 0n,
  tokenBalance = 1_000n
}: {
  allowance?: bigint;
  tokenBalance?: bigint;
} = {}) {
  const rpcClient = {
    getBalance: vi.fn().mockResolvedValue(1_000_000n),
    getChainId: vi.fn().mockResolvedValue(network.chainId),
    getCode: vi.fn().mockResolvedValue("0x1234"),
    readContract: vi.fn(({ functionName }: { functionName: string }) => {
      if (functionName === "balanceOf") return Promise.resolve(tokenBalance);
      if (functionName === "allowance") return Promise.resolve(allowance);
      throw new Error(`unexpected contract read: ${functionName}`);
    }),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "success" })
  };
  const walletClient = {
    writeContract: vi.fn()
      .mockResolvedValueOnce(approvalHash)
      .mockResolvedValueOnce(distributionHash)
  };

  clientMocks.createPublicClient.mockReturnValue(rpcClient);
  clientMocks.createWalletClient.mockReturnValue(walletClient);

  return { rpcClient, walletClient };
}

function successfulFreshPreflight(): EvmDistributionPreflightResult {
  return {
    assetBalanceWei: 1_000n,
    estimatedNetworkFeeWei: 100n,
    feeEstimateBasis: "rpc",
    nativeBalanceWei: 1_000n,
    needsApproval: false,
    requiredNativeWei: 100n,
    totalTransactions: 1
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("assertEvmWalletContext", () => {
  it("accepts the provider preferred account case-insensitively on the selected chain", async () => {
    const provider = makeProvider({ activeAccount: account.toUpperCase().replace("0X", "0x") });

    await expect(assertEvmWalletContext({ account, network, provider })).resolves.toBeUndefined();
    expect(provider.request).toHaveBeenCalledWith({ method: "eth_accounts" });
    expect(provider.request).toHaveBeenCalledWith({ method: "eth_chainId" });
  });

  it.each([
    ["preferred account", { activeAccount: otherAccount }],
    ["chain", { chainId: network.chainId + 1 }]
  ])("rejects a changed provider %s", async (_label, providerOptions) => {
    const provider = makeProvider(providerOptions);

    await expect(assertEvmWalletContext({ account, network, provider }))
      .rejects.toThrow("签名前钱包的账户或网络已改变，请重新预检");
  });
});

describe("EVM distribution signing gates", () => {
  it("blocks a native write when the provider preferred account changed", async () => {
    const { walletClient } = makeHarness();
    const provider = makeProvider({ activeAccount: otherAccount });

    await expect(sendEvmNativeDistribution({
      from: account,
      network,
      provider,
      rows,
      rpcEndpoint: network.rpcEndpoint
    })).rejects.toThrow("签名前钱包的账户或网络已改变，请重新预检");

    expect(walletClient.writeContract).not.toHaveBeenCalled();
  });

  it("blocks a token write when the provider chain changed", async () => {
    const { walletClient } = makeHarness({ allowance: 1_000n });
    const provider = makeProvider({ chainId: network.chainId + 1 });

    await expect(sendEvmTokenDistribution({
      from: account,
      network,
      provider,
      rows,
      rpcEndpoint: network.rpcEndpoint,
      token
    })).rejects.toThrow("签名前钱包的账户或网络已改变，请重新预检");

    expect(walletClient.writeContract).not.toHaveBeenCalled();
  });
});

describe("sendEvmTokenDistribution post-approval preflight", () => {
  it("stops after a confirmed approval when the preferred account changes", async () => {
    const { walletClient } = makeHarness();
    const assertWalletContext = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("签名前钱包的账户或网络已改变，请重新预检"));
    const postApprovalPreflight = vi.fn().mockResolvedValue(successfulFreshPreflight());
    const steps: EvmTokenDistributionStep[] = [];

    await expect(sendEvmTokenDistribution({
      assertWalletContext,
      from: account,
      network,
      onStep: (step) => steps.push(step),
      postApprovalPreflight,
      provider: makeProvider(),
      rows,
      rpcEndpoint: network.rpcEndpoint,
      token
    })).rejects.toThrow("签名前钱包的账户或网络已改变，请重新预检");

    expect(assertWalletContext).toHaveBeenCalledTimes(2);
    expect(walletClient.writeContract).toHaveBeenCalledOnce();
    expect(walletClient.writeContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: "approve"
    }));
    expect(postApprovalPreflight).not.toHaveBeenCalled();
    expect(steps.map((step) => step.type)).toEqual([
      "allowance-checked",
      "approval-submitted",
      "approval-confirmed"
    ]);
    expect(steps).toContainEqual({
      hash: approvalHash,
      totalTransactions: 2,
      type: "approval-confirmed"
    });
    expect(steps.some((step) => step.type === "distribution-submitted")).toBe(false);
  });

  it.each([
    ["token balance", new Error("Token 余额不足：授权后余额已变化")],
    ["native gas balance", new Error("原生币余额不足以支付预估网络费")],
    ["RPC preflight", new Error("RPC 请求失败")]
  ])("does not submit distribution when the fresh %s check fails", async (_label, failure) => {
    const { walletClient } = makeHarness();
    const assertWalletContext = vi.fn().mockResolvedValue(undefined);
    const postApprovalPreflight = vi.fn().mockRejectedValue(failure);
    const steps: EvmTokenDistributionStep[] = [];

    await expect(sendEvmTokenDistribution({
      assertWalletContext,
      from: account,
      network,
      onStep: (step) => steps.push(step),
      postApprovalPreflight,
      provider: makeProvider(),
      rows,
      rpcEndpoint: network.rpcEndpoint,
      token
    })).rejects.toThrow(failure.message);

    expect(walletClient.writeContract).toHaveBeenCalledOnce();
    expect(postApprovalPreflight).toHaveBeenCalledWith({
      assetMode: "token",
      from: checksummedAccount,
      network,
      rows,
      rpcEndpoint: network.rpcEndpoint,
      token
    });
    expect(steps.map((step) => step.type)).toEqual([
      "allowance-checked",
      "approval-submitted",
      "approval-confirmed"
    ]);
    expect(steps).toContainEqual({
      hash: approvalHash,
      totalTransactions: 2,
      type: "approval-confirmed"
    });
  });

  it("does not submit distribution when allowance is still insufficient after approval", async () => {
    const { walletClient } = makeHarness();
    const postApprovalPreflight = vi.fn().mockResolvedValue({
      ...successfulFreshPreflight(),
      needsApproval: true,
      totalTransactions: 2
    });
    const steps: EvmTokenDistributionStep[] = [];

    await expect(sendEvmTokenDistribution({
      assertWalletContext: vi.fn().mockResolvedValue(undefined),
      from: account,
      network,
      onStep: (step) => steps.push(step),
      postApprovalPreflight,
      provider: makeProvider(),
      rows,
      rpcEndpoint: network.rpcEndpoint,
      token
    })).rejects.toThrow("Token 授权后复检未通过：授权额度仍不足");

    expect(walletClient.writeContract).toHaveBeenCalledOnce();
    expect(steps.map((step) => step.type)).toEqual([
      "allowance-checked",
      "approval-submitted",
      "approval-confirmed"
    ]);
  });

  it("continues to distribution only after the fresh preflight and final wallet gate pass", async () => {
    const { walletClient } = makeHarness();
    const assertWalletContext = vi.fn().mockResolvedValue(undefined);
    const postApprovalPreflight = vi.fn().mockResolvedValue(successfulFreshPreflight());
    const steps: EvmTokenDistributionStep[] = [];

    const result = await sendEvmTokenDistribution({
      assertWalletContext,
      from: account,
      network,
      onStep: (step) => steps.push(step),
      postApprovalPreflight,
      provider: makeProvider(),
      rows,
      rpcEndpoint: network.rpcEndpoint,
      token
    });

    expect(assertWalletContext).toHaveBeenCalledTimes(3);
    expect(postApprovalPreflight).toHaveBeenCalledOnce();
    expect(walletClient.writeContract).toHaveBeenCalledTimes(2);
    expect(walletClient.writeContract).toHaveBeenNthCalledWith(1, expect.objectContaining({
      functionName: "approve"
    }));
    expect(walletClient.writeContract).toHaveBeenNthCalledWith(2, expect.objectContaining({
      functionName: "disperseToken"
    }));
    expect(steps.map((step) => step.type)).toEqual([
      "allowance-checked",
      "approval-submitted",
      "approval-confirmed",
      "distribution-submitted",
      "distribution-confirmed"
    ]);
    expect(result.hashes).toEqual([approvalHash, distributionHash]);
  });
});
