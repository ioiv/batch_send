// @vitest-environment jsdom

import { expandSettings, expandTaskDetails } from "../test/workbench";

import { type ReactNode } from "react";
import { Keypair } from "@solana/web3.js";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareAutomaticSolCollection } from "../lib/automatic-sol-collection";
import { type AutomaticCollectionTask, type AutomaticCollectionWallet } from "../lib/collection-orchestrator";
import { type CollectionDisplayResult } from "../lib/collection-results";
import { readTaskHistory, saveTaskRecord, type TaskRecord } from "../lib/task-history";
import { AutomaticCollectionWorkbench, type AutomaticCollectionRound } from "./AutomaticCollectionWorkbench";

vi.mock("../lib/automatic-sol-collection", () => ({ prepareAutomaticSolCollection: vi.fn() }));
vi.mock("../lib/automatic-evm-collection", () => ({ prepareAutomaticEvmCollection: vi.fn() }));
vi.mock("../hooks/useEvmGas", () => ({ useEvmGas: () => ({ gasSettings: { gasLimit: "auto", gasPrice: "auto" } }) }));
vi.mock("./ToolPageLayout", () => ({
  ToolPageLayout: ({ children, title, modeSwitch, status }: { children: ReactNode; title: string; modeSwitch: ReactNode; status: string }) => (
    <main data-status={status}><h1>{title}</h1>{modeSwitch}{children}</main>
  )
}));

const first = Keypair.fromSeed(new Uint8Array(32).fill(77));
const second = Keypair.fromSeed(new Uint8Array(32).fill(78));
const target = Keypair.fromSeed(new Uint8Array(32).fill(79)).publicKey.toBase58();
const alternate = Keypair.fromSeed(new Uint8Array(32).fill(80)).publicKey.toBase58();
const secrets = [JSON.stringify([...first.secretKey]), JSON.stringify([...second.secretKey])];
const address = first.publicKey.toBase58();
const snapshot = { keys: secrets.join("\n"), selectedIds: [address] };

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
beforeEach(() => { vi.mocked(prepareAutomaticSolCollection).mockReset(); localStorage.clear(); });

function preparedWallet({ complete = true, uncertain = false } = {}) {
  const events: string[] = [];
  const task = (phase: "token" | "nft" | "native", amount: bigint, asset: string): AutomaticCollectionTask => {
    const id = `${address}:${phase}`;
    const preview: CollectionDisplayResult = { address, phase, executionId: id, asset, amount: phase === "native" ? "0.5" : amount.toString(), message: "待归集", status: "pending" };
    return {
      id, phase, preview,
      ...(phase !== "native" ? { holding: { kind: phase, key: phase, address: `${phase}Mint123456789012345`, symbol: phase === "token" ? "USDC" : "ART", raw: amount, decimals: 0 } } : {}),
      execute: vi.fn<AutomaticCollectionTask["execute"]>(async (progress): Promise<CollectionDisplayResult> => {
        events.push(phase);
        progress({ ...preview, hash: `${phase}-signature`, status: "confirming", message: "等待确认" });
        return uncertain && phase === "token"
          ? { ...preview, status: "error", message: "确认状态不确定", hash: "token-signature", uncertain: true, retryable: false }
          : { ...preview, hash: `${phase}-signature`, status: "success", message: "归集完成", retryable: false, uncertain: false };
      })
    };
  };
  const wallet: AutomaticCollectionWallet = {
    address, complete, issues: complete ? [] : ["部分索引读取失败"],
    native: { symbol: "SOL", raw: 500_000_000n, decimals: 9 },
    tasks: [task("token", 12n, "USDC"), task("nft", 1n, "NFT ART"), task("native", 500_000_000n, "SOL")],
    verifyEmpty: vi.fn(async () => { events.push("verify"); return true; })
  };
  return { wallet, events };
}

function renderWorkbench() {
  const onManual = vi.fn();
  const readInitialWallets = vi.fn(() => snapshot);
  const historyRef = { current: [] as AutomaticCollectionRound[] };
  render(<AutomaticCollectionWorkbench kind="solana" currentToolId="sol-collection"
    initialConfig={{ networkId: "devnet", rpcEndpoint: "https://api.devnet.solana.com", targetAddress: target }}
    readInitialWallets={readInitialWallets} historyRef={historyRef} onManual={onManual} />);
  return { onManual, readInitialWallets, historyRef };
}

