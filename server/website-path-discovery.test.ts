import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { discoverWebsitePaths, MAX_PATH_DISCOVERY_CANDIDATES, MAX_PATH_DISCOVERY_BYTES, type WebsitePathDiscoveryDependencies } from "./website-path-discovery";
import { MAX_RESPONSE_BYTES, type PublicDocumentResult } from "./network-scan";
import { MAX_PATH_SCRIPT_DOCUMENTS, MAX_PATH_SOURCE_CANDIDATES } from "../src/lib/website-path-kind";

function document(body: unknown, extra: Partial<PublicDocumentResult> = {}): PublicDocumentResult {
  return { url: "https://example.com/", statusCode: 200, body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)), truncated: false, ...extra };
}
function dependencies(fetcher: (url: URL, call: number, signal?: AbortSignal) => PublicDocumentResult | Promise<PublicDocumentResult>) {
  let call = 0;
  const fetchDocument = vi.fn((url: string, options: { timeoutMs: number; maxBytes: number; signal?: AbortSignal }) => {
    expect(options.maxBytes).toBe(MAX_PATH_DISCOVERY_BYTES);
    expect(options.timeoutMs).toBeGreaterThan(0);
    expect(options.timeoutMs).toBeLessThanOrEqual(45000);
    return Promise.resolve(fetcher(new URL(url), ++call, options.signal));
  });
  return { adapter: { fetchDocument } satisfies WebsitePathDiscoveryDependencies, fetchDocument };
}
const urls = (result: Awaited<ReturnType<typeof discoverWebsitePaths>>) => result.candidates.map((candidate) => candidate.url);
afterEach(() => vi.useRealTimers());

