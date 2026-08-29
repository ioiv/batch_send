// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SolanaHoldingsResult,
  SolTokenAssetHolding
} from "../lib/sol-token-collection";

const solMocks = vi.hoisted(() => ({
  assertNetwork: vi.fn(),
  collect: vi.fn(),
  collectTokenJobs: vi.fn(),
  createTokenJobs: vi.fn(),
  discoverHoldings: vi.fn(),
  inspectMints: vi.fn(),
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

vi.mock("../lib/sol-token-collection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/sol-token-collection")>();
  return {
    ...actual,
    collectSolTokenJobs: solMocks.collectTokenJobs,
    createSolTokenCollectionJobs: solMocks.createTokenJobs,
    discoverSolanaHoldings: solMocks.discoverHoldings,
    inspectSolTokenMints: solMocks.inspectMints
  };
});

import { getSolCollectionWorkbenchStatus, SolCollectionPage } from "./SolCollectionPage";

const targetAddress = "11111111111111111111111111111111";
const firstSourceAddress = "So11111111111111111111111111111111111111112";
const secondSourceAddress = "Vote111111111111111111111111111111111111111";
const classicTokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const token2022Program = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const classicMint = "5WcE8o73vmsSZXeeWTLm3ty3fAJKCnBWRF6VuKUme5nu";
const token2022Mint = "6JhaGdekBjU2RfiYWSjYdQAibx4LfSfTNFEeMUHnUVz7";
const firstTokenAccount = "AB3FQHskSYuWVw4M9EpGdxNzrAjBNiYGpbH4CVzLFene";
const secondTokenAccount = "Bow1CGKGDB9mNxeWdw85E2aCthQ1oZX4oFEe7fYT17ew";
const destinationTokenAccount = "8sbwsw9cnbGTy8L4CN8guhQ4fU3T8D4Qiq71f72ECbKe";

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

function tokenHolding(overrides: Partial<SolTokenAssetHolding> = {}): SolTokenAssetHolding {
  const program = overrides.program ?? "spl-token";
  const programId = overrides.programId
    ?? (program === "token-2022" ? token2022Program : classicTokenProgram);
  const sourceTokenAccount = overrides.sourceTokenAccount ?? firstTokenAccount;
  const amount = overrides.amount ?? 1_000_000n;
  const decimals = overrides.decimals === undefined ? 6 : overrides.decimals;
  return {
    amount,
    decimals,
    formattedAmount: decimals === null ? null : String(Number(amount) / 10 ** decimals),
    id: overrides.id ?? `${programId}:${sourceTokenAccount}`,
    isAssociated: overrides.isAssociated ?? true,
    isFrozen: overrides.isFrozen ?? false,
    isNative: overrides.isNative ?? false,
    label: overrides.label ?? "来源一",
    line: overrides.line ?? 1,
    mintAddress: overrides.mintAddress ?? classicMint,
    mintExtensions: overrides.mintExtensions ?? [],
    program,
    programId,
    sourceAddress: overrides.sourceAddress ?? firstSourceAddress,
    sourceTokenAccount,
    status: overrides.status ?? "ready",
    ...(overrides.unsupportedReason ? { unsupportedReason: overrides.unsupportedReason } : {})
  };
}

function holdingsResult(
  tokenAccounts: readonly SolTokenAssetHolding[],
  nativeBalanceLamports = 0n
): SolanaHoldingsResult {
  return {
    holdings: [...tokenAccounts],
    issues: [],
    partial: false,
    readyTokenAccountCount: tokenAccounts.filter((holding) => holding.status === "ready").length,
    tokenInventoryComplete: true,
    tokenAccountCount: tokenAccounts.length,
    totalNativeBalanceLamports: nativeBalanceLamports,
    wallets: [{
      address: firstSourceAddress,
      issues: [],
      label: "来源一",
      line: 1,
      nativeBalanceLamports,
      nativeBalanceStatus: "ok",
      status: "ok",
      tokenInventoryStatus: "complete",
      tokenAccounts: [...tokenAccounts]
    }]
  };
}

function tokenJob(holding: SolTokenAssetHolding, id = holding.id) {
  return {
    amount: holding.amount,
    decimals: holding.decimals ?? 0,
    destinationAddress: targetAddress,
    destinationTokenAccount,
    id,
    mintAddress: holding.mintAddress,
    program: holding.program,
    programId: holding.programId,
    source: source(),
    sourceAddress: holding.sourceAddress,
    sourceTokenAccount: holding.sourceTokenAccount
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
  solMocks.collectTokenJobs.mockResolvedValue([]);
  solMocks.createTokenJobs.mockReturnValue([]);
  solMocks.discoverHoldings.mockResolvedValue(holdingsResult([]));
  solMocks.inspectMints.mockImplementation(async ({ mintAddresses }: { mintAddresses: readonly string[] }) => (
    mintAddresses.map((mintAddress) => ({
    decimals: 6,
    extensions: [],
    mintAddress,
    program: mintAddress === token2022Mint ? "token-2022" : "spl-token",
    programId: mintAddress === token2022Mint ? token2022Program : classicTokenProgram,
    status: "ready"
    }))
  ));
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
  it("uses an optional Token list like EVM collection and defaults a blank list to SOL", async () => {
    const user = userEvent.setup();
    render(<SolCollectionPage />);

    expect(screen.getByRole("textbox", { name: "Token 清单" })).toBeVisible();
    expect(screen.getByRole("button", { name: "添加 Token" })).toBeVisible();
    expect(screen.getByRole("button", { name: "查看地址余额" })).toBeVisible();
    expect(screen.getByText(/可选；留空则归集 SOL，填写后归集列出的 SPL Token/)).toBeVisible();
    expect(screen.queryByRole("tab", { name: "SOL" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "SPL Token" })).not.toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "目标钱包" }), targetAddress);
    await importSolSecret(user);
    await confirmExecution(user);

    await waitFor(() => expect(solMocks.collect).toHaveBeenCalledTimes(1));
    expect(solMocks.createTokenJobs).not.toHaveBeenCalled();
    expect(solMocks.collectTokenJobs).not.toHaveBeenCalled();
  });

  it("automatically recognizes and locks a valid Mint like the EVM Token editor", async () => {
    const user = userEvent.setup();
    render(<SolCollectionPage />);
    const tokenInput = screen.getByRole("textbox", { name: "Token 清单" });

    await user.type(tokenInput, classicMint);

    expect(await screen.findByText("1 个 Token 已识别", {}, { timeout: 2_000 })).toBeVisible();
    expect(solMocks.inspectMints).toHaveBeenCalledWith(expect.objectContaining({
      mintAddresses: [classicMint]
    }));
    expect(tokenInput).toHaveAttribute("readonly");
  });

  it("rejects an oversized pasted Token list before rendering it", () => {
    render(<SolCollectionPage />);
    const tokenInput = screen.getByRole("textbox", { name: "Token 清单" });
    const pasted = Array.from({ length: 1_001 }, () => classicMint).join("\n");

    fireEvent.paste(tokenInput, {
      clipboardData: { getData: () => pasted }
    });

    expect(screen.getByText(/Token 清单一次最多 1000 行，本次修改未应用/)).toBeVisible();
    expect(tokenInput).toHaveValue("");
  });

  it("rejects an oversized Mint before parsing or rendering it", () => {
    render(<SolCollectionPage />);
    const tokenInput = screen.getByRole("textbox", { name: "Token 清单" });

    fireEvent.paste(tokenInput, {
      clipboardData: { getData: () => "1".repeat(10_000) }
    });
    fireEvent.change(tokenInput, { target: { value: "1".repeat(10_000) } });

    expect(screen.getByText(/Mint 地址最多 64 个字符，本次修改未应用/)).toBeVisible();
    expect(tokenInput).toHaveAttribute("maxlength", "64");
    expect(tokenInput).toHaveValue("");
    expect(solMocks.inspectMints).not.toHaveBeenCalled();
  });

  it("queries only listed SPL Tokens, shows SOL first, and uses the list as the collection selection", async () => {
    const listedHolding = tokenHolding();
    const unlistedHolding = tokenHolding({
      amount: 2_000_000n,
      id: `${token2022Program}:${secondTokenAccount}`,
      mintAddress: token2022Mint,
      program: "token-2022",
      sourceTokenAccount: secondTokenAccount
    });
    const listedJob = tokenJob(listedHolding, "listed-job");
    solMocks.discoverHoldings.mockResolvedValue(
      holdingsResult([listedHolding, unlistedHolding], 50_000_000n)
    );
    solMocks.createTokenJobs.mockReturnValueOnce([listedJob]);
    const user = userEvent.setup();
    render(<SolCollectionPage />);

    await importSolSecret(user);
    await user.type(screen.getByRole("textbox", { name: "Token 清单" }), classicMint);
    await user.click(screen.getByRole("button", { name: "查看地址余额" }));

    await waitFor(() => expect(solMocks.discoverHoldings).toHaveBeenCalledTimes(1));
    const walletList = screen.getByLabelText("已导入来源钱包");
    const walletRow = within(walletList)
      .getByTitle(firstSourceAddress)
      .closest('[role="listitem"]') as HTMLElement;
    const balances = within(walletRow).getByLabelText(new RegExp(`来源一.*${firstSourceAddress}.*余额`));
    const balanceItems = Array.from(balances.children);
    expect(balanceItems).toHaveLength(2);
    expect(balanceItems[0]).toHaveTextContent("SOL");
    expect(balanceItems[1]).toHaveTextContent("SPL");

    await user.type(screen.getByRole("textbox", { name: "目标钱包" }), targetAddress);
    expect(screen.getByRole("button", { name: "确认并开始归集" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "确认并开始归集" }));
    const dialog = screen.getByRole("alertdialog", { name: "确认 SPL Token 归集？" });
    await user.click(within(dialog).getByRole("button", { name: "确认并开始归集" }));

    await waitFor(() => expect(solMocks.createTokenJobs).toHaveBeenCalledTimes(1));
    expect([...solMocks.createTokenJobs.mock.calls[0][0].selectedHoldingIds]).toEqual([
      listedHolding.id
    ]);
    expect(solMocks.collectTokenJobs).toHaveBeenCalledWith(expect.objectContaining({
      jobs: [listedJob]
    }));
    expect(solMocks.discoverHoldings).toHaveBeenCalledTimes(2);
    expect(solMocks.collect).not.toHaveBeenCalled();
  });

  it("invalidates a pending balance query when the Token list changes", async () => {
    let resolveFirstQuery: ((value: SolanaHoldingsResult) => void) | undefined;
    const firstQuery = new Promise<SolanaHoldingsResult>((resolve) => {
      resolveFirstQuery = resolve;
    });
    const secondHolding = tokenHolding({
      mintAddress: token2022Mint,
      program: "token-2022",
      programId: token2022Program
    });
    solMocks.discoverHoldings
      .mockReturnValueOnce(firstQuery)
      .mockResolvedValueOnce(holdingsResult([secondHolding], 25_000_000n));
    const user = userEvent.setup();
    render(<SolCollectionPage />);

    await importSolSecret(user);
    await user.type(screen.getByRole("textbox", { name: "Token 清单" }), classicMint);
    await user.click(screen.getByRole("button", { name: "查看地址余额" }));
    await user.click(screen.getByRole("button", { name: "删除 Token 地址 1" }));
    await user.type(screen.getByRole("textbox", { name: "Token 清单" }), token2022Mint);
    resolveFirstQuery?.(holdingsResult([tokenHolding()], 50_000_000n));

    await waitFor(() => expect(screen.queryByLabelText(new RegExp(`来源一.*${firstSourceAddress}.*余额`)))
      .not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "查看地址余额" }));
    await waitFor(() => expect(solMocks.discoverHoldings).toHaveBeenLastCalledWith(expect.objectContaining({
      mintAddresses: [token2022Mint]
    })));
    expect(await screen.findByText(/清单内发现 1 个非零 Token 账户/)).toBeVisible();
  });

  it("shows selection, four amount modes and direct confirmation without a preflight section", () => {
    render(<SolCollectionPage />);
    const target = screen.getByRole("textbox", { name: "目标钱包" });
    const sourceImport = screen.getByRole("button", { name: "导入钱包" });
    const tokenList = screen.getByRole("textbox", { name: "Token 清单" });
    const network = screen.getByRole("combobox", { name: "选择 Solana 网络" });

    expect(sourceImport.compareDocumentPosition(tokenList) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tokenList.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(target.compareDocumentPosition(network) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
    expect(solMocks.createTokenJobs).not.toHaveBeenCalled();
    expect(solMocks.collectTokenJobs).not.toHaveBeenCalled();
  });

  it("queries a listed Mint without a target and renders zero SOL before its SPL balance", async () => {
    const firstHolding = tokenHolding();
    const secondHolding = tokenHolding({
      amount: 2_000_000n,
      id: `${classicTokenProgram}:${secondTokenAccount}`,
      sourceTokenAccount: secondTokenAccount
    });
    solMocks.discoverHoldings.mockResolvedValueOnce(holdingsResult([firstHolding, secondHolding], 0n));
    const user = userEvent.setup();
    render(<SolCollectionPage />);

    await importSolSecret(user);
    expect(screen.getByRole("textbox", { name: "目标钱包" })).toHaveValue("");
    await user.type(screen.getByRole("textbox", { name: "Token 清单" }), classicMint);
    const discover = screen.getByRole("button", { name: "查看地址余额" });
    expect(discover).toBeEnabled();
    await user.click(discover);

    await waitFor(() => expect(solMocks.discoverHoldings).toHaveBeenCalledWith(expect.objectContaining({
      mintAddresses: [classicMint],
      sources: [expect.objectContaining({ address: firstSourceAddress })]
    })));
    const walletList = screen.getByLabelText("已导入来源钱包");
    const walletRow = within(walletList).getByTitle(firstSourceAddress).closest('[role="listitem"]') as HTMLElement;
    const balances = within(walletRow).getByLabelText(new RegExp(`来源一.*${firstSourceAddress}.*余额`));
    const balanceItems = Array.from(balances.children);

    expect(balanceItems).toHaveLength(2);
    expect(balanceItems[0]).toHaveTextContent("0");
    expect(balanceItems[0]).toHaveTextContent("SOL");
    expect(balanceItems[1]).toHaveTextContent("3");
    expect(balanceItems[1]).toHaveTextContent("SPL");
    expect(balanceItems[0].compareDocumentPosition(balanceItems[1]) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it("uses the Token list directly and executes every underlying token-account job", async () => {
    const firstHolding = tokenHolding();
    const secondHolding = tokenHolding({
      amount: 2_000_000n,
      id: `${classicTokenProgram}:${secondTokenAccount}`,
      sourceTokenAccount: secondTokenAccount
    });
    const jobs = [tokenJob(firstHolding, "job-one"), tokenJob(secondHolding, "job-two")];
    solMocks.discoverHoldings.mockResolvedValueOnce(holdingsResult([firstHolding, secondHolding], 50_000_000n));
    solMocks.createTokenJobs.mockReturnValueOnce(jobs);
    const user = userEvent.setup();
    render(<SolCollectionPage />);

    await importSolSecret(user);
    await user.type(screen.getByRole("textbox", { name: "Token 清单" }), classicMint);
    await user.type(screen.getByRole("textbox", { name: "目标钱包" }), targetAddress);

    const start = screen.getByRole("button", { name: "确认并开始归集" });
    expect(start).toBeEnabled();
    await user.click(start);
    const dialog = screen.getByRole("alertdialog", { name: "确认 SPL Token 归集？" });
    await user.click(within(dialog).getByRole("button", { name: "确认并开始归集" }));

    await waitFor(() => expect(solMocks.createTokenJobs).toHaveBeenCalledTimes(1));
    const createOptions = solMocks.createTokenJobs.mock.calls[0][0];
    expect([...createOptions.selectedHoldingIds]).toEqual([firstHolding.id, secondHolding.id]);
    expect(createOptions.holdings).toEqual([firstHolding, secondHolding]);
    expect(solMocks.collectTokenJobs).toHaveBeenCalledWith(expect.objectContaining({ jobs }));
    expect(solMocks.collect).not.toHaveBeenCalled();
  });

  it("shows unsupported Token-2022 holdings and prevents executing them", async () => {
    const unsupported = tokenHolding({
      mintAddress: token2022Mint,
      mintExtensions: [14],
      program: "token-2022",
      sourceTokenAccount: secondTokenAccount,
      status: "unsupported",
      unsupportedReason: "TransferHook Token 暂不支持归集"
    });
    solMocks.discoverHoldings.mockResolvedValueOnce(holdingsResult([unsupported], 1_000_000n));
    solMocks.inspectMints.mockResolvedValueOnce([{
      decimals: 6,
      extensions: [14],
      mintAddress: token2022Mint,
      program: "token-2022",
      programId: token2022Program,
      status: "unsupported",
      unsupportedReason: "TransferHook Token 暂不支持归集"
    }]);
    const user = userEvent.setup();
    render(<SolCollectionPage />);

    await importSolSecret(user);
    await user.type(screen.getByRole("textbox", { name: "Token 清单" }), token2022Mint);
    await user.click(screen.getByRole("button", { name: "查看地址余额" }));

    expect(await screen.findByText("不支持")).toBeVisible();
    expect(screen.getByText(/TransferHook Token 暂不支持归集/)).toBeVisible();
    await user.type(screen.getByRole("textbox", { name: "目标钱包" }), targetAddress);
    expect(screen.getByRole("button", { name: "确认并开始归集" })).toBeDisabled();
  });

  it("blocks a partial Token inventory until the balance query succeeds", async () => {
    const holding = tokenHolding();
    const partial = holdingsResult([holding], 1_000_000n);
    partial.partial = true;
    partial.tokenInventoryComplete = false;
    partial.wallets[0].status = "partial";
    partial.wallets[0].tokenInventoryStatus = "partial";
    partial.wallets[0].issues = ["token-2022 Token 账户读取失败"];
    partial.issues = [`${firstSourceAddress}: token-2022 Token 账户读取失败`];
    solMocks.discoverHoldings.mockResolvedValueOnce(partial);
    const user = userEvent.setup();
    render(<SolCollectionPage />);

    await importSolSecret(user);
    await user.type(screen.getByRole("textbox", { name: "Token 清单" }), classicMint);
    await user.click(screen.getByRole("button", { name: "查看地址余额" }));

    expect(await screen.findByText(/Token 持仓清单不完整，当前结果仅供展示/)).toBeVisible();
    expect(screen.getByText(/token-2022 Token 账户读取失败/)).toBeVisible();
    await user.type(screen.getByRole("textbox", { name: "目标钱包" }), targetAddress);
    expect(screen.getByRole("button", { name: "确认并开始归集" })).toBeDisabled();
  });

  it("fails closed when direct execution discovers a partial Token inventory", async () => {
    const holding = tokenHolding();
    const partial = holdingsResult([holding], 1_000_000n);
    partial.partial = true;
    partial.tokenInventoryComplete = false;
    partial.wallets[0].status = "partial";
    partial.wallets[0].tokenInventoryStatus = "partial";
    solMocks.discoverHoldings.mockResolvedValueOnce(partial);
    const user = userEvent.setup();
    render(<SolCollectionPage />);

    await importSolSecret(user);
    await user.type(screen.getByRole("textbox", { name: "Token 清单" }), classicMint);
    await user.type(screen.getByRole("textbox", { name: "目标钱包" }), targetAddress);
    await user.click(screen.getByRole("button", { name: "确认并开始归集" }));
    const dialog = screen.getByRole("alertdialog", { name: "确认 SPL Token 归集？" });
    await user.click(within(dialog).getByRole("button", { name: "确认并开始归集" }));

    expect(await screen.findByText(/Token 持仓清单读取不完整/)).toBeVisible();
    expect(solMocks.createTokenJobs).not.toHaveBeenCalled();
    expect(solMocks.collectTokenJobs).not.toHaveBeenCalled();
  });

  it("keeps unsupported accounts visible while collecting ready accounts for the same listed Mint", async () => {
    const ready = tokenHolding({
      mintAddress: token2022Mint,
      program: "token-2022",
      programId: token2022Program
    });
    const unsupported = tokenHolding({
      id: `${token2022Program}:${secondTokenAccount}`,
      mintAddress: token2022Mint,
      program: "token-2022",
      programId: token2022Program,
      sourceTokenAccount: secondTokenAccount,
      status: "unsupported",
      unsupportedReason: "TransferHook 账户暂不支持归集"
    });
    const job = tokenJob(ready, "ready-job");
    solMocks.discoverHoldings.mockResolvedValueOnce(holdingsResult([ready, unsupported], 1_000_000n));
    solMocks.createTokenJobs.mockReturnValueOnce([job]);
    const user = userEvent.setup();
    render(<SolCollectionPage />);

    await importSolSecret(user);
    await user.type(screen.getByRole("textbox", { name: "Token 清单" }), token2022Mint);
    await user.type(screen.getByRole("textbox", { name: "目标钱包" }), targetAddress);
    await user.click(screen.getByRole("button", { name: "确认并开始归集" }));
    const dialog = screen.getByRole("alertdialog", { name: "确认 SPL Token 归集？" });
    await user.click(within(dialog).getByRole("button", { name: "确认并开始归集" }));

    await waitFor(() => expect(solMocks.collectTokenJobs).toHaveBeenCalledTimes(1));
    expect([...solMocks.createTokenJobs.mock.calls[0][0].selectedHoldingIds]).toEqual([ready.id]);
    expect(await screen.findByText("TransferHook 账户暂不支持归集")).toBeVisible();
  });

  it("keeps progress controls visible and cooperatively pauses the collection runner", async () => {
    let finishCollection: ((value: never[]) => void) | undefined;
    solMocks.collect.mockImplementationOnce(() => new Promise((resolve) => {
      finishCollection = resolve;
    }));
    const user = await prepareSolPage();
    await confirmExecution(user);

    const pauseButton = await screen.findByRole("button", { name: "暂停归集" });
    expect(screen.getByRole("progressbar", { name: "SOL 归集进度" })).toBeVisible();
    expect(solMocks.collect.mock.calls[0][0].pauseControl.paused).toBe(false);

    await user.click(pauseButton);
    expect(screen.getByRole("button", { name: "继续归集" })).toBeVisible();
    expect(solMocks.collect.mock.calls[0][0].pauseControl.paused).toBe(true);

    await user.click(screen.getByRole("button", { name: "继续归集" }));
    expect(solMocks.collect.mock.calls[0][0].pauseControl.paused).toBe(false);
    finishCollection?.([]);
    await screen.findByText(/归集完成：0 笔成功/);
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
