// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SiteHeader } from "./SiteHeader";

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe("SiteHeader sidebar navigation", () => {
  it("replaces the all-tools dropdown with a collapsible persistent sidebar", async () => {
    const user = userEvent.setup();
    const { container } = render(<SiteHeader currentToolId="sol-distribution" />);
    const header = within(screen.getByRole("banner"));

    expect(screen.queryByText("全部工具")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /工具首页/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "站点主导航" })).not.toBeInTheDocument();
    expect(header.getByRole("link", { name: "ChainKit 首页" })).toBeVisible();
    expect(screen.getByRole("navigation", { name: "工具导航" })).toBeVisible();
    expect(screen.getByRole("link", { name: /SOL 分发/ })).toHaveAttribute("aria-current", "page");

    await user.click(screen.getByRole("button", { name: "收起侧边导航" }));
    expect(container.querySelector(".site-sidebar")).toHaveAttribute("data-collapsed", "true");
    expect(screen.getByRole("button", { name: "展开侧边导航" })).toHaveAttribute("aria-expanded", "false");
    expect(window.localStorage.getItem("chainkit-sidebar-collapsed")).toBe("true");
  });
});
