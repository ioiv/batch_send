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
    expect(summary).toMatchObject({ discovered: 6, validated: 6, truncated: false });
    expect(summary.sources.map(source => source.source)).toEqual(PATH_DISCOVERY_SOURCES.map(source => source.id));
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/odd-release-17`, sources: ["links", "sitemap", "wayback"] }));
    expect(options.onResult).toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/api/chunk-endpoint`, sources: ["scripts"] }));
    const requestedPaths = vi.mocked(requestNetworkScan).mock.calls.map(([payload]) => new URL(String(payload.url)).pathname);
    expect(requestedPaths).not.toContain("/historic-service");
    expect(requestedPaths).toContain("/map-page.xml");
    expect(scanWebsitePaths).toHaveBeenCalledWith(expect.objectContaining({ candidates: expect.not.arrayContaining([`${origin}/admin/`, `${origin}/login`]) }));
    expect(options.onProgress).toHaveBeenLastCalledWith({ phase: "validating", completed: 6, total: 6, discovered: 6 });
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
    const verified = vi.mocked(scanWebsitePaths).mock.calls.flatMap(([options]) => options.candidates);
    expect(verified).toEqual(expect.arrayContaining([`${origin}/page.html`, `${origin}/contact.php`, `${origin}/account.aspx`, `${origin}/api/users.json`, `${origin}/api/live`, `${origin}/api/chunk`, `${origin}/from-map`, `${origin}/legacy-api.json`]));
    expect(verified.some(url => /CSS|PNG|woff|zip|extensionless|JS|\.mjs|\.map|\.xml|\.css/.test(url))).toBe(false);
    expect(requestNetworkScan).toHaveBeenCalledWith(expect.objectContaining({ source: "scripts", url: `${origin}/chunk.mjs` }), expect.any(AbortSignal));
    expect(requestNetworkScan).toHaveBeenCalledWith(expect.objectContaining({ source: "sitemap", url: `${origin}/child-map.xml` }), expect.any(AbortSignal));
    expect(requestNetworkScan).not.toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/theme.CSS` }), expect.anything());
    expect(summary.sources.find(source => source.source === "scripts")?.urls).toEqual([`${origin}/api/chunk`, `${origin}/api/live`]);
    expect(summary.sources.find(source => source.source === "wayback")?.urls).toEqual([`${origin}/legacy-api.json`]);
    expect(options.onProgress).toHaveBeenLastCalledWith({ phase: "validating", completed: 9, total: 9, discovered: 9 });
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
