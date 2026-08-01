import {
  encodeEventTopics,
  type Hex,
  type TransactionReceipt
} from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EvmWalletProvider } from "../hooks/useEvmWallet";

const clientMocks = vi.hoisted(() => ({
  createEvmPublicClient: vi.fn(),
  createPublicClient: vi.fn(),
  createWalletClient: vi.fn(),
  ensureEvmNetwork: vi.fn()
}));

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  const createXRuntimeHash = "0xbd8a7ea8cfca7b4e5f5041d7d4b17bc317c5ce42cfbc42066a00cf26b43eb53f";

  return {
    ...actual,
    createPublicClient: clientMocks.createPublicClient,
    createWalletClient: clientMocks.createWalletClient,
    custom: vi.fn((provider) => provider),
    keccak256: vi.fn((value: Hex) => {
      // The CreateX runtime is intentionally not bundled with the app. These two
      // Sentinel used by the flow tests to model the pinned CreateX runtime.
      if (value === "0xc0de") return createXRuntimeHash;
      return actual.keccak256(value);
    })
  };
});

vi.mock("./evm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./evm")>();
  return {
    ...actual,
    createEvmPublicClient: clientMocks.createEvmPublicClient,
    ensureEvmNetwork: clientMocks.ensureEvmNetwork
  };
});

import {
  createXContractAddress,
  deployDisperseContract,
  disperseContractGuardedSalt,
  getDisperseDeploymentArtifacts,
  resolveDisperseDeploymentNetwork,
  runDisperseDeploymentValidation,
  type DisperseDeploymentCheck,
  type DisperseDeploymentStage
} from "./createx";
import { disperseContractAddress, type EvmChainConfig } from "./evm";

const account = "0x1111111111111111111111111111111111111111";
const rpcEndpoint = "https://rpc.example.test";
const transactionHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const blockHash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const factoryRuntime = "0xc0de" as const;
const testNetwork: EvmChainConfig = {
  blockExplorerUrl: "https://sepolia.basescan.org",
  chainId: 84532,
  label: "Base Sepolia",
  nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
  rpcEndpoint
};

type HarnessOptions = {
  balance?: bigint;
  estimatedGas?: bigint;
  feeMode?: "eip1559" | "legacy";
  gasPrice?: bigint;
  initialTargetCode?: Hex;
  postTargetCode?: Hex;
  receipt?: TransactionReceipt;
  rpcFactoryCode?: Hex;
  signingAccount?: string;
  signingChainId?: number;
};

function makeContractCreationLog() {
  return {
    address: createXContractAddress,
    blockHash,
    blockNumber: 1n,
    data: "0x" as const,
    logIndex: 0,
    removed: false,
    topics: encodeEventTopics({
      abi: [
        {
          anonymous: false,
          inputs: [
            { indexed: true, name: "newContract", type: "address" },
            { indexed: true, name: "salt", type: "bytes32" }
          ],
          name: "ContractCreation",
          type: "event"
        }
      ],
      args: {
        newContract: disperseContractAddress,
        salt: disperseContractGuardedSalt
      },
      eventName: "ContractCreation"
    }) as [Hex, ...Hex[]],
    transactionHash,
    transactionIndex: 0
  };
}

function makeReceipt(logs: TransactionReceipt["logs"] = [makeContractCreationLog()]) {
  return {
    blockHash,
    blockNumber: 1n,
    contractAddress: null,
    cumulativeGasUsed: 441_622n,
    effectiveGasPrice: 1_000_000_000n,
    from: account,
    gasUsed: 441_622n,
    logs,
    logsBloom: `0x${"0".repeat(512)}`,
    status: "success",
    to: createXContractAddress,
    transactionHash,
    transactionIndex: 0,
    type: "eip1559"
  } as TransactionReceipt;
}

