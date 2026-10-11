// @vitest-environment jsdom

import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Keypair } from "@solana/web3.js";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretKeyInput, type SecretKeyInputHandle } from "@/components/SecretKeyInput";
import { buildWalletAssetOverview } from "@/lib/wallet-asset-overview";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("wallet file drop", () => {
  it("reads a dropped file into the import dialog and waits for confirmation", async () => {
    const user = userEvent.setup();
    const ref = createRef<SecretKeyInputHandle>();
    const secret = `0x${"41".repeat(32)}`;
    const file = new File([secret], "wallets.txt", { type: "text/plain" });
    Object.defineProperty(file, "text", { value: async () => secret });
    render(<SecretKeyInput mode="evm" ref={ref} />);
    const dropzone = screen.getByRole("button", { name: "导入钱包" });
    fireEvent.drop(dropzone, { dataTransfer: { files: [file] } });
    const dialog = await screen.findByRole("dialog", { name: "导入来源钱包" });
    await waitFor(() => expect(within(dialog).getByRole("textbox", { name: "粘贴私钥" })).toHaveValue(secret));
    expect(ref.current?.read()).toBe("");
    await user.click(within(dialog).getByRole("button", { name: "确认导入" }));
    expect(ref.current?.read()).toBe(secret);
    expect(screen.getByRole("button", { name: "继续导入钱包" })).toHaveTextContent("已导入 1 个钱包");
  });

  it("does not read a dropped file while controls are locked", async () => {
    const read = vi.fn(async () => "");
    const file = new File([], "wallets.txt", { type: "text/plain" });
    Object.defineProperty(file, "text", { value: read });
    render(<SecretKeyInput disabled mode="evm" />);
    fireEvent.drop(screen.getByRole("button", { name: "导入钱包" }), { dataTransfer: { files: [file] } });
    expect(screen.queryByRole("dialog", { name: "导入来源钱包" })).not.toBeInTheDocument();
    expect(read).not.toHaveBeenCalled();
  });
});

async function importWallets(user: ReturnType<typeof userEvent.setup>, secret: string) {
  await user.click(screen.getByRole("button", { name: /导入钱包/ }));
  const dialog = screen.getByRole("dialog", { name: "导入来源钱包" });
  fireEvent.input(within(dialog).getByRole("textbox", { name: "粘贴私钥" }), {
    target: { value: secret }
  });
  await user.click(within(dialog).getByRole("button", { name: "确认导入" }));
}

