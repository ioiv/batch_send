import { extractWebsiteScriptPaths } from "./website-path-script-parser.js";
import { extractPublishedClientRoutes } from "./website-path-client-manifests.js";
import { websitePathDocumentCache } from "./website-path-document-cache.js";
import { fetchPublicDocument, normalizeUrl, publicDocumentFailure, publicDocumentPathResult, type PathScanResult, type PublicDocumentResult } from "./network-scan.js";
import { createBrotliDecompress, createGunzip, createInflate, constants } from "node:zlib";
import { MAX_PATH_SCRIPT_DOCUMENTS, pathResourceKind } from "../src/lib/website-path-kind.js";

export type WebsitePathDiscoverySource = "links" | "scripts" | "robots" | "sitemap" | "wayback";
export type WebsitePathCandidateKind = "page" | "script" | "sitemap" | "asset" | "probe";
/** Fixed exposure probes are a client-side concern; only these kinds consume document limits. */
type CountedKind = "page" | "script" | "sitemap";
export interface WebsitePathCandidate {
  url: string;
  kind: WebsitePathCandidateKind;
  source: WebsitePathDiscoverySource;
  sources?: WebsitePathDiscoverySource[];
  documentUrl?: string;
  clientRoute?: boolean;
  evidence?: { kind: string; documentUrl: string; bytes?: number; truncated?: boolean; methods?: string[] };
}
export interface WebsitePathDiscoveryResult {
  source: WebsitePathDiscoverySource;
  url: string;
  status: "success" | "partial" | "error";
  candidates: WebsitePathCandidate[];
  ignoredUrls?: string[];
  canonicalUrl?: string;
  message?: string;
  retryable?: boolean;
  document?: { url: string; bytes: number; truncated: boolean; cacheHit?: boolean };
  /** The GET already performed to discover this document; no second probe is needed. */
  response?: PathScanResult;
}
export interface WebsitePathDiscoveryDependencies {
  fetchDocument(url: string, options: { timeoutMs: number; maxBytes: number; signal?: AbortSignal; headers?: Readonly<Record<string, string>> }): Promise<PublicDocumentResult>;
}
const defaults: WebsitePathDiscoveryDependencies = { fetchDocument: fetchPublicDocument };
export const MAX_PATH_DISCOVERY_CANDIDATES = 2000;
export const MAX_PATH_DISCOVERY_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_PAGES = 4;
const SOURCES: WebsitePathDiscoverySource[] = ["links", "scripts", "robots", "sitemap", "wayback"];
class SourceFailure extends Error {
  constructor(message: string, readonly retryable = false) { super(message); }
}

