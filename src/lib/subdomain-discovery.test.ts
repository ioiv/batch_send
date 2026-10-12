import { afterEach, describe, expect, it, vi } from "vitest";
import { requestNetworkScan, scanSubdomains } from "./network-scan";
import {
  discoverSubdomains, exportDiscoveredSubdomainsCsv, SUBDOMAIN_DISCOVERY_SOURCES,
  type DiscoveredSubdomainResult
} from "./subdomain-discovery";

vi.mock("./network-scan", async importOriginal => ({
  ...await importOriginal<typeof import("./network-scan")>(), requestNetworkScan: vi.fn(), scanSubdomains: vi.fn()
}));

afterEach(() => vi.resetAllMocks());

function settings() {
  return { domain: "example.com", concurrency: 4, timeoutMs: 5000, signal: new AbortController().signal,
    onSource: vi.fn(), onResult: vi.fn(), onProgress: vi.fn() };
}

function sourcesWithDomains(domains: string[] = []) {
  vi.mocked(requestNetworkScan).mockImplementation(async payload => ({ source: payload.source, status: "success", domains }));
  vi.mocked(scanSubdomains).mockImplementation(async options => {
    for (const domain of options.candidates) options.onResult({ domain, status: "resolved", addresses: ["1.1.1.1"] });
  });
}

