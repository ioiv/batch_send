// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvmContractCallBatch, EvmContractCallConfig, EvmContractCallExecutionOptions, EvmContractCallRow } from "../lib/evm-contract-call";

const core = vi.hoisted(() => ({ prepare: vi.fn(), inspect: vi.fn(), execute: vi.fn(), retry: vi.fn(), dispose: vi.fn() }));
vi.mock("../lib/evm-contract-call", async () => ({
  ...await vi.importActual<typeof import("../lib/evm-contract-call")>("../lib/evm-contract-call"),
  prepareEvmContractCallBatch: core.prepare,
  inspectEvmContractCallTarget: core.inspect,
  executeEvmContractCallBatch: core.execute,
  retryEvmContractCallBatch: core.retry,
  disposeEvmContractCallBatch: core.dispose
}));

import { EvmContractCallPage } from "./EvmContractCallPage";

const secrets = ["61", "62", "63"].map(byte => `0x${byte.repeat(32)}` as `0x${string}`);
const addresses = secrets.map(secret => privateKeyToAccount(secret).address);
const contractAddress = "0x0000000000000000000000000000000000000001";
const rpcEndpoint = "https://rpc.example.test/private-token";
const calldataTemplate = "0x12345678{address}{random}{randowId}";
const transactionHash = `0x${"ab".repeat(32)}`;
const uncertainHash = `0x${"cd".repeat(32)}`;

function makeBatch(input: string, config: EvmContractCallConfig): EvmContractCallBatch {
  if (!input.trim()) throw new Error("请至少导入一个有效的 EVM 私钥");
  return {
    config,
    rows: input.split("\n").map((key, index) => ({
      id: `row-${index}`,
      index,
      line: index + 1,
      address: privateKeyToAccount(key as `0x${string}`).address,
      label: "",
      status: "pending",
      amountWei: 1_000_000_000_000_000n,
      randomId: BigInt(index + 7),
      calldata: `0x12345678${index.toString(16).padStart(64, "0")}`,
      hash: null,
      message: "待执行"
    }))
  };
}

