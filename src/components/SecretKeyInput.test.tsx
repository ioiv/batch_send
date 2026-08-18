// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SecretKeyInput } from "./SecretKeyInput";

afterEach(cleanup);

describe("SecretKeyInput", () => {
  it("keeps password-manager and browser persistence protections", () => {
    render(<SecretKeyInput mode="evm" />);
    const textarea = screen.getByLabelText("来源钱包密钥");
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]')!;

    expect(fileInput.accept).toBe(".txt,.csv,.json,text/plain,text/csv,application/json");
    expect(textarea).toHaveAttribute("autocomplete", "off");
    expect(textarea).toHaveAttribute("data-1p-ignore", "true");
    expect(textarea).toHaveAttribute("data-bwignore", "true");
    expect(textarea).toHaveAttribute("maxlength", "524288");
  });

  it("disables both input paths while a collection is running", () => {
    render(<SecretKeyInput disabled mode="solana" />);
    expect(screen.getByLabelText("来源钱包密钥")).toBeDisabled();
    expect(screen.getByRole("button", { name: "导入钱包文件" })).toBeDisabled();
    expect(document.querySelector('input[type="file"]')).toBeDisabled();
  });
});
