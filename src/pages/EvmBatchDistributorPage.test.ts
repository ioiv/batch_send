// @vitest-environment jsdom

import { expandTaskDetails } from "../test/workbench";

import { createElement } from "react";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
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
  refreshTransactions: vi.fn(),
  sendNative: vi.fn(),
  sendToken: vi.fn()
}));

vi.mock("../lib/task-history-refresh", () => ({ refreshTaskTransactions: pageMocks.refreshTransactions }));

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
import { readTaskHistory, saveTaskRecord } from "../lib/task-history";

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
  pageMocks.refreshTransactions.mockReset().mockImplementation(async (record) => record);
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
  await user.click(addressInput);
  await user.paste(recipient);
  const preflightButton = screen.getByRole("button", { name: "开始分发" });
  await waitFor(() => expect(preflightButton).toBeEnabled());
  await user.click(preflightButton);
  await screen.findByRole("alertdialog", { name: "确认 EVM 分发" });
  return { addressInput, user };
}

async function prepareReadyTokenDistributionPage() {
  const user = userEvent.setup();
  render(createElement(EvmBatchDistributorPage));
  await user.click(screen.getByRole("tab", { name: "Token" }));
  await user.click(screen.getByRole("textbox", { name: "Token 合约地址" }));
  await user.paste(tokenAddress);
  await screen.findByText("Mock Token");
  await user.click(screen.getByRole("textbox", { name: "收款地址" }));
  await user.paste(recipient);
  const preflightButton = screen.getByRole("button", { name: "开始分发" });
  await waitFor(() => expect(preflightButton).toBeEnabled());
  await user.click(preflightButton);
  await screen.findByRole("alertdialog", { name: "确认 EVM 分发" });
  return user;
}

