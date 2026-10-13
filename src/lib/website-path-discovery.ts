import { createWebsitePathValidator, formatScanCsv, normalizeWebsiteUrl, requestNetworkScan, type WebsitePathScanResult } from "./network-scan";
import { createStreamingScanQueue } from "./streaming-scan-queue";
import { confirmedExposure, exposurePathFor, exposureProbeUrls, type ExposurePath, type ExposureVerdict } from "./exposure-path";
import { MAX_PATH_SOURCE_CANDIDATES, pathResourceKind } from "./website-path-kind";

export type PathDiscoverySource = "links" | "scripts" | "robots" | "sitemap" | "wayback";
export const PATH_DISCOVERY_SOURCES: { id: PathDiscoverySource; label: string }[] = [
  { id: "links", label: "页面链接" }, { id: "scripts", label: "脚本线索" },
  { id: "robots", label: "爬虫声明" }, { id: "sitemap", label: "站点地图" }, { id: "wayback", label: "历史记录" }
];
export const MAX_DISCOVERED_WEBSITE_PATHS = 2000;
export const PATH_DISCOVERY_DURATION_MS = 90_000;
const MAX_DEPTH = 3;
const CRAWL_LIMITS = { links: 100, scripts: 40, robots: 1, sitemap: 20 };
type CrawlSource = Exclude<PathDiscoverySource, "wayback">;
type CandidateKind = "page" | "script" | "sitemap" | "asset";
interface PathCandidate { url: string; kind: CandidateKind; source: PathDiscoverySource; sources?: PathDiscoverySource[]; documentUrl?: string; clientRoute?: boolean }
interface DiscoveryDocument {
  source: PathDiscoverySource; url: string; status: "success" | "partial" | "error";
  candidates: PathCandidate[]; message?: string;
  ignoredUrls?: string[];
  canonicalUrl?: string;
}
export interface PathDiscoverySourceResult {
  source: PathDiscoverySource; status: "success" | "partial" | "error"; urls: string[]; message?: string;
}
export interface DiscoveredWebsitePathResult extends WebsitePathScanResult {
  sources: PathDiscoverySource[];
  clientRoute?: boolean;
  /** Set only for the fixed, non-destructive exposure probes that returned a real 2xx. */
  exposure?: { path: ExposurePath; verdict: ExposureVerdict };
  /** Wall-clock duration of the response validation for this path. */
  durationMs?: number;
}
export interface WebsitePathDiscoveryProgress {
  phase: "discovering" | "validating"; completed: number; total: number; discovered: number;
  discoveryCompleted?: number; discoveryTotal?: number;
}
export interface WebsitePathDiscoverySummary {
  discovered: number; validated: number; truncated: boolean; sources: PathDiscoverySourceResult[];
  baseUrl?: string;
}
interface DiscoveryOptions {
  baseUrl: string; concurrency: number; timeoutMs: number; signal: AbortSignal;
  onSource: (result: PathDiscoverySourceResult) => void;
  onResult: (result: DiscoveredWebsitePathResult) => void;
  onRemoveResult?: (url: string) => void;
  onProgress?: (progress: WebsitePathDiscoveryProgress) => void;
  onExposureProgress?: (completed: number, total: number) => void;
  onTarget?: (baseUrl: string) => void;
}
interface CrawlJob { source: CrawlSource; url: string; depth: number; documentUrl?: string }
interface SourceState { completed: number; succeeded: number; partial: boolean; messages: Set<string> }

function validCandidateUrl(value: unknown, origin: string): value is string {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.origin === origin && url.href === value && !url.username && !url.password && !url.search && !url.hash
      && !/[{}*]/.test(decodeURIComponent(url.pathname)) && !/(?:^|\/):[^/]+/.test(decodeURIComponent(url.pathname));
  } catch { return false; }
}

