import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage, ServerResponse } from "node:http";
import type { RequestOptions } from "node:https";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchPublicDocument, handleNetworkScanRequest, isPublicIp, MAX_RESPONSE_BYTES, scanSubdomain, scanWebsitePath,
  validateScanPayload, type NetworkScanDependencies
} from "./network-scan";
import * as discovery from "./subdomain-discovery";
import * as pathDiscovery from "./website-path-discovery";

const dnsError = (code: string) => Object.assign(new Error("sensitive upstream details"), { code });

function mockResolver(overrides: Partial<ReturnType<typeof baseResolver>> = {}) {
  return { ...baseResolver(), ...overrides };
}

function baseResolver() {
  return {
    resolve4: vi.fn(async (_hostname: string) => ["93.184.216.34"]),
    resolve6: vi.fn(async (_hostname: string): Promise<string[]> => { throw dnsError("ENODATA"); }),
    resolveCname: vi.fn(async (_hostname: string): Promise<string[]> => { throw dnsError("ENODATA"); }),
    cancel: vi.fn()
  };
}

function transport(onResponse: (response: IncomingMessage & PassThrough, options: RequestOptions) => void, resolver = mockResolver()) {
  const requests: ClientRequest[] = [];
  const responses: Array<IncomingMessage & PassThrough> = [];
  const request = vi.fn((_protocol: "http:" | "https:", options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    const outgoing = Object.assign(new EventEmitter(), {
      end: vi.fn(() => queueMicrotask(() => {
        const incoming = Object.assign(new PassThrough(), { statusCode: 200, headers: {}, complete: false }) as unknown as IncomingMessage & PassThrough;
        responses.push(incoming);
        callback(incoming);
        onResponse(incoming, options);
      })),
      destroy: vi.fn()
    }) as unknown as ClientRequest;
    requests.push(outgoing);
    return outgoing;
  });
  const dependencies: NetworkScanDependencies = { createResolver: () => resolver, request };
  return { dependencies, resolver, request, requests, responses };
}

function endResponse(response: IncomingMessage & PassThrough, body: string | Buffer) {
  response.complete = true;
  response.end(body);
}

afterEach(() => { vi.useRealTimers(); });

describe("public-target validation", () => {
  it.each([
    "0.0.0.0", "10.0.0.1", "100.64.0.1", "100.127.255.254", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.254",
    "192.0.0.1", "192.0.2.1", "192.88.99.1", "192.168.1.1", "198.18.0.1", "198.19.255.254", "198.51.100.1", "203.0.113.1",
    "224.0.0.1", "240.0.0.1", "255.255.255.255", "::", "::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "64:ff9b::a00:1",
    "fc00::1", "fd00::1", "fe80::1", "fe80::1%eth0", "ff02::1", "2001::1", "2001:2::1", "2001:10::1", "2001:20::1",
    "2001:db8::1", "2002:7f00:1::1", "3ffe::1", "3fff::1", "not-an-ip"
  ])("rejects reserved or local IP %s", (address) => { expect(isPublicIp(address)).toBe(false); });

  it.each(["8.8.8.8", "1.1.1.1", "100.128.0.1", "172.32.0.1", "93.184.216.34", "2606:4700:4700::1111", "2001:4860:4860::8888"])("allows public IP %s", (address) => {
    expect(isPublicIp(address)).toBe(true);
  });

  it.each([
    "http://localhost/", "https://printer.local/", "http://127.0.0.1/", "http://127.1/", "http://2130706433/", "http://0x7f000001/",
    "http://[::1]/", "http://[::ffff:8.8.8.8]/", "http://169.254.169.254/latest/meta-data/", "https://user:pass@example.com/",
    "https://@example.com/", "https://example.com:8443/", "ftp://example.com/", "https://example.com/#fragment", "https://example.com\\@localhost/"
  ])("rejects unsafe URL %s", (url) => { expect(() => validateScanPayload({ kind: "path", url })).toThrow(); });

  it("normalizes domains and default ports, rejects extra fields and invalid budgets", () => {
    expect(validateScanPayload({ kind: "subdomain", domain: "WWW.Example.COM." })).toEqual({ kind: "subdomain", domain: "www.example.com", timeoutMs: 5000 });
    expect(validateScanPayload({ kind: "path", url: "https://example.com:443/admin", timeoutMs: 1000 })).toEqual({ kind: "path", url: "https://example.com/admin", timeoutMs: 1000 });
    expect(() => validateScanPayload({ kind: "subdomain", domain: "example.com", extra: "ignored" })).toThrow();
    expect(() => validateScanPayload({ kind: "path", url: "https://example.com/", timeoutMs: 10001 })).toThrow();
    expect(() => validateScanPayload({ kind: "path", url: `https://example.com/${"x".repeat(2048)}` })).toThrow();
    expect(() => validateScanPayload({ kind: "subdomain", domain: "localhost" })).toThrow();
    expect(() => validateScanPayload({ kind: "subdomain", domain: "192.168.0.1" })).toThrow();
  });

  it("validates known passive discovery sources with their separate 20-second timeout", () => {
    expect(validateScanPayload({ kind: "subdomain-discovery", domain: "Example.com", source: "crtsh" })).toEqual({ kind: "subdomain-discovery", domain: "example.com", source: "crtsh", timeoutMs: 20000 });
    expect(validateScanPayload({ kind: "subdomain-discovery", domain: "example.com", source: "dns", timeoutMs: 15000 })).toHaveProperty("timeoutMs", 15000);
    expect(() => validateScanPayload({ kind: "subdomain-discovery", domain: "example.com", source: "https://evil.com" })).toThrow();
    expect(() => validateScanPayload({ kind: "subdomain-discovery", domain: "example.com", source: "crtsh", timeoutMs: 20001 })).toThrow();
    expect(() => validateScanPayload({ kind: "path", url: "https://example.com/", timeoutMs: 15000 })).toThrow();
  });
  it("validates same-origin discovery documents and script owner context", () => {
    expect(validateScanPayload({ kind: "path-discovery", baseUrl: "https://example.com/start?tracking=1", url: "https://example.com/assets/app.js?version=2", documentUrl: "https://example.com/docs/page", source: "scripts", timeoutMs: 20000 })).toEqual({ kind: "path-discovery", baseUrl: "https://example.com/start", url: "https://example.com/assets/app.js", documentUrl: "https://example.com/docs/page", source: "scripts", timeoutMs: 20000 });
    for (const override of [{ url: "https://evil.com/" }, { documentUrl: "http://example.com/" }, { source: "dictionary" }, { timeoutMs: 20001 }, { extra: 1 }]) {
      expect(() => validateScanPayload({ kind: "path-discovery", baseUrl: "https://example.com/", url: "https://example.com/", source: "links", ...override })).toThrow();
    }
  });
});

