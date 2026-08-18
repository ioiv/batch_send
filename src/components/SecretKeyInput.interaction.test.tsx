// @vitest-environment jsdom

import { createRef } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretKeyInput, type SecretKeyInputHandle } from "@/components/SecretKeyInput";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SecretKeyInput DOM-only lifecycle", () => {
  it("reads and clears through the imperative ref without writing storage", async () => {
    const user = userEvent.setup();
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    const inputRef = createRef<SecretKeyInputHandle>();
    render(<SecretKeyInput mode="evm" ref={inputRef} />);

    const textarea = screen.getByLabelText("来源钱包密钥") as HTMLTextAreaElement;
    const sentinel = `0x${"11".repeat(32)}`;
    await user.type(textarea, sentinel);

    expect(inputRef.current?.read()).toBe(sentinel);
    expect(storageWrite).not.toHaveBeenCalled();
    inputRef.current?.clear();
    expect(textarea).toHaveValue("");
    expect(inputRef.current?.read()).toBe("");
  });

  it("clears imported file controls, page lifecycle restores, and unmount", async () => {
    const user = userEvent.setup();
    const inputRef = createRef<SecretKeyInputHandle>();
    const { unmount } = render(<SecretKeyInput mode="evm" ref={inputRef} />);
    const textarea = screen.getByLabelText("来源钱包密钥") as HTMLTextAreaElement;
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const sentinel = `0x${"22".repeat(32)}`;

    await user.upload(fileInput, new File([sentinel], "wallets.txt", { type: "text/plain" }));
    await waitFor(() => expect(inputRef.current?.read()).toContain(sentinel));
    expect(fileInput.value).toBe("");

    window.dispatchEvent(new Event("pagehide"));
    expect(textarea).toHaveValue("");

    await user.type(textarea, sentinel);
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    expect(textarea).toHaveValue("");

    await user.type(textarea, sentinel);
    unmount();
    expect(textarea.value).toBe("");
  });
});
