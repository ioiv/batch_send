// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvmCollectionPlanItem } from "../lib/evm-collection";

const evmMocks = vi.hoisted(() => ({
  assertNetwork: vi.fn(),
  createWalletClient: vi.fn(),
  discoverEnumerable: vi.fn(),
  execute: vi.fn(),
  inspectContract: vi.fn(),
  plan: vi.fn(),
  preflight: vi.fn()
}));

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return { ...actual, createWalletClient: evmMocks.createWalletClient };
});

vi.mock("../lib/evm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/evm")>();
  return { ...actual, assertEvmRpcNetwork: evmMocks.assertNetwork };
});

vi.mock("../lib/evm-collection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/evm-collection")>();
  return {
    ...actual,
    executeEvmCollectionPlan: evmMocks.execute,
    planEvmCollection: evmMocks.plan,
    preflightEvmCollectionPlan: evmMocks.preflight
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

import {
  EvmCollectionPage,
  getEvmCollectionWorkbenchStatus,
  hasEvmCollectionPlanDrift
} from "./EvmCollectionPage";

const sourceAddress = "0x0000000000000000000000000000000000000003";
const targetAddress = "0x0000000000000000000000000000000000000001";
const tokenAddress = "0x0000000000000000000000000000000000000002";
const secondTokenAddress = "0x0000000000000000000000000000000000000004";
const privateKey = ("0x" + "11".repeat(32)) as `0x${string}`;
const signerAccount = privateKeyToAccount(privateKey);
const transactionHash = "0x" + "ab".repeat(32);
const planItem = {
  account: signerAccount,
  address: sourceAddress,
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
  evmMocks.assertNetwork.mockResolvedValue(undefined);
  evmMocks.createWalletClient.mockReturnValue({});
  evmMocks.plan.mockResolvedValue([planItem]);
  evmMocks.preflight.mockResolvedValue({
    estimatedNetworkFee: 1_000_000_000_000n,
    executableTransactions: 1,
    plan: [planItem]
  });
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
});

