// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const solMocks = vi.hoisted(() => ({
  assertNetwork: vi.fn(),
  collect: vi.fn(),
  parseSources: vi.fn(),
  preflight: vi.fn()
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
    parseSolanaSourceKeys: solMocks.parseSources,
    preflightSolCollectionSources: solMocks.preflight
  };
});

import { getSolCollectionWorkbenchStatus, SolCollectionPage } from "./SolCollectionPage";

const targetAddress = "11111111111111111111111111111111";
const firstSourceAddress = "So11111111111111111111111111111111111111112";
const secondSourceAddress = "Vote111111111111111111111111111111111111111";
const preflightResult = {
  errorSources: 0,
  estimatedNetworkFeeLamports: 5_000n,
  executableSources: 1,
  items: [{
    address: firstSourceAddress,
    balanceLamports: 1_000_000_000n,
    feeLamports: 5_000n,
    label: "来源一",
    line: 1,
    message: "可归集",
    reserveLamports: 2_000_000n,
    status: "ready" as const,
    transferLamports: 997_995_000n
  }],
  skippedSources: 0,
  totalBalanceLamports: 1_000_000_000n,
  totalTransferLamports: 997_995_000n
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  solMocks.assertNetwork.mockResolvedValue(undefined);
  solMocks.parseSources.mockReturnValue({
    duplicates: [],
    errors: [],
    sources: [{
      address: firstSourceAddress,
      keypair: {},
      label: "来源一",
      line: 1
    }]
  });
  solMocks.preflight.mockResolvedValue(preflightResult);
  solMocks.collect.mockResolvedValue([]);
});

async function prepareReadySolPage() {
  const user = userEvent.setup();
  render(<SolCollectionPage />);
  await user.type(screen.getByRole("textbox", { name: "目标钱包" }), targetAddress);
  await user.type(screen.getByRole("textbox", { name: "来源钱包密钥" }), "local-secret");
  await user.click(screen.getByRole("button", { name: "预检余额与费用" }));
  await screen.findByRole("button", { name: "确认并开始归集" });
  return user;
}

async function confirmSolExecution(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "确认并开始归集" }));
  const dialog = screen.getByRole("alertdialog", { name: "确认 SOL 归集？" });
  await user.click(within(dialog).getByRole("button", { name: "确认并开始归集" }));
}

