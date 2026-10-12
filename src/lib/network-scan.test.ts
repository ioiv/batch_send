import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exportPathResultsCsv, normalizeDomain, normalizeWebsiteUrl,
  scanSubdomains, scanWebsitePaths
} from "./network-scan";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function json(result: unknown) { return new Response(JSON.stringify({ result }), { headers: { "Content-Type": "application/json" } }); }
function options<T>(onResult: (result: T) => void) {
  return { concurrency: 2, timeoutMs: 5000, signal: new AbortController().signal, onResult };
}

describe("network scan targets", () => {
  it("extracts the DNS hostname from pasted website addresses", () => {
    expect(normalizeDomain("HTTPS://EXAMPLE.com./")).toBe("example.com");
    expect(normalizeDomain("例子.中国")).toBe("xn--fsqu00a.xn--fiqs8s");
    expect(normalizeDomain("https://example.com/a?x=1#heading")).toBe("example.com");
    expect(normalizeDomain("example.com:8000/path?q=1")).toBe("example.com");
    expect(normalizeDomain("网站： https://EXAMPLE.com/path，复制的网址")).toBe("example.com");
    expect(normalizeDomain("“https://例子。中国/目录”")).toBe("xn--fsqu00a.xn--fiqs8s");
    for (const invalid of ["localhost", "127.0.0.1", "https://user:pass@example.com", "https://@example.com", "a..com", "-a.com", "user@example.com", "example.com\\@other.com"]) {
      expect(() => normalizeDomain(invalid)).toThrow();
    }
  });

  it("extracts the website entry, preserves exact paths and removes query parameters and fragments", () => {
    expect(normalizeWebsiteUrl("EXAMPLE.com/site")).toBe("https://example.com/site");
    expect(normalizeWebsiteUrl("https://example.com/index.html")).toBe("https://example.com/index.html");
    expect(normalizeWebsiteUrl("example.com")).toBe("https://example.com/");
    expect(normalizeWebsiteUrl("https://example.com/INDEX.HTML?q=1#section")).toBe("https://example.com/INDEX.HTML");
    expect(normalizeWebsiteUrl("链接：[文档](https://example.com/docs?q=1#section)")).toBe("https://example.com/docs");
    expect(normalizeWebsiteUrl("访问 example.com/about?tracking=x。 ")).toBe("https://example.com/about");
    expect(normalizeWebsiteUrl("//example.com/path?q=1")).toBe("https://example.com/path");
    expect(normalizeWebsiteUrl("https://example.com/?email=user@example.com")).toBe("https://example.com/");
    for (const invalid of ["javascript:alert(1)", "https://example.com:8443/", "https://user:pass@example.com/a", "https://@example.com/", ""]) {
      expect(() => normalizeWebsiteUrl(invalid)).toThrow();
    }
  });

  it("rejects unsupported/malformed schemes and unsafe selected tokens instead of silently changing the target", () => {
    for (const invalid of ["https:", "https:/", "https", "https:/example.com/path", "ssh:example.com", "javascript:example.com", "ftp://example.com/a", "example.com:bad", "example.com\\path", "https://evil.com\\@example.com/"]) {
      expect(() => normalizeWebsiteUrl(invalid)).toThrow();
      expect(() => normalizeDomain(invalid)).toThrow();
    }
    expect(() => normalizeWebsiteUrl("first https://user:pass@example.com/a then https://safe.com/")).toThrow();
    expect(() => normalizeWebsiteUrl("first https://example.com:8443/a then https://safe.com/")).toThrow();
    expect(normalizeWebsiteUrl("first https://example.com/a then https://safe.com/")).toBe("https://example.com/a");
    expect(normalizeWebsiteUrl("https://example.com/a，https://safe.com/second")).toBe("https://example.com/a");
    expect(normalizeWebsiteUrl("https://example.com/a，这是网址")).toBe("https://example.com/a");
    expect(normalizeWebsiteUrl("URL: https://example.com/a?tracking=1")).toBe("https://example.com/a");
  });

  it("retains literal punctuation on standalone and quoted exact entry URLs", () => {
    for (const path of ["/action!", "/v1.", "/a_(b)", "/plain)"]) {
      expect(normalizeWebsiteUrl(`https://example.com${path}`)).toBe(`https://example.com${path}`);
      expect(normalizeWebsiteUrl(`“https://example.com${path}”`)).toBe(`https://example.com${path}`);
    }
    expect(normalizeWebsiteUrl("Read [docs](https://example.com/a_(b)).")).toBe("https://example.com/a_(b)");
  });
});