describe("subdomain DNS checks", () => {
  it("returns A, AAAA and CNAME data and releases the resolver", async () => {
    const resolver = mockResolver({ resolve6: vi.fn(async () => ["2606:4700:4700::1111"]), resolveCname: vi.fn(async () => ["edge.example.com"]) });
    const adapter = transport(() => {}, resolver);
    expect(await scanSubdomain("www.example.com", 1000, adapter.dependencies)).toEqual({
      domain: "www.example.com", status: "resolved", addresses: ["93.184.216.34", "2606:4700:4700::1111"], cname: "edge.example.com"
    });
    expect(resolver.resolve4).toHaveBeenCalledWith("www.example.com");
    expect(resolver.resolve6).toHaveBeenCalledWith("www.example.com");
    expect(resolver.resolveCname).toHaveBeenCalledWith("www.example.com");
    expect(resolver.cancel).toHaveBeenCalled();
    expect(adapter.request).not.toHaveBeenCalled();
  });

  it("only classifies authoritative missing records as not-found", async () => {
    const missing = mockResolver({ resolve4: vi.fn(async () => { throw dnsError("ENOTFOUND"); }) });
    expect((await scanSubdomain("missing.example.com", 1000, transport(() => {}, missing).dependencies)).status).toBe("not-found");
    const failed = mockResolver({ resolve4: vi.fn(async () => { throw dnsError("ESERVFAIL"); }) });
    const result = await scanSubdomain("failed.example.com", 1000, transport(() => {}, failed).dependencies);
    expect(result.status).toBe("error");
    expect(result.message).not.toContain("sensitive upstream details");
    const empty = mockResolver({ resolve4: vi.fn(async () => []) });
    expect((await scanSubdomain("empty.example.com", 1000, transport(() => {}, empty).dependencies)).status).toBe("error");
  });

  it("recognizes a CNAME record even when its destination has no A or AAAA record", async () => {
    const resolver = mockResolver({
      resolve4: vi.fn(async () => { throw dnsError("ENODATA"); }),
      resolveCname: vi.fn(async () => ["Edge.Example.COM."])
    });
    expect(await scanSubdomain("alias.example.com", 1000, transport(() => {}, resolver).dependencies)).toEqual({
      domain: "alias.example.com", status: "resolved", addresses: [], cname: "edge.example.com"
    });
  });

  it("displays private CNAME metadata without following or requesting it", async () => {
    const resolver = mockResolver({ resolveCname: vi.fn(async () => ["router.local"]) });
    const adapter = transport(() => {}, resolver);
    expect(await scanSubdomain("alias.example.com", 1000, adapter.dependencies)).toMatchObject({ status: "resolved", cname: "router.local", message: "DNS 记录包含非公网地址，仅展示解析结果" });
    expect(adapter.request).not.toHaveBeenCalled();
  });

  it("displays mixed DNS-only address metadata and treats partial DNS failure as error", async () => {
    const mixed = mockResolver({ resolve6: vi.fn(async () => ["::1"]) });
    const adapter = transport(() => {}, mixed);
    expect(await scanSubdomain("mixed.example.com", 1000, adapter.dependencies)).toMatchObject({ status: "resolved", addresses: ["93.184.216.34", "::1"], message: "DNS 记录包含非公网地址，仅展示解析结果" });
    expect(adapter.request).not.toHaveBeenCalled();
    const failedFamily = mockResolver({ resolve6: vi.fn(async () => { throw dnsError("ETIMEOUT"); }) });
    expect((await scanSubdomain("partial.example.com", 1000, transport(() => {}, failedFamily).dependencies)).status).toBe("error");
  });

  it("cancels DNS after the configured timeout", async () => {
    vi.useFakeTimers();
    const resolver = mockResolver({ resolve4: vi.fn(() => new Promise<string[]>(() => {})) });
    const pending = scanSubdomain("slow.example.com", 1000, transport(() => {}, resolver).dependencies);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ status: "error", message: "请求超时" });
    expect(resolver.cancel).toHaveBeenCalled();
  });

  it("cancels DNS immediately when the client stops scanning", async () => {
    const controller = new AbortController();
    const resolver = mockResolver({ resolve4: vi.fn(() => new Promise<string[]>(() => {})) });
    const pending = scanSubdomain("slow.example.com", 10000, transport(() => {}, resolver).dependencies, controller.signal);
    controller.abort();
    expect(await pending).toMatchObject({ status: "error", message: "请求失败" });
    expect(resolver.cancel).toHaveBeenCalled();
  });
});