function makeHarness(options: HarnessOptions = {}) {
  const network = testNetwork;
  const runtimeCode = getDisperseDeploymentArtifacts().runtimeCode;
  let transactionSubmitted = false;
  const receipt = options.receipt || makeReceipt();

  const codeFor = (address: string) => {
    if (address.toLowerCase() === createXContractAddress.toLowerCase()) {
      return options.rpcFactoryCode || factoryRuntime;
    }
    if (address.toLowerCase() === disperseContractAddress.toLowerCase()) {
      if (!transactionSubmitted) return options.initialTargetCode ?? "0x";
      return options.postTargetCode ?? runtimeCode;
    }
    throw new Error(`unexpected code lookup: ${address}`);
  };

  const httpClient = {
    estimateContractGas: vi.fn().mockResolvedValue(options.estimatedGas ?? 500_000n),
    estimateFeesPerGas: vi.fn().mockResolvedValue(options.feeMode === "legacy"
      ? { gasPrice: options.gasPrice ?? 1_000_000_000n }
      : {
          maxFeePerGas: options.gasPrice ?? 1_000_000_000n,
          maxPriorityFeePerGas: 100_000_000n
        }),
    getBalance: vi.fn().mockResolvedValue(options.balance ?? 1_000_000_000_000_000n),
    getChainId: vi.fn().mockResolvedValue(network.chainId),
    getCode: vi.fn(async ({ address }: { address: string }) => codeFor(address)),
    getGasPrice: vi.fn().mockResolvedValue(options.gasPrice ?? 1_000_000_000n),
    readContract: vi.fn().mockResolvedValue(disperseContractAddress),
    simulateContract: vi.fn().mockResolvedValue({ result: disperseContractAddress }),
    waitForTransactionReceipt: vi.fn().mockResolvedValue(receipt)
  };
  const walletClient = {
    writeContract: vi.fn(async (_request: Record<string, unknown>) => {
      transactionSubmitted = true;
      return transactionHash;
    })
  };
  let chainIdRequests = 0;
  const provider: EvmWalletProvider = {
    request: vi.fn(async ({ method }) => {
      if (method === "eth_chainId") {
        chainIdRequests += 1;
        const chainId = chainIdRequests > 1 ? options.signingChainId ?? network.chainId : network.chainId;
        return `0x${chainId.toString(16)}`;
      }
      if (method === "eth_accounts") return [options.signingAccount ?? account];
      throw new Error(`unexpected provider request: ${method}`);
    })
  };

  clientMocks.createEvmPublicClient.mockReturnValue(httpClient);
  clientMocks.createPublicClient.mockReturnValue(httpClient);
  clientMocks.createWalletClient.mockReturnValue(walletClient);
  clientMocks.ensureEvmNetwork.mockResolvedValue(undefined);

  return { httpClient, network, provider, walletClient };
}

function findCheck(checks: DisperseDeploymentCheck[], id: DisperseDeploymentCheck["id"]) {
  return checks.find((check) => check.id === id);
}

