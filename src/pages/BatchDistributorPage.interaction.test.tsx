// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  sendRawTransaction: vi.fn(),
  sendWalletTransaction: vi.fn(),
  signAllTransactions: vi.fn(),
  signTransaction: vi.fn()
}));

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

import { BatchDistributorPage } from "./BatchDistributorPage";

afterEach(cleanup);

beforeEach(() => {
  window.history.replaceState({}, "", "/sol/");
  solanaMocks.assertNetwork.mockReset().mockResolvedValue(undefined);
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

async function waitForInitialBalanceLookup() {
  await waitFor(() => {
    expect(solanaMocks.assertNetwork).toHaveBeenCalledTimes(1);
    expect(solanaMocks.getBalance).toHaveBeenCalledTimes(1);
  });
}

describe("BatchDistributorPage network safety", () => {
  it("shows the network and RPC together without an advanced-settings disclosure", () => {
    render(<BatchDistributorPage />);

    const networkAndRpc = screen.getByLabelText("网络与 RPC");
    expect(within(networkAndRpc).getByRole("combobox")).toBeVisible();
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
      screen.getByRole("textbox", { name: "收款地址" }),
      "11111111111111111111111111111111"
    );
    const rpcInput = screen.getByRole("textbox", { name: "RPC" });
    const connectionCount = solanaMocks.connectionEndpoints.length;

    fireEvent.change(rpcInput, { target: { value: "h" } });

    const invalidRpcTitle = await screen.findByText("RPC 地址无效");
    expect(invalidRpcTitle).toBeVisible();
    expect(within(invalidRpcTitle.closest("[role='alert']") as HTMLElement)
      .getByText("RPC 地址无效：请输入完整的 HTTP 或 HTTPS 地址")).toBeVisible();
    expect(rpcInput).toHaveAttribute("aria-invalid", "true");
    expect(solanaMocks.connectionEndpoints).toHaveLength(connectionCount);
    expect(screen.getByRole("button", { name: "运行预检" })).toBeDisabled();
  });

  it("turns a synchronous connection constructor failure into a balance error", async () => {
    render(<BatchDistributorPage />);
    await waitForInitialBalanceLookup();

    solanaMocks.connectionConstructorErrorEndpoint = "https://throws.example";
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

    fireEvent.change(screen.getByRole("textbox", { name: "RPC" }), {
      target: { value: "https://api.devnet.solana.com" }
    });

    expect(await screen.findByText(/RPC 网络不匹配：当前选择 Mainnet/)).toBeVisible();
    expect(solanaMocks.assertNetwork).toHaveBeenLastCalledWith(
      expect.objectContaining({ endpoint: "https://api.devnet.solana.com" }),
      "mainnet-beta"
    );
    expect(solanaMocks.getBalance).not.toHaveBeenCalled();
    expect(screen.getByLabelText("链路摘要")).not.toHaveTextContent("余额 99 SOL");
  });

  it("shows a blocking preflight error when the wallet cannot cover amount and fees", async () => {
    solanaMocks.getBalance.mockResolvedValue(1n);
    const user = userEvent.setup();
    render(<BatchDistributorPage />);
    expect(document.querySelector(".workbench-grid")).toBeInTheDocument();

    await user.type(
      screen.getByRole("textbox", { name: "收款地址" }),
      "11111111111111111111111111111111"
    );
    await user.click(screen.getByRole("button", { name: "运行预检" }));

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
      screen.getByRole("textbox", { name: "收款地址" }),
      "11111111111111111111111111111111"
    );

    const preflightButton = screen.getByRole("button", { name: "运行预检" });
    await waitFor(() => expect(preflightButton).toBeEnabled());
    await user.click(preflightButton);
    await waitFor(() => expect(solanaMocks.assertNetwork).toHaveBeenCalledTimes(1));
    await screen.findByText(/只读预检已通过/);

    const confirmTrigger = await screen.findByRole("button", { name: "确认并签名" });
    await user.click(confirmTrigger);
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
      screen.getByRole("textbox", { name: "收款地址" }),
      "11111111111111111111111111111111"
    );
    const preflightButton = screen.getByRole("button", { name: "运行预检" });
    await waitFor(() => expect(preflightButton).toBeEnabled());
    await user.click(preflightButton);
    await screen.findByText(/只读预检已通过/);

    const confirmTrigger = screen.getByRole("button", { name: "确认并签名" });
    await user.click(confirmTrigger);
    const dialog = await screen.findByRole("alertdialog", { name: "确认 SOL 批量分发" });
    await user.click(within(dialog).getByRole("button", { name: "取消" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "确认 SOL 批量分发" })).not.toBeInTheDocument());
    expect(solanaMocks.assertNetwork).toHaveBeenCalledTimes(1);
    expect(solanaMocks.signTransaction).not.toHaveBeenCalled();
    expect(confirmTrigger).toHaveFocus();
  });

  it("invalidates a passed preflight as soon as the distribution input changes", async () => {
    const user = userEvent.setup();
    render(<BatchDistributorPage />);
    await waitForInitialBalanceLookup();
    solanaMocks.assertNetwork.mockClear();

    const editor = screen.getByRole("textbox", { name: "收款地址" });
    await user.type(editor, "11111111111111111111111111111111");
    const preflightButton = screen.getByRole("button", { name: "运行预检" });
    await waitFor(() => expect(preflightButton).toBeEnabled());
    await user.click(preflightButton);
    await screen.findByText(/只读预检已通过/);
    expect(screen.getByRole("button", { name: "确认并签名" })).toBeEnabled();

    await user.type(editor, "\nBPFLoader1111111111111111111111111111111111");

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "确认并签名" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "运行预检" })).toBeEnabled();
    });
    expect(solanaMocks.assertNetwork).toHaveBeenCalledTimes(1);
    expect(solanaMocks.signTransaction).not.toHaveBeenCalled();
  });

  it("completes a distribution, preserves the hash until confirmed clear, and starts blank", async () => {
    const user = userEvent.setup();
    render(<BatchDistributorPage />);

    const editor = screen.getByRole("textbox", { name: "收款地址" });
    await user.type(editor, "11111111111111111111111111111111");
    await user.click(screen.getByRole("button", { name: "运行预检" }));
    await screen.findByText(/只读预检已通过/);
    await user.click(screen.getByRole("button", { name: "确认并签名" }));
    await user.click(within(await screen.findByRole("alertdialog", { name: "确认 SOL 批量分发" }))
      .getByRole("button", { name: "确认并签名" }));

    expect(await screen.findByText(/已完成 1 笔交易确认/)).toBeVisible();
    expect(screen.getByRole("link", { name: /交易 1:/ })).toHaveAttribute("href", expect.stringContaining("solana-signature-1"));
    await user.click(screen.getByRole("button", { name: "清空清单并开始新任务" }));
    const clearDialog = await screen.findByRole("alertdialog", { name: "清空当前 SOL 分发任务？" });
    expect(within(clearDialog).getByText(/请先核对链上状态/)).toBeVisible();
    await user.click(within(clearDialog).getByRole("button", { name: "取消" }));
    expect(editor).toHaveValue("11111111111111111111111111111111");

    await user.click(screen.getByRole("button", { name: "清空清单并开始新任务" }));
    await user.click(within(await screen.findByRole("alertdialog", { name: "清空当前 SOL 分发任务？" }))
      .getByRole("button", { name: "清空并开始新任务" }));
    expect(screen.getByRole("textbox", { name: "收款地址" })).toHaveValue("");
    expect(screen.queryByRole("link", { name: /交易 1:/ })).not.toBeInTheDocument();
  });

  it("locks an interrupted multi-transaction task after a hash and only allows confirmed restart", async () => {
    solanaMocks.planChunks.mockImplementation((rows: unknown[]) => {
      const values = rows as unknown[];
      return [[values[0]], [values[1]]];
    });
    solanaMocks.sendWalletTransaction
      .mockResolvedValueOnce("solana-signature-partial")
      .mockRejectedValueOnce(new Error("wallet rejected"));
    const user = userEvent.setup();
    render(<BatchDistributorPage />);

    const editor = screen.getByRole("textbox", { name: "收款地址" });
    await user.type(
      editor,
      "11111111111111111111111111111111\nBPFLoader1111111111111111111111111111111111"
    );
    await user.click(screen.getByRole("button", { name: "运行预检" }));
    await screen.findByText(/只读预检已通过/);
    await user.click(screen.getByRole("button", { name: "确认并签名" }));
    await user.click(within(await screen.findByRole("alertdialog", { name: "确认 SOL 批量分发" }))
      .getByRole("button", { name: "确认并签名" }));

    expect(await screen.findByText(/已提交 1\/2 笔交易/)).toBeVisible();
    expect(screen.getByText("禁止直接重试")).toBeVisible();
    expect(editor).toBeDisabled();
    expect(screen.queryByRole("button", { name: "返回修改并重新预检" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /交易 1:/ })).toBeVisible();
  });

  it("refreshes the blockhash and confirms each group before signing the next batch", async () => {
    solanaMocks.batchSignEnabled = true;
    solanaMocks.planChunks.mockImplementation(() => Array.from({ length: 21 }, (_, index) => [{ index }]));
    const user = userEvent.setup();
    render(<BatchDistributorPage />);
    await waitForInitialBalanceLookup();

    await user.type(
      screen.getByRole("textbox", { name: "收款地址" }),
      "11111111111111111111111111111111"
    );
    await user.click(screen.getByRole("button", { name: "运行预检" }));
    await screen.findByText(/只读预检已通过/);
    solanaMocks.getLatestBlockhash.mockClear();

    await user.click(screen.getByRole("button", { name: "确认并签名" }));
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
