import { createWebsitePathValidator, formatScanCsv, isWebsitePathScanResult, normalizeWebsiteUrl, requestNetworkScan, type WebsitePathScanResult } from "./network-scan";
import { confirmedExposure, exposurePathFor, exposureProbeUrls, type ExposurePath, type ExposureVerdict } from "./exposure-path";
import { MAX_PATH_SCRIPT_DOCUMENTS, MAX_PATH_SOURCE_CANDIDATES, pathResourceKind } from "./website-path-kind";

export type PathDiscoverySource = "links" | "scripts" | "robots" | "sitemap" | "wayback";
export const PATH_DISCOVERY_SOURCES: { id: PathDiscoverySource; label: string }[] = [
  { id: "links", label: "页面链接" }, { id: "scripts", label: "脚本线索" },
  { id: "robots", label: "爬虫声明" }, { id: "sitemap", label: "站点地图" }, { id: "wayback", label: "历史记录" }
];
export const MAX_DISCOVERED_WEBSITE_PATHS = 2000;
export const PATH_DISCOVERY_DURATION_MS = 180_000;
/** Large compressed bundles need their own read budget; path probes stay responsive. */
export const SCRIPT_DISCOVERY_TIMEOUT_MS = 45_000;
const MAX_DEPTH = 3;
const CRAWL_LIMITS = { links: 100, scripts: MAX_PATH_SCRIPT_DOCUMENTS, robots: 1, sitemap: 20 };
type CrawlSource = Exclude<PathDiscoverySource, "wayback">;
type CandidateKind = "page" | "script" | "sitemap" | "asset";
export interface PathDiscoveryEvidence { kind: string; documentUrl: string; bytes?: number; truncated?: boolean; methods?: string[] }
interface PathCandidate { url: string; kind: CandidateKind; source: PathDiscoverySource; sources?: PathDiscoverySource[]; documentUrl?: string; clientRoute?: boolean; evidence?: PathDiscoveryEvidence }
interface DiscoveryDocument {
  source: PathDiscoverySource; url: string; status: "success" | "partial" | "error";
  candidates: PathCandidate[]; message?: string;
  ignoredUrls?: string[];
  canonicalUrl?: string;
  /** Only transient transport/upstream failures may be retried. */
  retryable?: boolean;
  document?: { url: string; bytes: number; truncated: boolean; cacheHit?: boolean };
  response?: WebsitePathScanResult;
}
export interface PathDiscoverySourceResult {
  source: PathDiscoverySource; status: "success" | "partial" | "error"; urls: string[]; message?: string;
  issues?: PathDiscoveryIssue[];
  issueCount?: number;
  unresolvedIssueCount?: number;
}
export interface PathDiscoveryIssue {
  url: string; source: PathDiscoverySource; kind: "request" | "parse" | "limit" | "missing"; message: string;
  resolved?: boolean; attempts?: number; statusCode?: number;
}
export interface DiscoveredWebsitePathResult extends WebsitePathScanResult {
  sources: PathDiscoverySource[];
  clientRoute?: boolean;
  /** Set only for the fixed, non-destructive exposure probes that returned a real 2xx. */
  exposure?: { path: ExposurePath; verdict: ExposureVerdict };
  /** Wall-clock duration of the response validation for this path. */
  durationMs?: number;
  /** Up to eight observed documents, merged as later sources arrive. */
  evidence?: PathDiscoveryEvidence[];
}
export interface WebsitePathDiscoveryProgress {
  phase: "discovering" | "validating"; completed: number; total: number; discovered: number;
  discoveryCompleted?: number; discoveryTotal?: number;
  diagnostics?: WebsitePathDiscoveryDiagnostics;
}
export interface WebsitePathDiscoveryDiagnostics {
  documentsQueued: number; documentsRead: number; documentsFailed: number; retryAttempts: number;
  scriptDocuments: number; pendingDocuments: number; activeDocuments: number;
  pendingValidations: number; activeValidations: number; deadlineReached: boolean; skippedDocuments: number;
  reusedResponses?: number;
  failedAttempts?: number;
  recoveredDocuments?: number;
}
export interface WebsitePathDiscoverySummary {
  discovered: number; validated: number; truncated: boolean; sources: PathDiscoverySourceResult[];
  baseUrl?: string;
  diagnostics?: WebsitePathDiscoveryDiagnostics;
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
type CrawlEdge = Omit<CrawlJob, "depth">;
interface DocumentJob extends Omit<CrawlJob, "source"> {
  source: PathDiscoverySource; attempt: number; key: string; priority: number;
  pending: boolean; outcomes: DocumentOutcome[]; edges?: Map<string, CrawlEdge>; expandedDepth?: number;
}
interface DocumentOutcome {
  status: DiscoveryDocument["status"]; message?: string; statusCode?: number; truncated?: boolean; retryable?: boolean; redirectTo?: string;
}
interface ValidationJob { url: string; priority: number }
interface SourceState { messages: Set<string> }

function validCandidateUrl(value: unknown, origin: string): value is string {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.origin === origin && url.href === value && !url.username && !url.password && !url.search && !url.hash
      && !/[{}*]/.test(decodeURIComponent(url.pathname)) && !/(?:^|\/):[^/]+/.test(decodeURIComponent(url.pathname));
  } catch { return false; }
}