describe("website path probes", () => {
  it("keeps shared discovery document requests public-only and bounds their raw bodies", async () => {
    const blocked = transport(() => {}, mockResolver({ resolve4: vi.fn(async () => ["10.0.0.1"]) }));
    await expect(fetchPublicDocument("https://example.com/", { timeoutMs: 1000, maxBytes: 8 }, blocked.dependencies)).rejects.toThrow();
    expect(blocked.request).not.toHaveBeenCalled();
    const bounded = transport((response) => { response.write("123456789more"); });
    const result = await fetchPublicDocument("https://example.com/", { timeoutMs: 1000, maxBytes: 8 }, bounded.dependencies);
    expect(result.body.toString()).toBe("12345678");
    expect(result.truncated).toBe(true);
    expect(bounded.responses[0].destroyed).toBe(true);
  });
  it("pins the connection to the vetted address and retains TLS hostname and path", async () => {
    const adapter = transport((response, options) => {
      expect(options.hostname).toBe("example.com");
      expect(options.servername).toBe("example.com");
      expect(options.path).toBe("/admin?view=1");
      expect(options.agent).toBe(false);
      options.lookup!("example.com", {}, (error, address, family) => { expect(error).toBeNull(); expect(address).toBe("93.184.216.34"); expect(family).toBe(4); });
      options.lookup!("example.com", { all: true }, (error, addresses) => { expect(error).toBeNull(); expect(addresses).toEqual([{ address: "93.184.216.34", family: 4 }]); });
      response.headers = { "content-length": "69" };
      endResponse(response, "<html><title> Admin &amp; Settings </title><body>okay</body></html>");
    });
    const result = await scanWebsitePath("https://example.com/admin?view=1", 1000, adapter.dependencies);
    expect(result).toMatchObject({ status: "responded", statusCode: 200, title: "Admin & Settings", contentLength: 69 });
    expect(result.fingerprint).toHaveLength(64);
    expect(adapter.resolver.resolve4).toHaveBeenCalledTimes(1);
    expect(adapter.resolver.resolve6).toHaveBeenCalledTimes(1);
    expect(adapter.resolver.resolveCname).not.toHaveBeenCalled();
    expect(adapter.request).toHaveBeenCalledTimes(1);
  });

  it("does not follow redirects even when their location is private", async () => {
    const adapter = transport((response) => { response.statusCode = 302; response.headers = { location: "http://127.0.0.1/private" }; endResponse(response, "redirect"); });
    expect(await scanWebsitePath("https://example.com/admin", 1000, adapter.dependencies)).toMatchObject({ status: "responded", statusCode: 302, location: "http://127.0.0.1/private" });
    expect(adapter.request).toHaveBeenCalledTimes(1);
  });

  it("blocks private and mixed DNS answers before requesting anything", async () => {
    for (const addresses of [["127.0.0.1"], ["93.184.216.34", "10.0.0.1"]]) {
      const adapter = transport(() => {}, mockResolver({ resolve4: vi.fn(async () => addresses) }));
      expect((await scanWebsitePath("https://example.com/admin", 1000, adapter.dependencies)).status).toBe("error");
      expect(adapter.request).not.toHaveBeenCalled();
    }
  });

  it("bounds response sampling and closes a continuing stream", async () => {
    const body = Buffer.alloc(MAX_RESPONSE_BYTES + 4096, "x");
    const adapter = transport((response) => { response.write(body); });
    const result = await scanWebsitePath("https://example.com/large", 1000, adapter.dependencies);
    expect(result.status).toBe("responded");
    expect(result.fingerprint).toBe(createHash("sha256").update(body.subarray(0, MAX_RESPONSE_BYTES)).digest("hex"));
    expect(adapter.responses[0].destroyed).toBe(true);
    expect(adapter.requests[0].destroy).toHaveBeenCalled();
  });

  it("bounds the entire DNS plus HTTP operation and destroys hanging requests", async () => {
    vi.useFakeTimers();
    const resolver = mockResolver({ resolve4: vi.fn(() => new Promise<string[]>((resolve) => setTimeout(() => resolve(["93.184.216.34"]), 600))) });
    const adapter = transport(() => {}, resolver);
    const pending = scanWebsitePath("https://example.com/slow", 1000, adapter.dependencies);
    await vi.advanceTimersByTimeAsync(600);
    expect(adapter.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(400);
    expect(await pending).toMatchObject({ status: "error", message: "请求超时" });
    expect(adapter.requests[0].destroy).toHaveBeenCalled();
    expect(adapter.responses[0].destroyed).toBe(true);
  });

  it("reports aborted responses and transport errors without disclosing upstream details", async () => {
    const adapter = transport((response) => { response.emit("aborted"); });
    expect(await scanWebsitePath("https://example.com/aborted", 1000, adapter.dependencies)).toMatchObject({ status: "error", message: "请求失败" });
    const errorAdapter = transport((response) => { response.emit("error", new Error("private credentials upstream")); });
    expect((await scanWebsitePath("https://example.com/error", 1000, errorAdapter.dependencies)).message).toBe("请求失败");
  });

  it("destroys the outbound request immediately on cancellation", async () => {
    const controller = new AbortController();
    const adapter = transport(() => { controller.abort(); });
    expect(await scanWebsitePath("https://example.com/cancelled", 10000, adapter.dependencies, controller.signal)).toMatchObject({ status: "error" });
    expect(adapter.responses[0].destroyed).toBe(true);
    expect(adapter.requests[0].destroy).toHaveBeenCalled();
  });

  it("never starts DNS or HTTP for an already cancelled scan", async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = transport(() => {});
    expect((await scanWebsitePath("https://example.com/cancelled", 10000, adapter.dependencies, controller.signal)).status).toBe("error");
    expect(adapter.resolver.resolve4).not.toHaveBeenCalled();
    expect(adapter.request).not.toHaveBeenCalled();
  });
});

