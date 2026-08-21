// @vitest-environment jsdom

import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretKeyInput, type SecretKeyInputHandle } from "@/components/SecretKeyInput";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function importEvmWallet(user: ReturnType<typeof userEvent.setup>, secret: string) {
  await user.click(screen.getByRole("button", { name: /导入钱包/ }));
  const dialog = screen.getByRole("dialog", { name: "导入来源钱包" });
  await user.type(within(dialog).getByRole("textbox", { name: "粘贴私钥" }), secret);
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
    await importEvmWallet(user, sentinel);

    expect(screen.getByText(address.slice(0, 8) + "…" + address.slice(-8))).toBeVisible();
    expect(inputRef.current?.read()).toBe(sentinel);
    expect(storageWrite).not.toHaveBeenCalled();

    const checkbox = screen.getByRole("checkbox", { name: new RegExp(address, "i") });
    await user.click(checkbox);
    expect(inputRef.current?.read()).toBe("");
    await user.click(checkbox);
    expect(inputRef.current?.read()).toBe(sentinel);

    await user.click(screen.getByRole("button", { name: new RegExp(`删除.*${address}`, "i") }));
    expect(inputRef.current?.read()).toBe("");
    expect(screen.getByText("导入后将在这里显示钱包地址，可勾选或删除。")).toBeVisible();

    await importEvmWallet(user, sentinel);
    inputRef.current?.clear();
    expect(inputRef.current?.read()).toBe("");
    expect(document.querySelector<HTMLTextAreaElement>(".secret-dom-store")).toHaveValue("");
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

    await importEvmWallet(user, sentinel);
    act(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    expect(secretStore).toHaveValue("");

    await importEvmWallet(user, sentinel);
    unmount();
    expect(secretStore.value).toBe("");
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
