import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestNetworkScan, scanWebsitePaths } from "./network-scan";
import { discoverWebsitePaths, exportDiscoveredWebsitePathsCsv, PATH_DISCOVERY_DURATION_MS, PATH_DISCOVERY_SOURCES } from "./website-path-discovery";

vi.mock("./network-scan", async importOriginal => ({
  ...await importOriginal<typeof import("./network-scan")>(), requestNetworkScan: vi.fn(), scanWebsitePaths: vi.fn()
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
  vi.mocked(requestNetworkScan).mockImplementation(async payload => document(payload));
  vi.mocked(scanWebsitePaths).mockImplementation(async options => {
    options.candidates.forEach(url => options.onResult({ url, status: "responded", statusCode: 200 }));
  });
});
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); });

describe("observed website path discovery", () => {
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
    expect(summary).toMatchObject({ discovered: 10, validated: 10, truncated: false });
    expect(summary.sources.map(source => source.source)).toEqual(PATH_DISCOVERY_SOURCES.map(source => source.id));
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/odd-release-17`, sources: ["links", "sitemap", "wayback"] }));
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/api/chunk-endpoint`, sources: ["scripts"] }));
    const requestedPaths = vi.mocked(requestNetworkScan).mock.calls.map(([payload]) => new URL(String(payload.url)).pathname);
    expect(requestedPaths).not.toContain("/historic-service");
    expect(requestedPaths).toContain("/map-page.xml");
    expect(scanWebsitePaths).toHaveBeenCalledWith(expect.objectContaining({ candidates: expect.not.arrayContaining([`${origin}/admin/`, `${origin}/login`]) }));
    expect(options.onProgress).toHaveBeenLastCalledWith({ phase: "validating", completed: 10, total: 10, discovered: 10 });
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
    expect(scanWebsitePaths).toHaveBeenCalledTimes(4);
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
    expect(summary.sources.find(source => source.source === "links")).toMatchObject({ status: "partial", message: expect.stringContaining("90 秒") });
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/archived` }));
  });

  it("validates target and numeric settings before starting discovery", async () => {
    for (const override of [{ concurrency: 9 }, { timeoutMs: 999 }, { baseUrl: "https://user:pass@example.com/" }]) {
      await expect(discoverWebsitePaths({ ...settings(), ...override })).rejects.toThrow();
    }
    expect(requestNetworkScan).not.toHaveBeenCalled();
  });
});