describe("SolCollectionPage workbench", () => {
  it("orders target, source and network fields without legacy steps", () => {
    render(<SolCollectionPage />);
    const target = screen.getByRole("textbox", { name: "目标钱包" });
    const source = screen.getByRole("textbox", { name: "来源钱包密钥" });
    const network = screen.getByRole("combobox", { name: "选择 Solana 网络" });

    expect(target.compareDocumentPosition(source) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(source.compareDocumentPosition(network) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("编辑中")).toBeInTheDocument();
    expect(screen.queryByText(/下一步|预检准备项|密钥仅在本地内存/)).not.toBeInTheDocument();
  });

  it("shows a blocking error when read-only preflight fails", async () => {
    solMocks.preflight.mockResolvedValueOnce({
      ...preflightResult,
      errorSources: 1,
      executableSources: 0,
      items: [{
        ...preflightResult.items[0],
        message: "无法读取来源余额",
        status: "error"
      }]
    });
    const user = userEvent.setup();
    render(<SolCollectionPage />);
    await user.type(screen.getByRole("textbox", { name: "目标钱包" }), targetAddress);
    await user.type(screen.getByRole("textbox", { name: "来源钱包密钥" }), "local-secret");
    await user.click(screen.getByRole("button", { name: "预检余额与费用" }));

    expect(await screen.findByText(/1 个来源预检失败/)).toBeInTheDocument();
    expect(screen.getAllByText("需要处理").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "确认并开始归集" })).not.toBeInTheDocument();
    expect(solMocks.collect).not.toHaveBeenCalled();
  });

  it("renders a successful execution in place and clears the source key", async () => {
    solMocks.collect.mockResolvedValueOnce([{
      address: firstSourceAddress,
      balanceLamports: 1_000_000_000n,
      feeLamports: 5_000n,
      label: "来源一",
      line: 1,
      message: "归集成功",
      reserveLamports: 2_000_000n,
      signature: "success-signature",
      status: "success",
      transferLamports: 997_995_000n
    }]);
    const user = await prepareReadySolPage();
    await confirmSolExecution(user);

    expect(await screen.findByText(/执行结束：1 笔成功/)).toBeInTheDocument();
    expect(screen.getAllByText("已完成").length).toBeGreaterThan(0);
    expect(screen.getByRole("textbox", { name: "来源钱包密钥" })).toHaveValue("");
    expect(screen.getByRole("link", { name: "查看来源一的交易" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "目标钱包" })).toBeDisabled();
  });

  it("keeps mixed success and failure results visible and blocks blind retry", async () => {
    solMocks.parseSources.mockReturnValue({
      duplicates: [],
      errors: [],
      sources: [
        { address: firstSourceAddress, keypair: {}, label: "来源一", line: 1 },
        { address: secondSourceAddress, keypair: {}, label: "来源二", line: 2 }
      ]
    });
    solMocks.preflight.mockResolvedValueOnce({
      ...preflightResult,
      executableSources: 2,
      items: [
        preflightResult.items[0],
        { ...preflightResult.items[0], address: secondSourceAddress, label: "来源二", line: 2 }
      ],
      totalBalanceLamports: 2_000_000_000n,
      totalTransferLamports: 1_995_990_000n
    });
    solMocks.collect.mockResolvedValueOnce([
      {
        address: firstSourceAddress,
        balanceLamports: 1_000_000_000n,
        feeLamports: 5_000n,
        label: "来源一",
        line: 1,
        message: "归集成功",
        reserveLamports: 2_000_000n,
        signature: "success-signature",
        status: "success",
        transferLamports: 997_995_000n
      },
      {
        address: secondSourceAddress,
        balanceLamports: 1_000_000_000n,
        feeLamports: 5_000n,
        label: "来源二",
        line: 2,
        message: "提交失败",
        reserveLamports: 2_000_000n,
        status: "error",
        transferLamports: 997_995_000n
      }
    ]);
    const user = await prepareReadySolPage();
    await confirmSolExecution(user);

    expect(await screen.findByText(/执行结束：1 笔成功，0 笔跳过，1 笔失败/)).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /来源一.*已完成/ })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /来源二.*失败/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "请先核对链上结果" })).toBeDisabled();
  });

  it("cancels execution, invalidates a ready preflight on edit, and confirms clearing", async () => {
    const user = await prepareReadySolPage();
    const executeTrigger = screen.getByRole("button", { name: "确认并开始归集" });

    await user.click(executeTrigger);
    const executeDialog = screen.getByRole("alertdialog", { name: "确认 SOL 归集？" });
    await user.click(within(executeDialog).getByRole("button", { name: "取消" }));
    expect(solMocks.collect).not.toHaveBeenCalled();

    const target = screen.getByRole("textbox", { name: "目标钱包" });
    await user.clear(target);
    await user.type(target, targetAddress);
    expect(screen.getByText("编辑中")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认并开始归集" })).not.toBeInTheDocument();

    const clearTrigger = screen.getByRole("button", { name: "清空任务" });
    await user.click(clearTrigger);
    let clearDialog = screen.getByRole("alertdialog", { name: "清空当前 SOL 归集任务？" });
    await user.click(within(clearDialog).getByRole("button", { name: "取消" }));
    expect(target).toHaveValue(targetAddress);

    await user.click(clearTrigger);
    clearDialog = screen.getByRole("alertdialog", { name: "清空当前 SOL 归集任务？" });
    await user.click(within(clearDialog).getByRole("button", { name: "清空任务" }));
    expect(target).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "来源钱包密钥" })).toHaveValue("");

    await user.type(target, targetAddress);
    await user.type(screen.getByRole("textbox", { name: "来源钱包密钥" }), "new-local-secret");
    await user.click(screen.getByRole("button", { name: "预检余额与费用" }));
    expect(await screen.findByRole("button", { name: "确认并开始归集" })).toBeEnabled();
  });

  it("maps a submitted hash followed by interruption to uncertain and locks retry", async () => {
    solMocks.collect.mockImplementationOnce(async ({ onProgress }) => {
      onProgress?.({
        address: firstSourceAddress,
        completed: 0,
        current: 1,
        label: "来源一",
        phase: "submitted",
        signature: "submitted-signature",
        total: 1,
        transferLamports: 997_995_000n
      });
      throw new Error("interrupted");
    });
    const user = await prepareReadySolPage();
    await user.click(screen.getByRole("button", { name: "确认并开始归集" }));
    const dialog = screen.getByRole("alertdialog", { name: "确认 SOL 归集？" });
    await user.click(within(dialog).getByRole("button", { name: "确认并开始归集" }));

    await waitFor(() => expect(screen.getAllByText("需核对链上状态").length).toBeGreaterThan(0));
    expect(screen.getByRole("button", { name: "请先核对链上结果" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "目标钱包" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "清空任务" }));
    const clearDialog = screen.getByRole("alertdialog", { name: "清空当前 SOL 归集任务？" });
    expect(within(clearDialog).getByText(/包含已提交的交易哈希/)).toBeInTheDocument();
    await user.click(within(clearDialog).getByRole("button", { name: "取消" }));
    expect(screen.getAllByText("需核对链上状态").length).toBeGreaterThan(0);
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
