// @vitest-environment jsdom

import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Keypair } from "@solana/web3.js";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretKeyInput, type SecretKeyInputHandle } from "@/components/SecretKeyInput";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
    expect(screen.getByText("导入后将在这里显示钱包地址，可勾选或删除。")).toBeVisible();

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
    expect(within(dialog).getByText("85 个钱包待解析")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "确认导入" }));

    const walletBrowser = screen.getByLabelText("已导入来源钱包");
    const walletList = within(walletBrowser).getByRole("list");
    expect(within(walletBrowser).getByText("已显示 40 / 85")).toBeVisible();
    expect(within(walletList).getAllByRole("listitem")).toHaveLength(40);

    fireEvent.scroll(walletList);
    expect(within(walletBrowser).getByText("已显示 80 / 85")).toBeVisible();
    expect(within(walletList).getAllByRole("listitem")).toHaveLength(80);

    fireEvent.scroll(walletList);
    expect(within(walletBrowser).getByText("已显示 85 / 85")).toBeVisible();
    expect(within(walletList).getAllByRole("listitem")).toHaveLength(85);
    expect(within(walletBrowser).queryByRole("button", { name: "加载更多钱包" })).not.toBeInTheDocument();
  });
});
