import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebsitePathValidator, requestNetworkScan, scanWebsitePaths } from "./network-scan";
import { exposureProbeUrls } from "./exposure-path";
import { discoverWebsitePaths, exportDiscoveredWebsitePathsCsv, PATH_DISCOVERY_DURATION_MS, PATH_DISCOVERY_SOURCES } from "./website-path-discovery";

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
    await vi.waitFor(() => expect(options.onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: "discovering", completed: 2000 })));
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
