// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const solMocks = vi.hoisted(() => ({
  assertNetwork: vi.fn(),
  collect: vi.fn(),
  parseSources: vi.fn()
}));

vi.mock("../lib/solana", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/solana")>();
  return { ...actual, assertSolanaRpcNetwork: solMocks.assertNetwork };
});

vi.mock("../lib/sol-collection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/sol-collection")>();
  return {
    ...actual,
    collectSolFromSources: solMocks.collect,
    parseSolanaSourceKeys: solMocks.parseSources
  };
});

import { getSolCollectionWorkbenchStatus, SolCollectionPage } from "./SolCollectionPage";

const targetAddress = "11111111111111111111111111111111";
const firstSourceAddress = "So11111111111111111111111111111111111111112";
const secondSourceAddress = "Vote111111111111111111111111111111111111111";

function source(address = firstSourceAddress, label = "来源一", line = 1) {
  return { address, keypair: {}, label, line };
}

function result({
  address = firstSourceAddress,
  label = "来源一",
  retryable = false,
  signature = "success-signature",
  status = "success"
}: {
  address?: string;
  label?: string;
  retryable?: boolean;
  signature?: string;
  status?: "error" | "success";
}) {
  return {
    address,
    balanceLamports: 1_000_000_000n,
    feeLamports: 5_000n,
    label,
    line: 1,
    message: status === "success" ? "归集成功" : "RPC 请求失败，可重试",
    reserveLamports: 0n,
    retryable,
    ...(signature ? { signature } : {}),
    status,
    transferLamports: 999_995_000n
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  window.localStorage.clear();
  solMocks.assertNetwork.mockResolvedValue(undefined);
  solMocks.parseSources.mockReturnValue({ duplicates: [], errors: [], sources: [source()] });
  solMocks.collect.mockResolvedValue([]);
});

async function importSolSecret(user: ReturnType<typeof userEvent.setup>, secret = "local-secret") {
  await user.click(screen.getByRole("button", { name: /导入钱包/ }));
  const dialog = screen.getByRole("dialog", { name: "导入来源钱包" });
  await user.type(within(dialog).getByRole("textbox", { name: "粘贴私钥" }), secret);
  await user.click(within(dialog).getByRole("button", { name: "确认导入" }));
}

async function prepareSolPage() {
  const user = userEvent.setup();
  render(<SolCollectionPage />);
  await user.type(screen.getByRole("textbox", { name: "目标钱包" }), targetAddress);
  await importSolSecret(user);
  expect(screen.getByRole("button", { name: "确认并开始归集" })).toBeEnabled();
  return user;
}

async function confirmExecution(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "确认并开始归集" }));
  const dialog = screen.getByRole("alertdialog", { name: "确认 SOL 归集？" });
  await user.click(within(dialog).getByRole("button", { name: "确认并开始归集" }));
}

