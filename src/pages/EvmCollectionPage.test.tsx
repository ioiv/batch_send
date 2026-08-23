// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvmCollectionPlanItem } from "../lib/evm-collection";

const evmMocks = vi.hoisted(() => ({
  assertNetwork: vi.fn(),
  createPublicClient: vi.fn(),
  createWalletClient: vi.fn(),
  discoverErc1155: vi.fn(),
  discoverEnumerable: vi.fn(),
  discoverTransfer: vi.fn(),
  execute: vi.fn(),
  getBalance: vi.fn(),
  getLiveGas: vi.fn(),
  inspectContract: vi.fn(),
  findDeployment: vi.fn(),
  plan: vi.fn(),
  preflight: vi.fn(),
  readContract: vi.fn(),
  readMetadata: vi.fn()
}));

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return { ...actual, createWalletClient: evmMocks.createWalletClient };
});

vi.mock("../lib/evm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/evm")>();
  return {
    ...actual,
    assertEvmRpcNetwork: evmMocks.assertNetwork,
    createEvmPublicClient: evmMocks.createPublicClient
  };
});

vi.mock("../lib/evm-gas", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/evm-gas")>();
  return { ...actual, getLiveEvmFeeQuote: evmMocks.getLiveGas };
});

vi.mock("../lib/evm-collection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/evm-collection")>();
  return {
    ...actual,
    executeEvmCollectionPlan: evmMocks.execute,
    planEvmCollection: evmMocks.plan,
    preflightEvmCollectionPlan: evmMocks.preflight,
    readErc20Metadata: evmMocks.readMetadata
  };
});

vi.mock("../lib/nft-contract-inspection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/nft-contract-inspection")>();
  return { ...actual, inspectNftContract: evmMocks.inspectContract };
});

vi.mock("../lib/erc721-discovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/erc721-discovery")>();
  return { ...actual, discoverEnumerableErc721Assets: evmMocks.discoverEnumerable };
});

vi.mock("../lib/erc721-transfer-discovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/erc721-transfer-discovery")>();
  return {
    ...actual,
    discoverErc721AssetsByTransfer: evmMocks.discoverTransfer,
    findErc721DeploymentBlock: evmMocks.findDeployment
  };
});

vi.mock("../lib/erc1155-transfer-discovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/erc1155-transfer-discovery")>();
  return { ...actual, discoverErc1155AssetsByTransfer: evmMocks.discoverErc1155 };
});

import {
  EvmCollectionPage,
  getDefaultEvmCollectionFeeCap,
  getEvmCollectionWorkbenchStatus,
  hasEvmCollectionPlanDrift
} from "./EvmCollectionPage";

const sourceAddress = "0x0000000000000000000000000000000000000003";
const targetAddress = "0x0000000000000000000000000000000000000001";
const tokenAddress = "0x0000000000000000000000000000000000000002" as const;
const secondTokenAddress = "0x0000000000000000000000000000000000000004";
const privateKey = ("0x" + "11".repeat(32)) as `0x${string}`;
const secondPrivateKey = ("0x" + "22".repeat(32)) as `0x${string}`;
const signerAccount = privateKeyToAccount(privateKey);
const secondSignerAccount = privateKeyToAccount(secondPrivateKey);
const transactionHash = "0x" + "ab".repeat(32);
const planItem = {
  account: signerAccount,
  address: signerAccount.address,
  amount: 1_000_000_000_000_000_000n,
  asset: {
    contractAddress: tokenAddress,
    key: "erc20:" + tokenAddress.toLowerCase(),
    standard: "erc20" as const
  },
  id: "plan-1",
  label: "来源一",
  message: "可归集",
  metadata: {
    contractAddress: tokenAddress,
    decimals: 18,
    name: "Token",
    symbol: "TOK"
  },
  status: "ready" as const
} satisfies EvmCollectionPlanItem;
const secondPlanItem = {
  ...planItem,
  asset: {
    contractAddress: secondTokenAddress,
    key: "erc20:" + secondTokenAddress.toLowerCase(),
    standard: "erc20" as const
  },
  id: "plan-2",
  metadata: {
    contractAddress: secondTokenAddress,
    decimals: 18,
    name: "Token Two",
    symbol: "TOK2"
  }
} satisfies EvmCollectionPlanItem;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  window.localStorage.clear();
  evmMocks.assertNetwork.mockResolvedValue(undefined);
  evmMocks.createPublicClient.mockReturnValue({
    getBalance: evmMocks.getBalance,
    readContract: evmMocks.readContract
  });
  evmMocks.createWalletClient.mockReturnValue({});
  evmMocks.getBalance.mockResolvedValue(3_000_000_000_000_000_000n);
  evmMocks.getLiveGas.mockResolvedValue({
    gasPrice: 2_000_000_000n,
    sampledAt: 1_700_000_000_000,
    source: "rpc",
    type: "legacy"
  });
  evmMocks.plan.mockResolvedValue([planItem]);
  evmMocks.preflight.mockResolvedValue({
    estimatedNetworkFee: 1_000_000_000_000n,
    executableTransactions: 1,
    plan: [planItem]
  });
  evmMocks.readContract.mockResolvedValue(2_000_000_000_000_000_000n);
  evmMocks.readMetadata.mockImplementation(async (_client, address) => ({
    contractAddress: address,
    decimals: 18,
    name: address.toLowerCase() === secondTokenAddress.toLowerCase() ? "Token Two" : "Token",
    symbol: address.toLowerCase() === secondTokenAddress.toLowerCase() ? "TOK2" : "TOK"
  }));
  evmMocks.execute.mockResolvedValue([]);
  evmMocks.inspectContract.mockResolvedValue({
    address: tokenAddress,
    enumerable: true,
    issues: [],
    name: "Collection",
    snapshotBlock: 100n,
    standard: "erc721",
    symbol: "NFT"
  });
  evmMocks.discoverEnumerable.mockResolvedValue({
    assets: [{
      contractAddress: tokenAddress,
      key: "erc721:" + tokenAddress.toLowerCase() + ":1",
      standard: "erc721",
      tokenId: 1n
    }],
    issues: [],
    owners: [{
      balance: 1n,
      discovered: 1,
      ownerAddress: sourceAddress,
      scanned: 1,
      status: "complete"
    }],
    rpcRequests: 6,
    snapshotBlock: 100n
  });
  evmMocks.findDeployment.mockResolvedValue(12n);
  evmMocks.discoverTransfer.mockResolvedValue({
    assets: [{
      contractAddress: tokenAddress,
      key: "erc721:" + tokenAddress.toLowerCase() + ":1",
      standard: "erc721",
      tokenId: 1n
    }],
    candidateCount: 1,
    complete: true,
    fromBlock: 12n,
    issues: [],
    latestBlock: 100n,
    rpcRequests: 5,
    scope: "full-history"
  });
  evmMocks.discoverErc1155.mockResolvedValue({
    assets: [{
      contractAddress: tokenAddress,
      key: "erc1155:" + tokenAddress.toLowerCase() + ":9",
      standard: "erc1155",
      tokenId: 9n
    }],
    candidateCount: 1,
    complete: true,
    fromBlock: 12n,
    issues: [],
    latestBlock: 100n,
    rpcRequests: 5
  });
});

