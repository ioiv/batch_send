import { afterEach, describe, expect, it, vi } from "vitest";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { discoverWebsitePaths, MAX_PATH_DISCOVERY_CANDIDATES, MAX_PATH_DISCOVERY_BYTES, type WebsitePathDiscoveryDependencies } from "./website-path-discovery";
import type { PublicDocumentResult } from "./network-scan";

function document(body: unknown, extra: Partial<PublicDocumentResult> = {}): PublicDocumentResult {
  return { url: "https://example.com/", statusCode: 200, body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)), truncated: false, ...extra };
}
function dependencies(fetcher: (url: URL, call: number, signal?: AbortSignal) => PublicDocumentResult | Promise<PublicDocumentResult>) {
  let call = 0;
  const fetchDocument = vi.fn((url: string, options: { timeoutMs: number; maxBytes: number; signal?: AbortSignal }) => {
    expect(options.maxBytes).toBe(MAX_PATH_DISCOVERY_BYTES);
    expect(options.timeoutMs).toBeGreaterThan(0);
    expect(options.timeoutMs).toBeLessThanOrEqual(20000);
    return Promise.resolve(fetcher(new URL(url), ++call, options.signal));
  });
  return { adapter: { fetchDocument } satisfies WebsitePathDiscoveryDependencies, fetchDocument };
}
const urls = (result: Awaited<ReturnType<typeof discoverWebsitePaths>>) => result.candidates.map((candidate) => candidate.url);
afterEach(() => vi.useRealTimers());

