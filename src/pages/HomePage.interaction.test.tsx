// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { HomePage } from "@/pages/HomePage";

afterEach(cleanup);

describe("HomePage ecosystem filter", () => {
  it("filters tools by EVM or Solana without presenting a fixed chain list", async () => {
    const user = userEvent.setup();
    render(<HomePage />);

    expect(screen.getByRole("heading", { name: "链上批量工具" })).toBeVisible();
    expect(screen.getByRole("link", { name: /代币归集/ })).toBeVisible();
    expect(screen.queryByRole("tab", { name: "Ethereum" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Solana" }));
    expect(screen.getByRole("link", { name: /SOL 分发/ })).toBeVisible();
    expect(screen.getByRole("link", { name: /SOL 归集/ })).toBeVisible();
    expect(screen.queryByRole("link", { name: /代币归集/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "EVM" }));
    expect(screen.getByRole("link", { name: /EVM 分发/ })).toBeVisible();
    expect(screen.queryByRole("link", { name: /SOL 归集/ })).not.toBeInTheDocument();
  });
});