describe("EvmBatchDistributorPage safety", () => {
  it("opens confirmation after one start action and retains automatic checks before signing", async () => {
    const user = userEvent.setup();
    render(createElement(EvmBatchDistributorPage));
    await user.type(screen.getByRole("textbox", { name: "收款地址" }), recipient);
    expect(screen.queryByRole("button", { name: /运行预检|重新预检|确认分发/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "开始分发" }));
    const dialog = await screen.findByRole("alertdialog", { name: "确认 EVM 分发" });
    expect(pageMocks.preflight).toHaveBeenCalledTimes(1);
    expect(pageMocks.ensureNetwork).not.toHaveBeenCalled();
    expect(pageMocks.sendNative).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /运行预检|重新预检|确认分发/, hidden: true })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "签名并分发" }));
    expect(await screen.findByText("分发完成")).toBeVisible();
    expect(pageMocks.preflight).toHaveBeenCalledTimes(2);
    expect(pageMocks.sendNative).toHaveBeenCalledTimes(1);
  });

  it("shows a disabled checking state and opens the dialog only after automatic checks finish", async () => {
    let finishCheck!: (result: typeof preflightResult) => void;
    pageMocks.preflight.mockImplementationOnce(() => new Promise((resolve) => { finishCheck = resolve; }));
    const user = userEvent.setup();
    render(createElement(EvmBatchDistributorPage));
    await user.type(screen.getByRole("textbox", { name: "收款地址" }), recipient);
    await user.click(screen.getByRole("button", { name: "开始分发" }));
    expect(screen.getByRole("button", { name: "检查中" })).toBeDisabled();
    expect(screen.queryByRole("alertdialog", { name: "确认 EVM 分发" })).not.toBeInTheDocument();
    expect(pageMocks.sendNative).not.toHaveBeenCalled();
    await act(async () => { finishCheck(preflightResult); });
    expect(await screen.findByRole("alertdialog", { name: "确认 EVM 分发" })).toBeVisible();
    expect(pageMocks.sendNative).not.toHaveBeenCalled();
  });

  const makeSavedTask = (id: string, hash = transactionHash, uncertain = true) => ({
    id, toolId: "evm-distribution", label: "旧轮次",
    network: { kind: "evm" as const, id: "ethereum", label: "Ethereum", chainId: 1 },
    createdAt: "2026-10-12T08:00:00Z", updatedAt: "2026-10-12T08:00:00Z",
    results: [{ address: recipient, asset: "ETH", amount: "0.1", hash, message: "旧交易", status: uncertain ? "confirming" as const : "success" as const, uncertain }]
  });

  it("persists the signing state and returned hash within the sender callback before React renders", async () => {
    pageMocks.sendNative.mockImplementationOnce(async ({ onSubmitted }) => {
      const beforeSubmit = readTaskHistory("evm-distribution")[0].results.find((result) => result.label === "分发")!;
      expect(beforeSubmit.uncertain).toBe(true);
      expect(beforeSubmit.hash).toBeUndefined();
      onSubmitted(transactionHash);
      const submitted = readTaskHistory("evm-distribution")[0].results.find((result) => result.label === "分发")!;
      expect(submitted).toMatchObject({ hash: transactionHash, uncertain: true, status: "confirming" });
      window.dispatchEvent(new Event("pagehide"));
      expect(readTaskHistory("evm-distribution")[0].results[0].hash).toBe(transactionHash);
      return { hash: transactionHash };
    });
    const { user } = await prepareReadyDistributionPage();
    await screen.findByRole("alertdialog", { name: "确认 EVM 分发" });
    await user.click(within(screen.getByRole("alertdialog", { name: "确认 EVM 分发" })).getByRole("button", { name: "签名并分发" }));
    expect(await screen.findByText("分发完成")).toBeVisible();
  });

  it("checks fresh storage at the final signing action when another tab adds an unknown task", async () => {
    const { user } = await prepareReadyDistributionPage();
    await screen.findByRole("alertdialog", { name: "确认 EVM 分发" });
    const dialog = screen.getByRole("alertdialog", { name: "确认 EVM 分发" });
    saveTaskRecord(makeSavedTask("external-unknown"));
    await user.click(within(dialog).getByRole("button", { name: "签名并分发" }));
    expect(pageMocks.ensureNetwork).not.toHaveBeenCalled();
    expect(pageMocks.sendNative).not.toHaveBeenCalled();
    expect(pageMocks.preflight).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("请先在可恢复任务记录中核对之前提交的交易")).toBeVisible();
  });

  it("saves every Token step synchronously and never associates an approval hash with recipients", async () => {
    pageMocks.preflight.mockResolvedValue({ ...preflightResult, needsApproval: true, totalTransactions: 2 });
    pageMocks.sendToken.mockImplementationOnce(async ({ onStep }) => {
      onStep({ needsApproval: true, totalTransactions: 2, type: "allowance-checked" });
      onStep({ hash: approvalHash, totalTransactions: 2, type: "approval-submitted" });
      let saved = readTaskHistory("evm-distribution")[0].results;
      expect(saved.find((result) => result.label === "Token 授权")).toMatchObject({ hash: approvalHash, status: "confirming" });
      expect(saved.find((result) => result.label === "分发")?.hash).toBeUndefined();
      onStep({ hash: approvalHash, totalTransactions: 2, type: "approval-confirmed" });
      saved = readTaskHistory("evm-distribution")[0].results;
      expect(saved.find((result) => result.label === "Token 授权")).toMatchObject({ status: "success" });
      onStep({ totalTransactions: 2, type: "distribution-signing" });
      expect(readTaskHistory("evm-distribution")[0].results.find((result) => result.label === "分发")?.uncertain).toBe(true);
      onStep({ hash: distributionHash, hashes: [approvalHash, distributionHash], totalTransactions: 2, type: "distribution-submitted" });
      expect(readTaskHistory("evm-distribution")[0].results.find((result) => result.label === "分发")).toMatchObject({ hash: distributionHash, status: "confirming" });
      onStep({ hash: distributionHash, hashes: [approvalHash, distributionHash], totalTransactions: 2, type: "distribution-confirmed" });
      expect(readTaskHistory("evm-distribution")[0].results.every((result) => result.status === "success" && !result.uncertain)).toBe(true);
      return { hashes: [approvalHash, distributionHash] };
    });
    const user = await prepareReadyTokenDistributionPage();
    await screen.findByRole("alertdialog", { name: "确认 EVM 分发" });
    await user.click(within(screen.getByRole("alertdialog", { name: "确认 EVM 分发" })).getByRole("button", { name: "授权并分发" }));
    expect(await screen.findByText("分发完成")).toBeVisible();
  });

  it("still blocks signing if another tab adds an unknown task during the fresh preflight", async () => {
    const { user } = await prepareReadyDistributionPage();
    pageMocks.preflight.mockImplementationOnce(async () => {
      saveTaskRecord(makeSavedTask("external-during-preflight"));
      return preflightResult;
    });
    await screen.findByRole("alertdialog", { name: "确认 EVM 分发" });
    await user.click(within(screen.getByRole("alertdialog", { name: "确认 EVM 分发" })).getByRole("button", { name: "签名并分发" }));
    expect(await screen.findByText("请先在可恢复任务记录中核对之前提交的交易")).toBeVisible();
    expect(pageMocks.sendNative).not.toHaveBeenCalled();
  });

  it("stops the automatic checking state when another tab adds an unknown task during checks", async () => {
    pageMocks.preflight.mockImplementationOnce(async () => {
      saveTaskRecord(makeSavedTask("external-during-start"));
      return preflightResult;
    });
    const user = userEvent.setup();
    render(createElement(EvmBatchDistributorPage));
    await user.type(screen.getByRole("textbox", { name: "收款地址" }), recipient);
    await user.click(screen.getByRole("button", { name: "开始分发" }));
    expect(await screen.findByText("请先在可恢复任务记录中核对之前提交的交易")).toBeVisible();
    expect(screen.queryByRole("alertdialog", { name: "确认 EVM 分发" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "检查中" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "已人工核对链上结果" })).toBeEnabled();
    expect(pageMocks.sendNative).not.toHaveBeenCalled();
  });

  it("acknowledges the current round even after querying an older record moves it to the top", async () => {
    saveTaskRecord(makeSavedTask("older-complete", approvalHash, false));
    pageMocks.sendNative.mockImplementationOnce(async ({ onSubmitted }) => {
      onSubmitted(distributionHash);
      throw new Error("RPC timeout");
    });
    const { user } = await prepareReadyDistributionPage();
    await screen.findByRole("alertdialog", { name: "确认 EVM 分发" });
    await user.click(within(screen.getByRole("alertdialog", { name: "确认 EVM 分发" })).getByRole("button", { name: "签名并分发" }));
    await screen.findByRole("button", { name: "说明：不可安全整批重试" });
    const currentId = readTaskHistory("evm-distribution").find((record) => record.id !== "older-complete")!.id;
    const olderRound = screen.getByText("旧轮次 · Ethereum").closest(".task-history__round")! as HTMLElement;
    await user.click(within(olderRound).getByRole("button", { name: "继续查询交易状态" }));
    await waitFor(() => expect(readTaskHistory("evm-distribution")[0].id).toBe("older-complete"));
    await user.click(screen.getByRole("button", { name: "开始新一轮分发" }));
    await user.click(screen.getByRole("button", { name: "已核对，开始新任务" }));
    await user.click(within(screen.getByRole("alertdialog", { name: "已核对记录中的链上状态？" })).getByRole("button", { name: "确认已核对" }));
    expect(readTaskHistory("evm-distribution").find((record) => record.id === currentId)?.acknowledgedAt).toBeTruthy();
    expect(readTaskHistory("evm-distribution").find((record) => record.id === "older-complete")?.acknowledgedAt).toBeUndefined();
  });

  it("blocks writes after reopening an uncertain distribution and allows explicit review", async () => {
    saveTaskRecord({
      id: "evm-interrupted", toolId: "evm-distribution", label: "EVM 批量分发",
      network: { kind: "evm", id: "ethereum", label: "Ethereum", chainId: 1 },
      createdAt: "2026-10-12T08:00:00Z", updatedAt: "2026-10-12T08:00:00Z",
      results: [{ address: recipient, asset: "ETH", amount: "0.123456789", hash: transactionHash, message: "正在确认", status: "confirming" }]
    });
    const user = userEvent.setup();
    render(createElement(EvmBatchDistributorPage));
    await user.type(screen.getByRole("textbox", { name: "收款地址" }), recipient);
    expect(screen.getByRole("button", { name: "开始分发" })).toBeDisabled();
    expect(pageMocks.preflight).not.toHaveBeenCalled();
    const historyToggle = screen.queryByRole("button", { name: "展开可恢复任务记录" });
    if (historyToggle) await user.click(historyToggle);
    expect(screen.getByRole("button", { name: "删除记录" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "已人工核对链上结果" }));
    await user.click(within(screen.getByRole("alertdialog", { name: "已核对这轮交易的链上结果？" })).getByRole("button", { name: "确认已核对" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "开始分发" })).toBeEnabled());
    expect(pageMocks.sendNative).not.toHaveBeenCalled();
  });

  it("keeps the summary beside the actions and selects problem lines without sending", async () => {
    const user = userEvent.setup();
    render(createElement(EvmBatchDistributorPage));
    expandTaskDetails();
    const summary = screen.getByRole("region", { name: "清单摘要" });
    expect(summary.closest(".workbench-action-bar")).not.toBeNull();
    expect(within(summary).queryByText("需修正")).not.toBeInTheDocument();
    expect(within(summary).queryByText("重复地址")).not.toBeInTheDocument();

    const input = screen.getByRole("textbox", { name: "收款地址" }) as HTMLTextAreaElement;
    const list = `${recipient}\n\nbad\n${recipient}`;
    await user.type(input, list);
    await user.click(await screen.findByRole("button", { name: "定位需修正：1" }));
    expect(input).toHaveFocus();
    expect(input.value.slice(input.selectionStart, input.selectionEnd)).toBe("bad");

    await user.click(screen.getByRole("button", { name: "定位重复地址：1" }));
    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(list.length - recipient.length);
    expect(input.value.slice(input.selectionStart, input.selectionEnd)).toBe(recipient);
    expect(screen.getByRole("button", { name: "开始分发" })).toBeDisabled();
    expect(pageMocks.preflight).not.toHaveBeenCalled();
    expect(pageMocks.sendNative).not.toHaveBeenCalled();
  });

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
    // The compact summary stays beside the operation buttons, after the fee settings.
    expandTaskDetails();
    const summary = screen.getByRole("region", { name: "清单摘要" });
    const summaryValue = (label: string) => within(summary).getByText(label).nextElementSibling;
    expect(summaryValue("预估网络费")).toHaveTextContent("—");
    expect(gasSettings.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    const preflightButton = screen.getByRole("button", { name: "开始分发" });
    expect(gasSettings.closest(".workbench-panel")).not.toBeNull();
    expect(preflightButton.closest(".workbench-panel")).toBe(gasSettings.closest(".workbench-panel"));
    expect(gasSettings.compareDocumentPosition(preflightButton) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    await user.click(within(gasSettings).getByRole("tab", { name: "自定义" }));
    await user.type(within(gasSettings).getByRole("spinbutton", { name: "Gas Price（Gwei）" }), "3.25");
    await user.type(screen.getByRole("textbox", { name: "收款地址" }), recipient);
    await user.click(preflightButton);

    await screen.findByRole("alertdialog", { name: "确认 EVM 分发" });
    expect(document.querySelector(".workbench-action-bar__actions")?.querySelectorAll("button")).toHaveLength(1);
    expect(pageMocks.preflight).toHaveBeenCalledWith(expect.objectContaining({
      gasSettings: {
        fee: { gasPrice: 3_250_000_000n, type: "legacy" },
        mode: "custom"
      }
    }));
    expect(summaryValue("有效地址")).toHaveTextContent("1");
    expect(summaryValue("预估网络费")).toHaveTextContent("0.0001 ETH");
  });

  it("blocks preflight while the custom Gas Price is invalid", async () => {
    const user = userEvent.setup();
    render(createElement(EvmBatchDistributorPage));
    const gasSettings = screen.getByLabelText("Gas 设置");
    await user.click(within(gasSettings).getByRole("tab", { name: "自定义" }));
    await user.type(screen.getByRole("textbox", { name: "收款地址" }), recipient);

    expect(within(gasSettings).queryByText(/请输入大于 0/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始分发" })).toBeDisabled();
    expect(pageMocks.preflight).not.toHaveBeenCalled();
  });

  it("invalidates a ready distribution confirmation when the Gas setting changes", async () => {
    const { user } = await prepareReadyDistributionPage();
    expect(screen.getByRole("alertdialog", { name: "确认 EVM 分发" })).toBeVisible();
    await user.click(within(screen.getByRole("alertdialog", { name: "确认 EVM 分发" })).getByRole("button", { name: "取消" }));

    await user.click(within(screen.getByLabelText("Gas 设置")).getByRole("tab", { name: "自定义" }));

    expect(screen.queryByRole("alertdialog", { name: "确认 EVM 分发" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始分发" })).toBeDisabled();
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

  it("allows a confirmed approval to continue but blocks unknown submission without a hash", () => {
    expect(getEvmDistributionSafetyState({ approvalOnlyConfirmed: true, preflightStatus: "success", sendStatus: "error", signatureCount: 1 }).canRetryInPlace).toBe(true);
    expect(getEvmDistributionSafetyState({ submissionUncertain: true, preflightStatus: "success", sendStatus: "error", signatureCount: 0 }).unresolvedSubmission).toBe(true);
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
    await user.click(screen.getByRole("button", { name: "开始分发" }));

    expect((await screen.findAllByText("检查未通过")).length).toBeGreaterThan(0);
    expect(document.querySelector(".workbench-status")).toHaveAttribute("data-state", "error");
    expect(screen.queryByRole("alertdialog", { name: "确认 EVM 分发" })).not.toBeInTheDocument();
    expect(pageMocks.sendNative).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "重新检查" }));
    expect(await screen.findByRole("alertdialog", { name: "确认 EVM 分发" })).toBeVisible();
    expect(pageMocks.preflight).toHaveBeenCalledTimes(2);
  });

  it("closes the EVM confirmation without signing when the user cancels", async () => {
    const { user } = await prepareReadyDistributionPage();
    const trigger = screen.getByRole("button", { name: "开始分发", hidden: true });
    const dialog = screen.getByRole("alertdialog", { name: "确认 EVM 分发" });
    await user.click(within(dialog).getByRole("button", { name: "取消" }));

    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(pageMocks.ensureNetwork).not.toHaveBeenCalled();
    expect(pageMocks.sendNative).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
    expect(trigger).toBeEnabled();
    expect(trigger).toHaveAttribute("id", "evm-distribution-start");
    expect(screen.getByRole("textbox", { name: "收款地址" })).toBeEnabled();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("alertdialog", { name: "确认 EVM 分发" })).toBeVisible();
    expect(pageMocks.preflight).toHaveBeenCalledTimes(2);
  });

  it("shows the sending account and labels the fee as an estimate in confirmation", async () => {
    const { user } = await prepareReadyDistributionPage();
    await screen.findByRole("alertdialog", { name: "确认 EVM 分发" });

    const dialog = screen.getByRole("alertdialog", { name: "确认 EVM 分发" });
    expect(within(dialog).getByText("发送账户")).toBeVisible();
    expect(within(dialog).getByTitle(connectedAccount)).toBeVisible();
    expect(within(dialog).getByText("预估网络费")).toBeVisible();
    expect(screen.queryByText(/费用上限/)).not.toBeInTheDocument();
  });

  it("does not call the sender when the account changes after confirmation", async () => {
    const { user } = await prepareReadyDistributionPage();
    await screen.findByRole("alertdialog", { name: "确认 EVM 分发" });
    const dialog = screen.getByRole("alertdialog", { name: "确认 EVM 分发" });
    pageMocks.providerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "eth_accounts") return [switchedAccount];
      if (method === "eth_chainId") return "0x1";
      return null;
    });

    await user.click(within(dialog).getByRole("button", { name: "签名并分发" }));

    expect(await screen.findByText("签名前钱包的账户或网络已改变，请重新检查")).toBeVisible();
    expect(pageMocks.preflight).toHaveBeenCalledTimes(2);
    expect(pageMocks.sendNative).not.toHaveBeenCalled();
    expect(pageMocks.sendToken).not.toHaveBeenCalled();
  });

  it("does not call the sender when the fresh signing preflight fails", async () => {
    pageMocks.preflight
      .mockResolvedValueOnce(preflightResult)
      .mockRejectedValueOnce(new Error("签名前余额已变化"));
    const { user } = await prepareReadyDistributionPage();
    await screen.findByRole("alertdialog", { name: "确认 EVM 分发" });
    const dialog = screen.getByRole("alertdialog", { name: "确认 EVM 分发" });

    await user.click(within(dialog).getByRole("button", { name: "签名并分发" }));

    expect(await screen.findByText("EVM 分发失败：签名前余额已变化")).toBeVisible();
    expect(pageMocks.preflight).toHaveBeenCalledTimes(2);
    expect(pageMocks.sendNative).not.toHaveBeenCalled();
    expect(pageMocks.sendToken).not.toHaveBeenCalled();
  });

  it("invalidates a ready confirmation when the distribution input changes", async () => {
    const { addressInput, user } = await prepareReadyDistributionPage();
    expect(screen.getByRole("alertdialog", { name: "确认 EVM 分发" })).toBeVisible();
    await user.click(within(screen.getByRole("alertdialog", { name: "确认 EVM 分发" })).getByRole("button", { name: "取消" }));

    await user.type(addressInput, "\n0x00000000000000000000000000000000000000b2");

    await waitFor(() => {
      expect(screen.queryByRole("alertdialog", { name: "确认 EVM 分发" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "开始分发" })).toBeEnabled();
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

    await waitFor(() => expect(screen.getByRole("button", { name: "开始分发" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "开始分发" }));
    await screen.findByRole("alertdialog", { name: "确认 EVM 分发" });
    let dialog = screen.getByRole("alertdialog", { name: "确认 EVM 分发" });
    await user.click(within(dialog).getByRole("button", { name: "签名并分发" }));
    expect(await screen.findByText("分发完成")).toBeVisible();

    // The finished round has its own way forward, and it keeps the list.
    const addressInput = screen.getByRole("textbox", { name: "收款地址" });
    await user.click(screen.getByRole("button", { name: "开始新一轮分发" }));
    expect(screen.getByText("分发记录")).toBeVisible();
    expect(addressInput).toHaveValue(`${recipient}\n${secondRecipient}`);
    expect(screen.getByRole("button", { name: "开始分发" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "清空" }));
    dialog = screen.getByRole("alertdialog", { name: "清空收款清单？" });
    await user.click(within(dialog).getByRole("button", { name: "确认清空" }));

    expect(await screen.findByRole("textbox", { name: "收款地址" })).toHaveValue("");
    expect(screen.queryByText("旧清单金额未导入")).not.toBeInTheDocument();
  });

  it("completes a native distribution and renders its submitted hash", async () => {
    const { user } = await prepareReadyDistributionPage();
    await screen.findByRole("alertdialog", { name: "确认 EVM 分发" });
    const dialog = screen.getByRole("alertdialog", { name: "确认 EVM 分发" });
    await user.click(within(dialog).getByRole("button", { name: "签名并分发" }));

    expect(await screen.findByText("分发完成")).toBeVisible();
    expect(document.querySelector(".workbench-status")).toHaveAttribute("data-state", "success");
    expect(screen.getByRole("table", { name: "EVM 分发交易结果" })).not.toBeVisible();
    expandTaskDetails();
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
    await screen.findByRole("alertdialog", { name: "确认 EVM 分发" });
    const dialog = screen.getByRole("alertdialog", { name: "确认 EVM 分发" });
    expect(within(dialog).getByText("授权后检查")).toBeVisible();
    expect(within(dialog).getByText("余额、授权与 Gas 通过后才分发")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "授权并分发" }));

    expect(await screen.findByRole("button", { name: "说明：不可安全整批重试" })).toBeVisible();
    const resultTable = screen.getByRole("table", { name: "EVM 分发交易结果" });
    expect(within(resultTable).getByText("授权")).toBeInTheDocument();
    expect(within(resultTable).getByText("分发")).toBeInTheDocument();
    expect(within(resultTable).getByText("已确认")).toBeInTheDocument();
    expect(within(resultTable).getByText("待核对")).toBeInTheDocument();
    expect(document.querySelector(".workbench-status")).toHaveAttribute("data-state", "uncertain");
    expect(pageMocks.sendToken).toHaveBeenCalledTimes(1);
  });

  it("rechecks and continues after approval succeeds and the distribution signature is cancelled", async () => {
    pageMocks.preflight.mockResolvedValueOnce({ ...preflightResult, needsApproval: true, totalTransactions: 2 })
      .mockResolvedValue(preflightResult);
    pageMocks.sendToken.mockImplementationOnce(async ({ onStep }) => {
      onStep({ needsApproval: true, totalTransactions: 2, type: "allowance-checked" });
      onStep({ hash: approvalHash, totalTransactions: 2, type: "approval-submitted" });
      onStep({ hash: approvalHash, totalTransactions: 2, type: "approval-confirmed" });
      onStep({ totalTransactions: 2, type: "distribution-signing" });
      throw Object.assign(new Error("User rejected the request"), { code: 4001 });
    });
    const user = await prepareReadyTokenDistributionPage();
    await screen.findByRole("alertdialog", { name: "确认 EVM 分发" });
    await user.click(within(screen.getByRole("alertdialog", { name: "确认 EVM 分发" })).getByRole("button", { name: "授权并分发" }));
    expect(await screen.findByRole("button", { name: "继续分发" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "说明：不可安全整批重试" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "EVM 分发交易结果" })).getByText("已确认")).toBeVisible();
    expect(within(screen.getByRole("table", { name: "EVM 分发交易结果" })).getByText("未提交")).toBeVisible();
    const stored = readTaskHistory("evm-distribution");
    expect(stored).toHaveLength(1);
    expect(stored[0].results.find((result) => result.label === "Token 授权")).toMatchObject({ hash: approvalHash, status: "success" });
    expect(stored[0].results.find((result) => result.label === "分发")).toMatchObject({ status: "skipped", uncertain: false });
    expect(stored[0].results.find((result) => result.label === "分发")?.hash).toBeUndefined();
    await user.click(screen.getByRole("button", { name: "继续分发" }));
    await screen.findByRole("alertdialog", { name: "确认 EVM 分发" });
    await user.click(within(screen.getByRole("alertdialog", { name: "确认 EVM 分发" })).getByRole("button", { name: "签名并分发" }));
    expect(await screen.findByText("分发完成")).toBeVisible();
    expect(pageMocks.preflight).toHaveBeenCalledTimes(4);
    expect(pageMocks.sendToken).toHaveBeenCalledTimes(2);
  });

  it("does not offer continue when a distribution signing call times out after confirmed approval", async () => {
    pageMocks.preflight.mockResolvedValue({ ...preflightResult, needsApproval: true, totalTransactions: 2 });
    pageMocks.sendToken.mockImplementationOnce(async ({ onStep }) => {
      onStep({ needsApproval: true, totalTransactions: 2, type: "allowance-checked" });
      onStep({ hash: approvalHash, totalTransactions: 2, type: "approval-submitted" });
      onStep({ hash: approvalHash, totalTransactions: 2, type: "approval-confirmed" });
      onStep({ totalTransactions: 2, type: "distribution-signing" });
      throw new Error("RPC timeout");
    });
    const user = await prepareReadyTokenDistributionPage();
    await screen.findByRole("alertdialog", { name: "确认 EVM 分发" });
    await user.click(within(screen.getByRole("alertdialog", { name: "确认 EVM 分发" })).getByRole("button", { name: "授权并分发" }));
    expect(await screen.findByRole("button", { name: "说明：不可安全整批重试" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "继续分发" })).not.toBeInTheDocument();
  });

  it("allows editing after an uncertain submission but blocks a new write until acknowledgement", async () => {
    pageMocks.sendNative.mockImplementationOnce(async ({ onSubmitted }) => {
      onSubmitted(transactionHash);
      throw new Error("等待回执失败");
    });
    const { addressInput, user } = await prepareReadyDistributionPage();
    await screen.findByRole("alertdialog", { name: "确认 EVM 分发" });
    const dialog = screen.getByRole("alertdialog", { name: "确认 EVM 分发" });
    await user.click(within(dialog).getByRole("button", { name: "签名并分发" }));

    expect(await screen.findByRole("button", { name: "说明：不可安全整批重试" })).toBeVisible();
    expect(document.querySelector(".workbench-status")).toHaveAttribute("data-state", "uncertain");
    expect(addressInput).toBeEnabled();
    expect(screen.queryByRole("button", { name: "返回修改并重新预检" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alertdialog", { name: "确认 EVM 分发" })).not.toBeInTheDocument();
    // Nothing wipes an unverified submission; acknowledging it is the only way on.
    expect(screen.queryByRole("button", { name: "清空清单" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "说明：不可安全整批重试" }));
    expect(screen.getByRole("dialog", { name: "不可安全整批重试" })).toHaveTextContent("请先核对交易哈希，再开始新任务");
    await user.keyboard("{Escape}");
    expect(pageMocks.preflight).toHaveBeenCalledTimes(2);
    expect(pageMocks.ensureNetwork).toHaveBeenCalledTimes(1);

    await user.type(addressInput, "\n0x00000000000000000000000000000000000000b2");
    expect(screen.getByText("分发记录")).toBeVisible();
    expect(screen.getByRole("button", { name: "已核对，开始新任务" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /开始分发|重新检查/ })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "已核对，开始新任务" }));
    const acknowledgement = screen.getByRole("alertdialog", { name: "已核对记录中的链上状态？" });
    await user.click(within(acknowledgement).getByRole("button", { name: "确认已核对" }));

    expect(screen.queryByRole("button", { name: "说明：不可安全整批重试" })).not.toBeInTheDocument();
    expect(addressInput).toHaveValue(`${recipient}\n0x00000000000000000000000000000000000000b2`);
    await waitFor(() => expect(screen.getByRole("button", { name: "开始分发" })).toBeEnabled());
  });
});