function runButton() {
  return screen.getByRole("button", { name: "一键归集" });
}

async function scan(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "扫描资产" }));
  await waitFor(() => expect(runButton()).toBeEnabled());
}

async function confirm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(runButton());
  const dialog = screen.getByRole("alertdialog", { name: "确认一键归集？" });
  await user.click(within(dialog).getByRole("button", { name: "确认并开始归集" }));
  await waitFor(() => expect(screen.getByText(/本轮结束 · 成功/u)).toBeVisible());
}

describe("AutomaticCollectionWorkbench", () => {
  it("persists a submitted hash before a pagehide in the progress callback and keeps a later receipt after unmount", async () => {
    const user = userEvent.setup();
    const { wallet } = preparedWallet();
    const hash = '3'.repeat(88);
    let afterPagehide: TaskRecord[] = [];
    let finish!: () => void;
    wallet.tasks[0].execute = vi.fn<AutomaticCollectionTask['execute']>(async progress => {
      progress({ ...wallet.tasks[0].preview, status: 'submitting', hash, message: '正在提交' });
      fireEvent(window, new Event('pagehide'));
      afterPagehide = readTaskHistory('sol-collection');
      await new Promise<void>(resolve => { finish = resolve; });
      return { ...wallet.tasks[0].preview, status: 'success', hash, message: '归集完成', uncertain: false };
    });
    vi.mocked(prepareAutomaticSolCollection).mockResolvedValue([wallet]);
    renderWorkbench();
    await scan(user);
    await user.click(runButton());
    const dialog = screen.getByRole('alertdialog', { name: '确认一键归集？' });
    await user.click(within(dialog).getByRole('button', { name: '确认并开始归集' }));
    await waitFor(() => expect(afterPagehide[0]?.results[0]).toMatchObject({ hash, status: 'submitting' }));
    cleanup();
    await act(async () => { finish(); });
    await waitFor(() => expect(readTaskHistory('sol-collection')[0].results[0]).toMatchObject({ hash, status: 'success', uncertain: false }));
    expect(wallet.tasks[1].execute).not.toHaveBeenCalled();
  });

  it("checks newly persisted uncertain transactions from another tab when confirmation is clicked", async () => {
    const user = userEvent.setup();
    const { wallet, events } = preparedWallet();
    vi.mocked(prepareAutomaticSolCollection).mockResolvedValue([wallet]);
    renderWorkbench();
    await scan(user);
    await user.click(runButton());
    const now = new Date().toISOString();
    saveTaskRecord({ id: 'another-tab-round', toolId: 'sol-collection', label: '一键归集', network: { kind: 'solana', id: 'devnet', label: 'Devnet' }, createdAt: now, updatedAt: now,
      results: [{ address, asset: 'SOL', status: 'confirming', hash: '4'.repeat(88), message: '另一个页面已提交' }] });
    const dialog = screen.getByRole('alertdialog', { name: '确认一键归集？' });
    await user.click(within(dialog).getByRole('button', { name: '确认并开始归集' }));
    await waitFor(() => expect(runButton()).toBeDisabled());
    expect(events).toEqual([]);
    expect(wallet.tasks[0].execute).not.toHaveBeenCalled();
    expect(screen.getByText('请先查询或核对可恢复任务记录中的待确认交易')).toBeVisible();
  });

  it("requires review of a restored submitted transaction before any new scan", async () => {
    const user = userEvent.setup();
    const now = new Date().toISOString();
    saveTaskRecord({ id: "interrupted-round", toolId: "sol-collection", label: "一键归集", network: { kind: "solana", id: "devnet", label: "Devnet" }, targetAddress: target,
      createdAt: now, updatedAt: now, results: [{ address, asset: "SOL", amount: "0.5", message: "已提交", status: "confirming", hash: "3".repeat(88) }] });
    renderWorkbench();
    expect(screen.getByRole("button", { name: "扫描资产" })).toBeDisabled();
    expect(screen.getByText("请先查询或核对可恢复任务记录中的待确认交易")).toBeVisible();
    const expand = screen.queryByRole("button", { name: "展开可恢复任务记录" });
    if (expand) await user.click(expand);
    expect(screen.getByRole("button", { name: "继续查询交易状态" })).toBeEnabled();
    expect(prepareAutomaticSolCollection).not.toHaveBeenCalled();
  });
  it("shows read-only progress as each wallet completes, and cancellation cannot enable a partial plan", async () => {
    const user = userEvent.setup();
    const { wallet, events } = preparedWallet();
    let finish!: () => void;
    vi.mocked(prepareAutomaticSolCollection).mockImplementation(async ({ onScanProgress }) => {
      onScanProgress?.({ completed: 1, total: 2, wallet });
      await new Promise<void>(resolve => { finish = resolve; });
      return [wallet];
    });
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    renderWorkbench();
    await user.click(screen.getByRole("button", { name: "扫描资产" }));
    expect(screen.getByText("已扫描 1 / 2 个钱包")).toBeVisible();
    expect(screen.queryByRole("button", { name: "一键归集" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /^归集 USDC/u })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "取消扫描" }));
    await act(async () => { finish(); });
    expect(screen.getByText("扫描已取消")).toBeVisible();
    expect(screen.queryByRole("button", { name: "一键归集" })).not.toBeInTheDocument();
    expect(storageWrite).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("excludes a selected NFT from execution and preserves the wallet's native balance", async () => {
    const user = userEvent.setup();
    const { wallet, events } = preparedWallet();
    vi.mocked(prepareAutomaticSolCollection).mockResolvedValue([wallet]);
    renderWorkbench();
    await scan(user);
    await user.click(screen.getByRole("checkbox", { name: /^归集 NFT ART/u }));
    await user.click(screen.getByRole("checkbox", { name: "最后归集原生币" }));
    await user.click(runButton());
    const dialog = screen.getByRole("alertdialog", { name: "确认一键归集？" });
    expect(within(dialog).getByText("Devnet")).toBeVisible();
    expect(within(dialog).getByText("1 个钱包有未选择资产，同时保留原生币")).toBeVisible();
    expect(within(dialog).getByText("转出所选资产的全部可转余额；执行前重新读取")).toBeVisible();
    expect(within(dialog).getByText("最多 1 笔；零余额或保护拦截时减少")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "确认并开始归集" }));
    await waitFor(() => expect(screen.getByText(/本轮结束 · 成功/u)).toBeVisible());
    expect(events).toEqual(["token"]);
    expect(wallet.tasks[1].execute).not.toHaveBeenCalled();
    expect(wallet.tasks[2].execute).not.toHaveBeenCalled();
    expect(wallet.verifyEmpty).not.toHaveBeenCalled();
  });

  it("confirms NFT standard, IDs and source quantities without an internal composite key", async () => {
    const user = userEvent.setup();
    const { wallet } = preparedWallet();
    const contract = "0x1111111111111111111111111111111111111111";
    const nft = wallet.tasks[1];
    nft.preview = { ...nft.preview, tokenStandard: "erc1155", tokenId: "7", contractAddress: contract, amount: "5" };
    nft.holding = { ...nft.holding!, key: `erc1155:${contract}:7`, address: contract, raw: 5n, tokenStandard: "erc1155", tokenId: "7" };
    wallet.tasks.push({ ...nft, id: `${address}:nft-extra`, preview: { ...nft.preview, tokenId: "8" }, holding: { ...nft.holding, key: `erc1155:${contract}:8`, tokenId: "8", raw: 1n } });
    vi.mocked(prepareAutomaticSolCollection).mockResolvedValue([wallet]);
    renderWorkbench();
    await scan(user);
    await user.click(runButton());
    const dialog = within(screen.getByRole("alertdialog", { name: "确认一键归集？" }));
    expect(dialog.getByText("ERC1155")).toBeVisible();
    expect(dialog.getByText("Token ID 7 · 估计数量 5")).toBeVisible();
    expect(dialog.getByText("Token ID 8 · 估计数量 1")).toBeVisible();
    expect(dialog.getAllByText(contract)).toHaveLength(1);
    expect(dialog.queryByText(`erc1155:${contract}:7`)).not.toBeInTheDocument();
    expect(dialog.getByText("估计数量读取时间")).toBeVisible();
    expect(dialog.getAllByRole("button", { name: "复制合约地址" })).toHaveLength(2);
    expect(wallet.tasks[0].execute).not.toHaveBeenCalled();
  });

  it("excludes a contract across wallets rather than just hiding its display", async () => {
    const user = userEvent.setup();
    const { wallet, events } = preparedWallet();
    const extra = { ...wallet.tasks[0], id: `${address}:token-extra`, preview: { ...wallet.tasks[0].preview, executionId: `${address}:token-extra` } };
    wallet.tasks.push(extra);
    vi.mocked(prepareAutomaticSolCollection).mockResolvedValue([wallet]);
    renderWorkbench();
    await scan(user);
    await user.click(screen.getAllByRole("button", { name: "排除合约 tokenMint123456789012345" })[0]);
    for (const checkbox of screen.getAllByRole("checkbox", { name: /^归集 USDC/u })) expect(checkbox).not.toBeChecked();
    await confirm(user);
    expect(events).toEqual(["nft"]);
    expect(wallet.tasks[0].execute).not.toHaveBeenCalled();
    expect(extra.execute).not.toHaveBeenCalled();
  });
  it("explains invalid destination and RPC fields before scanning", async () => {
    const user = userEvent.setup();
    renderWorkbench();
    const destination = screen.getByRole("textbox", { name: "接收地址" });
    fireEvent.change(destination, { target: { value: "invalid-address" } });
    expect(destination).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("请输入可签名的 Solana 钱包地址")).toBeVisible();
    expect(screen.getByRole("button", { name: "扫描资产" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "前往完善" }));
    await waitFor(() => expect(destination).toHaveFocus());
    fireEvent.change(destination, { target: { value: target } });
    expandSettings("修改 RPC");
    const rpc = screen.getByRole("textbox", { name: "RPC 节点" });
    fireEvent.change(rpc, { target: { value: "https://" } });
    expect(rpc).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("请输入有效的 HTTP(S) RPC 地址")).toBeVisible();
    expect(prepareAutomaticSolCollection).not.toHaveBeenCalled();
    fireEvent.change(rpc, { target: { value: "https://api.devnet.solana.com" } });
    expect(screen.getByRole("button", { name: "扫描资产" })).toBeEnabled();
  });

  it("unlocks configuration after a cancelled adapter eventually resolves without accepting its stale scan", async () => {
    const user = userEvent.setup();
    const { wallet, events } = preparedWallet();
    let resolveScan!: (wallets: AutomaticCollectionWallet[]) => void;
    const pendingScan = new Promise<AutomaticCollectionWallet[]>((resolve) => { resolveScan = resolve; });
    vi.mocked(prepareAutomaticSolCollection).mockReturnValue(pendingScan);
    renderWorkbench();
    await user.click(screen.getByRole("button", { name: "扫描资产" }));
    expect(screen.getByRole("textbox", { name: "接收地址" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "取消扫描" }));
    expect(vi.mocked(prepareAutomaticSolCollection).mock.calls[0][0].signal.aborted).toBe(true);
    await act(async () => { resolveScan([wallet]); await pendingScan; });
    expect(screen.getByText("扫描已取消")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "接收地址" })).toBeEnabled();
    expandSettings("修改 RPC");
    expect(screen.getByRole("textbox", { name: "RPC 节点" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "扫描资产" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "一键归集" })).not.toBeInTheDocument();
    expect(screen.queryByText("USDC")).not.toBeInTheDocument();
    expect(events).toEqual([]);
  });

  it("cannot execute a scan containing only failed or skipped assets while native collection is off", async () => {
    const user = userEvent.setup();
    const { wallet, events } = preparedWallet();
    wallet.tasks[0].preview = { ...wallet.tasks[0].preview, status: "error", message: "资产不支持" };
    wallet.tasks[1].preview = { ...wallet.tasks[1].preview, status: "skipped", message: "已无持仓" };
    vi.mocked(prepareAutomaticSolCollection).mockResolvedValue([wallet]);
    renderWorkbench();
    await user.click(screen.getByRole("button", { name: "扫描资产" }));
    await waitFor(() => expect(screen.getByText("扫描完成 · 1 个钱包")).toBeVisible());
    expect(screen.getByRole("checkbox", { name: "最后归集原生币" })).not.toBeChecked();
    expect(screen.queryByRole("button", { name: "一键归集" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新扫描" })).toBeEnabled();
    expect(screen.queryByRole("alertdialog", { name: "确认一键归集？" })).not.toBeInTheDocument();
    expect(events).toEqual([]);
  });

  it("archives the complete native-inclusive round before changing the native option and keeps SOL in historical logs", async () => {
    const user = userEvent.setup();
    const { wallet, events } = preparedWallet();
    vi.mocked(prepareAutomaticSolCollection).mockResolvedValue([wallet]);
    const { historyRef } = renderWorkbench();
    await scan(user);
    await user.click(screen.getByRole("checkbox", { name: "最后归集原生币" }));
    await confirm(user);
    expect(events).toEqual(["token", "nft", "verify", "native"]);
    expandTaskDetails();
    await user.click(screen.getByRole("button", { name: "查看日志" }));
    let log = screen.getByRole("dialog", { name: "执行日志" });
    expect(within(log).getByText("SOL")).toBeVisible();
    expect(within(log).getByTitle("native-signature")).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(screen.getByRole("checkbox", { name: "最后归集原生币" }));
    expect(historyRef.current).toHaveLength(1);
    expect(historyRef.current[0].results.map((result) => result.phase)).toEqual(["token", "nft", "native"]);
    expect(historyRef.current[0].results[2]).toMatchObject({ asset: "SOL", hash: "native-signature", status: "success" });
    expect(screen.queryByRole("button", { name: "一键归集" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "扫描资产" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "查看日志" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "展开历史归集记录" }));
    const historicalLogButton = screen.getAllByRole("button", { name: "查看日志" }).find((button) => !button.hasAttribute("disabled"))!;
    await user.click(historicalLogButton);
    log = screen.getByRole("dialog", { name: historyRef.current[0].label });
    expect(within(log).getByText("SOL")).toBeVisible();
    expect(within(log).getByTitle("native-signature")).toBeVisible();
  });

  it("keeps native off by default, scans only selected secrets, and sends only after confirmation", async () => {
    const user = userEvent.setup();
    const { wallet, events } = preparedWallet();
    vi.mocked(prepareAutomaticSolCollection).mockResolvedValue([wallet]);
    renderWorkbench();
    expect(screen.getByRole("checkbox", { name: "最后归集原生币" })).not.toBeChecked();
    expect(screen.queryByRole("button", { name: "一键归集" })).not.toBeInTheDocument();
    expect(screen.getByText("已选择 1 / 2")).toBeVisible();
    await scan(user);
    expect(prepareAutomaticSolCollection).toHaveBeenCalledWith(expect.objectContaining({ keys: secrets[0], targetAddress: target }));
    const row = screen.getByTitle(address).closest('[role="listitem"]')! as HTMLElement;
    expect(within(row).getByText("USDC")).toBeVisible();
    expect(within(row).getByText("12")).toBeVisible();
    expect(within(row).getByText("NFT 1 项 / 1 件")).toBeVisible();
    expect(events).toEqual([]);
    await user.click(runButton());
    expect(events).toEqual([]);
    let dialog = screen.getByRole("alertdialog", { name: "确认一键归集？" });
    expect(within(dialog).getByText("Token → NFT")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(events).toEqual([]);
    await confirm(user);
    expect(events).toEqual(["token", "nft"]);
    expect(wallet.verifyEmpty).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "一键归集" })).not.toBeInTheDocument();
    expect(within(row).queryByText("USDC")).not.toBeInTheDocument();
  });

  it("confirms native last and verifies empty holdings between NFT and native phases", async () => {
    const user = userEvent.setup();
    const { wallet, events } = preparedWallet();
    vi.mocked(prepareAutomaticSolCollection).mockResolvedValue([wallet]);
    renderWorkbench();
    await scan(user);
    await user.click(screen.getByRole("checkbox", { name: "最后归集原生币" }));
    await user.click(runButton());
    const dialog = screen.getByRole("alertdialog", { name: "确认一键归集？" });
    expect(within(dialog).getByText("Token → NFT → 原生币")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "确认并开始归集" }));
    await waitFor(() => expect(screen.getByText(/本轮结束 · 成功/u)).toBeVisible());
    expect(events).toEqual(["token", "nft", "verify", "native"]);
  });

  it.each(["rpc", "target", "selection"] as const)("invalidates the scanned signing plan when %s changes", async (field) => {
    const user = userEvent.setup();
    const { wallet, events } = preparedWallet();
    vi.mocked(prepareAutomaticSolCollection).mockResolvedValue([wallet]);
    renderWorkbench();
    await scan(user);
    if (field === "rpc") expandSettings("修改 RPC");
    if (field === "rpc") fireEvent.change(screen.getByRole("textbox", { name: "RPC 节点" }), { target: { value: "https://different-rpc.example.com" } });
    if (field === "target") fireEvent.change(screen.getByRole("textbox", { name: "接收地址" }), { target: { value: alternate } });
    if (field === "selection") await user.click(screen.getByRole("checkbox", { name: `选择 ${address}` }));
    expect(screen.queryByRole("button", { name: "一键归集" })).not.toBeInTheDocument();
    expect(events).toEqual([]);
    expect(screen.queryByText("USDC")).not.toBeInTheDocument();
  });

  it("keeps a partial scan distinct from empty holdings and retains native SOL", async () => {
    const user = userEvent.setup();
    const { wallet, events } = preparedWallet({ complete: false });
    vi.mocked(prepareAutomaticSolCollection).mockResolvedValue([wallet]);
    renderWorkbench();
    await scan(user);
    expect(screen.getByText("扫描不完整")).toBeVisible();
    expect(screen.queryByText("无资产")).not.toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "最后归集原生币" }));
    await confirm(user);
    expect(events).toEqual(["token", "nft"]);
    expect(wallet.verifyEmpty).not.toHaveBeenCalled();
    expect(wallet.tasks[2].execute).not.toHaveBeenCalled();
  });

  it("hands all wallet keys and the selected subset back to manual mode without storage", async () => {
    const user = userEvent.setup();
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    const { onManual, readInitialWallets } = renderWorkbench();
    await user.click(screen.getByRole("tab", { name: "手动归集" }));
    expect(onManual).toHaveBeenCalledWith(snapshot, expect.objectContaining({ networkId: "devnet", rpcEndpoint: "https://api.devnet.solana.com", targetAddress: target,
      automaticDraft: expect.objectContaining({ kind: "solana", includeNative: false, maxFee: "0.01" }) }));
    expect(readInitialWallets).toHaveBeenCalledTimes(1);
    expect(storageWrite).not.toHaveBeenCalled();
  });

  it("requires acknowledgement of uncertain transactions before scanning or changing modes", async () => {
    const user = userEvent.setup();
    const { wallet, events } = preparedWallet({ uncertain: true });
    vi.mocked(prepareAutomaticSolCollection).mockResolvedValue([wallet]);
    const { onManual } = renderWorkbench();
    await scan(user);
    await confirm(user);
    expect(events).toEqual(["token"]);
    expect(screen.getByRole("button", { name: "重新扫描" })).toBeDisabled();
    expect(screen.getByRole("tab", { name: "手动归集" })).toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("tab", { name: "手动归集" }));
    expect(onManual).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "接收地址" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: "我已核对状态不确定交易的链上结果，可以重新扫描" }));
    expect(screen.getByRole("button", { name: "重新扫描" })).toBeEnabled();
    expect(screen.getByRole("tab", { name: "手动归集" })).not.toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("tab", { name: "手动归集" }));
    expect(onManual).toHaveBeenCalledWith(snapshot, expect.any(Object));
  });

  it("clears the live guard when the current round is reviewed in recovered task records", async () => {
    const user = userEvent.setup();
    const { wallet } = preparedWallet({ uncertain: true });
    vi.mocked(prepareAutomaticSolCollection).mockResolvedValue([wallet]);
    renderWorkbench();
    await scan(user);
    await confirm(user);
    expect(screen.getByRole('button', { name: '重新扫描' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '已人工核对链上结果' }));
    const dialog = screen.getByRole('alertdialog', { name: '已核对这轮交易的链上结果？' });
    await user.click(within(dialog).getByRole('button', { name: '确认已核对' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '重新扫描' })).toBeEnabled());
    expect(screen.queryByRole('checkbox', { name: '我已核对状态不确定交易的链上结果，可以重新扫描' })).not.toBeInTheDocument();
  });
});