describe("runDisperseDeploymentValidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ready after the RPC passes bytecode, simulation, and balance checks", async () => {
    const harness = makeHarness();
    const snapshots: DisperseDeploymentCheck[][] = [];

    const result = await runDisperseDeploymentValidation({
      account,
      network: harness.network,
      onChecks: (checks) => snapshots.push(checks),
      provider: harness.provider,
      rpcEndpoint
    });

    expect(result).toMatchObject({
      estimatedFee: 600_000_000_000_000n,
      estimatedGas: 500_000n,
      feeCapPerGas: 1_000_000_000n,
      feeParameters: {
        maxFeePerGas: 1_000_000_000n,
        maxPriorityFeePerGas: 100_000_000n,
        type: "eip1559"
      },
      gasLimit: 600_000n,
      status: "ready",
      targetState: "absent"
    });
    expect(result.checks.map(({ id, status }) => [id, status])).toEqual([
      ["artifacts", "pass"],
      ["rpc", "pass"],
      ["wallet", "pass"],
      ["factory", "pass"],
      ["address", "pass"],
      ["target", "pass"],
      ["simulation", "pass"],
      ["balance", "pass"]
    ]);
    expect(harness.httpClient.simulateContract).toHaveBeenCalledOnce();
    expect(snapshots.at(-1)).toEqual(result.checks);
  });

  it("derives the network from the RPC without a network preset", async () => {
    const harness = makeHarness();

    const network = await resolveDisperseDeploymentNetwork(rpcEndpoint);

    expect(network).toMatchObject({
      chainId: harness.network.chainId,
      label: harness.network.label,
      rpcEndpoint
    });
  });

  it("returns already-deployed only when the existing runtime hash matches", async () => {
    const runtimeCode = getDisperseDeploymentArtifacts().runtimeCode;
    const harness = makeHarness({ initialTargetCode: runtimeCode });

    const result = await runDisperseDeploymentValidation({
      account,
      network: harness.network,
      provider: harness.provider,
      rpcEndpoint
    });

    expect(result).toMatchObject({ status: "already-deployed", targetState: "expected" });
    expect(findCheck(result.checks, "target")).toMatchObject({ status: "pass" });
    expect(findCheck(result.checks, "simulation")).toMatchObject({ status: "skipped" });
    expect(harness.httpClient.simulateContract).not.toHaveBeenCalled();
  });

  it("blocks deployment when the target address contains different bytecode", async () => {
    const harness = makeHarness({ initialTargetCode: "0x00" });

    await expect(runDisperseDeploymentValidation({
      account,
      network: harness.network,
      provider: harness.provider,
      rpcEndpoint
    })).rejects.toMatchObject({
      message: "目标地址已有其他字节码，官方 runtime hash 不匹配，已永久阻止部署",
      name: "DisperseDeploymentValidationError"
    });

    expect(harness.httpClient.simulateContract).not.toHaveBeenCalled();
  });

  it("blocks when the wallet balance is below the estimated deployment fee", async () => {
    const harness = makeHarness({ balance: 599_999_999_999_999n });
    const snapshots: DisperseDeploymentCheck[][] = [];

    await expect(runDisperseDeploymentValidation({
      account,
      network: harness.network,
      onChecks: (checks) => snapshots.push(checks),
      provider: harness.provider,
      rpcEndpoint
    })).rejects.toMatchObject({
      message: expect.stringContaining("至少需要"),
      name: "DisperseDeploymentValidationError"
    });

    expect(findCheck(snapshots.at(-1) || [], "simulation")).toMatchObject({ status: "pass" });
    expect(findCheck(snapshots.at(-1) || [], "balance")).toMatchObject({ status: "fail" });
  });

  it("uses the EIP-1559 fee cap with a 20 percent gas buffer", async () => {
    const harness = makeHarness({ balance: 2_000_000_000_000_000n });
    harness.httpClient.estimateContractGas.mockResolvedValue(550_000n);
    harness.httpClient.estimateFeesPerGas.mockResolvedValue({
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 200_000_000n
    });

    const result = await runDisperseDeploymentValidation({
      account,
      network: harness.network,
      provider: harness.provider,
      rpcEndpoint
    });

    expect(result).toMatchObject({
      estimatedFee: 1_320_000_000_000_000n,
      estimatedGas: 550_000n,
      feeCapPerGas: 2_000_000_000n,
      feeParameters: {
        maxFeePerGas: 2_000_000_000n,
        maxPriorityFeePerGas: 200_000_000n,
        type: "eip1559"
      },
      gasLimit: 660_000n,
      status: "ready"
    });
  });
});

