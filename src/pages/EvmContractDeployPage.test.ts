// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deployMocks = vi.hoisted(() => ({
  deploy: vi.fn(),
  getLiveGas: vi.fn(),
  providerRequest: vi.fn(),
  resolveNetwork: vi.fn(),
  validate: vi.fn()
}));

vi.mock("../lib/evm-gas", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/evm-gas")>();
  return { ...actual, getLiveEvmFeeQuote: deployMocks.getLiveGas };
});

vi.mock("../hooks/useEvmWallet", () => ({
  useEvmWallet: () => ({
    address: "0x00000000000000000000000000000000000000a1",
    buttonLabel: "断开钱包",
    chainIdHex: "0x1",
    connectWallet: vi.fn(),
    connected: true,
    disconnectWallet: vi.fn(),
    getProvider: () => ({ request: deployMocks.providerRequest }),
    message: "",
    providerName: "测试钱包",
    selectedWalletId: "test-wallet",
    selectWallet: vi.fn(),
    status: "connected",
    statusText: "测试钱包 · 已连接",
    wallets: []
  })
}));

vi.mock("../lib/createx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/createx")>();
  return {
    ...actual,
    deployDisperseContract: deployMocks.deploy,
    resolveDisperseDeploymentNetwork: deployMocks.resolveNetwork,
    runDisperseDeploymentValidation: deployMocks.validate
  };
});

import { EvmContractDeployPage, getDeploymentSafetyState } from "./EvmContractDeployPage";

const transactionHash = "0x" + "cd".repeat(32);
const deploymentPreflight = {
  checks: [],
  estimatedFee: 120_000n,
  estimatedGas: 100_000n,
  feeCapPerGas: 1n,
  feeParameters: { gasPrice: 1n, type: "legacy" as const },
  gasLimit: 120_000n,
  status: "ready" as const,
  targetState: "absent" as const
};

afterEach(cleanup);

beforeEach(() => {
  window.localStorage.clear();
  deployMocks.deploy.mockReset();
  deployMocks.getLiveGas.mockReset().mockResolvedValue({
    gasPrice: 2_000_000_000n,
    sampledAt: 1_700_000_000_000,
    source: "rpc",
    type: "legacy"
  });
  deployMocks.providerRequest.mockReset();
  deployMocks.resolveNetwork.mockReset().mockImplementation(async (rpcEndpoint: string) => ({
    blockExplorerUrl: "https://etherscan.io",
    chainId: 1,
    label: "Ethereum",
    metadataCandidates: [],
    metadataSource: "built-in",
    metadataStatus: "confirmed",
    nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
    rpcEndpoint,
    sourceVersion: "app"
  }));
  deployMocks.validate.mockReset().mockResolvedValue(deploymentPreflight);
});

async function prepareReadyDeploymentPage() {
  const user = userEvent.setup();
  render(createElement(EvmContractDeployPage));
  const validateButton = screen.getByRole("button", { name: "校验部署条件" });
  expect(validateButton).toBeEnabled();
  await user.click(validateButton);
  await screen.findByRole("button", { name: "确认部署" });
  return user;
}