describe("observed HTML and script paths", () => {
  it("ignores JSON, plain-text and shader script data blocks without inventing requests or reporting bad JavaScript", async () => {
    const provider = dependencies(() => document('<a href="/real-page">x</a>'
      + '<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite"}</script>'
      + '<script type="application/json">{"api":"/not-a-request"}</script>'
      + '<script type="text/plain">import "/never-executed.js";fetch("/never-fetched");</script>'
      + '<script type="x-shader/x-fragment">void main() { gl_FragColor = vec4(1.0); }</script>'
      + '<script type="x-shader/x-vertex">void main() { gl_Position = vec4(1.0); }</script>'
      + '<script type="application/json" src="/never-loaded.js"></script>'
      + '<script src="/real-classic.js">fetch("/never-inline");</script>'
      + '<script type="module" src="/real-module.js"></script>'));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/", "links", 1000, provider.adapter);
    expect(result.status).toBe("success");
    expect(result.message).toBeUndefined();
    expect(urls(result)).toEqual(["https://example.com/real-page", "https://example.com/real-classic.js", "https://example.com/real-module.js"]);
  });

  it.each(["", 'type=""', 'type="text/javascript"', 'type="application/javascript"', 'type="application/ecmascript"', 'type=" module "', 'language="JavaScript"'])("keeps executable classic and module script requests (%s)", async attribute => {
    const provider = dependencies(() => document(`<script ${attribute}>fetch('/real-request');</script>`));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/", "links", 1000, provider.adapter);
    expect(result.status).toBe("success");
    expect(urls(result)).toEqual(["https://example.com/real-request"]);
  });

  it("reports unsupported inline import maps as a module coverage limit rather than damaged JavaScript", async () => {
    const provider = dependencies(() => document('<script type="importmap">{"imports":{"application":"/mapped-module.js"}}</script>'
      + '<script type="module">fetch("/real-request");</script>'));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/", "links", 1000, provider.adapter);
    expect(result.status).toBe("partial");
    expect(result.message).toContain("importmap 模块映射");
    expect(result.message).not.toContain("脚本语法不完整");
    expect(urls(result)).toEqual(["https://example.com/real-request"]);
  });

  it("uses a worker's own global URL for its downstream requests while keeping imports module-relative", async () => {
    const provider = dependencies(url => document(url.pathname === "/assets/main.js"
      ? "new Worker('workers/classic.js');new Worker(new URL('./workers/module.js',import.meta.url));navigator.serviceWorker.register('workers/sw.js');"
      : "fetch('api/config');import('./support.js');importScripts('./legacy.js');"));
    const initial = await discoverWebsitePaths("https://example.com/", "https://example.com/assets/main.js", "scripts", 1000,
      provider.adapter, undefined, "https://example.com/docs/index.html");
    expect(new Set(urls(initial))).toEqual(new Set(["https://example.com/docs/workers/classic.js", "https://example.com/assets/workers/module.js", "https://example.com/docs/workers/sw.js"]));
    expect(initial.candidates.every(candidate => candidate.documentUrl === candidate.url)).toBe(true);
    const helper = await discoverWebsitePaths("https://example.com/", "https://example.com/assets/helpers/nested.js", "scripts", 1000,
      provider.adapter, undefined, "https://example.com/docs/workers/classic.js");
    expect(new Set(urls(helper))).toEqual(new Set(["https://example.com/docs/workers/api/config", "https://example.com/assets/helpers/support.js", "https://example.com/docs/workers/legacy.js"]));
  });

  it("extracts literal same-origin links/assets and honors first base, entities, query stripping and exact files", async () => {
    const provider = dependencies(() => document(`<base href="/docs/"><base href="/ignored/"><a href="getting-started?utm_source=x#section">x</a><a href="&#x2f;index.html">file</a><script src="../app.js?v=1"></script><link rel="stylesheet" href="style.css"><img src="hero.png"><a href="https://evil.com/no">outside</a><a href="//example.com.evil/no">evil</a><a href="http://example.com/other">other origin</a><a href="javascript:alert(1)">js</a><form action="/submit"><input name="action"></form><a href="#anchor">anchor</a>`));
    const result = await discoverWebsitePaths("https://example.com/start", "https://example.com/start", "links", 1000, provider.adapter);
    expect(result.status).toBe("success");
    expect(urls(result)).toEqual(["https://example.com/docs/getting-started", "https://example.com/index.html", "https://example.com/app.js"]);
    expect(result.candidates.find((candidate) => candidate.kind === "script")).toMatchObject({ documentUrl: "https://example.com/docs/" });
    expect(provider.fetchDocument).toHaveBeenCalledTimes(1);
  });

  it("handles external bases without inventing local relative links or fetch contexts", async () => {
    const provider = dependencies(() => document(`<base href="https://cdn.other.com/assets/"><a href="relative">x</a><script src="https://example.com/app.js"></script><a href="https://example.com/absolute">x</a><script>fetch('relative/api');fetch('https://example.com/api');import('https://example.com/module.js');</script>`));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/", "links", 1000, provider.adapter);
    expect(result.status).toBe("partial");
    expect(urls(result)).toEqual(["https://example.com/absolute", "https://example.com/api"]);
  });

  it("normalizes ordinary HTML URL spaces before applying a base and resolving script ownership", async () => {
    const provider = dependencies(() => document('<base href="/my docs/"><a href="getting started?from=nav#intro">Start</a><script src="app bundle.js"></script><script>fetch("api/status");</script>'));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/", "links", 1000, provider.adapter);
    expect(new Set(urls(result))).toEqual(new Set([
      "https://example.com/my%20docs/getting%20started", "https://example.com/my%20docs/app%20bundle.js", "https://example.com/my%20docs/api/status"
    ]));
    expect(result.candidates.find(candidate => candidate.kind === "script")).toMatchObject({ documentUrl: "https://example.com/my%20docs/" });
  });

  it("still rejects HTML URL controls, credentials, dynamic segments and ambiguous backslashes", async () => {
    const provider = dependencies(() => document('<base href="/bad\nbase/"><a href="/good path">Good</a><a href="/bad\npath">bad</a><a href="/bad&#9;tab">bad</a><a href="/bad%0Aencoded">bad</a><a href="/bad\\path">bad</a><a href="/api/${id}">dynamic</a><a href="https://user:pass@example.com/private">credentials</a><a href="#section">fragment</a>'));
    const result = await discoverWebsitePaths("https://example.com/docs/page", "https://example.com/docs/page", "links", 1000, provider.adapter);
    expect(urls(result)).toEqual(["https://example.com/good%20path"]);
  });
  it("strips query templates before inspecting concrete paths and normalizes base owner contexts", async () => {
    const provider = dependencies(() => document(`<base href="/docs/?v=1#frag"><script src="app.js"></script><a href="/api?filter=%7Bvalue%7D">x</a><a href="/api?glob=*">x</a><a href="/search?q=hello%20world">x</a><a href="/files/Quarterly%20Report.pdf">x</a>`));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/", "links", 1000, provider.adapter);
    expect(urls(result)).toEqual(["https://example.com/docs/app.js", "https://example.com/api", "https://example.com/search"]);
    expect(result.candidates[0].documentUrl).toBe("https://example.com/docs/");
  });
  it("keeps script owner context on kind upgrades and combines actual source provenance", async () => {
    const provider = dependencies(() => document(`<base href="/portal/"><a href="/assets/app">x</a><link rel="preload" href="/assets/app" as="script"><script src="/assets/app"></script><a href="/api">x</a><script>fetch('/api');</script>`));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/", "links", 1000, provider.adapter);
    expect(result.candidates[0]).toMatchObject({ url: "https://example.com/assets/app", kind: "script", documentUrl: "https://example.com/portal/" });
    expect(result.candidates[1]).toMatchObject({ url: "https://example.com/api", source: "links", sources: ["links", "scripts"] });
  });

  it("distinguishes fetch/XHR owner-document relatives from imported module relatives", async () => {
    const provider = dependencies(() => document(`fetch('api/list?tracking=1');const xhr=new XMLHttpRequest();xhr.open("GET", "v1/items");import('./chunk.js');import helper from '../helpers.js';export { x } from './export.js';createBrowserRouter([{path:"/dashboard"}]);const unused=['/users/:id', '/files/{id}', '/api/' + id, '/joined/'.concat(id), \`/dynamic/\${id}\`]; // '/comment-only'
      const escaped = "\\x2fapi\\u002fv2";fetch(escaped);/* '/another-comment' */`));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/assets/main.js", "scripts", 1000, provider.adapter, undefined, "https://example.com/docs/page");
    expect(new Set(urls(result))).toEqual(new Set(["https://example.com/docs/api/list", "https://example.com/docs/v1/items", "https://example.com/assets/chunk.js", "https://example.com/helpers.js", "https://example.com/assets/export.js", "https://example.com/dashboard", "https://example.com/api/v2"]));
    expect(result.candidates.find((candidate) => candidate.url.endsWith("chunk.js"))).toMatchObject({ kind: "script", documentUrl: "https://example.com/docs/page" });
  });

  it("extracts inline fetch clues with script provenance and never reads markup inside JS strings", async () => {
    const provider = dependencies(() => document(`<script>fetch('api/items');import('./part.js');let text='<a href="invented">';</script><!-- <a href="/comment"> --><a href="/actual">x</a>`));
    const result = await discoverWebsitePaths("https://example.com/docs/page", "https://example.com/docs/page", "links", 1000, provider.adapter);
    expect(new Set(urls(result))).toEqual(new Set(["https://example.com/actual", "https://example.com/docs/api/items", "https://example.com/docs/part.js"]));
    expect(result.candidates[1].source).toBe("scripts");
  });
  it("does not invent relative paths from header, map or arbitrary method reads", async () => {
    const provider = dependencies(() => document(`response.headers.get('x-sentry-event-id');headers.get('x-request-id');records.get('reports');post('event-name');
      records.get('/observed-path');fetch('api/items');axios.get('api/health');const xhr=new XMLHttpRequest();xhr.open('GET', 'api/status');`));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/assets/main.js", "scripts", 1000, provider.adapter, undefined, "https://example.com/docs/page");
    expect(urls(result)).toEqual([
      "https://example.com/docs/api/items", "https://example.com/docs/api/health", "https://example.com/docs/api/status"
    ]);
    for (const invented of ["/observed-path", "/docs/reports", "/docs/event-name", "/docs/x-request-id", "/docs/x-sentry-event-id"]) {
      expect(urls(result)).not.toContain(`https://example.com${invented}`);
    }
  });
  it("preserves comment-like script strings and ignores links inside HTML comments or raw text", async () => {
    const provider = dependencies(() => document(`<!-- <script>fetch('/comment-script');</script><a href="/comment-link"> -->
      <script>const marker = "<!-- "; fetch('/api/users'); const markup = '<a href="/script-text">';</script>
      <style>p::after { content: '<a href="/style-text">'; }</style>
      <textarea><a href="/textarea-text">example</a></textarea>
      <title><a href="/title-text">example</a></title><a href="/about" title="<!-- text">About</a>`));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/", "links", 1000, provider.adapter);
    expect(result.status).toBe("success");
    expect(urls(result)).toEqual(["https://example.com/about", "https://example.com/api/users"]);
  });
  it("keeps complete script paths without inventing a URL from a cut-off string", async () => {
    const provider = dependencies(() => document('fetch("/complete");const broken="/unfinished', { truncated: true }));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/app.js", "scripts", 1000, provider.adapter);
    expect(result.status).toBe("partial");
    expect(urls(result)).toEqual(["https://example.com/complete"]);
    const inline = dependencies(() => document('<script>fetch("/complete");const broken="<a href=\'/invented\'>', { truncated: true }));
    expect(urls(await discoverWebsitePaths("https://example.com/", "https://example.com/", "links", 1000, inline.adapter))).toEqual(["https://example.com/complete"]);
  });
  it("resolves complete constant request URLs without treating their fragments as standalone paths", async () => {
    const provider = dependencies(() => document(`const api='/api'; const version=api+'/v1';
      fetch(version+'/users'); axios.get('/health'+'/ready'); const xhr=new XMLHttpRequest();xhr.open('GET', 'api/'+'items');`));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/assets/app.js", "scripts", 1000, provider.adapter, undefined, "https://example.com/docs/page");
    expect(result.status).toBe("success");
    expect(urls(result)).toEqual(["https://example.com/api/v1/users", "https://example.com/health/ready", "https://example.com/docs/api/items"]);
    expect(result.candidates.every(candidate => candidate.source === "scripts" && !candidate.clientRoute)).toBe(true);
  });
  it("retains observed complete conditional paths when a request expression is not statically resolvable", async () => {
    const provider = dependencies(() => document(`fetch(flag ? '/one' : '/two'); fetch('/api/' + id);`));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/app.js", "scripts", 1000, provider.adapter);
    expect(urls(result)).toEqual(["https://example.com/one", "https://example.com/two"]);
  });
  it("restores observed API wrapper prefixes instead of scanning their root-level suffixes", async () => {
    const provider = dependencies(() => document(`const prefix='/api';
      async function request(path,options){const response=await fetch(\`\${prefix}\${path}\`,options);return response.json()}
      function post(path,data){return request(path,{method:'POST',body:JSON.stringify(data)})}
      request('/config');post('/beta/holder',{});
      const supportBase=''.trim()||'';async function support(path,token){return fetch(\`\${supportBase}/api/support\${path}\`,{headers:{authorization:token}})}
      support('/reports',token);`));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/app.js", "scripts", 1000, provider.adapter);
    expect(urls(result)).toEqual([
      "https://example.com/api/config", "https://example.com/api/beta/holder", "https://example.com/api/support/reports"
    ]);
    for (const path of ["/config", "/beta/holder", "/reports", "/api"]) expect(urls(result)).not.toContain(`https://example.com${path}`);
  });
  it("joins declared nested route paths and preserves their script provenance in inline documents", async () => {
    const provider = dependencies(() => document(`<a href='/dashboard/settings'>Settings</a><script>
      createBrowserRouter([{path:'/dashboard',children:[{path:'settings'}, {path:':id',children:[{path:'edit'}]}, {path:'help',children:[{path:'faq'}]}]}]);
    </script>`));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/", "links", 1000, provider.adapter);
    expect(result.candidates.filter(candidate => candidate.clientRoute).map(candidate => candidate.url)).toEqual([
      "https://example.com/dashboard/settings", "https://example.com/dashboard", "https://example.com/dashboard/help", "https://example.com/dashboard/help/faq"
    ]);
    expect(result.candidates.find(candidate => candidate.url.endsWith('/dashboard/settings'))).toMatchObject({ source: "links", sources: ["links", "scripts"] });
    expect(urls(result)).not.toContain("https://example.com/dashboard/edit");
    expect(urls(result)).not.toContain("https://example.com/settings");
  });
  it("skips bare modules and ambiguous relatives while resolving import.meta and worker imports correctly", async () => {
    const provider = dependencies(() => document(`import React from 'react';import('package/path');export { x } from 'other-package';new URL('./logo.svg', import.meta.url);importScripts('worker.js');const ambiguous='./maybe';fetch('/api/' /* dynamic */ + id);const route='/route';location.assign(route);`));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/assets/main.js", "scripts", 1000, provider.adapter, undefined, "https://example.com/docs/page");
    expect(urls(result)).toEqual(["https://example.com/docs/worker.js", "https://example.com/route"]);
  });
  it("ignores static files regardless of encoded extension case and retains JSON APIs", async () => {
    const provider = dependencies(() => document(`<a href="/theme.CSS">x</a><img src="/hero%2EPNG"><link rel="stylesheet" href="/styles"><script src="/app%2eJS"></script><a href="/api/users.json">x</a><a href="/page.html">x</a><a href="/account.php">x</a><a href="/login.aspx">x</a>`));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/", "links", 1000, provider.adapter);
    expect(urls(result)).toEqual(["https://example.com/app%2eJS", "https://example.com/api/users.json", "https://example.com/page.html", "https://example.com/account.php", "https://example.com/login.aspx"]);
    expect(result.candidates[0].kind).toBe("script");
  });
  it("lets more than 2000 assets precede actual paths without exhausting page capacity", async () => {
    const provider = dependencies(() => document(Array.from({ length: 2200 }, (_, i) => `<img src="/image-${i}.png">`).join("") + '<a href="/actual-page">x</a><script src="/app.js"></script>'));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/", "links", 1000, provider.adapter);
    expect(result.status).toBe("success");
    expect(urls(result)).toEqual(["https://example.com/actual-page", "https://example.com/app.js"]);
  });
  it("preserves explicit extensionless or page-named asset markers without consuming page or script capacity", async () => {
    const provider = dependencies(() => document('<a href="/styles">old link</a><link rel="stylesheet" href="/styles"><img src="/image.php"><a href="/styles">same link later</a><img src="/known.png"><script src="/app.js"></script><a href="/actual-page">x</a>'));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/", "links", 1000, provider.adapter);
    expect(result).toMatchObject({ status: "success", ignoredUrls: ["https://example.com/styles", "https://example.com/image.php"] });
    expect(urls(result)).toEqual(["https://example.com/app.js", "https://example.com/actual-page"]);
  });
  it("bounds extensionless resource metadata independently and reports omitted markers", async () => {
    const provider = dependencies(() => document(Array.from({ length: 2001 }, (_, i) => `<img src="/image/unknown-${i}">`).join("") + '<a href="/actual-page">x</a><script src="/app.js"></script>'));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/", "links", 1000, provider.adapter);
    expect(result.status).toBe("partial");
    expect(result.ignoredUrls).toHaveLength(2000);
    expect(result.message).toContain("标记上限");
    expect(urls(result)).toEqual(["https://example.com/actual-page", "https://example.com/app.js"]);
  });
  it("caps script clues independently without dropping actual page paths", async () => {
    const provider = dependencies(() => document(Array.from({ length: MAX_PATH_SCRIPT_DOCUMENTS + 5 }, (_, i) => `<link rel="modulepreload" href="/app-${i}.js">`).join("") + '<a href="/actual-page">x</a>'));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/", "links", 1000, provider.adapter);
    expect(result.status).toBe("partial");
    expect(result.candidates.filter(candidate => candidate.kind === "script")).toHaveLength(MAX_PATH_SCRIPT_DOCUMENTS);
    expect(result.message).toContain(`${MAX_PATH_SCRIPT_DOCUMENTS} 份脚本线索上限`);
    expect(urls(result)).toContain("https://example.com/actual-page");
  });

  it("keeps all 188 published module imports and the request following a modern bundle's import table", async () => {
    const script = Array.from({ length: 188 }, (_, index) => `import './chunk-${index}.js';`).join("\n") + "\nfetch('/after-import-table');";
    const provider = dependencies(() => document(script, { contentType: "text/javascript" }));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/assets/vendor.js", "scripts", 1000, provider.adapter);
    expect(result.status).toBe("success");
    expect(result.candidates.filter(candidate => candidate.kind === "script")).toHaveLength(188);
    expect(urls(result)).toContain("https://example.com/assets/chunk-187.js");
    expect(urls(result)).toContain("https://example.com/after-import-table");
  });

  it("fits independent full page, script and sitemap budgets within the shared response bound", async () => {
    const html = Array.from({ length: MAX_PATH_DISCOVERY_CANDIDATES }, (_, index) => `<a href="/page-${index}">x</a>`).join("")
      + Array.from({ length: MAX_PATH_SCRIPT_DOCUMENTS }, (_, index) => `<link rel="modulepreload" href="/chunk-${index}.js">`).join("")
      + Array.from({ length: 20 }, (_, index) => `<link rel="sitemap" href="/map-${index}.xml">`).join("");
    const provider = dependencies(() => document(html, { contentType: "text/html" }));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/", "links", 20000, provider.adapter);
    expect(result.status).toBe("success");
    expect(result.candidates.filter(candidate => candidate.kind === "page")).toHaveLength(MAX_PATH_DISCOVERY_CANDIDATES);
    expect(result.candidates.filter(candidate => candidate.kind === "script")).toHaveLength(MAX_PATH_SCRIPT_DOCUMENTS);
    expect(result.candidates.filter(candidate => candidate.kind === "sitemap")).toHaveLength(20);
    expect(result.candidates.length).toBeLessThanOrEqual(MAX_PATH_SOURCE_CANDIDATES);
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

  it("accepts schema location children while excluding image, video and nested metadata URLs", async () => {
    const provider = dependencies(() => document('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"><url><loc>https://example.com/page</loc><image:image><image:loc>https://example.com/media/preview</image:loc></image:image><video:video><video:loc>https://example.com/video/preview</video:loc></video:video><metadata><loc>https://example.com/nested-fake</loc></metadata></url><image:url><loc>https://example.com/image-fake</loc></image:url></urlset>'));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/sitemap.xml", "sitemap", 1000, provider.adapter);
    expect(result.status).toBe("success");
    expect(urls(result)).toEqual(["https://example.com/page"]);
  });

  it("resolves prefixed sitemap namespaces and ignores a location rebound to another namespace", async () => {
    const provider = dependencies(() => document('<sm:sitemapindex xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9"><sm:sitemap><sm:loc><![CDATA[https://example.com/maps/actual.xml]]></sm:loc><sm:loc xmlns:sm="urn:unrelated">https://example.com/maps/fake.xml</sm:loc></sm:sitemap></sm:sitemapindex>'));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/sitemap.xml", "sitemap", 1000, provider.adapter);
    expect(result.status).toBe("success");
    expect(result.candidates).toEqual([expect.objectContaining({ url: "https://example.com/maps/actual.xml", kind: "sitemap" })]);
  });

  it("preserves complete sitemap locations before a truncated tail and never expands external entities", async () => {
    const partial = dependencies(() => document('<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9"><sm:url><sm:loc>https://example.com/kept</sm:loc></sm:url><sm:url><sm:loc>https://example.com/incomplete', { truncated: true }));
    expect(await discoverWebsitePaths("https://example.com/", "https://example.com/sitemap.xml", "sitemap", 1000, partial.adapter))
      .toMatchObject({ status: "partial", candidates: [{ url: "https://example.com/kept" }] });
    const entity = dependencies(() => document('<!DOCTYPE urlset [<!ENTITY external SYSTEM "https://example.com/private">]><urlset><url><loc>&external;</loc></url></urlset>'));
    expect(await discoverWebsitePaths("https://example.com/", "https://example.com/sitemap.xml", "sitemap", 1000, entity.adapter))
      .toMatchObject({ status: "error", candidates: [], message: "网站地图不支持 DTD 或外部实体" });
    expect(entity.fetchDocument).toHaveBeenCalledTimes(1);
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
    expect(provider.fetchDocument).toHaveBeenCalledWith("https://example.com/", expect.objectContaining({
      headers: { "Accept-Encoding": "gzip, deflate, br" }
    }));
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

describe("published client route manifests", () => {
  const manifest = (navigation = "pages.map(page=>({to:route(page.slug)}))", extras = "") => `
    const prefix='/docs';
    const pages=[{slug:'introduction', analytics:{slug:'not-a-page'}},{slug:'pulling'},{slug:'items'}];
    function route(value){return \`\${prefix}/\${value}\`}
    const routes=[{path:\`\${prefix}/:slug\`}];
    const links=${navigation};${extras}`;

  it("recovers only literal values from the navigation collection without running nested templates", async () => {
    const provider = dependencies(() => document("const className=`outer ${ok?`inner ${size}`:'plain'}`; const pattern=/[\"'`]/g;" + manifest(undefined, "const unrelated={slug:'analytics-event'};")));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/app.js", "scripts", 1000, provider.adapter);
    expect(result.candidates.filter(value => value.clientRoute).map(value => value.url)).toEqual([
      "https://example.com/docs/introduction", "https://example.com/docs/pulling", "https://example.com/docs/items"
    ]);
    expect(urls(result)).not.toContain("https://example.com/docs");
    expect(urls(result)).not.toContain("https://example.com/docs/not-a-page");
    expect(urls(result)).not.toContain("https://example.com/docs/analytics-event");
  });

  it.each([
    "pages.map(page=>({to:route(analytics.slug)}))",
    "pages.map(page=>({...page,slug:'changed'})).map(page=>({to:route(page.slug)}))"
  ])("does not treat an unrelated callback or rewritten collection as declared routes", async navigation => {
    const provider = dependencies(() => document(manifest(navigation)));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/app.js", "scripts", 1000, provider.adapter);
    expect(result.candidates.some(value => value.clientRoute)).toBe(false);
  });

  it("does not resolve a prefix reassigned to a dynamic value", async () => {
    const provider = dependencies(() => document(manifest().replace("const prefix='/docs';", "let prefix='/docs';prefix=getBase();")));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/app.js", "scripts", 1000, provider.adapter);
    expect(result.candidates.some(value => value.clientRoute)).toBe(false);
  });

  it.each([
    'const route=value=>`${prefix}/${value}`;',
    'const route=(value)=>`${prefix}/${value}`;',
    'const route=(value)=>{return `${prefix}/${value}`;};'
  ])("recovers manifest navigation using an arrow helper (%s)", async helper => {
    const provider = dependencies(() => document(manifest().replace('function route(value){return `${prefix}/${value}`}', helper)));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/app.js", "scripts", 1000, provider.adapter);
    expect(result.candidates.filter(value => value.clientRoute).map(value => value.url)).toEqual([
      "https://example.com/docs/introduction", "https://example.com/docs/pulling", "https://example.com/docs/items"
    ]);
  });

  it("recovers the observed docs structure with nested templates, grouped original pages and distinct callback names", async () => {
    const script = "const className=`outer ${ok?`inner ${size}`:'plain'}`; const pattern=/[\"'`]/g;" + manifest().replace(
      "const links=pages.map(page=>({to:route(page.slug)}));",
      "const groups=pages.reduce((acc,item)=>{const group=acc.at(-1);return group?.name===item.group?[...acc.slice(0,-1),{...group,pages:[...group.pages,item]}]:[...acc,{name:item.group,pages:[item]}]},[]);const links=groups.map(group=>group.pages.map(item=>({to:route(item.slug)})));"
    );
    const provider = dependencies(() => document(script));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/app.js", "scripts", 1000, provider.adapter);
    expect(result.candidates.filter(value => value.clientRoute).map(value => value.url)).toEqual([
      "https://example.com/docs/introduction", "https://example.com/docs/pulling", "https://example.com/docs/items"
    ]);
  });

  it("keeps provenance when a declared route was already seen as an HTML link", async () => {
    const provider = dependencies(() => document(`<a href='/docs/items'>Items</a><script>${manifest()}</script>`));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/", "links", 1000, provider.adapter);
    expect(result.candidates.find(value => value.url.endsWith("/docs/items"))).toMatchObject({ source: "links", sources: ["links", "scripts"], clientRoute: true });
  });

  it("clears route metadata when an explicit import establishes the same URL as a script", async () => {
    const provider = dependencies(() => document(manifest() + "import('/docs/items');"));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/app.js", "scripts", 1000, provider.adapter);
    const resource = result.candidates.find(value => value.url.endsWith("/docs/items"));
    expect(resource?.kind).toBe("script");
    expect(resource?.clientRoute).toBeUndefined();
  });

  it("marks limited static analysis partial and retains ordinary observed paths", async () => {
    let clock = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock += 50);
    try {
      const provider = dependencies(() => document("fetch('/observed');" + manifest()));
      const result = await discoverWebsitePaths("https://example.com/", "https://example.com/app.js", "scripts", 1000, provider.adapter);
      expect(result.status).toBe("partial");
      expect(result.message).toContain("静态前端路由解析时间上限");
      expect(urls(result)).toContain("https://example.com/observed");
    } finally { now.mockRestore(); }
  });

  it("ignores incomplete router markers while preserving ordinary encoded paths and dollar names", async () => {
    const provider = dependencies(() => document("fetch('/:');fetch('/$');fetch('/&');fetch('/my%20file');fetch('/$price');fetch('/index.html');"));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/app.js", "scripts", 1000, provider.adapter);
    expect(urls(result)).toEqual(["https://example.com/my%20file", "https://example.com/$price", "https://example.com/index.html"]);
  });

  it("reports a bounded set of route templates without unbounded static analysis", async () => {
    const provider = dependencies(() => document(manifest() + Array.from({ length: 30 }, (_, index) => "const extra" + index + "={path:`${prefix}/:parameter" + index + "`};").join("")));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/app.js", "scripts", 1000, provider.adapter);
    expect(result.status).toBe("partial");
    expect(result.message).toContain("静态前端路由清单读取上限");
    expect(result.candidates.filter(value => value.clientRoute)).toHaveLength(3);
  });
});

describe("observed HTTPS entry upgrades", () => {
  it("exposes the actual same-host HTTPS redirect without following it or retaining tracking parameters", async () => {
    const provider = dependencies(() => document("", { statusCode: 301, location: "https://example.com/docs/?tracking=1#section" }));
    const result = await discoverWebsitePaths("http://example.com/", "http://example.com/", "links", 1000, provider.adapter);
    expect(result).toMatchObject({ status: "success", url: "http://example.com/", canonicalUrl: "https://example.com/docs/", candidates: [] });
    expect(provider.fetchDocument).toHaveBeenCalledTimes(1);
  });

  it.each(["https://other.com/", "https://user:pass@example.com/", "https://example.com:8443/", "http://example.com/another", "https://example.com/:id"])("does not expose an unsafe or unsupported scope migration (%s)", async location => {
    const provider = dependencies(() => document("", { statusCode: 301, location }));
    const result = await discoverWebsitePaths("http://example.com/", "http://example.com/", "links", 1000, provider.adapter);
    expect(result.canonicalUrl).toBeUndefined();
    expect(provider.fetchDocument).toHaveBeenCalledTimes(1);
  });
});

describe("scan-scoped document reads and discovery evidence", () => {
  it("allows a 45-second script read while keeping other discovery sources within 20 seconds", async () => {
    const provider = dependencies(() => document("fetch('/api/long-script');"));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/assets/long.js", "scripts", 45000, provider.adapter);
    expect(result.status).toBe("success");
    expect(urls(result)).toEqual(["https://example.com/api/long-script"]);
    expect(provider.fetchDocument.mock.calls[0][1].timeoutMs).toBeGreaterThan(44000);
    await expect(discoverWebsitePaths("https://example.com/", "https://example.com/assets/long.js", "scripts", 45001, provider.adapter)).rejects.toThrow("45000");
    for (const source of ["links", "robots", "sitemap", "wayback"] as const) {
      await expect(discoverWebsitePaths("https://example.com/", "https://example.com/", source, 21000, provider.adapter)).rejects.toThrow("20000");
    }
    expect(provider.fetchDocument).toHaveBeenCalledTimes(1);
  });

  it("defaults script reads to 45 seconds and ordinary document reads to 20 seconds", async () => {
    const provider = dependencies(url => url.pathname.endsWith(".js") ? document("fetch('/api/default-script');") : document('<a href="/ordinary-page">x</a>'));
    await discoverWebsitePaths("https://example.com/", "https://example.com/assets/default.js", "scripts", undefined, provider.adapter);
    await discoverWebsitePaths("https://example.com/", "https://example.com/", "links", undefined, provider.adapter);
    expect(provider.fetchDocument.mock.calls[0][1].timeoutMs).toBeGreaterThan(44000);
    expect(provider.fetchDocument.mock.calls[0][1].timeoutMs).toBeLessThanOrEqual(45000);
    expect(provider.fetchDocument.mock.calls[1][1].timeoutMs).toBeGreaterThan(19000);
    expect(provider.fetchDocument.mock.calls[1][1].timeoutMs).toBeLessThanOrEqual(20000);
  });

  it("still cancels a hanging script request at its independent 45-second deadline", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const provider = dependencies((_url, _call, signal) => {
      requestSignal = signal;
      return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    let settled = false;
    const pending = discoverWebsitePaths("https://example.com/", "https://example.com/assets/deadline.js", "scripts", 45000, provider.adapter)
      .then(result => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(44999);
    expect(settled).toBe(false);
    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ status: "error", message: "发现查询超时", retryable: true });
    expect(requestSignal?.aborted).toBe(true);
  });

  it("downloads a shared script once while resolving requests against each owning directory", async () => {
    const script = "fetch('api/config');import('./chunk.js');";
    const provider = dependencies(() => document(script, { contentType: "application/javascript" }));
    const [first, second] = await Promise.all([
      discoverWebsitePaths("https://example.com/", "https://example.com/assets/shared.js", "scripts", 1000, provider.adapter, undefined, "https://example.com/one/page", "shared-owner-round"),
      discoverWebsitePaths("https://example.com/", "https://example.com/assets/shared.js", "scripts", 1000, provider.adapter, undefined, "https://example.com/two/page", "shared-owner-round")
    ]);
    expect(provider.fetchDocument).toHaveBeenCalledTimes(1);
    expect(new Set(urls(first))).toEqual(new Set(["https://example.com/one/api/config", "https://example.com/assets/chunk.js"]));
    expect(new Set(urls(second))).toEqual(new Set(["https://example.com/two/api/config", "https://example.com/assets/chunk.js"]));
    expect(first.document).toEqual({ url: "https://example.com/assets/shared.js", bytes: Buffer.byteLength(script), truncated: false, cacheHit: false });
    expect(second.document).toEqual({ ...first.document, cacheHit: true });
    expect(second.candidates.find(candidate => candidate.url.endsWith("/two/api/config"))?.evidence)
      .toEqual({ kind: "request", documentUrl: "https://example.com/assets/shared.js", bytes: Buffer.byteLength(script), truncated: false, methods: ["GET"] });
  });

  it("keeps separate scan rounds independent even when the script URL is identical", async () => {
    const provider = dependencies((_url, call) => document(`fetch('/api/version-${call}');`));
    const first = await discoverWebsitePaths("https://example.com/", "https://example.com/assets/round.js", "scripts", 1000, provider.adapter, undefined, undefined, "isolated-first-round");
    const second = await discoverWebsitePaths("https://example.com/", "https://example.com/assets/round.js", "scripts", 1000, provider.adapter, undefined, undefined, "isolated-second-round");
    expect(provider.fetchDocument).toHaveBeenCalledTimes(2);
    expect(urls(first)).toEqual(["https://example.com/api/version-1"]);
    expect(urls(second)).toEqual(["https://example.com/api/version-2"]);
    expect(first.document?.cacheHit).toBe(false);
    expect(second.document?.cacheHit).toBe(false);
  });

  it("marks a 503 retryable and fetches fresh content on the next attempt in the same round", async () => {
    const script = "fetch('/api/recovered');";
    const provider = dependencies((_url, call) => call === 1 ? document("unavailable", { statusCode: 503 }) : document(script));
    const first = await discoverWebsitePaths("https://example.com/", "https://example.com/assets/retry.js", "scripts", 1000, provider.adapter, undefined, undefined, "retry-after-503-round");
    expect(first).toMatchObject({ status: "error", retryable: true, candidates: [], message: "文档返回 HTTP 503",
      document: { bytes: Buffer.byteLength("unavailable"), truncated: false, cacheHit: false } });
    const recovered = await discoverWebsitePaths("https://example.com/", "https://example.com/assets/retry.js", "scripts", 1000, provider.adapter, undefined, undefined, "retry-after-503-round");
    expect(provider.fetchDocument).toHaveBeenCalledTimes(2);
    expect(recovered).toMatchObject({ status: "success", document: { bytes: Buffer.byteLength(script), cacheHit: false } });
    expect(urls(recovered)).toEqual(["https://example.com/api/recovered"]);
  });

  it("marks a timed-out read retryable and does not reuse its abandoned transport", async () => {
    vi.useFakeTimers();
    let abandoned: AbortSignal | undefined;
    const provider = dependencies((_url, call, signal) => {
      if (call > 1) return document("fetch('/api/after-timeout');");
      abandoned = signal;
      return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const pending = discoverWebsitePaths("https://example.com/", "https://example.com/assets/hanging.js", "scripts", 1000, provider.adapter, undefined, undefined, "retry-after-timeout-round");
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ status: "error", retryable: true, message: "发现查询超时", candidates: [] });
    expect(abandoned?.aborted).toBe(true);
    const recovered = await discoverWebsitePaths("https://example.com/", "https://example.com/assets/hanging.js", "scripts", 1000, provider.adapter, undefined, undefined, "retry-after-timeout-round");
    expect(provider.fetchDocument).toHaveBeenCalledTimes(2);
    expect(recovered).toMatchObject({ status: "success", document: { cacheHit: false } });
    expect(urls(recovered)).toEqual(["https://example.com/api/after-timeout"]);
  });

  it("reports decoded document bytes and truncation on each candidate's source evidence", async () => {
    const script = "fetch('/api/complete');";
    const provider = dependencies(() => document(gzipSync(script), { body: gzipSync(script), contentEncoding: "gzip", truncated: true }));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/assets/compressed.js", "scripts", 1000, provider.adapter, undefined, undefined, "compressed-evidence-round");
    expect(result).toMatchObject({ status: "partial", document: { url: "https://example.com/assets/compressed.js", bytes: Buffer.byteLength(script), truncated: true, cacheHit: false } });
    expect(result.candidates).toEqual([expect.objectContaining({ url: "https://example.com/api/complete", evidence: {
      kind: "request", documentUrl: "https://example.com/assets/compressed.js", bytes: Buffer.byteLength(script), truncated: true
    } })]);
    expect(result.response?.decodedBodyLength).toBeUndefined();
  });

  it("does not infer constants or wrappers from a document whose missing tail could modify them", async () => {
    const script = "const prefix='/api'; function request(path){return fetch(prefix+path)} request('/inferred'); fetch('/complete'); import('./next.js');";
    const provider = dependencies(() => document(script, { truncated: true }));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/assets/cut.js", "scripts", 1000, provider.adapter);
    expect(result.status).toBe("partial");
    expect(new Set(urls(result))).toEqual(new Set(["https://example.com/complete", "https://example.com/assets/next.js"]));
    expect(result.message).toContain("截断");
  });

  it("discovers a mint config request only after following the homepage's published module preload", async () => {
    const homepage = '<link rel="modulepreload" href="/assets/live-a1b2.js"><script>fetch("/api/bootstrap");</script>';
    const script = "const prefix='/api';async function request(path){const response=await fetch(prefix+path);return response.json()}function load(){return request('/mint/config')}load();";
    const provider = dependencies(url => url.pathname === "/" ? document(homepage, { contentType: "text/html" }) : url.pathname === "/assets/live-a1b2.js"
      ? document(script, { contentType: "application/javascript" }) : (() => { throw new Error(`Unexpected document: ${url.href}`); })());
    const entry = await discoverWebsitePaths("https://example.com/", "https://example.com/", "links", 1000, provider.adapter, undefined, undefined, "homepage-discovery-round");
    expect(urls(entry)).toContain("https://example.com/api/bootstrap");
    expect(urls(entry)).not.toContain("https://example.com/api/mint/config");
    const publishedScript = entry.candidates.find(candidate => candidate.kind === "script");
    expect(publishedScript).toMatchObject({ url: "https://example.com/assets/live-a1b2.js", documentUrl: "https://example.com/", evidence: { documentUrl: "https://example.com/" } });
    const discovered = await discoverWebsitePaths("https://example.com/", publishedScript!.url, "scripts", 1000, provider.adapter, undefined, publishedScript!.documentUrl, "homepage-discovery-round");
    expect(provider.fetchDocument.mock.calls.map(([url]) => url)).toEqual(["https://example.com/", "https://example.com/assets/live-a1b2.js"]);
    expect(discovered.candidates).toEqual([expect.objectContaining({ url: "https://example.com/api/mint/config", source: "scripts", evidence: {
      kind: "request", documentUrl: "https://example.com/assets/live-a1b2.js", bytes: Buffer.byteLength(script), truncated: false, methods: ["GET"]
    } })]);
  });

  it("preserves the completed GET response when an HTML discovery document returns 404", async () => {
    const body = '<title>Not found</title><a href="/fake-page">not a published page</a>';
    const provider = dependencies(() => document(body, { statusCode: 404, contentType: "text/html", contentLength: Buffer.byteLength(body) }));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/missing-page", "links", 1000, provider.adapter);
    expect(result).toMatchObject({ status: "error", candidates: [], response: {
      url: "https://example.com/missing-page", status: "responded", statusCode: 404, title: "Not found",
      contentLength: Buffer.byteLength(body), decodedBodyLength: Buffer.byteLength(body),
      fingerprint: createHash("sha256").update(body).digest("hex")
    } });
    expect(result.response?.durationMs).toBeGreaterThanOrEqual(0);
    expect(provider.fetchDocument).toHaveBeenCalledTimes(1);
  });

  it("fingerprints the first decoded 64 KiB while preserving a gzip document's full decoded length", async () => {
    const body = '<title>Decoded page</title><main>' + 'x'.repeat(MAX_RESPONSE_BYTES + 1000) + '<a href="/late-page">Late</a></main>';
    const compressed = gzipSync(body);
    const provider = dependencies(() => document("", { body: compressed, contentEncoding: "gzip", contentType: "text/html", contentLength: compressed.length }));
    const result = await discoverWebsitePaths("https://example.com/", "https://example.com/compressed-page", "links", 1000, provider.adapter);
    expect(result.status).toBe("success");
    expect(urls(result)).toEqual(["https://example.com/late-page"]);
    expect(result.response).toMatchObject({ url: "https://example.com/compressed-page", statusCode: 200, title: "Decoded page",
      contentLength: compressed.length, decodedBodyLength: Buffer.byteLength(body),
      fingerprint: createHash("sha256").update(Buffer.from(body).subarray(0, MAX_RESPONSE_BYTES)).digest("hex") });
    expect(result.document).toMatchObject({ bytes: Buffer.byteLength(body), truncated: false });
    expect(provider.fetchDocument).toHaveBeenCalledTimes(1);
  });
});
