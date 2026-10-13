import { afterEach, describe, expect, it, vi } from "vitest";
import { createSubdomainValidator, requestNetworkScan, type SubdomainScanResult } from "./network-scan";
import {
  discoverSubdomains, exportDiscoveredSubdomainsCsv, SUBDOMAIN_DISCOVERY_SOURCES,
  type DiscoveredSubdomainResult
} from "./subdomain-discovery";

vi.mock("./network-scan", async importOriginal => ({
  ...await importOriginal<typeof import("./network-scan")>(), requestNetworkScan: vi.fn(), createSubdomainValidator: vi.fn()
}));

afterEach(() => vi.resetAllMocks());

const validateCandidate = vi.fn<(domain: string, signal: AbortSignal) => Promise<SubdomainScanResult>>();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function settings() {
  return { domain: "example.com", concurrency: 4, timeoutMs: 5000, signal: new AbortController().signal,
    onSource: vi.fn(), onResult: vi.fn(), onProgress: vi.fn() };
}

function sourcesWithDomains(domains: string[] = []) {
  vi.mocked(requestNetworkScan).mockImplementation(async payload => ({ source: payload.source, status: "success", domains }));
  validateCandidate.mockImplementation(async domain => ({ domain, status: "resolved", addresses: ["1.1.1.1"] }));
  vi.mocked(createSubdomainValidator).mockResolvedValue(validateCandidate);
}