describe("SolCollectionPage workbench", () => {
  it("shows selection, four amount modes and direct confirmation without a preflight section", () => {
    render(<SolCollectionPage />);
    const target = screen.getByRole("textbox", { name: "目标钱包" });
    const sourceImport = screen.getByRole("button", { name: "导入钱包" });
    const network = screen.getByRole("combobox", { name: "选择 Solana 网络" });

    expect(target.compareDocumentPosition(sourceImport) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(sourceImport.compareDocumentPosition(network) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    ["全部数量", "百分比数量", "随机数量", "固定数量"].forEach((name) => (
      expect(screen.getByRole("tab", { name })).toBeInTheDocument()
    ));
    expect(screen.queryByText(/预检与结果|等待预检/)).not.toBeInTheDocument();
  });

  it("passes percentage, concurrency and random delay settings to direct execution", async () => {
    const user = await prepareSolPage();
    await user.click(screen.getByRole("tab", { name: "百分比数量" }));
    const percentage = screen.getByRole("spinbutton", { name: "归集百分比" });
    await user.clear(percentage);
    await user.type(percentage, "25");
    await confirmExecution(user);

    await waitFor(() => expect(solMocks.collect).toHaveBeenCalledTimes(1));
    expect(solMocks.collect).toHaveBeenCalledWith(expect.objectContaining({
      amountPolicy: { mode: "percentage", percentageBps: 2_500n },
      executionSettings: { concurrency: 3, maximumDelayMs: 0, minimumDelayMs: 0 }
    }));
  });

  it("keeps the wallet and renders success status inside its imported row", async () => {
    solMocks.collect.mockResolvedValueOnce([result({})]);
    const user = await prepareSolPage();
    await confirmExecution(user);

    expect(await screen.findByText(/归集完成：1 笔成功/)).toBeVisible();
    const walletList = screen.getByLabelText("已导入来源钱包");
    expect(within(walletList).getByText("已完成")).toBeVisible();
    expect(within(walletList).getByText("SOL · 0.999995")).toBeVisible();
    expect(within(walletList).getByRole("link", { name: "查看交易" })).toBeVisible();
    expect(screen.queryByRole("table", { name: "归集结果" })).not.toBeInTheDocument();

    const target = screen.getByRole("textbox", { name: "目标钱包" });
    expect(target).toBeEnabled();
    await user.clear(target);
    await user.type(target, targetAddress);
    expect(target).toHaveValue(targetAddress);
    expect(screen.getByLabelText("已导入来源钱包")).toBeVisible();
    expect(screen.getByText("归集记录")).toBeVisible();
  });

  it("offers retry for safe failures and retries only those wallets", async () => {
    solMocks.parseSources.mockReturnValue({
      duplicates: [],
      errors: [],
      sources: [source(), source(secondSourceAddress, "来源二", 2)]
    });
    solMocks.collect
      .mockResolvedValueOnce([
        result({}),
        result({ address: secondSourceAddress, label: "来源二", retryable: true, signature: "", status: "error" })
      ])
      .mockResolvedValueOnce([
        result({ address: secondSourceAddress, label: "来源二" })
      ]);
    const user = await prepareSolPage();
    await confirmExecution(user);

    const retryTrigger = await screen.findByRole("button", { name: "重试失败项 (1)" });
    expect(screen.getByLabelText(new RegExp(`来源二.*${secondSourceAddress}.*归集状态`))).toHaveTextContent("失败");
    await user.click(retryTrigger);
    const retryDialog = screen.getByRole("alertdialog", { name: "确认重试失败项？" });
    await user.click(within(retryDialog).getByRole("button", { name: "重试 1 个失败钱包" }));

    await waitFor(() => expect(solMocks.collect).toHaveBeenCalledTimes(2));
    expect(solMocks.collect.mock.calls[1][0].sources).toEqual([
      expect.objectContaining({ address: secondSourceAddress })
    ]);
  });

  it("does not offer automatic retry after a submitted transaction becomes uncertain", async () => {
    solMocks.collect.mockImplementationOnce(async ({ onProgress }) => {
      onProgress?.({
        address: firstSourceAddress,
        completed: 0,
        current: 1,
        label: "来源一",
        phase: "submitted",
        signature: "submitted-signature",
        total: 1,
        transferLamports: 999_995_000n
      });
      throw new Error("interrupted");
    });
    const user = await prepareSolPage();
    await confirmExecution(user);

    expect(await screen.findByText(/已显示签名的项目请先核对链上状态/)).toBeVisible();
    expect(screen.queryByRole("button", { name: /重试失败项/ })).not.toBeInTheDocument();
    const target = screen.getByRole("textbox", { name: "目标钱包" });
    expect(target).toBeEnabled();
    await user.clear(target);
    await user.type(target, targetAddress);
    expect(screen.getByText("归集记录")).toBeVisible();
    expect(screen.getByRole("button", { name: "已核对，开始新任务" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "确认并开始归集" })).toBeDisabled();
  });

  it("persists a replacement RPC and uses it on the next mount", async () => {
    const user = userEvent.setup();
    const firstRender = render(<SolCollectionPage />);
    await user.click(screen.getByRole("button", { name: "RPC、保留金额与执行设置" }));
    const rpc = screen.getByRole("textbox", { name: "RPC 地址" });
    await user.clear(rpc);
    await user.type(rpc, "https://custom.sol.example/rpc");
    await user.tab();
    firstRender.unmount();

    render(<SolCollectionPage />);
    await user.click(screen.getByRole("button", { name: "RPC、保留金额与执行设置" }));
    expect(screen.getByRole("textbox", { name: "RPC 地址" })).toHaveValue("https://custom.sol.example/rpc");
  });

  it("exposes the complete status mapping, including hash uncertainty", () => {
    const failedWithHash = [{
      address: targetAddress,
      amount: "1",
      asset: "SOL",
      hash: "signature",
      message: "待核对",
      status: "error" as const
    }];
    expect(getSolCollectionWorkbenchStatus("checking", [])).toBe("preflight");
    expect(getSolCollectionWorkbenchStatus("ready", [])).toBe("ready");
    expect(getSolCollectionWorkbenchStatus("running", [])).toBe("running");
    expect(getSolCollectionWorkbenchStatus("complete", [])).toBe("success");
    expect(getSolCollectionWorkbenchStatus("error", failedWithHash)).toBe("uncertain");
  });
});