async function prepareReadyErc20Page(assetInput = tokenAddress) {
  const user = userEvent.setup();
  render(<EvmCollectionPage fixedStandard="erc20" />);
  await user.type(screen.getByRole("textbox", { name: "目标地址" }), targetAddress);
  await user.type(screen.getByRole("textbox", { name: "Token 清单" }), assetInput);
  await user.type(screen.getByRole("textbox", { name: "来源钱包密钥" }), privateKey);
  await user.click(screen.getByRole("button", { name: "预检资产与费用" }));
  await screen.findByRole("button", { name: "确认并开始归集" });
  return user;
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

describe("EvmCollectionPage workbench", () => {
  it("renders source-mode and standard controls without legacy steps or promotion copy", () => {
    render(<EvmCollectionPage fixedStandard="nft" />);

    expect(screen.getByRole("heading", { name: "EVM NFT 归集", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "只读地址" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "来源密钥" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "ERC721" })).toBeInTheDocument();
    expect(screen.getAllByRole("textbox", { name: "NFT 合约" })).toHaveLength(1);
    expect(screen.getByText("编辑中")).toBeInTheDocument();
    expect(screen.queryByText(/下一步|预检准备项|平台费 0|不上传密钥|密钥仅在本地内存/)).not.toBeInTheDocument();
  });

  it("shows a blocking error when asset and transaction preflight has no executable item", async () => {
    const failedPlanItem = {
      ...planItem,
      message: "模拟失败",
      status: "failed" as const
    };
    evmMocks.preflight.mockResolvedValueOnce({
      estimatedNetworkFee: 0n,
      executableTransactions: 0,
      plan: [failedPlanItem]
    });
    const user = userEvent.setup();
    render(<EvmCollectionPage fixedStandard="erc20" />);
    await user.type(screen.getByRole("textbox", { name: "目标地址" }), targetAddress);
    await user.type(screen.getByRole("textbox", { name: "Token 清单" }), tokenAddress);
    await user.type(screen.getByRole("textbox", { name: "来源钱包密钥" }), privateKey);
    await user.click(screen.getByRole("button", { name: "预检资产与费用" }));

    expect(await screen.findByText(/没有可执行项/)).toBeInTheDocument();
    expect(screen.getAllByText("需要处理").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "确认并开始归集" })).not.toBeInTheDocument();
    expect(evmMocks.execute).not.toHaveBeenCalled();
  });

  it("keeps complete discovery results out of the asset table until explicitly added", async () => {
    const user = await discoverNft();
    expect(await screen.findByRole("button", { name: "加入资产清单" })).toBeInTheDocument();
    expect(screen.getByText("暂无资产")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "加入资产清单" }));
    expect(await screen.findByText("1 个有效")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "ERC721 待归集资产清单" })).toBeInTheDocument();
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

  it("cancels execution, invalidates a ready preflight on edit, and confirms clearing", async () => {
    const user = await prepareReadyErc20Page();
    await user.click(screen.getByRole("button", { name: "确认并开始归集" }));
    const executeDialog = screen.getByRole("alertdialog", { name: "确认 EVM 归集？" });
    await user.click(within(executeDialog).getByRole("button", { name: "取消" }));
    expect(evmMocks.execute).not.toHaveBeenCalled();

    const target = screen.getByRole("textbox", { name: "目标地址" });
    await user.clear(target);
    await user.type(target, targetAddress);
    expect(screen.getByText("编辑中")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认并开始归集" })).not.toBeInTheDocument();

    const clearTrigger = screen.getByRole("button", { name: "清空任务" });
    await user.click(clearTrigger);
    let clearDialog = screen.getByRole("alertdialog", { name: "清空当前归集任务？" });
    await user.click(within(clearDialog).getByRole("button", { name: "取消" }));
    expect(target).toHaveValue(targetAddress);

    await user.click(clearTrigger);
    clearDialog = screen.getByRole("alertdialog", { name: "清空当前归集任务？" });
    await user.click(within(clearDialog).getByRole("button", { name: "清空任务" }));
    expect(target).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "Token 清单" })).toHaveValue("");

    await user.type(target, targetAddress);
    await user.type(screen.getByRole("textbox", { name: "Token 清单" }), tokenAddress);
    await user.type(screen.getByRole("textbox", { name: "来源钱包密钥" }), privateKey);
    await user.click(screen.getByRole("button", { name: "预检资产与费用" }));
    expect(await screen.findByRole("button", { name: "确认并开始归集" })).toBeEnabled();
  });

  it("maps a submitted hash followed by interruption to uncertain and locks retry", async () => {
    evmMocks.execute.mockImplementationOnce(async ({ onProgress }) => {
      onProgress?.({
        address: sourceAddress,
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
    expect(screen.getByRole("button", { name: "请先核对链上结果" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "目标地址" })).toBeDisabled();
    expect(evmMocks.assertNetwork).toHaveBeenCalledTimes(2);

    await user.click(screen.getByRole("button", { name: "清空任务" }));
    const clearDialog = screen.getByRole("alertdialog", { name: "清空当前归集任务？" });
    expect(within(clearDialog).getByText(/包含已提交的交易哈希/)).toBeInTheDocument();
    await user.click(within(clearDialog).getByRole("button", { name: "取消" }));
    expect(screen.getAllByText("需核对链上状态").length).toBeGreaterThan(0);
  });

  it("blocks wallet-client creation when the fresh ownership plan drifts", async () => {
    const driftedPlanItem = {
      ...planItem,
      amount: planItem.amount + 1n,
      message: "签名前余额已变化"
    };
    evmMocks.plan
      .mockResolvedValueOnce([planItem])
      .mockResolvedValueOnce([driftedPlanItem]);
    evmMocks.preflight
      .mockResolvedValueOnce({
        estimatedNetworkFee: 1_000_000_000_000n,
        executableTransactions: 1,
        plan: [planItem]
      })
      .mockResolvedValueOnce({
        estimatedNetworkFee: 2_000_000_000_000n,
        executableTransactions: 1,
        plan: [driftedPlanItem]
      });

    const user = await prepareReadyErc20Page();
    await user.click(screen.getByRole("button", { name: "确认并开始归集" }));
    const dialog = screen.getByRole("alertdialog", { name: "确认 EVM 归集？" });
    await user.click(within(dialog).getByRole("button", { name: "确认并开始归集" }));

    expect(await screen.findByText(/资产余额、所有权或可执行交易已变化/)).toBeVisible();
    expect(evmMocks.plan).toHaveBeenCalledTimes(2);
    expect(evmMocks.preflight).toHaveBeenCalledTimes(2);
    expect(evmMocks.execute).not.toHaveBeenCalled();
    expect(evmMocks.createWalletClient).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "重新导入来源密钥" })).toBeEnabled();
  });

  it("continues with the freshly checked plan when its safety fingerprint is stable", async () => {
    evmMocks.execute.mockImplementationOnce(async ({ getWalletClient, plan }) => {
      await getWalletClient(plan[0].account, plan[0]);
      return [{
        address: sourceAddress,
        amount: planItem.amount,
        asset: planItem.asset,
        hash: transactionHash,
        id: planItem.id,
        label: planItem.label,
        message: "已确认",
        status: "success"
      }];
    });

    const user = await prepareReadyErc20Page();
    await user.click(screen.getByRole("button", { name: "确认并开始归集" }));
    const dialog = screen.getByRole("alertdialog", { name: "确认 EVM 归集？" });
    await user.click(within(dialog).getByRole("button", { name: "确认并开始归集" }));

    await waitFor(() => expect(evmMocks.execute).toHaveBeenCalledTimes(1));
    expect(evmMocks.plan).toHaveBeenCalledTimes(2);
    expect(evmMocks.preflight).toHaveBeenCalledTimes(2);
    expect(evmMocks.createWalletClient).toHaveBeenCalledTimes(1);
    expect(evmMocks.execute.mock.calls[0][0].plan).toEqual([planItem]);
    expect(await screen.findByText(/执行结束：1 笔确认成功/)).toBeInTheDocument();
    expect(screen.getAllByText("已完成").length).toBeGreaterThan(0);
    expect(screen.getByRole("textbox", { name: "来源钱包密钥" })).toHaveValue("");
    expect(screen.getByRole("link", { name: "查看来源一的交易" })).toBeInTheDocument();
  });

  it("keeps mixed success and failure results visible and blocks blind retry", async () => {
    const stablePlan = [planItem, secondPlanItem];
    evmMocks.plan.mockResolvedValue(stablePlan);
    evmMocks.preflight.mockResolvedValue({
      estimatedNetworkFee: 2_000_000_000_000n,
      executableTransactions: 2,
      plan: stablePlan
    });
    evmMocks.execute.mockResolvedValueOnce([
      {
        address: sourceAddress,
        amount: planItem.amount,
        asset: planItem.asset,
        hash: transactionHash,
        id: planItem.id,
        label: planItem.label,
        message: "归集成功",
        status: "success"
      },
      {
        address: sourceAddress,
        amount: secondPlanItem.amount,
        asset: secondPlanItem.asset,
        hash: null,
        id: secondPlanItem.id,
        label: secondPlanItem.label,
        message: "提交失败",
        status: "failed"
      }
    ]);
    const user = await prepareReadyErc20Page(tokenAddress + "\n" + secondTokenAddress);
    await confirmEvmExecution(user);

    expect(await screen.findByText(/执行结束：1 笔确认成功，1 笔失败/)).toBeInTheDocument();
    const resultRows = screen.getAllByRole("row");
    expect(resultRows.some((row) => row.textContent?.includes("TOK") && row.textContent.includes("已完成"))).toBe(true);
    expect(resultRows.some((row) => row.textContent?.includes("TOK2") && row.textContent.includes("失败"))).toBe(true);
    expect(screen.getAllByText("需核对链上状态").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "请先核对链上结果" })).toBeDisabled();
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