describe("EvmContractDeployPage safety", () => {
  it("shows live Gas and passes a custom Gas Price into deployment validation", async () => {
    const user = userEvent.setup();
    render(createElement(EvmContractDeployPage));

    expect(await screen.findByLabelText("实时 Gas 推荐：慢 1.8 Gwei，中 2 Gwei，快 2.4 Gwei")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "RPC、Gas、浏览器与链元数据" }));
    const gasSettings = screen.getByLabelText("Gas 设置");
    await user.click(within(gasSettings).getByRole("tab", { name: "自定义" }));
    await user.type(within(gasSettings).getByRole("spinbutton", { name: "Gas Price（Gwei）" }), "6");
    await user.click(screen.getByRole("button", { name: "校验部署条件" }));

    await screen.findByRole("button", { name: "确认部署" });
    expect(deployMocks.validate).toHaveBeenCalledWith(expect.objectContaining({
      gasSettings: {
        fee: { gasPrice: 6_000_000_000n, type: "legacy" },
        mode: "custom"
      }
    }));
  });

  it("blocks deployment validation while the custom Gas Price is invalid", async () => {
    const user = userEvent.setup();
    render(createElement(EvmContractDeployPage));
    await user.click(screen.getByRole("button", { name: "RPC、Gas、浏览器与链元数据" }));
    const gasSettings = screen.getByLabelText("Gas 设置");
    await user.click(within(gasSettings).getByRole("tab", { name: "自定义" }));

    expect(within(gasSettings).queryByText(/请输入大于 0/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "校验部署条件" })).toBeDisabled();
    expect(deployMocks.validate).not.toHaveBeenCalled();
  });

  it("does not expose retry after a deployment hash enters an uncertain state", () => {
    const state = getDeploymentSafetyState(
      "error",
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );

    expect(state.submittedButUncertain).toBe(true);
    expect(state.canRetryValidation).toBe(false);
    expect(state.workbenchStatus).toBe("uncertain");
  });

  it("requires a ready preflight before the confirmation action is presented", () => {
    expect(getDeploymentSafetyState("idle", "").workbenchStatus).toBe("editing");
    expect(getDeploymentSafetyState("validating", "").workbenchStatus).toBe("preflight");
    expect(getDeploymentSafetyState("ready", "").workbenchStatus).toBe("ready");
  });

  it("shows a failed deployment preflight and can validate again from the error state", async () => {
    deployMocks.validate.mockRejectedValueOnce(new Error("Gas 余额不足"));
    const user = userEvent.setup();
    render(createElement(EvmContractDeployPage));
    await user.click(screen.getByRole("button", { name: "校验部署条件" }));

    expect(await screen.findByText("部署已阻断")).toBeVisible();
    expect(document.querySelector(".workbench-status")).toHaveAttribute("data-state", "error");
    expect(screen.queryByRole("button", { name: "确认部署" })).not.toBeInTheDocument();
    expect(deployMocks.deploy).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "重新校验" }));
    expect(await screen.findByRole("button", { name: "确认部署" })).toBeEnabled();
    expect(deployMocks.resolveNetwork).toHaveBeenCalledTimes(2);
    expect(deployMocks.validate).toHaveBeenCalledTimes(2);
  });

  it("closes the CreateX confirmation without deploying when the user cancels", async () => {
    const user = await prepareReadyDeploymentPage();
    const trigger = screen.getByRole("button", { name: "确认部署" });
    await user.click(trigger);
    const dialog = screen.getByRole("alertdialog", { name: "确认 CreateX 部署" });
    await user.click(within(dialog).getByRole("button", { name: "取消" }));

    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(deployMocks.deploy).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
  });

  it("invalidates deployment confirmation when its validated context changes", async () => {
    const user = await prepareReadyDeploymentPage();
    expect(screen.getByRole("button", { name: "确认部署" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "RPC、Gas、浏览器与链元数据" }));
    const explorerInput = screen.getByRole("textbox", { name: "区块浏览器地址" });
    await user.clear(explorerInput);
    await user.type(explorerInput, "https://explorer.example");

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "确认部署" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "校验部署条件" })).toBeEnabled();
    });
    expect(deployMocks.validate).toHaveBeenCalledTimes(1);
    expect(deployMocks.deploy).not.toHaveBeenCalled();
  });

  it("invalidates deployment confirmation when the Gas setting changes", async () => {
    const user = await prepareReadyDeploymentPage();
    await user.click(screen.getByRole("button", { name: "RPC、Gas、浏览器与链元数据" }));
    await user.click(within(screen.getByLabelText("Gas 设置")).getByRole("tab", { name: "自定义" }));

    expect(screen.queryByRole("button", { name: "确认部署" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "校验部署条件" })).toBeDisabled();
  });

  it("completes deployment, keeps registration explicit, and starts a clean task on confirmation", async () => {
    deployMocks.deploy.mockImplementationOnce(async ({ onStage }) => {
      const receipt = { status: "success" };
      onStage?.({ preflight: deploymentPreflight, type: "awaiting-wallet" });
      onStage?.({ hash: transactionHash, type: "submitted" });
      onStage?.({ hash: transactionHash, receipt, type: "confirmed" });
      onStage?.({ hash: transactionHash, receipt, type: "verified" });
      return {
        alreadyDeployed: false,
        hash: transactionHash,
        preflight: deploymentPreflight,
        receipt
      };
    });
    const user = await prepareReadyDeploymentPage();
    await user.click(screen.getByRole("button", { name: "确认部署" }));
    const deployDialog = screen.getByRole("alertdialog", { name: "确认 CreateX 部署" });
    await user.click(within(deployDialog).getByRole("button", { name: "签名并部署" }));

    expect(await screen.findByText("部署与 runtime 验证完成")).toBeVisible();
    expect(document.querySelector(".workbench-status")).toHaveAttribute("data-state", "success");
    expect(screen.getByTitle(transactionHash)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "EVM 分发链名称" })).toHaveValue("Ethereum");
    expect(screen.getByRole("button", { name: "加入 EVM 分发" })).toBeEnabled();
    expect(screen.queryByText("链配置已加入")).not.toBeInTheDocument();
    expect(deployMocks.deploy).toHaveBeenCalledWith(expect.objectContaining({
      gasSettings: { mode: "auto" }
    }));

    await user.click(screen.getByRole("button", { name: "新建部署任务" }));
    const newTaskDialog = screen.getByRole("alertdialog", { name: "清空并新建部署任务？" });
    expect(within(newTaskDialog).getByText(/已产生交易哈希/)).toBeInTheDocument();
    await user.click(within(newTaskDialog).getByRole("button", { name: "新建部署任务" }));

    await waitFor(() => expect(document.querySelector(".workbench-status")).toHaveAttribute("data-state", "editing"));
    expect(screen.queryByTitle(transactionHash)).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "EVM 分发链名称" })).not.toBeInTheDocument();
    const validateButton = screen.getByRole("button", { name: "校验部署条件" });
    expect(validateButton).toBeEnabled();
    await user.click(validateButton);
    expect(await screen.findByRole("button", { name: "确认部署" })).toBeEnabled();
  });

  it("removes every deploy retry action after a submitted hash becomes uncertain", async () => {
    deployMocks.deploy.mockImplementationOnce(async ({ onStage }) => {
      onStage?.({ preflight: deploymentPreflight, type: "awaiting-wallet" });
      onStage?.({ hash: transactionHash, type: "submitted" });
      throw new Error("回执超时");
    });
    const user = await prepareReadyDeploymentPage();
    await user.click(screen.getByRole("button", { name: "确认部署" }));
    const dialog = screen.getByRole("alertdialog", { name: "确认 CreateX 部署" });
    await user.click(within(dialog).getByRole("button", { name: "签名并部署" }));

    expect(await screen.findByText("禁止直接重试部署")).toBeVisible();
    expect(document.querySelector(".workbench-status")).toHaveAttribute("data-state", "uncertain");
    expect(screen.getByTitle(transactionHash)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重新校验" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "校验部署条件" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认部署" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "RPC、Gas、浏览器与链元数据" })).toHaveAttribute("aria-disabled", "true");

    const newTaskTrigger = screen.getByRole("button", { name: "新建部署任务" });
    await user.click(newTaskTrigger);
    let newTaskDialog = screen.getByRole("alertdialog", { name: "清空并新建部署任务？" });
    expect(within(newTaskDialog).getByText(/先核验链上状态/)).toBeInTheDocument();
    expect(within(newTaskDialog).getByText(/不代表可以安全重试/)).toBeInTheDocument();
    await user.click(within(newTaskDialog).getByRole("button", { name: "取消" }));
    expect(document.querySelector(".workbench-status")).toHaveAttribute("data-state", "uncertain");
    expect(screen.getByTitle(transactionHash)).toBeInTheDocument();

    await user.click(newTaskTrigger);
    newTaskDialog = screen.getByRole("alertdialog", { name: "清空并新建部署任务？" });
    await user.click(within(newTaskDialog).getByRole("button", { name: "新建部署任务" }));
    await waitFor(() => expect(document.querySelector(".workbench-status")).toHaveAttribute("data-state", "editing"));
    expect(screen.queryByTitle(transactionHash)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "校验部署条件" })).toBeEnabled();
  });
});
