// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { HomePage } from "@/pages/HomePage";

afterEach(cleanup);

describe("HomePage ecosystem filter", () => {
  it("filters tools by EVM or Solana without presenting a fixed chain list", async () => {
    const user = userEvent.setup();
    render(<HomePage />);
    const main = within(screen.getByRole("main"));

    expect(screen.queryByRole("heading", { name: "链上批量工具" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "工具分类" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "页脚导航" })).not.toBeInTheDocument();
    expect(main.getByRole("link", { name: /代币归集/ })).toBeVisible();
    expect(screen.queryByRole("tab", { name: "Ethereum" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Solana" }));
    expect(main.getByRole("link", { name: /SOL 分发/ })).toBeVisible();
    expect(main.getByRole("link", { name: /SOL 归集/ })).toBeVisible();
    expect(main.queryByRole("link", { name: /代币归集/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "EVM" }));
    expect(main.getByRole("link", { name: /EVM 分发/ })).toBeVisible();
    expect(main.queryByRole("link", { name: /SOL 归集/ })).not.toBeInTheDocument();
  });
});
