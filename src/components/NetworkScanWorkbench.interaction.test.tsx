// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebsitePathScanPage } from "../pages/WebsitePathScanPage";
import { downloadScanCsv } from "../lib/network-scan";
import { EXPOSURE_PATHS } from "../lib/exposure-path";
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
  it("shows the exact unresolved documents separately from recovered and confirmed missing documents", async () => {
    const user = userEvent.setup();
    const sources = completedSources().map(source => source.source === "scripts" ? { ...source, status: "partial" as const,
      issueCount: 2, unresolvedIssueCount: 1, issues: [
        { source: "scripts" as const, url: "https://example.com/assets/large.js", kind: "limit" as const, message: "达到脚本语法节点上限", statusCode: 200, attempts: 1, resolved: false },
        { source: "scripts" as const, url: "https://example.com/assets/recovered.js", kind: "request" as const, message: "读取超时", attempts: 2, resolved: true }
      ] } : source.source === "links" ? { ...source, issueCount: 1, unresolvedIssueCount: 0, issues: [
        { source: "links" as const, url: "https://example.com/api/", kind: "missing" as const, message: "文档返回 HTTP 404", statusCode: 404, resolved: true }
      ] } : source);
    vi.mocked(discoverWebsitePaths).mockResolvedValue({ ...summary(sources), diagnostics: {
      documentsQueued: 4, documentsRead: 5, documentsFailed: 0, retryAttempts: 1, failedAttempts: 1, recoveredDocuments: 1,
      scriptDocuments: 2, pendingDocuments: 0, activeDocuments: 0, pendingValidations: 0, activeValidations: 0, deadlineReached: false, skippedDocuments: 0
    } });
    render(<WebsitePathScanPage />);
    targetInput();
    await user.click(screen.getByRole("button", { name: "开始扫描" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "重新扫描" })).toBeEnabled());
    expect(screen.getByText("发现问题明细 · 未解决 1 项 · 已处理 2 项")).toBeVisible();
    expect(screen.getByRole("link", { name: "https://example.com/assets/large.js" })).toBeVisible();
    expect(screen.getByText("达到脚本语法节点上限")).toBeVisible();
    expect(screen.getByText("已恢复")).toBeVisible();
    expect(screen.getByText("已核对 GET 响应")).toBeVisible();
    expect(screen.getByText(/失败尝试 1 次 · 重试恢复 1 份/u)).toBeVisible();
    expect(screen.getByRole("status", { name: "扫描完成 · 数据不完整" })).toBeVisible();
  });

  it("finishes normally when all historical issues recovered, retaining their expandable details", async () => {
    const user = userEvent.setup();
    const sources = completedSources().map(source => source.source === "wayback" ? { ...source, issueCount: 1, unresolvedIssueCount: 0, issues: [
      { source: "wayback" as const, url: "https://example.com/", kind: "request" as const, message: "读取超时", attempts: 2, resolved: true }
    ] } : source);
    vi.mocked(discoverWebsitePaths).mockResolvedValue(summary(sources));
    render(<WebsitePathScanPage />);
    targetInput();
    await user.click(screen.getByRole("button", { name: "开始扫描" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "重新扫描" })).toBeEnabled());
    expect(screen.getByRole("status", { name: "扫描完成" })).toBeVisible();
    const details = screen.getByText("发现问题明细 · 未解决 0 项 · 已处理 1 项").closest("details");
    expect(details).not.toHaveAttribute("open");
    await user.click(screen.getByText("发现问题明细 · 未解决 0 项 · 已处理 1 项"));
    expect(screen.getByText("已恢复")).toBeVisible();
  });

  it("retains declared POST endpoints separately from missing GET pages and exports their methods", async () => {
    const user = userEvent.setup();
    vi.mocked(discoverWebsitePaths).mockImplementation(async options => {
      options.onResult({ url: "https://example.com/api/create", status: "responded", statusCode: 404, sources: ["scripts"],
        evidence: [{ kind: "request", documentUrl: "https://example.com/app.js", methods: ["POST"] }] });
      options.onResult({ url: "https://example.com/gone", status: "responded", statusCode: 404, sources: ["links"] });
      options.onResult({ url: "https://example.com/docs", status: "responded", statusCode: 200, sources: ["links"], responseReused: true });
      return { ...summary(), discovered: 3, validated: 3 };
    });
    render(<WebsitePathScanPage />);
    targetInput();
    await user.click(screen.getByRole("button", { name: "开始扫描" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "重新扫描" })).toBeEnabled());
    await user.click(screen.getByRole("tab", { name: "待确认接口" }));
    expect(screen.getByRole("link", { name: "/api/create" })).toBeVisible();
    expect(screen.getByText("待确认接口 · GET 404")).toBeVisible();
    expect(screen.queryByRole("link", { name: "/gone" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索扫描结果" }), { target: { value: "POST" } });
    expect(screen.getByRole("link", { name: "/api/create" })).toBeVisible();
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索扫描结果" }), { target: { value: "" } });
    await user.click(screen.getByRole("button", { name: "说明：https://example.com/api/create 的响应详情" }));
    expect(screen.getByText("POST")).toBeVisible();
    expect(screen.getByText(/未执行其他方法/u)).toBeVisible();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("tab", { name: "未找到" }));
    expect(screen.getByRole("link", { name: "/gone" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "/api/create" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "有响应" }));
    await user.click(screen.getByRole("button", { name: "说明：https://example.com/docs 的响应详情" }));
    expect(screen.getByText(/已复用本轮发现时读取的 GET 响应/u)).toBeVisible();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "导出 CSV" }));
    const csv = vi.mocked(downloadScanCsv).mock.calls.at(-1)![1];
    expect(csv).toContain("declared_methods");
    expect(csv).toContain("POST");
  });

  it("extracts an entered website on blur, preserving its entry path and removing query and fragment", async () => {
    const user = userEvent.setup();
    render(<WebsitePathScanPage />);
    const input = screen.getByRole("textbox", { name: "网站地址" });
    const pasted = "目标：https://EXAMPLE.COM/docs/page.html?utm=1#part";
    await user.click(input);
    fireEvent.change(input, { target: { value: pasted } });
    expect(input).toHaveValue(pasted);
    await user.tab();
    expect(input).toHaveValue("https://example.com/docs/page.html");
    await user.click(screen.getByRole("button", { name: "开始扫描" }));
    await waitFor(() => expect(discoverWebsitePaths).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: "https://example.com/docs/page.html" })));
  });

  it("immediately extracts valid pasted websites without intercepting incomplete pastes", () => {
    render(<WebsitePathScanPage />);
    const input = screen.getByRole("textbox", { name: "网站地址" });
    expect(fireEvent.paste(input, { clipboardData: { getData: () => "网址：https://EXAMPLE.COM/docs/page.html?q=1#top" } })).toBe(false);
    expect(input).toHaveValue("https://example.com/docs/page.html");
    expect(fireEvent.paste(input, { clipboardData: { getData: () => "https://" } })).toBe(true);
    expect(input).toHaveValue("https://example.com/docs/page.html");
    expect(discoverWebsitePaths).not.toHaveBeenCalled();
  });

  it("formats direct submissions and keeps incomplete website input available for editing", async () => {
    render(<WebsitePathScanPage />);
    const input = screen.getByRole("textbox", { name: "网站地址" });
    targetInput("https://");
    fireEvent.blur(input);
    expect(input).toHaveValue("https://");
    expect(discoverWebsitePaths).not.toHaveBeenCalled();
    targetInput("https://EXAMPLE.COM/docs/index.html?x=1#top");
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(discoverWebsitePaths).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: "https://example.com/docs/index.html" })));
    expect(input).toHaveValue("https://example.com/docs/index.html");
  });

  it("starts automatic discovery without a dictionary and preserves the website and configured options", async () => {
    const user = userEvent.setup();
    render(<WebsitePathScanPage />);
    expect(screen.getByRole("heading", { level: 1, name: "网站路径扫描" })).toBeVisible();
    expect(screen.queryByRole("textbox", { name: /字典/u })).not.toBeInTheDocument();
    expect(document.querySelector("textarea")).toBeNull();
    expect(within(screen.getByRole("list", { name: "路径发现来源" })).getAllByRole("listitem")).toHaveLength(5);
    expect(screen.getByRole("spinbutton", { name: "页面与验证超时（秒）" })).toHaveValue(10);
    targetInput();
    fireEvent.change(screen.getByRole("spinbutton", { name: "扫描并发数" }), { target: { value: "2" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "页面与验证超时（秒）" }), { target: { value: "3" } });
    await user.click(screen.getByRole("button", { name: "开始扫描" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "重新扫描" })).toBeEnabled());
    expect(discoverWebsitePaths).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: "https://example.com/docs/", concurrency: 2, timeoutMs: 3000 }));
    expect(screen.getByRole("textbox", { name: "网站地址" })).toHaveValue("https://example.com/docs/");
    expect(screen.getByRole("spinbutton", { name: "扫描并发数" })).toHaveValue(2);
  });

  it("keeps the observed mint endpoint visible with its concrete script evidence, searchable provenance and CSV export", async () => {
    const user = userEvent.setup();
    const endpoint = "https://next.overload.build/api/mint/config";
    const sourceScript = "https://next.overload.build/assets/live-BBH9rgPf.js";
    const sources = completedSources().map(source => ({ ...source,
      urls: source.source === "scripts" ? [endpoint] : source.source === "links" ? ["https://next.overload.build/docs"] : [] }));
    const diagnostics = { documentsQueued: 58, documentsRead: 59, documentsFailed: 1, retryAttempts: 1,
      scriptDocuments: 17, pendingDocuments: 0, activeDocuments: 0, pendingValidations: 0,
      activeValidations: 0, deadlineReached: false, skippedDocuments: 0 };
    vi.mocked(discoverWebsitePaths).mockImplementation(async options => {
      sources.forEach(options.onSource);
      options.onResult({ url: endpoint, status: "responded", statusCode: 200, contentLength: 132, durationMs: 84, sources: ["scripts"],
        evidence: [{ kind: "request", documentUrl: sourceScript, bytes: 851719, truncated: false }] });
      options.onResult({ url: "https://next.overload.build/docs", status: "responded", statusCode: 200, sources: ["links"] });
      return { discovered: 2, validated: 2, truncated: false, sources, diagnostics };
    });
    render(<WebsitePathScanPage />);
    targetInput("https://next.overload.build/");
    await user.click(screen.getByRole("button", { name: "开始扫描" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "重新扫描" })).toBeEnabled());
    expect(discoverWebsitePaths).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: "https://next.overload.build/", concurrency: 4, timeoutMs: 10000 }));
    expect(screen.getByRole("status", { name: "扫描完成" })).toBeVisible();
    expect(screen.getByText("文档读取 59 次 · 不同脚本 17 份 · 自动重试 1 次 · 读取失败 1 次")).toBeVisible();
    const table = within(screen.getByRole("table", { name: "网站路径扫描结果" }));
    const row = table.getByRole("link", { name: "/api/mint/config" }).closest("tr")!;
    expect(within(row).getByText("有响应 · 200")).toBeVisible();
    expect(within(row).getByText("脚本")).toBeVisible();
    expect(screen.queryByText("发现依据")).not.toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: `说明：${endpoint} 的响应详情` }));
    expect(await screen.findByText("发现依据")).toBeVisible();
    expect(screen.getByRole("link", { name: sourceScript })).toHaveAttribute("href", sourceScript);
    expect(screen.getByText(/已读取 851,719 B（完整文档）/u)).toBeVisible();
    expect(screen.getByText("132 B")).toBeVisible();
    await user.keyboard("{Escape}");
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索扫描结果" }), { target: { value: "LIVE-bbh9rgpf.JS" } });
    expect(screen.getByRole("link", { name: "/api/mint/config" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "/docs" })).not.toBeInTheDocument();
    expect(screen.getByText("匹配 1 / 2 条 · CSV 导出本轮全部已验证结果")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "导出 CSV" }));
    const csv = vi.mocked(downloadScanCsv).mock.calls.at(-1)![1];
    for (const value of [endpoint, sourceScript, "https://next.overload.build/docs", "evidence_documents", "evidence_kinds", "request"]) expect(csv).toContain(value);
  });

  it("updates live retry diagnostics and later evidence for the same row, retaining final document diagnostics", async () => {
    const user = userEvent.setup();
    const pending = deferred();
    let options!: DiscoveryOptions;
    vi.mocked(discoverWebsitePaths).mockImplementation(value => { options = value; return pending.promise; });
    render(<WebsitePathScanPage />);
    targetInput("https://next.overload.build/");
    await user.click(screen.getByRole("button", { name: "开始扫描" }));
    const url = "https://next.overload.build/api/mint/config";
    const sourceScript = "https://next.overload.build/assets/live-BBH9rgPf.js";
    const diagnostics = { documentsQueued: 12, documentsRead: 5, documentsFailed: 1, retryAttempts: 1,
      scriptDocuments: 4, pendingDocuments: 5, activeDocuments: 3, pendingValidations: 1,
      activeValidations: 1, deadlineReached: false, skippedDocuments: 0 };
    await act(async () => {
      options.onResult({ url, status: "responded", statusCode: 200, sources: ["scripts"] });
      options.onProgress?.({ phase: "discovering", completed: 1, total: 1, discovered: 1,
        discoveryCompleted: 5, discoveryTotal: 13, diagnostics });
    });
    expect(screen.getByText("文档读取 5 次 · 不同脚本 4 份 · 自动重试 1 次 · 读取失败 1 次")).toBeVisible();
    await act(async () => {
      options.onResult({ url, status: "responded", statusCode: 200, sources: ["scripts", "links"],
        evidence: [{ kind: "request", documentUrl: sourceScript, bytes: 851719, truncated: false }] });
    });
    const table = within(screen.getByRole("table", { name: "网站路径扫描结果" }));
    expect(table.getAllByRole("row")).toHaveLength(2);
    await user.click(table.getByRole("button", { name: `说明：${url} 的响应详情` }));
    expect(await screen.findByRole("link", { name: sourceScript })).toBeVisible();
    expect(screen.getByText(/已读取 851,719 B（完整文档）/u)).toBeVisible();
    await user.keyboard("{Escape}");
    await act(async () => {
      pending.resolve({ discovered: 1, validated: 1, truncated: false, sources: completedSources(),
        diagnostics: { ...diagnostics, documentsRead: 13, pendingDocuments: 0, activeDocuments: 0,
          pendingValidations: 0, activeValidations: 0 } });
      await pending.promise;
    });
    expect(screen.getByRole("status", { name: "扫描完成" })).toBeVisible();
    expect(screen.getByText("文档读取 13 次 · 不同脚本 4 份 · 自动重试 1 次 · 读取失败 1 次")).toBeVisible();
    expect(screen.queryByText("文档读取 5 次 · 不同脚本 4 份 · 自动重试 1 次 · 读取失败 1 次")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "/api/mint/config" })).toBeVisible();
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
      { source: "links", status: "success", urls: ["https://example.com/docs/guide.html", "https://example.com/login"] },
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
      options.onResult({ url: "https://example.com/docs/guide.html", status: "responded", statusCode: 200, title: "Guide", contentLength: 128, sources: ["links", "robots"] });
      options.onResult({ url: "https://example.com/login", status: "responded", statusCode: 302, location: "/signin", sources: ["links"] });
      options.onResult({ url: "https://example.com/missing", status: "responded", statusCode: 404, sources: ["sitemap"] });
      options.onResult({ url: "https://example.com/catchall", status: "responded", statusCode: 200, soft404: true, title: "统一页面", sources: ["scripts"] });
      options.onResult({ url: "https://example.com/broken", status: "error", message: "请求超时", sources: ["wayback"] });
      options.onProgress?.({ phase: "validating", completed: 5, total: 5, discovered: 5 });
    });
    expect(screen.getByText("响应验证中 · 已验证 5 / 5 项 · 发现 5 个路径")).toBeVisible();
    let table = within(screen.getByRole("table", { name: "网站路径扫描结果" }));
    expect(table.getByRole("link", { name: "/docs/guide.html" })).toHaveAttribute("href", "https://example.com/docs/guide.html");
    expect(table.getByText("Guide")).toBeVisible();
    expect(table.getByText("页面 +1")).toBeVisible();
    expect(table.getByText("重定向 · 302")).toBeVisible();
    expect(table.getByText("未找到 · 404")).toBeVisible();
    expect(table.getByText("疑似软 404 · 200")).toBeVisible();
    expect(table.getByText("请求错误")).toBeVisible();
    expect(screen.queryByText("128 B")).not.toBeInTheDocument();
    await user.click(table.getByRole("button", { name: "说明：https://example.com/docs/guide.html 的响应详情" }));
    expect(await screen.findByText("128 B")).toBeVisible();
    expect(screen.getByText("https://example.com/docs/guide.html")).toBeVisible();
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
    for (const expected of ["guide.html", "/login", "/missing", "/catchall", "/broken", "links", "scripts"]) expect(csv).toContain(expected);
    await user.click(screen.getByRole("tab", { name: "全部" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索扫描结果" }), { target: { value: "脚本线索" } });
    table = within(screen.getByRole("table", { name: "网站路径扫描结果" }));
    expect(table.getByText("统一页面")).toBeVisible();
    expect(table.queryByText("Guide")).not.toBeInTheDocument();
    await act(async () => { pending.resolve({ discovered: 5, validated: 5, truncated: false, sources }); await pending.promise; });
    expect(screen.getByRole("status", { name: "扫描完成 · 数据不完整" })).toBeVisible();
  });

  it("shows and exports validation during discovery and removes paths later identified as static assets", async () => {
    const user = userEvent.setup();
    const pending = deferred();
    let options!: DiscoveryOptions;
    vi.mocked(discoverWebsitePaths).mockImplementation(value => { options = value; return pending.promise; });
    render(<WebsitePathScanPage />);
    targetInput();
    await user.click(screen.getByRole("button", { name: "开始扫描" }));
    await act(async () => {
      options.onProgress?.({ phase: "discovering", completed: 0, total: 2, discovered: 2, discoveryCompleted: 1, discoveryTotal: 8 });
    });
    expect(screen.getByRole("status", { name: "发现并验证中" })).toBeVisible();
    expect(screen.getByText("正在发现并验证路径，等待首批响应结果…")).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "路径响应验证进度" })).toHaveTextContent("0/2");
    expect(screen.getByRole("progressbar", { name: "路径发现请求进度" })).toHaveTextContent("1/8");

    const removedUrl = "https://example.com/bundle";
    const keptUrl = "https://example.com/live";
    await act(async () => {
      options.onResult({ url: removedUrl, status: "responded", statusCode: 200, sources: ["links"] });
      options.onResult({ url: keptUrl, status: "responded", statusCode: 200, sources: ["links"] });
      options.onProgress?.({ phase: "discovering", completed: 2, total: 2, discovered: 2, discoveryCompleted: 1, discoveryTotal: 8 });
    });
    expect(screen.getByText("发现并验证中 · 已处理 1 / 8 个发现请求 · 已验证 2 / 当前候选 2 · 发现 2 个路径")).toBeVisible();
    expect(screen.getByRole("link", { name: "/bundle" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "导出 CSV" }));
    expect(vi.mocked(downloadScanCsv).mock.calls.at(-1)![1]).toContain(removedUrl);

    await act(async () => {
      options.onResult({ url: keptUrl, status: "responded", statusCode: 200, soft404: true, clientRoute: true, sources: ["links", "scripts"] });
      options.onRemoveResult?.(removedUrl);
      options.onProgress?.({ phase: "discovering", completed: 1, total: 1, discovered: 1, discoveryCompleted: 2, discoveryTotal: 8 });
    });
    expect(screen.queryByRole("link", { name: "/bundle" })).not.toBeInTheDocument();
    const table = within(screen.getByRole("table", { name: "网站路径扫描结果" }));
    expect(table.getAllByRole("row")).toHaveLength(2);
    expect(table.getByText("前端路由 · 200")).toBeVisible();
    expect(table.getByText("页面 +1")).toBeVisible();
    expect(screen.getByText("发现并验证中 · 已处理 2 / 8 个发现请求 · 已验证 1 / 当前候选 1 · 发现 1 个路径")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "导出 CSV" }));
    const csv = vi.mocked(downloadScanCsv).mock.calls.at(-1)![1];
    expect(csv).toContain(keptUrl);
    expect(csv).not.toContain(removedUrl);

    await user.click(screen.getByRole("button", { name: "停止扫描" }));
    await act(async () => {
      options.onRemoveResult?.(keptUrl);
      pending.resolve(summary());
      await pending.promise;
    });
    expect(screen.getByRole("link", { name: "/live" })).toBeVisible();
    expect(screen.getByText("已停止 · 已处理 2 / 8 个发现请求 · 已验证 1 / 当前候选 1 · 发现 1 个路径")).toBeVisible();
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

  it("filters responding paths by exact HTTP code, combines search and resets the code for another category or round", async () => {
    const user = userEvent.setup();
    vi.mocked(discoverWebsitePaths).mockImplementation(async (options) => {
      for (const [path, statusCode] of [["alpha", 200], ["beta", 200], ["moved", 301], ["redirect", 302], ["forbidden", 403], ["server-error", 500]] as const) {
        options.onResult({ url: `https://example.com/${path}`, status: "responded", statusCode, sources: ["links"] });
      }
      options.onResult({ url: "https://example.com/catchall", status: "responded", statusCode: 200, soft404: true, sources: ["links"] });
      options.onResult({ url: "https://example.com/missing", status: "responded", statusCode: 404, sources: ["links"] });
      options.onResult({ url: "https://example.com/request-error", status: "error", message: "连接失败", sources: ["links"] });
      return { discovered: 9, validated: 9, truncated: false, sources: completedSources() };
    });
    render(<WebsitePathScanPage />);
    targetInput();
    await user.click(screen.getByRole("button", { name: "开始扫描" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "重新扫描" })).toBeEnabled());
    expect(screen.queryByRole("group", { name: "HTTP状态码筛选" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "有响应" }));
    let codes = within(screen.getByRole("group", { name: "HTTP状态码筛选" }));
    expect(codes.getAllByRole("button").map((button) => button.textContent)).toEqual(["全部状态 · 6", "200 · 2", "301 · 1", "302 · 1", "403 · 1", "500 · 1"]);
    expect(codes.getByRole("button", { name: "全部状态 · 6" })).toHaveAttribute("aria-pressed", "true");
    await user.click(codes.getByRole("button", { name: "301 · 1" }));
    let table = within(screen.getByRole("table", { name: "网站路径扫描结果" }));
    expect(table.getByRole("link", { name: "/moved" })).toBeVisible();
    expect(table.queryByRole("link", { name: "/redirect" })).not.toBeInTheDocument();
    expect(table.getAllByRole("row")).toHaveLength(2);
    expect(codes.getByRole("button", { name: "301 · 1" })).toHaveAttribute("aria-pressed", "true");
    await user.click(codes.getByRole("button", { name: "403 · 1" }));
    expect(screen.getByRole("link", { name: "/forbidden" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "/moved" })).not.toBeInTheDocument();
    await user.click(codes.getByRole("button", { name: "500 · 1" }));
    expect(screen.getByRole("link", { name: "/server-error" })).toBeVisible();
    await user.click(codes.getByRole("button", { name: "200 · 2" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索扫描结果" }), { target: { value: "beta" } });
    table = within(screen.getByRole("table", { name: "网站路径扫描结果" }));
    expect(table.getByRole("link", { name: "/beta" })).toBeVisible();
    expect(table.queryByRole("link", { name: "/alpha" })).not.toBeInTheDocument();
    expect(codes.getByRole("button", { name: "200 · 2" })).toBeVisible();
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索扫描结果" }), { target: { value: "redirect" } });
    expect(screen.queryByRole("table", { name: "网站路径扫描结果" })).not.toBeInTheDocument();
    expect(screen.getByText("暂无匹配结果")).toBeVisible();
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索扫描结果" }), { target: { value: "" } });
    await user.click(screen.getByRole("tab", { name: "全部" }));
    expect(screen.queryByRole("group", { name: "HTTP状态码筛选" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "有响应" }));
    codes = within(screen.getByRole("group", { name: "HTTP状态码筛选" }));
    expect(codes.getByRole("button", { name: "全部状态 · 6" })).toHaveAttribute("aria-pressed", "true");
    await user.click(codes.getByRole("button", { name: "302 · 1" }));
    expect(screen.getByRole("link", { name: "/redirect" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "重新扫描" }));
    await waitFor(() => expect(discoverWebsitePaths).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("group", { name: "HTTP状态码筛选" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "有响应" }));
    codes = within(screen.getByRole("group", { name: "HTTP状态码筛选" }));
    expect(codes.getByRole("button", { name: "全部状态 · 6" })).toHaveAttribute("aria-pressed", "true");
    expect(within(screen.getByRole("table", { name: "网站路径扫描结果" })).getAllByRole("row")).toHaveLength(7);
  });

  it("surfaces fixed exposure findings in a dedicated tab and exports their verdict", async () => {
    const user = userEvent.setup();
    const entry = EXPOSURE_PATHS.find(item => item.path === "/.env")!;
    vi.mocked(discoverWebsitePaths).mockImplementation(async (options) => {
      options.onExposureProgress?.(0, EXPOSURE_PATHS.length);
      options.onResult({ url: "https://example.com/.env", status: "responded", statusCode: 200, fingerprint: "a".repeat(64), durationMs: 120,
        exposure: { path: entry, verdict: "high" }, sources: [] });
      options.onResult({ url: "https://example.com/.git/HEAD", status: "responded", statusCode: 404, durationMs: 40, sources: [] });
      options.onExposureProgress?.(EXPOSURE_PATHS.length, EXPOSURE_PATHS.length);
      return { discovered: 0, validated: 0, truncated: false, sources: completedSources() };
    });
    render(<WebsitePathScanPage />);
    targetInput();
    await user.click(screen.getByRole("button", { name: "开始扫描" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "重新扫描" })).toBeEnabled());
    // A confirmed finding also appears in the general list; an unconfirmed probe never does.
    expect(screen.getByRole("link", { name: "/.env" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "/.git/HEAD" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "暴露面 · 1" }));
    const table = within(screen.getByRole("table", { name: "网站路径扫描结果" }));
    expect(table.getByRole("link", { name: "/.env" })).toBeVisible();
    expect(table.getByText("高置信暴露 · 200")).toBeVisible();
    expect(table.getByText("暴露探测")).toBeVisible();
    expect(table.queryByText("/.git/HEAD")).not.toBeInTheDocument();
    await user.click(table.getByRole("button", { name: "说明：https://example.com/.env 的响应详情" }));
    expect(await screen.findByText(entry.description)).toBeVisible();
    expect(screen.getByText(/请人工确认是否为真实泄漏/)).toBeVisible();
    await user.keyboard("{Escape}");
    const confidence = within(screen.getByRole("group", { name: "暴露面置信度筛选" }));
    expect(confidence.getByRole("button", { name: "全部暴露 · 1" })).toHaveAttribute("aria-pressed", "true");
    await user.click(confidence.getByRole("button", { name: "高置信 · 1" }));
    expect(within(screen.getByRole("table", { name: "网站路径扫描结果" })).getByRole("link", { name: "/.env" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "导出 CSV" }));
    const csv = vi.mocked(downloadScanCsv).mock.calls[0][1];
    expect(csv).toContain('"high","secret-file","high"');
    expect(csv).toContain("120");
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
    fireEvent.change(screen.getByRole("spinbutton", { name: "扫描并发数" }), { target: { value: "9" } });
    await user.click(screen.getByRole("button", { name: "开始扫描" }));
    expect(screen.getByRole("alert")).toHaveTextContent("并发数需要是 1–8 的整数");
    fireEvent.change(screen.getByRole("spinbutton", { name: "扫描并发数" }), { target: { value: "4" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "页面与验证超时（秒）" }), { target: { value: "0" } });
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
    await user.click(screen.getByRole("tab", { name: "有响应" }));
    await user.click(screen.getByRole("button", { name: "下一页" }));
    expect(screen.getByRole("link", { name: "/path100" })).toBeVisible();
    await user.click(within(screen.getByRole("group", { name: "HTTP状态码筛选" })).getByRole("button", { name: "200 · 101" }));
    expect(screen.getByRole("link", { name: "/path0" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "/path100" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上一页" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "下一页" }));
    await user.click(screen.getByRole("button", { name: "导出 CSV" }));
    expect(vi.mocked(downloadScanCsv).mock.calls[0][1]).toContain("/path0");
    expect(vi.mocked(downloadScanCsv).mock.calls[0][1]).toContain("/path100");
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索扫描结果" }), { target: { value: "/path0" } });
    expect(screen.getByRole("link", { name: "/path0" })).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "路径结果分页" })).not.toBeInTheDocument();
  }, 10_000);

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

describe("public entry guidance and client routes", () => {
  it("prefills a linked public website without starting a scan", () => {
    const previous = window.location.href;
    window.history.replaceState({}, "", "/network/paths/?target=https%3A%2F%2Fdocs.example.com%2F%3Ftracking%3D1");
    try {
      render(<WebsitePathScanPage />);
      expect(screen.getByRole("textbox", { name: "网站地址" })).toHaveValue("https://docs.example.com/");
      expect(discoverWebsitePaths).not.toHaveBeenCalled();
    } finally { window.history.replaceState({}, "", previous); }
  });

  it("shows an unavailable entry clearly and preserves its actual HTTP status", async () => {
    const user = userEvent.setup();
    vi.mocked(discoverWebsitePaths).mockImplementation(async options => {
      options.onResult({ url: "https://example.com/", status: "responded", statusCode: 404, sources: ["links"] });
      return { ...summary(), discovered: 1, validated: 1 };
    });
    render(<WebsitePathScanPage />);
    targetInput("https://example.com/");
    await user.click(screen.getByRole("button", { name: "开始扫描" }));
    expect(await screen.findByText(/网站入口返回 HTTP 404/)).toBeVisible();
    expect(screen.getByText("未找到 · 404")).toBeVisible();
  });

  it("keeps successfully responding declared routes separate from soft-404 shells but does not hide missing routes", async () => {
    const user = userEvent.setup();
    vi.mocked(discoverWebsitePaths).mockImplementation(async options => {
      options.onResult({ url: "https://example.com/docs/items", status: "responded", statusCode: 200, soft404: true, clientRoute: true, sources: ["scripts"] });
      options.onResult({ url: "https://example.com/docs/missing", status: "responded", statusCode: 404, soft404: true, clientRoute: true, sources: ["scripts"] });
      options.onResult({ url: "https://example.com/unknown", status: "responded", statusCode: 200, soft404: true, sources: ["scripts"] });
      return { ...summary(), discovered: 3, validated: 3 };
    });
    render(<WebsitePathScanPage />);
    targetInput("https://example.com/");
    await user.click(screen.getByRole("button", { name: "开始扫描" }));
    expect(await screen.findByText("前端路由 · 200")).toBeVisible();
    expect(screen.getByText("未找到 · 404")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "说明：https://example.com/docs/items 的响应详情" }));
    expect(await screen.findByText(/脚本明确声明了此路由/)).toHaveTextContent("统一应用入口");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("tab", { name: "有响应" }));
    expect(screen.getByRole("link", { name: "/docs/items" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "/docs/missing" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "/unknown" })).not.toBeInTheDocument();
  });

  it("keeps published fixed-list routes visible and excludes unconfirmed probes from counts", async () => {
    const user = userEvent.setup();
    vi.mocked(discoverWebsitePaths).mockImplementation(async options => {
      options.onResult({ url: "https://example.com/console/", status: "responded", statusCode: 200, clientRoute: true, sources: ["scripts"] });
      options.onResult({ url: "https://example.com/actuator/health", status: "responded", statusCode: 403, sources: ["links"] });
      options.onResult({ url: "https://example.com/.git/HEAD", status: "responded", statusCode: 404, sources: [] });
      options.onResult({ url: "https://example.com/.env", status: "error", sources: [] });
      return { ...summary(), discovered: 2, validated: 2 };
    });
    render(<WebsitePathScanPage />);
    targetInput("https://example.com/");
    await user.click(screen.getByRole("button", { name: "开始扫描" }));
    expect(await screen.findByText("前端路由 · 200")).toBeVisible();
    expect(screen.getByText("访问受限 · 403")).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "有响应" }));
    expect(screen.getByRole("button", { name: "全部状态 · 2" })).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "未找到" }));
    expect(screen.queryByRole("link", { name: "/.git/HEAD" })).not.toBeInTheDocument();
    const metrics = document.querySelector<HTMLElement>(".workbench-inline-summary")!;
    expect(within(metrics).getByText("未找到").nextElementSibling).toHaveTextContent("0");
    expect(within(metrics).getByText("请求错误").nextElementSibling).toHaveTextContent("0");
  });

  it("updates the current entry when the website advertises an HTTPS upgrade", async () => {
    const user = userEvent.setup();
    vi.mocked(discoverWebsitePaths).mockImplementation(async options => {
      options.onTarget?.("https://example.com/docs/");
      return { ...summary(), baseUrl: "https://example.com/docs/" };
    });
    render(<WebsitePathScanPage />);
    targetInput("http://example.com/");
    await user.click(screen.getByRole("button", { name: "开始扫描" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "网站地址" })).toHaveValue("https://example.com/docs/"));
    expect(screen.getByText("本轮目标：https://example.com/docs/")).toBeVisible();
  });
});
