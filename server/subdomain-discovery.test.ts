import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMON_SUBDOMAIN_LABELS, discoverSubdomains, MAX_DISCOVERY_DOMAINS, type SubdomainDiscoveryDependencies } from "./subdomain-discovery";
import type { PublicDocumentResult, SubdomainScanResult } from "./network-scan";

function document(body: unknown, overrides: Partial<PublicDocumentResult> = {}): PublicDocumentResult {
  return { url: "https://provider.invalid/", statusCode: 200, body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)), truncated: false, ...overrides };
}

function dependencies(fetcher: (url: URL, call: number, signal?: AbortSignal) => PublicDocumentResult | Promise<PublicDocumentResult>) {
  let count = 0;
  const fetchDocument = vi.fn((url: string, options: Parameters<SubdomainDiscoveryDependencies["fetchDocument"]>[1]) => {
    count += 1;
    expect(options.maxBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(options.timeoutMs).toBeLessThanOrEqual(20000);
    return Promise.resolve(fetcher(new URL(url), count, options.signal));
  });
  const adapter: SubdomainDiscoveryDependencies = { fetchDocument };
  return { adapter, fetchDocument };
}

beforeEach(() => { vi.stubEnv("SSLMATE_API_KEY", ""); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("certificate transparency discovery", () => {
  it("authenticates every CertSpotter page using only the fixed HTTPS endpoint", async () => {
    const provider = dependencies((_url, call) => document(call === 1 ? [{ id: "1", dns_names: ["api.example.com"] }] : []));
    const key = "fake-sslmate-token";
    const result = await discoverSubdomains("example.com", "certspotter", 1000, provider.adapter, undefined, { sslmateApiKey: key });
    expect(result).toMatchObject({ status: "success", domains: ["api.example.com"], message: "已通过 SSLMate 认证查询" });
    expect(provider.fetchDocument).toHaveBeenCalledTimes(2);
    for (const [url, options] of provider.fetchDocument.mock.calls) {
      expect(new URL(url).origin + new URL(url).pathname).toBe("https://api.certspotter.com/v1/issuances");
      expect(options.headers).toEqual({ Authorization: `Bearer ${key}` });
      expect(url).not.toContain(key);
    }
    expect(JSON.stringify(result)).not.toContain(key);
  });

  it("reads the server environment for the serverless entry point and keeps anonymous mode without a key", async () => {
    vi.stubEnv("SSLMATE_API_KEY", "fake-environment-token");
    const authenticated = dependencies(() => document([]));
    await discoverSubdomains("example.com", "certspotter", 1000, authenticated.adapter);
    expect(authenticated.fetchDocument.mock.calls[0][1].headers).toEqual({ Authorization: "Bearer fake-environment-token" });
    vi.stubEnv("SSLMATE_API_KEY", "");
    const anonymous = dependencies(() => document([]));
    expect(await discoverSubdomains("example.com", "certspotter", 1000, anonymous.adapter)).toEqual({ source: "certspotter", status: "success", domains: [] });
    expect(anonymous.fetchDocument.mock.calls[0][1].headers).toBeUndefined();
  });

  it("never sends the credential to other providers", async () => {
    for (const source of ["subdomaincenter", "hackertarget", "certkit"] as const) {
      const provider = dependencies(() => document([]));
      await discoverSubdomains("example.com", source, 1000, provider.adapter, undefined, { sslmateApiKey: "fake-sslmate-token" });
      expect(provider.fetchDocument).toHaveBeenCalled();
      for (const [, options] of provider.fetchDocument.mock.calls) {
        expect(options.headers?.Authorization).toBeUndefined();
        expect(options.headers?.Cookie).toBeUndefined();
        if (source !== "certkit") expect(options.headers).toBeUndefined();
      }
    }
  });

  it.each([
    [401, "bad_credentials", "Key 无效"],
    [403, "disabled_credentials", "Key 已停用"],
    [403, "unauthorized", "CT Search 权限"],
    [403, "not_allowed_by_plan", "账户或 Key 无权"],
    [402, "payment_required", "订阅不可用"],
    [429, "rate_limited", "配额或速率"],
    [503, "timeout", "套餐时限"]
  ])("explains SSLMate error %s / %s without exposing or retrying provider details", async (statusCode, code, message) => {
    const key = "fake-sensitive-token";
    const provider = dependencies(() => document({ code, message: `upstream echoes ${key}` }, { statusCode }));
    const result = await discoverSubdomains("example.com", "certspotter", 1000, provider.adapter, undefined, { sslmateApiKey: key });
    expect(result.status).toBe("error");
    expect(result.message).toContain(message);
    expect(JSON.stringify(result)).not.toContain(key);
    expect(provider.fetchDocument).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed local credentials before sending a request", async () => {
    const provider = dependencies(() => document([]));
    const result = await discoverSubdomains("example.com", "certspotter", 1000, provider.adapter, undefined, { sslmateApiKey: "fake-token\r\nInjected: value" });
    expect(result).toMatchObject({ status: "error", message: "SSLMate Key 格式无效，请检查服务端配置" });
    expect(provider.fetchDocument).not.toHaveBeenCalled();
  });

  it.each(["subdomaincenter"] as const)("reads %s concrete names without credentials, deduplicates and scopes results", async source => {
    const provider = dependencies(url => {
      expect(url.origin + url.pathname).toBe("https://api.subdomain.center/");
      expect(url.searchParams.get("domain")).toBe("example.com");
      expect(url.searchParams.has("crawl")).toBe(false);
      return document(["api.example.com", "API.Example.COM.", "*.example.com", "example.com", "cdn.example.com", "api.example.com.evil.com"]);
    });
    const result = await discoverSubdomains("Example.COM", source, 1000, provider.adapter);
    expect(result).toMatchObject({ source, status: "partial", domains: ["api.example.com", "cdn.example.com"] });
    expect(provider.fetchDocument).toHaveBeenCalledTimes(1);
    expect(provider.fetchDocument.mock.calls[0][1].headers).toBeUndefined();
  });

  it.each(["subdomaincenter"] as const)("reports an empty %s index as successfully read, rather than unavailable", async source => {
    const provider = dependencies(() => document([]));
    const result = await discoverSubdomains("stonkrobbers.io", source, 1000, provider.adapter);
    expect(result).toMatchObject({ source, status: "success", domains: [] });
    expect(result.message).toContain("暂无此域名的收录");
  });

  it.each(["subdomaincenter"] as const)("rejects %s malformed JSON structures", async source => {
    for (const body of [{ domains: ["api.example.com"] }, [42], "<html>blocked</html>"]) {
      const provider = dependencies(() => document(body));
      expect((await discoverSubdomains("example.com", source, 1000, provider.adapter)).status).toBe("error");
    }
  });

  it("marks Subdomain Center's anonymous sample limit without trying paid pagination", async () => {
    const provider = dependencies(() => document(Array.from({ length: 500 }, (_, index) => `host-${index}.example.com`)));
    const result = await discoverSubdomains("example.com", "subdomaincenter", 1000, provider.adapter);
    expect(result).toMatchObject({ status: "partial" });
    expect(result.domains).toHaveLength(500);
    expect(result.message).toContain("免费抽样上限");
    expect(provider.fetchDocument).toHaveBeenCalledTimes(1);
  });

  it.each(["subdomaincenter"] as const)("recovers only complete names from a bounded %s response", async source => {
    const provider = dependencies(() => document('["api.example.com","cdn.example.com","incomplete', { truncated: true }));
    expect(await discoverSubdomains("example.com", source, 1000, provider.adapter)).toMatchObject({ status: "partial", domains: ["api.example.com", "cdn.example.com"] });
  });

  it("caps indexed candidates at 5000 unique scoped names and reports partial", async () => {
    const provider = dependencies(() => document(Array.from({ length: MAX_DISCOVERY_DOMAINS + 10 }, (_, index) => `observed-${index}.example.com`)));
    const result = await discoverSubdomains("example.com", "subdomaincenter", 1000, provider.adapter);
    expect(result.status).toBe("partial");
    expect(result.domains).toHaveLength(MAX_DISCOVERY_DOMAINS);
    expect(result.message).toContain("5000");
  });

  it("paginates CertSpotter with the opaque last ID until an empty page", async () => {
    const provider = dependencies((url, call) => {
      expect(url.origin + url.pathname).toBe("https://api.certspotter.com/v1/issuances");
      expect(url.searchParams.get("domain")).toBe("example.com");
      expect(url.searchParams.get("include_subdomains")).toBe("true");
      expect(url.searchParams.get("expand")).toBe("dns_names");
      if (call === 1) { expect(url.searchParams.has("after")).toBe(false); return document([{ id: "opaque+a/b", dns_names: ["api.example.com", "*.example.com", "evil.com"] }]); }
      expect(url.searchParams.get("after")).toBe("opaque+a/b");
      return document([]);
    });
    expect(await discoverSubdomains("example.com", "certspotter", 1000, provider.adapter)).toMatchObject({ source: "certspotter", status: "partial", domains: ["api.example.com"] });
    expect(provider.fetchDocument).toHaveBeenCalledTimes(2);
  });

  it("marks CertSpotter repeated cursors and page caps as partial", async () => {
    const repeated = dependencies(() => document([{ id: "same", dns_names: ["api.example.com"] }]));
    expect((await discoverSubdomains("example.com", "certspotter", 1000, repeated.adapter)).status).toBe("partial");
    expect(repeated.fetchDocument).toHaveBeenCalledTimes(2);
    const capped = dependencies((_url, call) => document([{ id: String(call), dns_names: [`api${call}.example.com`] }]));
    expect((await discoverSubdomains("example.com", "certspotter", 1000, capped.adapter)).status).toBe("partial");
    expect(capped.fetchDocument).toHaveBeenCalledTimes(8);
  });

  it("preserves earlier CertSpotter results when a later page is rate limited", async () => {
    const provider = dependencies((_url, call) => call === 1 ? document([{ id: "1", dns_names: ["api.example.com"] }]) : document({ error: "secret upstream detail" }, { statusCode: 429 }));
    const result = await discoverSubdomains("example.com", "certspotter", 1000, provider.adapter);
    expect(result).toMatchObject({ status: "partial", domains: ["api.example.com"] });
    expect(result.message).toContain("限流");
    expect(result.message).not.toContain("secret");
  });

  it("explains why a wildcard-only certificate cannot enumerate concrete hosts", async () => {
    const provider = dependencies((_url, call) => document(call === 1 ? [{ id: "1", dns_names: ["*.stonkrobbers.io", "stonkrobbers.io"] }] : []));
    expect(await discoverSubdomains("stonkrobbers.io", "certspotter", 1000, provider.adapter)).toMatchObject({
      status: "partial", domains: [], message: "证书仅公开通配名称，无法从证书列出具体子域名"
    });
  });
});

describe("passive host and indexed sources", () => {
  it("parses HackerTarget hostsearch without inventing names or accepting other domains", async () => {
    const provider = dependencies((url) => { expect(url.origin + url.pathname).toBe("https://api.hackertarget.com/hostsearch/"); expect(url.searchParams.get("q")).toBe("example.com"); return document("api.example.com,8.8.8.8\napi.example.com,1.1.1.1\nexample.com,8.8.8.8\nevil.com,8.8.8.8\n"); });
    expect(await discoverSubdomains("example.com", "hackertarget", 1000, provider.adapter)).toEqual({ source: "hackertarget", status: "success", domains: ["api.example.com"] });
  });

  it("reports HackerTarget's 50-line free limit and textual quota errors", async () => {
    const provider = dependencies(() => document(Array.from({ length: 50 }, (_, index) => `api${index}.example.com,8.8.8.8`).join("\n")));
    expect((await discoverSubdomains("example.com", "hackertarget", 1000, provider.adapter)).status).toBe("partial");
    const quota = dependencies(() => document("API count exceeded - Increase Quota with Membership"));
    expect(await discoverSubdomains("example.com", "hackertarget", 1000, quota.adapter)).toMatchObject({ status: "error", domains: [] });
  });

  it("rejects comma-containing provider errors and preserves valid bounded CSV lines", async () => {
    const quota = dependencies(() => document("error,quota exceeded"));
    expect((await discoverSubdomains("example.com", "hackertarget", 1000, quota.adapter)).status).toBe("error");
    const partial = dependencies(() => document("api.example.com,8.8.8.8\nerror,quota exceeded\ncdn.example.com,1.1.1.1\n"));
    expect(await discoverSubdomains("example.com", "hackertarget", 1000, partial.adapter)).toMatchObject({ status: "partial", domains: ["api.example.com", "cdn.example.com"] });
    const truncated = dependencies(() => document("api.example.com,8.8.8.8\ncdn.example.com,1.1", { truncated: true }));
    expect(await discoverSubdomains("example.com", "hackertarget", 1000, truncated.adapter)).toMatchObject({ status: "partial", domains: ["api.example.com"] });
  });

  it("rejects malformed provider responses and redirects without following them", async () => {
    for (const source of ["subdomaincenter", "certspotter", "certkit"] as const) {
      const malformed = dependencies(() => document("<html>provider blocked</html>"));
      expect((await discoverSubdomains("example.com", source, 1000, malformed.adapter)).status).toBe("error");
      const redirect = dependencies(() => document("", { statusCode: 302, location: "http://127.0.0.1/" }));
      expect((await discoverSubdomains("example.com", source, 1000, redirect.adapter)).status).toBe("error");
      expect(redirect.fetchDocument).toHaveBeenCalledTimes(1);
    }
  });
});

describe("bounded common-name DNS discovery", () => {
  function commonProvider(answer: (domain: string) => SubdomainScanResult | Promise<SubdomainScanResult>) {
    const provider = dependencies(() => { throw new Error("DNS discovery must never perform HTTP"); });
    const scanDomain = vi.fn(async (domain: string, timeoutMs: number, signal: AbortSignal) => {
      expect(timeoutMs).toBeLessThanOrEqual(2000);
      expect(signal.aborted).toBe(false);
      return answer(domain);
    });
    provider.adapter.scanDomain = scanDomain;
    return { ...provider, scanDomain };
  }
  const missing = (domain: string): SubdomainScanResult => ({ domain, status: "not-found", addresses: [] });
  const resolved = (domain: string, addresses = ["1.1.1.1"], cname?: string): SubdomainScanResult => ({ domain, status: "resolved", addresses, ...(cname ? { cname } : {}) });

  it("finds API and docs omitted by wildcard certificates without counting unresolved guesses", async () => {
    const provider = commonProvider(domain => ["api.stonkrobbers.io", "docs.stonkrobbers.io"].includes(domain) ? resolved(domain) : missing(domain));
    expect(await discoverSubdomains("stonkrobbers.io", "common", 20000, provider.adapter)).toEqual({
      source: "common", status: "success", domains: ["api.stonkrobbers.io", "docs.stonkrobbers.io"]
    });
    expect(provider.scanDomain).toHaveBeenCalledTimes(COMMON_SUBDOMAIN_LABELS.length + 2);
    expect(provider.fetchDocument).not.toHaveBeenCalled();
    const controls = provider.scanDomain.mock.calls.slice(0, 2).map(([domain]) => domain);
    expect(new Set(controls).size).toBe(2);
    expect(controls.every(domain => /^chainkit-check-[a-f0-9]{32}\.stonkrobbers\.io$/.test(domain))).toBe(true);
  });

  it("filters catch-all DNS and admits an independently named CNAME result", async () => {
    const provider = commonProvider(domain => domain === "api.example.com" ? resolved(domain, ["1.1.1.1"], "named.provider.com") : resolved(domain, ["1.1.1.1"], "wildcard.provider.com"));
    expect(await discoverSubdomains("example.com", "common", 20000, provider.adapter)).toMatchObject({
      status: "partial", domains: ["api.example.com"], message: expect.stringContaining("通配 DNS")
    });
  });

  it("does not invent hosts from rotating address-only wildcard answers", async () => {
    let control = 0;
    const provider = commonProvider(domain => resolved(domain, domain.startsWith("chainkit-check-") ? [++control === 1 ? "1.1.1.1" : "8.8.8.8"] : ["9.9.9.9"]));
    expect(await discoverSubdomains("example.com", "common", 20000, provider.adapter)).toMatchObject({ status: "partial", domains: [] });
    expect(provider.scanDomain).toHaveBeenCalledTimes(2);
  });

  it("rejects unstable wildcard CNAME controls and a single resolving control before guessing", async () => {
    let control = 0;
    const rotating = commonProvider(domain => resolved(domain, ["1.1.1.1"], `dynamic-${++control}.provider.com`));
    expect(await discoverSubdomains("example.com", "common", 20000, rotating.adapter)).toMatchObject({ status: "partial", domains: [], message: expect.stringContaining("不稳定") });
    expect(rotating.scanDomain).toHaveBeenCalledTimes(2);
    control = 0;
    const intermittent = commonProvider(domain => ++control === 1 ? resolved(domain) : missing(domain));
    expect(await discoverSubdomains("example.com", "common", 20000, intermittent.adapter)).toMatchObject({ status: "partial", domains: [] });
    expect(intermittent.scanDomain).toHaveBeenCalledTimes(2);
  });

  it("requires successful wildcard controls before trying the fixed name list", async () => {
    const provider = commonProvider(domain => ({ domain, status: "error", addresses: [], message: "DNS 查询失败" }));
    expect(await discoverSubdomains("example.com", "common", 20000, provider.adapter)).toMatchObject({ status: "error", domains: [], message: expect.stringContaining("通配 DNS 校验未完成") });
    expect(provider.scanDomain).toHaveBeenCalledTimes(2);
  });

  it("preserves resolved names while reporting individual DNS failures", async () => {
    const provider = commonProvider(domain => domain.startsWith("chainkit-check-") ? missing(domain) : domain === "api.example.com" ? resolved(domain) : { domain, status: "error", addresses: [] });
    expect(await discoverSubdomains("example.com", "common", 20000, provider.adapter)).toMatchObject({ status: "partial", domains: ["api.example.com"], message: expect.stringContaining("查询失败") });
  });

  it("keeps common-name queries within four DNS workers", async () => {
    let active = 0;
    let peak = 0;
    const provider = commonProvider(async domain => {
      if (domain.startsWith("chainkit-check-")) return missing(domain);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 1));
      active -= 1;
      return missing(domain);
    });
    expect(await discoverSubdomains("example.com", "common", 1000, provider.adapter)).toMatchObject({ status: "success", domains: [] });
    expect(peak).toBe(4);
    expect(provider.scanDomain).toHaveBeenCalledTimes(34);
  });

  it("stops pending common-name DNS work on cancellation", async () => {
    const controller = new AbortController();
    const provider = commonProvider(domain => domain.startsWith("chainkit-check-") ? missing(domain) : new Promise(() => {}));
    const pending = discoverSubdomains("example.com", "common", 20000, provider.adapter, controller.signal);
    await vi.waitFor(() => expect(provider.scanDomain).toHaveBeenCalledTimes(6));
    controller.abort();
    expect(await pending).toMatchObject({ status: "error", domains: [], message: "来源查询已取消" });
    expect(provider.scanDomain.mock.calls.every(([, , signal]) => signal.aborted)).toBe(true);
  });
});

describe("discovery operation bounds", () => {
  it("cancels a hanging provider at the source-wide deadline", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const provider = dependencies((_url, _call, signal) => { requestSignal = signal; return new Promise(() => {}); });
    const pending = discoverSubdomains("example.com", "subdomaincenter", 1000, provider.adapter);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ status: "error", domains: [], message: "来源查询超时" });
    expect(requestSignal?.aborted).toBe(true);
  });

  it("cancels provider HTTP work immediately and avoids work on pre-cancelled requests", async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const provider = dependencies((_url, _call, signal) => { requestSignal = signal; return new Promise(() => {}); });
    const pending = discoverSubdomains("example.com", "subdomaincenter", 20000, provider.adapter, controller.signal);
    controller.abort();
    expect((await pending).status).toBe("error");
    expect(requestSignal?.aborted).toBe(true);
    const preCancelled = dependencies(() => document(""));
    expect((await discoverSubdomains("example.com", "subdomaincenter", 1000, preCancelled.adapter, controller.signal)).status).toBe("error");
    expect(preCancelled.fetchDocument).not.toHaveBeenCalled();
  });

  it("rejects local domains and invalid source timeout budgets before outbound work", async () => {
    const provider = dependencies(() => document(""));
    await expect(discoverSubdomains("router.local", "subdomaincenter", 1000, provider.adapter)).rejects.toThrow();
    await expect(discoverSubdomains("example.com", "subdomaincenter", 20001, provider.adapter)).rejects.toThrow();
    expect(provider.fetchDocument).not.toHaveBeenCalled();
  });
});
