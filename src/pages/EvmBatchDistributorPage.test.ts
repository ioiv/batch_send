// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pageMocks = vi.hoisted(() => ({
  ensureNetwork: vi.fn(),
  getLiveGas: vi.fn(),
  getNativeBalance: vi.fn(),
  getTokenBalance: vi.fn(),
  getTokenDetails: vi.fn(),
  preflight: vi.fn(),
  providerRequest: vi.fn(),
  sendNative: vi.fn(),
  sendToken: vi.fn()
}));

vi.mock("../hooks/useEvmWallet", () => ({
  useEvmWallet: () => ({
    address: "0x00000000000000000000000000000000000000a1",
    buttonLabel: "断开钱包",
    chainIdHex: "0x1",
    connectWallet: vi.fn(),
    connected: true,
    disconnectWallet: vi.fn(),
    getProvider: () => ({ request: pageMocks.providerRequest }),
    message: "",
    providerName: "测试钱包",
    selectedWalletId: "test-wallet",
    selectWallet: vi.fn(),
    status: "connected",
    statusText: "测试钱包 · 已连接",
    wallets: []
  })
}));

vi.mock("../lib/evm-gas", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/evm-gas")>();
  return { ...actual, getLiveEvmFeeQuote: pageMocks.getLiveGas };
});

vi.mock("../lib/evm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/evm")>();
  return {
    ...actual,
    ensureEvmNetwork: pageMocks.ensureNetwork,
    getEvmNativeBalance: pageMocks.getNativeBalance,
    getEvmTokenBalance: pageMocks.getTokenBalance,
    getEvmTokenDetails: pageMocks.getTokenDetails,
    preflightEvmDistribution: pageMocks.preflight,
    sendEvmNativeDistribution: pageMocks.sendNative,
    sendEvmTokenDistribution: pageMocks.sendToken
  };
});

import {
  EvmBatchDistributorPage,
  getEvmDistributionSafetyState,
  runEvmDistributionSigningGate
} from "./EvmBatchDistributorPage";

const recipient = "0x00000000000000000000000000000000000000b1";
const secondRecipient = "0x00000000000000000000000000000000000000b2";
const connectedAccount = "0x00000000000000000000000000000000000000a1";
const switchedAccount = "0x00000000000000000000000000000000000000a2";
const tokenAddress = "0x00000000000000000000000000000000000000c1";
const transactionHash = "0x" + "ab".repeat(32);
const approvalHash = "0x" + "12".repeat(32);
const distributionHash = "0x" + "34".repeat(32);
const preflightResult = {
  assetBalanceWei: 10_000_000_000_000_000_000n,
  estimatedNetworkFeeWei: 100_000_000_000_000n,
  feeEstimateBasis: "rpc" as const,
  feeQuote: {
    gasPrice: 2_000_000_000n,
    sampledAt: 1_700_000_000_000,
    source: "rpc" as const,
    type: "legacy" as const
  },
  nativeBalanceWei: 10_000_000_000_000_000_000n,
  needsApproval: false,
  requiredNativeWei: 200_000_000_000_000_000n,
  totalTransactions: 1
};

afterEach(cleanup);

beforeEach(() => {
  window.history.replaceState({}, "", "/evm/");
  window.localStorage.clear();
  window.sessionStorage.clear();
  pageMocks.ensureNetwork.mockReset().mockResolvedValue(undefined);
  pageMocks.getLiveGas.mockReset().mockResolvedValue(preflightResult.feeQuote);
  pageMocks.getNativeBalance.mockReset().mockResolvedValue(preflightResult.nativeBalanceWei);
  pageMocks.getTokenBalance.mockReset().mockResolvedValue(1_000_000_000n);
  pageMocks.getTokenDetails.mockReset().mockResolvedValue({
    address: tokenAddress,
    decimals: 6,
    name: "Mock Token",
    symbol: "MOCK"
  });
  pageMocks.preflight.mockReset().mockResolvedValue(preflightResult);
  pageMocks.providerRequest.mockReset().mockImplementation(async ({ method }: { method: string }) => {
    if (method === "eth_accounts") return [connectedAccount];
    if (method === "eth_chainId") return "0x1";
    return null;
  });
  pageMocks.sendNative.mockReset().mockResolvedValue({ hash: transactionHash });
  pageMocks.sendToken.mockReset().mockResolvedValue({ hashes: [transactionHash] });
});

