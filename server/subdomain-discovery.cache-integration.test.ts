import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicDocumentResult } from "./network-scan";
import { discoverSubdomains, type SubdomainDiscoveryDependencies } from "./subdomain-discovery";

const { fetchDocument } = vi.hoisted(() => ({
  fetchDocument: vi.fn<SubdomainDiscoveryDependencies["fetchDocument"]>()
}));

vi.mock("./network-scan", async importOriginal => {
  const actual = await importOriginal<typeof import("./network-scan")>();
  return { ...actual, fetchPublicDocument: fetchDocument };
});

function document(body: unknown, overrides: Partial<PublicDocumentResult> = {}): PublicDocumentResult {
  return { url: "https://provider.invalid/", statusCode: 200,
    body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)), truncated: false, ...overrides };
}

beforeEach(() => {
  fetchDocument.mockReset();
  vi.stubEnv("SSLMATE_API_KEY", "");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("default discovery dependency cache integration", () => {
  it("caches completed Pentest-Tools Light results without restarting a remote scan", async () => {
    const domain = "cached-pentesttools.example.com";
    fetchDocument.mockImplementation(async url => {
      const path = new URL(url).pathname;
      if (path.endsWith("/token")) return document({}, { setCookies: ["ptt.auth.token=fake-cache-session; Path=/; Secure"] });
      if (path.endsWith("/scans")) return document({ data: { created_id: 2468 } });
      if (path.endsWith("/output")) return document({ data: { type: "subdomains", data: { subdomains: [{ hostname: `api.${domain}` }] } } });
      if (path.includes("/scans_internal/")) return document({ data: { status_name: "finished" } });
      return document("<html>Subdomain Finder</html>");
    });
    const first = await discoverSubdomains(domain, "pentesttools");
    expect(first).toMatchObject({ status: "success", domains: [`api.${domain}`] });
    first.domains.push(`mutated.${domain}`);
    expect(await discoverSubdomains(domain, "pentesttools")).toMatchObject({ status: "success", domains: [`api.${domain}`] });
    expect(fetchDocument).toHaveBeenCalledTimes(5);
    expect(fetchDocument.mock.calls.filter(([url]) => url.endsWith("/scans"))).toHaveLength(1);
  });

  it.each(["subdomaincenter", "hackertarget", "certspotter", "certkit"] as const)("caches completed %s results by normalized domain and source", async source => {
    const domain = `cached-${source}.example.com`;
    const hostname = `api.${domain}`;
    fetchDocument.mockImplementation(async url => {
      if (source === "hackertarget") return document(`${hostname},1.1.1.1\n`);
      if (source === "certspotter") return document(new URL(url).searchParams.has("after") ? [] : [{ id: "1", dns_names: [hostname] }]);
      if (source === "certkit") return document({ totalCount: 1, results: [{ commonName: hostname, dnsNames: [hostname] }] });
      return document([hostname]);
    });
    // Omitting dependencies exercises the actual default object and its singleton cache.
    const first = await discoverSubdomains(`${domain.toUpperCase()}.`, source, 1000);
    expect(first).toMatchObject({ source, status: "success", domains: [hostname] });
    const fetched = fetchDocument.mock.calls.length;
    expect(fetched).toBe(source === "certspotter" ? 2 : 1);
    first.domains.push(`mutated.${domain}`);
    expect(await discoverSubdomains(domain, source, 1000)).toMatchObject({ source, status: "success", domains: [hostname] });
    expect(fetchDocument).toHaveBeenCalledTimes(fetched);

    await discoverSubdomains(`different-${domain}`, source, 1000);
    expect(fetchDocument).toHaveBeenCalledTimes(fetched * 2);
  });

  it("does not share cached results between public providers for the same domain", async () => {
    const domain = "provider-isolation.example.com";
    fetchDocument.mockImplementation(async url => new URL(url).hostname === "api.subdomain.center"
      ? document([`center.${domain}`]) : document(`passive.${domain},1.1.1.1\n`));
    expect(await discoverSubdomains(domain, "subdomaincenter", 1000)).toMatchObject({ domains: [`center.${domain}`] });
    expect(await discoverSubdomains(domain, "hackertarget", 1000)).toMatchObject({ domains: [`passive.${domain}`] });
    expect(await discoverSubdomains(domain, "subdomaincenter", 1000)).toMatchObject({ domains: [`center.${domain}`] });
    expect(fetchDocument).toHaveBeenCalledTimes(2);
  });

  it("isolates successful authenticated and anonymous CertSpotter caches as fake keys change", async () => {
    const domain = "credential-success.example.com";
    fetchDocument.mockImplementation(async (url, options) => {
      if (new URL(url).searchParams.has("after")) return document([]);
      const label = options.headers?.Authorization === "Bearer fake-cache-key-a" ? "key-a"
        : options.headers?.Authorization === "Bearer fake-cache-key-b" ? "key-b" : "anonymous";
      return document([{ id: "1", dns_names: [`${label}.${domain}`] }]);
    });
    for (const [key, label] of [["fake-cache-key-a", "key-a"], ["fake-cache-key-b", "key-b"], ["", "anonymous"]]) {
      vi.stubEnv("SSLMATE_API_KEY", key);
      for (let repeat = 0; repeat < 2; repeat++) {
        expect(await discoverSubdomains(domain, "certspotter", 1000)).toMatchObject({ status: "success", domains: [`${label}.${domain}`] });
      }
    }
    expect(fetchDocument).toHaveBeenCalledTimes(6);
    expect(fetchDocument.mock.calls.map(([, options]) => options.headers?.Authorization)).toEqual([
      "Bearer fake-cache-key-a", "Bearer fake-cache-key-a", "Bearer fake-cache-key-b", "Bearer fake-cache-key-b", undefined, undefined
    ]);
    vi.stubEnv("SSLMATE_API_KEY", "fake-cache-key-a");
    expect(await discoverSubdomains(domain, "certspotter", 1000)).toMatchObject({ domains: [`key-a.${domain}`] });
    expect(fetchDocument).toHaveBeenCalledTimes(6);
  });

  it("keeps a cached 401 failure within its fake credential namespace", async () => {
    const domain = "credential-failure.example.com";
    fetchDocument.mockImplementation(async (_url, options) => options.headers?.Authorization === "Bearer fake-rejected-cache-key"
      ? document({ code: "bad_credentials" }, { statusCode: 401 }) : document([]));
    vi.stubEnv("SSLMATE_API_KEY", "fake-rejected-cache-key");
    for (let repeat = 0; repeat < 2; repeat++) {
      expect(await discoverSubdomains(domain, "certspotter", 1000)).toMatchObject({ status: "error", domains: [], message: expect.stringContaining("Key 无效") });
    }
    expect(fetchDocument).toHaveBeenCalledOnce();
    vi.stubEnv("SSLMATE_API_KEY", "fake-accepted-cache-key");
    for (let repeat = 0; repeat < 2; repeat++) {
      expect(await discoverSubdomains(domain, "certspotter", 1000)).toMatchObject({ status: "success", domains: [] });
    }
    expect(fetchDocument).toHaveBeenCalledTimes(2);
    vi.stubEnv("SSLMATE_API_KEY", "fake-rejected-cache-key");
    expect(await discoverSubdomains(domain, "certspotter", 1000)).toMatchObject({ status: "error", message: expect.stringContaining("Key 无效") });
    expect(fetchDocument).toHaveBeenCalledTimes(2);
  });

  it("does not cache a source deadline failure as an upstream outage", async () => {
    vi.useFakeTimers();
    const domain = "source-timeout.example.com";
    fetchDocument.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
    }));
    const pending = discoverSubdomains(domain, "subdomaincenter", 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ status: "error", domains: [], message: expect.stringContaining("超时") });
    expect(fetchDocument.mock.calls[0][1].signal?.aborted).toBe(true);
    fetchDocument.mockResolvedValue(document([`api.${domain}`]));
    expect(await discoverSubdomains(domain, "subdomaincenter", 1000)).toMatchObject({ status: "success", domains: [`api.${domain}`] });
    expect(fetchDocument).toHaveBeenCalledTimes(2);
  });

  it("does not cache caller cancellation or let a late cancelled response replace fresh data", async () => {
    const domain = "caller-cancellation.example.com";
    let release!: (result: PublicDocumentResult) => void;
    fetchDocument.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const controller = new AbortController();
    const pending = discoverSubdomains(domain, "subdomaincenter", 1000, undefined, controller.signal);
    controller.abort();
    expect(await pending).toMatchObject({ status: "error", domains: [], message: expect.stringContaining("取消") });
    expect(fetchDocument.mock.calls[0][1].signal?.aborted).toBe(true);
    fetchDocument.mockResolvedValue(document([`fresh.${domain}`]));
    expect(await discoverSubdomains(domain, "subdomaincenter", 1000)).toMatchObject({ status: "success", domains: [`fresh.${domain}`] });
    release(document([`late.${domain}`]));
    await Promise.resolve();
    expect(await discoverSubdomains(domain, "subdomaincenter", 1000)).toMatchObject({ status: "success", domains: [`fresh.${domain}`] });
    expect(fetchDocument).toHaveBeenCalledTimes(2);
  });

  it("honors an already aborted caller before returning a warm cache entry", async () => {
    const domain = "warm-cache-cancellation.example.com";
    fetchDocument.mockResolvedValue(document([`api.${domain}`]));
    expect(await discoverSubdomains(domain, "subdomaincenter", 1000)).toMatchObject({ status: "success", domains: [`api.${domain}`] });
    const controller = new AbortController();
    controller.abort();
    expect(await discoverSubdomains(domain, "subdomaincenter", 1000, undefined, controller.signal)).toEqual({
      source: "subdomaincenter", status: "error", domains: [], message: "来源查询已取消"
    });
    expect(fetchDocument).toHaveBeenCalledOnce();
  });
});
