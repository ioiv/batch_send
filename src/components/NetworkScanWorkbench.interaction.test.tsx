// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebsitePathScanPage } from "../pages/WebsitePathScanPage";
import { downloadScanCsv } from "../lib/network-scan";
import { PATH_DISCOVERY_SOURCES, discoverWebsitePaths, type PathDiscoverySourceResult, type WebsitePathDiscoverySummary } from "../lib/website-path-discovery";

vi.mock("../lib/website-path-discovery", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/website-path-discovery")>(), discoverWebsitePaths: vi.fn()
}));
vi.mock("../lib/network-scan", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/network-scan")>(), downloadScanCsv: vi.fn()
}));

type DiscoveryOptions = Parameters<typeof discoverWebsitePaths>[0];
function completedSources(status: PathDiscoverySourceResult["status"] = "success"): PathDiscoverySourceResult[] {
  return PATH_DISCOVERY_SOURCES.map(({ id }) => ({ source: id, status, urls: [], ...(status === "error" ? { message: "来源暂不可用" } : {}) }));
}
function summary(sources = completedSources()): WebsitePathDiscoverySummary {
  return { discovered: 0, validated: 0, truncated: false, sources };
}
function deferred() {
  let resolve!: (value: WebsitePathDiscoverySummary) => void;
  const promise = new Promise<WebsitePathDiscoverySummary>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function targetInput(value = "https://example.com/docs/") {
  fireEvent.change(screen.getByRole("textbox", { name: "网站地址" }), { target: { value } });
}

beforeEach(() => {
  vi.mocked(discoverWebsitePaths).mockReset();
  vi.mocked(discoverWebsitePaths).mockResolvedValue(summary());
  vi.mocked(downloadScanCsv).mockReset();
});
afterEach(cleanup);

describe("Automatic website path discovery workbench", () => {
  it("starts automatic discovery without a dictionary and preserves the website and configured options", async () => {
    const user = userEvent.setup();
    render(<WebsitePathScanPage />);
    expect(screen.getByRole("heading", { level: 1, name: "网站路径扫描" })).toBeVisible();
    expect(screen.queryByRole("textbox", { name: /字典/u })).not.toBeInTheDocument();
    expect(document.querySelector("textarea")).toBeNull();
    expect(within(screen.getByRole("list", { name: "路径发现来源" })).getAllByRole("listitem")).toHaveLength(5);
    targetInput();
    fireEvent.change(screen.getByRole("spinbutton", { name: "响应验证并发数" }), { target: { value: "2" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "站点请求超时（秒）" }), { target: { value: "3" } });
    await user.click(screen.getByRole("button", { name: "开始扫描" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "重新扫描" })).toBeEnabled());
    expect(discoverWebsitePaths).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: "https://example.com/docs/", concurrency: 2, timeoutMs: 3000 }));
    expect(screen.getByRole("textbox", { name: "网站地址" })).toHaveValue("https://example.com/docs/");
    expect(screen.getByRole("spinbutton", { name: "响应验证并发数" })).toHaveValue(2);
  });

  it("streams discovery and validation, keeps sources compact, exposes response details and exports all filtered-out rows", async () => {
    const user = userEvent.setup();
    const pending = deferred();
    let options!: DiscoveryOptions;
    vi.mocked(discoverWebsitePaths).mockImplementation((value) => { options = value; return pending.promise; });
    render(<WebsitePathScanPage />);
    targetInput();
    await user.click(screen.getByRole("button", { name: "开始扫描" }));
    const sources: PathDiscoverySourceResult[] = [
      { source: "links", status: "success", urls: ["https://example.com/docs/robots.txt", "https://example.com/login"] },
      { source: "scripts", status: "partial", urls: ["https://example.com/catchall"], message: "达到脚本读取上限" },
      { source: "robots", status: "success", urls: [] },
      { source: "sitemap", status: "success", urls: ["https://example.com/missing"] },
      { source: "wayback", status: "error", urls: [], message: "历史来源限流" }
    ];
    await act(async () => {
      sources.forEach(options.onSource);
      options.onProgress?.({ phase: "discovering", completed: 12, total: 12, discovered: 5 });
    });
    expect(screen.getByText("发现中 · 已处理 12 / 12 个发现请求 · 发现 5 个路径")).toBeVisible();
    expect(screen.getByText("脚本线索 · 1（部分）")).toBeVisible();
    expect(screen.getByText("历史记录 · 不可用")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "说明：历史记录 的发现状态" }));
    expect(await screen.findByText("历史来源限流")).toBeVisible();
    await user.keyboard("{Escape}");
    await act(async () => {
      options.onResult({ url: "https://example.com/docs/robots.txt", status: "responded", statusCode: 200, title: "Robots", contentLength: 128, sources: ["links", "robots"] });
      options.onResult({ url: "https://example.com/login", status: "responded", statusCode: 302, location: "/signin", sources: ["links"] });
      options.onResult({ url: "https://example.com/missing", status: "responded", statusCode: 404, sources: ["sitemap"] });
      options.onResult({ url: "https://example.com/catchall", status: "responded", statusCode: 200, soft404: true, title: "统一页面", sources: ["scripts"] });
      options.onResult({ url: "https://example.com/broken", status: "error", message: "请求超时", sources: ["wayback"] });
      options.onProgress?.({ phase: "validating", completed: 5, total: 5, discovered: 5 });
    });
    expect(screen.getByText("响应验证中 · 已验证 5 / 5 项 · 发现 5 个路径")).toBeVisible();
    let table = within(screen.getByRole("table", { name: "网站路径扫描结果" }));
    expect(table.getByRole("link", { name: "/docs/robots.txt" })).toHaveAttribute("href", "https://example.com/docs/robots.txt");
    expect(table.getByText("Robots")).toBeVisible();
    expect(table.getByText("页面 +1")).toBeVisible();
    expect(table.getByText("重定向 · 302")).toBeVisible();
    expect(table.getByText("未找到 · 404")).toBeVisible();
    expect(table.getByText("疑似软 404 · 200")).toBeVisible();
    expect(table.getByText("请求错误")).toBeVisible();
    expect(screen.queryByText("128 B")).not.toBeInTheDocument();
    await user.click(table.getByRole("button", { name: "说明：https://example.com/docs/robots.txt 的响应详情" }));
    expect(await screen.findByText("128 B")).toBeVisible();
    expect(screen.getByText("https://example.com/docs/robots.txt")).toBeVisible();
    await user.keyboard("{Escape}");
    await user.click(table.getByRole("button", { name: "说明：https://example.com/login 的响应详情" }));
    expect(await screen.findByRole("link", { name: "/signin" })).toHaveAttribute("href", "https://example.com/signin");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("tab", { name: "有响应" }));
    table = within(screen.getByRole("table", { name: "网站路径扫描结果" }));
    expect(table.queryByText("统一页面")).not.toBeInTheDocument();
    expect(table.queryByText("未找到 · 404")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "导出 CSV" }));
    const [filename, csv] = vi.mocked(downloadScanCsv).mock.calls[0];
    expect(filename).toMatch(/^website-path-discovery-.*\.csv$/u);
    for (const expected of ["robots.txt", "/login", "/missing", "/catchall", "/broken", "links", "scripts"]) expect(csv).toContain(expected);
    await user.click(screen.getByRole("tab", { name: "全部" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索扫描结果" }), { target: { value: "脚本线索" } });
    table = within(screen.getByRole("table", { name: "网站路径扫描结果" }));
    expect(table.getByText("统一页面")).toBeVisible();
    expect(table.queryByText("Robots")).not.toBeInTheDocument();
    await act(async () => { pending.resolve({ discovered: 5, validated: 5, truncated: false, sources }); await pending.promise; });
    expect(screen.getByRole("status", { name: "扫描完成 · 数据不完整" })).toBeVisible();
  });

  it("cancels without overlapping jobs or accepting late source/results updates and preserves configuration", async () => {
    const user = userEvent.setup();
    const pending = deferred();
    let options!: DiscoveryOptions;
    vi.mocked(discoverWebsitePaths).mockImplementationOnce((value) => { options = value; return pending.promise; });
    render(<WebsitePathScanPage />);
    targetInput();
    await user.click(screen.getByRole("button", { name: "开始扫描" }));
    await act(async () => {
      options.onSource({ source: "links", status: "success", urls: ["https://example.com/docs/"] });
      options.onProgress?.({ phase: "discovering", completed: 1, total: 4, discovered: 1 });
    });
    await user.click(screen.getByRole("button", { name: "停止扫描" }));
    expect(options.signal.aborted).toBe(true);
    expect(screen.getByRole("button", { name: "停止中…" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("textbox", { name: "网站地址" }).closest("form")!);
    expect(discoverWebsitePaths).toHaveBeenCalledTimes(1);
    await act(async () => {
      options.onSource({ source: "wayback", status: "error", urls: [], message: "过期错误" });
      options.onResult({ url: "https://example.com/late", status: "responded", statusCode: 200, sources: ["links"] });
      options.onProgress?.({ phase: "validating", completed: 1, total: 1, discovered: 1 });
      pending.resolve(summary());
      await pending.promise;
    });
    expect(screen.getByText("已停止 · 已处理 1 / 4 个发现请求 · 发现 1 个路径")).toBeVisible();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText("过期错误")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "网站地址" })).toHaveValue("https://example.com/docs/");
    await user.click(screen.getByRole("button", { name: "重新扫描" }));
    await waitFor(() => expect(discoverWebsitePaths).toHaveBeenCalledTimes(2));
    await act(async () => { options.onResult({ url: "https://example.com/stale", status: "responded", statusCode: 200, sources: ["links"] }); });
    expect(screen.queryByRole("link", { name: "/stale" })).not.toBeInTheDocument();
  });

  it("aborts discovery and discards updates on unmount", async () => {
    const user = userEvent.setup();
    const pending = deferred();
    let options!: DiscoveryOptions;
    vi.mocked(discoverWebsitePaths).mockImplementation((value) => { options = value; return pending.promise; });
    const view = render(<WebsitePathScanPage />);
    targetInput();
    await user.click(screen.getByRole("button", { name: "开始扫描" }));
    view.unmount();
    expect(options.signal.aborted).toBe(true);
    await act(async () => { options.onResult({ url: "https://example.com/late", status: "responded", statusCode: 200, sources: ["links"] }); pending.resolve(summary()); await pending.promise; });
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("validates the website and numerical limits before requesting discovery", async () => {
    const user = userEvent.setup();
    render(<WebsitePathScanPage />);
    await user.click(screen.getByRole("button", { name: "开始扫描" }));
    expect(screen.getByRole("textbox", { name: "网站地址" })).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("textbox", { name: "网站地址" })).toHaveFocus();
    targetInput("https://example.com:3000/");
    await user.click(screen.getByRole("button", { name: "开始扫描" }));
    expect(screen.getByRole("alert")).toBeVisible();
    targetInput();
    fireEvent.change(screen.getByRole("spinbutton", { name: "响应验证并发数" }), { target: { value: "9" } });
    await user.click(screen.getByRole("button", { name: "开始扫描" }));
    expect(screen.getByRole("alert")).toHaveTextContent("并发数需要是 1–8 的整数");
    fireEvent.change(screen.getByRole("spinbutton", { name: "响应验证并发数" }), { target: { value: "4" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "站点请求超时（秒）" }), { target: { value: "0" } });
    await user.click(screen.getByRole("button", { name: "开始扫描" }));
    expect(screen.getByRole("alert")).toHaveTextContent("超时需要是 1–10 秒的整数");
    expect(discoverWebsitePaths).not.toHaveBeenCalled();
  });

  it.each(["success", "error"] as const)("distinguishes empty discovery from unavailable sources (%s)", async (status) => {
    const user = userEvent.setup();
    vi.mocked(discoverWebsitePaths).mockResolvedValue(summary(completedSources(status)));
    render(<WebsitePathScanPage />);
    targetInput();
    await user.click(screen.getByRole("button", { name: "开始扫描" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "重新扫描" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "导出 CSV" })).toBeDisabled();
    expect(screen.getByText(status === "error" ? "本轮未返回验证结果，部分来源未完整读取，请查看来源说明" : "本轮未发现可验证路径，不能据此确认网站没有其他路径")).toBeVisible();
    expect(screen.getByRole("status", { name: status === "error" ? "扫描完成 · 数据不完整" : "扫描完成" })).toBeVisible();
  });

  it("paginates results while searching and exporting the full set", async () => {
    const user = userEvent.setup();
    vi.mocked(discoverWebsitePaths).mockImplementation(async (options) => {
      for (let index = 0; index < 101; index += 1) options.onResult({ url: `https://example.com/path${index}`, status: "responded", statusCode: 200, sources: ["links"] });
      return { discovered: 101, validated: 101, truncated: false, sources: completedSources() };
    });
    render(<WebsitePathScanPage />);
    targetInput();
    await user.click(screen.getByRole("button", { name: "开始扫描" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "下一页" })).toBeEnabled());
    let table = within(screen.getByRole("table", { name: "网站路径扫描结果" }));
    expect(table.getAllByRole("row")).toHaveLength(101);
    expect(table.queryByRole("link", { name: "/path100" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "下一页" }));
    table = within(screen.getByRole("table", { name: "网站路径扫描结果" }));
    expect(table.getByRole("link", { name: "/path100" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "导出 CSV" }));
    expect(vi.mocked(downloadScanCsv).mock.calls[0][1]).toContain("/path0");
    expect(vi.mocked(downloadScanCsv).mock.calls[0][1]).toContain("/path100");
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索扫描结果" }), { target: { value: "/path0" } });
    expect(screen.getByRole("link", { name: "/path0" })).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "路径结果分页" })).not.toBeInTheDocument();
  });

  it("retains partial results on a service failure", async () => {
    const user = userEvent.setup();
    vi.mocked(discoverWebsitePaths).mockImplementation(async (options) => {
      options.onResult({ url: "https://example.com/docs/", status: "responded", statusCode: 200, sources: ["links"] });
      options.onProgress?.({ phase: "validating", completed: 1, total: 3, discovered: 3 });
      throw new Error("扫描服务连接失败");
    });
    render(<WebsitePathScanPage />);
    targetInput();
    await user.click(screen.getByRole("button", { name: "开始扫描" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("扫描服务连接失败");
    expect(screen.getByRole("link", { name: "/docs/" })).toBeVisible();
    expect(screen.getByRole("button", { name: "导出 CSV" })).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "网站地址" })).toBeEnabled();
  });
});