function mockHandlerRequest(method = "POST", contentType = "application/json", client = "test-client") {
  return Object.assign(new PassThrough(), { method, headers: { "content-type": contentType }, socket: { remoteAddress: client } }) as unknown as IncomingMessage & PassThrough & { body?: unknown };
}

function mockHandlerResponse() {
  const headers: Record<string, string> = {};
  const response = Object.assign(new EventEmitter(), { statusCode: 0, destroyed: false, writableEnded: false, setHeader: vi.fn((name: string, value: string) => { headers[name] = value; }), end: vi.fn() });
  return { response: response as unknown as ServerResponse, state: response, headers };
}

describe("Node HTTP handler", () => {
  it("dispatches observed path discovery with cancellation and owner context", async () => {
    const result = { source: "scripts" as const, url: "https://example.com/app.js", status: "success" as const, candidates: [{ url: "https://example.com/api", kind: "page" as const, source: "scripts" as const }] };
    const discover = vi.spyOn(pathDiscovery, "discoverWebsitePaths").mockResolvedValue(result);
    try {
      const request = mockHandlerRequest();
      request.body = { kind: "path-discovery", baseUrl: "https://example.com/", url: "https://example.com/app.js", documentUrl: "https://example.com/docs/page", source: "scripts", timeoutMs: 15000 };
      const response = mockHandlerResponse();
      await handleNetworkScanRequest(request, response.response);
      expect(response.state.statusCode).toBe(200);
      expect(JSON.parse(response.state.end.mock.calls[0][0])).toEqual({ result });
      expect(discover).toHaveBeenCalledWith("https://example.com/", "https://example.com/app.js", "scripts", 15000, undefined, expect.any(AbortSignal), "https://example.com/docs/page");
    } finally { discover.mockRestore(); }
  });
  it("dispatches passive discovery through the same validated and cancellable endpoint", async () => {
    const result = { source: "dns" as const, status: "success" as const, domains: ["api.example.com"] };
    const discover = vi.spyOn(discovery, "discoverSubdomains").mockResolvedValue(result);
    try {
      const request = mockHandlerRequest();
      request.body = { kind: "subdomain-discovery", domain: "example.com", source: "dns", timeoutMs: 15000 };
      const response = mockHandlerResponse();
      await handleNetworkScanRequest(request, response.response);
      expect(response.state.statusCode).toBe(200);
      expect(JSON.parse(response.state.end.mock.calls[0][0])).toEqual({ result });
      expect(discover).toHaveBeenCalledWith("example.com", "dns", 15000, undefined, expect.any(AbortSignal));
    } finally { discover.mockRestore(); }
  });
  it("rejects methods and unsupported content types with JSON", async () => {
    const method = mockHandlerResponse();
    await handleNetworkScanRequest(mockHandlerRequest("GET"), method.response);
    expect(method.state.statusCode).toBe(405);
    expect(method.headers.Allow).toBe("POST");
    expect(JSON.parse(method.state.end.mock.calls[0][0])).toHaveProperty("error");
    const type = mockHandlerResponse();
    await handleNetworkScanRequest(mockHandlerRequest("POST", "text/plain"), type.response);
    expect(type.state.statusCode).toBe(415);
  });

  it("accepts Vercel-parsed JSON for validation and prevents secret error leakage", async () => {
    const request = mockHandlerRequest();
    request.body = { kind: "path", url: "http://127.0.0.1/" };
    const response = mockHandlerResponse();
    await handleNetworkScanRequest(request, response.response);
    expect(response.state.statusCode).toBe(400);
    expect(response.headers["Cache-Control"]).toBe("no-store");
    expect(JSON.parse(response.state.end.mock.calls[0][0])).toEqual({ error: "仅支持公网目标" });
  });

  it("rejects oversized raw JSON before buffering its remainder", async () => {
    const request = mockHandlerRequest();
    const response = mockHandlerResponse();
    const pending = handleNetworkScanRequest(request, response.response);
    request.write(Buffer.alloc(8193, "x"));
    await pending;
    expect(response.state.statusCode).toBe(413);
    expect(request.listenerCount("data")).toBe(0);
    request.end();
  });

  it("limits active requests to eight per client and releases their quota", async () => {
    const openRequests = Array.from({ length: 8 }, () => mockHandlerRequest("POST", "application/json", "quota-client"));
    const pending = openRequests.map((request) => handleNetworkScanRequest(request, mockHandlerResponse().response));
    const ninth = mockHandlerRequest("POST", "application/json", "quota-client");
    ninth.body = {};
    const busy = mockHandlerResponse();
    await handleNetworkScanRequest(ninth, busy.response);
    expect(busy.state.statusCode).toBe(429);
    expect(busy.headers["Retry-After"]).toBe("10");
    openRequests.forEach((request) => request.end("{}"));
    await Promise.all(pending);
    const next = mockHandlerResponse();
    await handleNetworkScanRequest(ninth, next.response);
    expect(next.state.statusCode).toBe(400);
  });

  it("releases all active slots on disconnect so a scan can restart immediately", async () => {
    const openRequests = Array.from({ length: 8 }, () => mockHandlerRequest("POST", "application/json", "disconnect-client"));
    const responses = openRequests.map(() => mockHandlerResponse());
    const pending = openRequests.map((request, index) => handleNetworkScanRequest(request, responses[index].response));
    responses.forEach(({ state }) => { state.destroyed = true; state.emit("close"); });
    await Promise.all(pending);
    responses.forEach(({ state }) => { expect(state.end).not.toHaveBeenCalled(); });
    const restarted = mockHandlerRequest("POST", "application/json", "disconnect-client");
    restarted.body = {};
    const response = mockHandlerResponse();
    await handleNetworkScanRequest(restarted, response.response);
    expect(response.state.statusCode).toBe(400);
    openRequests.forEach((request) => request.end());
  });
});
