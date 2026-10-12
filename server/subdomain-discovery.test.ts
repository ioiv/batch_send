import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverSubdomains, MAX_DISCOVERY_DOMAINS, type SubdomainDiscoveryDependencies } from "./subdomain-discovery";
import type { PublicDocumentResult } from "./network-scan";

const absent = () => Object.assign(new Error("upstream details"), { code: "ENODATA" });
function metadataResolver() {
  return {
    resolveNs: vi.fn(async (_domain: string): Promise<string[]> => { throw absent(); }),
    resolveMx: vi.fn(async (_domain: string): Promise<Array<{ exchange: string; priority: number }>> => { throw absent(); }),
    resolveTxt: vi.fn(async (_domain: string): Promise<string[][]> => { throw absent(); }),
    resolveSoa: vi.fn(async (_domain: string): Promise<{ nsname: string; hostmaster: string; serial: number; refresh: number; retry: number; expire: number; minttl: number }> => { throw absent(); }),
    cancel: vi.fn()
  };
}

function document(body: unknown, overrides: Partial<PublicDocumentResult> = {}): PublicDocumentResult {
  return { url: "https://provider.invalid/", statusCode: 200, body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)), truncated: false, ...overrides };
}

function dependencies(fetcher: (url: URL, call: number, signal?: AbortSignal) => PublicDocumentResult | Promise<PublicDocumentResult>, resolver = metadataResolver()) {
  let count = 0;
  const fetchDocument = vi.fn((url: string, options: { timeoutMs: number; maxBytes: number; signal?: AbortSignal }) => {
    count += 1;
    expect(options.maxBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(options.timeoutMs).toBeLessThanOrEqual(20000);
    return Promise.resolve(fetcher(new URL(url), count, options.signal));
  });
  const adapter: SubdomainDiscoveryDependencies = { fetchDocument, createResolver: () => resolver };
  return { adapter, fetchDocument, resolver };
}

afterEach(() => { vi.useRealTimers(); });

describe("certificate transparency discovery", () => {
  it("splits crt.sh names, deduplicates, scopes exact subdomains and skips wildcard names", async () => {
    const provider = dependencies((url) => {
      expect(url.origin).toBe("https://crt.sh");
      expect(url.searchParams.get("q")).toBe("%.example.com");
      expect(url.searchParams.get("output")).toBe("json");
      return document([
        { name_value: "www.example.com\nAPI.Example.COM.\n*.wild.example.com\nexample.com\napi.example.com.evil.com", result_count: 2 },
        { name_value: "api.example.com\r\ncdn.example.com", result_count: 1 }
      ]);
    });
    expect(await discoverSubdomains("Example.COM", "crtsh", 1000, provider.adapter)).toEqual({ source: "crtsh", status: "success", domains: ["api.example.com", "cdn.example.com", "www.example.com"] });
    expect(provider.fetchDocument).toHaveBeenCalledTimes(1);
  });

  it("marks crt.sh raw truncation counts and missing completeness counts as partial", async () => {
    const limited = dependencies(() => document([{ name_value: "api.example.com", result_count: 10000 }]));
    expect(await discoverSubdomains("example.com", "crtsh", 1000, limited.adapter)).toMatchObject({ status: "partial", domains: ["api.example.com"] });
    const unknown = dependencies(() => document([{ name_value: "api.example.com" }]));
    expect((await discoverSubdomains("example.com", "crtsh", 1000, unknown.adapter)).status).toBe("partial");
  });

  it("recovers complete crt.sh name fields from a bounded truncated response", async () => {
    const provider = dependencies(() => document('[{"name_value":"api.example.com\\ncdn.example.com"},{"name_value":"incomplete', { truncated: true }));
    expect(await discoverSubdomains("example.com", "crtsh", 1000, provider.adapter)).toMatchObject({ status: "partial", domains: ["api.example.com", "cdn.example.com"] });
  });

  it("caps each source at 5000 unique scoped names and explicitly reports partial", async () => {
    const names = Array.from({ length: MAX_DISCOVERY_DOMAINS + 10 }, (_, index) => `observed-${index}.example.com`).join("\n");
    const provider = dependencies(() => document([{ name_value: names, result_count: 5010 }]));
    const result = await discoverSubdomains("example.com", "crtsh", 1000, provider.adapter);
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
    expect(await discoverSubdomains("example.com", "certspotter", 1000, provider.adapter)).toEqual({ source: "certspotter", status: "success", domains: ["api.example.com"] });
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
});

describe("passive host and archive sources", () => {
  it("parses HackerTarget hostsearch without inventing names or accepting other domains", async () => {
    const provider = dependencies((url) => { expect(url.origin + url.pathname).toBe("https://api.hackertarget.com/hostsearch/"); expect(url.searchParams.get("q")).toBe("example.com"); return document("api.example.com,8.8.8.8\napi.example.com,1.1.1.1\nexample.com,8.8.8.8\nevil.com,8.8.8.8\n"); });
    expect(await discoverSubdomains("example.com", "hackertarget", 1000, provider.adapter)).toEqual({ source: "hackertarget", status: "success", domains: ["api.example.com"] });
  });

  it("reports HackerTarget's 500-line free limit and textual quota errors", async () => {
    const provider = dependencies(() => document(Array.from({ length: 500 }, (_, index) => `api${index}.example.com,8.8.8.8`).join("\n")));
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

  it("uses Wayback's resume marker as an opaque token and extracts URL hostnames only", async () => {
    const token = "com,example)/ opaque%2B+token";
    const provider = dependencies((url, call) => {
      expect(url.origin + url.pathname).toBe("https://web.archive.org/cdx/search/cdx");
      expect(url.searchParams.get("url")).toBe("example.com");
      expect(url.searchParams.get("matchType")).toBe("domain");
      expect(url.searchParams.get("showResumeKey")).toBe("true");
      if (call === 1) return document([["original"], ["https://api.example.com/old"], [], [token]]);
      expect(url.searchParams.get("resumeKey")).toBe(token);
      return document([["original"], ["http://cdn.example.com:8080/archive"], ["https://example.com/"], ["https://example.com.evil.org/"]]);
    });
    expect(await discoverSubdomains("example.com", "wayback", 1000, provider.adapter)).toEqual({ source: "wayback", status: "success", domains: ["api.example.com", "cdn.example.com"] });
    expect(provider.fetchDocument).toHaveBeenCalledTimes(2);
  });

  it("marks repeated Wayback cursors partial instead of silently claiming completion", async () => {
    const provider = dependencies(() => document([["original"], ["https://api.example.com/"], [], ["same-token"]]));
    expect((await discoverSubdomains("example.com", "wayback", 1000, provider.adapter)).status).toBe("partial");
    expect(provider.fetchDocument).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed provider responses and redirects without following them", async () => {
    for (const source of ["crtsh", "certspotter", "wayback"] as const) {
      const malformed = dependencies(() => document("<html>provider blocked</html>"));
      expect((await discoverSubdomains("example.com", source, 1000, malformed.adapter)).status).toBe("error");
      const redirect = dependencies(() => document("", { statusCode: 302, location: "http://127.0.0.1/" }));
      expect((await discoverSubdomains("example.com", source, 1000, redirect.adapter)).status).toBe("error");
      expect(redirect.fetchDocument).toHaveBeenCalledTimes(1);
    }
  });
});

describe("observed target metadata", () => {
  it("queries only root NS/MX/TXT/SOA and extracts scoped hostnames from actual values", async () => {
    const resolver = metadataResolver();
    resolver.resolveNs.mockResolvedValue(["ns1.example.com", "ns.provider.com"]);
    resolver.resolveMx.mockResolvedValue([{ priority: 10, exchange: "mail.example.com" }]);
    resolver.resolveTxt.mockResolvedValue([["v=spf1 include:", "relay.example.com -all"], ["domain=example.com.evil.com"], ["url=https://txt.example.com/"]]);
    resolver.resolveSoa.mockResolvedValue({ nsname: "ns2.example.com", hostmaster: "admin.example.com", serial: 1, refresh: 1, retry: 1, expire: 1, minttl: 1 });
    const provider = dependencies(() => { throw new Error("no HTTP expected"); }, resolver);
    expect(await discoverSubdomains("example.com", "dns", 1000, provider.adapter)).toEqual({ source: "dns", status: "success", domains: ["mail.example.com", "ns1.example.com", "ns2.example.com", "relay.example.com", "txt.example.com"] });
    for (const query of [resolver.resolveNs, resolver.resolveMx, resolver.resolveTxt, resolver.resolveSoa]) expect(query).toHaveBeenCalledExactlyOnceWith("example.com");
    expect(provider.fetchDocument).not.toHaveBeenCalled();
    expect(resolver.cancel).toHaveBeenCalled();
  });

  it("distinguishes absent DNS metadata from an upstream DNS failure", async () => {
    const absentProvider = dependencies(() => { throw new Error("no HTTP expected"); });
    expect(await discoverSubdomains("example.com", "dns", 1000, absentProvider.adapter)).toEqual({ source: "dns", status: "success", domains: [] });
    const resolver = metadataResolver();
    resolver.resolveNs.mockRejectedValue(new Error("nameserver secrets"));
    const partial = dependencies(() => document(""), resolver);
    expect((await discoverSubdomains("example.com", "dns", 1000, partial.adapter)).status).toBe("partial");
  });

  it("does not invent hostnames by matching inside underscored or malformed TXT DNS tokens", async () => {
    const resolver = metadataResolver();
    resolver.resolveTxt.mockResolvedValue([["include:_spf.mail.example.com selector._domainkey.example.com bad..api.example.com -api.example.com valid=relay.example.com"]]);
    const provider = dependencies(() => document(""), resolver);
    expect((await discoverSubdomains("example.com", "dns", 1000, provider.adapter)).domains).toEqual(["relay.example.com"]);
  });

  it("reads exactly root HTML, robots and sitemap and follows no links or redirects", async () => {
    const seenPaths: string[] = [];
    const provider = dependencies((url) => {
      expect(url.origin).toBe("https://example.com");
      seenPaths.push(url.pathname);
      if (url.pathname === "/") return document('<a href="https://api.example.com/dashboard">api</a><script src="//cdn.example.com/x.js"></script><a href="https://example.com.evil.com/">evil</a>', { statusCode: 302, location: "https://redirect.example.com/" });
      if (url.pathname === "/robots.txt") return document("Sitemap: https://map.example.com/sitemap.xml\n");
      return document("<url><loc>https://shop.example.com/</loc></url>");
    });
    expect(await discoverSubdomains("example.com", "website", 1000, provider.adapter)).toEqual({ source: "website", status: "success", domains: ["api.example.com", "cdn.example.com", "map.example.com", "redirect.example.com", "shop.example.com"] });
    expect(seenPaths.sort()).toEqual(["/", "/robots.txt", "/sitemap.xml"]);
    expect(provider.fetchDocument).toHaveBeenCalledTimes(3);
  });

  it("reports partial website evidence when one document fails or is truncated", async () => {
    const provider = dependencies((url) => url.pathname === "/" ? document('<a href="https://api.example.com/">', { truncated: true }) : document("", { statusCode: 403 }));
    expect(await discoverSubdomains("example.com", "website", 1000, provider.adapter)).toMatchObject({ status: "partial", domains: ["api.example.com"] });
  });
});

describe("discovery operation bounds", () => {
  it("cancels a hanging provider at the source-wide deadline", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const provider = dependencies((_url, _call, signal) => { requestSignal = signal; return new Promise(() => {}); });
    const pending = discoverSubdomains("example.com", "crtsh", 1000, provider.adapter);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ status: "error", domains: [], message: "来源查询超时" });
    expect(requestSignal?.aborted).toBe(true);
  });

  it("cancels DNS immediately and avoids work on pre-cancelled requests", async () => {
    const controller = new AbortController();
    const resolver = metadataResolver();
    resolver.resolveNs.mockImplementation(() => new Promise(() => {}));
    const provider = dependencies(() => document(""), resolver);
    const pending = discoverSubdomains("example.com", "dns", 20000, provider.adapter, controller.signal);
    controller.abort();
    expect((await pending).status).toBe("error");
    expect(resolver.cancel).toHaveBeenCalled();
    const preCancelled = dependencies(() => document(""));
    expect((await discoverSubdomains("example.com", "crtsh", 1000, preCancelled.adapter, controller.signal)).status).toBe("error");
    expect(preCancelled.fetchDocument).not.toHaveBeenCalled();
  });

  it("rejects local domains and invalid source timeout budgets before outbound work", async () => {
    const provider = dependencies(() => document(""));
    await expect(discoverSubdomains("router.local", "crtsh", 1000, provider.adapter)).rejects.toThrow();
    await expect(discoverSubdomains("example.com", "crtsh", 20001, provider.adapter)).rejects.toThrow();
    expect(provider.fetchDocument).not.toHaveBeenCalled();
  });
});
