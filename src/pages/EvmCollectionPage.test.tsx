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
  discoverCandidates: vi.fn(),
  discoverEnumerable: vi.fn(),
  discoverRange: vi.fn(),
  execute: vi.fn(),
  getBalance: vi.fn(),
  getLiveGas: vi.fn(),
  inspectContract: vi.fn(),
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

vi.mock("../lib/erc721-token-range-discovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/erc721-token-range-discovery")>();
  return { ...actual, discoverErc721AssetsByTokenRange: evmMocks.discoverRange };
});

vi.mock("../lib/nft-candidate-discovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/nft-candidate-discovery")>();
  return { ...actual, discoverNftAssetsFromCandidates: evmMocks.discoverCandidates };
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
  vi.restoreAllMocks();
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
  evmMocks.discoverRange.mockResolvedValue({
    assets: [{
      contractAddress: tokenAddress,
      key: "erc721:" + tokenAddress.toLowerCase() + ":1",
      standard: "erc721",
      tokenId: 1n
    }],
    complete: true,
    expectedBalance: 1n,
    issues: [],
    range: { fromTokenId: 0n, source: "totalSupply", toTokenId: 10n },
    rpcRequests: 5,
    scanned: 2,
    snapshotBlock: 100n
  });
  evmMocks.discoverCandidates.mockResolvedValue({
    assets: [],
    candidateCount: 0,
    complete: false,
    eventScanComplete: false,
    expectedBalance: 1n,
    issues: [{ code: "log-scan-failed", message: "测试事件扫描不可用" }],
    openSeaComplete: false,
    openSeaUsed: false,
    snapshotBlock: 100n,
    sources: ["transfer-events"]
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
  await importEvmSecret(user);
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

  it("keeps ERC20 balances when a wallet's native balance lookup fails", async () => {
    const user = userEvent.setup();
    render(<EvmCollectionPage fixedStandard="erc20" />);

    await importEvmSecret(user);
    await user.type(screen.getByRole("textbox", { name: "Token 清单" }), tokenAddress);
    await waitFor(() => expect(evmMocks.readMetadata).toHaveBeenCalled(), { timeout: 1_500 });
    evmMocks.getBalance.mockRejectedValueOnce(new Error("native balance unavailable"));
    await user.click(screen.getByRole("button", { name: "查看地址余额" }));

    const walletList = screen.getByLabelText("已导入来源钱包");
    const walletRow = within(walletList).getByTitle(signerAccount.address).closest('[role="listitem"]') as HTMLElement;
    expect(await within(walletRow).findByText("读取失败")).toBeVisible();
    expect(within(walletRow).getByText("ETH")).toBeVisible();
    expect(within(walletRow).getByText("2")).toBeVisible();
    expect(within(walletRow).getByText("TOK")).toBeVisible();
    expect(evmMocks.readContract).toHaveBeenCalledWith(expect.objectContaining({
      args: [signerAccount.address],
      functionName: "balanceOf"
    }));
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

  it("uses checked private-key wallets and offers automatic plus manual NFT entry", () => {
    render(<EvmCollectionPage fixedStandard="nft" />);

    expect(screen.getByRole("heading", { name: "EVM NFT 归集", level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "只读地址" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导入钱包" })).toBeVisible();
    expect(screen.queryByRole("tab", { name: "ERC721" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "ERC1155" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "手工 / 文件" })).toBeVisible();
    expect(screen.getAllByRole("textbox", { name: "NFT 合约" })).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "归集全部" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "指定总数量" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("编辑中")).toBeInTheDocument();
    expect(screen.queryByText(/下一步|预检准备项|平台费 0|不上传密钥|密钥仅在本地内存/)).not.toBeInTheDocument();
  });

  it("places NFT source keys above discovery and exposes manual Token ID entry on demand", async () => {
    const user = userEvent.setup();
    render(<EvmCollectionPage fixedStandard="nft" />);

    const walletImport = screen.getByRole("button", { name: "导入钱包" });
    const nftContract = screen.getByRole("textbox", { name: "NFT 合约" });

    expect(walletImport.compareDocumentPosition(nftContract) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(screen.getByRole("tab", { name: "手工 / 文件" })).toBeVisible();
    expect(screen.queryByLabelText("Token ID / 区间")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "识别持仓" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "发现方式与事件范围" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist", { name: "NFT 发现方式" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("事件起始区块")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "手工 / 文件" }));
    expect(screen.getByLabelText("Token ID / 区间")).toBeVisible();
    expect(screen.getByRole("tab", { name: "ERC721" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "ERC1155" })).toBeVisible();
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

  it("summarizes complete discovery results in the source wallet row", async () => {
    const user = await discoverNft();
    const walletList = screen.getByLabelText("已导入来源钱包");
    expect(await within(walletList).findByText("ERC721")).toBeVisible();
    const walletRow = within(walletList).getByTitle(signerAccount.address).closest('[role="listitem"]') as HTMLElement;
    const walletBalances = within(walletRow).getByLabelText(`${signerAccount.address} 余额`);
    expect(within(walletBalances).getByText("3")).toBeVisible();
    expect([...walletBalances.querySelectorAll("small")].map((item) => item.textContent)).toEqual(["ETH", "ERC721"]);
    expect(within(walletBalances).getByText("1")).toBeVisible();
    expect(screen.queryByRole("table", { name: /待归集资产清单/ })).not.toBeInTheDocument();
    expect(screen.getByText(/共有 1 个可归集 ERC721/)).toHaveAttribute("role", "status");
    expect(screen.getByLabelText("归集数量说明")).toHaveTextContent("?");
    expect(screen.queryByText(/归集全部：归集所有已识别的 ERC721/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "再次识别" })).toBeEnabled();
    expect(evmMocks.discoverEnumerable).toHaveBeenCalledTimes(1);
    expect(evmMocks.getBalance).toHaveBeenCalledWith({ address: signerAccount.address });
    expect(screen.getByRole("tab", { name: "指定总数量" })).toBeEnabled();

    await user.type(screen.getByRole("textbox", { name: "目标地址" }), targetAddress);
    expect(screen.getByRole("button", { name: "确认并开始归集" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "再次识别" }));
    await waitFor(() => expect(evmMocks.discoverEnumerable).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "确认并开始归集" })).toBeEnabled();
  });

  it("shows each checked wallet's ERC721 count and keeps NFT concurrency user-controlled", async () => {
    evmMocks.discoverEnumerable.mockResolvedValueOnce({
      assets: [
        {
          contractAddress: tokenAddress,
          key: `erc721:${tokenAddress.toLowerCase()}:1`,
          ownerAddress: signerAccount.address,
          standard: "erc721",
          tokenId: 1n
        },
        ...[2n, 3n].map((tokenId) => ({
          contractAddress: tokenAddress,
          key: `erc721:${tokenAddress.toLowerCase()}:${tokenId}`,
          ownerAddress: secondSignerAccount.address,
          standard: "erc721" as const,
          tokenId
        }))
      ],
      issues: [],
      owners: [
        {
          balance: 1n,
          discovered: 1,
          ownerAddress: signerAccount.address,
          scanned: 1,
          status: "complete"
        },
        {
          balance: 2n,
          discovered: 2,
          ownerAddress: secondSignerAccount.address,
          scanned: 2,
          status: "complete"
        }
      ],
      rpcRequests: 9,
      snapshotBlock: 100n
    });

    const user = userEvent.setup();
    render(<EvmCollectionPage fixedStandard="nft" />);
    await importEvmSecret(user);
    await importEvmSecret(user, secondPrivateKey);
    await user.type(screen.getByRole("textbox", { name: "NFT 合约" }), tokenAddress);
    await user.click(screen.getByRole("button", { name: "识别持仓" }));

    const walletList = screen.getByLabelText("已导入来源钱包");
    const firstRow = within(walletList).getByTitle(signerAccount.address).closest('[role="listitem"]') as HTMLElement;
    const secondRow = within(walletList).getByTitle(secondSignerAccount.address).closest('[role="listitem"]') as HTMLElement;
    expect(await within(firstRow).findByText("1")).toBeVisible();
    expect(within(secondRow).getByText("2")).toBeVisible();
    expect(screen.getByText(/共有 3 个可归集 ERC721/)).toBeVisible();
    const concurrencyInput = screen.getByRole("spinbutton", { name: "并发钱包数" });
    expect(concurrencyInput).toBeEnabled();
    expect(concurrencyInput).toHaveValue(3);
    await user.clear(concurrencyInput);
    await user.type(concurrencyInput, "9");
    expect(concurrencyInput).toHaveValue(9);

    expect(screen.getByLabelText("并发钱包数说明")).toHaveTextContent("?");
  });

  it("keeps NFT holdings when one wallet's native balance lookup fails", async () => {
    evmMocks.getBalance.mockImplementation(async ({ address }: { address: string }) => {
      if (address.toLowerCase() === signerAccount.address.toLowerCase()) {
        throw new Error("native balance unavailable");
      }
      return 2_000_000_000_000_000_000n;
    });
    evmMocks.discoverEnumerable.mockResolvedValueOnce({
      assets: [
        {
          contractAddress: tokenAddress,
          key: `erc721:${tokenAddress.toLowerCase()}:1`,
          ownerAddress: signerAccount.address,
          standard: "erc721",
          tokenId: 1n
        },
        {
          contractAddress: tokenAddress,
          key: `erc721:${tokenAddress.toLowerCase()}:2`,
          ownerAddress: secondSignerAccount.address,
          standard: "erc721",
          tokenId: 2n
        }
      ],
      issues: [],
      owners: [
        {
          balance: 1n,
          discovered: 1,
          ownerAddress: signerAccount.address,
          scanned: 1,
          status: "complete"
        },
        {
          balance: 1n,
          discovered: 1,
          ownerAddress: secondSignerAccount.address,
          scanned: 1,
          status: "complete"
        }
      ],
      rpcRequests: 8,
      snapshotBlock: 100n
    });

    const user = userEvent.setup();
    render(<EvmCollectionPage fixedStandard="nft" />);
    await importEvmSecret(user);
    await importEvmSecret(user, secondPrivateKey);
    await user.type(screen.getByRole("textbox", { name: "NFT 合约" }), tokenAddress);
    await user.click(screen.getByRole("button", { name: "识别持仓" }));

    const walletList = screen.getByLabelText("已导入来源钱包");
    const firstRow = within(walletList).getByTitle(signerAccount.address).closest('[role="listitem"]') as HTMLElement;
    const secondRow = within(walletList).getByTitle(secondSignerAccount.address).closest('[role="listitem"]') as HTMLElement;
    expect(await within(firstRow).findByText("读取失败")).toBeVisible();
    expect(within(firstRow).getByText("ETH")).toBeVisible();
    expect(within(firstRow).getByText("ERC721")).toBeVisible();
    expect(within(firstRow).getByText("1")).toBeVisible();
    expect(within(secondRow).getByText("2")).toBeVisible();
    expect(within(secondRow).getByText("ETH")).toBeVisible();
    expect(within(secondRow).getByText("ERC721")).toBeVisible();
    expect(screen.getByText(/共有 2 个可归集 ERC721/)).toBeVisible();
  });

  it("persists and restores the OpenSea key while passing it to ordinary ERC721 discovery", async () => {
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
    evmMocks.discoverCandidates.mockResolvedValueOnce({
      assets: [{
        contractAddress: tokenAddress,
        key: `erc721:${tokenAddress.toLowerCase()}:42`,
        standard: "erc721",
        tokenId: 42n
      }],
      candidateCount: 1,
      complete: true,
      eventScanComplete: false,
      expectedBalance: 1n,
      issues: [],
      openSeaComplete: true,
      openSeaUsed: true,
      snapshotBlock: 100n,
      sources: ["opensea"]
    });
    const user = userEvent.setup();
    const view = render(<EvmCollectionPage fixedStandard="nft" />);
    const openSeaKeyInput = screen.getByLabelText("OpenSea Key");
    expect(openSeaKeyInput).toHaveAttribute("type", "text");
    expect(openSeaKeyInput).toHaveAttribute("data-masked", "true");
    await user.click(screen.getByRole("button", { name: "显示 OpenSea Key" }));
    expect(openSeaKeyInput).not.toHaveAttribute("data-masked");
    expect(screen.getByRole("button", { name: "隐藏 OpenSea Key" })).toHaveAttribute("aria-pressed", "true");
    await importEvmSecret(user);
    await user.type(screen.getByRole("textbox", { name: "NFT 合约" }), tokenAddress);
    await user.type(openSeaKeyInput, "temporary-opensea-key");
    await user.click(screen.getByRole("button", { name: "识别持仓" }));

    await waitFor(() => expect(evmMocks.discoverCandidates).toHaveBeenCalledWith(expect.objectContaining({
      chainId: 1,
      openSeaApiKey: "temporary-opensea-key",
      ownerAddresses: [signerAccount.address]
    })));
    expect(await within(screen.getByLabelText("已导入来源钱包")).findByText("1")).toBeVisible();
    expect(window.localStorage.getItem("chainkit.opensea-api-key.v1")).toBe("temporary-opensea-key");

    view.unmount();
    render(<EvmCollectionPage fixedStandard="nft" />);
    expect(screen.getByLabelText("OpenSea Key")).toHaveValue("temporary-opensea-key");
  });

  it("keeps the OpenSea key editable on unsupported networks and explains RPC-only discovery", async () => {
    window.localStorage.setItem("batch-send.preferred-evm-network.v1", "robinhood");
    const user = userEvent.setup();
    render(<EvmCollectionPage fixedStandard="nft" />);

    const openSeaKeyInput = screen.getByLabelText("OpenSea Key");
    expect(openSeaKeyInput).toBeEnabled();
    expect(openSeaKeyInput).toHaveAttribute("placeholder", "仅保存，当前链使用 RPC");
    expect(screen.getByRole("button", { name: "显示 OpenSea Key" })).toBeEnabled();
    expect(screen.getByText("当前网络不支持 OpenSea；Key 仅保存，持仓识别使用 RPC。")).toHaveClass("sr-only");

    await user.type(openSeaKeyInput, "chrome-compatible-key");
    expect(openSeaKeyInput).toHaveValue("chrome-compatible-key");
    expect(window.localStorage.getItem("chainkit.opensea-api-key.v1")).toBe("chrome-compatible-key");
  });

  it("discovers ERC1155 holdings and does not fall back to ERC721 range probing", async () => {
    evmMocks.inspectContract.mockResolvedValueOnce({
      address: tokenAddress,
      enumerable: false,
      issues: [],
      name: "Multi Collection",
      snapshotBlock: 100n,
      standard: "erc1155",
      symbol: "MULTI"
    });
    evmMocks.discoverCandidates.mockResolvedValueOnce({
      assets: [{
        contractAddress: tokenAddress,
        key: `erc1155:${tokenAddress.toLowerCase()}:9`,
        standard: "erc1155",
        tokenId: 9n
      }],
      candidateCount: 1,
      complete: true,
      eventScanComplete: true,
      expectedBalance: null,
      holdings: [{
        balance: 4n,
        contractAddress: tokenAddress,
        ownerAddress: signerAccount.address,
        tokenId: 9n
      }],
      issues: [],
      openSeaComplete: false,
      openSeaUsed: false,
      snapshotBlock: 100n,
      sources: ["transfer-events"]
    });
    await discoverNft();

    expect(await screen.findByText(/共有 1 个 ERC1155 Token ID，合计 4 份/)).toBeVisible();
    expect(evmMocks.discoverCandidates).toHaveBeenCalledWith(expect.objectContaining({
      standard: "erc1155"
    }));
    expect(evmMocks.discoverRange).not.toHaveBeenCalled();
    const walletList = screen.getByLabelText("已导入来源钱包");
    expect(within(walletList).getByText("3")).toBeVisible();
    expect(within(walletList).getByText("ETH")).toBeVisible();
    expect(within(walletList).getByText("1 ID / 4")).toBeVisible();
    expect(screen.getByText("归集全部余额")).toBeVisible();
    expect(screen.getByRole("button", { name: "确认并开始归集" })).toBeDisabled();
  });

  it("executes ERC1155 assets and links their shared batch hash from wallet details", async () => {
    const assets = [9n, 10n].map((tokenId) => ({
      contractAddress: tokenAddress,
      key: `erc1155:${tokenAddress.toLowerCase()}:${tokenId}`,
      standard: "erc1155" as const,
      tokenId
    }));
    const erc1155Plan = assets.map((asset, index) => ({
      account: signerAccount,
      address: signerAccount.address,
      amount: index === 0 ? 4n : 2n,
      asset,
      id: `erc1155-manual-${asset.tokenId}`,
      label: "来源一",
      message: "已检测到可归集 NFT 余额",
      status: "ready" as const
    })) satisfies EvmCollectionPlanItem[];
    evmMocks.plan.mockResolvedValueOnce(erc1155Plan);
    evmMocks.execute.mockResolvedValueOnce(erc1155Plan.map((item) => ({
      address: item.address,
      amount: item.amount,
      asset: item.asset,
      hash: transactionHash,
      id: item.id,
      label: item.label,
      message: "ERC1155 批量归集交易已确认（2 个 Token ID）",
      retryable: false,
      status: "success" as const
    })));

    const user = userEvent.setup();
    render(<EvmCollectionPage fixedStandard="nft" />);
    await importEvmSecret(user);
    await user.type(screen.getByRole("textbox", { name: "NFT 合约" }), tokenAddress);
    await user.click(screen.getByRole("tab", { name: "手工 / 文件" }));
    await user.click(screen.getByRole("tab", { name: "ERC1155" }));
    await user.type(screen.getByLabelText("Token ID / 区间"), "9,10");
    await user.click(screen.getByRole("button", { name: "加入清单" }));
    await user.type(screen.getByRole("textbox", { name: "目标地址" }), targetAddress);
    await confirmEvmExecution(user);

    await waitFor(() => expect(evmMocks.execute).toHaveBeenCalledTimes(1));
    expect(evmMocks.plan).toHaveBeenCalledWith(expect.objectContaining({
      assets: [
        expect.objectContaining({ standard: "erc1155", tokenId: 9n }),
        expect.objectContaining({ standard: "erc1155", tokenId: 10n })
      ]
    }));
    expect(evmMocks.execute.mock.calls[0][0].plan).toEqual(erc1155Plan);

    const walletList = screen.getByLabelText("已导入来源钱包");
    expect(await within(walletList).findByText("ERC1155 · 2 个 Token ID")).toBeVisible();
    const batchLink = within(walletList).getByRole("link", { name: `查看交易 ${transactionHash}` });
    expect(batchLink).toHaveTextContent("0xabababab…ababab");
    await user.click(within(walletList).getByRole("button", { name: /归集详情/ }));
    const details = screen.getByRole("dialog", { name: "归集详情" });
    const hashLinks = within(details).getAllByRole("link", { name: `查看交易 ${transactionHash}` });
    expect(hashLinks).toHaveLength(2);
    hashLinks.forEach((link) => expect(link).toHaveTextContent("0xabababab…ababab"));
  });

  it("stops an in-progress direct Token ID scan without changing the asset inventory", async () => {
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
    evmMocks.discoverRange.mockResolvedValueOnce({
      assets: [],
      complete: false,
      expectedBalance: 1n,
      issues: [{ code: "range-required", message: "请填写范围" }],
      range: null,
      rpcRequests: 9,
      scanned: 0,
      snapshotBlock: 100n
    });
    const user = await discoverNft();
    expect(await screen.findByText("直接探测 Token ID")).toBeVisible();
    await user.type(screen.getByRole("spinbutton", { name: "起始 Token ID" }), "0");
    await user.type(screen.getByRole("spinbutton", { name: "结束 Token ID" }), "100");

    let observedSignal: AbortSignal | undefined;
    evmMocks.discoverRange.mockImplementationOnce(({ signal }: { signal?: AbortSignal }) => {
      observedSignal = signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    await user.click(screen.getByRole("button", { name: "探测 Token ID" }));
    await user.click(await screen.findByRole("button", { name: "停止探测" }));

    expect(await screen.findByText(/Token ID 探测已停止，现有持仓结果未修改/)).toBeVisible();
    expect(observedSignal?.aborted).toBe(true);
    expect(within(screen.getByLabelText("已导入来源钱包")).queryByText("ERC721")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "探测 Token ID" })).toBeEnabled();
  });

  it("directly probes ordinary ERC721 Token IDs without reading Transfer history", async () => {
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

    await discoverNft();
    await waitFor(() => expect(evmMocks.discoverRange).toHaveBeenCalledWith(expect.objectContaining({
      ownerAddresses: [signerAccount.address],
      snapshotBlock: 100n
    })));
    expect(await within(screen.getByLabelText("已导入来源钱包")).findByText("1")).toBeVisible();
    expect(screen.queryByText(/回溯|历史扫描/)).not.toBeInTheDocument();
  });

  it("asks for a direct Token ID range when no supply counter is available", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
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
    evmMocks.discoverRange
      .mockResolvedValueOnce({
        assets: [],
        complete: false,
        expectedBalance: 1n,
        issues: [{ code: "range-required", message: "请填写范围" }],
        range: null,
        rpcRequests: 9,
        scanned: 0,
        snapshotBlock: 100n
      })
      .mockResolvedValueOnce({
        assets: [{
          contractAddress: tokenAddress,
          key: "erc721:" + tokenAddress.toLowerCase() + ":42",
          standard: "erc721",
          tokenId: 42n
        }],
        complete: true,
        expectedBalance: 1n,
        issues: [],
        range: { fromTokenId: 40n, source: "manual", toTokenId: 45n },
        rpcRequests: 7,
        scanned: 3,
        snapshotBlock: 100n
      });

    const user = await discoverNft();
    expect(await screen.findByText(/合约没有可用计数器/)).toBeVisible();
    await user.type(screen.getByRole("spinbutton", { name: "起始 Token ID" }), "40");
    await user.type(screen.getByRole("spinbutton", { name: "结束 Token ID" }), "45");
    await user.click(screen.getByRole("button", { name: "探测 Token ID" }));

    await waitFor(() => expect(evmMocks.discoverRange).toHaveBeenLastCalledWith(expect.objectContaining({
      fromTokenId: 40n,
      toTokenId: 45n
    })));
    expect(await within(screen.getByLabelText("已导入来源钱包")).findByText("1")).toBeVisible();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("reconciles a repeated complete discovery and clears stale zero-holding rows", async () => {
    const user = await discoverNft();
    expect(await within(screen.getByLabelText("已导入来源钱包")).findByText("1")).toBeVisible();
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
    expect(await within(screen.getByLabelText("已导入来源钱包")).findByText("0")).toBeVisible();
    expect(within(screen.getByLabelText("已导入来源钱包")).getByText("3")).toBeVisible();
    expect(within(screen.getByLabelText("已导入来源钱包")).getByText("ETH")).toBeVisible();
    expect(screen.getByText(/当前没有该合约的可归集 ERC721/)).toHaveAttribute("role", "status");
    expect(screen.getByRole("button", { name: "确认并开始归集" })).toBeDisabled();
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
    const trigger = await screen.findByRole("button", { name: "确认使用部分结果" });
    await user.click(trigger);
    let dialog = screen.getByRole("alertdialog", { name: "使用部分识别结果？" });
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(within(screen.getByLabelText("已导入来源钱包")).queryByText("ERC721")).not.toBeInTheDocument();

    await user.click(trigger);
    dialog = screen.getByRole("alertdialog", { name: "使用部分识别结果？" });
    await user.click(within(dialog).getByRole("button", { name: "确认使用部分结果" }));
    expect(await within(screen.getByLabelText("已导入来源钱包")).findByText("1")).toBeVisible();
    expect(within(screen.getByLabelText("已导入来源钱包")).getByText("3")).toBeVisible();
    expect(within(screen.getByLabelText("已导入来源钱包")).getByText("ETH")).toBeVisible();
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

  it("maps a submitted hash followed by interruption to uncertain without locking edits", async () => {
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
    expect(screen.queryByRole("button", { name: /重试失败项/ })).not.toBeInTheDocument();
    const target = screen.getByRole("textbox", { name: "目标地址" });
    expect(target).toBeEnabled();
    expect(evmMocks.assertNetwork).toHaveBeenCalled();

    await user.clear(target);
    await user.type(target, targetAddress);
    expect(screen.getByText("归集记录")).toBeVisible();
    expect(screen.getByRole("button", { name: "已核对，开始新任务" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "确认并开始归集" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "清空工作台" }));
    const clearDialog = screen.getByRole("alertdialog", { name: "清空归集工作台？" });
    expect(within(clearDialog).getByText(/包含已提交的交易哈希/)).toBeInTheDocument();
    await user.click(within(clearDialog).getByRole("button", { name: "取消" }));
    expect(screen.getByText("归集记录")).toBeVisible();
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
    expect(await screen.findByText(/归集完成：1 项确认成功/)).toBeInTheDocument();
    expect(screen.getAllByText("已完成").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("已导入来源钱包")).toBeVisible();
    expect(screen.getByRole("link", { name: "查看交易" })).toBeInTheDocument();

    const target = screen.getByRole("textbox", { name: "目标地址" });
    expect(target).toBeEnabled();
    await user.clear(target);
    await user.type(target, targetAddress);
    expect(target).toHaveValue(targetAddress);
    expect(screen.getByRole("textbox", { name: "Token 清单" })).toHaveValue(tokenAddress);
    expect(screen.getByLabelText("已导入来源钱包")).toBeVisible();
    expect(screen.getByText("归集记录")).toBeInTheDocument();
    expect(screen.queryByText(/新建任务/)).not.toBeInTheDocument();
  });

  it("summarizes NFT execution by wallet and refreshes counts on the next recognition", async () => {
    const firstAsset = {
      contractAddress: tokenAddress,
      key: `erc721:${tokenAddress.toLowerCase()}:1`,
      ownerAddress: signerAccount.address,
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
    expect(await within(screen.getByLabelText("已导入来源钱包")).findByText("2")).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "指定总数量" }));
    const nftTotal = screen.getByRole("spinbutton", { name: "ERC721 归集总数量" });
    await user.clear(nftTotal);
    await user.type(nftTotal, "2");
    await user.type(screen.getByRole("textbox", { name: "目标地址" }), targetAddress);
    await confirmEvmExecution(user);

    const walletList = screen.getByLabelText("已导入来源钱包");
    expect(await screen.findByText(/归集完成：1 项确认成功，1 项失败/)).toBeVisible();
    expect(await within(walletList).findByText("ERC721 · 2 个")).toBeVisible();
    expect(within(walletList).queryByText("成功 1 · 失败 1")).not.toBeInTheDocument();
    await user.click(within(walletList).getByRole("button", { name: /归集详情/ }));
    const details = screen.getByRole("dialog", { name: "归集详情" });
    expect(within(details).getByText("成功 1 · 失败 1")).toBeVisible();
    const hashLink = within(details).getByRole("link", { name: `查看交易 ${transactionHash}` });
    expect(hashLink).toHaveTextContent("0xabababab…ababab");
    expect(hashLink).toHaveAttribute("href", expect.stringContaining(transactionHash));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("table", { name: /待归集资产清单/ })).not.toBeInTheDocument();

    evmMocks.discoverEnumerable.mockResolvedValueOnce({
      assets: [secondAsset],
      issues: [],
      owners: [{
        balance: 1n,
        discovered: 1,
        ownerAddress: sourceAddress,
        scanned: 1,
        status: "complete"
      }],
      rpcRequests: 4,
      snapshotBlock: 101n
    });
    await user.click(screen.getByRole("button", { name: "再次识别" }));
    await screen.findByText(/持仓识别完成/);
    expect(within(walletList).getByText("1")).toBeVisible();
    expect(screen.getByText("归集记录")).toBeVisible();
    expect(screen.getByRole("button", { name: "再次识别" })).toBeEnabled();
    expect(screen.getByRole("spinbutton", { name: "ERC721 归集总数量" })).toHaveValue(1);
    expect(screen.getByRole("button", { name: "确认并开始归集" })).toBeEnabled();
  });

  it("validates an ERC721 total and collects all remaining items when live ownership is lower", async () => {
    const assets = [1n, 2n].map((tokenId) => ({
      contractAddress: tokenAddress,
      key: `erc721:${tokenAddress.toLowerCase()}:${tokenId}`,
      ownerAddress: signerAccount.address,
      standard: "erc721" as const,
      tokenId
    }));
    evmMocks.discoverEnumerable.mockResolvedValueOnce({
      assets,
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
    const nftPlan = assets.slice(0, 1).map((asset, index) => ({
      account: signerAccount,
      address: signerAccount.address,
      amount: 1n,
      asset,
      id: `retry-nft-${index + 1}`,
      label: "来源一",
      message: "已确认 NFT 所有权",
      status: "ready" as const
    })) satisfies EvmCollectionPlanItem[];
    evmMocks.plan.mockResolvedValueOnce(nftPlan);

    const user = await discoverNft();
    await user.click(screen.getByRole("tab", { name: "指定总数量" }));
    const totalInput = screen.getByRole("spinbutton", { name: "ERC721 归集总数量" });
    await user.clear(totalInput);
    await user.type(totalInput, "3");
    expect(screen.getByText("请输入 1–2 的整数")).toBeVisible();
    expect(screen.getByRole("button", { name: "确认并开始归集" })).toBeDisabled();
    await user.clear(totalInput);
    await user.type(totalInput, "2");
    await user.type(screen.getByRole("textbox", { name: "目标地址" }), targetAddress);
    await confirmEvmExecution(user);

    await waitFor(() => expect(evmMocks.execute).toHaveBeenCalledTimes(1));
    expect(evmMocks.execute.mock.calls[0][0].plan).toHaveLength(1);
    expect(evmMocks.execute.mock.calls[0][0].plan[0]).toEqual(expect.objectContaining({
      id: "retry-nft-1"
    }));
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

    expect(await screen.findByText(/归集完成：1 项确认成功，1 项失败/)).toBeInTheDocument();
    const walletList = screen.getByLabelText("已导入来源钱包");
    expect(within(walletList).getByText(/TOK · 1/)).toBeVisible();
    expect(within(walletList).getByText(/TOK2 · 1/)).toBeVisible();
    expect(within(walletList).getByText("失败")).toBeVisible();
    expect(document.querySelector(".workbench-status")).toHaveAttribute("data-state", "error");
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