describe("SecretKeyInput DOM-only lifecycle", () => {
  it("hands off every wallet and restores just the selected subset without storage", async () => {
    const user = userEvent.setup();
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    const ref = createRef<SecretKeyInputHandle>();
    const secrets = ["71", "72"].map((byte) => (`0x${byte.repeat(32)}`) as `0x${string}`);
    const addresses = secrets.map((secret) => privateKeyToAccount(secret).address);
    const { unmount } = render(<SecretKeyInput mode="evm" ref={ref} />);
    await importWallets(user, secrets.join("\n"));
    await user.click(screen.getByRole("checkbox", { name: new RegExp(addresses[1], "i") }));
    const snapshot = ref.current!.handoff();
    expect(snapshot).toEqual({ keys: secrets.join("\n"), selectedIds: [addresses[0].toLowerCase()] });
    const store = document.querySelector<HTMLTextAreaElement>(".secret-dom-store")!;
    unmount();
    expect(store.value).toBe("");
    const readInitialWallets = vi.fn(() => snapshot);
    const mounted = render(<SecretKeyInput mode="evm" ref={ref} readInitialWallets={readInitialWallets} />);
    expect(screen.getByText("已选择 1 / 2")).toBeVisible();
    expect(ref.current!.read()).toBe(secrets[0]);
    expect(ref.current!.handoff().keys).toBe(secrets.join("\n"));
    mounted.rerender(<SecretKeyInput mode="evm" ref={ref} readInitialWallets={readInitialWallets} />);
    expect(readInitialWallets).toHaveBeenCalledTimes(1);
    expect(storageWrite).not.toHaveBeenCalled();
  });

  it("never selects incomplete scans or positive native dust as zero balances", async () => {
    const user = userEvent.setup();
    const ref = createRef<SecretKeyInputHandle>();
    const secrets = ["73", "74", "75", "76"].map((byte) => (`0x${byte.repeat(32)}`) as `0x${string}`);
    const ids = secrets.map((secret) => privateKeyToAccount(secret).address.toLowerCase());
    const zero = { holdings: [], complete: true, native: { symbol: "ETH", raw: 0n, decimals: 18 } };
    const overviews = {
      [ids[0]]: buildWalletAssetOverview(zero),
      [ids[1]]: buildWalletAssetOverview({ ...zero, complete: false }),
      [ids[2]]: buildWalletAssetOverview({ ...zero, native: { ...zero.native, raw: 1n } }),
      [ids[3]]: buildWalletAssetOverview({ ...zero, native: { ...zero.native, raw: null } })
    };
    render(<SecretKeyInput mode="evm" ref={ref} walletAssetOverviews={overviews} />);
    await importWallets(user, secrets.join("\n"));
    await user.click(screen.getByRole("button", { name: "选中余额为零 (1)" }));
    expect(ref.current!.read()).toBe(secrets[0]);
    expect(screen.getByText("已选择 1 / 4")).toBeVisible();
    expect(screen.getAllByText("扫描不完整")).toHaveLength(2);
  });

  it("imports, selects, deletes, reads and clears without writing storage", async () => {
    const user = userEvent.setup();
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    const inputRef = createRef<SecretKeyInputHandle>();
    render(<SecretKeyInput mode="evm" ref={inputRef} />);

    const sentinel = (`0x${"11".repeat(32)}`) as `0x${string}`;
    const address = privateKeyToAccount(sentinel).address;
    await importWallets(user, sentinel);

    expect(screen.getByText(address.slice(0, 8) + "…" + address.slice(-8))).toBeVisible();
    expect(inputRef.current?.read()).toBe(sentinel);
    expect(storageWrite).not.toHaveBeenCalled();

    const checkbox = screen.getByRole("checkbox", { name: new RegExp(address, "i") });
    await user.click(checkbox);
    expect(inputRef.current?.read()).toBe("");
    await user.click(checkbox);
    expect(inputRef.current?.read()).toBe(sentinel);

    const removeButton = screen.getByRole("button", { name: new RegExp(`删除.*${address}`, "i") });
    expect(removeButton).toHaveClass("imported-wallet-remove");
    await user.click(removeButton);
    expect(inputRef.current?.read()).toBe("");
    expect(screen.queryByLabelText("已导入来源钱包")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导入钱包" })).toBeVisible();

    await importWallets(user, sentinel);
    inputRef.current?.clear();
    expect(inputRef.current?.read()).toBe("");
    expect(document.querySelector<HTMLTextAreaElement>(".secret-dom-store")).toHaveValue("");
  });

  it("copies the complete imported wallet address", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    const sentinel = (`0x${"12".repeat(32)}`) as `0x${string}`;
    const address = privateKeyToAccount(sentinel).address;
    render(<SecretKeyInput mode="evm" />);
    await importWallets(user, sentinel);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await user.click(screen.getByRole("button", {
      name: new RegExp(`复制.*${address}.*地址`, "i")
    }));

    expect(writeText).toHaveBeenCalledWith(address);
    expect(screen.getByRole("button", {
      name: new RegExp(`复制.*${address}.*地址`, "i")
    })).toHaveTextContent("已复制");
  });

  it("automatically deduplicates wallets across continued imports", async () => {
    const user = userEvent.setup();
    const inputRef = createRef<SecretKeyInputHandle>();
    const onDirty = vi.fn();
    const firstSecret = (`0x${"13".repeat(32)}`) as `0x${string}`;
    const secondSecret = (`0x${"14".repeat(32)}`) as `0x${string}`;
    const firstAddress = privateKeyToAccount(firstSecret).address;
    const secondAddress = privateKeyToAccount(secondSecret).address;
    render(<SecretKeyInput mode="evm" onDirty={onDirty} ref={inputRef} />);

    await importWallets(user, firstSecret);
    await importWallets(user, [firstSecret, secondSecret, secondSecret].join("\n"));

    expect(screen.getByText("已选择 2 / 2")).toBeVisible();
    expect(screen.getByTitle(firstAddress)).toBeVisible();
    expect(screen.getByTitle(secondAddress)).toBeVisible();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(inputRef.current?.read().split("\n")).toEqual([firstSecret, secondSecret]);
    expect(onDirty).toHaveBeenCalledTimes(2);

    await importWallets(user, secondSecret);
    expect(screen.getByText("已选择 2 / 2")).toBeVisible();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(inputRef.current?.read().split("\n")).toEqual([firstSecret, secondSecret]);
    expect(onDirty).toHaveBeenCalledTimes(2);
  });

  it("automatically deduplicates Solana wallets across continued imports", async () => {
    const user = userEvent.setup();
    const inputRef = createRef<SecretKeyInputHandle>();
    const first = Keypair.fromSeed(new Uint8Array(32).fill(21));
    const second = Keypair.fromSeed(new Uint8Array(32).fill(22));
    const firstSecret = JSON.stringify(Array.from(first.secretKey));
    const secondSecret = JSON.stringify(Array.from(second.secretKey));
    render(<SecretKeyInput mode="solana" ref={inputRef} />);

    await importWallets(user, firstSecret);
    await importWallets(user, [firstSecret, secondSecret, firstSecret].join("\n"));

    expect(screen.getByText("已选择 2 / 2")).toBeVisible();
    expect(screen.getByTitle(first.publicKey.toBase58())).toBeVisible();
    expect(screen.getByTitle(second.publicKey.toBase58())).toBeVisible();
    expect(inputRef.current?.read().split("\n")).toEqual([firstSecret, secondSecret]);
  });

  it("clears imported file controls, page lifecycle restores, and unmount", async () => {
    const user = userEvent.setup();
    const inputRef = createRef<SecretKeyInputHandle>();
    const { unmount } = render(<SecretKeyInput mode="evm" ref={inputRef} />);
    const secretStore = document.querySelector<HTMLTextAreaElement>(".secret-dom-store")!;
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const sentinel = (`0x${"22".repeat(32)}`) as `0x${string}`;

    await user.click(screen.getByRole("button", { name: "导入钱包" }));
    const dialog = screen.getByRole("dialog", { name: "导入来源钱包" });
    const draft = within(dialog).getByRole("textbox", { name: "粘贴私钥" });
    await user.upload(fileInput, new File([sentinel], "wallets.txt", { type: "text/plain" }));
    await waitFor(() => expect(draft).toHaveValue(sentinel));
    expect(fileInput.value).toBe("");
    await user.click(within(dialog).getByRole("button", { name: "确认导入" }));
    expect(inputRef.current?.read()).toContain(sentinel);

    act(() => window.dispatchEvent(new Event("pagehide")));
    expect(secretStore).toHaveValue("");

    await importWallets(user, sentinel);
    act(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    expect(secretStore).toHaveValue("");

    await importWallets(user, sentinel);
    unmount();
    expect(secretStore.value).toBe("");
  });

  it("keeps wallet rows compact and opens execution details in a side sheet", async () => {
    const user = userEvent.setup();
    const sentinel = (`0x${"33".repeat(32)}`) as `0x${string}`;
    const address = privateKeyToAccount(sentinel).address;
    const hash = `0x${"ab".repeat(32)}`;
    const explorerUrl = `https://explorer.test/tx/${hash}`;
    render(
      <SecretKeyInput
        compactStatuses
        mode="evm"
        walletStatuses={{
          [address.toLowerCase()]: [
            {
              amount: "4",
              asset: "ERC1155 #9",
              explorerUrl,
              hash,
              message: "批量归集交易已确认",
              status: "success"
            },
            {
              amount: "2",
              asset: "ERC1155 #10",
              explorerUrl,
              hash,
              message: "批量归集交易已确认",
              status: "success"
            }
          ]
        }}
      />
    );
    await importWallets(user, sentinel);

    const walletRow = screen.getByTitle(address).closest('[role="listitem"]') as HTMLElement;
    expect(within(walletRow).getByText("ERC1155 · 2 个 Token ID")).toBeVisible();
    expect(within(walletRow).getByText("已完成")).toBeVisible();
    const transactionLink = within(walletRow).getByRole("link", { name: `查看交易 ${hash}` });
    expect(transactionLink).toHaveTextContent("0xabababab…ababab");
    expect(transactionLink).toHaveAttribute("href", explorerUrl);

    await user.click(within(walletRow).getByRole("button", { name: new RegExp(`查看.*${address}.*归集详情`, "i") }));
    const details = screen.getByRole("dialog", { name: "归集详情" });
    expect(within(details).getByText("成功 2")).toBeVisible();
    expect(within(details).getByText("ERC1155 #9 · 4")).toBeVisible();
    expect(within(details).getByText("ERC1155 #10 · 2")).toBeVisible();
    const detailLinks = within(details).getAllByRole("link", { name: `查看交易 ${hash}` });
    expect(detailLinks).toHaveLength(2);
    detailLinks.forEach((link) => {
      expect(link).toHaveTextContent("0xabababab…ababab");
      expect(link).toHaveAttribute("href", explorerUrl);
    });
  });

  it("deletes the selected wallets in one confirmed step", async () => {
    const user = userEvent.setup();
    const inputRef = createRef<SecretKeyInputHandle>();
    const onDirty = vi.fn();
    const secrets = ["51", "52", "53"].map((byte) => (`0x${byte.repeat(32)}`) as `0x${string}`);
    const addresses = secrets.map((secret) => privateKeyToAccount(secret).address);
    render(<SecretKeyInput mode="evm" onDirty={onDirty} ref={inputRef} />);
    await importWallets(user, secrets.join("\n"));

    await user.click(screen.getByRole("checkbox", { name: new RegExp(addresses[2], "i") }));
    await user.click(screen.getByRole("button", { name: "删除选中 (2)" }));
    let dialog = screen.getByRole("alertdialog", { name: "删除 2 个已选钱包？" });
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(3);

    onDirty.mockClear();
    await user.click(screen.getByRole("button", { name: "删除选中 (2)" }));
    dialog = screen.getByRole("alertdialog", { name: "删除 2 个已选钱包？" });
    await user.click(within(dialog).getByRole("button", { name: "删除 2 个钱包" }));

    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByTitle(addresses[2])).toBeVisible();
    expect(screen.getByText("已选择 0 / 1")).toBeVisible();
    expect(screen.getByRole("button", { name: "删除选中" })).toBeDisabled();
    expect(onDirty).toHaveBeenCalledWith("remove", [addresses[0], addresses[1]]);
    expect(inputRef.current?.read()).toBe("");
    await user.click(screen.getByRole("checkbox", { name: new RegExp(addresses[2], "i") }));
    expect(inputRef.current?.read()).toBe(secrets[2]);
  });

  it("selects only wallets whose every read balance is exactly zero", async () => {
    const user = userEvent.setup();
    const inputRef = createRef<SecretKeyInputHandle>();
    const onDirty = vi.fn();
    const secrets = ["61", "62", "63", "64", "65"].map((byte) => (`0x${byte.repeat(32)}`) as `0x${string}`);
    // The fifth wallet was never queried and has no balances at all.
    const [empty, tokenOnly, dust, unread] = secrets.map((secret) => (
      privateKeyToAccount(secret).address.toLowerCase()
    ));
    const walletBalances = {
      [empty]: [{ amount: "0", symbol: "ETH", zero: true }, { amount: "0", symbol: "TOK", zero: true }],
      [tokenOnly]: [{ amount: "0", symbol: "ETH", zero: true }, { amount: "5", symbol: "TOK", zero: false }],
      // Rounds to "0" on screen but holds dust: only the raw flag counts.
      [dust]: [{ amount: "0", symbol: "ETH" }],
      [unread]: [{ amount: "读取失败", symbol: "ETH" }]
    };
    const { rerender } = render(<SecretKeyInput mode="evm" onDirty={onDirty} ref={inputRef} />);
    await importWallets(user, secrets.join("\n"));
    expect(screen.getByRole("button", { name: "选中余额为零" })).toBeDisabled();

    rerender(<SecretKeyInput mode="evm" onDirty={onDirty} ref={inputRef} walletBalances={walletBalances} />);
    onDirty.mockClear();
    await user.click(screen.getByRole("button", { name: "选中余额为零 (1)" }));

    expect(screen.getByText("已选择 1 / 5")).toBeVisible();
    expect(inputRef.current?.read()).toBe(secrets[0]);
    expect(onDirty).toHaveBeenCalledWith("selection");
  });

  it("imports a large pasted batch and incrementally renders wallets while scrolling", async () => {
    const user = userEvent.setup();
    render(<SecretKeyInput mode="evm" />);
    const secrets = Array.from({ length: 85 }, (_, index) => (
      `0x${(index + 1).toString(16).padStart(64, "0")}`
    ));

    await user.click(screen.getByRole("button", { name: "导入钱包" }));
    const dialog = screen.getByRole("dialog", { name: "导入来源钱包" });
    const draft = within(dialog).getByRole("textbox", { name: "粘贴私钥" });
    fireEvent.input(draft, { target: { value: secrets.join("\n") } });

    expect(within(dialog).getByText("85 / 1,000")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "确认导入" })).toHaveTextContent("导入 85 个钱包");
    await user.click(within(dialog).getByRole("button", { name: "确认导入" }));

    const walletBrowser = screen.getByLabelText("已导入来源钱包");
    const walletList = within(walletBrowser).getByRole("list");
    expect(within(walletBrowser).getByText("已显示 40 / 85")).toBeVisible();
    expect(within(walletList).getAllByRole("listitem")).toHaveLength(40);

    fireEvent.scroll(walletList);
    expect(within(walletBrowser).getByText("已显示 80 / 85")).toBeVisible();
    expect(within(walletList).getAllByRole("listitem")).toHaveLength(80);

    fireEvent.scroll(walletList);
    expect(within(walletBrowser).queryByText(/已显示/)).not.toBeInTheDocument();
    expect(within(walletList).getAllByRole("listitem")).toHaveLength(85);
    expect(within(walletBrowser).queryByRole("button", { name: "加载更多钱包" })).not.toBeInTheDocument();
  });
});