async function fillTokenList(
  user: ReturnType<typeof userEvent.setup>,
  assetInput: string
) {
  const [firstToken = "", ...additionalTokens] = assetInput
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (firstToken) {
    await user.type(screen.getByRole("textbox", { name: "Token 清单" }), firstToken);
  }
  for (const [index, address] of additionalTokens.entries()) {
    await user.click(screen.getByRole("button", { name: "添加 Token" }));
    await user.type(screen.getByRole("textbox", { name: `Token 地址 ${index + 2}` }), address);
  }
}

async function prepareReadyErc20Page(assetInput: string = tokenAddress) {
  const user = userEvent.setup();
  render(<EvmCollectionPage fixedStandard="erc20" />);
  await user.type(screen.getByRole("textbox", { name: "目标地址" }), targetAddress);
  await fillTokenList(user, assetInput);
  await importEvmSecret(user);
  expect(screen.getByRole("button", { name: "确认并开始归集" })).toBeEnabled();
  return user;
}

async function importEvmSecret(
  user: ReturnType<typeof userEvent.setup>,
  secret: string = privateKey
) {
  await user.click(screen.getByRole("button", { name: /导入钱包/ }));
  const dialog = screen.getByRole("dialog", { name: "导入来源钱包" });
  await user.type(within(dialog).getByRole("textbox", { name: "粘贴私钥" }), secret);
  await user.click(within(dialog).getByRole("button", { name: "确认导入" }));
}

async function confirmEvmExecution(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "确认并开始归集" }));
  const dialog = screen.getByRole("alertdialog", { name: "确认 EVM 归集？" });
  await user.click(within(dialog).getByRole("button", { name: "确认并开始归集" }));
}

async function discoverNft() {
  const user = userEvent.setup();
  render(<EvmCollectionPage fixedStandard="nft" />);
  await user.type(screen.getByRole("textbox", { name: "只读来源地址" }), sourceAddress);
  await user.type(screen.getByRole("textbox", { name: "NFT 合约" }), tokenAddress);
  await user.click(screen.getByRole("button", { name: "识别持仓" }));
  return user;
}

describe("EVM collection fee protection defaults", () => {
  const network = (chainId: number, symbol: string) => ({
    chainId,
    nativeCurrency: { decimals: 18, name: symbol, symbol }
  });

  it("uses chain-aware caps and safe symbol fallbacks", () => {
    expect(getDefaultEvmCollectionFeeCap(network(1, "ETH"))).toBe("0.01");
    expect(getDefaultEvmCollectionFeeCap(network(8453, "ETH"))).toBe("0.003");
    expect(getDefaultEvmCollectionFeeCap(network(137, "POL"))).toBe("0.1");
    expect(getDefaultEvmCollectionFeeCap(network(999_001, "POL"))).toBe("0.1");
    expect(getDefaultEvmCollectionFeeCap(network(999_002, "xDAI"))).toBe("0.05");
    expect(getDefaultEvmCollectionFeeCap(network(999_003, "NEW"))).toBe("0.01");
  });
});

