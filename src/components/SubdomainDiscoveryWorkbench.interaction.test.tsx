// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubdomainScanPage } from "../pages/SubdomainScanPage";
import { downloadScanCsv } from "../lib/network-scan";
import {
  SUBDOMAIN_DISCOVERY_SOURCES,
  discoverSubdomains,
  type SubdomainDiscoverySourceResult,
  type SubdomainDiscoverySummary
} from "../lib/subdomain-discovery";

vi.mock("../lib/subdomain-discovery", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/subdomain-discovery")>(),
  discoverSubdomains: vi.fn()
}));
vi.mock("../lib/network-scan", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/network-scan")>(),
  downloadScanCsv: vi.fn()
}));

type DiscoveryOptions = Parameters<typeof discoverSubdomains>[0];

function completedSources(status: SubdomainDiscoverySourceResult["status"] = "success"): SubdomainDiscoverySourceResult[] {
  return SUBDOMAIN_DISCOVERY_SOURCES.map((source) => ({
    source: source.id, status, domains: [], ...(status === "error" ? { message: "上游来源不可用" } : {})
  }));
}

function summary(sources = completedSources()): SubdomainDiscoverySummary {
  return { discovered: 0, validated: 0, truncated: false, sources };
}

function deferred() {
  let resolve!: (summary: SubdomainDiscoverySummary) => void;
  const promise = new Promise<SubdomainDiscoverySummary>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function domainInput(value = "example.com") {
  fireEvent.change(screen.getByRole("textbox", { name: "主域名" }), { target: { value } });
}

beforeEach(() => {
  vi.mocked(discoverSubdomains).mockReset();
  vi.mocked(discoverSubdomains).mockResolvedValue(summary());
  vi.mocked(downloadScanCsv).mockReset();
});
afterEach(cleanup);

describe("Subdomain discovery workbench", () => {
  it("extracts a domain from entered text on blur without changing the value during typing", async () => {
    const user = userEvent.setup();
    render(<SubdomainScanPage />);
    const input = screen.getByRole("textbox", { name: "主域名" });
    const pasted = "请扫描 https://EXAMPLE.COM:8443/team/index.html?x=1#top";
    await user.click(input);
    fireEvent.change(input, { target: { value: pasted } });
    expect(input).toHaveValue(pasted);
    await user.tab();
    expect(input).toHaveValue("example.com");
    await user.click(screen.getByRole("button", { name: "开始扫描" }));
    await waitFor(() => expect(discoverSubdomains).toHaveBeenCalledWith(expect.objectContaining({ domain: "example.com" })));
  });

  it("immediately extracts valid pasted URLs and leaves invalid pastes to the browser", () => {
    render(<SubdomainScanPage />);
    const input = screen.getByRole("textbox", { name: "主域名" });
    expect(fireEvent.paste(input, { clipboardData: { getData: () => "网址：https://EXAMPLE.COM:8443/docs?q=1#top" } })).toBe(false);
    expect(input).toHaveValue("example.com");
    expect(fireEvent.paste(input, { clipboardData: { getData: () => "https://" } })).toBe(true);
    expect(input).toHaveValue("example.com");
    expect(discoverSubdomains).not.toHaveBeenCalled();
  });

  it("formats a full URL when submitted directly and leaves incomplete input untouched on blur", async () => {
    render(<SubdomainScanPage />);
    const input = screen.getByRole("textbox", { name: "主域名" });
    domainInput("https://");
    fireEvent.blur(input);
    expect(input).toHaveValue("https://");
    expect(discoverSubdomains).not.toHaveBeenCalled();
    domainInput("https://EXAMPLE.COM/docs?x=1#top");
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(discoverSubdomains).toHaveBeenCalledWith(expect.objectContaining({ domain: "example.com" })));
    expect(input).toHaveValue("example.com");
  });

  it("queries multiple public sources without exposing a dictionary and preserves the submitted configuration", async () => {
    const user = userEvent.setup();
    render(<SubdomainScanPage />);
    expect(screen.getByRole("heading", { level: 1, name: "子域名扫描" })).toBeVisible();
    expect(screen.queryByRole("textbox", { name: /字典/u })).not.toBeInTheDocument();
    expect(document.querySelector("textarea")).toBeNull();
    expect(within(screen.getByRole("list", { name: "公开发现来源" })).getAllByRole("listitem")).toHaveLength(6);
    domainInput("EXAMPLE.COM");
    fireEvent.change(screen.getByRole("spinbutton", { name: "DNS 验证并发数" }), { target: { value: "2" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "单项 DNS 超时（秒）" }), { target: { value: "3" } });
    await user.click(screen.getByRole("button", { name: "开始扫描" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "重新扫描" })).toBeEnabled());
    expect(discoverSubdomains).toHaveBeenCalledWith(expect.objectContaining({ domain: "example.com", concurrency: 2, timeoutMs: 3000 }));
    expect(screen.getByRole("textbox", { name: "主域名" })).toHaveValue("example.com");
    expect(screen.getByRole("spinbutton", { name: "DNS 验证并发数" })).toHaveValue(2);
  });

  it("streams source and DNS phases, preserves provenance and historic names, filters and exports all results", async () => {
    const user = userEvent.setup();
    const pending = deferred();
    let options!: DiscoveryOptions;
    vi.mocked(discoverSubdomains).mockImplementation((value) => { options = value; return pending.promise; });
    render(<SubdomainScanPage />);
    domainInput();
    await user.click(screen.getByRole("button", { name: "开始扫描" }));
    const sources: SubdomainDiscoverySourceResult[] = [
      { source: "crtsh", status: "success", domains: ["www.example.com", "api.example.com"] },
      { source: "certspotter", status: "partial", domains: ["api.example.com"], message: "上游分页受限" },
      { source: "hackertarget", status: "error", domains: [], message: "上游 API 配额耗尽" },
      { source: "dns", status: "success", domains: ["www.example.com"] },
      { source: "website", status: "success", domains: ["broken.example.com"] },
      { source: "wayback", status: "success", domains: ["old.example.com"] }
    ];
    await act(async () => {
      sources.forEach(options.onSource);
      options.onProgress?.({ phase: "discovering", completed: 6, total: 6, discovered: 4 });
    });
    expect(screen.getByText("发现中 · 已读取 6 / 6 个来源 · 发现 4 个子域名")).toBeVisible();
    const sourceList = within(screen.getByRole("list", { name: "公开发现来源" }));
    expect(sourceList.getByText("上游分页受限")).toBeVisible();
    expect(sourceList.getByText("上游 API 配额耗尽")).toBeVisible();
    await act(async () => {
      options.onProgress?.({ phase: "validating", completed: 0, total: 4, discovered: 4 });
      options.onResult({ domain: "www.example.com", status: "resolved", addresses: ["93.184.216.34"], cname: "edge.example.com", sources: ["crtsh", "dns"] });
      options.onResult({ domain: "api.example.com", status: "resolved", addresses: ["93.184.216.34"], wildcard: true, sources: ["crtsh", "certspotter"] });
      options.onResult({ domain: "old.example.com", status: "not-found", addresses: [], sources: ["wayback"] });
      options.onResult({ domain: "broken.example.com", status: "error", addresses: [], message: "DNS 验证超时", sources: ["website"] });
      options.onProgress?.({ phase: "validating", completed: 4, total: 4, discovered: 4 });
    });
    expect(screen.getByText("DNS 验证中 · 已验证 4 / 4 项 · 发现 4 个子域名")).toBeVisible();
    let table = within(screen.getByRole("table", { name: "子域名发现结果" }));
    expect(table.getByRole("columnheader", { name: "发现来源" })).toBeVisible();
    expect(table.getByRole("link", { name: "www.example.com" })).toHaveAttribute("href", "https://www.example.com");
    expect(table.queryByText("edge.example.com")).not.toBeInTheDocument();
    expect(table.queryByText("93.184.216.34")).not.toBeInTheDocument();
    expect(table.getAllByText("1 个地址")).toHaveLength(2);
    await user.click(table.getByRole("button", { name: "说明：www.example.com 的解析详情" }));
    let details = within(screen.getByRole("dialog", { name: "www.example.com 的解析详情" }));
    expect(details.getByText("edge.example.com")).toBeVisible();
    expect(details.getByText("93.184.216.34")).toBeVisible();
    await user.keyboard("{Escape}");
    await user.click(table.getByRole("button", { name: "说明：www.example.com 的发现来源" }));
    details = within(screen.getByRole("dialog", { name: "www.example.com 的发现来源" }));
    expect(details.getByText("crt.sh · 证书记录")).toBeVisible();
    expect(details.getByText("域名 DNS 记录")).toBeVisible();
    await user.keyboard("{Escape}");
    expect(table.getByText("当前未解析")).toBeVisible();
    expect(table.queryByText("公开来源曾记录该域名，当前未查到 DNS 记录")).not.toBeInTheDocument();
    expect(table.getByText("疑似通配解析")).toBeVisible();
    await user.click(table.getByRole("button", { name: "说明：broken.example.com 的解析详情" }));
    expect(screen.getByRole("dialog", { name: "broken.example.com 的解析详情" })).toHaveTextContent("DNS 验证超时");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("tab", { name: "当前未解析" }));
    table = within(screen.getByRole("table", { name: "子域名发现结果" }));
    expect(table.getByText("old.example.com")).toBeVisible();
    expect(table.queryByText("www.example.com")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "导出 CSV" }));
    const [filename, csv] = vi.mocked(downloadScanCsv).mock.calls[0];
    expect(filename).toMatch(/^subdomain-discovery-.*\.csv$/u);
    for (const expected of ["www.example.com", "api.example.com", "old.example.com", "broken.example.com", "crtsh", "wayback"]) expect(csv).toContain(expected);
    await user.click(screen.getByRole("tab", { name: "全部" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索子域名发现结果" }), { target: { value: "Wayback" } });
    table = within(screen.getByRole("table", { name: "子域名发现结果" }));
    expect(table.getByText("old.example.com")).toBeVisible();
    expect(table.queryByText("api.example.com")).not.toBeInTheDocument();
    await act(async () => { pending.resolve({ discovered: 4, validated: 4, truncated: false, sources }); await pending.promise; });
    expect(screen.getByText("扫描完成 · 数据不完整 · 已验证 4 / 4 项 · 发现 4 个子域名")).toBeVisible();
    expect(screen.getByText("部分来源不可用或仅返回部分记录；本轮结果可能不完整，详情见各来源状态。")).toBeVisible();
  });

  it("cancels both phases, blocks overlapping jobs and ignores source/results callbacks from stopped rounds", async () => {
    const user = userEvent.setup();
    const pending = deferred();
    let options!: DiscoveryOptions;
    vi.mocked(discoverSubdomains).mockImplementationOnce((value) => { options = value; return pending.promise; });
    render(<SubdomainScanPage />);
    domainInput();
    await user.click(screen.getByRole("button", { name: "开始扫描" }));
    await act(async () => {
      options.onSource({ source: "crtsh", status: "success", domains: ["www.example.com"] });
      options.onProgress?.({ phase: "discovering", completed: 1, total: 6, discovered: 1 });
    });
    await user.click(screen.getByRole("button", { name: "停止扫描" }));
    expect(options.signal.aborted).toBe(true);
    expect(screen.getByRole("button", { name: "停止中…" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("textbox", { name: "主域名" }).closest("form")!);
    expect(discoverSubdomains).toHaveBeenCalledTimes(1);
    await act(async () => {
      options.onSource({ source: "hackertarget", status: "error", domains: [], message: "过期来源错误" });
      options.onResult({ domain: "late.example.com", status: "resolved", addresses: [], sources: ["crtsh"] });
      options.onProgress?.({ phase: "validating", completed: 1, total: 1, discovered: 1 });
      pending.resolve(summary());
      await pending.promise;
    });
    expect(screen.getByText("已停止 · 已读取 1 / 6 个来源 · 发现 1 个子域名")).toBeVisible();
    expect(screen.queryByText("过期来源错误")).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "主域名" })).toHaveValue("example.com");
    expect(screen.getByRole("textbox", { name: "主域名" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "重新扫描" }));
    await waitFor(() => expect(discoverSubdomains).toHaveBeenCalledTimes(2));
    await act(async () => { options.onResult({ domain: "stale.example.com", status: "resolved", addresses: [], sources: ["crtsh"] }); });
    expect(screen.queryByRole("link", { name: "stale.example.com" })).not.toBeInTheDocument();
  });

  it("aborts discovery on unmount", async () => {
    const user = userEvent.setup();
    const pending = deferred();
    let options!: DiscoveryOptions;
    vi.mocked(discoverSubdomains).mockImplementation((value) => { options = value; return pending.promise; });
    const view = render(<SubdomainScanPage />);
    domainInput();
    await user.click(screen.getByRole("button", { name: "开始扫描" }));
    view.unmount();
    expect(options.signal.aborted).toBe(true);
    await act(async () => {
      options.onSource({ source: "crtsh", status: "success", domains: ["www.example.com"] });
      options.onResult({ domain: "www.example.com", status: "resolved", addresses: [], sources: ["crtsh"] });
      pending.resolve(summary());
      await pending.promise;
    });
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("validates domain and DNS options before starting source requests", async () => {
    const user = userEvent.setup();
    render(<SubdomainScanPage />);
    await user.click(screen.getByRole("button", { name: "开始扫描" }));
    expect(screen.getByRole("textbox", { name: "主域名" })).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("textbox", { name: "主域名" })).toHaveFocus();
    domainInput();
    fireEvent.change(screen.getByRole("spinbutton", { name: "DNS 验证并发数" }), { target: { value: "9" } });
    await user.click(screen.getByRole("button", { name: "开始扫描" }));
    expect(screen.getByRole("alert")).toHaveTextContent("并发数需要是 1–8 的整数");
    fireEvent.change(screen.getByRole("spinbutton", { name: "DNS 验证并发数" }), { target: { value: "4" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "单项 DNS 超时（秒）" }), { target: { value: "0" } });
    await user.click(screen.getByRole("button", { name: "开始扫描" }));
    expect(screen.getByRole("alert")).toHaveTextContent("DNS 超时需要是 1–10 秒的整数");
    expect(discoverSubdomains).not.toHaveBeenCalled();
  });

  it.each(["success", "error"] as const)("distinguishes zero discoveries when sources finish with %s", async (status) => {
    const user = userEvent.setup();
    vi.mocked(discoverSubdomains).mockResolvedValue(summary(completedSources(status)));
    render(<SubdomainScanPage />);
    domainInput();
    await user.click(screen.getByRole("button", { name: "开始扫描" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "重新扫描" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "导出 CSV" })).toBeDisabled();
    expect(screen.getByText(status === "error" ? "本轮未发现可验证子域名，公开来源未完整返回，请查看来源状态" : "公开来源本轮未发现子域名，不能据此确认没有子域名")).toBeVisible();
    if (status === "error") expect(screen.getByRole("status", { name: "扫描完成 · 数据不完整" })).toBeVisible();
    else expect(screen.getByRole("status", { name: "扫描完成" })).toBeVisible();
  });

  it("labels a truncated source set as incomplete and shows the verification cap", async () => {
    const user = userEvent.setup();
    vi.mocked(discoverSubdomains).mockImplementation(async (options) => {
      options.onResult({ domain: "www.example.com", status: "resolved", addresses: [], sources: ["crtsh"] });
      return { discovered: 5000, validated: 5000, truncated: true, sources: completedSources() };
    });
    render(<SubdomainScanPage />);
    domainInput();
    await user.click(screen.getByRole("button", { name: "开始扫描" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "重新扫描" })).toBeEnabled());
    expect(screen.getByRole("status", { name: "扫描完成 · 数据不完整" })).toBeVisible();
    expect(screen.getByText("发现数量超过验证上限，本轮仅验证前 5,000 个子域名。")).toBeVisible();
  });

  it("paginates large results while searching and exporting the full set", async () => {
    const user = userEvent.setup();
    vi.mocked(discoverSubdomains).mockImplementation(async (options) => {
      for (let index = 0; index < 101; index += 1) options.onResult({ domain: `host${index}.example.com`, status: "resolved", addresses: [], sources: ["crtsh"] });
      return { discovered: 101, validated: 101, truncated: false, sources: completedSources() };
    });
    render(<SubdomainScanPage />);
    domainInput();
    await user.click(screen.getByRole("button", { name: "开始扫描" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "下一页" })).toBeEnabled());
    let table = within(screen.getByRole("table", { name: "子域名发现结果" }));
    expect(table.getAllByRole("row")).toHaveLength(101);
    expect(table.queryByRole("link", { name: "host100.example.com" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "下一页" }));
    table = within(screen.getByRole("table", { name: "子域名发现结果" }));
    expect(table.getByRole("link", { name: "host100.example.com" })).toBeVisible();
    expect(table.queryByRole("link", { name: "host0.example.com" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "导出 CSV" }));
    expect(vi.mocked(downloadScanCsv).mock.calls[0][1]).toContain("host0.example.com");
    expect(vi.mocked(downloadScanCsv).mock.calls[0][1]).toContain("host100.example.com");
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索子域名发现结果" }), { target: { value: "host0.example.com" } });
    expect(screen.getByRole("link", { name: "host0.example.com" })).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "子域名结果分页" })).not.toBeInTheDocument();
  });
});