beforeEach(() => {
  localStorage.clear();
  core.prepare.mockReset().mockImplementation(makeBatch);
  core.inspect.mockReset().mockResolvedValue({ chainId: 1 });
  core.execute.mockReset();
  core.retry.mockReset();
  core.dispose.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function importWallets(user: ReturnType<typeof userEvent.setup>, count = 2) {
  await user.click(screen.getByRole("button", { name: "导入钱包" }));
  const dialog = screen.getByRole("dialog", { name: "导入来源钱包" });
  fireEvent.input(within(dialog).getByRole("textbox", { name: "粘贴私钥" }), {
    target: { value: secrets.slice(0, count).join("\n") }
  });
  expect(within(dialog).getByLabelText("钱包导入预览")).toHaveTextContent(addresses[0]);
  await user.click(within(dialog).getByRole("button", { name: "确认导入" }));
}

async function setupPage(count = 2) {
  const user = userEvent.setup();
  render(<EvmContractCallPage />);
  await importWallets(user, count);
  fireEvent.change(screen.getByRole("textbox", { name: "合约地址" }), { target: { value: contractAddress } });
  if (!screen.queryByRole("textbox", { name: "RPC 节点" })) await user.click(screen.getByRole("button", { name: "修改 RPC" }));
  fireEvent.change(screen.getByRole("textbox", { name: "RPC 节点" }), { target: { value: rpcEndpoint } });
  fireEvent.change(screen.getByRole("textbox", { name: "调用数据" }), { target: { value: calldataTemplate } });
  await user.click(screen.getByRole("tab", { name: "固定金额" }));
  fireEvent.change(screen.getByRole("textbox", { name: "每钱包固定金额" }), { target: { value: "0.001" } });
  return user;
}

async function manageWallets(user: ReturnType<typeof userEvent.setup>) {
  const manage = screen.queryByRole("button", { name: "管理钱包" });
  if (manage) await user.click(manage);
}

function reviewButton() {
  return screen.getByRole("button", { name: "核对并发送" });
}

function sendButton() {
  return screen.getByRole("button", { name: /^确认发送 \d+ 笔$/ });
}

function resultTable() {
  return screen.getByRole("table", { name: "合约批量调用结果" });
}

async function reviewCalls(user: ReturnType<typeof userEvent.setup>) {
  await user.click(reviewButton());
  await waitFor(() => expect(sendButton()).toBeEnabled());
  return core.prepare.mock.results.at(-1)!.value as EvmContractCallBatch;
}

describe("EVM contract call workbench", () => {
  it("starts without native value and reveals amount and random-integer controls only when needed", async () => {
    const user = userEvent.setup();
    render(<EvmContractCallPage />);
    expect(screen.getByRole("tab", { name: "不附带金额" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("textbox", { name: "每钱包固定金额" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/randowId 最小值|随机整数最小值/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "调用数据" }), { target: { value: calldataTemplate } });
    expect(screen.getByLabelText(/randowId 最小值|随机整数最小值/)).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "调用数据" }), { target: { value: "0x12345678{address}" } });
    expect(screen.queryByLabelText(/randowId 最小值|随机整数最小值/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "固定金额" }));
    expect(screen.getByRole("textbox", { name: "每钱包固定金额" })).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "随机金额" }));
    expect(screen.getByRole("textbox", { name: "最小金额" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "最大金额" })).toBeVisible();
    expect(core.prepare).not.toHaveBeenCalled();
    expect(core.inspect).not.toHaveBeenCalled();
  });

  it("reviews only selected wallets on the selected chain and waits for explicit send without storing secrets", async () => {
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    const user = await setupPage();
    expect(screen.getByRole("button", { name: "管理钱包" })).toBeVisible();
    expect(screen.queryByRole("checkbox", { name: new RegExp(addresses[0], "i") })).not.toBeInTheDocument();
    const secretStore = document.querySelector<HTMLTextAreaElement>(".secret-dom-store")!;
    await manageWallets(user);
    expect(document.querySelector(".secret-dom-store")).toBe(secretStore);
    await user.click(screen.getByRole("checkbox", { name: new RegExp(addresses[1], "i") }));
    expect(screen.getByText("已选择 1 / 2")).toBeVisible();
    expect(core.prepare).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /^确认发送/ })).not.toBeInTheDocument();
    const batch = await reviewCalls(user);
    expect(core.prepare).toHaveBeenCalledExactlyOnceWith(secrets[0], expect.objectContaining({
      contractAddress,
      calldataTemplate,
      rpcEndpoint,
      expectedChainId: 1,
      amount: { mode: "fixed", fixed: "0.001", min: "0", max: "0" },
      taskNum: 3,
      delay: { mode: "fixed", minMs: 0, maxMs: 0 }
    }));
    expect(core.inspect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ contractAddress, rpcEndpoint, expectedChainId: 1 }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(core.execute).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(within(resultTable()).getAllByRole("row")).toHaveLength(2);
    expect(document.querySelector<HTMLTextAreaElement>(".secret-dom-store")!.value).toContain(secrets[0]);
    expect(document.body.textContent).not.toContain(secrets[0]);
    expect(document.body.textContent).not.toContain(secrets[1]);
    expect(JSON.stringify(storageWrite.mock.calls)).not.toContain(secrets[0]);
    expect(JSON.stringify(storageWrite.mock.calls)).not.toContain(secrets[1]);
    expect(batch.rows).toHaveLength(1);
  });

  it("updates the RPC and expected chain when a common network is selected", async () => {
    const user = await setupPage(1);
    const network = screen.getByRole("combobox", { name: "选择调用网络" });
    await user.click(network);
    await user.clear(network);
    await user.type(network, "8453");
    await user.click(screen.getByRole("option", { name: /Base.*8453/ }));
    await user.click(screen.getByRole("tab", { name: "不附带金额" }));
    core.inspect.mockResolvedValueOnce({ chainId: 8453 });
    const batch = await reviewCalls(user);
    expect(batch.config.expectedChainId).toBe(8453);
    expect(batch.config.rpcEndpoint).not.toBe(rpcEndpoint);
    expect(batch.config.amount).toEqual(expect.objectContaining({ mode: "fixed", fixed: "0" }));
    expect(core.inspect).toHaveBeenLastCalledWith(expect.objectContaining({ expectedChainId: 8453 }), expect.any(Object));
    expect(core.execute).not.toHaveBeenCalled();
  });

  it("inserts the canonical randomId placeholder and preserves its configured range", async () => {
    const user = await setupPage(1);
    const input = screen.getByRole("textbox", { name: "调用数据" });
    fireEvent.change(input, { target: { value: "0x12345678" } });
    await user.click(screen.getByRole("button", { name: "＋ 随机整数" }));
    expect(input).toHaveValue("0x12345678{randomId}");
    fireEvent.change(screen.getByRole("textbox", { name: "随机整数最小值" }), { target: { value: "5" } });
    fireEvent.change(screen.getByRole("textbox", { name: "随机整数最大值" }), { target: { value: "9" } });
    await reviewCalls(user);
    expect(core.prepare.mock.calls.at(-1)![1].randomId).toEqual({ min: "5", max: "9" });
  });

  it("exports the randomId column with the exact reviewed random integer", async () => {
    const NativeUrl = URL;
    const createObjectURL = vi.fn((_blob: Blob | MediaSource) => "blob:call-results");
    vi.stubGlobal("URL", class extends NativeUrl {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = vi.fn();
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const user = await setupPage(1);
    core.prepare.mockImplementationOnce((input: string, config: EvmContractCallConfig) => {
      const batch = makeBatch(input, config);
      return { ...batch, rows: batch.rows.map(row => ({ ...row, randomId: 9007199254740993123456789n })) };
    });
    await reviewCalls(user);
    await user.click(screen.getByRole("button", { name: "导出 CSV" }));
    const csv = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(createObjectURL.mock.calls[0][0] as Blob);
    });
    const [header, row] = csv.split("\r\n");
    expect(header).toContain('"value (wei)","randomId","状态"');
    expect(header).not.toContain("randowId");
    expect(row.split(",")[5]).toBe('"9007199254740993123456789"');
    expect(row).toContain(addresses[0]);
  });

  it("locates invalid calldata before making a target-check request", async () => {
    const user = await setupPage(1);
    const template = screen.getByRole("textbox", { name: "调用数据" });
    fireEvent.change(template, { target: { value: "0x123" } });
    await user.click(reviewButton());
    expect(template).toHaveAttribute("aria-invalid", "true");
    expect(core.inspect).not.toHaveBeenCalled();
    expect(core.prepare).not.toHaveBeenCalled();
    expect(core.execute).not.toHaveBeenCalled();
  });

  it("keeps wallets when returning to edit and discards the old plan before reviewing changed selections", async () => {
    const user = await setupPage();
    const firstBatch = await reviewCalls(user);
    await user.click(screen.getByRole("button", { name: "返回修改" }));
    expect(core.dispose).toHaveBeenCalledWith(firstBatch);
    expect(screen.queryByRole("button", { name: /^确认发送/ })).not.toBeInTheDocument();
    expect(document.querySelector<HTMLTextAreaElement>(".secret-dom-store")!.value).toContain(secrets[1]);
    fireEvent.change(screen.getByRole("textbox", { name: "调用数据" }), { target: { value: "0x87654321{address}" } });
    await manageWallets(user);
    await user.click(screen.getByRole("checkbox", { name: new RegExp(addresses[1], "i") }));
    await reviewCalls(user);
    expect(core.prepare.mock.calls.at(-1)![0]).toBe(secrets[0]);
    expect(core.prepare.mock.calls.at(-1)![1].calldataTemplate).toBe("0x87654321{address}");
    expect(core.execute).not.toHaveBeenCalled();
  });

  it("checks once while pending and ignores a stale response after configuration edits", async () => {
    const user = await setupPage();
    let resolveInspection!: (result: { chainId: number }) => void;
    core.inspect.mockImplementation(() => new Promise(resolve => { resolveInspection = resolve; }));
    const review = reviewButton();
    act(() => { fireEvent.click(review); fireEvent.click(review); });
    await waitFor(() => expect(core.inspect).toHaveBeenCalledTimes(1));
    expect(core.prepare).not.toHaveBeenCalled();
    const manage = screen.getByRole("button", { name: "管理钱包" });
    expect(manage).toBeDisabled();
    await user.click(manage);
    expect(screen.queryByRole("button", { name: "继续导入钱包" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "导入来源钱包" })).not.toBeInTheDocument();
    const signal = core.inspect.mock.calls[0][1].signal as AbortSignal;
    fireEvent.change(screen.getByRole("textbox", { name: "调用数据" }), { target: { value: "0x87654321" } });
    expect(signal.aborted).toBe(true);
    await act(async () => resolveInspection({ chainId: 1 }));
    expect(screen.queryByRole("button", { name: /^确认发送/ })).not.toBeInTheDocument();
    expect(core.prepare).not.toHaveBeenCalled();
    expect(core.execute).not.toHaveBeenCalled();
    core.inspect.mockResolvedValue({ chainId: 1 });
    await reviewCalls(user);
    expect(core.prepare.mock.calls[0][1].calldataTemplate).toBe("0x87654321");
  });

  it("cancels target inspection without losing wallets or accepting a late response", async () => {
    const user = await setupPage();
    let resolveInspection!: (result: { chainId: number }) => void;
    core.inspect.mockImplementation(() => new Promise(resolve => { resolveInspection = resolve; }));
    await user.click(reviewButton());
    const signal = core.inspect.mock.calls[0][1].signal as AbortSignal;
    await user.click(screen.getByRole("button", { name: "取消检查" }));
    expect(signal.aborted).toBe(true);
    expect(document.querySelector<HTMLTextAreaElement>(".secret-dom-store")!.value).toContain(secrets[0]);
    await act(async () => resolveInspection({ chainId: 1 }));
    expect(reviewButton()).toBeEnabled();
    expect(screen.queryByRole("button", { name: /^确认发送/ })).not.toBeInTheDocument();
    expect(core.prepare).not.toHaveBeenCalled();
    expect(core.execute).not.toHaveBeenCalled();
  });

  it("redacts target-check errors and allows correction without sending", async () => {
    const user = await setupPage(1);
    core.inspect.mockRejectedValue(new Error(`节点不可用 ${rpcEndpoint} signer=${secrets[0]}`));
    await user.click(reviewButton());
    await waitFor(() => expect(screen.getAllByText("节点不可用 [RPC 已隐藏] signer=[敏感数据已隐藏]").some(element => element.getAttribute("role") === "status")).toBe(true));
    expect(document.body.textContent).not.toContain(secrets[0]);
    expect(document.body.textContent).not.toContain(rpcEndpoint);
    expect(reviewButton()).toBeEnabled();
    expect(screen.queryByRole("button", { name: /^确认发送/ })).not.toBeInTheDocument();
    expect(core.prepare).not.toHaveBeenCalled();
    expect(core.execute).not.toHaveBeenCalled();
  });

  it("streams results, puts unresolved rows first, filters by status and sends each reviewed batch once", async () => {
    const user = await setupPage(3);
    const batch = await reviewCalls(user);
    let finish!: (rows: EvmContractCallRow[]) => void;
    let options!: EvmContractCallExecutionOptions;
    core.execute.mockImplementation((_batch: EvmContractCallBatch, executionOptions: EvmContractCallExecutionOptions) => {
      options = executionOptions;
      return new Promise(resolve => { finish = resolve; });
    });
    const send = sendButton();
    act(() => { fireEvent.click(send); fireEvent.click(send); });
    expect(core.execute).toHaveBeenCalledExactlyOnceWith(batch, expect.objectContaining({ signal: expect.any(AbortSignal), onUpdate: expect.any(Function) }));
    expect(screen.queryByRole("button", { name: /^确认发送/ })).not.toBeInTheDocument();
    expect(document.querySelector<HTMLInputElement>("#contract-call-to")).toBeDisabled();
    act(() => options.onUpdate?.({ ...batch.rows[0], status: "signing", message: "正在本地签名" }));
    expect(resultTable()).toHaveTextContent("签名中");
    const finalRows: EvmContractCallRow[] = [
      { ...batch.rows[0], status: "submitted", hash: transactionHash, message: "RPC 已接收" },
      { ...batch.rows[1], status: "failed", message: "余额不足" },
      { ...batch.rows[2], status: "unknown", hash: uncertainHash, message: "广播响应中断，请核对" }
    ];
    await act(async () => finish(finalRows));
    expect(screen.getByRole("status", { name: "有交易待核对" })).toHaveAttribute("data-state", "uncertain");
    const rows = within(resultTable()).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("待核对");
    expect(rows[1]).toHaveTextContent("失败");
    expect(rows[2]).toHaveTextContent("已提交");
    expect(core.dispose).toHaveBeenCalledWith(batch);
    expect(screen.getByRole("button", { name: "开始新一轮" })).toBeEnabled();
    expect(screen.queryByText(uncertainHash)).not.toBeInTheDocument();
    await user.click(within(rows[0]).getByLabelText("查看钱包 3的调用详情"));
    await waitFor(() => expect(within(rows[0]).getByText(uncertainHash)).toBeVisible());
    await user.click(screen.getByRole("button", { name: /^待核对/ }));
    expect(within(resultTable()).getAllByRole("row")).toHaveLength(2);
    expect(resultTable()).toHaveTextContent("待核对");
    expect(resultTable()).not.toHaveTextContent("余额不足");
    expect(core.execute).toHaveBeenCalledTimes(1);
  });

  it.each(["submitted", "unknown"] as const)("continues only unsent wallets, preserves prior results and acknowledges only new uncertain outcomes (%s)", async retryStatus => {
    const user = await setupPage(3);
    const batch = await reviewCalls(user);
    const finalRows: EvmContractCallRow[] = [
      { ...batch.rows[0], status: "submitted", hash: transactionHash, message: "RPC 已接收" },
      { ...batch.rows[1], status: "cancelled", message: "已停止后续任务" },
      { ...batch.rows[2], status: "unknown", hash: uncertainHash, message: "请核对" }
    ];
    core.execute.mockResolvedValueOnce(finalRows);
    await user.click(sendButton());
    const retryBatch: EvmContractCallBatch = { config: batch.config, rows: [{ ...finalRows[1], status: "pending" }] };
    core.retry.mockReturnValue(retryBatch);
    expect(await screen.findByRole("button", { name: "仅继续 1 个未发送钱包" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: "我已核对待核对交易的链上结果" }));
    await user.click(await screen.findByRole("button", { name: "仅继续 1 个未发送钱包" }));
    expect(core.retry).toHaveBeenCalledExactlyOnceWith(secrets.join("\n"), batch.config, finalRows);
    await waitFor(() => expect(sendButton()).toBeEnabled());
    expect(core.prepare).toHaveBeenCalledTimes(1);
    expect(core.inspect).toHaveBeenLastCalledWith(batch.config, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(core.execute).toHaveBeenCalledTimes(1);
    core.execute.mockResolvedValueOnce([{ ...retryBatch.rows[0], status: retryStatus, hash: `0x${"ef".repeat(32)}` }]);
    await user.click(sendButton());
    await waitFor(() => expect(core.execute).toHaveBeenCalledTimes(2));
    expect(core.execute.mock.calls[1][0]).toBe(retryBatch);
    await waitFor(() => expect(within(resultTable()).getAllByRole("row")).toHaveLength(4));
    for (const [walletLabel, hash] of [["钱包 1", transactionHash], ["钱包 3", uncertainHash]]) {
      const row = within(resultTable()).getByText(walletLabel).closest("tr")!;
      await user.click(within(row).getByLabelText(`查看${walletLabel}的调用详情`));
      await waitFor(() => expect(within(row).getByText(hash)).toBeVisible());
    }
    const acknowledgement = screen.getByRole("checkbox", { name: "我已核对待核对交易的链上结果" });
    if (retryStatus === "unknown") expect(acknowledgement).not.toBeChecked();
    else expect(acknowledgement).toBeChecked();
  });

  it("requires unresolved broadcasts to be reviewed before continuing or preparing a new round", async () => {
    const user = await setupPage(3);
    const batch = await reviewCalls(user);
    core.execute.mockResolvedValueOnce([
      { ...batch.rows[0], status: "submitted", hash: transactionHash, message: "RPC 已接收" },
      { ...batch.rows[1], status: "cancelled", message: "已停止后续任务" },
      { ...batch.rows[2], status: "unknown", hash: uncertainHash, message: "请核对" }
    ]);
    await user.click(sendButton());
    const retry = await screen.findByRole("button", { name: "仅继续 1 个未发送钱包" });
    expect(retry).toBeDisabled();
    await user.click(retry);
    expect(core.retry).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "开始新一轮" }));
    expect(screen.getByRole("textbox", { name: "调用数据" })).toBeVisible();
    expect(reviewButton()).toBeDisabled();
    await user.click(reviewButton());
    expect(core.inspect).toHaveBeenCalledTimes(1);
    expect(core.prepare).toHaveBeenCalledTimes(1);
    expect(core.execute).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "查看上一轮结果" }));
    const acknowledgement = screen.getByRole("checkbox", { name: "我已核对待核对交易的链上结果" });
    expect(acknowledgement).not.toBeChecked();
    await user.click(acknowledgement);
    expect(screen.getByRole("button", { name: "仅继续 1 个未发送钱包" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "开始新一轮" }));
    expect(reviewButton()).toBeEnabled();
    await reviewCalls(user);
    expect(core.inspect).toHaveBeenCalledTimes(2);
    expect(core.prepare).toHaveBeenCalledTimes(2);
    expect(core.execute).toHaveBeenCalledTimes(1);
  });

  it("offers no resend path for submitted or uncertain broadcasts", async () => {
    const user = await setupPage();
    const batch = await reviewCalls(user);
    core.execute.mockResolvedValue([
      { ...batch.rows[0], status: "submitted", hash: transactionHash, message: "RPC 已接收" },
      { ...batch.rows[1], status: "unknown", hash: null, message: "广播响应中断" }
    ]);
    await user.click(sendButton());
    await waitFor(() => expect(screen.getByRole("button", { name: "开始新一轮" })).toBeEnabled());
    expect(screen.queryByRole("button", { name: /^仅继续/ })).not.toBeInTheDocument();
    expect(core.retry).not.toHaveBeenCalled();
  });

  it("unlocks source management for a new round and keeps submitted results in the previous round", async () => {
    const user = await setupPage();
    const batch = await reviewCalls(user);
    let executionOptions!: EvmContractCallExecutionOptions;
    core.execute.mockImplementationOnce((_batch: EvmContractCallBatch, options: EvmContractCallExecutionOptions) => {
      executionOptions = options;
      return Promise.resolve(batch.rows.map(row => ({ ...row, status: "submitted", hash: transactionHash, message: "RPC 已接收" })));
    });
    await user.click(sendButton());
    await user.click(await screen.findByRole("button", { name: "开始新一轮" }));
    expect(screen.getByRole("status", { name: "编辑中" })).toBeVisible();
    await manageWallets(user);
    expect(screen.getByRole("button", { name: "继续导入钱包" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "取消全选" })).toBeEnabled();
    const secondWallet = screen.getByRole("checkbox", { name: new RegExp(addresses[1], "i") });
    expect(secondWallet).toBeEnabled();
    expect(screen.getByRole("button", { name: `删除 ${addresses[0]}` })).toBeEnabled();
    expect(screen.queryAllByText("确认中")).toHaveLength(0);
    await user.click(secondWallet);
    expect(screen.getByText("已选择 1 / 2")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "继续导入钱包" }));
    expect(screen.getByRole("dialog", { name: "导入来源钱包" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "取消" }));
    act(() => executionOptions.onUpdate?.({ ...batch.rows[0], status: "signing", message: "旧任务的延迟回调" }));
    expect(screen.queryByText("旧任务的延迟回调")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "查看上一轮结果" }));
    expect(resultTable()).toHaveTextContent("已提交");
    await user.click(screen.getByRole("button", { name: "开始新一轮" }));
    await user.click(screen.getByRole("button", { name: `删除 ${addresses[0]}` }));
    expect(screen.getByText("已选择 0 / 1")).toBeVisible();
    await user.click(screen.getByRole("checkbox", { name: new RegExp(addresses[1], "i") }));
    await reviewCalls(user);
    expect(core.prepare.mock.calls.at(-1)![0]).toBe(secrets[1]);
    act(() => executionOptions.onUpdate?.({ ...batch.rows[0], status: "signing", message: "旧任务的延迟回调" }));
    expect(resultTable()).toHaveTextContent("待发送");
    expect(resultTable()).not.toHaveTextContent("签名中");
    expect(within(resultTable()).getByTitle(addresses[1])).toBeVisible();
  });

  it("redacts execution errors and disposes the plan before another round", async () => {
    const user = await setupPage(1);
    const batch = await reviewCalls(user);
    core.execute.mockRejectedValue(new Error(`节点不可用 ${rpcEndpoint} signer=${secrets[0]}`));
    await user.click(sendButton());
    await waitFor(() => expect(core.dispose).toHaveBeenCalledWith(batch));
    expect(screen.getAllByText("节点不可用 [RPC 已隐藏] signer=[敏感数据已隐藏]").some(element => element.getAttribute("role") === "status")).toBe(true);
    expect(document.body.textContent).not.toContain(secrets[0]);
    expect(document.body.textContent).not.toContain(rpcEndpoint);
    expect(screen.queryByRole("button", { name: /^确认发送/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始新一轮" })).toBeEnabled();
    expect(core.execute).toHaveBeenCalledTimes(1);
  });

  it("clears private keys and invalidates the reviewed batch when the page is hidden", async () => {
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    const user = await setupPage();
    const batch = await reviewCalls(user);
    const secretStore = document.querySelector<HTMLTextAreaElement>(".secret-dom-store")!;
    expect(secretStore.value).toContain(secrets[0]);
    act(() => window.dispatchEvent(new Event("pagehide")));
    expect(core.dispose).toHaveBeenCalledWith(batch);
    expect(secretStore.value).toBe("");
    expect(screen.queryByRole("button", { name: /^确认发送/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("已导入来源钱包")).not.toBeInTheDocument();
    expect(core.execute).not.toHaveBeenCalled();
    expect(JSON.stringify(storageWrite.mock.calls)).not.toContain(secrets[0]);
  });

  it("aborts an unfinished target check on pagehide and ignores its late response", async () => {
    const user = await setupPage();
    let resolveInspection!: (result: { chainId: number }) => void;
    core.inspect.mockImplementation(() => new Promise(resolve => { resolveInspection = resolve; }));
    await user.click(reviewButton());
    const signal = core.inspect.mock.calls[0][1].signal as AbortSignal;
    act(() => window.dispatchEvent(new Event("pagehide")));
    expect(signal.aborted).toBe(true);
    expect(document.querySelector<HTMLTextAreaElement>(".secret-dom-store")!.value).toBe("");
    await act(async () => resolveInspection({ chainId: 1 }));
    expect(screen.queryByRole("button", { name: /^确认发送/ })).not.toBeInTheDocument();
    expect(core.prepare).not.toHaveBeenCalled();
    expect(core.execute).not.toHaveBeenCalled();
  });

  it("aborts queued work and clears keys on pagehide during execution", async () => {
    const user = await setupPage();
    const batch = await reviewCalls(user);
    let signal!: AbortSignal;
    core.execute.mockImplementation((_batch: EvmContractCallBatch, options: EvmContractCallExecutionOptions) => {
      signal = options.signal!;
      return new Promise<EvmContractCallRow[]>(resolve => {
        signal.addEventListener("abort", () => resolve(batch.rows.map(row => ({ ...row, status: "cancelled", message: "已停止后续任务" }))), { once: true });
      });
    });
    await user.click(sendButton());
    expect(signal.aborted).toBe(false);
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    expect(signal.aborted).toBe(true);
    expect(document.querySelector<HTMLTextAreaElement>(".secret-dom-store")!.value).toBe("");
    expect(core.dispose).toHaveBeenCalledWith(batch);
    expect(screen.queryByRole("button", { name: /^确认发送/ })).not.toBeInTheDocument();
    expect(core.execute).toHaveBeenCalledTimes(1);
  });
});
