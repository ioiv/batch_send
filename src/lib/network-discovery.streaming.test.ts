import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverWebsitePaths } from "./website-path-discovery";
import { discoverSubdomains } from "./subdomain-discovery";

afterEach(() => vi.unstubAllGlobals());
const json = (result: unknown) => new Response(JSON.stringify({ result }), { headers: { "Content-Type": "application/json" } });
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 2));
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

describe("discovery and verification over the API", () => {
  it.each(["skipped", "hidden-response", "in-flight"] as const)("validates a fixed path once after resource evidence arrives during %s work", async (stage) => {
    const origin = "https://example.com";
    const home = gate();
    const baseline = gate();
    const baselineStarted = gate();
    const envResponse = gate();
    const envStarted = gate();
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const payload = JSON.parse(String(init.body));
      requests.push(payload);
      const pathname = new URL(payload.url).pathname;
      if (payload.kind === "path-discovery") {
        if (payload.source === "links") await home.promise;
        let candidates: { url: string; source: string; kind: string }[] = [];
        if (payload.source === "wayback") candidates = [{ url: `${origin}/.env`, source: "wayback", kind: "page" }];
        if (payload.source === "sitemap" && pathname === "/sitemap.xml") {
          // The archive first admits the path. A later sitemap identifies it as a
          // resource before the readable homepage enables the fixed probe list.
          await (stage === "skipped" ? baselineStarted.promise : envStarted.promise);
          candidates = [{ url: `${origin}/.env`, source: "sitemap", kind: "sitemap" }];
        }
        return json({ source: payload.source, url: payload.url, status: "success", candidates });
      }
      const missing = pathname.includes("chainkit-");
      if (missing) {
        baselineStarted.release();
        if (stage === "skipped") await baseline.promise;
      }
      if (pathname === "/.env") {
        envStarted.release();
        if (stage !== "skipped") await envResponse.promise;
      }
      return json({ url: payload.url, status: "responded", statusCode: missing ? 404 : 200,
        fingerprint: missing ? "missing" : "actual" });
    }));
    const onSource = vi.fn();
    const onResult = vi.fn();
    const onProgress = vi.fn();
    const onExposureProgress = vi.fn();
    const controller = new AbortController();
    const pending = discoverWebsitePaths({ baseUrl: `${origin}/`, concurrency: 3, timeoutMs: 1000,
      signal: controller.signal, onSource, onResult, onProgress, onExposureProgress });
    const envRequests = () => requests.filter(request => request.kind === "path" && request.url === `${origin}/.env`);
    const waitForHomeBlockedValidation = () => vi.waitFor(() => expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({
      discovered: 1,
      completed: 0,
      diagnostics: expect.objectContaining({ activeValidations: 0, pendingValidations: 1,
        activeDocuments: 1, pendingDocuments: 0 })
    })));
    try {
      await vi.waitFor(() => expect(onSource).toHaveBeenCalledWith(expect.objectContaining({ source: "sitemap", status: "success" })));
      if (stage === "skipped") {
        onProgress.mockClear();
        baseline.release();
        // The resource validation has skipped after its baseline. Only the
        // homepage validation remains, waiting for its existing discovery read.
        await waitForHomeBlockedValidation();
        expect(envRequests()).toHaveLength(0);
        expect(requests.filter(request => request.kind === "path" && request.url === `${origin}/`)).toHaveLength(0);
      } else {
        expect(envRequests()).toHaveLength(1);
        if (stage === "hidden-response") {
          onProgress.mockClear();
          envResponse.release();
          await waitForHomeBlockedValidation(); // Its completed response stays hidden until fixed-probe promotion.
        }
      }
      expect(onResult.mock.calls.some(([result]) => result.url === `${origin}/.env`)).toBe(false);
      expect(onExposureProgress).not.toHaveBeenCalled();
      home.release();
      if (stage === "in-flight") {
        await vi.waitFor(() => expect(onExposureProgress).toHaveBeenCalled());
        expect(envRequests()).toHaveLength(1);
        envResponse.release();
      }
      expect(await pending).toMatchObject({ discovered: 1, validated: 1 });
      expect(envRequests()).toHaveLength(1);
      expect(onExposureProgress).toHaveBeenLastCalledWith(44, 44);
      expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/.env`, sources: [], exposure: { path: expect.objectContaining({ path: "/.env" }), verdict: "high" } }));
      const paths = requests.filter(request => request.kind === "path").map(request => String(request.url));
      expect(paths.filter(path => path.includes("chainkit-"))).toHaveLength(1);
      expect(new Set(paths).size).toBe(paths.length);
    } finally {
      home.release();
      baseline.release();
      envResponse.release();
      controller.abort();
      await pending.catch(() => {});
    }
  });

  it("streams website results through one baseline without exceeding eight simultaneous API requests", async () => {
    let releaseArchive!: () => void;
    const archiveGate = new Promise<void>(resolve => { releaseArchive = resolve; });
    let active = 0;
    let peak = 0;
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const payload = JSON.parse(String(init.body));
      requests.push(payload);
      peak = Math.max(peak, ++active);
      try {
        await tick();
        if (payload.kind === "path-discovery") {
          if (payload.source === "wayback") await archiveGate;
          const paths = payload.source === "wayback" ? ["/page-0", "/late"]
            : payload.source === "links" && payload.url === "https://example.com/"
              ? Array.from({ length: 24 }, (_, index) => `/page-${index}`) : [];
          return json({ source: payload.source, url: payload.url, status: "success",
            candidates: paths.map(path => ({ url: `https://example.com${path}`, source: payload.source, kind: "page" })) });
        }
        const missing = payload.url.includes("chainkit-");
        return json({ url: payload.url, status: "responded", statusCode: missing ? 404 : 200, fingerprint: missing ? "missing" : "actual" });
      } finally { active -= 1; }
    }));
    const onResult = vi.fn();
    let completed = false;
    const pending = discoverWebsitePaths({ baseUrl: "https://example.com/", concurrency: 8, timeoutMs: 1000,
      signal: new AbortController().signal, onSource: vi.fn(), onResult }).then(result => { completed = true; return result; });
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ url: "https://example.com/page-0", sources: ["links"] })));
    expect(completed).toBe(false);
    releaseArchive();
    expect(await pending).toMatchObject({ discovered: 26, validated: 26 });
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ url: "https://example.com/page-0", sources: ["links", "wayback"] }));
    const paths = requests.filter(request => request.kind === "path").map(request => String(request.url));
    expect(paths.filter(path => path.includes("chainkit-"))).toHaveLength(1);
    expect(new Set(paths).size).toBe(paths.length);
    expect(peak).toBeGreaterThan(3);
    expect(peak).toBeLessThanOrEqual(8);
  });

  it("streams DNS results, follows CNAMEs and reuses the wildcard baseline while sources are still running", async () => {
    let releaseSource!: () => void;
    const sourceGate = new Promise<void>(resolve => { releaseSource = resolve; });
    let active = 0;
    let peak = 0;
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const payload = JSON.parse(String(init.body));
      requests.push(payload);
      peak = Math.max(peak, ++active);
      try {
        await tick();
        if (payload.kind === "subdomain-discovery") {
          if (payload.source === "subdomaincenter") await sourceGate;
          const domains = payload.source === "common" ? Array.from({ length: 16 }, (_, index) => `site-${index}.example.com`)
            : payload.source === "subdomaincenter" ? ["site-0.example.com", "late.example.com"] : [];
          return json({ source: payload.source, status: "success", domains });
        }
        if (payload.domain.startsWith("chainkit-")) return json({ domain: payload.domain, status: "not-found", addresses: [] });
        return json({ domain: payload.domain, status: "resolved", addresses: ["8.8.8.8"],
          ...(payload.domain === "site-0.example.com" ? { cname: "cname.example.com" } : {}) });
      } finally { active -= 1; }
    }));
    const onResult = vi.fn();
    let completed = false;
    const pending = discoverSubdomains({ domain: "example.com", concurrency: 8, timeoutMs: 1000,
      signal: new AbortController().signal, onSource: vi.fn(), onResult }).then(result => { completed = true; return result; });
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ domain: "site-0.example.com", sources: ["common"] })));
    expect(completed).toBe(false);
    releaseSource();
    expect(await pending).toMatchObject({ discovered: 18, validated: 18 });
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ domain: "site-0.example.com", sources: ["common", "subdomaincenter"] }));
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ domain: "cname.example.com", sources: ["cname"] }));
    const domains = requests.filter(request => request.kind === "subdomain").map(request => String(request.domain));
    expect(domains.filter(domain => domain.startsWith("chainkit-"))).toHaveLength(1);
    expect(new Set(domains).size).toBe(domains.length);
    expect(peak).toBeLessThanOrEqual(8);
  });
});