describe("observed HTML and script paths", () => {
  it("extracts literal same-origin links/assets and honors first base, entities, query stripping and exact files", async () => {
    const provider = dependencies(() => document(`<base href="/docs/"><base href="/ignored/"><a href="getting-started?utm_source=x#section">x</a><a href="&#x2f;index.html">file</a><script src="../app.js?v=1"></script><link rel="stylesheet" href="style.css"><img src="hero.png"><a href="https://evil.com/no">outside</a><a href="//example.com.evil/no">evil</a><a href="http://example.com/other">other origin</a><a href="javascript:alert(1)">js</a><form action="/submit"><input name="action"></form><a href="#anchor">anchor</a>`));
    const result = await discoverWebsitePaths("https://example.com/start", "https://example.com/start", "links", 1000, provider.adapter);
    expect(result.status).toBe("success");
    expect(urls(result)).toEqual(["https://example.com/docs/getting-started", "https://example.com/index.html", "https://example.com/app.js", "https://example.com/docs/style.css", "https://example.com/docs/hero.png"]);
    expect(result.candidates.find((candidate) => candidate.kind === "script")).toMatchObject({ documentUrl: "https://example.com/docs/" });
    expect(provider.fetchDocument).toHaveBeenCalledTimes(1);
  });

  it("handles external bases without inventing local relative links or fetch contexts", async () => {
    const provider = dependencies(() => document(`<base href="https://cdn.other.com/assets/"><a href="relative">x</a><script src="https://example.com/app.js"></script><a href="https://example.com/absolute">x</a><script>fetch('relative/api');fetch('https://example.com/api');import('https://example.com/module.js');</script>`));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/", "links", 1000, provider.adapter);
    expect(result.status).toBe("partial");
    expect(urls(result)).toEqual(["https://example.com/app.js", "https://example.com/absolute", "https://example.com/api", "https://example.com/module.js"]);
    expect(result.candidates[0].kind).toBe("asset");
    expect(result.candidates[3].kind).toBe("asset");
  });
  it("strips query templates before inspecting concrete paths and normalizes base owner contexts", async () => {
    const provider = dependencies(() => document(`<base href="/docs/?v=1#frag"><script src="app.js"></script><a href="/api?filter=%7Bvalue%7D">x</a><a href="/api?glob=*">x</a><a href="/search?q=hello%20world">x</a><a href="/files/Quarterly%20Report.pdf">x</a>`));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/", "links", 1000, provider.adapter);
    expect(urls(result)).toEqual(["https://example.com/docs/app.js", "https://example.com/api", "https://example.com/search", "https://example.com/files/Quarterly%20Report.pdf"]);
    expect(result.candidates[0].documentUrl).toBe("https://example.com/docs/");
  });
  it("keeps script owner context on kind upgrades and combines actual source provenance", async () => {
    const provider = dependencies(() => document(`<base href="/portal/"><a href="/assets/app">x</a><link rel="preload" href="/assets/app" as="script"><script src="/assets/app"></script><a href="/api">x</a><script>fetch('/api');</script>`));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/", "links", 1000, provider.adapter);
    expect(result.candidates[0]).toMatchObject({ url: "https://example.com/assets/app", kind: "script", documentUrl: "https://example.com/portal/" });
    expect(result.candidates[1]).toMatchObject({ url: "https://example.com/api", source: "links", sources: ["links", "scripts"] });
  });

  it("distinguishes fetch/XHR owner-document relatives from imported module relatives", async () => {
    const provider = dependencies(() => document(`fetch('api/list?tracking=1');xhr.open("GET", "v1/items");import('./chunk.js');import helper from '../helpers.js';export { x } from './export.js';const routes=["/dashboard", '/users/:id', '/files/{id}', '/api/' + id, '/joined/'.concat(id), \`/dynamic/\${id}\`]; // '/comment-only'
      const escaped = "\\x2fapi\\u002fv2";/* '/another-comment' */`));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/assets/main.js", "scripts", 1000, provider.adapter, undefined, "https://example.com/docs/page");
    expect(urls(result)).toEqual(["https://example.com/docs/api/list", "https://example.com/docs/v1/items", "https://example.com/assets/chunk.js", "https://example.com/helpers.js", "https://example.com/assets/export.js", "https://example.com/dashboard", "https://example.com/api/v2"]);
    expect(result.candidates.find((candidate) => candidate.url.endsWith("chunk.js"))).toMatchObject({ kind: "script", documentUrl: "https://example.com/docs/page" });
  });

  it("extracts inline fetch clues with script provenance and never reads markup inside JS strings", async () => {
    const provider = dependencies(() => document(`<script>fetch('api/items');import('./part.js');let text='<a href="invented">';</script><!-- <a href="/comment"> --><a href="/actual">x</a>`));
    const result = await discoverWebsitePaths("https://example.com/docs/page", "https://example.com/docs/page", "links", 1000, provider.adapter);
    expect(urls(result)).toEqual(["https://example.com/actual", "https://example.com/docs/api/items", "https://example.com/docs/part.js"]);
    expect(result.candidates[1].source).toBe("scripts");
  });
  it("skips bare modules and ambiguous relatives while resolving import.meta and worker imports correctly", async () => {
    const provider = dependencies(() => document(`import React from 'react';import('package/path');export { x } from 'other-package';new URL('./logo.svg', import.meta.url);importScripts('worker.js');const ambiguous='./maybe';fetch('/api/' /* dynamic */ + id);const route='/route';`));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/assets/main.js", "scripts", 1000, provider.adapter, undefined, "https://example.com/docs/page");
    expect(urls(result)).toEqual(["https://example.com/assets/logo.svg", "https://example.com/assets/worker.js", "https://example.com/route"]);
  });

  it("rejects dynamic/credential/control paths before transport and skips non-JS script responses", async () => {
    const provider = dependencies(() => document(`<a href="https://user:pass@example.com/private">x</a><a href="/api/%7Bid%7D">x</a><a href="/api/%0Asecret">x</a><a href="/api/%5Csecret">x</a><a href="/api/:id">x</a><a href="/api/*">x</a><a href="/my%20file">x</a>`));
    expect(urls(await discoverWebsitePaths("https://example.com/", "https://example.com/", "links", 1000, provider.adapter))).toEqual(["https://example.com/my%20file"]);
    const html = dependencies(() => document('<a href="/fake-api">', { contentType: "text/html" }));
    expect((await discoverWebsitePaths("https://example.com/", "https://example.com/main.js", "scripts", 1000, html.adapter)).status).toBe("error");
  });

  it("retains only complete HTML tokens from cut-off bodies and caps document results", async () => {
    const truncated = dependencies(() => document('<a href="/valid">ok</a><a href="/cut-off', { truncated: true }));
    expect(await discoverWebsitePaths("https://example.com/", "https://example.com/", "links", 1000, truncated.adapter)).toMatchObject({ status: "partial", candidates: [{ url: "https://example.com/valid" }] });
    const capped = dependencies(() => document(Array.from({ length: MAX_PATH_DISCOVERY_CANDIDATES + 1 }, (_, i) => `<a href="/item${i}">x</a>`).join("")));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/", "links", 1000, capped.adapter);
    expect(result.status).toBe("partial");
    expect(result.candidates).toHaveLength(MAX_PATH_DISCOVERY_CANDIDATES);
  });
});

