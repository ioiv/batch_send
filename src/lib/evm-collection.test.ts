import { describe, expect, it, vi } from "vitest";
import { getAddress, type Address, type Hash, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import {
  deriveEvmCollectionAddress,
  executeEvmCollectionPlan,
  maximumEvmCollectionAssetInputEntries,
  maximumEvmCollectionInputCharacters,
  maximumEvmCollectionInputIssues,
  maximumEvmCollectionInputLines,
  maximumEvmPrivateKeyInputEntries,
  maximumEvmTokenId,
  maximumEvmTokenIdDigits,
  normalizeEvmCollectionError,
  parseEvmCollectionAssets,
  parseEvmPrivateKeyInput,
  planEvmCollection,
  preflightEvmCollectionPlan,
  readErc20Metadata,
  type EvmCollectionAccount,
  type EvmCollectionPlanItem,
  type EvmCollectionPublicClient,
  type EvmCollectionWalletClient
} from "./evm-collection";

const privateKeyOne = `0x${"0".repeat(63)}1` as Hex;
const privateKeyTwo = `0x${"0".repeat(63)}2` as Hex;
const privateKeyThree = `0x${"0".repeat(63)}3` as Hex;
const tokenAddress = "0x00000000000000000000000000000000000000a1";
const nftAddress = "0x00000000000000000000000000000000000000b2";
const targetAddress = "0x00000000000000000000000000000000000000c3";
const externalOwner = "0x00000000000000000000000000000000000000d4";
const transactionHash = `0x${"a".repeat(64)}` as Hash;
const maxFeePerTransactionWei = 10_000n;

type ContractParameters = {
  address: Address;
  args?: readonly unknown[];
  functionName: string;
};

function makePublicClient(options: {
  estimateGas?: () => Promise<bigint>;
  getBalance?: () => Promise<bigint>;
  getGasPrice?: () => Promise<bigint>;
  readContract?: (parameters: ContractParameters) => Promise<unknown>;
  simulateContract?: (parameters: ContractParameters) => Promise<{ request: unknown; result?: unknown }>;
  waitForTransactionReceipt?: (parameters: { hash: Hash }) => Promise<{ status: string }>;
} = {}) {
  const estimateGas = vi.fn(options.estimateGas || (async () => 100n));
  const getBalance = vi.fn(options.getBalance || (async () => 1_000_000n));
  const getGasPrice = vi.fn(options.getGasPrice || (async () => 10n));
  const readContract = vi.fn(options.readContract || (async () => 0n));
  const simulateContract = vi.fn(options.simulateContract || (async (parameters: ContractParameters) => ({
    request: { prepared: true },
    result: parameters.functionName === "transfer" ? true : undefined
  })));
  const waitForTransactionReceipt = vi.fn(
    options.waitForTransactionReceipt || (async () => ({ status: "success" }))
  );
  const client = {
    estimateGas,
    getBalance,
    getGasPrice,
    readContract,
    simulateContract,
    waitForTransactionReceipt
  } as unknown as EvmCollectionPublicClient;
  return {
    client,
    estimateGas,
    getBalance,
    getGasPrice,
    readContract,
    simulateContract,
    waitForTransactionReceipt
  };
}

function makeWalletClient(write?: (request: unknown) => Promise<Hash>) {
  const writeContract = vi.fn(write || (async () => transactionHash));
  const client = { writeContract } as unknown as EvmCollectionWalletClient;
  return { client, writeContract };
}

function parseAccounts(keys = [privateKeyOne, privateKeyTwo, privateKeyThree]) {
  return parseEvmPrivateKeyInput(keys.map((key, index) => `来源 ${index + 1},${key}`).join("\n")).accounts;
}

function getSingleAsset(input: string, standard: "erc20" | "erc721" | "erc1155") {
  const parsed = parseEvmCollectionAssets(input, standard);
  expect(parsed.invalid).toBe(0);
  expect(parsed.assets).toHaveLength(1);
  return parsed.assets[0];
}

describe("parseEvmPrivateKeyInput", () => {
  it("accepts bare and labelled private-key rows and derives public addresses", () => {
    const parsed = parseEvmPrivateKeyInput(`${privateKeyOne}\n主钱包, ${privateKeyTwo}`);

    expect(parsed.invalid).toBe(0);
    expect(parsed.duplicates).toBe(0);
    expect(parsed.accounts).toHaveLength(2);
    expect(parsed.accounts.map((item) => item.label)).toEqual(["钱包 1", "主钱包"]);
    expect(parsed.accounts.map((item) => item.address)).toEqual([
      deriveEvmCollectionAddress(privateKeyOne),
      deriveEvmCollectionAddress(privateKeyTwo)
    ]);
    expect(parsed.rows.map((item) => item.status)).toEqual(["valid", "valid"]);
  });

  it("deduplicates by derived address and preserves the first signer", () => {
    const parsed = parseEvmPrivateKeyInput(`第一个,${privateKeyOne}\n重复项,${privateKeyOne}`);

    expect(parsed.accounts).toHaveLength(1);
    expect(parsed.accounts[0].label).toBe("第一个");
    expect(parsed.duplicates).toBe(1);
    expect(parsed.invalid).toBe(0);
    expect(parsed.rows[1]).toMatchObject({ status: "duplicate" });
  });

  it("never echoes key material in rows, labels, issues, or thrown errors", () => {
    const maliciousDeriver = vi.fn((_key: Hex) => {
      throw new Error(`derivation failed for ${privateKeyOne}`);
    });
    const parsed = parseEvmPrivateKeyInput(`${privateKeyOne},${privateKeyTwo}\n标签,${privateKeyOne}`, {
      deriveAccount: maliciousDeriver
    });
    const serialized = JSON.stringify(parsed);

    expect(parsed.invalid).toBe(2);
    expect(serialized).not.toContain(privateKeyOne);
    expect(serialized).not.toContain(privateKeyTwo);
    expect(serialized).toContain("已隐藏敏感内容");
    expect(() => deriveEvmCollectionAddress(privateKeyOne, maliciousDeriver)).toThrow("无法从该私钥派生地址");
    expect(() => deriveEvmCollectionAddress(privateKeyOne, maliciousDeriver)).not.toThrow(privateKeyOne);
  });

  it("rejects malformed, short, and cryptographically invalid keys without exposing input", () => {
    const zeroKey = `0x${"0".repeat(64)}`;
    const parsed = parseEvmPrivateKeyInput(`bad,row,shape\nshort,0x1234\nzero,${zeroKey}`);

    expect(parsed.accounts).toHaveLength(0);
    expect(parsed.invalid).toBe(3);
    expect(parsed.issues.map((issue) => issue.code)).toEqual([
      "invalid-format",
      "invalid-private-key",
      "invalid-private-key"
    ]);
    expect(JSON.stringify(parsed)).not.toContain(zeroKey);
  });

  it("rejects oversized key sets before deriving any account", () => {
    const deriveAccount = vi.fn(() => {
      throw new Error("the preflight limit should run first");
    });
    const input = Array.from(
      { length: maximumEvmPrivateKeyInputEntries + 1 },
      () => privateKeyOne
    ).join("\n");

    const parsed = parseEvmPrivateKeyInput(input, { deriveAccount });

    expect(deriveAccount).not.toHaveBeenCalled();
    expect(parsed.accounts).toHaveLength(0);
    expect(parsed.invalid).toBe(1);
    expect(parsed.issues).toEqual([
      expect.objectContaining({ code: "input-limit", line: maximumEvmPrivateKeyInputEntries + 1 })
    ]);
    expect(JSON.stringify(parsed)).not.toContain(privateKeyOne);
  });

  it("bounds private-key input characters, physical lines, and retained issues", () => {
    const tooLong = parseEvmPrivateKeyInput(
      `${privateKeyOne}${"x".repeat(maximumEvmCollectionInputCharacters)}`
    );
    const tooManyLines = parseEvmPrivateKeyInput(
      `${privateKeyOne}${"\n".repeat(maximumEvmCollectionInputLines)}`
    );
    const invalidRows = parseEvmPrivateKeyInput(
      Array.from({ length: maximumEvmCollectionInputIssues + 1 }, (_, index) => `wallet-${index},0x1`).join("\n")
    );

    expect(tooLong.issues).toEqual([expect.objectContaining({ code: "input-limit" })]);
    expect(tooManyLines.issues).toEqual([
      expect.objectContaining({ code: "input-limit", line: maximumEvmCollectionInputLines + 1 })
    ]);
    expect(invalidRows.invalid).toBe(maximumEvmCollectionInputIssues + 1);
    expect(invalidRows.issues).toHaveLength(maximumEvmCollectionInputIssues);
    expect(invalidRows.rows).toHaveLength(maximumEvmCollectionInputIssues);
  });
});

describe("normalizeEvmCollectionError", () => {
  it("redacts embedded private keys from viem-style short messages", () => {
    const normalized = normalizeEvmCollectionError({
      message: "long fallback",
      shortMessage: `RPC rejected account secret ${privateKeyOne}`
    }, "fallback", "submission-failed");

    expect(normalized.code).toBe("submission-failed");
    expect(normalized.message).toBe("RPC rejected account secret [已隐藏敏感内容]");
    expect(normalized.message).not.toContain(privateKeyOne);
  });

  it("redacts RPC endpoints that may contain provider credentials", () => {
    const rpcEndpoint = "https://mainnet.example.test/v2/private-provider-key";
    const normalized = normalizeEvmCollectionError(new Error(`request failed at ${rpcEndpoint}`));

    expect(normalized.message).toBe("request failed at [RPC 地址已隐藏]");
    expect(normalized.message).not.toContain("private-provider-key");
  });
});

describe("parseEvmCollectionAssets", () => {
  it("parses and deduplicates ERC20 contract rows case-insensitively", () => {
    const parsed = parseEvmCollectionAssets(`${tokenAddress}\n${tokenAddress.toUpperCase().replace("0X", "0x")}`, "erc20");

    expect(parsed.assets).toHaveLength(1);
    expect(parsed.duplicates).toBe(1);
    expect(parsed.invalid).toBe(0);
    expect(parsed.rows.map((row) => row.status)).toEqual(["valid", "duplicate"]);
  });

  it("parses ERC721 and ERC1155 contract,Token ID rows as exact bigint IDs", () => {
    const erc721 = parseEvmCollectionAssets(`${nftAddress},0\n${nftAddress},9007199254740993`, "erc721");
    const erc1155 = parseEvmCollectionAssets(`${nftAddress},42`, "erc1155");

    expect(erc721.assets.map((asset) => "tokenId" in asset ? asset.tokenId : null)).toEqual([
      0n,
      9_007_199_254_740_993n
    ]);
    expect(erc1155.assets[0]).toMatchObject({ standard: "erc1155", tokenId: 42n });
  });

  it("rejects malformed addresses, missing IDs, negative IDs, and ERC20 extra columns", () => {
    const nft = parseEvmCollectionAssets(`bad,1\n${nftAddress}\n${nftAddress},-1`, "erc721");
    const erc20 = parseEvmCollectionAssets(`${tokenAddress},1`, "erc20");

    expect(nft.invalid).toBe(3);
    expect(nft.rows.flatMap((row) => row.problems)).toEqual(expect.arrayContaining([
      "合约地址格式不正确",
      "NFT 每行格式应为 合约地址,Token ID",
      "Token ID 必须是非负十进制整数"
    ]));
    expect(erc20.invalid).toBe(1);
  });

  it("accepts the maximum uint256 token ID and rejects larger or overlong IDs", () => {
    const maximum = parseEvmCollectionAssets(`${nftAddress},${maximumEvmTokenId}`, "erc721");
    const overflow = parseEvmCollectionAssets(`${nftAddress},${maximumEvmTokenId + 1n}`, "erc721");
    const overlong = parseEvmCollectionAssets(
      `${nftAddress},${"9".repeat(maximumEvmTokenIdDigits + 1)}`,
      "erc1155"
    );

    expect(maximum.assets[0]).toMatchObject({ tokenId: maximumEvmTokenId });
    expect(overflow).toMatchObject({ assets: [], invalid: 1 });
    expect(overlong).toMatchObject({ assets: [], invalid: 1 });
    expect(overflow.rows[0].problems).toContain("Token ID 超出 uint256 范围");
    expect(overlong.rows[0].problems).toContain("Token ID 超出 uint256 范围");
  });

  it("bounds asset entries, characters, and retained invalid rows", () => {
    const tooManyEntries = parseEvmCollectionAssets(
      Array.from({ length: maximumEvmCollectionAssetInputEntries + 1 }, () => tokenAddress).join("\n"),
      "erc20"
    );
    const tooLong = parseEvmCollectionAssets(
      `${tokenAddress}${"x".repeat(maximumEvmCollectionInputCharacters)}`,
      "erc20"
    );
    const invalidRows = parseEvmCollectionAssets(
      Array.from({ length: maximumEvmCollectionInputIssues + 1 }, () => "not-an-address").join("\n"),
      "erc20"
    );

    expect(tooManyEntries).toMatchObject({ assets: [], invalid: 1 });
    expect(tooManyEntries.rows[0]).toMatchObject({
      line: maximumEvmCollectionAssetInputEntries + 1,
      status: "invalid"
    });
    expect(tooLong).toMatchObject({ assets: [], invalid: 1 });
    expect(invalidRows.invalid).toBe(maximumEvmCollectionInputIssues + 1);
    expect(invalidRows.rows).toHaveLength(maximumEvmCollectionInputIssues);
  });
});

describe("readErc20Metadata", () => {
  it("falls back for non-standard name and symbol while keeping valid decimals", async () => {
    const { client } = makePublicClient({
      readContract: async ({ functionName }) => {
        if (functionName === "decimals") return 6;
        if (functionName === "name") throw new Error("name unavailable");
        return new Uint8Array([1, 2, 3]);
      }
    });

    await expect(readErc20Metadata(client, tokenAddress)).resolves.toEqual({
      contractAddress: tokenAddress,
      decimals: 6,
      name: "ERC20 Token",
      symbol: "TOKEN"
    });
  });

  it("rejects invalid decimals even when display metadata is available", async () => {
    const { client } = makePublicClient({
      readContract: async ({ functionName }) => functionName === "decimals" ? 256 : "Token"
    });

    await expect(readErc20Metadata(client, tokenAddress)).rejects.toThrow("元数据返回格式不正确");
  });
});

describe("planEvmCollection", () => {
  it("plans ERC20 ready, zero-balance skipped, and read-failure rows", async () => {
    const accounts = parseAccounts();
    const asset = getSingleAsset(tokenAddress, "erc20");
    const { client } = makePublicClient({
      readContract: async ({ args, functionName }) => {
        if (functionName === "name") return "Example Token";
        if (functionName === "symbol") return "EXT";
        if (functionName === "decimals") return 18;
        const owner = args?.[0] as Address;
        if (owner === accounts[0].address) return 25n;
        if (owner === accounts[1].address) return 0n;
        throw new Error(`RPC failed while handling ${privateKeyThree}`);
      }
    });

    const plan = await planEvmCollection({ accounts, assets: [asset], publicClient: client });

    expect(plan.map((item) => item.status)).toEqual(["ready", "skipped", "failed"]);
    expect(plan.map((item) => item.amount)).toEqual([25n, 0n, 0n]);
    expect(plan[0].metadata).toMatchObject({ decimals: 18, symbol: "EXT" });
    expect(JSON.stringify(plan, (_key, value) => typeof value === "bigint" ? value.toString() : value))
      .not.toContain(privateKeyThree);
  });

  it("creates one ERC721 ready item for the actual imported owner", async () => {
    const accounts = parseAccounts();
    const asset = getSingleAsset(`${nftAddress},7`, "erc721");
    const { client, readContract } = makePublicClient({
      readContract: async () => accounts[1].address
    });

    const plan = await planEvmCollection({ accounts, assets: [asset], publicClient: client });

    expect(readContract).toHaveBeenCalledOnce();
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({
      address: accounts[1].address,
      amount: 1n,
      label: "来源 2",
      status: "ready"
    });
  });

  it("creates one asset-level ERC721 skip when the owner was not imported", async () => {
    const accounts = parseAccounts();
    const asset = getSingleAsset(`${nftAddress},8`, "erc721");
    const { client } = makePublicClient({ readContract: async () => externalOwner });

    const plan = await planEvmCollection({ accounts, assets: [asset], publicClient: client });

    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({
      account: null,
      address: getAddress(externalOwner),
      amount: 1n,
      status: "skipped"
    });
  });

  it("uses the complete ERC1155 balance and skips zero balances", async () => {
    const accounts = parseAccounts([privateKeyOne, privateKeyTwo]);
    const asset = getSingleAsset(`${nftAddress},42`, "erc1155");
    const { client } = makePublicClient({
      readContract: async ({ args }) => args?.[0] === accounts[0].address ? 12n : 0n
    });

    const plan = await planEvmCollection({ accounts, assets: [asset], publicClient: client });

    expect(plan.map((item) => item.status)).toEqual(["ready", "skipped"]);
    expect(plan.map((item) => item.amount)).toEqual([12n, 0n]);
  });
});

describe("executeEvmCollectionPlan", () => {
  async function readyPlansForAllStandards(account: EvmCollectionAccount) {
    const erc20 = getSingleAsset(tokenAddress, "erc20");
    const erc721 = getSingleAsset(`${nftAddress},7`, "erc721");
    const erc1155 = getSingleAsset(`${nftAddress},42`, "erc1155");
    return [
      {
        account: account.account,
        address: account.address,
        amount: 25n,
        asset: erc20,
        id: "erc20-plan",
        label: account.label,
        message: "ready",
        status: "ready"
      },
      {
        account: account.account,
        address: account.address,
        amount: 1n,
        asset: erc721,
        id: "erc721-plan",
        label: account.label,
        message: "ready",
        status: "ready"
      },
      {
        account: account.account,
        address: account.address,
        amount: 12n,
        asset: erc1155,
        id: "erc1155-plan",
        label: account.label,
        message: "ready",
        status: "ready"
      }
    ] satisfies EvmCollectionPlanItem[];
  }

  describe("preflightEvmCollectionPlan", () => {
    it("marks a simulated transfer as ready without submitting it", async () => {
      const account = parseAccounts([privateKeyOne])[0];
      const [item] = await readyPlansForAllStandards(account);
      const { client: publicClient, estimateGas, getBalance, simulateContract } = makePublicClient();

      const preflight = await preflightEvmCollectionPlan({
        maxFeePerTransactionWei,
        plan: [item],
        publicClient,
        targetAddress
      });

      expect(preflight.plan).toMatchObject([{ status: "ready" }]);
      expect(preflight.plan[0].message).toContain("已完成交易模拟与网络费预检");
      expect(preflight.executableTransactions).toBe(1);
      expect(preflight.estimatedNetworkFee).toBe(1_200n);
      expect(simulateContract).toHaveBeenCalledOnce();
      expect(estimateGas).toHaveBeenCalledOnce();
      expect(getBalance).toHaveBeenCalledOnce();
    });

    it("removes a failed simulation from the final confirmation plan", async () => {
      const account = parseAccounts([privateKeyOne])[0];
      const [item] = await readyPlansForAllStandards(account);
      const { client: publicClient, estimateGas, getBalance } = makePublicClient({
        simulateContract: async () => {
          throw new Error("receiver rejected NFT");
        }
      });

      const preflight = await preflightEvmCollectionPlan({
        maxFeePerTransactionWei,
        plan: [item],
        publicClient,
        targetAddress
      });

      expect(preflight.plan).toMatchObject([{ status: "failed" }]);
      expect(preflight.plan[0].message).toContain("预检模拟失败");
      expect(preflight.executableTransactions).toBe(0);
      expect(estimateGas).not.toHaveBeenCalled();
      expect(getBalance).not.toHaveBeenCalled();
    });

    it("reserves estimated fees per source so later items fail early when native gas is insufficient", async () => {
      const account = parseAccounts([privateKeyOne])[0];
      const [first, second] = await readyPlansForAllStandards(account);
      const { client: publicClient, getBalance } = makePublicClient({ getBalance: async () => 2_000n });

      const preflight = await preflightEvmCollectionPlan({
        maxFeePerTransactionWei,
        plan: [first, second],
        publicClient,
        targetAddress
      });

      expect(preflight.plan.map((item) => item.status)).toEqual(["ready", "failed"]);
      expect(preflight.plan[1].message).toContain("原生币余额不足");
      expect(preflight.executableTransactions).toBe(1);
      expect(getBalance).toHaveBeenCalledOnce();
    });
  });

  it("simulates each standard before writing, then waits for a successful receipt", async () => {
    const account = parseAccounts([privateKeyOne])[0];
    const plan = await readyPlansForAllStandards(account);
    const events: string[] = [];
    const { client: publicClient, simulateContract, waitForTransactionReceipt } = makePublicClient({
      simulateContract: async (parameters) => {
        events.push(`simulate:${parameters.functionName}`);
        return { request: { parameters }, result: parameters.functionName === "transfer" ? true : undefined };
      },
      waitForTransactionReceipt: async () => {
        events.push("confirm");
        return { status: "success" };
      }
    });
    const { client: walletClient, writeContract } = makeWalletClient(async () => {
      events.push("write");
      return transactionHash;
    });
    const progress = vi.fn();

    const results = await executeEvmCollectionPlan({
      getWalletClient: async () => walletClient,
      maxFeePerTransactionWei,
      onProgress: progress,
      plan,
      publicClient,
      targetAddress
    });

    expect(results.map((result) => result.status)).toEqual(["success", "success", "success"]);
    expect(results.every((result) => result.hash === transactionHash)).toBe(true);
    expect(events).toEqual([
      "simulate:transfer", "write", "confirm",
      "simulate:safeTransferFrom", "write", "confirm",
      "simulate:safeTransferFrom", "write", "confirm"
    ]);
    expect(simulateContract.mock.calls[0][0]).toMatchObject({
      args: [getAddress(targetAddress), 25n],
      functionName: "transfer"
    });
    expect(simulateContract.mock.calls[1][0]).toMatchObject({
      args: [account.address, getAddress(targetAddress), 7n],
      functionName: "safeTransferFrom"
    });
    expect(simulateContract.mock.calls[2][0]).toMatchObject({
      args: [account.address, getAddress(targetAddress), 42n, 12n, "0x"],
      functionName: "safeTransferFrom"
    });
    expect(writeContract).toHaveBeenCalledTimes(3);
    expect(waitForTransactionReceipt).toHaveBeenCalledTimes(3);
    expect(progress.mock.calls.slice(0, 4).map(([value]) => value.stage)).toEqual([
      "simulating",
      "estimating",
      "submitting",
      "confirming"
    ]);
    expect(writeContract.mock.calls[0][0]).toMatchObject({ gas: 120n, gasPrice: 10n });
  });

  it("batches ERC1155 Token IDs from the same wallet and contract into one transaction", async () => {
    const account = parseAccounts([privateKeyOne])[0];
    const plans = await readyPlansForAllStandards(account);
    const first = plans[2];
    const secondAsset = getSingleAsset(`${nftAddress},43`, "erc1155");
    const second: EvmCollectionPlanItem = {
      ...first,
      amount: 5n,
      asset: secondAsset,
      id: "erc1155-plan-43"
    };
    const { client: publicClient, simulateContract, waitForTransactionReceipt } = makePublicClient();
    const { client: walletClient, writeContract } = makeWalletClient();

    const results = await executeEvmCollectionPlan({
      getWalletClient: () => walletClient,
      maxFeePerTransactionWei,
      plan: [first, second],
      publicClient,
      targetAddress
    });

    expect(results.map((result) => result.status)).toEqual(["success", "success"]);
    expect(results.every((result) => result.hash === transactionHash)).toBe(true);
    expect(simulateContract).toHaveBeenCalledTimes(1);
    expect(simulateContract.mock.calls[0][0]).toMatchObject({
      args: [account.address, getAddress(targetAddress), [42n, 43n], [12n, 5n], "0x"],
      functionName: "safeBatchTransferFrom"
    });
    expect(writeContract).toHaveBeenCalledOnce();
    expect(waitForTransactionReceipt).toHaveBeenCalledOnce();
  });

  it("continues signing and confirmation when a UI progress callback throws", async () => {
    const account = parseAccounts([privateKeyOne])[0];
    const [item] = await readyPlansForAllStandards(account);
    const { client: publicClient, waitForTransactionReceipt } = makePublicClient();
    const { client: walletClient, writeContract } = makeWalletClient();

    const [result] = await executeEvmCollectionPlan({
      getWalletClient: () => walletClient,
      maxFeePerTransactionWei,
      onProgress: () => {
        throw new Error("render interrupted");
      },
      plan: [item],
      publicClient,
      targetAddress
    });

    expect(result).toMatchObject({ hash: transactionHash, status: "success" });
    expect(writeContract).toHaveBeenCalledOnce();
    expect(waitForTransactionReceipt).toHaveBeenCalledOnce();
  });

  it("does not write after a failed simulation and redacts its error", async () => {
    const account = parseAccounts([privateKeyOne])[0];
    const [item] = await readyPlansForAllStandards(account);
    const { client: publicClient, waitForTransactionReceipt } = makePublicClient({
      simulateContract: async () => {
        throw new Error(`simulation leaked ${privateKeyOne}`);
      }
    });
    const { client: walletClient, writeContract } = makeWalletClient();

    const [result] = await executeEvmCollectionPlan({
      getWalletClient: () => walletClient,
      maxFeePerTransactionWei,
      plan: [item],
      publicClient,
      targetAddress
    });

    expect(result.status).toBe("failed");
    expect(result.hash).toBeNull();
    expect(result.message).not.toContain(privateKeyOne);
    expect(writeContract).not.toHaveBeenCalled();
    expect(waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it("does not submit an ERC20 transfer whose simulation returns false", async () => {
    const account = parseAccounts([privateKeyOne])[0];
    const [item] = await readyPlansForAllStandards(account);
    const { client: publicClient } = makePublicClient({
      simulateContract: async () => ({ request: { prepared: true }, result: false } as never)
    });
    const { client: walletClient, writeContract } = makeWalletClient();

    const [result] = await executeEvmCollectionPlan({
      getWalletClient: () => walletClient,
      maxFeePerTransactionWei,
      plan: [item],
      publicClient,
      targetAddress
    });

    expect(result.status).toBe("failed");
    expect(result.message).toContain("transfer 模拟返回 false");
    expect(writeContract).not.toHaveBeenCalled();
  });

  it("hard-blocks a transaction whose buffered network fee exceeds the confirmed cap", async () => {
    const account = parseAccounts([privateKeyOne])[0];
    const [item] = await readyPlansForAllStandards(account);
    const { client: publicClient } = makePublicClient({
      estimateGas: async () => 1_000n,
      getGasPrice: async () => 100n
    });
    const { client: walletClient, writeContract } = makeWalletClient();

    const [result] = await executeEvmCollectionPlan({
      getWalletClient: () => walletClient,
      maxFeePerTransactionWei: 50_000n,
      plan: [item],
      publicClient,
      targetAddress
    });

    expect(result.status).toBe("failed");
    expect(result.message).toContain("超过已确认上限");
    expect(writeContract).not.toHaveBeenCalled();
  });

  it("checks the source native balance before submission", async () => {
    const account = parseAccounts([privateKeyOne])[0];
    const [item] = await readyPlansForAllStandards(account);
    const { client: publicClient } = makePublicClient({ getBalance: async () => 1n });
    const { client: walletClient, writeContract } = makeWalletClient();

    const [result] = await executeEvmCollectionPlan({
      getWalletClient: () => walletClient,
      maxFeePerTransactionWei,
      plan: [item],
      publicClient,
      targetAddress
    });

    expect(result.status).toBe("failed");
    expect(result.message).toContain("原生币余额不足");
    expect(writeContract).not.toHaveBeenCalled();
  });

  it("keeps the hash but marks a reverted receipt as failed", async () => {
    const account = parseAccounts([privateKeyOne])[0];
    const [item] = await readyPlansForAllStandards(account);
    const { client: publicClient } = makePublicClient({
      waitForTransactionReceipt: async () => ({ status: "reverted" })
    });
    const { client: walletClient } = makeWalletClient();

    const [result] = await executeEvmCollectionPlan({
      getWalletClient: () => walletClient,
      maxFeePerTransactionWei,
      plan: [item],
      publicClient,
      targetAddress
    });

    expect(result).toMatchObject({ hash: transactionHash, status: "failed" });
    expect(result.message).toContain("执行状态为失败");
  });

  it("keeps the hash and warns against blind retries when confirmation throws", async () => {
    const account = parseAccounts([privateKeyOne])[0];
    const [item] = await readyPlansForAllStandards(account);
    const { client: publicClient } = makePublicClient({
      waitForTransactionReceipt: async () => {
        throw new Error(`confirmation timeout ${privateKeyOne}`);
      }
    });
    const { client: walletClient } = makeWalletClient();

    const [result] = await executeEvmCollectionPlan({
      getWalletClient: () => walletClient,
      maxFeePerTransactionWei,
      plan: [item],
      publicClient,
      targetAddress
    });

    expect(result).toMatchObject({ hash: transactionHash, status: "failed" });
    expect(result.message).toContain("请先查询链上状态，勿盲目重发");
    expect(result.message).not.toContain(privateKeyOne);
  });

  it("stops later items from the same source after an uncertain submission", async () => {
    const account = parseAccounts([privateKeyOne])[0];
    const [first, second] = await readyPlansForAllStandards(account);
    const { client: publicClient, simulateContract } = makePublicClient();
    const { client: walletClient, writeContract } = makeWalletClient(async () => {
      throw new Error("RPC response lost");
    });

    const results = await executeEvmCollectionPlan({
      getWalletClient: () => walletClient,
      maxFeePerTransactionWei,
      plan: [first, second],
      publicClient,
      targetAddress
    });

    expect(results.map((result) => result.status)).toEqual(["failed", "failed"]);
    expect(results[0].message).toContain("状态不确定");
    expect(results[1].message).toContain("已停止其后续归集项");
    expect(writeContract).toHaveBeenCalledOnce();
    expect(simulateContract).toHaveBeenCalledOnce();
  });

  it("passes existing skipped and failed plan rows through without RPC calls", async () => {
    const account = parseAccounts([privateKeyOne])[0];
    const [base] = await readyPlansForAllStandards(account);
    const plan = [
      { ...base, message: "zero", status: "skipped" as const },
      { ...base, id: "failed", message: "read error", status: "failed" as const }
    ];
    const { client: publicClient, simulateContract, waitForTransactionReceipt } = makePublicClient();
    const { client: walletClient, writeContract } = makeWalletClient();

    const results = await executeEvmCollectionPlan({
      getWalletClient: () => walletClient,
      maxFeePerTransactionWei,
      plan,
      publicClient,
      targetAddress
    });

    expect(results.map((result) => result.status)).toEqual(["skipped", "failed"]);
    expect(simulateContract).not.toHaveBeenCalled();
    expect(writeContract).not.toHaveBeenCalled();
    expect(waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it("rejects an invalid target before any transaction work", async () => {
    const { client: publicClient, simulateContract } = makePublicClient();
    await expect(executeEvmCollectionPlan({
      getWalletClient: vi.fn(),
      maxFeePerTransactionWei,
      plan: [],
      publicClient,
      targetAddress: "invalid"
    })).rejects.toThrow("目标归集地址格式不正确");
    expect(simulateContract).not.toHaveBeenCalled();
  });

  it("rejects the zero address as a collection target", async () => {
    const { client: publicClient, simulateContract } = makePublicClient();
    await expect(executeEvmCollectionPlan({
      getWalletClient: vi.fn(),
      maxFeePerTransactionWei,
      plan: [],
      publicClient,
      targetAddress: "0x0000000000000000000000000000000000000000"
    })).rejects.toThrow("目标归集地址不能是零地址");
    expect(simulateContract).not.toHaveBeenCalled();
  });
});
