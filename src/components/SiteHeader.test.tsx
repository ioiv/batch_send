// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SiteHeader } from "./SiteHeader";

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe("SiteHeader sidebar navigation", () => {
  it("labels network tools consistently in navigation and search", async () => {
    const user = userEvent.setup();
    render(<SiteHeader currentToolId="subdomain-scan" />);
    expect(screen.getByRole("link", { name: "子域名扫描 · 网络" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "网站路径扫描 · 网络" })).toHaveAttribute("href", "/network/paths/");
    await user.type(screen.getByRole("combobox", { name: "搜索工具" }), "DNS");
    const result = screen.getByRole("option");
    expect(result).toHaveAttribute("href", "/network/subdomains/");
    expect(within(result).getByText("网络")).toBeVisible();
  });
  it("offers all matching tools and a visible empty state instead of choosing the first match", async () => {
    const user = userEvent.setup();
    render(<SiteHeader />);
    const search = screen.getByRole("combobox", { name: "搜索工具" });
    await user.type(search, "EVM{Enter}");
    expect(screen.getAllByRole("option").length).toBeGreaterThan(1);
    expect(search).not.toHaveAttribute("aria-activedescendant");
    await user.keyboard("{ArrowDown}");
    expect(search).toHaveAttribute("aria-activedescendant", screen.getAllByRole("option")[0].id);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "not-a-tool");
    expect(screen.getByText(/没有匹配的工具/)).toBeVisible();
  });

  it("makes search available inside the mobile menu", async () => {
    const user = userEvent.setup();
    render(<SiteHeader />);
    await user.click(screen.getByRole("button", { name: "打开站点菜单" }));
    const menu = screen.getByRole("dialog");
    await user.type(within(menu).getByRole("combobox", { name: "搜索工具" }), "Solana");
    expect(within(menu).getAllByRole("option")).toHaveLength(2);
  });

  it("focuses and selects the tool search with the keyboard shortcut", async () => {
    const user = userEvent.setup();
    render(<SiteHeader />);
    const search = screen.getByRole("combobox", { name: "搜索工具" });
    await user.type(search, "归集");
    await user.click(screen.getByRole("button", { name: "收起侧边导航" }));
    await user.keyboard("{Control>}k{/Control}");
    expect(search).toHaveFocus();
    expect((search as HTMLInputElement).selectionStart).toBe(0);
    expect((search as HTMLInputElement).selectionEnd).toBe(2);
    expect(screen.getByText("⌘K")).toBeVisible();
  });
  it("replaces the all-tools dropdown with a collapsible persistent sidebar", async () => {
    const user = userEvent.setup();
    const { container } = render(<SiteHeader currentToolId="sol-distribution" />);
    const header = within(screen.getByRole("banner"));

    expect(screen.queryByText("全部工具")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /工具首页/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "站点主导航" })).not.toBeInTheDocument();
    expect(header.getByRole("link", { name: "ChainKit 首页" })).toBeVisible();
    expect(header.getByRole("search")).toBeVisible();
    expect(header.getByRole("combobox", { name: "搜索工具" })).toBeVisible();
    expect(screen.getByRole("navigation", { name: "工具导航" })).toBeVisible();
    expect(screen.getByRole("link", { name: /SOL 分发/ })).toHaveAttribute("aria-current", "page");
    expect(container.querySelector('[data-region="header"]')).toBeInTheDocument();
    expect(container.querySelector('[data-region="sidebar"]')).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "收起侧边导航" }));
    expect(container.querySelector(".site-sidebar")).toHaveAttribute("data-collapsed", "true");
    expect(screen.getByRole("button", { name: "展开侧边导航" })).toHaveAttribute("aria-expanded", "false");
    expect(window.localStorage.getItem("chainkit-sidebar-collapsed")).toBe("true");
  });
});