describe("multisource subdomain discovery", () => {
  it("includes Pentest-Tools and CertKit alongside the public automatic providers", () => {
    expect(SUBDOMAIN_DISCOVERY_SOURCES.map(source => source.id)).not.toContain("crtsh");
    expect(SUBDOMAIN_DISCOVERY_SOURCES.map(source => source.id)).not.toContain("wayback");
    expect(SUBDOMAIN_DISCOVERY_SOURCES.map(source => source.id)).toEqual(expect.arrayContaining(["subdomaincenter", "anubis", "pentesttools", "certkit"]));
    expect(SUBDOMAIN_DISCOVERY_SOURCES).toHaveLength(9);
  });

  it("automatically requests Pentest-Tools and merges its names into DNS validation and provenance", async () => {
    sourcesWithDomains();
    vi.mocked(requestNetworkScan).mockImplementation(async payload => ({ source: payload.source, status: "success",
      domains: payload.source === "subdomaincenter" ? ["shared.example.com"]
        : payload.source === "pentesttools" ? ["shared.example.com", "pentest-only.example.com"] : [] }));
    const options = settings();
    const summary = await discoverSubdomains(options);

    expect(requestNetworkScan).toHaveBeenCalledWith({ kind: "subdomain-discovery", domain: "example.com", source: "pentesttools", timeoutMs: 120_000 }, expect.any(AbortSignal));
    expect(requestNetworkScan).toHaveBeenCalledWith({ kind: "subdomain-discovery", domain: "example.com", source: "subdomaincenter", timeoutMs: 20_000 }, expect.any(AbortSignal));
    expect(validateCandidate.mock.calls.map(([domain]) => domain).sort()).toEqual(["pentest-only.example.com", "shared.example.com"]);
    expect(options.onSource).toHaveBeenCalledWith({ source: "pentesttools", status: "success", domains: ["shared.example.com", "pentest-only.example.com"] });
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ domain: "shared.example.com", sources: ["subdomaincenter", "pentesttools"] }));
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ domain: "pentest-only.example.com", sources: ["pentesttools"] }));
    expect(summary).toMatchObject({ discovered: 2, validated: 2, truncated: false });
    expect(exportDiscoveredSubdomainsCsv(options.onResult.mock.calls.map(([result]) => result))).toContain("pentesttools");
  });

  it("automatically requests CertKit with a 20-second timeout and deduplicates certificate names across sources", async () => {
    sourcesWithDomains();
    vi.mocked(requestNetworkScan).mockImplementation(async payload => ({ source: payload.source, status: "success",
      domains: payload.source === "subdomaincenter" ? ["shared.example.com"]
        : payload.source === "certkit" ? ["shared.example.com", "ct-only.example.com", "ct-only.example.com"] : [] }));
    const options = settings();
    const summary = await discoverSubdomains(options);

    expect(requestNetworkScan).toHaveBeenCalledWith({ kind: "subdomain-discovery", domain: "example.com", source: "certkit", timeoutMs: 20_000 }, expect.any(AbortSignal));
    expect(validateCandidate.mock.calls.map(([domain]) => domain).sort()).toEqual(["ct-only.example.com", "shared.example.com"]);
    expect(options.onSource).toHaveBeenCalledWith({ source: "certkit", status: "success", domains: ["shared.example.com", "ct-only.example.com"] });
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ domain: "shared.example.com", sources: ["subdomaincenter", "certkit"] }));
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ domain: "ct-only.example.com", sources: ["certkit"] }));
    expect(summary).toMatchObject({ discovered: 2, validated: 2, truncated: false });
    expect(summary.sources.map(source => source.source)).toContain("certkit");
    const csv = exportDiscoveredSubdomainsCsv(options.onResult.mock.calls.map(([result]) => result));
    expect(csv).toContain('"subdomaincenter; certkit"');
    expect(csv).toContain('"certkit"');
  });

  it("retains CertKit failure details while validating names returned by other sources", async () => {
    sourcesWithDomains();
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      if (payload.source === "certkit") throw new Error("CertKit 来源暂不可用");
      return { source: payload.source, status: "success", domains: payload.source === "subdomaincenter" ? ["api.example.com"] : [] };
    });
    const options = settings();
    const summary = await discoverSubdomains(options);
    expect(summary).toMatchObject({ discovered: 1, validated: 1 });
    expect(summary.sources.find(source => source.source === "certkit")).toEqual({ source: "certkit", status: "error", domains: [], message: "CertKit 来源暂不可用" });
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ domain: "api.example.com", sources: ["subdomaincenter"] }));
  });

  it("validates supplemental names while providers are pending and merges later provenance without repeating DNS", async () => {
    sourcesWithDomains();
    const providers = deferred<void>();
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      await providers.promise;
      return { source: payload.source, status: "success", domains: payload.source === "subdomaincenter" ? ["api.example.com"] : [] };
    });
    const options = { ...settings(), additionalDomains: ["api.example.com", "api.example.com"] };
    const pending = discoverSubdomains(options);
    await vi.waitFor(() => expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ domain: "api.example.com", sources: ["manual"] })));
    expect(options.onSource).toHaveBeenCalledWith({ source: "manual", status: "success", domains: ["api.example.com"] });
    providers.resolve();
    expect(await pending).toMatchObject({ discovered: 1, validated: 1 });
    expect(options.onResult).toHaveBeenLastCalledWith(expect.objectContaining({ domain: "api.example.com", sources: ["subdomaincenter", "manual"] }));
    expect(validateCandidate).toHaveBeenCalledTimes(1);
    expect(requestNetworkScan).toHaveBeenCalledTimes(SUBDOMAIN_DISCOVERY_SOURCES.length);
    expect(requestNetworkScan).not.toHaveBeenCalledWith(expect.objectContaining({ source: "manual" }), expect.anything());
  });

  it.each([["other.org"], ["example.com"], ["*.example.com"], ["https://api.example.com/"], ["api.example.com.evil.org"]])("rejects out-of-scope supplemental names before starting requests: %j", async additionalDomains => {
    const values = Array.isArray(additionalDomains) ? additionalDomains : [additionalDomains];
    await expect(discoverSubdomains({ ...settings(), additionalDomains: values })).rejects.toThrow();
    expect(requestNetworkScan).not.toHaveBeenCalled();
    expect(createSubdomainValidator).not.toHaveBeenCalled();
  });

  it("queries all sources, merges scoped names and provenance, and verifies actual discovered names", async () => {
    sourcesWithDomains();
    vi.mocked(requestNetworkScan).mockImplementation(async payload => ({ source: payload.source, status: "success",
      domains: payload.source === "subdomaincenter" ? ["unusual-prod-17.api.example.com", "shared.example.com"]
        : payload.source === "website" ? ["shared.example.com", "portal.apac.example.com"] : [] }));
    const options = settings();
    const summary = await discoverSubdomains(options);
    expect(requestNetworkScan).toHaveBeenCalledTimes(SUBDOMAIN_DISCOVERY_SOURCES.length);
    expect(validateCandidate.mock.calls.map(([domain]) => domain).sort())
      .toEqual(["portal.apac.example.com", "shared.example.com", "unusual-prod-17.api.example.com"]);
    expect(createSubdomainValidator).toHaveBeenCalledTimes(1);
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ domain: "shared.example.com", sources: ["subdomaincenter", "website"] }));
    expect(summary).toMatchObject({ discovered: 3, validated: 3, truncated: false });
    expect(summary.sources.map(source => source.source)).toEqual(SUBDOMAIN_DISCOVERY_SOURCES.map(source => source.id));
    expect(options.onProgress).toHaveBeenLastCalledWith({ phase: "validating", completed: 3, total: 3, discovered: 3, discoveryCompleted: SUBDOMAIN_DISCOVERY_SOURCES.length, discoveryTotal: SUBDOMAIN_DISCOVERY_SOURCES.length });
  });

  it("emits DNS results while a later provider is pending and updates provenance without querying twice", async () => {
    sourcesWithDomains();
    const website = deferred<string[]>();
    vi.mocked(requestNetworkScan).mockImplementation(async payload => ({ source: payload.source, status: "success",
      domains: payload.source === "subdomaincenter" ? ["api.example.com"] : payload.source === "website" ? await website.promise : [] }));
    const options = settings();
    const job = discoverSubdomains(options);

    await vi.waitFor(() => expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ domain: "api.example.com", sources: ["subdomaincenter"] })));
    expect(options.onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: "discovering", completed: 1, total: 1, discovered: 1 }));
    expect(options.onSource).not.toHaveBeenCalledWith(expect.objectContaining({ source: "website" }));
    website.resolve(["api.example.com", "portal.example.com"]);

    expect(await job).toMatchObject({ discovered: 2, validated: 2 });
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ domain: "api.example.com", sources: ["subdomaincenter", "website"] }));
    expect(validateCandidate.mock.calls.map(([domain]) => domain)).toEqual(["api.example.com", "portal.example.com"]);
    expect(createSubdomainValidator).toHaveBeenCalledTimes(1);
    expect(options.onProgress.mock.calls.every(([progress]) => progress.completed <= progress.total)).toBe(true);
    expect(options.onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "validating", completed: 2, total: 2, discoveryCompleted: SUBDOMAIN_DISCOVERY_SOURCES.length }));
  });

  it("reserves API capacity for providers and expands DNS concurrency after discovery closes", async () => {
    sourcesWithDomains();
    const providers = deferred<void>();
    const dns = deferred<void>();
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      if (payload.source !== "common") await providers.promise;
      return { source: payload.source, status: "success", domains: payload.source === "common"
        ? Array.from({ length: 12 }, (_, index) => `node${index}.example.com`) : [] };
    });
    let active = 0;
    let peak = 0;
    validateCandidate.mockImplementation(async domain => {
      active += 1;
      peak = Math.max(peak, active);
      try { await dns.promise; return { domain, status: "resolved", addresses: [] }; }
      finally { active -= 1; }
    });
    const job = discoverSubdomains({ ...settings(), concurrency: 8 });
    await vi.waitFor(() => expect(validateCandidate).toHaveBeenCalledTimes(5));
    expect(active).toBe(5);
    providers.resolve();
    await vi.waitFor(() => expect(validateCandidate).toHaveBeenCalledTimes(8));
    expect(active).toBe(8);
    dns.resolve();
    expect(await job).toMatchObject({ discovered: 12, validated: 12 });
    expect(peak).toBe(8);
    expect(createSubdomainValidator).toHaveBeenCalledTimes(1);
  });

  it("preserves historic names even when they no longer resolve", async () => {
    sourcesWithDomains(["old-build-123.example.com"]);
    validateCandidate.mockImplementation(async domain => ({ domain, status: "not-found", addresses: [] }));
    const options = settings();
    await discoverSubdomains(options);
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ status: "not-found", sources: expect.arrayContaining(["subdomaincenter", "anubis"]) }));
  });

  it("follows observed in-scope CNAME names without guessing and stops cycles", async () => {
    sourcesWithDomains();
    vi.mocked(requestNetworkScan).mockImplementation(async payload => ({ source: payload.source, status: "success",
      domains: payload.source === "subdomaincenter" ? ["api.example.com"] : [] }));
    validateCandidate.mockImplementation(async domain => ({ domain, status: "resolved", addresses: ["1.1.1.1"],
      cname: domain === "api.example.com" ? "edge.internal.example.com" : "api.example.com" }));
    const options = settings();
    expect(await discoverSubdomains(options)).toMatchObject({ discovered: 2, validated: 2 });
    expect(validateCandidate).toHaveBeenCalledTimes(2);
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ domain: "edge.internal.example.com", sources: ["dns"] }));
    expect(options.onSource).toHaveBeenCalledWith(expect.objectContaining({ source: "dns", domains: ["edge.internal.example.com"] }));
  });

  it("verifies CNAME discoveries before DNS metadata arrives and merges its eventual failure", async () => {
    sourcesWithDomains();
    const dnsMetadata = deferred<void>();
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      if (payload.source === "dns") {
        await dnsMetadata.promise;
        return { source: payload.source, status: "error", domains: [], message: "根域名 DNS 不可用" };
      }
      return { source: payload.source, status: "success", domains: payload.source === "subdomaincenter" ? ["api.example.com"] : [] };
    });
    validateCandidate.mockImplementation(async domain => ({ domain, status: "resolved", addresses: [],
      cname: domain === "api.example.com" ? "edge.internal.example.com" : "api.example.com" }));
    const options = settings();
    const job = discoverSubdomains(options);
    await vi.waitFor(() => expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ domain: "edge.internal.example.com", sources: ["dns"] })));
    expect(options.onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: "discovering", completed: 2, total: 2 }));
    dnsMetadata.resolve();
    const summary = await job;

    expect(summary).toMatchObject({ discovered: 2, validated: 2 });
    expect(validateCandidate).toHaveBeenCalledTimes(2);
    expect(summary.sources.find(source => source.source === "dns")).toMatchObject({ status: "partial",
      domains: expect.arrayContaining(["api.example.com", "edge.internal.example.com"]), message: expect.stringContaining("CNAME") });
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ domain: "api.example.com", sources: ["subdomaincenter", "dns"] }));
  });

  it.each(["api.example.com", "external.example.org", "https://edge.example.com", "root..example.com"])("does not expand self, external or invalid CNAME %s", async cname => {
    sourcesWithDomains(["api.example.com"]);
    validateCandidate.mockImplementation(async domain => ({ domain, status: "resolved", addresses: [], cname }));
    expect(await discoverSubdomains(settings())).toMatchObject({ discovered: 1, validated: 1 });
    expect(validateCandidate).toHaveBeenCalledTimes(1);
  });

  it("retains partial/error source status and proceeds with available sources", async () => {
    sourcesWithDomains();
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      if (payload.source === "hackertarget") throw new Error("上游来源已限流");
      return { source: payload.source, status: payload.source === "subdomaincenter" ? "partial" : "success",
        domains: payload.source === "subdomaincenter" ? ["api.example.com"] : [], message: payload.source === "subdomaincenter" ? "来源返回部分数据" : undefined };
    });
    const summary = await discoverSubdomains(settings());
    expect(summary.sources.find(source => source.source === "hackertarget")).toMatchObject({ status: "error", message: "上游来源已限流" });
    expect(summary.sources.find(source => source.source === "subdomaincenter")?.status).toBe("partial");
    expect(summary.validated).toBe(1);
  });

  it("distinguishes unavailable sources from a successful empty search", async () => {
    vi.mocked(requestNetworkScan).mockRejectedValue(new Error("来源不可用"));
    const options = settings();
    await expect(discoverSubdomains(options)).rejects.toThrow(/所有发现来源/);
    expect(options.onSource).toHaveBeenCalledTimes(SUBDOMAIN_DISCOVERY_SOURCES.length);
    sourcesWithDomains();
    expect(await discoverSubdomains(settings())).toMatchObject({ discovered: 0, validated: 0 });
    expect(createSubdomainValidator).not.toHaveBeenCalled();
  });

  it("rejects out-of-scope or malformed provider data without querying their DNS", async () => {
    sourcesWithDomains();
    vi.mocked(requestNetworkScan).mockImplementation(async payload => ({ source: payload.source, status: "success",
      domains: payload.source === "subdomaincenter" ? ["evil-example.com"] : payload.source === "website" ? ["https://api.example.com/"] : [] }));
    const summary = await discoverSubdomains(settings());
    expect(summary.sources.filter(source => source.status === "error")).toHaveLength(2);
    expect(createSubdomainValidator).not.toHaveBeenCalled();
  });

  it("caps the merged discovery at 5000 and verifies each included name once", async () => {
    sourcesWithDomains();
    vi.mocked(requestNetworkScan).mockImplementation(async payload => ({ source: payload.source, status: "success",
      domains: payload.source === "subdomaincenter" ? Array.from({ length: 5000 }, (_, i) => `node${i}.example.com`)
        : payload.source === "website" ? ["overflow.example.com"] : [] }));
    const summary = await discoverSubdomains(settings());
    expect(summary).toMatchObject({ discovered: 5000, validated: 5000, truncated: true });
    expect(validateCandidate).toHaveBeenCalledTimes(5000);
    expect(new Set(validateCandidate.mock.calls.map(([domain]) => domain)).size).toBe(5000);
    expect(validateCandidate).not.toHaveBeenCalledWith("overflow.example.com", expect.anything());
  });

  it("counts CNAME additions against the same 5000-name cap", async () => {
    sourcesWithDomains(Array.from({ length: 5000 }, (_, index) => `node${index}.example.com`));
    validateCandidate.mockImplementation(async domain => ({ domain, status: "resolved", addresses: [],
      ...(domain === "node0.example.com" ? { cname: "overflow.example.com" } : {}) }));
    expect(await discoverSubdomains(settings())).toMatchObject({ discovered: 5000, validated: 5000, truncated: true });
    expect(validateCandidate).toHaveBeenCalledTimes(5000);
    expect(validateCandidate).not.toHaveBeenCalledWith("overflow.example.com", expect.anything());
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
    expect(createSubdomainValidator).not.toHaveBeenCalled();
  });

  it("stops before beginning another queued DNS query after cancellation", async () => {
    sourcesWithDomains(Array.from({ length: 501 }, (_, i) => `node${i}.example.com`));
    const controller = new AbortController();
    validateCandidate.mockImplementation(async domain => {
      controller.abort();
      return { domain, status: "resolved", addresses: [] };
    });
    await expect(discoverSubdomains({ ...settings(), concurrency: 1, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(validateCandidate).toHaveBeenCalledTimes(1);
  });

  it("keeps emitted results and suppresses pending provider and DNS callbacks after cancellation", async () => {
    sourcesWithDomains();
    const controller = new AbortController();
    const website = deferred<string[]>();
    const secondDns = deferred<SubdomainScanResult>();
    vi.mocked(requestNetworkScan).mockImplementation(async payload => ({ source: payload.source, status: "success",
      domains: payload.source === "subdomaincenter" ? ["api.example.com", "pending.example.com"] : payload.source === "website" ? await website.promise : [] }));
    validateCandidate.mockImplementation(async domain => domain === "pending.example.com" ? await secondDns.promise
      : { domain, status: "resolved", addresses: [] });
    const options = { ...settings(), signal: controller.signal };
    const job = discoverSubdomains(options);
    const rejection = expect(job).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(options.onResult).toHaveBeenCalledTimes(1));
    const callbacks = [options.onSource.mock.calls.length, options.onResult.mock.calls.length, options.onProgress.mock.calls.length];
    controller.abort();
    website.resolve(["late.example.com"]);
    secondDns.resolve({ domain: "pending.example.com", status: "resolved", addresses: [], cname: "late-cname.example.com" });
    await rejection;

    expect([options.onSource.mock.calls.length, options.onResult.mock.calls.length, options.onProgress.mock.calls.length]).toEqual(callbacks);
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ domain: "api.example.com" }));
    expect(validateCandidate).toHaveBeenCalledTimes(2);
  });

  it("stops pending discovery when validator initialization fails", async () => {
    sourcesWithDomains();
    vi.mocked(requestNetworkScan).mockImplementation(async (payload, signal) => {
      if (payload.source === "website") await new Promise<void>((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return { source: payload.source, status: "success", domains: payload.source === "subdomaincenter" ? ["api.example.com"] : [] };
    });
    vi.mocked(createSubdomainValidator).mockRejectedValue(new Error("通配 DNS 基线无法读取"));
    const options = settings();
    await expect(discoverSubdomains(options)).rejects.toThrow("通配 DNS 基线无法读取");
    expect(createSubdomainValidator).toHaveBeenCalledTimes(1);
    expect(validateCandidate).not.toHaveBeenCalled();
    expect(options.onResult).not.toHaveBeenCalled();
  });

  it("exports discovery provenance with safe CSV fields", () => {
    const result: DiscoveredSubdomainResult = { domain: "api.example.com", sources: ["subdomaincenter", "dns"], status: "resolved", addresses: ["1.1.1.1"], message: "=formula", wildcard: true };
    expect(exportDiscoveredSubdomainsCsv([result])).toContain('"subdomaincenter; dns"');
    expect(exportDiscoveredSubdomainsCsv([result])).toContain('"\'=formula"');
    expect(exportDiscoveredSubdomainsCsv([result])).toContain("discovery_sources");
  });
});