describe("deployDisperseContract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes the exact zero-value call and verifies matching receipts and deployed runtime", async () => {
    const harness = makeHarness();
    const stages: DisperseDeploymentStage[] = [];

    const result = await deployDisperseContract({
      account,
      network: harness.network,
      onStage: (stage) => stages.push(stage),
      provider: harness.provider,
      rpcEndpoint
    });

    expect(result.alreadyDeployed).toBe(false);
    expect(result.hash).toBe(transactionHash);
    expect(harness.walletClient.writeContract).toHaveBeenCalledWith(expect.objectContaining({
      account,
      address: createXContractAddress,
      functionName: "deployCreate2",
      gas: 600_000n,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 100_000_000n,
      value: 0n
    }));
    expect(stages.map((stage) => stage.type)).toEqual([
      "awaiting-wallet",
      "submitted",
      "confirmed",
      "verified"
    ]);
    expect(stages[0]).toMatchObject({
      preflight: {
        feeCapPerGas: 1_000_000_000n,
        gasLimit: 600_000n
      }
    });
    expect(findCheck(result.preflight.checks, "receipt")).toMatchObject({ status: "pass" });
    expect(findCheck(result.preflight.checks, "runtime")).toMatchObject({ status: "pass" });
  });

  it("binds the buffered gas limit and legacy gas price to the wallet request", async () => {
    const harness = makeHarness({
      balance: 2_000_000_000_000_000n,
      feeMode: "legacy",
      gasPrice: 3_000_000_000n
    });

    await deployDisperseContract({
      account,
      network: harness.network,
      provider: harness.provider,
      rpcEndpoint
    });

    expect(harness.walletClient.writeContract).toHaveBeenCalledWith(expect.objectContaining({
      gas: 600_000n,
      gasPrice: 3_000_000_000n
    }));
    expect(harness.walletClient.writeContract.mock.calls[0][0]).not.toHaveProperty("maxFeePerGas");
  });

  it("does not request a signature after the page invalidates the deployment context", async () => {
    const harness = makeHarness();
    let contextIsCurrent = true;

    await expect(deployDisperseContract({
      account,
      network: harness.network,
      onChecks: (checks) => {
        if (findCheck(checks, "balance")?.status === "pass") contextIsCurrent = false;
      },
      provider: harness.provider,
      rpcEndpoint,
      shouldContinue: () => contextIsCurrent
    })).rejects.toMatchObject({
      message: "钱包、网络或 RPC 已改变，已取消本次部署签名",
      name: "DisperseDeploymentValidationError"
    });

    expect(harness.walletClient.writeContract).not.toHaveBeenCalled();
  });

  it.each([
    ["account", { signingAccount: "0x2222222222222222222222222222222222222222" }],
    ["chain", { signingChainId: 1 }]
  ] as const)("does not request a signature when the wallet %s changes after preflight", async (_label, options) => {
    const harness = makeHarness(options);

    await expect(deployDisperseContract({
      account,
      network: harness.network,
      provider: harness.provider,
      rpcEndpoint
    })).rejects.toMatchObject({
      message: "签名前钱包的账户或网络已改变，请重新校验",
      name: "DisperseDeploymentValidationError"
    });

    expect(harness.walletClient.writeContract).not.toHaveBeenCalled();
  });

  it("rejects a successful receipt that lacks the exact CreateX creation event", async () => {
    const harness = makeHarness({ receipt: makeReceipt([]) });
    const stages: DisperseDeploymentStage[] = [];

    await expect(deployDisperseContract({
      account,
      network: harness.network,
      onStage: (stage) => stages.push(stage),
      provider: harness.provider,
      rpcEndpoint
    })).rejects.toMatchObject({
      message: "CreateX ContractCreation 事件中的目标地址或 guarded salt 不匹配",
      name: "DisperseDeploymentValidationError"
    });

    expect(stages.map((stage) => stage.type)).toEqual(["awaiting-wallet", "submitted"]);
  });

  it("rejects a confirmed deployment when the post-transaction runtime hash differs", async () => {
    const harness = makeHarness({ postTargetCode: "0x00" });
    const snapshots: DisperseDeploymentCheck[][] = [];
    const stages: DisperseDeploymentStage[] = [];

    await expect(deployDisperseContract({
      account,
      network: harness.network,
      onChecks: (checks) => snapshots.push(checks),
      onStage: (stage) => stages.push(stage),
      provider: harness.provider,
      rpcEndpoint
    })).rejects.toMatchObject({
      message: "交易成功，但部署后的官方 runtime hash 校验未通过",
      name: "DisperseDeploymentValidationError"
    });

    expect(stages.map((stage) => stage.type)).toEqual(["awaiting-wallet", "submitted", "confirmed"]);
    expect(findCheck(snapshots.at(-1) || [], "receipt")).toMatchObject({ status: "pass" });
    expect(findCheck(snapshots.at(-1) || [], "runtime")).toMatchObject({ status: "fail" });
  });
});