async function readDocument(baseUrl: string, job: { url: string; source: PathDiscoverySource; documentUrl?: string }, timeoutMs: number, signal: AbortSignal, scanId: string): Promise<DiscoveryDocument> {
  try {
    const result = await requestNetworkScan<DiscoveryDocument>({ kind: "path-discovery", baseUrl, url: job.url, source: job.source, scanId,
      ...(job.documentUrl ? { documentUrl: job.documentUrl } : {}), timeoutMs }, signal);
    const sourceIds = PATH_DISCOVERY_SOURCES.map(source => source.id);
    if (result.source !== job.source || result.url !== job.url || !["success", "partial", "error"].includes(result.status)
      || !Array.isArray(result.candidates) || result.candidates.length > MAX_PATH_SOURCE_CANDIDATES
      || (result.ignoredUrls !== undefined && (!Array.isArray(result.ignoredUrls) || result.ignoredUrls.length > MAX_DISCOVERED_WEBSITE_PATHS
        || result.ignoredUrls.some(url => !validCandidateUrl(url, new URL(baseUrl).origin))))
      || (result.message !== undefined && typeof result.message !== "string")
      || (result.retryable !== undefined && (typeof result.retryable !== "boolean" || result.retryable && result.status === "success"))
      || (result.document !== undefined && (!result.document || !validDocumentUrl(result.document.url, baseUrl)
        || !Number.isSafeInteger(result.document.bytes) || result.document.bytes < 0 || typeof result.document.truncated !== "boolean"
        || result.document.cacheHit !== undefined && typeof result.document.cacheHit !== "boolean"))
      || (result.response !== undefined && !isWebsitePathScanResult(result.response, job.url))
      || (result.canonicalUrl !== undefined && !validCanonicalUrl(result.canonicalUrl, job))
      || result.candidates.some(candidate => !candidate || !validCandidateUrl(candidate.url, new URL(baseUrl).origin)
        || !["page", "script", "sitemap", "asset", "probe"].includes(candidate.kind) || !sourceIds.includes(candidate.source)
        || (candidate.sources !== undefined && (!Array.isArray(candidate.sources) || candidate.sources.length > sourceIds.length
          || candidate.sources.some(source => !sourceIds.includes(source))))
        || (candidate.documentUrl !== undefined && !validCandidateUrl(candidate.documentUrl, new URL(baseUrl).origin))
        || (candidate.evidence !== undefined && (!candidate.evidence || typeof candidate.evidence.kind !== "string" || candidate.evidence.kind.length > 100
          || !validDocumentUrl(candidate.evidence.documentUrl, baseUrl)
          || candidate.evidence.bytes !== undefined && (!Number.isSafeInteger(candidate.evidence.bytes) || candidate.evidence.bytes < 0)
          || candidate.evidence.truncated !== undefined && typeof candidate.evidence.truncated !== "boolean"
          || candidate.evidence.methods !== undefined && (!Array.isArray(candidate.evidence.methods) || candidate.evidence.methods.length > 16
            || new Set(candidate.evidence.methods).size !== candidate.evidence.methods.length
            || candidate.evidence.methods.some(method => typeof method !== "string" || !/^[A-Z][A-Z0-9!#$%&'*+.^_`|~-]{0,31}$/.test(method))))))
      || result.candidates.some(candidate => candidate.clientRoute !== undefined && (typeof candidate.clientRoute !== "boolean" || candidate.kind !== "page" || candidate.source !== "scripts" && !candidate.sources?.includes("scripts")))
      || (result.status === "error" && (result.candidates.length || result.canonicalUrl !== undefined))) throw new Error("发现来源返回了无效或范围外的路径。");
    return result;
  } catch (error) {
    signal.throwIfAborted();
    return { ...job, status: "error", candidates: [], message: error instanceof Error ? error.message : "来源读取失败" };
  }
}

function validDocumentUrl(value: unknown, baseUrl: string): value is string {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    const base = new URL(baseUrl);
    return url.href === value && !url.username && !url.password && !url.hash
      && (url.origin === base.origin || base.protocol === "http:" && url.protocol === "https:" && url.hostname === base.hostname && !url.port);
  } catch { return false; }
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

/** Traverse published references with one priority scheduler shared by discovery and validation. */
export async function discoverWebsitePaths(options: DiscoveryOptions): Promise<WebsitePathDiscoverySummary> {
  let baseUrl = normalizeWebsiteUrl(options.baseUrl);
  let origin = new URL(baseUrl).origin;
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 8) throw new Error("并发数必须是 1–8 的整数。");
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 10_000) throw new Error("单项超时必须在 1–10 秒之间。");
  options.signal.throwIfAborted();
  const startedAt = Date.now();
  const scanId = crypto.randomUUID();
  let entryDocument: DiscoveryDocument | undefined;
  if (new URL(baseUrl).protocol === "http:" && !pathResourceKind(baseUrl)) {
    entryDocument = await readDocument(baseUrl, { source: "links", url: baseUrl }, options.timeoutMs, options.signal, scanId);
    if (entryDocument.canonicalUrl) {
      baseUrl = entryDocument.canonicalUrl;
      origin = new URL(baseUrl).origin;
      entryDocument = undefined;
    }
  }
  options.signal.throwIfAborted();
  options.onTarget?.(baseUrl);
  const candidates = new Map<string, Set<PathDiscoverySource>>();
  // Admission is monotonic: later asset evidence cannot recycle the 2,000-path limit.
  const admittedSiteUrls = new Set<string>();
  const resourceUrls = new Set<string>();
  const clientRoutes = new Set<string>();
  const evidence = new Map<string, PathDiscoveryEvidence[]>();
  const states = Object.fromEntries(PATH_DISCOVERY_SOURCES.map(({ id }) => [id,
    { messages: new Set<string>() }])) as Record<PathDiscoverySource, SourceState>;
  if (baseUrl !== normalizeWebsiteUrl(options.baseUrl)) states.links.messages.add("根据网站入口的实际跳转，已改用同主机 HTTPS 地址");
  const documentQueue: DocumentJob[] = [];
  const documentRecords = new Map<string, DocumentJob>();
  const extraIssues = new Map<string, PathDiscoveryIssue>();
  const uniqueDocuments = new Map<PathDiscoverySource, Set<string>>(PATH_DISCOVERY_SOURCES.map(({ id }) => [id, new Set()]));
  const validationQueue: ValidationJob[] = [];
  const scheduledValidations = new Set<string>();
  const validatedResults = new Map<string, WebsitePathScanResult>();
  const observedResponses = new Map<string, WebsitePathScanResult>();
  const exposureUrls = new Set<string>();
  let exposureCompleted = 0;
  let exposuresEnabled = false;
  let validationStarted = false;
  let validator: ReturnType<typeof createWebsitePathValidator> | undefined;
  let activeDocuments = 0;
  let activeValidations = 0;
  let documentsRead = 0;
  let documentsSinceValidation = 0;
  let failedAttempts = 0;
  let retryAttempts = 0;
  let truncated = false;
  let timedOut = false;
  let discoveryFinished = false;
  let failed = false;
  let failure: unknown;
  let initialized = false;
  let settled = false;
  const controller = new AbortController();
  const discoveryController = new AbortController();
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const completion = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  void completion.catch(() => {});
  const stop = () => fail(options.signal.reason ?? new DOMException("Aborted", "AbortError"));
  options.signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    for (const job of documentQueue) { job.pending = false; markTimedOut(job); }
    documentQueue.length = 0;
    discoveryController.abort(new DOMException("Discovery deadline reached", "TimeoutError"));
    pump();
  }, Math.max(1, PATH_DISCOVERY_DURATION_MS - (Date.now() - startedAt)));

  function diagnostics(): WebsitePathDiscoveryDiagnostics {
    const records = [...documentRecords.values()];
    const documentsFailed = records.filter(job => {
      const latest = job.outcomes.at(-1);
      return !job.pending && latest && (latest.status === "error" || latest.status === "partial" && latest.retryable)
        && !benignMissing(job, latest);
    }).length;
    const recoveredDocuments = records.filter(job => {
      const latest = job.outcomes.at(-1);
      return job.outcomes.length > 1 && latest && (latest.status === "success" || latest.status === "partial" && closedRedirect(job, latest))
        && job.outcomes.slice(0, -1).some(outcome => outcome.status !== "success");
    }).length;
    const skippedDocuments = [...extraIssues.keys()].filter(key => key.startsWith("skip:")).length;
    return { documentsQueued: documentRecords.size, documentsRead, documentsFailed, retryAttempts, failedAttempts, recoveredDocuments,
      scriptDocuments: uniqueDocuments.get("scripts")!.size, pendingDocuments: documentQueue.length, activeDocuments,
      pendingValidations: validationQueue.length, activeValidations, deadlineReached: timedOut, skippedDocuments,
      reusedResponses: [...validatedResults.values()].filter(result => result.responseReused).length };
  }
  function benignMissing(job: DocumentJob, outcome: DocumentOutcome) {
    return job.source === "links" && job.url !== baseUrl && job.url !== `${origin}/`
      && (outcome.statusCode === 404 || outcome.statusCode === 410);
  }
  function outcomeIssue(job: DocumentJob, outcome: DocumentOutcome): PathDiscoveryIssue {
    const kind = outcome.statusCode === 404 || outcome.statusCode === 410 ? "missing"
      : outcome.truncated || /(?:达到|超过).*(?:上限|时限)|读取限制/u.test(outcome.message ?? "") ? "limit"
        : outcome.retryable || outcome.statusCode! >= 300 && outcome.statusCode! < 400
          || outcome.status === "error" && !(outcome.statusCode! >= 200 && outcome.statusCode! < 300) ? "request" : "parse";
    return { url: job.url, source: job.source, kind,
      message: (outcome.message ?? (outcome.status === "error" ? "文档读取失败" : "文档仅返回部分线索")).slice(0, 600),
      attempts: Math.min(2, job.outcomes.length), ...(outcome.statusCode !== undefined ? { statusCode: outcome.statusCode } : {}) };
  }
  function closedRedirect(job: DocumentJob, outcome: DocumentOutcome): boolean {
    const seen = new Set<string>();
    while (outcome.redirectTo && !outcome.retryable && !seen.has(job.key)) {
      seen.add(job.key);
      const edge = [...job.edges?.values() ?? []].find(edge => edge.url === outcome.redirectTo);
      if (!edge) return false;
      const target = documentRecords.get(documentKey(edge));
      const latest = target?.outcomes.at(-1);
      if (!target || target.pending || !latest) return false;
      if (latest.status === "success" && latest.statusCode! >= 200 && latest.statusCode! < 300) return true;
      if (latest.status !== "partial") return false;
      job = target; outcome = latest;
    }
    return false;
  }
  function documentIssues(job: DocumentJob): PathDiscoveryIssue[] {
    const latest = job.outcomes.at(-1);
    if (!latest) return [];
    const issues: PathDiscoveryIssue[] = [];
    job.outcomes.forEach((outcome, index) => {
      if (outcome.status === "success") return;
      const earlier = index < job.outcomes.length - 1;
      const issue = outcomeIssue(job, outcome);
      // A second partial transport failure has not recovered the first one.
      // Keep its latest issue once; a successful read or a different remaining
      // parse/limit problem can establish that the earlier cause was resolved.
      const recovered = earlier && (latest.status === "success" || latest.status === "partial" && (closedRedirect(job, latest)
        || !latest.retryable && outcomeIssue(job, latest).kind !== issue.kind));
      if (earlier && !recovered) return;
      issues.push({ ...issue, resolved: recovered || benignMissing(job, outcome) || outcome.status === "partial" && closedRedirect(job, outcome) });
    });
    return issues;
  }
  function sourceResult(source: PathDiscoverySource): PathDiscoverySourceResult {
    const state = states[source];
    const records = [...documentRecords.values()].filter(job => job.source === source);
    const issues = [...records.flatMap(documentIssues), ...[...extraIssues.values()].filter(issue => issue.source === source)]
      .sort((left, right) => Number(Boolean(left.resolved)) - Number(Boolean(right.resolved)));
    const unresolved = issues.filter(issue => !issue.resolved);
    const usable = records.some(job => job.outcomes.some(outcome => outcome.status !== "error" || benignMissing(job, outcome)));
    const urls = [...candidates].filter(([, sources]) => sources.has(source)).map(([url]) => url).sort();
    const status = unresolved.length ? usable || unresolved.some(issue => issue.kind === "limit") ? "partial" : "error" : "success";
    const notes = [...state.messages, ...records.flatMap(job => {
      const latest = job.outcomes.at(-1);
      return latest?.status === "success" && latest.message ? [latest.message] : [];
    }), ...unresolved.map(issue => issue.message)];
    const message = [...new Set(notes)].join("；").slice(0, 600);
    return { source, status, urls, ...(message ? { message } : {}),
      ...(issues.length ? { issues: issues.slice(0, 40), issueCount: issues.length, unresolvedIssueCount: unresolved.length } : {}) };
  }
  function progress() {
    if (!options.signal.aborted && !failed) options.onProgress?.({ phase: discoveryFinished ? "validating" : "discovering",
      completed: [...candidates.keys()].filter(url => validatedResults.has(url)).length,
      total: candidates.size, discovered: candidates.size,
      discoveryCompleted: documentsRead, discoveryTotal: documentRecords.size + retryAttempts, diagnostics: diagnostics() });
  }
  function emitResult(url: string) {
    const raw = validatedResults.get(url);
    if (!raw || resourceUrls.has(url) && !exposureUrls.has(url) || options.signal.aborted || failed) return;
    const result: DiscoveredWebsitePathResult = { ...raw,
      ...(clientRoutes.has(url) ? { clientRoute: true } : {}),
      ...(evidence.has(url) ? { evidence: [...evidence.get(url)!] } : {}),
      sources: PATH_DISCOVERY_SOURCES.filter(source => candidates.get(url)?.has(source.id)).map(source => source.id) };
    const confirmed = exposureUrls.has(url) ? confirmedExposure(result, result.missingPathBaseline) : undefined;
    options.onResult({ ...result, ...(confirmed ? { exposure: confirmed } : {}) });
  }
  function scheduleValidation(url: string) {
    if (scheduledValidations.has(url) || validatedResults.has(url) || !validationStarted) return;
    scheduledValidations.add(url);
    // A fixed probe that is also an observed path receives normal path priority.
    validationQueue.push({ url, priority: candidates.has(url) ? 1 : 0 });
  }
  function startValidation() {
    if (validationStarted) return;
    validationStarted = true;
    candidates.forEach((_sources, url) => scheduleValidation(url));
  }
  function addExposureProbes() {
    if (exposuresEnabled) return;
    exposuresEnabled = true;
    exposureProbeUrls(baseUrl).forEach(url => exposureUrls.add(url));
    exposureCompleted = [...exposureUrls].filter(url => validatedResults.has(url)).length;
    options.onExposureProgress?.(exposureCompleted, exposureUrls.size);
    exposureUrls.forEach(url => { if (validatedResults.has(url)) emitResult(url); else scheduleValidation(url); });
  }
  function ignoreResource(url: string, touched?: Set<PathDiscoverySource>) {
    candidates.get(url)?.forEach(source => touched?.add(source));
    resourceUrls.add(url);
    candidates.delete(url);
    clientRoutes.delete(url);
    evidence.delete(url);
    for (const [key, issue] of extraIssues) {
      if (key.startsWith("skip:links:") && issue.url === url) extraIssues.delete(key);
    }
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
    let evidenceChanged = false;
    if (candidate.evidence) {
      const documents = evidence.get(candidate.url) ?? [];
      const previous = documents.find(item => item.kind === candidate.evidence!.kind && item.documentUrl === candidate.evidence!.documentUrl);
      if (previous) {
        const next = { ...previous };
        const methods = [...new Set([...previous.methods ?? [], ...candidate.evidence.methods ?? []])].slice(0, 16);
        if (methods.length !== (previous.methods?.length ?? 0)) { next.methods = methods; evidenceChanged = true; }
        if (candidate.evidence.bytes !== undefined && (previous.bytes === undefined || previous.truncated && !candidate.evidence.truncated)) {
          next.bytes = candidate.evidence.bytes;
          next.truncated = candidate.evidence.truncated;
          evidenceChanged = true;
        }
        if (evidenceChanged) evidence.set(candidate.url, documents.map(item => item === previous ? next : item));
      } else if (documents.length < 8) {
        evidence.set(candidate.url, [...documents, { ...candidate.evidence,
          ...(candidate.evidence.methods ? { methods: [...candidate.evidence.methods] } : {}) }]);
        evidenceChanged = true;
      }
    }
    const provenance = new Set([candidate.source, ...candidate.sources ?? []]);
    const existing = candidates.get(candidate.url);
    if (existing) {
      const changed = evidenceChanged || [...provenance].some(source => !existing.has(source)) || candidate.clientRoute && !clientRoutes.has(candidate.url);
      provenance.forEach(source => existing.add(source));
      if (candidate.clientRoute) clientRoutes.add(candidate.url);
      if (changed) emitResult(candidate.url);
      return true;
    }
    if (!admittedSiteUrls.has(candidate.url) && admittedSiteUrls.size === MAX_DISCOVERED_WEBSITE_PATHS) {
      evidence.delete(candidate.url);
      truncated = true;
      provenance.forEach(source => {
        const key = `paths:${source}`;
        if (!extraIssues.has(key)) extraIssues.set(key, { url: candidate.url, source, kind: "limit", message: "发现路径超过 2,000 项，本轮仅验证保留的路径" });
      });
      return false;
    }
    admittedSiteUrls.add(candidate.url);
    candidates.set(candidate.url, provenance);
    if (candidate.clientRoute) clientRoutes.add(candidate.url);
    if (validatedResults.has(candidate.url)) emitResult(candidate.url);
    else {
      scheduleValidation(candidate.url);
      const pending = validationQueue.find(job => job.url === candidate.url);
      if (pending) pending.priority = 1;
    }
    return true;
  }
  function documentKey(job: CrawlEdge) {
    // Relative requests in one shared script have equivalent bases for owners in
    // the same directory. Different owner directories still get their own parse.
    const owner = job.source === "scripts" ? new URL(job.documentUrl ?? baseUrl) : undefined;
    const context = owner ? `${new URL(".", owner).href}${owner.search}${owner.hash}` : "";
    return `${job.source}:${job.url}:${context}`;
  }
  function enqueue(job: CrawlJob) {
    if (timedOut || failed) return;
    const key = documentKey(job);
    const previous = documentRecords.get(key);
    if (previous) {
      extraIssues.delete(`skip:${key}`);
      if (job.depth < previous.depth) {
        previous.depth = job.depth;
        // Revisit only the parsed graph edges. A newly shorter route must reach
        // descendants without downloading the same document or charging twice.
        if (previous.edges && (previous.expandedDepth === undefined || job.depth < previous.expandedDepth)) {
          previous.expandedDepth = job.depth;
          previous.edges.forEach(edge => enqueueEdge(edge, previous));
        }
      }
      return;
    }
    const unique = uniqueDocuments.get(job.source)!;
    if (job.depth > MAX_DEPTH || !unique.has(job.url) && unique.size >= CRAWL_LIMITS[job.source]) {
      extraIssues.set(`skip:${key}`, { url: job.url, source: job.source, kind: "limit",
        message: job.depth > MAX_DEPTH ? "达到 3 层爬取深度，保留已发现路径"
          : job.source === "scripts" ? `达到本轮 ${MAX_PATH_SCRIPT_DOCUMENTS} 份不同脚本文档上限，保留已发现路径` : "达到本轮文档读取上限，保留已发现路径" });
      return;
    }
    extraIssues.delete(`skip:${key}`);
    unique.add(job.url);
    const priority = job.source === "scripts" ? 80 : job.source === "robots" ? 90 : job.source === "sitemap" ? 70 : job.depth === 0 ? 100 : 50;
    const record = { ...job, key, priority, attempt: 0, pending: true, outcomes: [] };
    documentRecords.set(key, record);
    documentQueue.push(record);
  }
  function shouldCrawlPage(candidate: PathCandidate) {
    if (candidate.evidence?.kind !== "request") return true;
    // Request evidence proves an endpoint, not an HTML page. An independently
    // observed navigation/link still promotes the same URL into the page graph.
    return Boolean(candidate.clientRoute || [candidate.source, ...candidate.sources ?? []]
      .some(source => source === "links" || source === "robots" || source === "sitemap"));
  }
  function expandDocument(result: DiscoveryDocument, job: DocumentJob) {
    if (result.source === "wayback") return;
    for (const candidate of result.candidates) {
      const kind = candidate.kind === "page" ? pathResourceKind(candidate.url) ?? "page" : candidate.kind;
      if (kind === "asset" || kind === "page" && (!candidates.has(candidate.url) || !shouldCrawlPage(candidate))) continue;
      const source = kind === "script" ? "scripts" : kind === "sitemap" ? "sitemap" : "links";
      const edge: CrawlEdge = { url: candidate.url, source,
        ...(source === "scripts" ? { documentUrl: candidate.documentUrl ?? (result.source === "links" ? result.url : job.documentUrl ?? baseUrl) } : {}) };
      // Keep only crawl edges, not full response/evidence arrays, for depth replay.
      (job.edges ??= new Map()).set(`${source}:${edge.url}:${edge.documentUrl ?? ""}`, edge);
      enqueueEdge(edge, job);
    }
  }
  function enqueueEdge(edge: CrawlEdge, job: DocumentJob) {
    if (edge.source === "links" && !candidates.has(edge.url)) return;
    enqueue({ ...edge, depth: edge.source === "sitemap" ? 0 : edge.source === "scripts" ? job.depth : job.depth + 1 });
  }
  function accept(result: DiscoveryDocument, job: DocumentJob) {
    options.signal.throwIfAborted();
    job.expandedDepth = job.depth;
    const touched = new Set<PathDiscoverySource>([result.source]);
    for (const url of result.ignoredUrls ?? []) ignoreResource(url, touched);
    for (const candidate of result.candidates) {
      touched.add(candidate.source);
      candidate.sources?.forEach(source => touched.add(source));
      collect(candidate, touched);
    }
    expandDocument(result, job);
    touched.forEach(source => options.onSource(sourceResult(source)));
    if (result.status !== "error") startValidation();
    if ((result.source === "links" || result.source === "scripts") && result.status !== "error") addExposureProbes();
    progress();
  }
  function markTimedOut(job: DocumentJob) {
    extraIssues.set(`deadline:${job.key}`, { url: job.url, source: job.source, kind: "limit",
      message: job.source === "wayback" ? "历史记录查询未在发现时限内完成" : `达到 ${PATH_DISCOVERY_DURATION_MS / 1000} 秒发现时限，保留已读取记录` });
  }
  function fail(error: unknown) {
    if (failed) return;
    failed = true;
    failure = error;
    controller.abort(error);
    discoveryController.abort(error);
    documentQueue.length = 0;
    validationQueue.length = 0;
    finish();
  }
  // Even an adapter that ignores AbortSignal must not keep the scheduler alive or
  // publish a late result. Real transport requests receive the same cancellation.
  async function cancellable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    let abort!: () => void;
    const cancellation = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    });
    try { return await Promise.race([operation(), cancellation]); }
    finally { signal.removeEventListener("abort", abort); }
  }
  function finishDiscovery() {
    if (discoveryFinished || activeDocuments || documentQueue.length || failed) return;
    discoveryFinished = true;
    clearTimeout(timer);
    const records = [...documentRecords.values()];
    if (!records.some(job => job.source === "scripts" && job.outcomes.length)
      && !records.some(job => job.source === "links" && job.outcomes.some(outcome => outcome.status !== "error"))) {
      extraIssues.set("scripts:entry", { url: baseUrl, source: "scripts", kind: "request", message: "未能读取站点页面，无法完整发现脚本线索" });
    }
    const sources = PATH_DISCOVERY_SOURCES.map(source => sourceResult(source.id));
    sources.forEach(options.onSource);
    if (sources.every(source => source.status === "error")) { fail(new Error("所有发现来源均不可用，请查看来源详情后重试。")); return; }
    startValidation();
    // Queue reconciliation is intentional: a result removed while in flight may
    // become a fixed probe later, and no accepted candidate may be left behind.
    candidates.forEach((_sources, url) => scheduleValidation(url));
    if (exposuresEnabled) exposureUrls.forEach(url => scheduleValidation(url));
    progress();
  }
  function finish() {
    if (settled || activeDocuments || activeValidations || !failed && (!discoveryFinished || validationQueue.length)) return;
    settled = true;
    if (failed) reject(failure); else resolve();
  }
  function runDocument(job: DocumentJob) {
    activeDocuments++;
    documentsSinceValidation++;
    void cancellable(() => {
      if (entryDocument && job.source === "links" && job.url === entryDocument.url) {
        const result = entryDocument;
        entryDocument = undefined;
        return Promise.resolve(result);
      }
      return readDocument(baseUrl, job, job.source === "scripts" ? SCRIPT_DISCOVERY_TIMEOUT_MS : job.source === "wayback" ? 20_000 : options.timeoutMs, discoveryController.signal, scanId);
    }, discoveryController.signal)
      .then(result => {
        if (failed || discoveryController.signal.aborted) return;
        documentsRead++;
        let redirectTo: string | undefined;
        if (result.response?.statusCode! >= 300 && result.response?.statusCode! < 400 && result.response?.location) {
          try {
            const target = new URL(result.response.location, job.url);
            target.search = ""; target.hash = "";
            if (validCandidateUrl(target.href, origin)) redirectTo = target.href;
          } catch { /* Invalid and cross-origin redirects remain unresolved. */ }
        }
        job.outcomes.push({ status: result.status, ...(result.message ? { message: result.message } : {}),
          ...(result.response?.statusCode !== undefined ? { statusCode: result.response.statusCode } : {}),
          ...(result.document?.truncated !== undefined ? { truncated: result.document.truncated } : {}),
          ...(redirectTo ? { redirectTo } : {}),
          ...(result.retryable !== undefined ? { retryable: result.retryable } : {}) });
        if (result.response?.status === "responded" && !validatedResults.has(result.response.url)) observedResponses.set(result.response.url, result.response);
        if (result.status === "error" || result.retryable) failedAttempts++;
        if (result.status === "partial") accept(result, job);
        if (result.retryable && job.attempt === 0 && !timedOut) {
          retryAttempts++;
          job.attempt++;
          documentQueue.push(job);
          options.onSource(sourceResult(job.source));
          return;
        }
        if (result.status !== "partial") accept(result, job);
        job.pending = false;
      }).catch(error => {
        if (timedOut && !failed) markTimedOut(job);
        else if (!failed) fail(error);
      }).finally(() => { if (failed || timedOut) job.pending = false; activeDocuments--; pump(); });
  }
  function runValidation(job: ValidationJob) {
    activeValidations++;
    if (job.priority > 0) documentsSinceValidation = 0;
    void cancellable(async () => {
      if (resourceUrls.has(job.url) && !exposureUrls.has(job.url)) return;
      validator ??= createWebsitePathValidator({ baseUrl, timeoutMs: options.timeoutMs, signal: controller.signal });
      const validate = await validator;
      controller.signal.throwIfAborted();
      if (resourceUrls.has(job.url) && !exposureUrls.has(job.url)) return;
      try { return await validate(job.url, controller.signal, observedResponses.get(job.url)); }
      catch (error) {
        controller.signal.throwIfAborted();
        if (error instanceof TypeError || error instanceof DOMException && error.name === "TimeoutError") {
          return { url: job.url, status: "error" as const, message: error.message || "路径请求失败，请稍后重试。" };
        }
        throw error;
      }
    }, controller.signal).then(result => {
      if (failed || controller.signal.aborted) return;
      if (!result) {
        scheduledValidations.delete(job.url);
        if (exposureUrls.has(job.url)) scheduleValidation(job.url);
        return;
      }
      validatedResults.set(result.url, result);
      observedResponses.delete(result.url);
      emitResult(result.url);
      if (exposureUrls.has(result.url)) {
        exposureCompleted++;
        options.onExposureProgress?.(exposureCompleted, exposureUrls.size);
      }
      progress();
    }).catch(error => { if (!failed) fail(error); })
      .finally(() => { activeValidations--; pump(); });
  }
  function pump() {
    if (!initialized || settled) return;
    try {
      finishDiscovery();
      while (!failed && activeDocuments + activeValidations < options.concurrency) {
        let validationIndex = -1;
        for (let next = 0; next < validationQueue.length; next++) {
          const candidate = validationQueue[next];
          // A queued/in-flight HTML read can supply the same response. Other
          // candidates continue first, and discovery expiry releases all waits.
          if (!discoveryFinished && documentRecords.get(`links:${candidate.url}:`)?.pending) continue;
          if (validationIndex < 0 || candidate.priority > validationQueue[validationIndex].priority) validationIndex = next;
        }
        const normalValidation = validationIndex >= 0 && validationQueue[validationIndex].priority > 0;
        const validationTurn = normalValidation && activeValidations === 0
          && (options.concurrency > 1 || documentsSinceValidation >= 4);
        if (validationTurn) {
          runValidation(validationQueue.splice(validationIndex, 1)[0]);
          continue;
        }
        if (documentQueue.length && !timedOut) {
          let index = 0;
          for (let next = 1; next < documentQueue.length; next++) if (documentQueue[next].priority > documentQueue[index].priority) index = next;
          runDocument(documentQueue.splice(index, 1)[0]);
          continue;
        }
        // One live validation worker provides feedback while leaving the other
        // slots available for new scripts; all slots open after discovery closes.
        if (validationIndex < 0 || !discoveryFinished && activeValidations >= 1) break;
        runValidation(validationQueue.splice(validationIndex, 1)[0]);
      }
      progress();
      finish();
    } catch (error) { fail(error); }
  }

  try {
    collect({ url: baseUrl, source: "links", kind: "page" });
    collect({ url: `${origin}/`, source: "links", kind: "page" });
    const entryResourceKind = pathResourceKind(baseUrl);
    if (entryResourceKind === "script") enqueue({ url: baseUrl, source: "scripts", documentUrl: `${origin}/`, depth: 0 });
    else if (entryResourceKind === "asset" && /\.xml(?:\.gz)?$/i.test(decodeURIComponent(new URL(baseUrl).pathname))) enqueue({ url: baseUrl, source: "sitemap", depth: 0 });
    else if (!entryResourceKind) enqueue({ url: baseUrl, source: "links", depth: 0 });
    enqueue({ url: `${origin}/`, source: "links", depth: 0 });
    enqueue({ url: `${origin}/robots.txt`, source: "robots", depth: 0 });
    enqueue({ url: `${origin}/sitemap.xml`, source: "sitemap", depth: 0 });
    const archive: DocumentJob = { url: baseUrl, source: "wayback", depth: 0, attempt: 0, key: `wayback:${baseUrl}`, priority: 30, pending: true, outcomes: [] };
    documentRecords.set(archive.key, archive);
    documentQueue.push(archive);
    initialized = true;
    pump();
    await completion;
  } finally {
    clearTimeout(timer);
    controller.abort();
    discoveryController.abort();
    options.signal.removeEventListener("abort", stop);
  }
  options.signal.throwIfAborted();
  return { discovered: candidates.size, validated: [...candidates.keys()].filter(url => validatedResults.has(url)).length,
    truncated, sources: PATH_DISCOVERY_SOURCES.map(source => sourceResult(source.id)), diagnostics: diagnostics(),
    ...(baseUrl !== normalizeWebsiteUrl(options.baseUrl) ? { baseUrl } : {}) };
}

export function exportDiscoveredWebsitePathsCsv(results: DiscoveredWebsitePathResult[]) {
  return formatScanCsv(["url", "discovery_sources", "status", "http_status", "title", "content_length", "redirect_location", "possible_soft_404", "declared_client_route", "exposure_verdict", "exposure_kind", "exposure_confidence", "duration_ms", "message", "evidence_documents", "evidence_kinds", "declared_methods"],
    results.filter(result => !pathResourceKind(result.url) || exposurePathFor(result.url)).map(result => [result.url, result.sources.join("; "), result.status, result.statusCode, result.title, result.contentLength,
      result.location, Boolean(result.soft404), Boolean(result.clientRoute), result.exposure?.verdict, result.exposure?.path.kind, result.exposure?.path.confidence,
      result.durationMs, result.message, [...new Set(result.evidence?.map(item => item.documentUrl))].join("; "), [...new Set(result.evidence?.map(item => item.kind))].join("; "), [...new Set(result.evidence?.flatMap(item => item.methods ?? []))].join("; ")]));
}