async function readDocument(baseUrl: string, job: { url: string; source: PathDiscoverySource; documentUrl?: string }, timeoutMs: number, signal: AbortSignal): Promise<DiscoveryDocument> {
  try {
    const result = await requestNetworkScan<DiscoveryDocument>({ kind: "path-discovery", baseUrl, url: job.url, source: job.source,
      ...(job.documentUrl ? { documentUrl: job.documentUrl } : {}), timeoutMs }, signal);
    const sourceIds = PATH_DISCOVERY_SOURCES.map(source => source.id);
    if (result.source !== job.source || result.url !== job.url || !["success", "partial", "error"].includes(result.status)
      || !Array.isArray(result.candidates) || result.candidates.length > MAX_PATH_SOURCE_CANDIDATES
      || (result.ignoredUrls !== undefined && (!Array.isArray(result.ignoredUrls) || result.ignoredUrls.length > MAX_DISCOVERED_WEBSITE_PATHS
        || result.ignoredUrls.some(url => !validCandidateUrl(url, new URL(baseUrl).origin))))
      || (result.message !== undefined && typeof result.message !== "string")
      || (result.canonicalUrl !== undefined && !validCanonicalUrl(result.canonicalUrl, job))
      || result.candidates.some(candidate => !candidate || !validCandidateUrl(candidate.url, new URL(baseUrl).origin)
        || !["page", "script", "sitemap", "asset", "probe"].includes(candidate.kind) || !sourceIds.includes(candidate.source)
        || (candidate.sources !== undefined && (!Array.isArray(candidate.sources) || candidate.sources.length > sourceIds.length
          || candidate.sources.some(source => !sourceIds.includes(source))))
        || (candidate.documentUrl !== undefined && !validCandidateUrl(candidate.documentUrl, new URL(baseUrl).origin)))
      || result.candidates.some(candidate => candidate.clientRoute !== undefined && (typeof candidate.clientRoute !== "boolean" || candidate.kind !== "page" || candidate.source !== "scripts" && !candidate.sources?.includes("scripts")))
      || (result.status === "error" && (result.candidates.length || result.canonicalUrl !== undefined))) throw new Error("发现来源返回了无效或范围外的路径。");
    return result;
  } catch (error) {
    signal.throwIfAborted();
    return { ...job, status: "error", candidates: [], message: error instanceof Error ? error.message : "来源读取失败" };
  }
}

function validCanonicalUrl(value: unknown, job: { url: string; source: PathDiscoverySource }): value is string {
  if (typeof value !== "string" || job.source !== "links") return false;
  try {
    const before = new URL(job.url);
    const after = new URL(value);
    return before.protocol === "http:" && after.protocol === "https:" && after.hostname === before.hostname
      && !after.port && validCandidateUrl(value, after.origin);
  } catch { return false; }
}

