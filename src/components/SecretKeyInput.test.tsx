// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { SecretKeyInput } from "./SecretKeyInput";

afterEach(cleanup);

describe("SecretKeyInput", () => {
  it("removes the visible secret box while preserving DOM-only persistence protections", () => {
    render(<SecretKeyInput mode="evm" />);
    const secretStore = document.querySelector<HTMLTextAreaElement>(".secret-dom-store")!;
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]')!;

    expect(screen.queryByRole("textbox", { name: "来源钱包密钥" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导入钱包" })).toBeEnabled();
    expect(fileInput.accept).toBe(".txt,.csv,.tsv,.json,.xlsx,text/plain,text/csv,text/tab-separated-values,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(secretStore).toHaveAttribute("aria-hidden", "true");
    expect(secretStore).toHaveAttribute("autocomplete", "off");
    expect(secretStore).toHaveAttribute("data-1p-ignore", "true");
    expect(secretStore).toHaveAttribute("data-bwignore", "true");
    expect(secretStore).toHaveAttribute("maxlength", "524288");
  });

  it("disables the import path while a collection is running", () => {
    render(<SecretKeyInput disabled mode="solana" />);
    expect(screen.getByRole("button", { name: "导入钱包" })).toBeDisabled();
    expect(document.querySelector('input[type="file"]')).toBeDisabled();
  });

  it.each(["evm", "solana"] as const)("shows import help relevant to %s wallets", async (mode) => {
    const user = userEvent.setup();
    render(<SecretKeyInput mode={mode} />);
    await user.click(screen.getByRole("button", { name: "导入钱包" }));
    const dialog = screen.getByRole("dialog", { name: "导入来源钱包" });
    expect(dialog).toHaveTextContent(mode === "evm" ? "支持 EVM 十六进制私钥" : "支持 Solana Base58 私钥与 JSON 字节数组");
    expect(dialog).not.toHaveTextContent(mode === "evm" ? "Solana" : "EVM 十六进制私钥");
    expect(dialog).not.toHaveTextContent("助记词和加密 Keystore 请先转换为私钥");
  });
});