function decodeEntities(input: string): string {
  return input.replace(/&(?:#(x[0-9a-f]+|[0-9]+)|(amp|lt|gt|quot|apos|sol|colon|num|quest|equals));/gi, (entity, number: string | undefined, name: string | undefined) => {
    if (number) {
      const value = number[0].toLowerCase() === "x" ? Number.parseInt(number.slice(1), 16) : Number.parseInt(number, 10);
      return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : entity;
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", sol: "/", colon: ":", num: "#", quest: "?", equals: "=" } as Record<string, string>)[name!.toLowerCase()] ?? entity;
  });
}

/** Only literal, concrete URLs are useful evidence; dynamic route templates are not requests. */
function concreteValue(value: string): boolean {
  let decoded = value;
  try { decoded = decodeURIComponent(value); } catch { return false; }
  return value.length > 0 && value.length <= 2048 && !/[\u0000-\u0020\u007f\\]/.test(value)
    && !/[\u0000-\u001f\u007f\\{}<>]/.test(decoded) && !/\$\{|(^|\/):[a-z_]/i.test(decoded)
    && !decoded.includes("*") && decoded !== "/&" && !decoded.split("/").some(part => part === ":" || part === "$") && !/^[#?]/.test(value);
}

function pathKind(url: string): WebsitePathCandidateKind {
  return pathResourceKind(url) ?? "page";
}

class CandidateCollector {
  readonly candidates = new Map<string, WebsitePathCandidate>();
  readonly ignoredUrls = new Set<string>();
  ignoredUrlsCapped = false;
  readonly counts = { page: 0, script: 0, sitemap: 0 };
  readonly cappedKinds = new Set<CountedKind>();
  capped = false;
  constructor(readonly origin: string, readonly source: WebsitePathDiscoverySource, readonly evidenceDocument?: string) {}
  add(value: string, documentUrl: URL, kind?: WebsitePathCandidateKind, ownerDocument?: URL, observedSource = this.source, clientRoute = false, evidenceKind?: string, method?: string): void {
    // Queries and fragments are intentionally not scanned; their templates/tracking must not discard an observed concrete pathname.
    const raw = value.trim().split(/[?#]/, 1)[0];
    if (!concreteValue(raw)) return;
    let url: URL;
    try { url = new URL(raw, documentUrl); } catch { return; }
    if (url.origin !== this.origin || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) return;
    url.search = "";
    url.hash = "";
    try { normalizeUrl(url.href); } catch { return; }
    const candidate: WebsitePathCandidate = { url: url.href, kind: kind === "page" || kind === undefined ? pathKind(url.href) : kind, source: observedSource };
    candidate.evidence = { kind: evidenceKind ?? (candidate.kind === "script" ? "import" : observedSource), documentUrl: this.evidenceDocument ?? documentUrl.href, ...(method ? { methods: [method] } : {}) };
    if (clientRoute && candidate.kind === "page") candidate.clientRoute = true;
    if (candidate.kind === "script" && ownerDocument) {
      if (ownerDocument.origin !== this.origin || ownerDocument.username || ownerDocument.password || ownerDocument.port) candidate.kind = "asset";
      else {
        const owner = new URL(ownerDocument);
        owner.search = "";
        owner.hash = "";
        candidate.documentUrl = owner.href;
      }
    }
    if (candidate.kind === "asset") {
      if (!pathResourceKind(url.href)) {
        if (this.ignoredUrls.size < MAX_PATH_DISCOVERY_CANDIDATES) this.ignoredUrls.add(url.href);
        else if (!this.ignoredUrls.has(url.href)) this.ignoredUrlsCapped = true;
        const previous = this.candidates.get(url.href);
        if (previous) {
          this.counts[previous.kind as "page" | "script" | "sitemap"]--;
          this.candidates.delete(url.href);
        }
      }
      return;
    }
    if (this.ignoredUrls.has(url.href)) return;
    const existing = this.candidates.get(url.href);
    if (existing) {
      if (method && existing.evidence) existing.evidence.methods = [...new Set([...(existing.evidence.methods ?? []), method])].slice(0, 16);
      if (evidenceKind === "navigation" || evidenceKind === "route") {
        if (existing.evidence) existing.evidence.kind = evidenceKind;
      }
      if (candidate.clientRoute && existing.kind === "page") existing.clientRoute = true;
      const sources = new Set(existing.sources ?? [existing.source]);
      sources.add(candidate.source);
      if (sources.size > 1) existing.sources = [...sources];
      // Explicit script/sitemap clues should survive a less specific navigation link.
      if (candidate.kind === "sitemap" || (candidate.kind === "script" && existing.kind !== "sitemap")) {
        if (existing.kind !== candidate.kind) {
          const limit = candidate.kind === "script" ? MAX_PATH_SCRIPT_DOCUMENTS : 20;
          const candidateKind = candidate.kind as CountedKind;
          if (this.counts[candidateKind] >= limit) {
            this.cappedKinds.add(candidateKind);
            this.counts[existing.kind as CountedKind]--;
            this.candidates.delete(url.href);
            return;
          }
          this.counts[existing.kind as CountedKind]--;
          this.counts[candidateKind]++;
        }
        existing.kind = candidate.kind;
        delete existing.clientRoute;
        if (candidate.documentUrl) existing.documentUrl = candidate.documentUrl;
      }
      return;
    }
    const candidateKind = candidate.kind as CountedKind;
    const limit = candidateKind === "page" ? MAX_PATH_DISCOVERY_CANDIDATES : candidateKind === "script" ? MAX_PATH_SCRIPT_DOCUMENTS : 20;
    if (this.counts[candidateKind] >= limit) { this.cappedKinds.add(candidateKind); if (candidateKind === "page") this.capped = true; return; }
    this.candidates.set(url.href, candidate);
    this.counts[candidateKind]++;
  }
  archive(value: string, current: URL): void {
    let historical: URL;
    try { historical = new URL(value); } catch { return; }
    if (!["http:", "https:"].includes(historical.protocol) || historical.hostname !== current.hostname || historical.port || historical.username || historical.password) return;
    // An archived HTTP path remains useful after a site's move to HTTPS.
    this.add(`${current.origin}${historical.pathname}${historical.search}${historical.hash}`, current);
  }
}

interface Context {
  documentUrl: URL;
  ownerDocument: URL;
  source: WebsitePathDiscoverySource;
  collector: CandidateCollector;
  deadline: number;
  signal: AbortSignal;
  dependencies: WebsitePathDiscoveryDependencies;
  warnings: Set<string>;
  note?: string;
  canonicalUrl?: string;
  scanId?: string;
  document?: WebsitePathDiscoveryResult["document"];
  response?: PathScanResult;
}

async function readDocument(context: Context, url: URL): Promise<PublicDocumentResult> {
  const startedAt = Date.now();
  const remaining = context.deadline - Date.now();
  if (remaining <= 0 || context.signal.aborted) throw new SourceFailure("发现查询超时或已取消");
  const load = async (signal: AbortSignal) => {
    let response = await context.dependencies.fetchDocument(url.href, { timeoutMs: remaining, maxBytes: MAX_PATH_DISCOVERY_BYTES, signal,
      headers: { "Accept-Encoding": "gzip, deflate, br" } });
    if ((!response.contentEncoding || response.contentEncoding === "identity") && response.body[0] === 0x1f && response.body[1] === 0x8b) response = { ...response, contentEncoding: "gzip" };
    if (response.contentEncoding && response.contentEncoding.toLowerCase() !== "identity") response = await decodeDocument({ ...context, signal }, response);
    return response;
  };
  const loaded = context.scanId
    ? await websitePathDocumentCache.read(`${context.scanId}:${url.href}`, load, context.signal)
    : { document: await load(context.signal), cacheHit: false };
  const response = loaded.document;
  if (context.source !== "wayback") {
    context.document = { url: url.href, bytes: response.body.length, truncated: response.truncated, cacheHit: loaded.cacheHit };
    context.response = publicDocumentPathResult({ ...response, url: url.href }, { decodedBody: true, durationMs: Date.now() - startedAt });
  }
  if (response.truncated) context.warnings.add("文档达到读取上限，已保留完整线索");
  return response;
}

async function decodeDocument(context: Context, response: PublicDocumentResult): Promise<PublicDocumentResult> {
  const encoding = response.contentEncoding!.toLowerCase().trim();
  const decoder = encoding === "gzip" || encoding === "x-gzip" ? createGunzip({ finishFlush: constants.Z_SYNC_FLUSH })
    : encoding === "deflate" ? createInflate({ finishFlush: constants.Z_SYNC_FLUSH }) : encoding === "br" ? createBrotliDecompress() : undefined;
  if (!decoder) throw new SourceFailure("文档使用暂不支持的压缩格式");
  return new Promise((resolve, reject) => {
    let settled = false;
    let size = 0;
    const chunks: Buffer[] = [];
    const finish = (truncated: boolean) => {
      if (settled) return;
      settled = true;
      context.signal.removeEventListener("abort", onAbort);
      decoder.destroy();
      resolve({ ...response, body: Buffer.concat(chunks, size), truncated: response.truncated || truncated, contentEncoding: "identity" });
    };
    const fail = () => {
      if (settled) return;
      if (response.truncated && size) { finish(true); return; }
      settled = true;
      context.signal.removeEventListener("abort", onAbort);
      decoder.destroy();
      reject(new SourceFailure(context.signal.aborted ? "发现查询超时或已取消" : "压缩文档无法读取"));
    };
    const onAbort = () => fail();
    decoder.on("data", (chunk: Buffer) => {
      if (settled) return;
      const remaining = MAX_PATH_DISCOVERY_BYTES - size;
      if (remaining > 0) { const sampled = chunk.subarray(0, remaining); chunks.push(sampled); size += sampled.length; }
      if (chunk.length >= remaining) finish(true);
    });
    decoder.once("error", fail);
    decoder.once("end", () => finish(false));
    if (context.signal.aborted) { fail(); return; }
    context.signal.addEventListener("abort", onAbort, { once: true });
    decoder.end(response.body);
  });
}

function attributes(tag: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const match of tag.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
    const name = match[1].toLowerCase();
    if (!values.has(name)) values.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""));
  }
  return values;
}

const CLASSIC_SCRIPT_TYPES = new Set([
  "application/ecmascript", "application/javascript", "application/x-ecmascript", "application/x-javascript",
  "text/ecmascript", "text/javascript", "text/javascript1.0", "text/javascript1.1", "text/javascript1.2",
  "text/javascript1.3", "text/javascript1.4", "text/javascript1.5", "text/jscript", "text/livescript",
  "text/x-ecmascript", "text/x-javascript"
]);
function scriptType(attrs: Map<string, string>): "javascript" | "importmap" | "data" {
  const type = (attrs.get("type") ?? (attrs.get("language") ? `text/${attrs.get("language")}` : "")).trim().toLowerCase();
  if (type === "importmap") return "importmap";
  return !type || type === "module" || CLASSIC_SCRIPT_TYPES.has(type) ? "javascript" : "data";
}

function extractJavascript(context: Context, text: string, scriptBase: URL, ownerBase: URL): void {
  const result = extractWebsiteScriptPaths(text, { deadline: context.deadline, signal: context.signal, truncated: context.document?.truncated });
  result.warnings.forEach(warning => context.warnings.add(warning));
  for (const candidate of result.candidates) {
    const module = candidate.kind === "import";
    const resolutionBase = module && !candidate.documentRelative ? scriptBase : ownerBase;
    let requestOwner = ownerBase;
    if (candidate.workerContext) {
      try { requestOwner = new URL(candidate.url, resolutionBase); } catch { continue; }
    }
    context.collector.add(candidate.url, resolutionBase, module ? "script" : "page", requestOwner,
      "scripts", Boolean(candidate.clientRoute), candidate.kind, candidate.method);
  }
  if (!context.document?.truncated) {
    const manifest = extractPublishedClientRoutes(text, { deadline: context.deadline, signal: context.signal });
    manifest.warnings.forEach(warning => context.warnings.add(warning));
    for (const url of manifest.urls) context.collector.add(url, ownerBase, "page", ownerBase, "scripts", true, "route");
  }
}

function extractHtml(context: Context, input: string): void {
  const scripts: string[] = [];
  const htmlUrl = (raw: string, reference: URL): string | undefined => {
    // Browsers encode ordinary spaces in HTML URLs; controls and dynamic paths
    // still pass through the collector's strict checks after normalization.
    if (/[\u0000-\u001f\u007f\\]/.test(raw)) return;
    const value = raw.trim();
    if (!value || /^[#?]/.test(value)) return;
    try {
      const url = new URL(value, reference);
      if (url.protocol === "http:" || url.protocol === "https:") return url.href;
    } catch { /* Ignore malformed HTML URL attributes. */ }
  };
  // Read comments and raw-text elements together: <!-- inside a script is JavaScript
  // text, while markup inside script/style/textarea/title is not a navigable link.
  const markup = input.replace(/<!--[\s\S]*?(?:-->|$)|(<(script|style|textarea|title)\b(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(?:<\/\2\s*>|$)|<[a-z][\w:-]*\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi,
    (whole: string, opening: string | undefined, name: string | undefined, body: string | undefined) => {
      if (!opening) return whole.startsWith("<!--") ? "" : whole;
      if (name!.toLowerCase() === "script") {
        const attrs = attributes(opening);
        const type = scriptType(attrs);
        if (type === "javascript" && !attrs.has("src")) scripts.push(body!);
        else if (type === "importmap" && body?.trim()) context.warnings.add("网页包含尚未解析的 importmap 模块映射，模块覆盖可能不完整");
      }
      return opening;
    });
  const tags = [...markup.matchAll(/<([a-z][\w:-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)];
  let base = context.documentUrl;
  const baseTag = tags.find((tag) => tag[1].toLowerCase() === "base" && attributes(tag[0]).has("href"));
  if (baseTag) {
    const href = attributes(baseTag[0]).get("href")!;
    try {
      const value = htmlUrl(href, context.documentUrl);
      if (value && concreteValue(value.split(/[?#]/, 1)[0])) { base = new URL(value); base.search = ""; base.hash = ""; }
    } catch { /* Browser ignores a malformed base URL. */ }
  }
  for (const tag of tags) {
    const name = tag[1].toLowerCase();
    const attrs = attributes(tag[0]);
    if (name === "base" || name === "form") continue;
    if (name === "script" && scriptType(attrs) !== "javascript") continue;
    if (["a", "area", "link"].includes(name) && attrs.has("href")) {
      const rel = (attrs.get("rel") ?? "").toLowerCase().split(/\s+/);
      context.collector.add(htmlUrl(attrs.get("href")!, base) ?? "", base, rel.includes("sitemap") ? "sitemap" : rel.includes("modulepreload") || rel.includes("preload") && attrs.get("as")?.toLowerCase() === "script" ? "script" : rel.includes("stylesheet") || rel.includes("icon") ? "asset" : undefined, base);
    }
    if (attrs.has("src") && ["script", "img", "iframe", "source", "audio", "video", "embed", "input"].includes(name)) {
      context.collector.add(htmlUrl(attrs.get("src")!, base) ?? "", base, name === "script" ? base.origin === context.collector.origin ? "script" : "asset" : name === "iframe" ? "page" : "asset", base);
    }
    if (["img", "source"].includes(name) && attrs.has("srcset")) {
      for (const entry of attrs.get("srcset")!.split(",")) context.collector.add(htmlUrl(entry.trim().split(/\s+/)[0] ?? "", base) ?? "", base, "asset");
    }
  }
  if (base.origin !== context.collector.origin || base.username || base.password || base.port) context.warnings.add("网页 base 指向站外或无效地址，部分相对脚本线索无法解析");
  for (const script of scripts) extractJavascript(context, script, base, base);
}

function completeLines(text: string, truncated: boolean): string[] {
  const lines = text.split(/\r?\n/);
  if (truncated && !/\r?\n$/.test(text)) lines.pop();
  return lines;
}

function extractRobots(context: Context, text: string, truncated: boolean): void {
  for (const line of completeLines(text, truncated)) {
    const directive = /^\s*(sitemap|allow|disallow)\s*:\s*(.*?)\s*(?:#.*)?$/i.exec(line);
    if (!directive || !directive[2]) continue;
    const value = directive[2].trim();
    if (directive[1].toLowerCase() === "sitemap") context.collector.add(value, context.documentUrl, "sitemap");
    else if (value.startsWith("/") && !value.includes("$") && !value.includes("*")) context.collector.add(value, context.documentUrl);
  }
}

function extractSitemap(context: Context, text: string, truncated: boolean): void {
  if (/^\s*(?:<\?xml[^>]*>\s*)?</.test(text)) {
    if (/<!DOCTYPE\b|<!ENTITY\b/i.test(text)) throw new SourceFailure("网站地图不支持 DTD 或外部实体");
    interface Element { name: string; local: string; namespace: string | undefined; namespaces: Map<string, string>; location: boolean; value: string; nested: boolean }
    const stack: Element[] = [];
    let root: Element | undefined;
    let offset = 0;
    let count = 0;
    const tokens = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[a-zA-Z_][\w.:-]*\b(?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+/g;
    for (const token of text.matchAll(tokens)) {
      if (++count > 50000 || stack.length > 64 || count % 256 === 0 && (Date.now() >= context.deadline || context.signal.aborted)) {
        context.warnings.add("达到站点地图解析上限，已保留完整路径");
        return;
      }
      if (token.index !== offset) {
        context.warnings.add("站点地图 XML 结构不完整，已保留完整路径");
        return;
      }
      offset = token.index + token[0].length;
      const raw = token[0];
      const current = stack.at(-1);
      if (raw.startsWith("<!--") || raw.startsWith("<?")) continue;
      if (raw.startsWith("<![CDATA[")) {
        if (current?.location && !current.nested) current.value += raw.slice(9, -3);
        continue;
      }
      if (!raw.startsWith("<")) {
        if (current?.location && !current.nested) current.value += decodeEntities(raw);
        else if (!current && raw.trim()) throw new SourceFailure("网站地图格式无效");
        continue;
      }
      const name = /^<\/?([a-zA-Z_][\w.:-]*)/.exec(raw)![1];
      if (raw.startsWith("</")) {
        if (!current || current.name !== name) {
          context.warnings.add("站点地图 XML 结构不完整，已保留完整路径");
          return;
        }
        if (current.location && !current.nested) context.collector.add(current.value.trim(), context.documentUrl, root?.local === "sitemapindex" ? "sitemap" : undefined);
        stack.pop();
        continue;
      }
      const namespaces = new Map(current?.namespaces);
      for (const attribute of raw.matchAll(/\bxmlns(?::([a-zA-Z_][\w.-]*))?\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        namespaces.set(attribute[1] ?? "", decodeEntities(attribute[2] ?? attribute[3]));
      }
      const parts = name.split(":");
      const local = parts.at(-1)!;
      const namespace = namespaces.get(parts.length > 1 ? parts[0] : "") ?? (parts.length > 1 ? undefined : "");
      const element: Element = { name, local, namespace, namespaces, location: false, value: "", nested: false };
      if (!current) {
        if (root || !["sitemapindex", "urlset"].includes(local) || namespace !== "" && !/^https?:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9$/.test(namespace ?? "")) throw new SourceFailure("网站地图格式无效");
        root = element;
      } else {
        if (current.location) current.nested = true;
        element.location = local === "loc" && namespace === root?.namespace && current.namespace === root?.namespace
          && current.local === (root?.local === "sitemapindex" ? "sitemap" : "url") && stack.length === 2;
      }
      if (!/\/\s*>$/.test(raw)) stack.push(element);
    }
    if (!root) throw new SourceFailure("网站地图格式无效");
    if (offset !== text.length || stack.length && !truncated) context.warnings.add("站点地图 XML 结构不完整，已保留完整路径");
  } else {
    const lines = completeLines(text, truncated).map((line) => line.trim()).filter(Boolean);
    if (lines.some((line) => !/^https?:\/\//i.test(line))) throw new SourceFailure("网站地图格式无效");
    for (const line of lines) context.collector.add(line, context.documentUrl);
  }
}

async function discoverDocument(context: Context): Promise<void> {
  const response = await readDocument(context, context.documentUrl);
  if (response.statusCode >= 300 && response.statusCode < 400) {
    if (response.location && context.source === "links" && context.documentUrl.protocol === "http:") {
      try {
        const destination = new URL(response.location, context.documentUrl);
        destination.search = "";
        destination.hash = "";
        if (destination.protocol === "https:" && destination.hostname === context.documentUrl.hostname
          && !destination.username && !destination.password && !destination.port && concreteValue(destination.pathname)) {
          context.canonicalUrl = normalizeUrl(destination.href).href;
          context.note = "网站入口已跳转到同主机 HTTPS 地址";
          return;
        }
      } catch { /* Only a concrete, observed same-host HTTPS upgrade can change the scan scope. */ }
    }
    if (response.location) context.collector.add(response.location, context.documentUrl, context.source === "scripts" ? "script" : context.source === "sitemap" ? "sitemap" : "page");
    if (!context.collector.candidates.size) throw new SourceFailure("文档重定向至站外或无可用地址");
    context.warnings.add("文档返回重定向，已保留同源跳转地址");
    return;
  }
  if ((response.statusCode === 404 || response.statusCode === 410) && ["robots", "sitemap"].includes(context.source)) { context.note = "网站未提供此文档"; return; }
  if (response.statusCode < 200 || response.statusCode >= 300) throw new SourceFailure(response.statusCode === 429 ? "网站暂时限流，请稍后重试" : `文档返回 HTTP ${response.statusCode}`, [408, 502, 503, 504].includes(response.statusCode));
  const text = response.body.toString("utf8");
  if (context.source === "links") {
    if (response.contentType && !/\b(?:html|xhtml)\b/i.test(response.contentType)) { context.note = "此响应不是网页文档"; return; }
    extractHtml(context, text);
  } else if (context.source === "scripts") {
    if (response.contentType && !/\b(?:javascript|ecmascript|x-javascript|plain|octet-stream)\b/i.test(response.contentType)) throw new SourceFailure("此响应不是脚本文档");
    extractJavascript(context, text, context.documentUrl, context.ownerDocument);
  }
  else if (context.source === "robots") extractRobots(context, text, response.truncated);
  else extractSitemap(context, text, response.truncated);
}

async function discoverArchive(context: Context): Promise<void> {
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  for (let page = 0; page < MAX_ARCHIVE_PAGES; page += 1) {
    const url = new URL("https://web.archive.org/cdx/search/cdx");
    url.searchParams.set("url", context.documentUrl.hostname);
    url.searchParams.set("matchType", "host");
    url.searchParams.set("output", "json");
    url.searchParams.set("fl", "original");
    url.searchParams.set("collapse", "urlkey");
    url.searchParams.set("limit", "1000");
    url.searchParams.set("showResumeKey", "true");
    url.searchParams.set("gzip", "false");
    if (cursor) url.searchParams.set("resumeKey", cursor);
    const response = await readDocument(context, url);
    if (response.statusCode < 200 || response.statusCode >= 300) throw new SourceFailure(response.statusCode === 429 ? "Wayback 暂时限流，请稍后重试" : `Wayback 返回 HTTP ${response.statusCode}`);
    const text = response.body.toString("utf8");
    if (response.truncated) {
      for (const match of text.matchAll(/\[\s*("(?:\\.|[^"\\])*")\s*\]/g)) {
        try { context.collector.archive(JSON.parse(match[1]) as string, context.documentUrl); } catch { /* Only complete JSON string fields are evidence. */ }
      }
      return;
    }
    let rows: unknown;
    try { rows = JSON.parse(text); } catch { throw new SourceFailure("Wayback 返回的数据格式无效"); }
    if (!Array.isArray(rows) || rows.some((row) => !Array.isArray(row)) || (rows.length && (rows[0].length !== 1 || rows[0][0] !== "original"))) throw new SourceFailure("Wayback 返回的数据格式无效");
    let next: string | undefined;
    for (let index = 1; index < rows.length; index += 1) {
      const row: unknown[] = rows[index];
      if (!row.length && index === rows.length - 2 && rows[index + 1].length === 1 && typeof rows[index + 1][0] === "string") { next = rows[index + 1][0]; break; }
      if (row.length !== 1 || typeof row[0] !== "string") throw new SourceFailure("Wayback 返回的数据格式无效");
      context.collector.archive(row[0], context.documentUrl);
    }
    if (context.collector.capped) return;
    if (next === undefined) return;
    if (!next || next.length > 1024 || seenCursors.has(next)) { context.warnings.add("Wayback 无法继续分页，已保留当前结果"); return; }
    cursor = next;
    seenCursors.add(next);
  }
  context.warnings.add("Wayback 达到分页上限，结果可能不完整");
}

/** Discover paths from actual documents and archived URLs; never execute scripts or invent route names. */
export async function discoverWebsitePaths(baseInput: string, documentInput: string, source: WebsitePathDiscoverySource, timeoutMs = source === "scripts" ? 45000 : 20000, dependencies = defaults, signal?: AbortSignal, ownerDocumentInput?: string, scanId?: string): Promise<WebsitePathDiscoveryResult> {
  const base = normalizeUrl(baseInput);
  const documentUrl = normalizeUrl(documentInput);
  base.search = "";
  documentUrl.search = "";
  const ownerDocument = ownerDocumentInput ? normalizeUrl(ownerDocumentInput) : base;
  ownerDocument.search = "";
  if (documentUrl.origin !== base.origin) throw new Error("发现文档必须与扫描网站同源");
  if (ownerDocument.origin !== base.origin) throw new Error("脚本所属网页必须与扫描网站同源");
  if (!SOURCES.includes(source)) throw new Error("不支持的发现来源");
  const maximumTimeoutMs = source === "scripts" ? 45000 : 20000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > maximumTimeoutMs) throw new Error(`发现来源超时必须在 1000–${maximumTimeoutMs} 毫秒之间`);
  if (scanId !== undefined && !/^[a-zA-Z0-9-]{1,64}$/.test(scanId)) throw new Error("扫描轮次标识无效");
  const collector = new CandidateCollector(base.origin, source, documentUrl.href);
  const controller = new AbortController();
  const context: Context = { documentUrl, ownerDocument, source, collector, deadline: Date.now() + timeoutMs, signal: controller.signal, dependencies, warnings: new Set(), ...(scanId ? { scanId } : {}) };
  let onAbort: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = (status: WebsitePathDiscoveryResult["status"], message?: string, retryable = false): WebsitePathDiscoveryResult => ({ source, url: documentUrl.href, status, candidates: [...collector.candidates.values()].map(candidate => candidate.evidence && context.document?.url === candidate.evidence.documentUrl ? { ...candidate, evidence: { ...candidate.evidence, bytes: context.document.bytes, truncated: context.document.truncated } } : candidate), ...(collector.ignoredUrls.size ? { ignoredUrls: [...collector.ignoredUrls] } : {}), ...(context.canonicalUrl ? { canonicalUrl: context.canonicalUrl } : {}), ...(context.document ? { document: context.document } : {}), ...(context.response ? { response: context.response } : {}), ...(message ? { message } : {}), ...(retryable ? { retryable: true } : {}) });
  if (signal?.aborted) return result("error", "发现查询已取消");
  const interruption = new Promise<never>((_, reject) => {
    onAbort = () => { controller.abort(); reject(new SourceFailure("发现查询已取消")); };
    timer = setTimeout(() => { controller.abort(); reject(new SourceFailure("发现查询超时", true)); }, timeoutMs);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([source === "wayback" ? discoverArchive(context) : discoverDocument(context), interruption]);
    if (collector.capped) context.warnings.add("达到每份文档 2000 个路径上限，结果可能不完整");
    if (collector.cappedKinds.has("script")) context.warnings.add(`达到每份文档 ${MAX_PATH_SCRIPT_DOCUMENTS} 份脚本线索上限，已保留实际路径`);
    if (collector.cappedKinds.has("sitemap")) context.warnings.add("达到每份文档 20 份地图线索上限，已保留实际路径");
    if (collector.ignoredUrlsCapped) context.warnings.add("部分无扩展名资源超过 2000 项标记上限，筛选可能不完整");
    return result(context.warnings.size ? "partial" : "success", context.warnings.size ? [...context.warnings].join("；") : context.note);
  } catch (error) {
    const failure = error instanceof SourceFailure ? error : publicDocumentFailure(error);
    return result(collector.candidates.size ? "partial" : "error", signal?.aborted ? "发现查询已取消" : failure.message, !signal?.aborted && failure.retryable);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    controller.abort();
  }
}