async function prepareReadyDistributionPage() {
  const user = userEvent.setup();
  render(createElement(EvmBatchDistributorPage));
  const addressInput = screen.getByRole("textbox", { name: "收款地址" });
  await user.type(addressInput, recipient);
  const preflightButton = screen.getByRole("button", { name: "运行预检" });
  await waitFor(() => expect(preflightButton).toBeEnabled());
  await user.click(preflightButton);
  await screen.findByRole("button", { name: "确认分发" });
  return { addressInput, user };
}

async function prepareReadyTokenDistributionPage() {
  const user = userEvent.setup();
  render(createElement(EvmBatchDistributorPage));
  await user.click(screen.getByRole("tab", { name: "Token" }));
  await user.type(screen.getByRole("textbox", { name: "Token 合约地址" }), tokenAddress);
  await screen.findByText("Mock Token");
  await user.type(screen.getByRole("textbox", { name: "收款地址" }), recipient);
  const preflightButton = screen.getByRole("button", { name: "运行预检" });
  await waitFor(() => expect(preflightButton).toBeEnabled());
  await user.click(preflightButton);
  await screen.findByRole("button", { name: "确认分发" });
  return user;
}

describe("EvmBatchDistributorPage safety", () => {
  it("shows live Gas and passes a custom Gas Price into preflight", async () => {
    const user = userEvent.setup();
    render(createElement(EvmBatchDistributorPage));

    expect(await screen.findByLabelText("实时 Gas 推荐：慢 1.8 Gwei，中 2 Gwei，快 2.4 Gwei")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Gas 与链设置" })).not.toBeInTheDocument();

    const networkAndRpc = screen.getByLabelText("网络与 RPC");
    expect(networkAndRpc).toBeVisible();
    expect(within(networkAndRpc).getByLabelText("RPC")).toHaveValue("https://ethereum.publicnode.com");
    expect(within(networkAndRpc).getByText(/Chain ID/)).toHaveTextContent("Chain ID 1");

    const gasSettings = screen.getByLabelText("Gas 设置");
    expect(gasSettings).toBeVisible();
    expect(within(gasSettings).getByLabelText("预估网络费 预检后显示")).toBeVisible();
    const preflightButton = screen.getByRole("button", { name: "运行预检" });
    expect(gasSettings.closest(".workbench-panel")).toBe(preflightButton.closest(".workbench-panel"));
    expect(gasSettings.compareDocumentPosition(preflightButton) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    await user.click(within(gasSettings).getByRole("tab", { name: "自定义" }));
    await user.type(within(gasSettings).getByRole("spinbutton", { name: "Gas Price（Gwei）" }), "3.25");
    await user.type(screen.getByRole("textbox", { name: "收款地址" }), recipient);
    await user.click(preflightButton);

    await screen.findByRole("button", { name: "确认分发" });
    expect(pageMocks.preflight).toHaveBeenCalledWith(expect.objectContaining({
      gasSettings: {
        fee: { gasPrice: 3_250_000_000n, type: "legacy" },
        mode: "custom"
      }
    }));
  });

  it("blocks preflight while the custom Gas Price is invalid", async () => {
    const user = userEvent.setup();
    render(createElement(EvmBatchDistributorPage));
    const gasSettings = screen.getByLabelText("Gas 设置");
    await user.click(within(gasSettings).getByRole("tab", { name: "自定义" }));
    await user.type(screen.getByRole("textbox", { name: "收款地址" }), recipient);

    expect(within(gasSettings).queryByText(/请输入大于 0/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "运行预检" })).toBeDisabled();
    expect(pageMocks.preflight).not.toHaveBeenCalled();
  });

  it("invalidates a ready distribution confirmation when the Gas setting changes", async () => {
    const { user } = await prepareReadyDistributionPage();
    expect(screen.getByRole("button", { name: "确认分发" })).toBeEnabled();

    await user.click(within(screen.getByLabelText("Gas 设置")).getByRole("tab", { name: "自定义" }));

    expect(screen.queryByRole("button", { name: "确认分发" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "运行预检" })).toBeDisabled();
    expect(pageMocks.preflight).toHaveBeenCalledTimes(1);
  });

  it("locks an in-place retry after any transaction hash was observed", () => {
    const state = getEvmDistributionSafetyState({
      preflightStatus: "success",
      sendStatus: "error",
      signatureCount: 1
    });

    expect(state.unresolvedSubmission).toBe(true);
    expect(state.canRetryInPlace).toBe(false);
    expect(state.workbenchStatus).toBe("uncertain");
  });

  it("allows returning to editing when signing failed before submission", () => {
    const state = getEvmDistributionSafetyState({
      preflightStatus: "success",
      sendStatus: "error",
      signatureCount: 0
    });

    expect(state.unresolvedSubmission).toBe(false);
    expect(state.canRetryInPlace).toBe(true);
    expect(state.workbenchStatus).toBe("error");
  });

  it("does not call a provider-backed sender when the fresh signing preflight fails", async () => {
    const provider = { request: vi.fn() };
    const sign = vi.fn(async () => {
      await provider.request({ method: "eth_sendTransaction" });
    });

    await expect(runEvmDistributionSigningGate({
      preflight: vi.fn().mockRejectedValue(new Error("签名前余额已变化")),
      sign
    })).rejects.toThrow("签名前余额已变化");

    expect(sign).not.toHaveBeenCalled();
    expect(provider.request).not.toHaveBeenCalled();
  });

  it("shows a failed editing preflight and allows a clean re-preflight", async () => {
    pageMocks.preflight.mockRejectedValueOnce(new Error("资产余额不足"));
    const user = userEvent.setup();
    render(createElement(EvmBatchDistributorPage));
    await user.type(screen.getByRole("textbox", { name: "收款地址" }), recipient);
    await user.click(screen.getByRole("button", { name: "运行预检" }));

    expect(await screen.findByText("预检未通过")).toBeVisible();
    expect(document.querySelector(".workbench-status")).toHaveAttribute("data-state", "error");
    expect(screen.queryByRole("button", { name: "确认分发" })).not.toBeInTheDocument();
    expect(pageMocks.sendNative).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "重新预检" }));
    expect(await screen.findByRole("button", { name: "确认分发" })).toBeEnabled();
    expect(pageMocks.preflight).toHaveBeenCalledTimes(2);
  });

  it("closes the EVM confirmation without signing when the user cancels", async () => {
    const { user } = await prepareReadyDistributionPage();
    const trigger = screen.getByRole("button", { name: "确认分发" });
    await user.click(trigger);
    const dialog = screen.getByRole("alertdialog", { name: "确认 EVM 分发" });
    await user.click(within(dialog).getByRole("button", { name: "取消" }));

    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(pageMocks.ensureNetwork).not.toHaveBeenCalled();
    expect(pageMocks.sendNative).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
  });

  it("shows the sending account and labels the fee as an estimate in confirmation", async () => {
    const { user } = await prepareReadyDistributionPage();
    await user.click(screen.getByRole("button", { name: "确认分发" }));

    const dialog = screen.getByRole("alertdialog", { name: "确认 EVM 分发" });
    expect(within(dialog).getByText("发送账户")).toBeVisible();
    expect(within(dialog).getByTitle(connectedAccount)).toBeVisible();
    expect(within(dialog).getByText("预估网络费")).toBeVisible();
    expect(screen.queryByText(/费用上限/)).not.toBeInTheDocument();
  });

  it("does not call the sender when the account changes after confirmation", async () => {
    const { user } = await prepareReadyDistributionPage();
    await user.click(screen.getByRole("button", { name: "确认分发" }));
    const dialog = screen.getByRole("alertdialog", { name: "确认 EVM 分发" });
    pageMocks.providerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "eth_accounts") return [switchedAccount];
      if (method === "eth_chainId") return "0x1";
      return null;
    });

    await user.click(within(dialog).getByRole("button", { name: "签名并分发" }));

    expect(await screen.findByText("签名前钱包的账户或网络已改变，请重新预检")).toBeVisible();
    expect(pageMocks.preflight).toHaveBeenCalledTimes(2);
    expect(pageMocks.sendNative).not.toHaveBeenCalled();
    expect(pageMocks.sendToken).not.toHaveBeenCalled();
  });

  it("does not call the sender when the fresh signing preflight fails", async () => {
    pageMocks.preflight
      .mockResolvedValueOnce(preflightResult)
      .mockRejectedValueOnce(new Error("签名前余额已变化"));
    const { user } = await prepareReadyDistributionPage();
    await user.click(screen.getByRole("button", { name: "确认分发" }));
    const dialog = screen.getByRole("alertdialog", { name: "确认 EVM 分发" });

    await user.click(within(dialog).getByRole("button", { name: "签名并分发" }));

    expect(await screen.findByText("EVM 分发失败：签名前余额已变化")).toBeVisible();
    expect(pageMocks.preflight).toHaveBeenCalledTimes(2);
    expect(pageMocks.sendNative).not.toHaveBeenCalled();
    expect(pageMocks.sendToken).not.toHaveBeenCalled();
  });

  it("invalidates a ready confirmation when the distribution input changes", async () => {
    const { addressInput, user } = await prepareReadyDistributionPage();
    expect(screen.getByRole("button", { name: "确认分发" })).toBeEnabled();

    await user.type(addressInput, "\n0x00000000000000000000000000000000000000b2");

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "确认分发" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "运行预检" })).toBeEnabled();
    });
    expect(pageMocks.preflight).toHaveBeenCalledTimes(1);
    expect(pageMocks.sendNative).not.toHaveBeenCalled();
  });

  it("clears the mixed URL amount warning after a uniform amount correction and a new task", async () => {
    const list = `${recipient},1\n${secondRecipient},2`;
    window.history.replaceState({}, "", `/evm/?${new URLSearchParams({ list }).toString()}`);
    const user = userEvent.setup();
    render(createElement(EvmBatchDistributorPage));

    expect(screen.getByText("旧清单金额未导入")).toBeVisible();
    const amountInput = screen.getByRole("spinbutton", { name: "每个地址的金额（ETH）" });
    await user.type(amountInput, "0.25");
    await waitFor(() => expect(screen.queryByText("旧清单金额未导入")).not.toBeInTheDocument());

    await waitFor(() => expect(screen.getByRole("button", { name: "运行预检" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "运行预检" }));
    await user.click(await screen.findByRole("button", { name: "确认分发" }));
    let dialog = screen.getByRole("alertdialog", { name: "确认 EVM 分发" });
    await user.click(within(dialog).getByRole("button", { name: "签名并分发" }));
    expect(await screen.findByText("分发已完成")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "清空清单并开始新任务" }));
    dialog = screen.getByRole("alertdialog", { name: "清空并新建分发任务？" });
    await user.click(within(dialog).getByRole("button", { name: "清空并开始新任务" }));

    expect(await screen.findByRole("textbox", { name: "收款地址" })).toHaveValue("");
    expect(screen.queryByText("旧清单金额未导入")).not.toBeInTheDocument();
  });

  it("completes a native distribution and renders its submitted hash", async () => {
    const { user } = await prepareReadyDistributionPage();
    await user.click(screen.getByRole("button", { name: "确认分发" }));
    const dialog = screen.getByRole("alertdialog", { name: "确认 EVM 分发" });
    await user.click(within(dialog).getByRole("button", { name: "签名并分发" }));

    expect(await screen.findByText("分发已完成")).toBeVisible();
    expect(document.querySelector(".workbench-status")).toHaveAttribute("data-state", "success");
    expect(screen.getByRole("table", { name: "EVM 分发交易结果" })).toBeInTheDocument();
    expect(screen.getByTitle(transactionHash)).toBeInTheDocument();
    expect(pageMocks.preflight).toHaveBeenCalledTimes(2);
    expect(pageMocks.sendNative).toHaveBeenCalledTimes(1);
    expect(pageMocks.sendNative).toHaveBeenCalledWith(expect.objectContaining({
      feeQuote: preflightResult.feeQuote,
      gasSettings: { mode: "auto" }
    }));
  });

  it("renders confirmed and uncertain rows when a token distribution partially fails", async () => {
    pageMocks.preflight.mockResolvedValue({
      ...preflightResult,
      assetBalanceWei: 1_000_000_000n,
      needsApproval: true,
      totalTransactions: 2
    });
    pageMocks.sendToken.mockImplementationOnce(async ({ onStep }) => {
      onStep({ needsApproval: true, totalTransactions: 2, type: "allowance-checked" });
      onStep({ hash: approvalHash, totalTransactions: 2, type: "approval-submitted" });
      onStep({ hash: approvalHash, totalTransactions: 2, type: "approval-confirmed" });
      onStep({
        hash: distributionHash,
        hashes: [approvalHash, distributionHash],
        totalTransactions: 2,
        type: "distribution-submitted"
      });
      throw new Error("分发回执超时");
    });
    const user = await prepareReadyTokenDistributionPage();
    await user.click(screen.getByRole("button", { name: "确认分发" }));
    const dialog = screen.getByRole("alertdialog", { name: "确认 EVM 分发" });
    expect(within(dialog).getByText("授权后复检")).toBeVisible();
    expect(within(dialog).getByText("余额、授权与 Gas 通过后才分发")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "授权并分发" }));

    expect(await screen.findByText("不可安全整批重试")).toBeVisible();
    const resultTable = screen.getByRole("table", { name: "EVM 分发交易结果" });
    expect(within(resultTable).getByText("授权")).toBeInTheDocument();
    expect(within(resultTable).getByText("分发")).toBeInTheDocument();
    expect(within(resultTable).getByText("已确认")).toBeInTheDocument();
    expect(within(resultTable).getByText("待核对")).toBeInTheDocument();
    expect(document.querySelector(".workbench-status")).toHaveAttribute("data-state", "uncertain");
    expect(pageMocks.sendToken).toHaveBeenCalledTimes(1);
  });

  it("locks in-place retry after a submitted hash becomes uncertain", async () => {
    pageMocks.sendNative.mockImplementationOnce(async ({ onSubmitted }) => {
      onSubmitted(transactionHash);
      throw new Error("等待回执失败");
    });
    const { addressInput, user } = await prepareReadyDistributionPage();
    await user.click(screen.getByRole("button", { name: "确认分发" }));
    const dialog = screen.getByRole("alertdialog", { name: "确认 EVM 分发" });
    await user.click(within(dialog).getByRole("button", { name: "签名并分发" }));

    expect(await screen.findByText("不可安全整批重试")).toBeVisible();
    expect(document.querySelector(".workbench-status")).toHaveAttribute("data-state", "uncertain");
    expect(addressInput).toBeDisabled();
    expect(screen.queryByRole("button", { name: "返回修改并重新预检" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认分发" })).not.toBeInTheDocument();
    const newTaskTrigger = screen.getByRole("button", { name: "清空清单并开始新任务" });
    expect(newTaskTrigger).toBeEnabled();
    expect(pageMocks.preflight).toHaveBeenCalledTimes(2);
    expect(pageMocks.ensureNetwork).toHaveBeenCalledTimes(1);

    await user.click(newTaskTrigger);
    let newTaskDialog = screen.getByRole("alertdialog", { name: "清空并新建分发任务？" });
    expect(within(newTaskDialog).getByText(/哈希.*从当前视图移除/)).toBeInTheDocument();
    expect(within(newTaskDialog).getByText(/先核验链上记录/)).toBeInTheDocument();
    await user.click(within(newTaskDialog).getByRole("button", { name: "取消" }));
    expect(addressInput).toBeDisabled();
    expect(document.querySelector(".workbench-status")).toHaveAttribute("data-state", "uncertain");

    await user.click(newTaskTrigger);
    newTaskDialog = screen.getByRole("alertdialog", { name: "清空并新建分发任务？" });
    await user.click(within(newTaskDialog).getByRole("button", { name: "清空并开始新任务" }));

    const freshAddressInput = await screen.findByRole("textbox", { name: "收款地址" });
    expect(freshAddressInput).toBeEnabled();
    expect(freshAddressInput).toHaveValue("");
    expect(document.querySelector(".workbench-status")).toHaveAttribute("data-state", "editing");
    expect(screen.queryByText("不可安全整批重试")).not.toBeInTheDocument();
    await user.type(freshAddressInput, recipient);
    await waitFor(() => expect(screen.getByRole("button", { name: "运行预检" })).toBeEnabled());
  });
});
