import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicDocumentOptions, PublicDocumentResult } from "./network-scan";
import { discoverSubdomains, MAX_DISCOVERY_DOMAINS, type SubdomainDiscoveryDependencies } from "./subdomain-discovery";

function document(body: unknown, overrides: Partial<PublicDocumentResult> = {}): PublicDocumentResult {
  return { url: "https://ct.certkit.io/search", statusCode: 200, truncated: false,
    body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)), ...overrides };
}

function provider(response: PublicDocumentResult | ((request: PublicDocumentOptions) => Promise<PublicDocumentResult>)) {
  const fetchDocument = vi.fn(async (url: string, request: PublicDocumentOptions) => {
    expect(url).toBe("https://ct.certkit.io/search");
    expect(request.maxBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(request.timeoutMs).toBeLessThanOrEqual(20_000);
    return typeof response === "function" ? response(request) : response;
  });
  const adapter: SubdomainDiscoveryDependencies = {
    fetchDocument
  };
  return { adapter, fetchDocument };
}

function certificate(commonName: string, dnsNames: string[] = []) {
  return { commonName, dnsNames, notBefore: "2020-01-01T00:00:00Z", notAfter: "2020-04-01T00:00:00Z" };
}

afterEach(() => { vi.useRealTimers(); });

describe("anonymous CertKit certificate source", () => {
  it("posts one normalized root with the public 100-certificate limit and merges scoped CN and SAN names", async () => {
    const fixture = provider(document({ timeTakenMs: 27, totalCount: 3, results: [
      certificate("CN.Example.COM.", ["API.example.com", "api.example.com", "example.com", "api.example.com.evil.com"]),
      certificate("cn.example.com", ["docs.example.com", "evil.com", "https://url.example.com/", "mal formed.example.com"]),
      certificate("outside.org", ["old.example.com"])
    ] }));
    const key = "fake-unrelated-sslmate-secret";
    const result = await discoverSubdomains("Example.COM.", "certkit", 1000, fixture.adapter, undefined, { sslmateApiKey: key });

    expect(result).toMatchObject({ source: "certkit", status: "success", domains: ["api.example.com", "cn.example.com", "docs.example.com", "old.example.com"] });
    expect(fixture.fetchDocument).toHaveBeenCalledOnce();
    const [, request] = fixture.fetchDocument.mock.calls[0];
    expect(request).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" } });
    expect(JSON.parse(request.body!)).toEqual({ domain: "example.com", limit: 100, sort: "" });
    expect(Object.keys(request.headers ?? {}).map(name => name.toLowerCase())).not.toContain("authorization");
    expect(Object.keys(request.headers ?? {}).map(name => name.toLowerCase())).not.toContain("cookie");
    expect(JSON.stringify(fixture.fetchDocument.mock.calls)).not.toContain(key);
    expect(JSON.stringify(result)).not.toContain(key);
  });

  it("keeps concrete certificate names while warning that wildcard certificates cannot enumerate hosts", async () => {
    const fixture = provider(document({ totalCount: 2, results: [
      certificate("*.example.com", ["api.example.com", "*.deep.example.com"]),
      certificate("outside.org", ["*.outside.org"])
    ] }));
    expect(await discoverSubdomains("example.com", "certkit", 1000, fixture.adapter)).toMatchObject({
      status: "partial", domains: ["api.example.com"], message: expect.stringContaining("通配")
    });
    const wildcardOnly = provider(document({ totalCount: 1, results: [certificate("*.example.com", ["example.com"])] }));
    expect(await discoverSubdomains("example.com", "certkit", 1000, wildcardOnly.adapter)).toMatchObject({
      status: "partial", domains: [], message: expect.stringContaining("具体")
    });
  });

  it("treats a successfully read empty certificate index as success", async () => {
    const fixture = provider(document({ timeTakenMs: 1, totalCount: 0, results: [] }));
    expect(await discoverSubdomains("example.com", "certkit", 1000, fixture.adapter)).toMatchObject({ status: "success", domains: [] });
    expect(fixture.fetchDocument).toHaveBeenCalledOnce();
  });

  it("marks a total exceeding the public response as partial without requesting another page or a larger limit", async () => {
    const rows = Array.from({ length: 100 }, (_, index) => certificate(`host-${index}.example.com`));
    const fixture = provider(document({ totalCount: 137, results: rows }));
    const result = await discoverSubdomains("example.com", "certkit", 1000, fixture.adapter);
    expect(result).toMatchObject({ status: "partial", message: expect.stringContaining("100") });
    expect(result.domains).toHaveLength(100);
    expect(fixture.fetchDocument).toHaveBeenCalledOnce();
  });

  it.each([
    { results: [], totalCount: "0" },
    { results: [], totalCount: -1 },
    { results: [], totalCount: 1.5 },
    { results: [], totalCount: Number.MAX_SAFE_INTEGER + 1 },
    { results: [], totalCount: undefined },
    { results: "invalid", totalCount: 0 },
    { message: "upstream-secret-message" },
    "<html>Sign in to search</html>"
  ])("rejects invalid response schemas instead of reporting successful empty discovery: %j", async body => {
    const fixture = provider(document(body));
    const result = await discoverSubdomains("example.com", "certkit", 1000, fixture.adapter);
    expect(result).toMatchObject({ status: "error", domains: [], message: expect.stringContaining("格式") });
    expect(JSON.stringify(result)).not.toContain("upstream-secret-message");
    expect(fixture.fetchDocument).toHaveBeenCalledOnce();
  });

  it.each([
    [429, "限流"],
    [302, "HTTP 302"]
  ])("reports HTTP %s as an independent source error without following redirects or retrying", async (statusCode, expectedMessage) => {
    const fixture = provider(document({ message: "upstream-private-detail" }, { statusCode: statusCode as number, location: "http://127.0.0.1/" }));
    const result = await discoverSubdomains("example.com", "certkit", 1000, fixture.adapter);
    expect(result).toMatchObject({ source: "certkit", status: "error", domains: [], message: expect.stringContaining(expectedMessage as string) });
    expect(JSON.stringify(result)).not.toContain("upstream-private-detail");
    expect(fixture.fetchDocument).toHaveBeenCalledOnce();
  });

  it("retains valid certificates when other rows are malformed and marks that response partial", async () => {
    const fixture = provider(document({ totalCount: 5, results: [
      certificate("api.example.com", ["docs.example.com"]),
      null, 42, { commonName: 17, dnsNames: [] }, { commonName: "bad.example.com", dnsNames: "not-an-array" }
    ] }));
    expect(await discoverSubdomains("example.com", "certkit", 1000, fixture.adapter)).toMatchObject({
      status: "partial", domains: ["api.example.com", "docs.example.com"], message: expect.stringContaining("格式")
    });
  });

  it("rejects an entirely malformed certificate list rather than passing it off as an empty index", async () => {
    const fixture = provider(document({ totalCount: 3, results: [null, 42, { dnsNames: "api.example.com" }] }));
    expect(await discoverSubdomains("example.com", "certkit", 1000, fixture.adapter)).toMatchObject({
      status: "error", domains: [], message: expect.stringContaining("格式")
    });
  });

  it("salvages only complete commonName fields and dnsNames arrays from a truncated bounded response", async () => {
    const fixture = provider(document('{"totalCount":3,"results":[{"commonName":"CN.example.com","dnsNames":["api.example.com","outside.org"]},{"commonName":"CDN.example.com","dnsNames":["unfinished.example.com","incom', { truncated: true }));
    expect(await discoverSubdomains("example.com", "certkit", 1000, fixture.adapter)).toMatchObject({
      status: "partial", domains: ["api.example.com", "cdn.example.com", "cn.example.com"], message: expect.stringContaining("读取上限")
    });
  });

  it("enforces the shared 5,000-name cap even when one returned certificate has many SANs", async () => {
    const names = Array.from({ length: MAX_DISCOVERY_DOMAINS + 1 }, (_, index) => `host-${index}.example.com`);
    const fixture = provider(document({ totalCount: 1, results: [certificate("example.com", names)] }));
    const result = await discoverSubdomains("example.com", "certkit", 1000, fixture.adapter);
    expect(result).toMatchObject({ status: "partial", message: expect.stringContaining("5000") });
    expect(result.domains).toHaveLength(MAX_DISCOVERY_DOMAINS);
    expect(fixture.fetchDocument).toHaveBeenCalledOnce();
  });

  it("does not request CertKit for a pre-cancelled caller and cancels an in-flight request", async () => {
    const before = new AbortController();
    before.abort();
    const skipped = provider(document({ totalCount: 0, results: [] }));
    expect(await discoverSubdomains("example.com", "certkit", 1000, skipped.adapter, before.signal)).toMatchObject({
      status: "error", domains: [], message: expect.stringContaining("取消")
    });
    expect(skipped.fetchDocument).not.toHaveBeenCalled();

    const fixture = provider(request => new Promise((_resolve, reject) => {
      request.signal!.addEventListener("abort", () => reject(new Error("private cancellation detail")), { once: true });
    }));
    const controller = new AbortController();
    const pending = discoverSubdomains("example.com", "certkit", 1000, fixture.adapter, controller.signal);
    controller.abort();
    expect(await pending).toMatchObject({ status: "error", domains: [], message: expect.stringContaining("取消") });
    expect(fixture.fetchDocument.mock.calls[0][1].signal?.aborted).toBe(true);
    expect(fixture.fetchDocument).toHaveBeenCalledOnce();
  });

  it("aborts an unfinished anonymous request at the source deadline without retrying", async () => {
    vi.useFakeTimers();
    const fixture = provider(request => new Promise((_resolve, reject) => {
      request.signal!.addEventListener("abort", () => reject(new Error("private timeout detail")), { once: true });
    }));
    const pending = discoverSubdomains("example.com", "certkit", 1000, fixture.adapter);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ status: "error", domains: [], message: expect.stringContaining("超时") });
    expect(fixture.fetchDocument.mock.calls[0][1].signal?.aborted).toBe(true);
    expect(fixture.fetchDocument).toHaveBeenCalledOnce();
  });
});
