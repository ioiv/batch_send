// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { FormatGeneratorPage } from "./FormatGeneratorPage";

afterEach(cleanup);

describe("FormatGeneratorPage interactions", () => {
  it("blocks duplicate output, supports explicit deduplication, and clears the editor", async () => {
    const user = userEvent.setup();
    render(<FormatGeneratorPage />);
    expect(document.querySelector(".workbench-grid")).toBeInTheDocument();

    const address = "11111111111111111111111111111111";
    const editor = screen.getByRole("textbox", { name: "收款地址" });
    await user.type(editor, `${address}\n${address}`);

    expect(screen.getByRole("button", { name: "复制结果" })).toBeDisabled();
    expect(screen.getByText(/1 个重复地址需要去重/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "立即去重" }));
    expect(editor).toHaveValue(address);
    expect(screen.getByRole("button", { name: "复制结果" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "清空" }));
    expect(editor).toHaveValue("");
    expect(screen.getByRole("button", { name: "复制结果" })).toBeDisabled();
  });

  it("blocks a mixed SOL and EVM list from both output actions", async () => {
    const user = userEvent.setup();
    render(<FormatGeneratorPage />);

    await user.type(
      screen.getByRole("textbox", { name: "收款地址" }),
      "11111111111111111111111111111111\n0x00000000000000000000000000000000000000aa"
    );

    expect(screen.getByText("清单包含两种生态地址")).toBeVisible();
    expect(screen.getByText(/请拆分 SOL 与 EVM 清单/)).toBeVisible();
    expect(screen.getByRole("button", { name: "复制结果" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "进入分发" })).toBeDisabled();
  });

  it("moves focus to the shared amount field when the amount is invalid", async () => {
    const user = userEvent.setup();
    render(<FormatGeneratorPage />);

    await user.type(
      screen.getByRole("textbox", { name: "收款地址" }),
      "11111111111111111111111111111111"
    );
    const amountInput = screen.getByRole("spinbutton", { name: "每个地址的金额" });
    await user.clear(amountInput);
    await user.click(screen.getByRole("button", { name: "修正金额" }));

    expect(amountInput).toHaveFocus();
    expect(amountInput).toHaveAttribute("id", "format-generator-fixed-amount");
  });

  it("copies a valid generated list through the output action", async () => {
    const user = userEvent.setup();
    render(<FormatGeneratorPage />);

    await user.type(
      screen.getByRole("textbox", { name: "收款地址" }),
      "0x00000000000000000000000000000000000000aa"
    );
    const copyButton = screen.getByRole("button", { name: "复制结果" });
    expect(copyButton).toBeEnabled();

    await user.click(copyButton);

    expect(await screen.findByRole("button", { name: "已复制" })).toBeVisible();
    expect(screen.getByText("结果已复制到剪贴板。")).toBeVisible();
    expect(screen.getByRole("button", { name: "进入 EVM 分发" })).toBeEnabled();
  });
});