describe("network scan execution", () => {
  it("flags matches against two wildcard probes without including probes in results", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const { domain } = JSON.parse(String(init.body));
      return json({ domain, status: "resolved", addresses: domain.startsWith("api.") ? ["1.1.1.1"] : ["8.8.8.8"] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const results: unknown[] = [];
    const progress = vi.fn();
    await scanSubdomains({ ...options(result => results.push(result)), domain: "example.com",
      candidates: ["www.example.com", "api.example.com"], onProgress: progress });
    expect(results).toEqual([
      { domain: "www.example.com", status: "resolved", addresses: ["8.8.8.8"], wildcard: true },
      { domain: "api.example.com", status: "resolved", addresses: ["1.1.1.1"], wildcard: false }
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(progress).toHaveBeenLastCalledWith(2, 2);
  });

  it("retains DNS lookup errors instead of treating them as absent", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const { domain } = JSON.parse(String(init.body));
      return json({ domain, status: domain.startsWith("chainkit-") ? "not-found" : "error", addresses: [], message: "DNS 查询超时" });
    }));
    const onResult = vi.fn();
    await scanSubdomains({ ...options(onResult), domain: "example.com", candidates: ["www.example.com"] });
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ status: "error", wildcard: false }));
  });

  it("detects a stable wildcard CNAME even when the address pool rotates", async () => {
    let address = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const { domain } = JSON.parse(String(init.body));
      return json({ domain, status: "resolved", addresses: [`8.8.8.${++address}`], cname: "Wildcard.CDN.com." });
    }));
    const onResult = vi.fn();
    await scanSubdomains({ ...options(onResult), domain: "example.com", candidates: ["www.example.com"] });
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ wildcard: true }));
  });

  it("bounds a stalled API connection with a client deadline and records a timeout", async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const { domain } = JSON.parse(String(init.body));
      calls++;
      if (calls === 1) return json({ domain, status: "not-found", addresses: [] });
      return await new Promise<Response>(() => {});
    }));
    const onResult = vi.fn();
    const job = scanSubdomains({ ...options(onResult), domain: "example.com", candidates: ["www.example.com"] });
    await vi.advanceTimersByTimeAsync(7001);
    await job;
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ status: "error", message: "扫描服务响应超时" }));
  });

  it("marks catch-all page fingerprints while retaining restricted and missing paths", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const { url } = JSON.parse(String(init.body));
      const path = new URL(url).pathname;
      return json({ url, status: "responded", statusCode: path === "/admin" ? 403 : path === "/gone" ? 404 : 200,
        title: "Page", fingerprint: path === "/admin" ? "restricted" : "fallback" });
    }));
    const onResult = vi.fn();
    await scanWebsitePaths({ ...options(onResult), baseUrl: "https://example.com/", candidates: ["https://example.com/catchall", "https://example.com/admin", "https://example.com/gone"] });
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ url: "https://example.com/catchall", soft404: true }));
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403, soft404: false }));
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404, soft404: false }));
  });

  it("bounds concurrency and stops queued work without late callbacks", async () => {
    const controller = new AbortController();
    let active = 0;
    let maxActive = 0;
    let candidateRequests = 0;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let twoStarted!: () => void;
    const started = new Promise<void>(resolve => { twoStarted = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const { domain } = JSON.parse(String(init.body));
      if (domain.startsWith("chainkit-")) return json({ domain, status: "not-found", addresses: [] });
      candidateRequests++;
      maxActive = Math.max(maxActive, ++active);
      if (active === 2) twoStarted();
      await pending;
      active--;
      return json({ domain, status: "resolved", addresses: ["8.8.8.8"] });
    }));
    const onResult = vi.fn();
    const job = scanSubdomains({ ...options(onResult), signal: controller.signal, domain: "example.com",
      candidates: ["a.example.com", "b.example.com", "c.example.com", "d.example.com"] });
    const rejected = expect(job).rejects.toMatchObject({ name: "AbortError" });
    await started;
    controller.abort();
    release();
    await rejected;
    expect(maxActive).toBe(2);
    expect(candidateRequests).toBe(2);
    expect(onResult).not.toHaveBeenCalled();
  });

  it("keeps distinct redirect destinations and different declared lengths out of soft 404 matches", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const { url } = JSON.parse(String(init.body));
      const path = new URL(url).pathname;
      return json({ url, status: "responded", statusCode: 302, fingerprint: "empty", title: "Redirect",
        contentLength: path === "/large" ? 100 : 0, location: path === "/admin" ? "/login" : "/404" });
    }));
    const onResult = vi.fn();
    await scanWebsitePaths({ ...options(onResult), baseUrl: "https://example.com/",
      candidates: ["https://example.com/admin", "https://example.com/large", "https://example.com/fallback"] });
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ url: "https://example.com/admin", soft404: false }));
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ url: "https://example.com/large", soft404: false }));
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ url: "https://example.com/fallback", soft404: true }));
  });

  it("reports an unavailable static-only deployment and server throttling", async () => {
    const settings = { ...options(vi.fn()), domain: "example.com", candidates: ["www.example.com"] };
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>SPA</html>")));
    await expect(scanSubdomains(settings)).rejects.toThrow(/扫描服务不可用/);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "请求过于频繁" }), { status: 429 })));
    await expect(scanSubdomains(settings)).rejects.toThrow(/请求过于频繁/);
  });

  it("rejects mismatched service responses and out-of-scope candidates", async () => {
    const fetchMock = vi.fn(async () => json({ domain: "other.com", status: "resolved", addresses: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(scanSubdomains({ ...options(vi.fn()), domain: "example.com", candidates: ["www.example.com"] })).rejects.toThrow(/无效 DNS/);
    fetchMock.mockClear();
    await expect(scanSubdomains({ ...options(vi.fn()), domain: "example.com", candidates: ["other.com"] })).rejects.toThrow(/扫描范围/);
    await expect(scanWebsitePaths({ ...options(vi.fn()), baseUrl: "https://example.com/", candidates: ["https://other.com/"] })).rejects.toThrow(/扫描范围/);
    await expect(scanSubdomains({ ...options(vi.fn()), concurrency: 9, domain: "example.com", candidates: ["www.example.com"] })).rejects.toThrow(/并发数/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("network scan CSV", () => {
  it("quotes separators and neutralizes formula-like target text", () => {
    const csv = exportPathResultsCsv([{ url: "https://example.com/", status: "responded", statusCode: 200,
      title: '=HYPERLINK("evil")', location: "//other.com/a,b", soft404: true }]);
    expect(csv).toContain('"\'=HYPERLINK(""evil"")"');
    expect(csv).toContain('"//other.com/a,b"');
    expect(csv).toContain('"true"');
  });
});