describe("EvmCollectionPage workbench", () => {
  it("keeps the optional Token list compact and defaults a blank list to the native asset", async () => {
    const user = userEvent.setup();
    render(<EvmCollectionPage fixedStandard="erc20" />);

    const tokenList = screen.getByRole("textbox", { name: "Token 清单" });
    expect(tokenList).toHaveAttribute("placeholder", "0x…");
    expect(screen.getByText("ERC20")).toBeVisible();
    expect(screen.getByRole("button", { name: "添加 Token" })).toBeVisible();
    expect(screen.queryByText("Token 识别")).not.toBeInTheDocument();
    expect(screen.getByText("可选；留空则归集 ETH，填写后归集列出的 ERC20 Token。")).toBeVisible();

    await user.type(screen.getByRole("textbox", { name: "目标地址" }), targetAddress);
    await importEvmSecret(user);
    await confirmEvmExecution(user);
    await waitFor(() => expect(evmMocks.plan).toHaveBeenCalled());
    expect(evmMocks.plan).toHaveBeenCalledWith(expect.objectContaining({
      assets: [{ key: "native", standard: "native" }]
    }));
  });

  it("orders wallet import, Token recognition and balances before compact network settings", async () => {
    const user = userEvent.setup();
    render(<EvmCollectionPage fixedStandard="erc20" />);

    const walletImport = screen.getByRole("button", { name: "导入钱包" });
    const target = screen.getByRole("textbox", { name: "目标地址" });
    const assets = screen.getByRole("textbox", { name: "Token 清单" });
    const addressBalanceControl = screen.getByLabelText("地址余额查询");
    const networkAndRpc = screen.getByLabelText("网络与 RPC");
    const gasSettings = screen.getByLabelText("Gas 设置");
    const feeProtection = screen.getByRole("button", { name: /高级网络费保护/ });

    expect(within(networkAndRpc).getByRole("combobox")).toBeVisible();
    expect(within(networkAndRpc).getByRole("textbox", { name: "RPC" }))
      .toHaveValue("https://ethereum.publicnode.com");
    expect(within(networkAndRpc).getByText(/Chain ID/)).toHaveTextContent("Chain ID 1");
    expect(screen.queryByRole("button", { name: "RPC 与 Gas 设置" })).not.toBeInTheDocument();
    expect(walletImport.compareDocumentPosition(assets) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(assets.compareDocumentPosition(addressBalanceControl) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(addressBalanceControl.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(target.compareDocumentPosition(networkAndRpc) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(assets.compareDocumentPosition(networkAndRpc) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(networkAndRpc.compareDocumentPosition(gasSettings) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(gasSettings.compareDocumentPosition(feeProtection) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(screen.queryByRole("spinbutton", { name: /单笔最高网络费/ })).not.toBeInTheDocument();

    await user.click(feeProtection);
    expect(screen.getByRole("spinbutton", { name: /单笔最高网络费/ })).toHaveValue(0.01);
  });

  it("automatically resolves Token symbols and queries balances for selected source addresses", async () => {
    const user = userEvent.setup();
    render(<EvmCollectionPage fixedStandard="erc20" />);

    await importEvmSecret(user);
    await user.type(screen.getByRole("textbox", { name: "Token 清单" }), tokenAddress);

    await waitFor(() => expect(evmMocks.readMetadata).toHaveBeenCalledWith(
      expect.anything(),
      tokenAddress
    ), { timeout: 1_500 });
    expect(screen.getByText("TOK")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Token 清单" })).toHaveAttribute("readonly");

    await user.click(screen.getByRole("button", { name: "查看地址余额" }));
    const walletList = screen.getByLabelText("已导入来源钱包");
    await waitFor(() => expect(within(walletList).getByText("2")).toBeVisible());
    expect(within(walletList).getByText("3")).toBeVisible();
    expect(within(walletList).getByText("ETH")).toBeVisible();
    expect(within(walletList).getByText("TOK")).toBeVisible();
    expect(within(walletList).queryByText("钱包 1")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "地址余额" })).not.toBeInTheDocument();
    expect(evmMocks.readContract).toHaveBeenCalledWith(expect.objectContaining({
      args: [signerAccount.address],
      functionName: "balanceOf"
    }));
    expect(evmMocks.getBalance).toHaveBeenCalledWith({ address: signerAccount.address });
  });

  it("locks recognized Token addresses and reuses their metadata when rows are added or removed", async () => {
    const user = userEvent.setup();
    render(<EvmCollectionPage fixedStandard="erc20" />);

    const firstTokenInput = screen.getByRole("textbox", { name: "Token 清单" });
    await user.type(firstTokenInput, tokenAddress);
    await screen.findByText("TOK", {}, { timeout: 1_500 });

    expect(firstTokenInput).toHaveAttribute("readonly");
    expect(evmMocks.readMetadata).toHaveBeenCalledTimes(1);
    await user.type(firstTokenInput, "1");
    expect(firstTokenInput).toHaveValue(tokenAddress);

    await user.click(screen.getByRole("button", { name: "添加 Token" }));
    const secondTokenInput = screen.getByRole("textbox", { name: "Token 地址 2" });
    expect(secondTokenInput).not.toHaveAttribute("readonly");
    expect(evmMocks.readMetadata).toHaveBeenCalledTimes(1);

    await user.type(secondTokenInput, secondTokenAddress);
    await screen.findByText("TOK2", {}, { timeout: 1_500 });
    expect(secondTokenInput).toHaveAttribute("readonly");
    expect(evmMocks.readMetadata).toHaveBeenCalledTimes(2);
    expect(evmMocks.readMetadata.mock.calls.filter(([, address]) => address === tokenAddress)).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "删除 Token 地址 2" }));
    expect(screen.queryByRole("textbox", { name: "Token 地址 2" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Token 清单" })).toHaveAttribute("readonly");
    expect(evmMocks.readMetadata).toHaveBeenCalledTimes(2);
  });

  it("keeps remaining inline balances when one imported address is deleted", async () => {
    const user = userEvent.setup();
    render(<EvmCollectionPage fixedStandard="erc20" />);

    await importEvmSecret(user);
    await importEvmSecret(user, secondPrivateKey);
    await user.type(screen.getByRole("textbox", { name: "Token 清单" }), tokenAddress);
    await waitFor(() => expect(evmMocks.readMetadata).toHaveBeenCalled(), { timeout: 1_500 });
    await user.click(screen.getByRole("button", { name: "查看地址余额" }));

    const walletList = screen.getByLabelText("已导入来源钱包");
    await waitFor(() => expect(within(walletList).getAllByText("2")).toHaveLength(2));
    await user.click(screen.getByRole("button", { name: new RegExp(`删除.*${signerAccount.address}`, "i") }));

    expect(within(walletList).queryByTitle(signerAccount.address)).not.toBeInTheDocument();
    expect(within(walletList).getByTitle(secondSignerAccount.address)).toBeVisible();
    expect(within(walletList).getByText("2")).toBeVisible();
    expect(within(walletList).getByText("TOK")).toBeVisible();
  });

  it("shows live Gas and passes a custom Gas Price into direct execution", async () => {
    const user = userEvent.setup();
    render(<EvmCollectionPage fixedStandard="erc20" />);

    expect(await screen.findByLabelText("实时 Gas 推荐：慢 1.8 Gwei，中 2 Gwei，快 2.4 Gwei")).toBeVisible();
    const gasSettings = screen.getByLabelText("Gas 设置");
    await user.click(within(gasSettings).getByRole("tab", { name: "自定义" }));
    await user.type(within(gasSettings).getByRole("spinbutton", { name: "Gas Price（Gwei）" }), "4.5");
    await user.type(screen.getByRole("textbox", { name: "目标地址" }), targetAddress);
    await user.type(screen.getByRole("textbox", { name: "Token 清单" }), tokenAddress);
    await importEvmSecret(user);
    await confirmEvmExecution(user);

    await waitFor(() => expect(evmMocks.execute).toHaveBeenCalled());
    expect(evmMocks.execute).toHaveBeenCalledWith(expect.objectContaining({
      gasSettings: {
        fee: { gasPrice: 4_500_000_000n, type: "legacy" },
        mode: "custom"
      }
    }));
    await user.click(screen.getByRole("button", { name: /高级网络费保护/ }));
    expect(screen.getByRole("spinbutton", { name: /单笔最高网络费/ })).toBeInTheDocument();
  });

  it("blocks direct confirmation while the custom Gas Price is invalid", async () => {
    const user = userEvent.setup();
    render(<EvmCollectionPage fixedStandard="erc20" />);
    const gasSettings = screen.getByLabelText("Gas 设置");
    await user.click(within(gasSettings).getByRole("tab", { name: "自定义" }));
    await user.type(screen.getByRole("textbox", { name: "目标地址" }), targetAddress);
    await user.type(screen.getByRole("textbox", { name: "Token 清单" }), tokenAddress);
    await importEvmSecret(user);

    expect(within(gasSettings).queryByText(/请输入大于 0/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认并开始归集" })).toBeDisabled();
    expect(evmMocks.execute).not.toHaveBeenCalled();
  });

  it("keeps imported wallets while Gas settings are edited", async () => {
    const user = await prepareReadyErc20Page();
    expect(screen.getByRole("button", { name: "确认并开始归集" })).toBeEnabled();

    await user.click(within(screen.getByLabelText("Gas 设置")).getByRole("tab", { name: "自定义" }));

    expect(screen.getByRole("button", { name: "确认并开始归集" })).toBeDisabled();
    expect(screen.getByLabelText("已导入来源钱包")).toBeVisible();
  });

  it("renders source modes while keeping both NFT standards automatic-only", () => {
    render(<EvmCollectionPage fixedStandard="nft" />);

    expect(screen.getByRole("heading", { name: "EVM NFT 归集", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "只读地址" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "来源密钥" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "ERC721" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "ERC1155" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("textbox", { name: "NFT 合约" })).toHaveLength(1);
    expect(screen.getByText("编辑中")).toBeInTheDocument();
    expect(screen.queryByText(/下一步|预检准备项|平台费 0|不上传密钥|密钥仅在本地内存/)).not.toBeInTheDocument();
  });

  it("places NFT source keys above asset discovery and keeps ERC721 discovery automatic-only", async () => {
    const user = userEvent.setup();
    render(<EvmCollectionPage fixedStandard="nft" />);

    await user.click(screen.getByRole("tab", { name: "来源密钥" }));
    const walletImport = screen.getByRole("button", { name: "导入钱包" });
    const nftContract = screen.getByRole("textbox", { name: "NFT 合约" });

    expect(walletImport.compareDocumentPosition(nftContract) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(screen.queryByRole("tab", { name: "手工 / 文件" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Token ID / 区间")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "识别持仓" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "发现方式与事件范围" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist", { name: "NFT 发现方式" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("事件起始区块")).not.toBeInTheDocument();
  });

  it("shows execution failures inside the wallet row and offers retry", async () => {
    evmMocks.execute.mockResolvedValueOnce([{
      address: planItem.address,
      amount: planItem.amount,
      asset: planItem.asset,
      hash: null,
      id: planItem.id,
      label: planItem.label,
      message: "模拟失败",
      retryable: true,
      status: "failed"
    }]);
    const user = await prepareReadyErc20Page();
    await confirmEvmExecution(user);

    expect(await screen.findByRole("button", { name: "重试失败项 (1)" })).toBeEnabled();
    const walletList = screen.getByLabelText("已导入来源钱包");
    expect(within(walletList).getByText("失败")).toBeVisible();
    expect(within(walletList).getByText("模拟失败")).toBeVisible();
  });

  it("does not render a separate preflight or result section", () => {
    render(<EvmCollectionPage fixedStandard="erc20" />);

    expect(screen.getByRole("button", { name: "确认并开始归集" })).toBeDisabled();
    expect(screen.queryByText(/预检与结果|等待预检/)).not.toBeInTheDocument();
  });

  it("automatically adds complete discovery results to the pending asset table", async () => {
    await discoverNft();
    expect(await screen.findByText("1 个有效")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "ERC721 待归集资产清单" })).toBeInTheDocument();
    expect(screen.getByText(/持仓已更新：该合约当前有 1 个可归集 NFT/)).toHaveAttribute("role", "status");
    expect(screen.getByRole("button", { name: "再次识别" })).toBeEnabled();
    expect(evmMocks.discoverEnumerable).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "加入资产清单" })).not.toBeInTheDocument();
  });

  it("explains ERC1155 history backtracking before the scan starts", async () => {
    evmMocks.inspectContract.mockResolvedValueOnce({
      address: tokenAddress,
      enumerable: false,
      issues: [],
      name: "Multi Collection",
      snapshotBlock: 100n,
      standard: "erc1155",
      symbol: "MULTI"
    });

    const user = await discoverNft();

    expect(await screen.findByText("需要回溯 Transfer 历史")).toBeVisible();
    expect(screen.getByLabelText("历史扫描范围")).toHaveTextContent("部署区块12");
    expect(screen.getByLabelText("历史扫描范围")).toHaveTextContent("快照区块100");
    expect(screen.getByRole("spinbutton", { name: "扫描起始区块" })).toHaveValue(12);
    expect(evmMocks.discoverErc1155).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "扫描完整历史" }));
    expect(await screen.findByRole("table", { name: "ERC1155 待归集资产清单" })).toBeVisible();
    expect(screen.getByText("9")).toBeVisible();
    expect(screen.getByText("全部余额")).toBeVisible();
    expect(screen.queryByLabelText("Token ID / 区间")).not.toBeInTheDocument();
    expect(evmMocks.findDeployment).toHaveBeenCalledTimes(1);
    expect(evmMocks.discoverErc1155).toHaveBeenCalledWith(expect.objectContaining({
      fromBlock: 12n,
      ownerAddresses: [sourceAddress],
      toBlock: 100n
    }));
    expect(screen.getByRole("button", { name: "再次识别" })).toBeEnabled();
  });

  it("stops an in-progress history scan without changing the asset inventory", async () => {
    evmMocks.inspectContract.mockResolvedValueOnce({
      address: tokenAddress,
      enumerable: false,
      issues: [],
      name: "Multi Collection",
      snapshotBlock: 100n,
      standard: "erc1155",
      symbol: "MULTI"
    });
    const user = await discoverNft();
    expect(await screen.findByText("需要回溯 Transfer 历史")).toBeVisible();

    let observedSignal: AbortSignal | undefined;
    evmMocks.discoverErc1155.mockImplementationOnce(({ signal }: { signal?: AbortSignal }) => {
      observedSignal = signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    await user.click(screen.getByRole("button", { name: "扫描完整历史" }));
    await user.click(await screen.findByRole("button", { name: "停止扫描" }));

    expect(await screen.findByText(/历史扫描已停止，现有资产清单未修改/)).toBeVisible();
    expect(observedSignal?.aborted).toBe(true);
    expect(screen.getByText("暂无资产")).toBeVisible();
    expect(screen.getByRole("button", { name: "扫描完整历史" })).toBeEnabled();
  });

  it("pauses an ERC721 fallback before reading Transfer history", async () => {
    evmMocks.inspectContract.mockResolvedValueOnce({
      address: tokenAddress,
      enumerable: false,
      issues: [],
      name: "Plain Collection",
      snapshotBlock: 100n,
      standard: "erc721",
      symbol: "PLAIN"
    });
    evmMocks.discoverEnumerable.mockResolvedValueOnce({
      assets: [],
      issues: [{ code: "not-enumerable", message: "合约不支持 ERC721Enumerable" }],
      owners: [],
      rpcRequests: 2,
      snapshotBlock: 100n
    });

    const user = await discoverNft();
    expect(await screen.findByText("需要回溯 Transfer 历史")).toBeVisible();
    expect(screen.getByText(/Enumerable 与公开索引未能完整对账/)).toBeVisible();
    expect(evmMocks.discoverTransfer).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "扫描完整历史" }));
    await waitFor(() => expect(evmMocks.discoverTransfer).toHaveBeenCalledWith(expect.objectContaining({
      fromBlock: 12n,
      ownerAddresses: [sourceAddress],
      scope: "full-history",
      toBlock: 100n
    })));
    expect(await screen.findByText("1 个有效")).toBeVisible();
  });

  it("reconciles a repeated complete discovery and clears stale zero-holding rows", async () => {
    const user = await discoverNft();
    expect(await screen.findByText("1 个有效")).toBeVisible();
    evmMocks.discoverEnumerable.mockResolvedValueOnce({
      assets: [],
      issues: [],
      owners: [{
        balance: 0n,
        discovered: 0,
        ownerAddress: sourceAddress,
        scanned: 0,
        status: "complete"
      }],
      rpcRequests: 2,
      snapshotBlock: 101n
    });

    await user.click(screen.getByRole("button", { name: "再次识别" }));
    expect(await screen.findByText("暂无资产")).toBeVisible();
    expect(screen.getByText(/当前没有该合约的可归集 NFT/)).toHaveAttribute("role", "status");
  });

  it("requires a separate confirmation before adding partial discovery results", async () => {
    evmMocks.discoverEnumerable.mockResolvedValueOnce({
      assets: [{
        contractAddress: tokenAddress,
        key: "erc721:" + tokenAddress.toLowerCase() + ":1",
        standard: "erc721",
        tokenId: 1n
      }],
      issues: [],
      owners: [{
        balance: 1n,
        discovered: 1,
        ownerAddress: sourceAddress,
        scanned: 1,
        status: "failed"
      }],
      rpcRequests: 6,
      snapshotBlock: 100n
    });
    const user = await discoverNft();
    const trigger = await screen.findByRole("button", { name: "确认并加入部分结果" });
    await user.click(trigger);
    let dialog = screen.getByRole("alertdialog", { name: "加入部分发现结果？" });
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.getByText("暂无资产")).toBeInTheDocument();

    await user.click(trigger);
    dialog = screen.getByRole("alertdialog", { name: "加入部分发现结果？" });
    await user.click(within(dialog).getByRole("button", { name: "确认加入部分结果" }));
    expect(await screen.findByText("1 个有效")).toBeInTheDocument();
  });

  it("cancels direct execution, preserves edits, and confirms clearing", async () => {
    const user = await prepareReadyErc20Page();
    await user.click(screen.getByRole("button", { name: "确认并开始归集" }));
    const executeDialog = screen.getByRole("alertdialog", { name: "确认 EVM 归集？" });
    await user.click(within(executeDialog).getByRole("button", { name: "取消" }));
    expect(evmMocks.execute).not.toHaveBeenCalled();

    const target = screen.getByRole("textbox", { name: "目标地址" });
    await user.clear(target);
    expect(screen.getByRole("button", { name: "确认并开始归集" })).toBeDisabled();
    await user.type(target, targetAddress);
    expect(screen.getByText("编辑中")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认并开始归集" })).toBeEnabled();

    const clearTrigger = screen.getByRole("button", { name: "清空工作台" });
    await user.click(clearTrigger);
    let clearDialog = screen.getByRole("alertdialog", { name: "清空归集工作台？" });
    await user.click(within(clearDialog).getByRole("button", { name: "取消" }));
    expect(target).toHaveValue(targetAddress);

    await user.click(clearTrigger);
    clearDialog = screen.getByRole("alertdialog", { name: "清空归集工作台？" });
    await user.click(within(clearDialog).getByRole("button", { name: "确认清空" }));
    expect(target).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "Token 清单" })).toHaveValue("");

    await user.type(target, targetAddress);
    await user.type(screen.getByRole("textbox", { name: "Token 清单" }), tokenAddress);
    await importEvmSecret(user);
    expect(screen.getByRole("button", { name: "确认并开始归集" })).toBeEnabled();
  });

  it("maps a submitted hash followed by interruption to uncertain and locks retry", async () => {
    evmMocks.execute.mockImplementationOnce(async ({ onProgress }) => {
      onProgress?.({
        address: planItem.address,
        amount: planItem.amount,
        completed: 0,
        hash: transactionHash,
        id: planItem.id,
        index: 0,
        label: planItem.label,
        message: "交易已提交",
        stage: "submitting",
        total: 1
      });
      throw new Error("interrupted");
    });
    const user = await prepareReadyErc20Page();
    await user.click(screen.getByRole("button", { name: "确认并开始归集" }));
    const dialog = screen.getByRole("alertdialog", { name: "确认 EVM 归集？" });
    await user.click(within(dialog).getByRole("button", { name: "确认并开始归集" }));

    await waitFor(() => expect(screen.getAllByText("需核对链上状态").length).toBeGreaterThan(0));
    expect(screen.getByRole("button", { name: "需先核对链上交易" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /重试失败项/ })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "目标地址" })).toBeDisabled();
    expect(evmMocks.assertNetwork).toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "清空工作台" }));
    const clearDialog = screen.getByRole("alertdialog", { name: "清空归集工作台？" });
    expect(within(clearDialog).getByText(/包含已提交的交易哈希/)).toBeInTheDocument();
    await user.click(within(clearDialog).getByRole("button", { name: "取消" }));
    expect(screen.getAllByText("需核对链上状态").length).toBeGreaterThan(0);
  });

  it("supports fixed amounts and passes execution settings without a preflight call", async () => {
    const user = await prepareReadyErc20Page();
    await user.click(screen.getByRole("tab", { name: "固定数量" }));
    const fixed = screen.getByRole("spinbutton", { name: "每钱包每资产固定归集数量" });
    await user.clear(fixed);
    await user.type(fixed, "0.25");
    await confirmEvmExecution(user);

    await waitFor(() => expect(evmMocks.execute).toHaveBeenCalledTimes(1));
    expect(evmMocks.preflight).not.toHaveBeenCalled();
    expect(evmMocks.execute.mock.calls[0][0].plan[0].amount).toBe(250_000_000_000_000_000n);
  });

  it("executes once, keeps the source wallet and renders status inline", async () => {
    evmMocks.execute.mockImplementationOnce(async ({ getWalletClient, plan }) => {
      await getWalletClient(plan[0].account, plan[0]);
      return [{
        address: planItem.address,
        amount: planItem.amount,
        asset: planItem.asset,
        hash: transactionHash,
        id: planItem.id,
        label: planItem.label,
        message: "已确认",
        retryable: false,
        status: "success"
      }];
    });

    const user = await prepareReadyErc20Page();
    await user.click(screen.getByRole("button", { name: "确认并开始归集" }));
    const dialog = screen.getByRole("alertdialog", { name: "确认 EVM 归集？" });
    await user.click(within(dialog).getByRole("button", { name: "确认并开始归集" }));

    await waitFor(() => expect(evmMocks.execute).toHaveBeenCalledTimes(1));
    expect(evmMocks.plan).toHaveBeenCalledTimes(1);
    expect(evmMocks.preflight).not.toHaveBeenCalled();
    expect(evmMocks.createWalletClient).toHaveBeenCalledTimes(1);
    expect(evmMocks.execute.mock.calls[0][0].plan).toEqual([
      expect.objectContaining({
        address: planItem.address,
        amount: planItem.amount,
        amountPolicy: { mode: "all" },
        id: planItem.id
      })
    ]);
    expect(evmMocks.execute.mock.calls[0][0].gasSettings).toEqual({ mode: "auto" });
    expect(await screen.findByText(/本轮完成：1 项确认成功/)).toBeInTheDocument();
    expect(screen.getAllByText("已完成").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("已导入来源钱包")).toBeVisible();
    expect(screen.getByRole("link", { name: "查看交易" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "继续使用当前设置" }));
    expect(screen.getByRole("textbox", { name: "目标地址" })).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "目标地址" })).toHaveValue(targetAddress);
    expect(screen.getByRole("textbox", { name: "Token 清单" })).toHaveValue(tokenAddress);
    expect(screen.getByLabelText("已导入来源钱包")).toBeVisible();
    expect(screen.getByText("上一轮结果 · 第 1 轮")).toBeInTheDocument();
    expect(screen.queryByText(/新建任务/)).not.toBeInTheDocument();
  });

  it("archives the round and keeps only unresolved NFT assets for the next round", async () => {
    const firstAsset = {
      contractAddress: tokenAddress,
      key: `erc721:${tokenAddress.toLowerCase()}:1`,
      standard: "erc721" as const,
      tokenId: 1n
    };
    const secondAsset = {
      ...firstAsset,
      key: `erc721:${tokenAddress.toLowerCase()}:2`,
      tokenId: 2n
    };
    evmMocks.discoverEnumerable.mockResolvedValueOnce({
      assets: [firstAsset, secondAsset],
      issues: [],
      owners: [{
        balance: 2n,
        discovered: 2,
        ownerAddress: sourceAddress,
        scanned: 2,
        status: "complete"
      }],
      rpcRequests: 8,
      snapshotBlock: 100n
    });
    const nftPlan = [firstAsset, secondAsset].map((asset, index) => ({
      account: signerAccount,
      address: signerAccount.address,
      amount: 1n,
      asset,
      id: `nft-plan-${index + 1}`,
      label: "来源一",
      message: "已确认 NFT 所有权",
      status: "ready" as const
    })) satisfies EvmCollectionPlanItem[];
    evmMocks.plan.mockResolvedValueOnce(nftPlan);
    evmMocks.execute.mockResolvedValueOnce([
      {
        address: signerAccount.address,
        amount: 1n,
        asset: firstAsset,
        hash: transactionHash,
        id: nftPlan[0].id,
        label: "来源一",
        message: "已确认",
        retryable: false,
        status: "success"
      },
      {
        address: signerAccount.address,
        amount: 1n,
        asset: secondAsset,
        hash: null,
        id: nftPlan[1].id,
        label: "来源一",
        message: "网络费不足",
        retryable: false,
        status: "failed"
      }
    ]);

    const user = await discoverNft();
    expect(await screen.findByText("2 个有效")).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "来源密钥" }));
    await importEvmSecret(user);
    await user.type(screen.getByRole("textbox", { name: "目标地址" }), targetAddress);
    await confirmEvmExecution(user);

    expect(await screen.findByRole("heading", { name: "本轮资产结果" })).toBeVisible();
    expect(screen.getByText("完成 1")).toBeVisible();
    expect(screen.getByText("需处理 1")).toBeVisible();
    expect(screen.queryByRole("checkbox", { name: "选择全部" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "整理本轮，继续下一轮" }));
    const inventory = screen.getByRole("table", { name: "ERC721 待归集资产清单" });
    expect(within(inventory).queryByText("1")).not.toBeInTheDocument();
    expect(within(inventory).getByText("2")).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "选择全部" })).toBeVisible();
    expect(screen.getByText("上一轮结果 · 第 1 轮")).toBeVisible();
    expect(screen.getByRole("button", { name: "再次识别" })).toBeEnabled();
  });

  it("keeps mixed results inline and offers safe retry", async () => {
    const stablePlan = [planItem, secondPlanItem];
    evmMocks.plan.mockResolvedValue(stablePlan);
    evmMocks.execute.mockResolvedValueOnce([
      {
        address: planItem.address,
        amount: planItem.amount,
        asset: planItem.asset,
        hash: transactionHash,
        id: planItem.id,
        label: planItem.label,
        message: "归集成功",
        retryable: false,
        status: "success"
      },
      {
        address: planItem.address,
        amount: secondPlanItem.amount,
        asset: secondPlanItem.asset,
        hash: null,
        id: secondPlanItem.id,
        label: secondPlanItem.label,
        message: "提交失败",
        retryable: true,
        status: "failed"
      }
    ]);
    const user = await prepareReadyErc20Page(tokenAddress + "\n" + secondTokenAddress);
    await confirmEvmExecution(user);

    expect(await screen.findByText(/本轮完成：1 项确认成功，1 项失败/)).toBeInTheDocument();
    const walletList = screen.getByLabelText("已导入来源钱包");
    expect(within(walletList).getByText(/TOK · 1/)).toBeVisible();
    expect(within(walletList).getByText(/TOK2 · 1/)).toBeVisible();
    expect(within(walletList).getByText("失败")).toBeVisible();
    expect(screen.getAllByText("需核对链上状态").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "重试失败项 (1)" })).toBeEnabled();
  });

  it("exposes the complete status mapping, including hash uncertainty", () => {
    const failedWithHash = [{
      address: sourceAddress,
      amount: "1",
      asset: "TOK",
      hash: transactionHash,
      message: "待核对",
      status: "error" as const
    }];
    expect(getEvmCollectionWorkbenchStatus("scanning", [])).toBe("preflight");
    expect(getEvmCollectionWorkbenchStatus("ready", [])).toBe("ready");
    expect(getEvmCollectionWorkbenchStatus("running", [])).toBe("running");
    expect(getEvmCollectionWorkbenchStatus("complete", [])).toBe("success");
    expect(getEvmCollectionWorkbenchStatus("error", failedWithHash)).toBe("uncertain");
    expect(hasEvmCollectionPlanDrift([planItem], [{ ...planItem }])).toBe(false);
    expect(hasEvmCollectionPlanDrift([planItem], [{ ...planItem, amount: planItem.amount + 1n }])).toBe(true);
  });
});