describe("metadata documents", () => {
  it("uses only actual robots directives and skips whole wildcard patterns", async () => {
    const provider = dependencies(() => document("User-agent: *\nAllow: /docs/ # comment\nDisallow: /private\nDisallow: /files/*\nDisallow: /ending$\nDisallow:\nSitemap: https://example.com/maps/main.xml\nSitemap: https://external.example/map.xml\n"));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/robots.txt", "robots", 1000, provider.adapter);
    expect(urls(result)).toEqual(["https://example.com/docs/", "https://example.com/private", "https://example.com/maps/main.xml"]);
    expect(result.candidates[2].kind).toBe("sitemap");
  });

  it("extracts sitemap-index locs as nested maps and ordinary urlsets as paths", async () => {
    const index = dependencies(() => document(`<?xml version="1.0"?><sitemapindex><sitemap><loc>https://example.com/maps/pages.xml</loc></sitemap><sitemap><loc><![CDATA[https://example.com/maps/other.xml?x=1]]></loc></sitemap></sitemapindex>`));
    const nested = await discoverWebsitePaths("https://example.com/", "https://example.com/sitemap.xml", "sitemap", 1000, index.adapter);
    expect(nested.candidates.map((candidate) => candidate.kind)).toEqual(["sitemap", "sitemap"]);
    const map = dependencies(() => document(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/article?ref=a&amp;page=2</loc></url><url><loc>https://other.example/article</loc></url><url><loc>https://example.com/truncated`, { truncated: true }));
    expect(await discoverWebsitePaths("https://example.com/", "https://example.com/maps/pages.xml", "sitemap", 1000, map.adapter)).toMatchObject({ status: "partial", candidates: [{ url: "https://example.com/article", kind: "page" }] });
  });

  it("supports text sitemaps, preserves complete bounded lines, and rejects error HTML", async () => {
    const map = dependencies(() => document("https://example.com/one\nhttps://example.com/two?track=x\nhttps://example.com/incomplete", { truncated: true }));
    expect(urls(await discoverWebsitePaths("https://example.com/", "https://example.com/sitemap.txt", "sitemap", 1000, map.adapter))).toEqual(["https://example.com/one", "https://example.com/two"]);
    const error = dependencies(() => document("<html>not a map</html>"));
    expect((await discoverWebsitePaths("https://example.com/", "https://example.com/sitemap.xml", "sitemap", 1000, error.adapter)).status).toBe("error");
  });

  it("treats absent metadata as a normal empty result but does not hide operational failures", async () => {
    for (const source of ["robots", "sitemap"] as const) {
      for (const statusCode of [404, 410]) {
        const absent = dependencies(() => document("", { statusCode }));
        expect(await discoverWebsitePaths("https://example.com/", `https://example.com/${source}`, source, 1000, absent.adapter)).toMatchObject({ status: "success", candidates: [], message: "网站未提供此文档" });
      }
      const denied = dependencies(() => document("", { statusCode: 403 }));
      expect((await discoverWebsitePaths("https://example.com/", `https://example.com/${source}`, source, 1000, denied.adapter)).status).toBe("error");
    }
  });

  it("retains same-origin redirects as clues without automatically following any destination", async () => {
    const redirect = dependencies(() => document("", { statusCode: 302, location: "/map-index.xml?track=1" }));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/sitemap.xml", "sitemap", 1000, redirect.adapter);
    expect(result).toMatchObject({ status: "partial", candidates: [{ url: "https://example.com/map-index.xml", kind: "sitemap" }] });
    expect(redirect.fetchDocument).toHaveBeenCalledTimes(1);
    const offsite = dependencies(() => document("", { statusCode: 301, location: "http://127.0.0.1/" }));
    expect((await discoverWebsitePaths("https://example.com/", "https://example.com/", "links", 1000, offsite.adapter)).status).toBe("error");
    expect(offsite.fetchDocument).toHaveBeenCalledTimes(1);
  });
});

describe("bounded document decoding", () => {
  it.each(["gzip", "deflate", "br"])("decodes %s response within the discovery bound", async (encoding) => {
    const body = Buffer.from('<a href="/compressed">x</a>');
    const compressed = encoding === "gzip" ? gzipSync(body) : encoding === "deflate" ? deflateSync(body) : brotliCompressSync(body);
    const provider = dependencies(() => document("", { body: compressed, contentEncoding: encoding }));
    expect(urls(await discoverWebsitePaths("https://example.com/", "https://example.com/", "links", 1000, provider.adapter))).toEqual(["https://example.com/compressed"]);
  });

  it("recognizes gzip sitemap files and caps decompressed expansion", async () => {
    const map = dependencies(() => document("", { body: gzipSync(Buffer.from('<urlset><url><loc>https://example.com/gzip-map</loc></url></urlset>')) }));
    expect(urls(await discoverWebsitePaths("https://example.com/", "https://example.com/sitemap.xml.gz", "sitemap", 1000, map.adapter))).toEqual(["https://example.com/gzip-map"]);
    const bomb = dependencies(() => document("", { body: gzipSync(Buffer.from('<a href="/first">x</a>' + " ".repeat(MAX_PATH_DISCOVERY_BYTES * 2))), contentEncoding: "gzip" }));
    expect(await discoverWebsitePaths("https://example.com/", "https://example.com/", "links", 1000, bomb.adapter)).toMatchObject({ status: "partial", candidates: [{ url: "https://example.com/first" }] });
  });
});

describe("archive evidence and interruption", () => {
  it("paginates exact-host archive records and maps historical default protocols onto current origin", async () => {
    const token = "opaque +%2F/token";
    const provider = dependencies((url, call) => {
      expect(url.origin + url.pathname).toBe("https://web.archive.org/cdx/search/cdx");
      expect(url.searchParams.get("url")).toBe("example.com");
      expect(url.searchParams.get("matchType")).toBe("host");
      if (call === 1) return document([["original"], ["http://example.com/old?tracking=1"], ["https://sub.example.com/no"], ["http://example.com:8080/no"], [], [token]]);
      expect(url.searchParams.get("resumeKey")).toBe(token);
      return document([["original"], ["https://example.com/new#section"], ["https://example.com.evil.com/no"]]);
    });
    const result = await discoverWebsitePaths("https://example.com/docs/", "https://example.com/docs/", "wayback", 1000, provider.adapter);
    expect(result.status).toBe("success");
    expect(urls(result)).toEqual(["https://example.com/old", "https://example.com/new"]);
    expect(provider.fetchDocument).toHaveBeenCalledTimes(2);
  });

  it("marks repeated/paging-limited archive sources partial and keeps earlier data on failure", async () => {
    const repeated = dependencies(() => document([["original"], ["https://example.com/one"], [], ["same"]]));
    expect((await discoverWebsitePaths("https://example.com/", "https://example.com/", "wayback", 1000, repeated.adapter)).status).toBe("partial");
    expect(repeated.fetchDocument).toHaveBeenCalledTimes(2);
    const capped = dependencies((_url, call) => document([["original"], [`https://example.com/page${call}`], [], [String(call)]]));
    expect((await discoverWebsitePaths("https://example.com/", "https://example.com/", "wayback", 1000, capped.adapter)).status).toBe("partial");
    expect(capped.fetchDocument).toHaveBeenCalledTimes(4);
    const fail = dependencies((_url, call) => call === 1 ? document([["original"], ["https://example.com/one"], [], ["next"]]) : document("", { statusCode: 429 }));
    expect(await discoverWebsitePaths("https://example.com/", "https://example.com/", "wayback", 1000, fail.adapter)).toMatchObject({ status: "partial", candidates: [{ url: "https://example.com/one" }], message: expect.stringContaining("限流") });
  });

  it("preserves complete archived fields from truncated JSON and rejects malformed source formats", async () => {
    const truncated = dependencies(() => document('[["original"],["https://example.com/one"],["https://example.com/cut', { truncated: true }));
    expect(await discoverWebsitePaths("https://example.com/", "https://example.com/", "wayback", 1000, truncated.adapter)).toMatchObject({ status: "partial", candidates: [{ url: "https://example.com/one" }] });
    const malformed = dependencies(() => document("<html>error details</html>"));
    expect((await discoverWebsitePaths("https://example.com/", "https://example.com/", "wayback", 1000, malformed.adapter)).status).toBe("error");
  });

  it("ends hanging requests at the total deadline and preserves earlier archive clues", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const provider = dependencies((_url, call, currentSignal) => {
      signal = currentSignal;
      return call === 1 ? document([["original"], ["https://example.com/one"], [], ["next"]]) : new Promise(() => {});
    });
    const pending = discoverWebsitePaths("https://example.com/", "https://example.com/", "wayback", 1000, provider.adapter);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ status: "partial", candidates: [{ url: "https://example.com/one" }], message: "发现查询超时" });
    expect(signal?.aborted).toBe(true);
  });

  it("avoids outbound work for invalid scope, unsafe hosts, invalid budget, or cancelled requests", async () => {
    const provider = dependencies(() => document(""));
    await expect(discoverWebsitePaths("https://example.com/", "https://evil.com/", "links", 1000, provider.adapter)).rejects.toThrow();
    await expect(discoverWebsitePaths("http://127.0.0.1/", "http://127.0.0.1/", "links", 1000, provider.adapter)).rejects.toThrow();
    await expect(discoverWebsitePaths("https://example.com/", "https://example.com/", "links", 20001, provider.adapter)).rejects.toThrow();
    const controller = new AbortController(); controller.abort();
    expect((await discoverWebsitePaths("https://example.com/", "https://example.com/", "links", 1000, provider.adapter, controller.signal)).status).toBe("error");
    expect(provider.fetchDocument).not.toHaveBeenCalled();
  });
});
