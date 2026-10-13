// @vitest-environment jsdom

import { expandSettings, expandTaskDetails } from "../test/workbench";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const solanaMocks = vi.hoisted(() => ({
  assertNetwork: vi.fn(),
  batchSignEnabled: false,
  blockhashNonce: 0,
  confirmTransaction: vi.fn(),
  connectionConstructorErrorEndpoint: "" as string,
  connectionEndpoints: [] as string[],
  createTransaction: vi.fn(),
  estimateFees: vi.fn(),
  getBalance: vi.fn(),
  getLatestBlockhash: vi.fn(),
  planChunks: vi.fn(),
  refreshTransactions: vi.fn(),
  sendRawTransaction: vi.fn(),
  sendWalletTransaction: vi.fn(),
  signAllTransactions: vi.fn(),
  signTransaction: vi.fn()
}));

vi.mock("../lib/task-history-refresh", () => ({ refreshTaskTransactions: solanaMocks.refreshTransactions }));

vi.mock("../lib/solana", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/solana")>();
  return {
    ...actual,
    Connection: class ConnectionStub {
      endpoint: string;

      constructor(endpoint: string) {
        this.endpoint = endpoint;
        solanaMocks.connectionEndpoints.push(endpoint);
        if (endpoint === solanaMocks.connectionConstructorErrorEndpoint) {
          throw new Error("RPC 构造失败");
        }
      }

      async getLatestBlockhash() {
        return solanaMocks.getLatestBlockhash();
      }

      async confirmTransaction(...args: unknown[]) {
        return solanaMocks.confirmTransaction(...args);
      }

      async sendRawTransaction(...args: unknown[]) {
        return solanaMocks.sendRawTransaction(...args);
      }
    },
    assertSolanaRpcNetwork: solanaMocks.assertNetwork,
    createTransferTransaction: solanaMocks.createTransaction,
    estimateTransactionFeesLamports: solanaMocks.estimateFees,
    getBalanceLamports: solanaMocks.getBalance,
    planTransferChunks: solanaMocks.planChunks,
    sendWalletTransaction: solanaMocks.sendWalletTransaction
  };
});

vi.mock("../hooks/useSolanaWallet", () => ({
  useSolanaWallet: () => ({
    address: "BPFLoader1111111111111111111111111111111111",
    buttonLabel: "断开钱包",
    connectWallet: vi.fn(),
    connected: true,
    disconnectWallet: vi.fn(),
    message: "",
    provider: {
      connect: vi.fn(),
      signAllTransactions: solanaMocks.batchSignEnabled ? solanaMocks.signAllTransactions : undefined,
      signTransaction: solanaMocks.signTransaction
    },
    providerName: "测试钱包",
    selectedWalletId: "test",
    status: "connected",
    statusText: "已连接",
    wallets: []
  })
}));

import { BatchDistributorPage, getUnsentSolanaDistribution } from "./BatchDistributorPage";
import { parseDistribution } from "../lib/distribution";
import { readTaskHistory, saveTaskRecord } from "../lib/task-history";

afterEach(cleanup);

beforeEach(() => {
  window.history.replaceState({}, "", "/sol/");
  window.localStorage.clear();
  window.sessionStorage.clear();
  solanaMocks.assertNetwork.mockReset().mockResolvedValue(undefined);
  solanaMocks.refreshTransactions.mockReset().mockImplementation(async (record) => record);
  solanaMocks.batchSignEnabled = false;
  solanaMocks.blockhashNonce = 0;
  solanaMocks.confirmTransaction.mockReset().mockResolvedValue({ value: { err: null } });
  solanaMocks.connectionConstructorErrorEndpoint = "";
  solanaMocks.connectionEndpoints.length = 0;
  solanaMocks.createTransaction.mockReset().mockImplementation((_sender, _chunk, blockhash) => ({
    blockhash,
    serialize: () => new Uint8Array([1])
  }));
  solanaMocks.estimateFees.mockReset().mockResolvedValue(5_000n);
  solanaMocks.getBalance.mockReset().mockResolvedValue(10_000_000_000n);
  solanaMocks.getLatestBlockhash.mockReset().mockImplementation(async () => {
    solanaMocks.blockhashNonce += 1;
    return {
      blockhash: `blockhash-${solanaMocks.blockhashNonce}`,
      lastValidBlockHeight: 100 + solanaMocks.blockhashNonce
    };
  });
  solanaMocks.planChunks.mockReset().mockImplementation((rows: unknown[]) => [rows]);
  solanaMocks.sendRawTransaction.mockReset().mockImplementation(async () => `batch-signature-${solanaMocks.sendRawTransaction.mock.calls.length}`);
  solanaMocks.sendWalletTransaction.mockReset().mockResolvedValue("solana-signature-1");
  solanaMocks.signAllTransactions.mockReset().mockImplementation(async (transactions) => transactions);
  solanaMocks.signTransaction.mockReset();
});