describe("multisource subdomain discovery", () => {
  it("queries all sources, merges scoped names and provenance, and verifies actual discovered names", async () => {
    sourcesWithDomains();
    vi.mocked(requestNetworkScan).mockImplementation(async payload => ({ source: payload.source, status: "success",
      domains: payload.source === "crtsh" ? ["unusual-prod-17.api.example.com", "shared.example.com"]
        : payload.source === "website" ? ["shared.example.com", "portal.apac.example.com"] : [] }));
    const options = settings();
    const summary = await discoverSubdomains(options);
    expect(requestNetworkScan).toHaveBeenCalledTimes(6);
    expect(scanSubdomains).toHaveBeenCalledWith(expect.objectContaining({
      candidates: ["portal.apac.example.com", "shared.example.com", "unusual-prod-17.api.example.com"]
    }));
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ domain: "shared.example.com", sources: ["crtsh", "website"] }));
    expect(summary).toMatchObject({ discovered: 3, validated: 3, truncated: false });
    expect(summary.sources.map(source => source.source)).toEqual(SUBDOMAIN_DISCOVERY_SOURCES.map(source => source.id));
    expect(options.onProgress).toHaveBeenLastCalledWith({ phase: "validating", completed: 3, total: 3, discovered: 3 });
  });

  it("preserves historic names even when they no longer resolve", async () => {
    sourcesWithDomains(["old-build-123.example.com"]);
    vi.mocked(scanSubdomains).mockImplementation(async options => {
      options.onResult({ domain: options.candidates[0], status: "not-found", addresses: [] });
    });
    const options = settings();
    await discoverSubdomains(options);
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ status: "not-found", sources: expect.arrayContaining(["crtsh", "wayback"]) }));
  });

  it("follows observed in-scope CNAME names without guessing and stops cycles", async () => {
    sourcesWithDomains();
    vi.mocked(requestNetworkScan).mockImplementation(async payload => ({ source: payload.source, status: "success",
      domains: payload.source === "crtsh" ? ["api.example.com"] : [] }));
    vi.mocked(scanSubdomains).mockImplementation(async options => {
      for (const domain of options.candidates) options.onResult({ domain, status: "resolved", addresses: ["1.1.1.1"],
        cname: domain === "api.example.com" ? "edge.internal.example.com" : "api.example.com" });
    });
    const options = settings();
    expect(await discoverSubdomains(options)).toMatchObject({ discovered: 2, validated: 2 });
    expect(scanSubdomains).toHaveBeenCalledTimes(2);
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ domain: "edge.internal.example.com", sources: ["dns"] }));
    expect(options.onSource).toHaveBeenCalledWith(expect.objectContaining({ source: "dns", domains: ["edge.internal.example.com"] }));
  });

  it("retains partial/error source status and proceeds with available sources", async () => {
    sourcesWithDomains();
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      if (payload.source === "hackertarget") throw new Error("上游来源已限流");
      return { source: payload.source, status: payload.source === "crtsh" ? "partial" : "success",
        domains: payload.source === "crtsh" ? ["api.example.com"] : [], message: payload.source === "crtsh" ? "来源返回部分数据" : undefined };
    });
    const summary = await discoverSubdomains(settings());
    expect(summary.sources.find(source => source.source === "hackertarget")).toMatchObject({ status: "error", message: "上游来源已限流" });
    expect(summary.sources.find(source => source.source === "crtsh")?.status).toBe("partial");
    expect(summary.validated).toBe(1);
  });

  it("distinguishes unavailable sources from a successful empty search", async () => {
    vi.mocked(requestNetworkScan).mockRejectedValue(new Error("来源不可用"));
    const options = settings();
    await expect(discoverSubdomains(options)).rejects.toThrow(/所有发现来源/);
    expect(options.onSource).toHaveBeenCalledTimes(6);
    sourcesWithDomains();
    expect(await discoverSubdomains(settings())).toMatchObject({ discovered: 0, validated: 0 });
    expect(scanSubdomains).not.toHaveBeenCalled();
  });

  it("rejects out-of-scope or malformed provider data without querying their DNS", async () => {
    sourcesWithDomains();
    vi.mocked(requestNetworkScan).mockImplementation(async payload => ({ source: payload.source, status: "success",
      domains: payload.source === "crtsh" ? ["evil-example.com"] : payload.source === "website" ? ["https://api.example.com/"] : [] }));
    const summary = await discoverSubdomains(settings());
    expect(summary.sources.filter(source => source.status === "error")).toHaveLength(2);
    expect(scanSubdomains).not.toHaveBeenCalled();
  });

  it("caps the merged discovery at 5000 and verifies in bounded batches", async () => {
    sourcesWithDomains();
    vi.mocked(requestNetworkScan).mockImplementation(async payload => ({ source: payload.source, status: "success",
      domains: payload.source === "crtsh" ? Array.from({ length: 5000 }, (_, i) => `node${i}.example.com`)
        : payload.source === "website" ? ["overflow.example.com"] : [] }));
    const summary = await discoverSubdomains(settings());
    expect(summary).toMatchObject({ discovered: 5000, validated: 5000, truncated: true });
    expect(scanSubdomains).toHaveBeenCalledTimes(10);
    expect(vi.mocked(scanSubdomains).mock.calls.every(([options]) => options.candidates.length <= 500)).toBe(true);
  });

  it("limits discovery to three source requests and stops without late callbacks", async () => {
    const controller = new AbortController();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      await pending;
      return { source: payload.source, status: "success", domains: ["api.example.com"] };
    });
    const options = { ...settings(), signal: controller.signal };
    const job = discoverSubdomains(options);
    const rejection = expect(job).rejects.toMatchObject({ name: "AbortError" });
    expect(requestNetworkScan).toHaveBeenCalledTimes(3);
    controller.abort();
    release();
    await rejection;
    expect(options.onSource).not.toHaveBeenCalled();
    expect(options.onResult).not.toHaveBeenCalled();
    expect(scanSubdomains).not.toHaveBeenCalled();
  });

  it("stops before beginning another DNS batch after cancellation", async () => {
    sourcesWithDomains(Array.from({ length: 501 }, (_, i) => `node${i}.example.com`));
    const controller = new AbortController();
    vi.mocked(scanSubdomains).mockImplementation(async options => {
      options.onResult({ domain: options.candidates[0], status: "resolved", addresses: [] });
      controller.abort();
    });
    await expect(discoverSubdomains({ ...settings(), signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(scanSubdomains).toHaveBeenCalledTimes(1);
  });

  it("exports discovery provenance with safe CSV fields", () => {
    const result: DiscoveredSubdomainResult = { domain: "api.example.com", sources: ["crtsh", "dns"], status: "resolved", addresses: ["1.1.1.1"], message: "=formula", wildcard: true };
    expect(exportDiscoveredSubdomainsCsv([result])).toContain('"crtsh; dns"');
    expect(exportDiscoveredSubdomainsCsv([result])).toContain('"\'=formula"');
    expect(exportDiscoveredSubdomainsCsv([result])).toContain("discovery_sources");
  });
});
