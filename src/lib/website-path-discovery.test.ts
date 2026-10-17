import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebsitePathValidator, requestNetworkScan, scanWebsitePaths } from "./network-scan";
import { exposureProbeUrls } from "./exposure-path";
import { MAX_PATH_SCRIPT_DOCUMENTS } from "./website-path-kind";
import { discoverWebsitePaths, exportDiscoveredWebsitePathsCsv, PATH_DISCOVERY_DURATION_MS, PATH_DISCOVERY_SOURCES, SCRIPT_DISCOVERY_TIMEOUT_MS } from "./website-path-discovery";

vi.mock("./network-scan", async importOriginal => ({
  ...await importOriginal<typeof import("./network-scan")>(), requestNetworkScan: vi.fn(), scanWebsitePaths: vi.fn(), createWebsitePathValidator: vi.fn()
}));
const origin = "https://example.com";
function settings(baseUrl = `${origin}/`) {
  return { baseUrl, concurrency: 4, timeoutMs: 5000, signal: new AbortController().signal,
    onSource: vi.fn(), onResult: vi.fn(), onProgress: vi.fn() };
}
function candidate(path: string, source = "links", kind = "page") { return { url: `${origin}${path}`, source, kind }; }
function document(payload: Record<string, unknown>, candidates: unknown[] = [], status = "success", message?: string) {
  return { source: payload.source, url: payload.url, status, candidates, ...(message ? { message } : {}) };
}
beforeEach(() => {
  vi.mocked(createWebsitePathValidator).mockImplementation(async configuration => async (url, signal) => {
    let result: Parameters<Parameters<typeof scanWebsitePaths>[0]["onResult"]>[0] | undefined;
    await scanWebsitePaths({ ...configuration, candidates: [url], concurrency: 1, signal,
      onResult: value => { result = value; } });
    if (!result) throw new Error("Validation mock returned no result");
    return result;
  });
  vi.mocked(requestNetworkScan).mockImplementation(async payload => document(payload));
  vi.mocked(scanWebsitePaths).mockImplementation(async options => {
    options.candidates.forEach(url => options.onResult({ url, status: "responded", statusCode: 200 }));
  });
});
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); });