function getRecipientEditor(name = "收款地址") {
  const input = screen.queryByRole("textbox", { name });
  const details = input?.closest("details") || screen.getByText("编辑原始清单", { selector: "summary" }).closest("details");
  if (details && !details.open) fireEvent.click(details.querySelector("summary")!);
  return screen.getByRole("textbox", { name });
}

async function waitForInitialBalanceLookup() {
  await waitFor(() => {
    expect(solanaMocks.assertNetwork).toHaveBeenCalledTimes(1);
    expect(solanaMocks.getBalance).toHaveBeenCalledTimes(1);
  });
}

describe("BatchDistributorPage network safety", () => {
  const recipient = "11111111111111111111111111111111";
  const validHash = "4".repeat(88);
  const makeSavedTask = (id: string, hash = validHash, uncertain = true) => ({
    id, toolId: "sol-distribution", label: "旧轮次", network: { kind: "solana" as const, id: "mainnet-beta", label: "Mainnet" },
    createdAt: "2026-10-12T08:00:00Z", updatedAt: "2026-10-12T08:00:00Z",
    results: [{ address: recipient, asset: "SOL", amount: "0.1", hash, message: "旧交易", status: uncertain ? "confirming" as const : "success" as const, uncertain }]
  });
  const openAndConfirm = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole("button", { name: "开始分发" }));
    await user.click(within(await screen.findByRole("alertdialog", { name: "确认 SOL 批量分发" })).getByRole("button", { name: "确认并签名" }));
  };

  it("persists a pending broadcast before calling the sender and saves its hash before confirmation", async () => {
    solanaMocks.sendWalletTransaction.mockImplementationOnce(async () => {
      const pending = readTaskHistory("sol-distribution")[0].results[0];
      expect(pending).toMatchObject({ status: "confirming", uncertain: true });
      expect(pending.hash).toBeUndefined();
      window.dispatchEvent(new Event("pagehide"));
      expect(readTaskHistory("sol-distribution")[0].results[0].uncertain).toBe(true);
      return validHash;
    });
    solanaMocks.confirmTransaction.mockImplementationOnce(async () => {
      expect(readTaskHistory("sol-distribution")[0].results[0]).toMatchObject({ hash: validHash, uncertain: true });
      return { value: { err: null } };
    });
    const user = userEvent.setup();
    render(<BatchDistributorPage />);
    await user.type(getRecipientEditor(), recipient);
    await openAndConfirm(user);
    expect(await screen.findByText("已完成 1 笔交易确认")).toBeVisible();
  });

  it("checks the latest storage before signing if another tab adds an unknown task", async () => {
    const user = userEvent.setup();
    render(<BatchDistributorPage />);
    await user.type(getRecipientEditor(), recipient);
    await user.click(screen.getByRole("button", { name: "开始分发" }));
    const dialog = await screen.findByRole("alertdialog", { name: "确认 SOL 批量分发" });
    saveTaskRecord(makeSavedTask("external-unknown"));
    await user.click(within(dialog).getByRole("button", { name: "确认并签名" }));
    expect(solanaMocks.sendWalletTransaction).not.toHaveBeenCalled();
    expect(await screen.findByText("请先在可恢复任务记录中核对之前提交的交易")).toBeVisible();
  });

  it("checks storage again before broadcasting after the signing-time balance check", async () => {
    const user = userEvent.setup();
    render(<BatchDistributorPage />);
    await user.type(getRecipientEditor(), recipient);
    await user.click(screen.getByRole("button", { name: "开始分发" }));
    solanaMocks.estimateFees.mockImplementationOnce(async () => {
      saveTaskRecord(makeSavedTask("external-during-preflight"));
      return 5_000n;
    });
    await user.click(within(await screen.findByRole("alertdialog", { name: "确认 SOL 批量分发" })).getByRole("button", { name: "确认并签名" }));
    expect(await screen.findByText("请先在可恢复任务记录中核对之前提交的交易")).toBeVisible();
    expect(solanaMocks.sendWalletTransaction).not.toHaveBeenCalled();
  });

  it("keeps a queried old round from replacing the current archive's history identity", async () => {
    saveTaskRecord(makeSavedTask("older-complete", "5".repeat(88), false));
    solanaMocks.sendWalletTransaction.mockResolvedValueOnce(validHash);
    solanaMocks.confirmTransaction.mockRejectedValueOnce(new Error("RPC timeout"));
    const user = userEvent.setup();
    render(<BatchDistributorPage />);
    await user.type(getRecipientEditor(), recipient);
    await openAndConfirm(user);
    await screen.findByRole("button", { name: "说明：禁止直接重试" });
    const currentId = readTaskHistory("sol-distribution").find((record) => record.id !== "older-complete")!.id;
    const olderRound = screen.getByText("旧轮次 · Mainnet").closest(".task-history__round")! as HTMLElement;
    await user.click(within(olderRound).getByRole("button", { name: "继续查询交易状态" }));
    await waitFor(() => expect(readTaskHistory("sol-distribution")[0].id).toBe("older-complete"));
    await user.click(screen.getByRole("button", { name: "开始新一轮分发" }));
    await user.click(screen.getByRole("button", { name: "已核对，开始新任务" }));
    await user.click(within(screen.getByRole("alertdialog", { name: "已核对记录中的链上状态？" })).getByRole("button", { name: "确认已核对" }));
    expect(readTaskHistory("sol-distribution").find((record) => record.id === currentId)?.acknowledgedAt).toBeTruthy();
    expect(readTaskHistory("sol-distribution").find((record) => record.id === "older-complete")?.acknowledgedAt).toBeUndefined();
  });

  it("reimports an exact unsent CSV and signs the original amounts without regeneration", async () => {
    const user = userEvent.setup();
    render(<BatchDistributorPage />);
    const exact = "11111111111111111111111111111111,0.123456789\nBPFLoader1111111111111111111111111111111111,0.987654321";
    const file = new File([exact], "sol-unsent-distribution.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", { value: vi.fn().mockResolvedValue(exact) });
    await user.upload(document.querySelector<HTMLInputElement>('input[type="file"]')!, file);
    await user.click(within(await screen.findByRole("dialog", { name: "导入收款钱包" })).getByRole("button", { name: "确认导入清单" }));
    expect(getRecipientEditor("收款地址与金额")).toHaveValue(exact);
    await user.click(screen.getByRole("button", { name: "开始分发" }));
    const dialog = await screen.findByRole("alertdialog", { name: "确认 SOL 批量分发" });
    expect(within(dialog).getByText("1.11111111 SOL")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "确认并签名" }));
    expect(await screen.findByText("已完成 1 笔交易确认")).toBeVisible();
    const plannedRows = solanaMocks.planChunks.mock.calls.at(-1)![0] as Array<{ amountRaw: string; lamports: bigint }>;
    expect(plannedRows.map((row) => [row.amountRaw, row.lamports])).toEqual([["0.123456789", 123_456_789n], ["0.987654321", 987_654_321n]]);
  });

  it("blocks a new distribution until an interrupted saved task is reviewed", async () => {
    saveTaskRecord({
      id: "sol-interrupted", toolId: "sol-distribution", label: "SOL 批量分发",
      network: { kind: "solana", id: "mainnet-beta", label: "Mainnet" },
      createdAt: "2026-10-12T08:00:00Z", updatedAt: "2026-10-12T08:00:00Z",
      results: [{ address: "11111111111111111111111111111111", asset: "SOL", amount: "0.123456789", hash: "4".repeat(88), message: "正在确认", status: "confirming" }]
    });
    const user = userEvent.setup();
    render(<BatchDistributorPage />);
    await user.type(getRecipientEditor(), "11111111111111111111111111111111");
    expect(screen.getByRole("button", { name: "开始分发" })).toBeDisabled();
    expect(screen.getByText("请先在可恢复任务记录中核对之前提交的交易")).toBeVisible();
    const historyToggle = screen.queryByRole("button", { name: "展开可恢复任务记录" });
    if (historyToggle) await user.click(historyToggle);
    expect(screen.getByRole("button", { name: "删除记录" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "已人工核对链上结果" }));
    await user.click(within(screen.getByRole("alertdialog", { name: "已核对这轮交易的链上结果？" })).getByRole("button", { name: "确认已核对" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "开始分发" })).toBeEnabled());
    expect(solanaMocks.sendWalletTransaction).not.toHaveBeenCalled();
  });

  it("shows the current RPC summary and expands its editable field", () => {
    render(<BatchDistributorPage />);

    const networkAndRpc = screen.getByLabelText("网络与 RPC");
    expect(within(networkAndRpc).getByRole("combobox")).toBeVisible();
    expandSettings("修改 RPC");
    expect(within(networkAndRpc).getByRole("textbox", { name: "RPC" }))
      .toHaveValue("https://api.mainnet-beta.solana.com");
    expect(screen.queryByRole("button", { name: "高级设置" })).not.toBeInTheDocument();
  });

  it("clears the mixed URL amount warning when the user supplies a uniform amount", async () => {
    const list = "11111111111111111111111111111111,1\nBPFLoader1111111111111111111111111111111111,2";
    window.history.replaceState({}, "", `/sol/?${new URLSearchParams({ list }).toString()}`);
    const user = userEvent.setup();
    render(<BatchDistributorPage />);

    expect(screen.getByText("旧清单金额未导入")).toBeVisible();
    await user.type(screen.getByRole("spinbutton", { name: "每个地址的金额（SOL）" }), "0.25");
    await waitFor(() => expect(screen.queryByText("旧清单金额未导入")).not.toBeInTheDocument());
  });

  it("does not construct a connection for an incomplete custom RPC", async () => {
    const user = userEvent.setup();
    render(<BatchDistributorPage />);
    await waitForInitialBalanceLookup();

    await user.type(
      getRecipientEditor(),
      "11111111111111111111111111111111"
    );
    expandSettings("修改 RPC");
    const rpcInput = screen.getByRole("textbox", { name: "RPC" });
    const connectionCount = solanaMocks.connectionEndpoints.length;

    fireEvent.change(rpcInput, { target: { value: "h" } });

    expect(await screen.findByText("RPC 地址无效：请输入完整的 HTTP 或 HTTPS 地址")).toBeVisible();
    expect(screen.getByText("RPC 地址无效：请输入完整的 HTTP 或 HTTPS 地址").closest('[role="alert"]')).toBeInTheDocument();
    expect(rpcInput).toHaveAttribute("aria-invalid", "true");
    expect(solanaMocks.connectionEndpoints).toHaveLength(connectionCount);
    expect(screen.getByRole("button", { name: "开始分发" })).toBeDisabled();
  });

  it("turns a synchronous connection constructor failure into a balance error", async () => {
    render(<BatchDistributorPage />);
    await waitForInitialBalanceLookup();

    solanaMocks.connectionConstructorErrorEndpoint = "https://throws.example";
    expandSettings("修改 RPC");
    fireEvent.change(screen.getByRole("textbox", { name: "RPC" }), {
      target: { value: solanaMocks.connectionConstructorErrorEndpoint }
    });

    expect(await screen.findByText("余额读取失败：RPC 构造失败")).toBeVisible();
    expect(screen.getByRole("heading", { name: "SOL 批量分发" })).toBeVisible();
    expect(solanaMocks.connectionEndpoints).toContain("https://throws.example");
    expect(solanaMocks.getBalance).toHaveBeenCalledTimes(1);
  });

  it("checks the RPC cluster before exposing its wallet balance", async () => {
    render(<BatchDistributorPage />);
    await waitForInitialBalanceLookup();
    solanaMocks.assertNetwork.mockImplementation(async (connection: { endpoint?: string }) => {
      if (connection.endpoint === "https://api.devnet.solana.com") {
        throw new Error("RPC 网络不匹配：当前选择 Mainnet");
      }
    });
    solanaMocks.getBalance.mockClear();
    solanaMocks.getBalance.mockResolvedValue(99_000_000_000n);

    expandSettings("修改 RPC");
    fireEvent.change(screen.getByRole("textbox", { name: "RPC" }), {
      target: { value: "https://api.devnet.solana.com" }
    });

    expect(await screen.findByText(/RPC 网络不匹配：当前选择 Mainnet/)).toBeVisible();
    expect(solanaMocks.assertNetwork).toHaveBeenLastCalledWith(
      expect.objectContaining({ endpoint: "https://api.devnet.solana.com" }),
      "mainnet-beta"
    );
    expect(solanaMocks.getBalance).not.toHaveBeenCalled();
    expandTaskDetails();
    expect(screen.getByRole("region", { name: "清单摘要" })).not.toHaveTextContent("99 SOL");
  });

  it("opens confirmation automatically after one click and performs no signing during its checks", async () => {
    const user = userEvent.setup();
    render(<BatchDistributorPage />);
    await waitForInitialBalanceLookup();
    let finishFees!: (fee: bigint) => void;
    solanaMocks.estimateFees.mockImplementationOnce(() => new Promise<bigint>((resolve) => { finishFees = resolve; }));
    await user.type(getRecipientEditor(), recipient);
    expect(screen.queryByRole("button", { name: /预检|复检/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "开始分发" }));
    await waitFor(() => expect(solanaMocks.estimateFees).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "检查中" })).toBeDisabled();
    expect(screen.queryByRole("alertdialog", { name: "确认 SOL 批量分发" })).not.toBeInTheDocument();
    expect(solanaMocks.sendWalletTransaction).not.toHaveBeenCalled();
    expect(solanaMocks.signAllTransactions).not.toHaveBeenCalled();
    await act(async () => { finishFees(5_000n); });
    const dialog = await screen.findByRole("alertdialog", { name: "确认 SOL 批量分发" });
    expect(within(dialog).getByRole("button", { name: "确认并签名" })).toBeEnabled();
    expect(within(dialog).getByText("0.000005 SOL")).toBeVisible();
    expect(solanaMocks.sendWalletTransaction).not.toHaveBeenCalled();
    expect(solanaMocks.signTransaction).not.toHaveBeenCalled();
  });

  it("shows a blocking check error when the wallet cannot cover amount and fees", async () => {
    solanaMocks.getBalance.mockResolvedValue(1n);
    const user = userEvent.setup();
    render(<BatchDistributorPage />);
    expect(document.querySelector(".workbench-grid")).toBeInTheDocument();

    await user.type(
      getRecipientEditor(),
      "11111111111111111111111111111111"
    );
    await user.click(screen.getByRole("button", { name: "开始分发" }));

    expect(await screen.findByText(/余额不足：预计共需/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "确认并签名" })).not.toBeInTheDocument();
    expect(solanaMocks.sendWalletTransaction).not.toHaveBeenCalled();
  });

  it("rechecks the genesis hash before signing and blocks a mismatched RPC", async () => {
    const user = userEvent.setup();
    render(<BatchDistributorPage />);
    await waitForInitialBalanceLookup();
    solanaMocks.assertNetwork.mockClear();
    solanaMocks.assertNetwork
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("RPC 网络不匹配：请选择 Mainnet 的 RPC"));

    await user.type(
      getRecipientEditor(),
      "11111111111111111111111111111111"
    );

    const preflightButton = screen.getByRole("button", { name: "开始分发" });
    await waitFor(() => expect(preflightButton).toBeEnabled());
    await user.click(preflightButton);
    await waitFor(() => expect(solanaMocks.assertNetwork).toHaveBeenCalledTimes(1));
    await screen.findByRole("button", { name: "确认并签名" });
    expect(document.querySelector(".workbench-action-bar__actions")?.querySelectorAll("button")).toHaveLength(1);

    const dialog = await screen.findByRole("alertdialog", { name: "确认 SOL 批量分发" });
    await user.click(within(dialog).getByRole("button", { name: "确认并签名" }));

    await waitFor(() => expect(solanaMocks.assertNetwork).toHaveBeenCalledTimes(2));
    expect(solanaMocks.assertNetwork).toHaveBeenNthCalledWith(1, expect.anything(), "mainnet-beta");
    expect(solanaMocks.assertNetwork).toHaveBeenNthCalledWith(2, expect.anything(), "mainnet-beta");
    expect(solanaMocks.estimateFees).toHaveBeenCalledTimes(1);
    expect(solanaMocks.signTransaction).not.toHaveBeenCalled();
    expect(screen.getByText(/RPC 网络不匹配/)).toBeVisible();
  });

  it("closes the confirmation dialog without signing when the user cancels", async () => {
    const user = userEvent.setup();
    render(<BatchDistributorPage />);
    await waitForInitialBalanceLookup();
    solanaMocks.assertNetwork.mockClear();

    await user.type(
      getRecipientEditor(),
      "11111111111111111111111111111111"
    );
    const preflightButton = screen.getByRole("button", { name: "开始分发" });
    await waitFor(() => expect(preflightButton).toBeEnabled());
    await user.click(preflightButton);
    await screen.findByRole("button", { name: "确认并签名" });
    expect(document.querySelector(".workbench-action-bar__actions")?.querySelectorAll("button")).toHaveLength(1);

    const dialog = await screen.findByRole("alertdialog", { name: "确认 SOL 批量分发" });
    await user.click(within(dialog).getByRole("button", { name: "取消" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "确认 SOL 批量分发" })).not.toBeInTheDocument());
    expect(solanaMocks.assertNetwork).toHaveBeenCalledTimes(1);
    expect(solanaMocks.signTransaction).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "开始分发" })).toBeEnabled();
    expect(getRecipientEditor()).toBeEnabled();
    await waitFor(() => expect(screen.getByRole("button", { name: "开始分发" })).toHaveFocus());
    await user.keyboard("{Enter}");
    await screen.findByRole("alertdialog", { name: "确认 SOL 批量分发" });
    expect(solanaMocks.assertNetwork).toHaveBeenCalledTimes(2);
    expect(solanaMocks.estimateFees).toHaveBeenCalledTimes(2);
    expect(solanaMocks.sendWalletTransaction).not.toHaveBeenCalled();
  });

  it("closes confirmation and invalidates its checks as soon as the distribution input changes", async () => {
    const user = userEvent.setup();
    render(<BatchDistributorPage />);
    await waitForInitialBalanceLookup();
    solanaMocks.assertNetwork.mockClear();

    const editor = getRecipientEditor();
    await user.type(editor, "11111111111111111111111111111111");
    const preflightButton = screen.getByRole("button", { name: "开始分发" });
    await waitFor(() => expect(preflightButton).toBeEnabled());
    await user.click(preflightButton);
    await screen.findByRole("button", { name: "确认并签名" });
    expect(document.querySelector(".workbench-action-bar__actions")?.querySelectorAll("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "确认并签名" })).toBeEnabled();

    fireEvent.change(editor, { target: { value: `${recipient}\nBPFLoader1111111111111111111111111111111111` } });

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "确认并签名" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "开始分发" })).toBeEnabled();
    });
    expect(solanaMocks.assertNetwork).toHaveBeenCalledTimes(1);
    expect(solanaMocks.signTransaction).not.toHaveBeenCalled();
  });

  it("completes a distribution and starts the next round from the kept list", async () => {
    const user = userEvent.setup();
    render(<BatchDistributorPage />);

    const editor = getRecipientEditor();
    await user.type(editor, "11111111111111111111111111111111");
    await user.click(screen.getByRole("button", { name: "开始分发" }));
    await screen.findByRole("button", { name: "确认并签名" });
    expect(document.querySelector(".workbench-action-bar__actions")?.querySelectorAll("button")).toHaveLength(1);
    await user.click(within(await screen.findByRole("alertdialog", { name: "确认 SOL 批量分发" }))
      .getByRole("button", { name: "确认并签名" }));

    expect(await screen.findByText(/已完成 1 笔交易确认/)).toBeVisible();
    expect(screen.getByRole("link", { name: /交易 1:/ })).not.toBeVisible();
    expandTaskDetails();
    expect(screen.getByRole("link", { name: /交易 1:/ })).toHaveAttribute("href", expect.stringContaining("solana-signature-1"));
    expect(screen.queryByRole("button", { name: "清空清单" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "开始新一轮分发" }));
    expect(editor).toHaveValue("11111111111111111111111111111111");
    expect(screen.getByText("分发记录")).toBeVisible();
    expect(screen.getByRole("button", { name: "开始分发" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "清空" }));
    await user.click(within(await screen.findByRole("alertdialog", { name: "清空收款清单？" }))
      .getByRole("button", { name: "确认清空" }));
    expect(getRecipientEditor()).toHaveValue("");
  });

  it("separates confirmed addresses from cancelled unsent addresses", async () => {
    solanaMocks.planChunks.mockImplementation((rows: unknown[]) => {
      const values = rows as unknown[];
      return [[values[0]], [values[1]]];
    });
    solanaMocks.sendWalletTransaction
      .mockResolvedValueOnce("solana-signature-partial")
      .mockRejectedValueOnce(new Error("wallet rejected"));
    const user = userEvent.setup();
    render(<BatchDistributorPage />);

    const editor = getRecipientEditor();
    await user.type(
      editor,
      "11111111111111111111111111111111\nBPFLoader1111111111111111111111111111111111"
    );
    await user.click(screen.getByRole("button", { name: "开始分发" }));
    await screen.findByRole("button", { name: "确认并签名" });
    expect(document.querySelector(".workbench-action-bar__actions")?.querySelectorAll("button")).toHaveLength(1);
    await user.click(within(await screen.findByRole("alertdialog", { name: "确认 SOL 批量分发" }))
      .getByRole("button", { name: "确认并签名" }));

    expect(await screen.findByText(/1 笔已确认；1 个地址确定未转出/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "说明：禁止直接重试" })).not.toBeInTheDocument();
    const results = screen.getByRole("table", { name: "SOL 分发清单状态" });
    expect(within(results).getByText("已确认")).toBeVisible();
    expect(within(results).getByText("未提交")).toBeVisible();
    expect(screen.getByRole("button", { name: "导出未发送清单（原金额）" })).toBeVisible();
    const stored = readTaskHistory("sol-distribution");
    expect(stored).toHaveLength(1);
    expect(stored[0].results.map((result) => result.status)).toEqual(["success", "skipped"]);
    expect(stored[0].results.map((result) => result.amount)).toEqual(["0.1", "0.1"]);
    expect(editor).toBeEnabled();
    expect(screen.queryByRole("button", { name: "返回修改并重新预检" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /交易 1:/ })).toBeVisible();

    await user.type(editor, "\nVote111111111111111111111111111111111111111");
    expect(screen.getByText("分发记录")).toBeVisible();
    expect(screen.queryByRole("button", { name: "已核对，开始新任务" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始分发" })).toBeEnabled();
  });

  it("exports only definitely unsent rows with their original exact amounts", () => {
    const rows = parseDistribution("11111111111111111111111111111111,0.123456789\nBPFLoader1111111111111111111111111111111111,0.987654321\nVote111111111111111111111111111111111111111,1.111111111").validRows;
    expect(getUnsentSolanaDistribution([
      { rows: [rows[0]], status: "confirmed", signature: "confirmed-hash" },
      { rows: [rows[1]], status: "pending", signature: "unknown-hash" },
      { rows: [rows[2]], status: "not-submitted" }
    ])).toBe(`${rows[2].address},1.111111111`);
    expect(getUnsentSolanaDistribution([{ rows: [rows[0]], status: "failed" }])).toBe(`${rows[0].address},0.123456789`);
  });

  it("blocks retry when a send call times out without returning its signature", async () => {
    solanaMocks.sendWalletTransaction.mockRejectedValueOnce(new Error("RPC timeout after broadcast"));
    const user = userEvent.setup();
    render(<BatchDistributorPage />);
    await user.type(getRecipientEditor(), "11111111111111111111111111111111");
    await user.click(screen.getByRole("button", { name: "开始分发" }));
    await user.click(within(await screen.findByRole("alertdialog", { name: "确认 SOL 批量分发" })).getByRole("button", { name: "确认并签名" }));
    expect(await screen.findByRole("button", { name: "说明：禁止直接重试" })).toBeVisible();
    expect(within(screen.getByRole("table", { name: "SOL 分发清单状态" })).getByText("待核对")).toBeVisible();
    expect(screen.queryByRole("button", { name: "导出未发送清单（原金额）" })).not.toBeInTheDocument();
  });

  it("keeps primary progress at zero until the submitted transaction is confirmed", async () => {
    let completeConfirmation!: (confirmation: { value: { err: null } }) => void;
    solanaMocks.confirmTransaction.mockImplementationOnce(() => new Promise((resolve) => { completeConfirmation = resolve; }));
    const user = userEvent.setup();
    render(<BatchDistributorPage />);
    await user.type(getRecipientEditor(), "11111111111111111111111111111111");
    await user.click(screen.getByRole("button", { name: "开始分发" }));
    await user.click(within(await screen.findByRole("alertdialog", { name: "确认 SOL 批量分发" })).getByRole("button", { name: "确认并签名" }));
    expandTaskDetails();
    expect(await screen.findByText("已签名 1/1")).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "链上确认进度" })).toHaveAttribute("aria-valuenow", "0");
    await act(async () => { completeConfirmation({ value: { err: null } }); });
    expect(screen.getByRole("progressbar", { name: "链上确认进度" })).toHaveAttribute("aria-valuenow", "100");
  });

  it("labels a failed chain execution as definitely not transferred", async () => {
    solanaMocks.confirmTransaction.mockResolvedValueOnce({ value: { err: { InstructionError: [0, "InvalidArgument"] } } });
    const user = userEvent.setup();
    render(<BatchDistributorPage />);
    await user.type(getRecipientEditor(), "11111111111111111111111111111111");
    await user.click(screen.getByRole("button", { name: "开始分发" }));
    await user.click(within(await screen.findByRole("alertdialog", { name: "确认 SOL 批量分发" })).getByRole("button", { name: "确认并签名" }));
    expect(await screen.findByRole("button", { name: "导出未发送清单（原金额）" })).toBeVisible();
    expect(within(screen.getByRole("table", { name: "SOL 分发清单状态" })).getByText("失败（未转出）")).toBeVisible();
    expect(screen.queryByRole("button", { name: "说明：禁止直接重试" })).not.toBeInTheDocument();
  });

  it("refreshes the blockhash and confirms each group before signing the next batch", async () => {
    solanaMocks.batchSignEnabled = true;
    solanaMocks.planChunks.mockImplementation(() => Array.from({ length: 21 }, (_, index) => [{ index }]));
    const user = userEvent.setup();
    render(<BatchDistributorPage />);
    await waitForInitialBalanceLookup();

    await user.type(
      getRecipientEditor(),
      "11111111111111111111111111111111"
    );
    await user.click(screen.getByRole("button", { name: "开始分发" }));
    await screen.findByRole("button", { name: "确认并签名" });
    expect(document.querySelector(".workbench-action-bar__actions")?.querySelectorAll("button")).toHaveLength(1);
    solanaMocks.getLatestBlockhash.mockClear();

    await user.click(within(await screen.findByRole("alertdialog", { name: "确认 SOL 批量分发" }))
      .getByRole("button", { name: "确认并签名" }));

    expect(await screen.findByText(/已完成 21 笔交易确认/)).toBeVisible();
    expect(solanaMocks.signAllTransactions).toHaveBeenCalledTimes(2);
    const firstBatch = solanaMocks.signAllTransactions.mock.calls[0][0] as Array<{ blockhash: string }>;
    const secondBatch = solanaMocks.signAllTransactions.mock.calls[1][0] as Array<{ blockhash: string }>;
    expect(firstBatch).toHaveLength(20);
    expect(secondBatch).toHaveLength(1);
    expect(new Set(firstBatch.map((transaction) => transaction.blockhash)).size).toBe(1);
    expect(firstBatch[0].blockhash).not.toBe(secondBatch[0].blockhash);
    expect(solanaMocks.getLatestBlockhash).toHaveBeenCalledTimes(3);
    expect(solanaMocks.sendRawTransaction).toHaveBeenCalledTimes(21);
    expect(solanaMocks.confirmTransaction).toHaveBeenCalledTimes(21);
    expect(solanaMocks.signAllTransactions.mock.invocationCallOrder[1])
      .toBeGreaterThan(solanaMocks.confirmTransaction.mock.invocationCallOrder[19]);
  });
});
