// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
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
    expect(fileInput.accept).toBe(".txt,.csv,.json,text/plain,text/csv,application/json");
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
});