describe("observed website path discovery", () => {
  it("resolves a followed same-origin redirect chain while preserving every actual HTTP response", async () => {
    let firstReads = 0;
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      if (payload.source !== "links") return document(payload);
      const path = new URL(String(payload.url)).pathname;
      if (path === "/first" && ++firstReads === 1) return { ...document(payload, [], "error", "connection failed"), retryable: true };
      const target = path === "/first" ? "/second" : path === "/second" ? "/final" : undefined;
      const statusCode = path === "/first" ? 302 : path === "/second" ? 307 : 200;
      return { ...document(payload, path === "/" ? [candidate("/first")] : target ? [candidate(target)] : [],
        target ? "partial" : "success", target ? "文档返回重定向，已保留同源跳转地址" : undefined),
        response: { url: String(payload.url), status: "responded", statusCode, ...(target ? { location: target } : {}) } };
    });
    vi.mocked(createWebsitePathValidator).mockImplementation(async () => async (url, _signal, observed) => observed ?? { url, status: "responded", statusCode: 200 });
    const options = settings();
    const summary = await discoverWebsitePaths(options);
    expect(summary.sources.find(source => source.source === "links")).toMatchObject({ status: "success", issueCount: 3, unresolvedIssueCount: 0,
      issues: [expect.objectContaining({ url: `${origin}/first`, kind: "request", message: "connection failed", resolved: true }),
        expect.objectContaining({ url: `${origin}/first`, kind: "request", statusCode: 302, resolved: true }),
        expect.objectContaining({ url: `${origin}/second`, kind: "request", statusCode: 307, resolved: true })] });
    expect(summary.diagnostics).toMatchObject({ documentsFailed: 0, failedAttempts: 1, recoveredDocuments: 1 });
    expect(summary.sources.find(source => source.source === "links")?.message).toBeUndefined();
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/first`, statusCode: 302 }));
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/final`, statusCode: 200 }));
  });

  it.each(["failed", "cross-origin", "cycle", "unfollowed"])("retains an unresolved redirect when its target is %s", async reason => {
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      if (payload.source !== "links") return document(payload);
      const path = new URL(String(payload.url)).pathname;
      const target = path === "/first" ? reason === "cross-origin" ? "https://other.com/target" : "/second" : path === "/second" && reason === "cycle" ? "/first" : undefined;
      const missing = path === "/second" && reason === "failed";
      const start = reason === "unfollowed" ? "/level-1" : "/first";
      const candidates = path === "/" ? [candidate(start)] : path === "/level-1" ? [candidate("/level-2")]
        : path === "/level-2" ? [candidate("/first")] : target && reason !== "cross-origin" ? [candidate(target)] : [];
      return { ...document(payload, candidates, missing || target && reason === "cross-origin" ? "error" : target ? "partial" : "success",
        missing ? "文档返回 HTTP 403" : target ? "文档返回重定向" : undefined),
        response: { url: String(payload.url), status: "responded", statusCode: missing ? 403 : target ? 302 : 200,
          ...(target ? { location: target } : {}) } };
    });
    const summary = await discoverWebsitePaths(settings());
    expect(summary.sources.find(source => source.source === "links")?.status).toBe("partial");
    expect(summary.sources.find(source => source.source === "links")?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: `${origin}/first`, kind: "request", resolved: false })
    ]));
    if (reason === "unfollowed") expect(vi.mocked(requestNetworkScan).mock.calls.some(([payload]) => payload.url === `${origin}/second`)).toBe(false);
    if (reason === "cross-origin") expect(vi.mocked(requestNetworkScan).mock.calls.some(([payload]) => String(payload.url).startsWith("https://other.com"))).toBe(false);
  });

  it("traverses a complete 188-import module closure, including shared dependencies and the final feature module", async () => {
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      if (payload.source === "links" && payload.url === `${origin}/`) return document(payload, [candidate("/assets/main.js", "links", "script")]);
      if (payload.url === `${origin}/assets/main.js`) return document(payload,
        Array.from({ length: 188 }, (_, index) => candidate(`/assets/chunk-${index}.js`, "scripts", "script")));
      const index = String(payload.url).match(/\/chunk-(\d+)\.js$/)?.[1];
      if (index !== undefined) return document(payload, [candidate("/assets/shared.js", "scripts", "script"),
        { ...candidate(`/service/chunk-${index}`, "scripts"), evidence: { kind: "request", documentUrl: String(payload.url) } },
        ...(index === "187" ? [candidate("/assets/final-feature.js", "scripts", "script")] : [])]);
      return document(payload, payload.url === `${origin}/assets/final-feature.js`
        ? [{ ...candidate("/service/final-feature", "scripts"), evidence: { kind: "request", documentUrl: String(payload.url) } }] : []);
    });
    const options = settings();
    const summary = await discoverWebsitePaths(options);
    const scriptReads = vi.mocked(requestNetworkScan).mock.calls.filter(([payload]) => payload.source === "scripts");
    expect(scriptReads).toHaveLength(191);
    expect(scriptReads.filter(([payload]) => payload.url === `${origin}/assets/shared.js`)).toHaveLength(1);
    expect(summary).toMatchObject({ discovered: 190, validated: 190, diagnostics: { scriptDocuments: 191 } });
    expect(summary.sources.find(source => source.source === "scripts")?.status).toBe("success");
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/service/chunk-187` }));
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/service/final-feature` }));
  });

  it("bounds an oversized module closure at the shared distinct-script limit and identifies the omitted URL", async () => {
    vi.mocked(requestNetworkScan).mockImplementation(async payload => document(payload,
      payload.source === "links" && payload.url === `${origin}/` ? [candidate("/main.js", "links", "script")]
        : payload.url === `${origin}/main.js` ? Array.from({ length: MAX_PATH_SCRIPT_DOCUMENTS }, (_, index) => candidate(`/chunk-${index}.js`, "scripts", "script"))
          : payload.url === `${origin}/chunk-${MAX_PATH_SCRIPT_DOCUMENTS - 2}.js` ? [{ ...candidate("/last-retained-path", "scripts"),
            evidence: { kind: "request", documentUrl: String(payload.url) } }] : []));
    const options = settings();
    const summary = await discoverWebsitePaths(options);
    expect(vi.mocked(requestNetworkScan).mock.calls.filter(([payload]) => payload.source === "scripts")).toHaveLength(MAX_PATH_SCRIPT_DOCUMENTS);
    expect(summary.diagnostics).toMatchObject({ scriptDocuments: MAX_PATH_SCRIPT_DOCUMENTS, skippedDocuments: 1 });
    expect(summary.sources.find(source => source.source === "scripts")).toMatchObject({ status: "partial", unresolvedIssueCount: 1,
      issues: [expect.objectContaining({ url: `${origin}/chunk-${MAX_PATH_SCRIPT_DOCUMENTS - 1}.js`, kind: "limit", message: expect.stringContaining(`${MAX_PATH_SCRIPT_DOCUMENTS} 份不同脚本文档上限`) })] });
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/last-retained-path` }));
  });

  it("accepts a source response containing the full independent page, module and sitemap budgets", async () => {
    const controller = new AbortController();
    let accepted!: () => void;
    const entryAccepted = new Promise<void>(resolve => { accepted = resolve; });
    vi.mocked(requestNetworkScan).mockImplementation(async (payload, signal) => {
      if (payload.source === "links" && payload.url === `${origin}/`) return document(payload,
        [...Array.from({ length: 2000 }, (_, index) => candidate(`/page-${index}`)),
          ...Array.from({ length: MAX_PATH_SCRIPT_DOCUMENTS }, (_, index) => candidate(`/chunk-${index}.js`, "links", "script")),
          ...Array.from({ length: 20 }, (_, index) => candidate(`/map-${index}.xml`, "links", "sitemap"))]);
      return await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const options = { ...settings(), signal: controller.signal };
    options.onSource.mockImplementation(source => { if (source.source === "links") accepted(); });
    const pending = discoverWebsitePaths(options);
    const stopped = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await entryAccepted;
    controller.abort();
    await stopped;
    const pages = options.onSource.mock.calls.find(([source]) => source.source === "links")![0];
    expect(pages.urls).toHaveLength(2000);
    expect(pages.message).not.toContain("无效或范围外");
    expect(options.onProgress.mock.calls.some(([progress]) => progress.diagnostics?.scriptDocuments === MAX_PATH_SCRIPT_DOCUMENTS)).toBe(true);
  });

  it("gives large script downloads an independent budget while keeping page and probe timeouts unchanged", async () => {
    vi.mocked(requestNetworkScan).mockImplementation(async payload => document(payload,
      payload.source === "links" && payload.url === `${origin}/` ? [candidate("/app.js", "links", "script")] : []));
    await discoverWebsitePaths({ ...settings(), timeoutMs: 3000 });
    const reads = vi.mocked(requestNetworkScan).mock.calls.map(([payload]) => payload);
    expect(reads.find(payload => payload.source === "scripts")).toMatchObject({ timeoutMs: SCRIPT_DISCOVERY_TIMEOUT_MS });
    expect(reads.filter(payload => payload.source === "links" || payload.source === "robots" || payload.source === "sitemap")
      .every(payload => payload.timeoutMs === 3000)).toBe(true);
    expect(reads.find(payload => payload.source === "wayback")).toHaveProperty("timeoutMs", 20000);
    expect(createWebsitePathValidator).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 3000 }));
  });

  it("dispatches newly discovered scripts immediately while a slower page is still reading", async () => {
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>(resolve => { releaseSlow = resolve; });
    const reads: string[] = [];
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      reads.push(String(payload.url));
      if (payload.url === `${origin}/slow`) await slowGate;
      return document(payload, payload.url === `${origin}/` && payload.source === "links"
        ? [candidate("/slow"), candidate("/fast"), candidate("/later-page")]
        : payload.url === `${origin}/fast` ? [candidate("/runtime.js", "links", "script")]
          : payload.url === `${origin}/runtime.js` ? [candidate("/api/mint/config", "scripts")] : []);
    });
    const options = { ...settings(), concurrency: 2 };
    const pending = discoverWebsitePaths(options);
    await vi.waitFor(() => expect(reads).toContain(`${origin}/runtime.js`));
    expect(reads.indexOf(`${origin}/runtime.js`)).toBeLessThan(reads.indexOf(`${origin}/later-page`));
    releaseSlow();
    await pending;
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/api/mint/config` }));
  });

  it("prioritizes script dependencies and nested sitemaps before ordinary pages while yielding for response feedback", async () => {
    const events: string[] = [];
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      events.push(`read:${payload.url}`);
      return document(payload, payload.url === `${origin}/` && payload.source === "links"
        ? [candidate("/first-page"), candidate("/app.js", "links", "script")]
        : payload.url === `${origin}/app.js` ? [candidate("/chunk.js", "scripts", "script")]
          : payload.url === `${origin}/sitemap.xml` ? [candidate("/nested.xml", "sitemap", "sitemap")] : []);
    });
    vi.mocked(createWebsitePathValidator).mockImplementation(async () => async url => {
      events.push(`validate:${url}`);
      return { url, status: "responded", statusCode: 200 };
    });
    await discoverWebsitePaths({ ...settings(), concurrency: 1 });
    const position = (value: string) => events.indexOf(`read:${origin}${value}`);
    expect(position("/app.js")).toBeLessThan(position("/first-page"));
    expect(position("/chunk.js")).toBeLessThan(position("/first-page"));
    expect(position("/nested.xml")).toBeLessThan(position("/first-page"));
    const firstValidation = events.findIndex(event => event.startsWith("validate:"));
    expect(firstValidation).toBeGreaterThan(position("/chunk.js"));
    expect(firstValidation).toBeLessThan(position("/first-page"));
  });

  it("validates request-only paths without reading each endpoint again as an HTML document", async () => {
    const endpoints = ["/actions/submit", "/report", "/data/items.json"];
    vi.mocked(requestNetworkScan).mockImplementation(async payload => document(payload,
      payload.source === "links" && payload.url === `${origin}/` ? [candidate("/app.js", "links", "script"), candidate("/guide")]
        : payload.source === "scripts" ? endpoints.map(path => ({ ...candidate(path, "scripts"),
          evidence: { kind: "request", documentUrl: `${origin}/app.js`, methods: ["POST"] } })) : []));
    const options = settings();
    const summary = await discoverWebsitePaths(options);
    expect(summary).toMatchObject({ discovered: 5, validated: 5 });
    const htmlReads = vi.mocked(requestNetworkScan).mock.calls.filter(([payload]) => payload.source === "links").map(([payload]) => payload.url);
    expect(htmlReads).toEqual([`${origin}/`, `${origin}/guide`]);
    for (const path of endpoints) expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}${path}`, sources: ["scripts"] }));
    expect(vi.mocked(scanWebsitePaths).mock.calls.flatMap(([call]) => call.candidates).filter(url => endpoints.some(path => url === `${origin}${path}`))).toHaveLength(3);
  });

  it("promotes an already validated request URL when a later navigation supplies page evidence", async () => {
    let releaseNavigation!: () => void;
    const navigationGate = new Promise<void>(resolve => { releaseNavigation = resolve; });
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      if (payload.url === `${origin}/navigation.js`) await navigationGate;
      return document(payload, payload.source === "links" && payload.url === `${origin}/`
        ? [candidate("/requests.js", "links", "script"), candidate("/navigation.js", "links", "script")]
        : payload.url === `${origin}/requests.js` ? [{ ...candidate("/report", "scripts"), evidence: { kind: "request", documentUrl: `${origin}/requests.js` } }]
          : payload.url === `${origin}/navigation.js` ? [{ ...candidate("/report", "scripts"), evidence: { kind: "navigation", documentUrl: `${origin}/navigation.js` } }]
            : payload.url === `${origin}/report` && payload.source === "links" ? [candidate("/report/details")] : []);
    });
    const options = settings();
    const pending = discoverWebsitePaths(options);
    await vi.waitFor(() => expect(options.onResult.mock.calls.some(([result]) => result.url === `${origin}/report`)).toBe(true));
    expect(vi.mocked(requestNetworkScan).mock.calls.some(([payload]) => payload.source === "links" && payload.url === `${origin}/report`)).toBe(false);
    releaseNavigation();
    await pending;
    expect(vi.mocked(requestNetworkScan).mock.calls.filter(([payload]) => payload.source === "links" && payload.url === `${origin}/report`)).toHaveLength(1);
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/report/details` }));
    expect(vi.mocked(scanWebsitePaths).mock.calls.flatMap(([call]) => call.candidates).filter(url => url === `${origin}/report`)).toHaveLength(1);
  });

  it.each([2, 4])("keeps response feedback flowing with %i workers while ordinary documents remain queued", async concurrency => {
    const events: string[] = [];
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      events.push(`read:${payload.url}`);
      return document(payload, payload.source === "links" && payload.url === `${origin}/`
        ? [candidate("/app.js", "links", "script"), ...Array.from({ length: 30 }, (_, index) => candidate(`/page-${index}`))] : []);
    });
    vi.mocked(createWebsitePathValidator).mockImplementation(async () => async url => {
      events.push(`validate:${url}`);
      return { url, status: "responded", statusCode: 200 };
    });
    const summary = await discoverWebsitePaths({ ...settings(), concurrency });
    const firstValidation = events.findIndex(event => event.startsWith("validate:"));
    expect(firstValidation).toBeLessThan(events.indexOf(`read:${origin}/page-29`));
    expect(events.indexOf(`read:${origin}/app.js`)).toBeLessThan(events.indexOf(`read:${origin}/page-0`));
    expect(summary.validated).toBe(summary.discovered);
  });

  it("yields a single worker for validation within a four-document quantum even with a continuous script chain", async () => {
    const events: string[] = [];
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      events.push(`read:${payload.url}`);
      const index = Number(String(payload.url).match(/chunk-(\d+)\.js$/)?.[1]);
      return document(payload, payload.source === "links" && payload.url === `${origin}/` ? [candidate("/chunk-0.js", "links", "script")]
        : payload.source === "scripts" && index < 12 ? [candidate(`/chunk-${index + 1}.js`, "scripts", "script")] : []);
    });
    vi.mocked(createWebsitePathValidator).mockImplementation(async () => async url => {
      events.push(`validate:${url}`);
      return { url, status: "responded", statusCode: 200 };
    });
    await discoverWebsitePaths({ ...settings(), concurrency: 1 });
    const firstValidation = events.findIndex(event => event.startsWith("validate:"));
    expect(events.slice(0, firstValidation).filter(event => event.startsWith("read:"))).toHaveLength(4);
    expect(firstValidation).toBeLessThan(events.indexOf(`read:${origin}/chunk-12.js`));
  });

  it("replays a parsed page and script graph when a later sitemap gives the page a shorter route", async () => {
    let releaseMap!: () => void;
    const mapGate = new Promise<void>(resolve => { releaseMap = resolve; });
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      if (payload.source === "sitemap") { await mapGate; return document(payload, [candidate("/shared.html", "sitemap")]); }
      const graph: Record<string, unknown[]> = {
        "links:/": [candidate("/level-1")], "links:/level-1": [candidate("/level-2")],
        "links:/level-2": [candidate("/shared.html")], "links:/shared.html": [candidate("/app.js", "links", "script")],
        "scripts:/app.js": [candidate("/chunk.js", "scripts", "script")], "scripts:/chunk.js": [candidate("/child", "scripts")],
        "links:/child": [candidate("/grandchild")]
      };
      return document(payload, graph[`${payload.source}:${new URL(String(payload.url)).pathname}`] ?? []);
    });
    const options = settings();
    const pending = discoverWebsitePaths(options);
    await vi.waitFor(() => expect(options.onSource.mock.calls.some(([source]) => source.urls.includes(`${origin}/child`))).toBe(true));
    expect(vi.mocked(requestNetworkScan).mock.calls.some(([payload]) => payload.source === "links" && payload.url === `${origin}/child`)).toBe(false);
    releaseMap();
    const summary = await pending;
    for (const url of ["/shared.html", "/app.js", "/chunk.js", "/child", "/grandchild"]) {
      expect(vi.mocked(requestNetworkScan).mock.calls.filter(([payload]) => payload.url === `${origin}${url}`)).toHaveLength(1);
    }
    expect(summary.diagnostics?.scriptDocuments).toBe(2);
    expect(summary.sources.find(source => source.source === "links")?.status).toBe("success");
    expect(summary.sources.flatMap(source => source.issues ?? []).some(issue => !issue.resolved && issue.kind === "limit")).toBe(false);
    expect(summary.diagnostics?.skippedDocuments).toBe(0);
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/grandchild` }));
  });

  it("reuses completed public document responses, including HTTP 404, without extra validation GETs", async () => {
    const validated: { url: string; observed?: unknown }[] = [];
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      const missing = payload.url === `${origin}/missing`;
      return { ...document(payload, payload.source === "links" && payload.url === `${origin}/` ? [candidate("/missing")] : [], missing ? "error" : "success"),
        ...(payload.source === "links" ? { response: { url: String(payload.url), status: "responded", statusCode: missing ? 404 : 200,
          fingerprint: missing ? "missing" : "actual", contentLength: missing ? 77 : 123, durationMs: missing ? 31 : 62 } } : {}) };
    });
    vi.mocked(createWebsitePathValidator).mockImplementation(async () => async (url, _signal, observed) => {
      validated.push({ url, observed });
      return observed ? { ...observed, responseReused: true } : { url, status: "responded", statusCode: 200 };
    });
    const options = settings();
    const summary = await discoverWebsitePaths(options);
    expect(summary).toMatchObject({ discovered: 2, validated: 2, diagnostics: { reusedResponses: 2 } });
    for (const url of [`${origin}/`, `${origin}/missing`]) expect(validated.find(result => result.url === url)?.observed).toEqual(expect.objectContaining({ url, status: "responded" }));
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/missing`, statusCode: 404, durationMs: 31, responseReused: true }));
  });

  it("retains a real upstream response when a later transient document retry loses its connection", async () => {
    let attempts = 0;
    let observedCode: number | undefined;
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      if (payload.source === "links" && payload.url === `${origin}/`) return document(payload, [candidate("/upstream")]);
      if (payload.url === `${origin}/upstream`) {
        attempts++;
        return { ...document(payload, [], "error"), retryable: true, ...(attempts === 1 ? { response: { url: String(payload.url), status: "responded", statusCode: 503 } } : {}) };
      }
      return document(payload);
    });
    vi.mocked(createWebsitePathValidator).mockImplementation(async () => async (url, _signal, observed) => {
      if (url === `${origin}/upstream`) observedCode = observed?.statusCode;
      return observed ? { ...observed, responseReused: true } : { url, status: "responded", statusCode: 200 };
    });
    const options = settings();
    await discoverWebsitePaths(options);
    expect(attempts).toBe(2);
    expect(observedCode).toBe(503);
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/upstream`, statusCode: 503, responseReused: true }));
  });

  it.each(["get", "BAD METHOD"])("rejects a mismatched reused response and invalid declared method %s before accepting source candidates", async method => {
    vi.mocked(requestNetworkScan).mockImplementation(async payload => payload.source === "links" && payload.url === `${origin}/`
      ? { ...document(payload, [candidate("/untrusted")]), response: { url: `${origin}/other`, status: "responded", statusCode: 200 } }
      : payload.source === "wayback" ? document(payload, [{ ...candidate("/bad-method", "wayback"), evidence: { kind: "request", documentUrl: `${origin}/archive`, methods: [method] } }])
        : document(payload));
    const options = settings();
    const summary = await discoverWebsitePaths(options);
    expect(summary.sources.find(source => source.source === "links")?.status).toBe("error");
    expect(summary.sources.find(source => source.source === "wayback")?.status).toBe("error");
    expect(options.onResult.mock.calls.some(([result]) => ["/untrusted", "/bad-method"].some(path => result.url === `${origin}${path}`))).toBe(false);
  });

  it.each(["M-SEARCH", "PURGE"])("accepts a valid declared HTTP token %s without issuing that method", async method => {
    vi.mocked(requestNetworkScan).mockImplementation(async payload => document(payload,
      payload.source === "links" && payload.url === `${origin}/` ? [candidate("/app.js", "links", "script")]
        : payload.source === "scripts" ? [{ ...candidate("/custom-method", "scripts"), evidence: { kind: "request", documentUrl: `${origin}/app.js`, methods: [method] } }] : []));
    const options = settings();
    await discoverWebsitePaths(options);
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/custom-method`, evidence: [{ kind: "request", documentUrl: `${origin}/app.js`, methods: [method] }] }));
    expect(vi.mocked(requestNetworkScan).mock.calls.every(([payload]) => payload.method === undefined)).toBe(true);
  });

  it("merges declared methods for one source document without duplicate evidence and exports all methods", async () => {
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
    const sharedEvidence = { kind: "request", documentUrl: `${origin}/shared.js` };
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      if (payload.url === `${origin}/second.js`) await secondGate;
      return document(payload, payload.source === "links" && payload.url === `${origin}/`
        ? [candidate("/first.js", "links", "script"), candidate("/second.js", "links", "script")]
        : payload.source === "scripts" ? [{ ...candidate("/action", "scripts"), evidence: { ...sharedEvidence,
          methods: payload.url === `${origin}/first.js` ? ["POST"] : ["GET", "POST"], bytes: 1024, truncated: false } }] : []);
    });
    const options = settings();
    const pending = discoverWebsitePaths(options);
    await vi.waitFor(() => expect(options.onResult.mock.calls.some(([result]) => result.url === `${origin}/action`)).toBe(true));
    const firstResult = options.onResult.mock.calls.find(([result]) => result.url === `${origin}/action`)![0];
    releaseSecond();
    await pending;
    const result = options.onResult.mock.calls.map(([result]) => result).filter(result => result.url === `${origin}/action`).at(-1)!;
    expect(result.evidence).toEqual([{ ...sharedEvidence, methods: ["POST", "GET"], bytes: 1024, truncated: false }]);
    expect(firstResult.evidence?.[0].methods).toEqual(["POST"]);
    const csv = exportDiscoveredWebsitePathsCsv([result]);
    expect(csv.split(/\r?\n/u)[0].split(",")).toContain("declared_methods");
    expect(csv).toContain('"POST; GET"');
  });

  it("charges shared script URLs once while parsing distinct owner directories and retaining later chunks", async () => {
    const owners = Array.from({ length: 49 }, (_, index) => `/owner-${index}/index.html`);
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      if (payload.source === "links" && payload.url === `${origin}/`) return document(payload, owners.map(path => candidate(path)));
      if (payload.source === "links" && owners.some(path => payload.url === `${origin}${path}`)) return document(payload,
        [candidate("/shared.js", "links", "script"), ...(payload.url === `${origin}${owners.at(-1)}` ? [candidate("/last-chunk.js", "links", "script")] : [])]);
      if (payload.source === "scripts" && payload.url === `${origin}/shared.js`) return document(payload,
        [{ url: new URL("api/owner", String(payload.documentUrl)).href, source: "scripts", kind: "page" }]);
      return document(payload, payload.url === `${origin}/last-chunk.js` ? [candidate("/api/mint/config", "scripts")] : []);
    });
    const options = settings();
    const summary = await discoverWebsitePaths(options);
    expect(summary.diagnostics?.scriptDocuments).toBe(2);
    const shared = vi.mocked(requestNetworkScan).mock.calls.filter(([payload]) => payload.url === `${origin}/shared.js`);
    expect(shared).toHaveLength(49);
    expect(new Set(shared.map(([payload]) => payload.scanId)).size).toBe(1);
    expect(shared[0][0].scanId).toEqual(expect.any(String));
    for (const index of [0, 48]) expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/owner-${index}/api/owner` }));
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/api/mint/config` }));
  });

  it("shares the parsing context for scripts whose owners have the same directory", async () => {
    vi.mocked(requestNetworkScan).mockImplementation(async payload => document(payload,
      payload.source === "links" && payload.url === `${origin}/`
        ? [candidate("/docs/first.html"), candidate("/docs/second.html")]
        : payload.source === "links" && String(payload.url).includes("/docs/") ? [candidate("/shared.js", "links", "script")] : []));
    await discoverWebsitePaths(settings());
    expect(vi.mocked(requestNetworkScan).mock.calls.filter(([payload]) => payload.url === `${origin}/shared.js`)).toHaveLength(1);
  });

  it.each([1, 2, 4, 8])("shares a strict %i-request cap across documents, archive, baseline and validation", async concurrency => {
    let active = 0;
    let peak = 0;
    const track = async () => { peak = Math.max(peak, ++active); await Promise.resolve(); await Promise.resolve(); active--; };
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      await track();
      return document(payload, payload.source === "links" && payload.url === `${origin}/`
        ? [...Array.from({ length: 12 }, (_, index) => candidate(`/page-${index}`)), candidate("/app.js", "links", "script")] : []);
    });
    vi.mocked(createWebsitePathValidator).mockImplementation(async () => {
      await track();
      return async url => { await track(); return { url, status: "responded", statusCode: 200 }; };
    });
    const summary = await discoverWebsitePaths({ ...settings(), concurrency });
    expect(summary.validated).toBe(summary.discovered);
    expect(peak).toBeLessThanOrEqual(concurrency);
    expect(active).toBe(0);
  });

  it.each(["error", "partial"])("retries a transient %s document once and preserves paths found by either attempt", async status => {
    let attempts = 0;
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      if (payload.source === "links" && payload.url === `${origin}/`) return document(payload, [candidate("/app.js", "links", "script")]);
      if (payload.source === "scripts") {
        attempts++;
        if (attempts === 1) return { ...document(payload, status === "partial" ? [candidate("/partial-path", "scripts")] : [], status, "temporary upstream failure"), retryable: true };
        return document(payload, [candidate("/api/mint/config", "scripts")]);
      }
      return document(payload);
    });
    const options = settings();
    const summary = await discoverWebsitePaths(options);
    expect(attempts).toBe(2);
    expect(summary.diagnostics).toMatchObject({ retryAttempts: 1, scriptDocuments: 1 });
    expect(summary.diagnostics).toMatchObject({ documentsFailed: 0, failedAttempts: 1, recoveredDocuments: 1 });
    const source = summary.sources.find(source => source.source === "scripts")!;
    expect(source).toMatchObject({ status: "success", unresolvedIssueCount: 0,
      issues: [{ url: `${origin}/app.js`, source: "scripts", kind: "request", message: "temporary upstream failure", resolved: true, attempts: 2 }] });
    expect(source.message).toBeUndefined();
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/api/mint/config` }));
    if (status === "partial") expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/partial-path` }));
  });

  it("keeps repeated partial transport failures unresolved without reporting a false recovery", async () => {
    let attempts = 0;
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      if (payload.source === "links" && payload.url === `${origin}/`) return document(payload, [candidate("/app.js", "links", "script")]);
      if (payload.source === "scripts") {
        attempts++;
        return { ...document(payload, [{ ...candidate(`/attempt-${attempts}`, "scripts"),
          evidence: { kind: "request", documentUrl: String(payload.url) } }], "partial", "temporary connection failure"), retryable: true };
      }
      return document(payload);
    });
    const options = settings();
    const summary = await discoverWebsitePaths(options);
    expect(summary.sources.find(source => source.source === "scripts")).toMatchObject({ status: "partial", issueCount: 1, unresolvedIssueCount: 1,
      issues: [{ url: `${origin}/app.js`, kind: "request", message: "temporary connection failure", resolved: false, attempts: 2 }] });
    expect(summary.diagnostics).toMatchObject({ documentsFailed: 1, failedAttempts: 2, recoveredDocuments: 0 });
    for (const path of ["/attempt-1", "/attempt-2"]) expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}${path}` }));
  });

  it("retains an unresolved read failure when its queued retry is cancelled by the discovery deadline", async () => {
    vi.useFakeTimers();
    let retryReads = 0;
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      if (payload.source === "links" && payload.url === `${origin}/`) return document(payload,
        [candidate("/retry.js", "links", "script"), ...Array.from({ length: 4 }, (_, index) => candidate(`/slow-${index}.js`, "links", "script"))]);
      if (payload.url === `${origin}/retry.js`) {
        retryReads++;
        return { ...document(payload, [], "error", "connection failed"), retryable: true };
      }
      if (payload.source === "scripts") return new Promise(() => {});
      return document(payload);
    });
    const pending = discoverWebsitePaths({ ...settings(), concurrency: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(retryReads).toBe(1);
    await vi.advanceTimersByTimeAsync(PATH_DISCOVERY_DURATION_MS + 1);
    const summary = await pending;
    expect(retryReads).toBe(1);
    expect(summary.diagnostics).toMatchObject({ documentsFailed: 1, failedAttempts: 1, recoveredDocuments: 0, deadlineReached: true });
    expect(summary.sources.find(source => source.source === "scripts")?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: `${origin}/retry.js`, kind: "request", resolved: false, attempts: 1 }),
      expect.objectContaining({ url: `${origin}/retry.js`, kind: "limit" })
    ]));
    expect(summary.validated).toBe(summary.discovered);
  });

  it("does not retry permanent failures, and bounds repeated transient failures at two attempts", async () => {
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      if (payload.source === "links" && payload.url === `${origin}/`) return document(payload,
        [candidate("/missing.js", "links", "script"), candidate("/broken.js", "links", "script")]);
      if (payload.source === "scripts") return { ...document(payload, [], "error", "upstream failure"), retryable: payload.url === `${origin}/broken.js` };
      return document(payload);
    });
    const summary = await discoverWebsitePaths(settings());
    const calls = vi.mocked(requestNetworkScan).mock.calls;
    expect(calls.filter(([payload]) => payload.url === `${origin}/missing.js`)).toHaveLength(1);
    expect(calls.filter(([payload]) => payload.url === `${origin}/broken.js`)).toHaveLength(2);
    expect(summary.sources.find(source => source.source === "scripts")?.status).toBe("error");
    expect(summary.diagnostics?.retryAttempts).toBe(1);
    expect(summary.diagnostics).toMatchObject({ documentsFailed: 2, failedAttempts: 3, recoveredDocuments: 0 });
    expect(summary.sources.find(source => source.source === "scripts")?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: `${origin}/broken.js`, resolved: false, attempts: 2 }),
      expect.objectContaining({ url: `${origin}/missing.js`, resolved: false, attempts: 1 })
    ]));
  });

  it.each([404, 410])("keeps a non-entry HTTP %i as a verified absence without marking page discovery incomplete", async statusCode => {
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      const missing = payload.url === `${origin}/absent`;
      return { ...document(payload, payload.source === "links" && payload.url === `${origin}/` ? [candidate("/absent")] : [], missing ? "error" : "success",
        missing ? `文档返回 HTTP ${statusCode}` : undefined),
        ...(payload.source === "links" ? { response: { url: String(payload.url), status: "responded", statusCode: missing ? statusCode : 200 } } : {}) };
    });
    vi.mocked(createWebsitePathValidator).mockImplementation(async () => async (url, _signal, observed) => observed ?? { url, status: "responded", statusCode: 200 });
    const options = settings();
    const summary = await discoverWebsitePaths(options);
    const pages = summary.sources.find(source => source.source === "links")!;
    expect(pages).toMatchObject({ status: "success", issueCount: 1, unresolvedIssueCount: 0,
      issues: [{ url: `${origin}/absent`, source: "links", kind: "missing", statusCode, resolved: true, attempts: 1 }] });
    expect(pages.message).toBeUndefined();
    expect(summary.diagnostics?.documentsFailed).toBe(0);
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/absent`, statusCode }));
  });

  it("keeps a missing entry and a missing required script as separate unresolved document issues", async () => {
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      const missing = payload.source === "links" && payload.url === `${origin}/entry` || payload.source === "scripts" && payload.url === `${origin}/missing.js`;
      return { ...document(payload, payload.source === "links" && payload.url === `${origin}/`
        ? [candidate("/missing.js", "links", "script")] : [], missing ? "error" : "success", missing ? "文档返回 HTTP 404" : undefined),
        ...(missing ? { response: { url: String(payload.url), status: "responded", statusCode: 404 } } : {}) };
    });
    const summary = await discoverWebsitePaths(settings(`${origin}/entry`));
    expect(summary.sources.find(source => source.source === "links")).toMatchObject({ status: "partial", unresolvedIssueCount: 1,
      issues: [expect.objectContaining({ url: `${origin}/entry`, kind: "missing", statusCode: 404, resolved: false })] });
    expect(summary.sources.find(source => source.source === "scripts")).toMatchObject({ status: "error", unresolvedIssueCount: 1,
      issues: [expect.objectContaining({ url: `${origin}/missing.js`, kind: "missing", statusCode: 404, resolved: false })] });
    expect(summary.diagnostics?.documentsFailed).toBe(2);
  });

  it("reports exact parser and archive failure documents without hiding genuine remaining limits", async () => {
    vi.mocked(requestNetworkScan).mockImplementation(async payload => document(payload,
      payload.source === "links" && payload.url === `${origin}/` ? [candidate("/app.js", "links", "script")] : [],
      payload.source === "scripts" ? "partial" : payload.source === "wayback" ? "error" : "success",
      payload.source === "scripts" ? "脚本语法不完整，仅恢复独立完整导入" : payload.source === "wayback" ? "Wayback 返回 HTTP 429" : undefined));
    const summary = await discoverWebsitePaths(settings());
    expect(summary.sources.find(source => source.source === "scripts")).toMatchObject({ status: "partial", unresolvedIssueCount: 1,
      issues: [{ url: `${origin}/app.js`, source: "scripts", kind: "parse", message: "脚本语法不完整，仅恢复独立完整导入", resolved: false, attempts: 1 }] });
    expect(summary.sources.find(source => source.source === "wayback")).toMatchObject({ status: "error", unresolvedIssueCount: 1,
      issues: [{ url: `${origin}/`, source: "wayback", kind: "request", message: "Wayback 返回 HTTP 429", resolved: false, attempts: 1 }] });
    expect(summary.diagnostics).toMatchObject({ documentsFailed: 1, failedAttempts: 1, recoveredDocuments: 0 });
  });

  it("bounds issue details to forty while retaining exact totals and prioritizing unresolved documents", async () => {
    let recoveredAttempts = 0;
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      if (payload.source === "links" && payload.url === `${origin}/`) return document(payload,
        [candidate("/recovered"), ...Array.from({ length: 50 }, (_, index) => candidate(`/broken-${index}`))]);
      if (payload.url === `${origin}/recovered` && ++recoveredAttempts === 1) return { ...document(payload, [], "error", "temporary failure"), retryable: true };
      if (String(payload.url).includes("/broken-")) return document(payload, [], "error", "connection failed");
      return document(payload);
    });
    const summary = await discoverWebsitePaths(settings());
    const pages = summary.sources.find(source => source.source === "links")!;
    expect(pages).toMatchObject({ status: "partial", issueCount: 51, unresolvedIssueCount: 50 });
    expect(pages.issues).toHaveLength(40);
    expect(pages.issues?.every(issue => !issue.resolved && issue.url.includes("/broken-"))).toBe(true);
    expect(summary.diagnostics).toMatchObject({ documentsFailed: 50, failedAttempts: 51, recoveredDocuments: 1 });
  });

  it("isolates a validation transport failure and continues every accepted candidate", async () => {
    vi.mocked(requestNetworkScan).mockImplementation(async payload => document(payload,
      payload.source === "links" && payload.url === `${origin}/` ? [candidate("/broken"), candidate("/survives")] : []));
    vi.mocked(createWebsitePathValidator).mockImplementation(async () => async url => {
      if (url === `${origin}/broken`) throw new TypeError("Failed to fetch");
      return { url, status: "responded", statusCode: 200 };
    });
    const options = settings();
    expect(await discoverWebsitePaths(options)).toMatchObject({ discovered: 3, validated: 3 });
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/broken`, status: "error", message: "Failed to fetch" }));
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/survives`, statusCode: 200 }));
  });

  it("merges concrete discovery evidence without losing earlier results and exports the source documents", async () => {
    let releaseOther!: () => void;
    const otherGate = new Promise<void>(resolve => { releaseOther = resolve; });
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      if (payload.url === `${origin}/other.js`) await otherGate;
      return document(payload, payload.source === "links" && payload.url === `${origin}/`
        ? [candidate("/app.js", "links", "script"), candidate("/other.js", "links", "script")]
        : payload.source === "scripts" ? [{ ...candidate("/api/mint/config", "scripts"), evidence: { kind: "request", documentUrl: String(payload.url) } }] : []);
    });
    const options = settings();
    const pending = discoverWebsitePaths(options);
    await vi.waitFor(() => expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/api/mint/config`, evidence: [{ kind: "request", documentUrl: `${origin}/app.js` }] })));
    releaseOther();
    await pending;
    const result = options.onResult.mock.calls.map(([result]) => result).filter(result => result.url === `${origin}/api/mint/config`).at(-1)!;
    expect(result.evidence).toEqual(expect.arrayContaining([
      { kind: "request", documentUrl: `${origin}/app.js` }, { kind: "request", documentUrl: `${origin}/other.js` }
    ]));
    expect(exportDiscoveredWebsitePathsCsv([result])).toContain(`${origin}/app.js; ${origin}/other.js`);
    expect(vi.mocked(scanWebsitePaths).mock.calls.flatMap(([call]) => call.candidates).filter(url => url === `${origin}/api/mint/config`)).toHaveLength(1);
  });

  it("bounds repeated evidence to eight unique entries and rejects out-of-scope document metadata", async () => {
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      if (payload.source === "links" && payload.url === `${origin}/`) return document(payload, Array.from({ length: 10 }, (_, index) => candidate(`/chunk-${index}.js`, "links", "script")));
      if (payload.source === "scripts") return document(payload, [{ ...candidate("/shared-path", "scripts"), evidence: { kind: "request", documentUrl: String(payload.url) } }]);
      if (payload.source === "wayback") return { ...document(payload, [candidate("/untrusted", "wayback")]), document: { url: "https://other.com/source.js", bytes: 20, truncated: false } };
      return document(payload);
    });
    const options = settings();
    const summary = await discoverWebsitePaths(options);
    const result = options.onResult.mock.calls.map(([result]) => result).filter(result => result.url === `${origin}/shared-path`).at(-1)!;
    expect(result.evidence).toHaveLength(8);
    expect(summary.sources.find(source => source.source === "wayback")?.status).toBe("error");
    expect(options.onResult).not.toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/untrusted` }));
  });

  it("does not retry or emit evidence from a document that resolves after cancellation", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let scriptStarted!: () => void;
    const started = new Promise<void>(resolve => { scriptStarted = resolve; });
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      if (payload.source === "links" && payload.url === `${origin}/`) return document(payload, [candidate("/app.js", "links", "script")]);
      if (payload.source === "scripts") {
        scriptStarted();
        await gate;
        return { ...document(payload, [candidate("/late-path", "scripts")], "partial"), retryable: true };
      }
      return document(payload);
    });
    const controller = new AbortController();
    const options = { ...settings(), signal: controller.signal };
    const pending = discoverWebsitePaths(options);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await started;
    controller.abort();
    await rejected;
    release();
    await Promise.resolve();
    expect(vi.mocked(requestNetworkScan).mock.calls.filter(([payload]) => payload.source === "scripts")).toHaveLength(1);
    expect(options.onResult).not.toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/late-path` }));
  });

  it("cancels slow discovery immediately when validation initialization fails", async () => {
    let archiveStarted = false;
    let archiveAborted = false;
    vi.mocked(requestNetworkScan).mockImplementation(async (payload, signal) => {
      if (payload.source === "wayback") {
        archiveStarted = true;
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => { archiveAborted = true; reject(signal.reason); }, { once: true }));
      }
      return document(payload);
    });
    vi.mocked(createWebsitePathValidator).mockRejectedValue(new Error("验证服务不可用"));
    await expect(discoverWebsitePaths(settings())).rejects.toThrow("验证服务不可用");
    expect(archiveStarted).toBe(true);
    expect(archiveAborted).toBe(true);
  });

  it("does not recycle the 2000-site-path budget when late evidence removes already verified resources", async () => {
    let releasePage!: () => void;
    const pageGate = new Promise<void>(resolve => { releasePage = resolve; });
    const originalPaths = Array.from({ length: 1999 }, (_, index) => `/old-${index}`);
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      if (payload.source === "wayback") return document(payload, originalPaths.map(path => candidate(path, "wayback")));
      if (payload.source === "links" && payload.url === `${origin}/`) {
        await pageGate;
        return { ...document(payload, Array.from({ length: 1999 }, (_, index) => candidate(`/new-${index}`))), ignoredUrls: originalPaths.map(path => `${origin}${path}`) };
      }
      return document(payload);
    });
    const options = settings();
    const pending = discoverWebsitePaths(options);
    // The pending homepage read is reused once it completes; historical paths
    // can all validate first without duplicating that in-flight HTML request.
    await vi.waitFor(() => expect(options.onProgress.mock.calls.some(([progress]) => progress.phase === "discovering" && progress.completed === 1999)).toBe(true));
    releasePage();
    expect(await pending).toMatchObject({ discovered: 1, validated: 1, truncated: true });
    const probes = new Set(exposureProbeUrls(origin));
    const siteRequests = vi.mocked(scanWebsitePaths).mock.calls.flatMap(([call]) => call.candidates).filter(url => !probes.has(url));
    expect(siteRequests).toHaveLength(2000);
    expect(siteRequests.some(url => url.includes("/new-"))).toBe(false);
  });

  it("streams verified paths before the archive finishes and updates later provenance without repeating requests", async () => {
    let releaseArchive!: () => void;
    const archiveGate = new Promise<void>(resolve => { releaseArchive = resolve; });
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      if (payload.source === "wayback") {
        await archiveGate;
        return document(payload, [candidate("/early", "wayback"), candidate("/late", "wayback")]);
      }
      return document(payload, payload.source === "links" && payload.url === `${origin}/` ? [candidate("/early")] : []);
    });
    const options = settings();
    let finished = false;
    const pending = discoverWebsitePaths(options).then(result => { finished = true; return result; });
    await vi.waitFor(() => expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/early`, sources: ["links"] })));
    expect(finished).toBe(false);
    expect(options.onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: "discovering", completed: expect.any(Number), discoveryCompleted: expect.any(Number) }));
    releaseArchive();
    expect(await pending).toMatchObject({ discovered: 3, validated: 3 });
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/early`, sources: ["links", "wayback"] }));
    const requested = vi.mocked(scanWebsitePaths).mock.calls.flatMap(([call]) => call.candidates);
    expect(requested.filter(url => url === `${origin}/early`)).toHaveLength(1);
    expect(createWebsitePathValidator).toHaveBeenCalledTimes(1);
  });

  it("removes a streamed resource and retracts exposure when later scripts declare the route", async () => {
    let releasePage!: () => void;
    let releaseRoutes!: () => void;
    const pageGate = new Promise<void>(resolve => { releasePage = resolve; });
    const routeGate = new Promise<void>(resolve => { releaseRoutes = resolve; });
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      if (payload.source === "wayback") return document(payload, [candidate("/styles", "wayback"), candidate("/console/", "wayback")]);
      if (payload.source === "links" && payload.url === `${origin}/`) {
        await pageGate;
        return { ...document(payload, [candidate("/app.js", "links", "script")]), ignoredUrls: [`${origin}/styles`] };
      }
      if (payload.source === "scripts") {
        await routeGate;
        return document(payload, [{ ...candidate("/console/", "scripts"), clientRoute: true }]);
      }
      return document(payload);
    });
    vi.mocked(scanWebsitePaths).mockImplementation(async call => call.candidates.forEach(url => call.onResult({ url,
      status: "responded", statusCode: 200, fingerprint: "actual", missingPathBaseline: { statusCode: 404, fingerprint: "missing" } })));
    const latest = new Map<string, Parameters<Parameters<typeof discoverWebsitePaths>[0]["onResult"]>[0]>();
    const options = { ...settings(), onRemoveResult: vi.fn((url: string) => latest.delete(url)) };
    options.onResult.mockImplementation(result => latest.set(result.url, result));
    const pending = discoverWebsitePaths(options);
    await vi.waitFor(() => expect(latest.has(`${origin}/styles`)).toBe(true));
    releasePage();
    await vi.waitFor(() => expect(latest.get(`${origin}/console/`)?.exposure?.verdict).toBe("medium"));
    expect(options.onRemoveResult).toHaveBeenCalledWith(`${origin}/styles`);
    expect(latest.has(`${origin}/styles`)).toBe(false);
    releaseRoutes();
    expect(await pending).toMatchObject({ discovered: 2, validated: 2 });
    expect(latest.get(`${origin}/console/`)).toMatchObject({ clientRoute: true, sources: ["scripts", "wayback"] });
    expect(latest.get(`${origin}/console/`)?.exposure).toBeUndefined();
    expect(exportDiscoveredWebsitePathsCsv([...latest.values()])).not.toContain("/styles");
    expect(vi.mocked(scanWebsitePaths).mock.calls.flatMap(([call]) => call.candidates).filter(url => url.endsWith("/console/"))).toHaveLength(1);
  });

  it("discards an in-flight result when newer document evidence identifies it as a resource", async () => {
    let releaseResource!: () => void;
    let resourceStarted!: () => void;
    const started = new Promise<void>(resolve => { resourceStarted = resolve; });
    const resourceGate = new Promise<void>(resolve => { releaseResource = resolve; });
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      if (payload.source === "links" && payload.url === `${origin}/`) return document(payload, [candidate("/asset"), candidate("/child")]);
      if (payload.source === "links" && payload.url === `${origin}/child`) {
        await started;
        return { ...document(payload), ignoredUrls: [`${origin}/asset`] };
      }
      return document(payload);
    });
    vi.mocked(createWebsitePathValidator).mockImplementation(async () => async url => {
      if (url === `${origin}/asset`) { resourceStarted(); await resourceGate; }
      return { url, status: "responded", statusCode: 200 };
    });
    const options = settings();
    const pending = discoverWebsitePaths(options);
    await started;
    await vi.waitFor(() => expect(options.onSource).toHaveBeenCalledWith(expect.objectContaining({ source: "links", urls: [`${origin}/`, `${origin}/child`] })));
    releaseResource();
    expect(await pending).toMatchObject({ discovered: 2, validated: 2 });
    expect(options.onResult).not.toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/asset` }));
  });

  it("preserves streamed results on cancellation and never emits later validation callbacks", async () => {
    vi.mocked(requestNetworkScan).mockImplementation(async (payload, signal) => {
      if (payload.source === "wayback") return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      return document(payload, payload.source === "links" && payload.url === `${origin}/` ? [candidate("/early")] : []);
    });
    const controller = new AbortController();
    const options = { ...settings(), signal: controller.signal };
    const pending = discoverWebsitePaths(options);
    const stopped = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/early` })));
    const callbacks = options.onResult.mock.calls.length;
    controller.abort();
    await stopped;
    await Promise.resolve();
    expect(options.onResult).toHaveBeenCalledTimes(callbacks);
  });

  it("traverses page links, script imports and nested sitemaps, merges provenance and verifies only supplied or observed paths", async () => {
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      const key = `${payload.source}:${new URL(String(payload.url)).pathname}`;
      return document(payload, ({
        "links:/": [candidate("/odd-release-17"), candidate("/assets/app.js", "links", "script")],
        "scripts:/assets/app.js": [candidate("/api/custom-service", "scripts"), candidate("/assets/chunk.js", "scripts", "script")],
        "scripts:/assets/chunk.js": [candidate("/api/chunk-endpoint", "scripts")],
        "robots:/robots.txt": [candidate("/private-real-path", "robots"), candidate("/map-index.xml", "robots", "sitemap")],
        "sitemap:/map-index.xml": [candidate("/map-page.xml", "sitemap", "sitemap")],
        "sitemap:/map-page.xml": [candidate("/odd-release-17", "sitemap")],
        "wayback:/": [candidate("/historic-service", "wayback"), candidate("/odd-release-17", "wayback")]
      } as Record<string, unknown[]>)[key] ?? []);
    });
    const options = settings();
    const summary = await discoverWebsitePaths(options);
    expect(summary).toMatchObject({ discovered: 6, validated: 6, truncated: false });
    expect(summary.sources.map(source => source.source)).toEqual(PATH_DISCOVERY_SOURCES.map(source => source.id));
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/odd-release-17`, sources: ["links", "sitemap", "wayback"] }));
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/api/chunk-endpoint`, sources: ["scripts"] }));
    const requestedPaths = vi.mocked(requestNetworkScan).mock.calls.map(([payload]) => new URL(String(payload.url)).pathname);
    expect(requestedPaths).not.toContain("/historic-service");
    expect(requestedPaths).toContain("/map-page.xml");
    expect(scanWebsitePaths).toHaveBeenCalledWith(expect.objectContaining({ candidates: expect.not.arrayContaining([`${origin}/admin/`, `${origin}/login`]) }));
    expect(options.onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "validating", completed: 6, total: 6, discovered: 6 }));
  });

  it("excludes static and metadata files from result counts, verification and source provenance while parsing script and sitemap clues", async () => {
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      const key = `${payload.source}:${new URL(String(payload.url)).pathname}`;
      return document(payload, ({
        "links:/": [candidate("/theme.CSS", "links", "asset"), candidate("/logo%2EPNG"), candidate("/font.woff2"),
          candidate("/download.zip"), candidate("/assets/extensionless", "links", "asset"), candidate("/app%2eJS", "links", "script"),
          candidate("/page.html"), candidate("/contact.php"), candidate("/account.aspx"), candidate("/api/users.json")],
        "scripts:/app%2eJS": [candidate("/api/live", "scripts"), candidate("/chunk.mjs", "scripts", "script"), candidate("/app.js.map", "scripts")],
        "scripts:/chunk.mjs": [candidate("/api/chunk", "scripts")],
        "sitemap:/sitemap.xml": [candidate("/child-map.xml", "sitemap", "sitemap")],
        "sitemap:/child-map.xml": [candidate("/from-map", "sitemap")],
        "wayback:/": [candidate("/archive.JS", "wayback"), candidate("/archive.css", "wayback"), candidate("/legacy-api.json", "wayback")]
      } as Record<string, unknown[]>)[key] ?? []);
    });
    const options = settings();
    const summary = await discoverWebsitePaths(options);
    expect(summary).toMatchObject({ discovered: 9, validated: 9, truncated: false });
    // Fixed exposure probes are a separate feature with their own test; scope this
    // assertion to the site's own observed paths.
    const probes = new Set(exposureProbeUrls(origin));
    const verified = vi.mocked(scanWebsitePaths).mock.calls.flatMap(([options]) => options.candidates).filter(url => !probes.has(url));
    expect(verified).toEqual(expect.arrayContaining([`${origin}/page.html`, `${origin}/contact.php`, `${origin}/account.aspx`, `${origin}/api/users.json`, `${origin}/api/live`, `${origin}/api/chunk`, `${origin}/from-map`, `${origin}/legacy-api.json`]));
    expect(verified.some(url => /CSS|PNG|woff|zip|extensionless|JS|\.mjs|\.map|\.xml|\.css/.test(url))).toBe(false);
    expect(requestNetworkScan).toHaveBeenCalledWith(expect.objectContaining({ source: "scripts", url: `${origin}/chunk.mjs` }), expect.any(AbortSignal));
    expect(requestNetworkScan).toHaveBeenCalledWith(expect.objectContaining({ source: "sitemap", url: `${origin}/child-map.xml` }), expect.any(AbortSignal));
    expect(requestNetworkScan).not.toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/theme.CSS` }), expect.anything());
    expect(summary.sources.find(source => source.source === "scripts")?.urls).toEqual([`${origin}/api/chunk`, `${origin}/api/live`]);
    expect(summary.sources.find(source => source.source === "wayback")?.urls).toEqual([`${origin}/legacy-api.json`]);
    expect(options.onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "validating", completed: 9, total: 9, discovered: 9 }));
  });

  it("keeps resource entry URLs as clues rather than validated results and bootstraps the homepage", async () => {
    for (const entry of ["/assets/app.js", "/assets/theme.css", "/custom-map.xml"]) {
      vi.mocked(requestNetworkScan).mockClear();
      vi.mocked(scanWebsitePaths).mockClear();
      vi.mocked(requestNetworkScan).mockImplementation(async payload => document(payload,
        payload.url === `${origin}${entry}` && ["scripts", "sitemap"].includes(String(payload.source)) ? [candidate("/discovered-api", String(payload.source))] : []));
      const summary = await discoverWebsitePaths(settings(`${origin}${entry}`));
      expect(summary.discovered).toBe(entry.endsWith("css") ? 1 : 2);
      expect(vi.mocked(scanWebsitePaths).mock.calls.flatMap(([options]) => options.candidates)).not.toContain(`${origin}${entry}`);
      expect(requestNetworkScan).toHaveBeenCalledWith(expect.objectContaining({ source: "links", url: `${origin}/` }), expect.any(AbortSignal));
      if (entry.endsWith("js")) expect(requestNetworkScan).toHaveBeenCalledWith(expect.objectContaining({ source: "scripts", url: `${origin}${entry}`, documentUrl: `${origin}/` }), expect.any(AbortSignal));
      if (entry.endsWith("css")) expect(vi.mocked(requestNetworkScan).mock.calls.filter(([payload]) => payload.url === `${origin}${entry}` && payload.source !== "wayback")).toEqual([]);
    }
  });

  it("allows more than 2000 resource clues across documents without consuming the actual path cap", async () => {
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      if (payload.source !== "links") return document(payload);
      const path = new URL(String(payload.url)).pathname;
      return document(payload, path === "/" || path === "/child"
        ? [...Array.from({ length: 1500 }, (_, index) => candidate(`/images/${path === "/" ? "root" : "child"}-${index}.png`, "links", "asset")),
          candidate(path === "/" ? "/child" : "/real-endpoint")]
        : []);
    });
    const summary = await discoverWebsitePaths(settings());
    expect(summary).toMatchObject({ discovered: 3, validated: 3, truncated: false });
    expect(scanWebsitePaths).toHaveBeenCalledWith(expect.objectContaining({ candidates: expect.arrayContaining([`${origin}/real-endpoint`]) }));
    expect(vi.mocked(requestNetworkScan).mock.calls.filter(([payload]) => payload.source === "links")).toHaveLength(3);
  });

  it.each([true, false])("removes extensionless resource paths regardless of archive arrival order (%s)", async archiveFirst => {
    let releaseArchive!: () => void;
    const archiveGate = new Promise<void>(resolve => { releaseArchive = resolve; });
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      if (payload.source === "wayback") {
        if (!archiveFirst) await archiveGate;
        return document(payload, [candidate("/assets/extensionless", "wayback"), candidate("/maps/extensionless", "wayback")]);
      }
      if (payload.source === "links" && payload.url === `${origin}/`) {
        if (archiveFirst) await Promise.resolve();
        releaseArchive();
        return document(payload, [candidate("/assets/extensionless", "links", "script"), candidate("/maps/extensionless", "links", "sitemap")]);
      }
      return document(payload, payload.source === "scripts" || payload.source === "sitemap" && payload.url === `${origin}/maps/extensionless`
        ? [candidate("/api/real", payload.source)] : []);
    });
    const summary = await discoverWebsitePaths(settings());
    expect(summary).toMatchObject({ discovered: 2, validated: 2 });
    const verified = vi.mocked(scanWebsitePaths).mock.calls.flatMap(([options]) => options.candidates);
    expect(verified).toEqual(expect.arrayContaining([`${origin}/`, `${origin}/api/real`]));
    expect(verified).not.toContain(`${origin}/assets/extensionless`);
    expect(verified).not.toContain(`${origin}/maps/extensionless`);
    expect(summary.sources.find(source => source.source === "wayback")?.urls).toEqual([]);
    expect(requestNetworkScan).toHaveBeenCalledWith(expect.objectContaining({ source: "scripts", url: `${origin}/assets/extensionless` }), expect.any(AbortSignal));
    expect(requestNetworkScan).toHaveBeenCalledWith(expect.objectContaining({ source: "sitemap", url: `${origin}/maps/extensionless` }), expect.any(AbortSignal));
  });

  it.each([true, false])("suppresses explicit stylesheet markers from historical results in either arrival order (%s)", async archiveFirst => {
    let releaseArchive!: () => void;
    const archiveGate = new Promise<void>(resolve => { releaseArchive = resolve; });
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      if (payload.source === "wayback") {
        if (!archiveFirst) await archiveGate;
        return document(payload, [candidate("/styles", "wayback"), candidate("/image.php", "wayback"), candidate("/historic-page", "wayback")]);
      }
      if (payload.source === "links" && payload.url === `${origin}/`) {
        if (archiveFirst) await Promise.resolve();
        releaseArchive();
        return { ...document(payload), ignoredUrls: [`${origin}/styles`, `${origin}/image.php`] };
      }
      return document(payload);
    });
    const options = settings();
    const summary = await discoverWebsitePaths(options);
    expect(summary).toMatchObject({ discovered: 2, validated: 2 });
    const verified = vi.mocked(scanWebsitePaths).mock.calls.flatMap(([options]) => options.candidates);
    expect(verified).toEqual(expect.arrayContaining([`${origin}/`, `${origin}/historic-page`]));
    expect(verified).not.toContain(`${origin}/styles`);
    expect(verified).not.toContain(`${origin}/image.php`);
    expect(summary.sources.find(source => source.source === "wayback")?.urls).toEqual([`${origin}/historic-page`]);
    const rows = options.onResult.mock.calls.map(([result]) => result);
    expect(exportDiscoveredWebsitePathsCsv(rows)).not.toMatch(/styles|image\.php/);
  });

  it("rejects untrusted resource marker metadata before suppressing any valid site paths", async () => {
    vi.mocked(requestNetworkScan).mockImplementation(async payload => ({ ...document(payload),
      ...(payload.source === "wayback" ? { ignoredUrls: ["https://other.com/styles"] } : {}) }));
    const summary = await discoverWebsitePaths(settings());
    expect(summary).toMatchObject({ discovered: 1, validated: 1 });
    expect(summary.sources.find(source => source.source === "wayback")?.status).toBe("error");
  });
  it("refreshes prior source counts immediately when later asset evidence removes their paths", async () => {
    let releaseArchive!: () => void;
    const archiveAccepted = new Promise<void>(resolve => { releaseArchive = resolve; });
    let assertRefreshedOnChildRead = false;
    let initialArchiveSeen = false;
    const options = settings();
    options.onSource.mockImplementation(result => {
      if (result.source === "wayback" && result.urls.includes(`${origin}/styles`)) {
        initialArchiveSeen = true;
        releaseArchive();
      }
    });
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      if (payload.source === "wayback") return document(payload, [candidate("/styles", "wayback")]);
      if (payload.source === "links" && payload.url === `${origin}/`) {
        await archiveAccepted;
        return { ...document(payload, [candidate("/child")]), ignoredUrls: [`${origin}/styles`] };
      }
      if (payload.source === "links" && payload.url === `${origin}/child`) {
        const snapshots = options.onSource.mock.calls.map(([result]) => result).filter(result => result.source === "wayback");
        expect(snapshots.at(-1)?.urls).toEqual([]);
        assertRefreshedOnChildRead = true;
      }
      return document(payload);
    });
    await discoverWebsitePaths(options);
    expect(initialArchiveSeen).toBe(true);
    expect(assertRefreshedOnChildRead).toBe(true);
  });

  it("omits static files from CSV while retaining page and JSON API results", () => {
    const csv = exportDiscoveredWebsitePathsCsv(["/theme.CSS", "/app%2eJS", "/map.xml", "/route.html", "/api/list.json"].map(path => ({ url: `${origin}${path}`, sources: ["links"], status: "responded", statusCode: 200 })));
    expect(csv).not.toMatch(/theme|app%2eJS|map\.xml/);
    expect(csv).toContain("route.html");
    expect(csv).toContain("/api/list.json");
  });

  it("preserves merged page and inline-script provenance supplied for the same URL", async () => {
    vi.mocked(requestNetworkScan).mockImplementation(async payload => document(payload,
      payload.source === "links" && payload.url === `${origin}/`
        ? [{ ...candidate("/api"), sources: ["links", "scripts"] }] : []));
    const options = settings();
    const summary = await discoverWebsitePaths(options);
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/api`, sources: ["links", "scripts"] }));
    expect(summary.sources.find(source => source.source === "scripts")?.urls).toContain(`${origin}/api`);
  });

  it("tags only confirmed fixed exposure probes, keeps them out of site counts, and exports their verdict", async () => {
    vi.mocked(scanWebsitePaths).mockImplementation(async options => {
      options.candidates.forEach(url => options.onResult({ ...(url.endsWith("/.env")
        ? { url, status: "responded", statusCode: 200, fingerprint: "secret" }
        : url.endsWith("/server-status")
          ? { url, status: "responded", statusCode: 200, fingerprint: "catchall", soft404: true }
          : url.endsWith("/robots.txt")
            ? { url, status: "responded", statusCode: 200, fingerprint: "public" }
            : { url, status: "responded", statusCode: 404 }), durationMs: 10,
        missingPathBaseline: { statusCode: 404, fingerprint: "missing" } }));
    });
    vi.mocked(requestNetworkScan).mockImplementation(async payload => document(payload, []));
    const options = settings();
    const summary = await discoverWebsitePaths(options);
    expect(summary.discovered).toBe(1); // Only the homepage path; robots.txt is metadata and fixed probes stay out.
    const results = vi.mocked(options.onResult).mock.calls.map(([result]) => result);
    expect(results.find(result => result.url === `${origin}/.env`)).toMatchObject({ exposure: { path: { path: "/.env", confidence: "high" }, verdict: "high" }, sources: [] });
    // A low-confidence published path and a catch-all answer must never become findings.
    expect(results.find(result => result.url === `${origin}/robots.txt`)?.exposure).toBeUndefined();
    expect(results.find(result => result.url === `${origin}/server-status`)?.exposure).toBeUndefined();
    expect(results.find(result => result.url === `${origin}/.git/HEAD`)).toMatchObject({ statusCode: 404 });
    expect(results.find(result => result.url === `${origin}/.git/HEAD`)?.exposure).toBeUndefined();
    expect(results.every(result => typeof result.durationMs === "number")).toBe(true);
    const csv = exportDiscoveredWebsitePathsCsv([results.find(result => result.url === `${origin}/.env`)!]);
    expect(csv).toContain('"high","secret-file","high"');
  });

  it("validates fixed paths once, preserves published routes, and exports archive findings", async () => {
    vi.mocked(requestNetworkScan).mockImplementation(async payload => document(payload,
      payload.source === "links" && payload.url === `${origin}/`
        ? [{ ...candidate("/console/", "scripts"), clientRoute: true }, candidate("/actuator/health")]
        : []));
    vi.mocked(scanWebsitePaths).mockImplementation(async options => {
      options.signal.throwIfAborted();
      options.candidates.forEach(url => options.onResult({ url, status: "responded", statusCode: 200,
        fingerprint: "actual", soft404: false, durationMs: 12,
        missingPathBaseline: { statusCode: 404, fingerprint: "missing" } }));
    });
    const options = { ...settings(), onExposureProgress: vi.fn() };
    const summary = await discoverWebsitePaths(options);
    expect(createWebsitePathValidator).toHaveBeenCalledTimes(1);
    const scanned = vi.mocked(scanWebsitePaths).mock.calls.flatMap(([call]) => call.candidates);
    expect(new Set(scanned).size).toBe(scanned.length);
    expect(options.onExposureProgress).toHaveBeenLastCalledWith(44, 44);
    const results = options.onResult.mock.calls.map(([result]) => result);
    expect(new Set(results.map(result => result.url)).size).toBe(scanned.length);
    const route = [...results].reverse().find(result => result.url.endsWith("/console/"))!;
    expect(route).toMatchObject({ clientRoute: true, sources: ["scripts"], durationMs: 12 });
    expect(route.exposure).toBeUndefined();
    expect(results.find(result => result.url.endsWith("/actuator/health"))).toMatchObject({ sources: ["links"], exposure: { verdict: "medium" } });
    expect(summary).toMatchObject({ discovered: 3, validated: 3 });
    const csv = exportDiscoveredWebsitePathsCsv(results);
    expect(csv).toContain("/backup.zip");
    expect(csv).toContain('"medium","backup","medium"');
  });

  it("does not add fixed probes when only archive records are available", async () => {
    vi.mocked(requestNetworkScan).mockImplementation(async payload => payload.source === "wayback"
      ? document(payload, [candidate("/historic", "wayback")])
      : document(payload, [], "error", "文档不可用"));
    const summary = await discoverWebsitePaths(settings());
    expect(summary).toMatchObject({ discovered: 2, validated: 2 });
    expect(vi.mocked(scanWebsitePaths).mock.calls.flatMap(([call]) => call.candidates)).toEqual(expect.arrayContaining([`${origin}/`, `${origin}/historic`]));
    expect(vi.mocked(scanWebsitePaths).mock.calls.flatMap(([call]) => call.candidates)).toHaveLength(2);
  });

  it("counts validated site paths without requiring a progress callback", async () => {
    expect(await discoverWebsitePaths({ ...settings(), onProgress: undefined })).toMatchObject({ discovered: 1, validated: 1 });
  });

  it("preserves an exact entry file, uses root metadata, and carries the owning HTML context into external scripts", async () => {
    vi.mocked(requestNetworkScan).mockImplementation(async payload => document(payload,
      payload.source === "links" && payload.url === `${origin}/docs/index.html`
        ? [{ ...candidate("/assets/app.js", "links", "script"), documentUrl: `${origin}/docs/base/` }] : []));
    await discoverWebsitePaths(settings(`${origin}/docs/index.html`));
    expect(requestNetworkScan).toHaveBeenCalledWith(expect.objectContaining({ source: "links", url: `${origin}/docs/index.html` }), expect.any(AbortSignal));
    expect(requestNetworkScan).toHaveBeenCalledWith(expect.objectContaining({ source: "robots", url: `${origin}/robots.txt` }), expect.any(AbortSignal));
    expect(requestNetworkScan).toHaveBeenCalledWith(expect.objectContaining({ source: "scripts", url: `${origin}/assets/app.js`, documentUrl: `${origin}/docs/base/` }), expect.any(AbortSignal));
    expect(scanWebsitePaths).toHaveBeenCalledWith(expect.objectContaining({ candidates: expect.arrayContaining([`${origin}/docs/index.html`]) }));
  });

  it("keeps historical missing responses and errors while isolating unavailable discovery sources", async () => {
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      if (payload.source === "sitemap") throw new Error("站点地图读取超时");
      return document(payload, payload.source === "wayback" ? [candidate("/old-release", "wayback")] : []);
    });
    vi.mocked(scanWebsitePaths).mockImplementation(async options => {
      options.candidates.forEach(url => options.onResult({ url, status: url.endsWith("old-release") ? "responded" : "error",
        ...(url.endsWith("old-release") ? { statusCode: 404 } : { message: "请求超时" }) }));
    });
    const options = settings();
    const summary = await discoverWebsitePaths(options);
    expect(summary.sources.find(source => source.source === "sitemap")).toMatchObject({ status: "error", message: "站点地图读取超时" });
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/old-release`, statusCode: 404, sources: ["wayback"] }));
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ status: "error" }));
  });

  it("marks a partially read page source when a child fails and a provider returns partial data", async () => {
    vi.mocked(requestNetworkScan).mockImplementation(async payload => document(payload,
      payload.source === "links" && payload.url === `${origin}/` ? [candidate("/child")] : [],
      payload.url === `${origin}/child` ? "error" : payload.source === "wayback" ? "partial" : "success",
      payload.url === `${origin}/child` ? "页面请求失败" : payload.source === "wayback" ? "历史来源仅返回部分记录" : undefined));
    const summary = await discoverWebsitePaths(settings());
    expect(summary.sources.find(source => source.source === "links")?.status).toBe("partial");
    expect(summary.sources.find(source => source.source === "wayback")?.status).toBe("partial");
  });

  it("rejects malformed, parameterized, template and out-of-origin discovery data without verifying it", async () => {
    for (const badUrl of ["https://other.com/admin", `${origin}/api/{id}`, `${origin}/api/:id`, `${origin}/a?token=123`, `${origin}/a#hash`]) {
      vi.mocked(requestNetworkScan).mockImplementation(async payload => document(payload,
        payload.source === "wayback" ? [{ url: badUrl, source: "wayback", kind: "page" }] : []));
      const summary = await discoverWebsitePaths(settings());
      expect(summary.sources.find(source => source.source === "wayback")?.status).toBe("error");
      expect(scanWebsitePaths).not.toHaveBeenCalledWith(expect.objectContaining({ candidates: expect.arrayContaining([badUrl]) }));
    }
  });

  it("distinguishes all-source failure from a successful site with no additional published paths", async () => {
    vi.mocked(requestNetworkScan).mockRejectedValue(new Error("来源不可用"));
    await expect(discoverWebsitePaths(settings())).rejects.toThrow(/所有发现来源/);
    expect(scanWebsitePaths).not.toHaveBeenCalled();
    vi.mocked(requestNetworkScan).mockImplementation(async payload => document(payload));
    expect(await discoverWebsitePaths(settings())).toMatchObject({ discovered: 1, validated: 1, truncated: false });
  });

  it("breaks cycles, caps page depth, and still verifies paths observed at the boundary", async () => {
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      const path = new URL(String(payload.url)).pathname;
      return document(payload, payload.source === "links"
        ? path === "/" ? [candidate("/level1")]
          : path === "/level1" ? [candidate("/level2"), candidate("/")]
          : path === "/level2" ? [candidate("/level3")]
          : path === "/level3" ? [candidate("/level4")] : [] : []);
    });
    const summary = await discoverWebsitePaths(settings());
    expect(summary).toMatchObject({ discovered: 5, validated: 5 });
    expect(summary.sources.find(source => source.source === "links")).toMatchObject({ status: "partial", message: expect.stringContaining("3 层") });
    expect(requestNetworkScan).not.toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/level4` }), expect.anything());
    expect(scanWebsitePaths).toHaveBeenCalledWith(expect.objectContaining({ candidates: expect.arrayContaining([`${origin}/level4`]) }));
  });

  it("allows a depth-rejected path to be rediscovered through a shallower sitemap", async () => {
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      const path = new URL(String(payload.url)).pathname;
      if (payload.source === "sitemap" && path === "/map-3.xml") {
        await Promise.resolve();
        await Promise.resolve();
      }
      return document(payload, ({
        "links:/": [candidate("/level1")], "links:/level1": [candidate("/level2")],
        "links:/level2": [candidate("/level3")], "links:/level3": [candidate("/target")],
        "sitemap:/sitemap.xml": [candidate("/map-1.xml", "sitemap", "sitemap")],
        "sitemap:/map-1.xml": [candidate("/map-2.xml", "sitemap", "sitemap")],
        "sitemap:/map-2.xml": [candidate("/map-3.xml", "sitemap", "sitemap")],
        "sitemap:/map-3.xml": [candidate("/target", "sitemap")]
      } as Record<string, unknown[]>)[`${payload.source}:${path}`] ?? []);
    });
    await discoverWebsitePaths(settings());
    expect(requestNetworkScan).toHaveBeenCalledWith(expect.objectContaining({ source: "links", url: `${origin}/target` }), expect.any(AbortSignal));
  });

  it("caps discovery and page reads, batches verification, and exports full provenance", async () => {
    vi.mocked(requestNetworkScan).mockImplementation(async payload => document(payload,
      payload.source === "links" && payload.url === `${origin}/`
        ? Array.from({ length: 2000 }, (_, index) => candidate(`/observed-${index}`)) : []));
    const summary = await discoverWebsitePaths(settings());
    expect(summary).toMatchObject({ discovered: 2000, validated: 2000, truncated: true });
    expect(vi.mocked(requestNetworkScan).mock.calls.filter(([payload]) => payload.source === "links")).toHaveLength(100);
    // Every site URL is admitted once, alongside the independently bounded fixed list.
    const probes = new Set(exposureProbeUrls(origin));
    expect(vi.mocked(scanWebsitePaths).mock.calls.flatMap(([options]) => options.candidates).filter(url => !probes.has(url))).toHaveLength(2000);
    expect(createWebsitePathValidator).toHaveBeenCalledTimes(1);
    expect(vi.mocked(scanWebsitePaths).mock.calls.every(([options]) => options.candidates.length <= 500)).toBe(true);
    const csv = exportDiscoveredWebsitePathsCsv([{ url: `${origin}/path`, sources: ["scripts", "wayback"], status: "responded", statusCode: 302,
      title: '=HYPERLINK("evil")', location: "/new", contentLength: 77 }]);
    expect(csv).toContain('"scripts; wayback"');
    expect(csv).toContain('"\'=HYPERLINK(""evil"")"');
    expect(csv).toContain('"77","/new"');
  });

  it("limits concurrent document reads independently of verification", async () => {
    let active = 0;
    let peak = 0;
    vi.mocked(requestNetworkScan).mockImplementation(async payload => {
      peak = Math.max(peak, ++active);
      await Promise.resolve();
      active--;
      return document(payload, payload.source === "links" && payload.url === `${origin}/`
        ? Array.from({ length: 12 }, (_, index) => candidate(`/page-${index}`)) : []);
    });
    await discoverWebsitePaths({ ...settings(), concurrency: 2 });
    expect(peak).toBeLessThanOrEqual(3); // Two site documents plus an independent archive query.
  });

  it("stops outstanding discovery and suppresses late callbacks and queued verification", async () => {
    let started!: () => void;
    const hasStarted = new Promise<void>(resolve => { started = resolve; });
    vi.mocked(requestNetworkScan).mockImplementation(async (_payload, signal) => {
      started();
      return await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const controller = new AbortController();
    const options = { ...settings(), signal: controller.signal };
    const job = discoverWebsitePaths(options);
    const rejected = expect(job).rejects.toMatchObject({ name: "AbortError" });
    await hasStarted;
    const progressCount = options.onProgress.mock.calls.length;
    controller.abort();
    await rejected;
    expect(options.onSource).not.toHaveBeenCalled();
    expect(options.onProgress).toHaveBeenCalledTimes(progressCount);
    expect(scanWebsitePaths).not.toHaveBeenCalled();
  });

  it("finishes a timed-out discovery with partial sources and preserves collected paths for verification", async () => {
    vi.useFakeTimers();
    vi.mocked(requestNetworkScan).mockImplementation(async (payload, signal) => {
      if (payload.source === "wayback") return document(payload, [candidate("/archived", "wayback")]);
      return await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const options = settings();
    const job = discoverWebsitePaths(options);
    await vi.advanceTimersByTimeAsync(PATH_DISCOVERY_DURATION_MS + 1);
    const summary = await job;
    expect(summary).toMatchObject({ discovered: 2, validated: 2 });
    expect(summary.sources.find(source => source.source === "links")).toMatchObject({ status: "partial", message: expect.stringContaining(`${PATH_DISCOVERY_DURATION_MS / 1000} 秒`) });
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/archived` }));
  });

  it("validates target and numeric settings before starting discovery", async () => {
    for (const override of [{ concurrency: 9 }, { timeoutMs: 999 }, { baseUrl: "https://user:pass@example.com/" }]) {
      await expect(discoverWebsitePaths({ ...settings(), ...override })).rejects.toThrow();
    }
    expect(requestNetworkScan).not.toHaveBeenCalled();
  });
});

  describe("canonical entries and declared client routes", () => {
    it("upgrades an observed HTTP entry and uses the new scope for every later request and validation", async () => {
      const entry = "http://example.com/start";
      vi.mocked(requestNetworkScan).mockImplementation(async payload => payload.url === entry
        ? { ...document(payload), canonicalUrl: `${origin}/docs/` } : document(payload,
          payload.source === "links" && payload.url === `${origin}/docs/` ? [candidate("/docs/items")] : []));
      const options = { ...settings(entry), onTarget: vi.fn() };
      const summary = await discoverWebsitePaths(options);
      expect(summary.baseUrl).toBe(`${origin}/docs/`);
      expect(options.onTarget).toHaveBeenCalledExactlyOnceWith(`${origin}/docs/`);
      const calls = vi.mocked(requestNetworkScan).mock.calls.map(([payload]) => payload);
      expect(calls.filter(payload => payload.url === entry)).toHaveLength(1);
      expect(calls.slice(1).every(payload => payload.baseUrl === `${origin}/docs/`)).toBe(true);
      expect(scanWebsitePaths).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: `${origin}/docs/`, candidates: expect.arrayContaining([`${origin}/docs/items`]) }));
      expect(vi.mocked(scanWebsitePaths).mock.calls.flatMap(([options]) => options.candidates).some(url => url.startsWith("http:"))).toBe(false);
    });

    it.each(["https://other.com/", "https://user@example.com/", "https://example.com:8443/", "https://example.com/?query=1", "https://example.com/:id"])("rejects an untrusted canonical target (%s)", async canonicalUrl => {
      vi.mocked(requestNetworkScan).mockImplementation(async payload => ({ ...document(payload), ...(String(payload.url).startsWith("http:") ? { canonicalUrl } : {}) }));
      const options = { ...settings("http://example.com/"), onTarget: vi.fn() };
      await expect(discoverWebsitePaths(options)).rejects.toThrow(/所有发现来源/);
      expect(options.onTarget).toHaveBeenCalledExactlyOnceWith("http://example.com/");
      expect(scanWebsitePaths).not.toHaveBeenCalled();
    });

    it("does not publish a late target or leave a discovery timer when cancelled during the HTTP entry read", async () => {
      vi.useFakeTimers();
      const controller = new AbortController();
      let release!: (value: unknown) => void;
      vi.mocked(requestNetworkScan).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
      const options = { ...settings("http://example.com/"), signal: controller.signal, onTarget: vi.fn() };
      const pending = discoverWebsitePaths(options);
      controller.abort();
      release({ source: "links", url: "http://example.com/", status: "success", candidates: [], canonicalUrl: `${origin}/` });
      await expect(pending).rejects.toThrow();
      expect(options.onTarget).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(scanWebsitePaths).not.toHaveBeenCalled();
    });

    it("keeps declared-route evidence and raw soft-404 diagnostics even with merged link provenance", async () => {
      vi.mocked(requestNetworkScan).mockImplementation(async payload => document(payload,
        payload.source === "links" && payload.url === `${origin}/`
          ? [{ ...candidate("/docs/items"), clientRoute: true, sources: ["links", "scripts"] }] : []));
      vi.mocked(scanWebsitePaths).mockImplementation(async options => options.candidates.forEach(url => options.onResult({ url, status: "responded", statusCode: 200, soft404: true })));
      const options = settings();
      await discoverWebsitePaths(options);
      expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/docs/items`, clientRoute: true, soft404: true, sources: ["links", "scripts"] }));
      const csv = exportDiscoveredWebsitePathsCsv(options.onResult.mock.calls.map(([result]) => result));
      expect(csv).toContain("declared_client_route");
      expect(csv).toContain(`${origin}/docs/items`);
    });

    it("reads scripts linked at the page depth boundary without charging their dependencies another page level", async () => {
      vi.mocked(requestNetworkScan).mockImplementation(async payload => {
        const path = new URL(String(payload.url)).pathname;
        const candidates = payload.source === "links" ? path === "/" ? [candidate("/one")]
          : path === "/one" ? [candidate("/two")]
          : path === "/two" ? [candidate("/three")]
          : path === "/three" ? [candidate("/app.js", "links", "script")] : []
          : path === "/app.js" ? [candidate("/chunk.js", "scripts", "script")]
            : path === "/chunk.js" ? [candidate("/deep-route", "scripts")] : [];
        return document(payload, candidates);
      });
      await discoverWebsitePaths(settings());
      expect(requestNetworkScan).toHaveBeenCalledWith(expect.objectContaining({ source: "scripts", url: `${origin}/app.js` }), expect.any(AbortSignal));
      expect(requestNetworkScan).toHaveBeenCalledWith(expect.objectContaining({ source: "scripts", url: `${origin}/chunk.js` }), expect.any(AbortSignal));
      expect(requestNetworkScan).not.toHaveBeenCalledWith(expect.objectContaining({ source: "links", url: `${origin}/deep-route` }), expect.any(AbortSignal));
      expect(scanWebsitePaths).toHaveBeenCalledWith(expect.objectContaining({ candidates: expect.arrayContaining([`${origin}/deep-route`]) }));
    });
  });