/** Traverse only published references; historical paths are checked without recursively crawling them. */
export async function discoverWebsitePaths(options: DiscoveryOptions): Promise<WebsitePathDiscoverySummary> {
  let baseUrl = normalizeWebsiteUrl(options.baseUrl);
  let origin = new URL(baseUrl).origin;
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 8) throw new Error("并发数必须是 1–8 的整数。");
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 10_000) throw new Error("单项超时必须在 1–10 秒之间。");
  options.signal.throwIfAborted();
  const candidates = new Map<string, Set<PathDiscoverySource>>();
  const admittedSiteUrls = new Set<string>();
  const resourceUrls = new Set<string>();
  const clientRoutes = new Set<string>();
  const states = Object.fromEntries(PATH_DISCOVERY_SOURCES.map(({ id }) => [id,
    { completed: 0, succeeded: 0, partial: false, messages: new Set<string>() }])) as Record<PathDiscoverySource, SourceState>;
  const queue: CrawlJob[] = [];
  const queued = new Set<string>();
  const counts: Record<CrawlSource, number> = { links: 0, scripts: 0, robots: 0, sitemap: 0 };
  let truncated = false;
  let crawlCompleted = 0;
  let archiveCompleted = false;
  let timedOut = false;
  let discoveryFinished = false;
  let validationStarted = false;
  const validatedResults = new Map<string, WebsitePathScanResult>();
  let validator: ReturnType<typeof createWebsitePathValidator> | undefined;
  let validationFailed = false;
  let validationFailure: unknown;
  const startedAt = Date.now();
  let entryDocument: DiscoveryDocument | undefined;
  if (new URL(baseUrl).protocol === "http:" && !pathResourceKind(baseUrl)) {
    entryDocument = await readDocument(baseUrl, { source: "links", url: baseUrl }, options.timeoutMs, options.signal);
    if (entryDocument.canonicalUrl) {
      baseUrl = entryDocument.canonicalUrl;
      origin = new URL(baseUrl).origin;
      states.links.messages.add("根据网站入口的实际跳转，已改用同主机 HTTPS 地址");
      entryDocument = undefined;
    }
  }
  options.signal.throwIfAborted();
  options.onTarget?.(baseUrl);
  const controller = new AbortController();
  const stop = () => controller.abort(options.signal.reason);
  options.signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(1, PATH_DISCOVERY_DURATION_MS - (Date.now() - startedAt)));
  const failValidation = (error: unknown) => {
    if (!validationFailed) { validationFailed = true; validationFailure = error; }
    controller.abort(error);
  };
  // Four document workers plus Wayback leave three API slots during discovery.
  const validationQueue = createStreamingScanQueue<WebsitePathScanResult>({
    concurrency: Math.min(options.concurrency, 3), signal: options.signal,
    scan: async (url, signal) => {
      try {
        if (resourceUrls.has(url) && !exposureUrls.has(url)) return;
        validator ??= createWebsitePathValidator({ baseUrl, timeoutMs: options.timeoutMs, signal });
        const validate = await validator;
        signal.throwIfAborted();
        if (resourceUrls.has(url) && !exposureUrls.has(url)) return;
        return await validate(url, signal);
      } catch (error) { failValidation(error); throw error; }
    },
    onResult: result => {
      try {
        validatedResults.set(result.url, result);
        if (resourceUrls.has(result.url) && !exposureUrls.has(result.url)) { progress(); return; }
        emitResult(result.url);
        if (exposureUrls.has(result.url)) {
          exposureCompleted += 1;
          options.onExposureProgress?.(exposureCompleted, exposureUrls.size);
        }
        progress();
      } catch (error) { failValidation(error); throw error; }
    },
    onSkipped: url => { if (exposureUrls.has(url)) validationQueue.add(url); }
  });

  function sourceResult(source: PathDiscoverySource): PathDiscoverySourceResult {
    const state = states[source];
    const urls = [...candidates].filter(([, sources]) => sources.has(source)).map(([url]) => url).sort();
    const status = state.partial || (state.succeeded > 0 && state.succeeded < state.completed) ? "partial"
      : state.completed > 0 && state.succeeded === 0 ? "error" : "success";
    return { source, status, urls, ...(state.messages.size ? { message: [...state.messages].join("；").slice(0, 600) } : {}) };
  }
  function progress() {
    if (!options.signal.aborted) options.onProgress?.({ phase: discoveryFinished ? "validating" : "discovering",
      completed: [...candidates.keys()].filter(url => validatedResults.has(url)).length,
      total: candidates.size, discovered: candidates.size,
      discoveryCompleted: crawlCompleted + Number(archiveCompleted), discoveryTotal: queue.length + 1 });
  }

  /**
   * Fixed, non-destructive exposure probes. They reuse the same public transport,
   * soft-404 baseline and client deadline as every other path, but they are tracked
   * apart from the site's own path counts and only the paths listed in
   * `exposure-path.ts` are ever requested.
   */
  const exposureUrls = new Set<string>();
  let exposureCompleted = 0;
  function emitResult(url: string) {
    const raw = validatedResults.get(url);
    if (!raw || resourceUrls.has(url) && !exposureUrls.has(url) || options.signal.aborted) return;
    const result: DiscoveredWebsitePathResult = { ...raw,
      ...(clientRoutes.has(url) ? { clientRoute: true } : {}),
      sources: PATH_DISCOVERY_SOURCES.filter(source => candidates.get(url)?.has(source.id)).map(source => source.id) };
    const confirmed = exposureUrls.has(url) ? confirmedExposure(result, result.missingPathBaseline) : undefined;
    options.onResult({ ...result,
      ...(confirmed ? { exposure: confirmed } : {}) });
  }
  function startValidation() {
    if (validationStarted) return;
    validationStarted = true;
    candidates.forEach((_sources, url) => validationQueue.add(url, 1));
  }
  function addExposureProbes() {
    if (exposureUrls.size) return;
    exposureProbeUrls(baseUrl).forEach(url => exposureUrls.add(url));
    exposureCompleted = [...exposureUrls].filter(url => validatedResults.has(url)).length;
    options.onExposureProgress?.(exposureCompleted, exposureUrls.size);
    exposureUrls.forEach(url => {
      if (validatedResults.has(url)) emitResult(url);
      else validationQueue.add(url);
    });
  }
  function ignoreResource(url: string, touched?: Set<PathDiscoverySource>) {
    candidates.get(url)?.forEach(source => touched?.add(source));
    resourceUrls.add(url);
    candidates.delete(url);
    clientRoutes.delete(url);
    if (validatedResults.has(url)) {
      if (exposureUrls.has(url)) emitResult(url);
      else options.onRemoveResult?.(url);
    }
  }
  function collect(candidate: PathCandidate, touched?: Set<PathDiscoverySource>) {
    if (candidate.kind !== "page" || pathResourceKind(candidate.url)) {
      ignoreResource(candidate.url, touched);
      return true;
    }
    if (resourceUrls.has(candidate.url)) return false;
    const provenance = new Set([candidate.source, ...candidate.sources ?? []]);
    const existing = candidates.get(candidate.url);
    if (existing) {
      const changed = [...provenance].some(source => !existing.has(source)) || candidate.clientRoute && !clientRoutes.has(candidate.url);
      provenance.forEach(source => existing.add(source));
      if (candidate.clientRoute) clientRoutes.add(candidate.url);
      if (changed) emitResult(candidate.url);
      return true;
    }
    if (!admittedSiteUrls.has(candidate.url) && admittedSiteUrls.size === MAX_DISCOVERED_WEBSITE_PATHS) {
      truncated = true;
      provenance.forEach(source => {
        states[source].partial = true;
        states[source].messages.add("发现路径超过 2,000 项，本轮仅验证保留的路径");
      });
      return false;
    }
    admittedSiteUrls.add(candidate.url);
    candidates.set(candidate.url, provenance);
    if (candidate.clientRoute) clientRoutes.add(candidate.url);
    if (validatedResults.has(candidate.url)) emitResult(candidate.url);
    else if (validationStarted) validationQueue.add(candidate.url, 1);
    return true;
  }
  function enqueue(job: CrawlJob) {
    const key = `${job.source}:${job.url}:${job.documentUrl ?? ""}`;
    if (queued.has(key)) return;
    if (job.depth > MAX_DEPTH || counts[job.source] === CRAWL_LIMITS[job.source]) {
      states[job.source].partial = true;
      states[job.source].messages.add(job.depth > MAX_DEPTH ? "达到 3 层爬取深度，保留已发现路径" : "达到本轮文档读取上限，保留已发现路径");
      return;
    }
    queued.add(key);
    counts[job.source]++;
    queue.push(job);
  }
  function accept(result: DiscoveryDocument, depth: number, crawl: boolean, documentUrl?: string) {
    options.signal.throwIfAborted();
    const state = states[result.source];
    state.completed++;
    if (result.status !== "error") state.succeeded++;
    if (result.status === "partial") state.partial = true;
    if (result.message) state.messages.add(result.message);
    const touched = new Set<PathDiscoverySource>([result.source]);
    for (const url of result.ignoredUrls ?? []) ignoreResource(url, touched);
    for (const candidate of result.candidates) {
      touched.add(candidate.source);
      candidate.sources?.forEach(source => touched.add(source));
      const kind = candidate.kind === "page" ? pathResourceKind(candidate.url) ?? "page" : candidate.kind;
      if (!collect(candidate, touched) || !crawl || kind === "asset") continue;
      const source = kind === "script" ? "scripts" : kind === "sitemap" ? "sitemap" : "links";
      // Nested sitemap indexes have their own document cap; they do not consume page depth.
      enqueue({ url: candidate.url, source, depth: source === "sitemap" ? 0 : source === "scripts" ? depth : depth + 1,
        ...(source === "scripts" ? { documentUrl: candidate.documentUrl ?? (result.source === "links" ? result.url : documentUrl ?? baseUrl) } : {}) });
    }
    touched.forEach(source => options.onSource(sourceResult(source)));
    if (result.status !== "error") startValidation();
    if ((result.source === "links" || result.source === "scripts") && result.status !== "error") addExposureProbes();
    progress();
  }

  collect({ url: baseUrl, source: "links", kind: "page" });
  collect({ url: `${origin}/`, source: "links", kind: "page" });
  const entryResourceKind = pathResourceKind(baseUrl);
  if (entryResourceKind === "script") enqueue({ url: baseUrl, source: "scripts", documentUrl: `${origin}/`, depth: 0 });
  else if (entryResourceKind === "asset" && /\.xml(?:\.gz)?$/i.test(decodeURIComponent(new URL(baseUrl).pathname))) enqueue({ url: baseUrl, source: "sitemap", depth: 0 });
  else if (!entryResourceKind) enqueue({ url: baseUrl, source: "links", depth: 0 });
  enqueue({ url: `${origin}/`, source: "links", depth: 0 });
  enqueue({ url: `${origin}/robots.txt`, source: "robots", depth: 0 });
  enqueue({ url: `${origin}/sitemap.xml`, source: "sitemap", depth: 0 });
  progress();
  const archive = (async () => {
    try {
      const result = await readDocument(baseUrl, { source: "wayback", url: baseUrl }, 20_000, controller.signal);
      if (!controller.signal.aborted) accept(result, 0, false);
    } catch (error) { if (!controller.signal.aborted) throw error; }
    finally { archiveCompleted = true; progress(); }
  })();
  try {
    let offset = 0;
    while (offset < queue.length && !controller.signal.aborted) {
      const batch = queue.slice(offset, offset + Math.min(options.concurrency, 4));
      offset += batch.length;
      await Promise.all(batch.map(async job => {
        try {
          const result = entryDocument && job.source === "links" && job.url === entryDocument.url
            ? entryDocument : await readDocument(baseUrl, job, options.timeoutMs, controller.signal);
          if (!controller.signal.aborted) accept(result, job.depth, true, job.documentUrl);
        } catch (error) { if (!controller.signal.aborted) throw error; }
        finally { crawlCompleted++; progress(); }
      }));
    }
    await archive;
    options.signal.throwIfAborted();
    if (validationFailed) throw validationFailure;
    if (timedOut) {
      const unfinished = new Set(queue.slice(offset).map(job => job.source));
      // In-flight reads may have been cancelled; account for them as incomplete sources too.
      for (const source of Object.keys(counts) as CrawlSource[]) if (states[source].completed < counts[source]) unfinished.add(source);
      unfinished.forEach(source => { states[source].partial = true; states[source].messages.add("达到 90 秒发现时限，保留已读取记录"); });
      if (states.wayback.completed === 0) { states.wayback.partial = true; states.wayback.messages.add("历史记录查询未在发现时限内完成"); }
    }
    if (states.scripts.completed === 0 && states.links.succeeded === 0) {
      states.scripts.completed = 1;
      states.scripts.messages.add("未能读取站点页面，无法完整发现脚本线索");
    }
    const sources = PATH_DISCOVERY_SOURCES.map(source => sourceResult(source.id));
    sources.forEach(options.onSource);
    if (sources.every(source => source.status === "error")) throw new Error("所有发现来源均不可用，请查看来源详情后重试。");
    startValidation();
    discoveryFinished = true;
    validationQueue.setConcurrency(options.concurrency);
    progress();
    await validationQueue.done();
  } finally {
    clearTimeout(timer);
    controller.abort();
    options.signal.removeEventListener("abort", stop);
    // Always settle the independent archive before abandoning this discovery round.
    await archive;
    await validationQueue.cancel();
  }
  options.signal.throwIfAborted();
  return { discovered: candidates.size, validated: [...candidates.keys()].filter(url => validatedResults.has(url)).length,
    truncated, sources: PATH_DISCOVERY_SOURCES.map(source => sourceResult(source.id)), ...(baseUrl !== normalizeWebsiteUrl(options.baseUrl) ? { baseUrl } : {}) };
}

export function exportDiscoveredWebsitePathsCsv(results: DiscoveredWebsitePathResult[]) {
  return formatScanCsv(["url", "discovery_sources", "status", "http_status", "title", "content_length", "redirect_location", "possible_soft_404", "declared_client_route", "exposure_verdict", "exposure_kind", "exposure_confidence", "duration_ms", "message"],
    results.filter(result => !pathResourceKind(result.url) || exposurePathFor(result.url)).map(result => [result.url, result.sources.join("; "), result.status, result.statusCode, result.title, result.contentLength,
      result.location, Boolean(result.soft404), Boolean(result.clientRoute), result.exposure?.verdict, result.exposure?.path.kind, result.exposure?.path.confidence,
      result.durationMs, result.message]));
}
