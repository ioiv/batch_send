import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import { fetchPublicDocument, normalizeDomain, type PublicDocumentResult } from "./network-scan.js";

export type SubdomainDiscoverySource = "crtsh" | "certspotter" | "hackertarget" | "dns" | "website" | "wayback";
export interface SubdomainDiscoveryResult {
  source: SubdomainDiscoverySource;
  status: "success" | "partial" | "error";
  domains: string[];
  message?: string;
}

type MetadataResolver = Pick<Resolver, "resolveNs" | "resolveMx" | "resolveTxt" | "resolveSoa" | "cancel">;
export interface SubdomainDiscoveryDependencies {
  fetchDocument(url: string, options: { timeoutMs: number; maxBytes: number; signal?: AbortSignal }): Promise<PublicDocumentResult>;
  createResolver(): MetadataResolver;
}

const defaults: SubdomainDiscoveryDependencies = { fetchDocument: fetchPublicDocument, createResolver: () => new Resolver() };
export const MAX_DISCOVERY_DOMAINS = 5000;
export const MAX_DISCOVERY_BYTES = 4 * 1024 * 1024;
const MAX_PAGES = 8;
const ABSENT_DNS_CODES = new Set(["ENODATA", "ENOTFOUND"]);

class SourceFailure extends Error {}

class DomainCollector {
  readonly domains = new Set<string>();
  capped = false;
  constructor(readonly root: string) {}
  add(input: unknown): void {
    if (typeof input !== "string" || input.includes("*")) return;
    let hostname: string;
    try { hostname = normalizeDomain(input.trim()); } catch { return; }
    if (hostname === this.root || !hostname.endsWith(`.${this.root}`) || this.domains.has(hostname)) return;
    if (this.domains.size >= MAX_DISCOVERY_DOMAINS) { this.capped = true; return; }
    this.domains.add(hostname);
    if (this.domains.size === MAX_DISCOVERY_DOMAINS) this.capped = true;
  }
  addUrl(value: unknown): void {
    if (typeof value !== "string" || value.length > 16384) return;
    try {
      const url = new URL(value.startsWith("//") ? `https:${value}` : value);
      if (url.protocol === "http:" || url.protocol === "https:") this.add(url.hostname);
    } catch { /* Historical URLs and document contents can contain malformed entries. */ }
  }
}

interface Context {
  domain: string;
  collector: DomainCollector;
  signal: AbortSignal;
  deadline: number;
  dependencies: SubdomainDiscoveryDependencies;
  warnings: Set<string>;
}

async function readDocument(context: Context, url: URL | string, maxBytes = MAX_DISCOVERY_BYTES): Promise<PublicDocumentResult> {
  const remaining = context.deadline - Date.now();
  if (remaining <= 0 || context.signal.aborted) throw new SourceFailure("来源查询超时或已取消");
  const response = await context.dependencies.fetchDocument(url.toString(), { timeoutMs: remaining, maxBytes, signal: context.signal });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    if (response.statusCode === 429) throw new SourceFailure("来源暂时限流，请稍后重试");
    throw new SourceFailure(`来源返回 HTTP ${response.statusCode}`);
  }
  if (response.truncated) context.warnings.add("来源响应达到读取上限，结果可能不完整");
  return response;
}

function parseJson(response: PublicDocumentResult): unknown {
  try { return JSON.parse(response.body.toString("utf8")); } catch { throw new SourceFailure("来源返回的数据格式无效"); }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

async function discoverCrtsh(context: Context): Promise<void> {
  const url = new URL("https://crt.sh/");
  url.searchParams.set("q", `%.${context.domain}`);
  url.searchParams.set("output", "json");
  const response = await readDocument(context, url);
  if (response.truncated) {
    // Recover only complete JSON string fields from a bounded, cut-off response.
    for (const match of response.body.toString("utf8").matchAll(/"name_value"\s*:\s*("(?:\\.|[^"\\])*")/g)) {
      try { for (const name of (JSON.parse(match[1]) as string).split(/\r?\n/)) context.collector.add(name); } catch { /* Skip an incomplete field. */ }
    }
    return;
  }
  const rows = parseJson(response);
  if (!Array.isArray(rows) || rows.some((row) => typeof record(row)?.name_value !== "string")) throw new SourceFailure("crt.sh 返回的数据格式无效");
  let rawCount = 0;
  let unknownCount = false;
  for (const row of rows) {
    const entry = record(row)!;
    for (const name of (entry.name_value as string).split(/\r?\n/)) context.collector.add(name);
    if (typeof entry.result_count === "number" && Number.isFinite(entry.result_count) && entry.result_count >= 0) rawCount += entry.result_count;
    else unknownCount = true;
  }
  // crt.sh applies its 10,000-row limit before grouping; it has no stable pagination API.
  if (rawCount >= 10000 || rows.length >= 10000) context.warnings.add("crt.sh 达到来源记录上限，结果可能不完整");
  if (unknownCount) context.warnings.add("crt.sh 未提供完整性计数，无法确认是否截断");
}

async function discoverCertspotter(context: Context): Promise<void> {
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL("https://api.certspotter.com/v1/issuances");
    url.searchParams.set("domain", context.domain);
    url.searchParams.set("include_subdomains", "true");
    url.searchParams.set("expand", "dns_names");
    if (cursor) url.searchParams.set("after", cursor);
    const response = await readDocument(context, url);
    if (response.truncated) {
      for (const match of response.body.toString("utf8").matchAll(/"dns_names"\s*:\s*(\[(?:\s*"(?:\\.|[^"\\])*"\s*,?)*\s*\])/g)) {
        try { for (const name of JSON.parse(match[1]) as unknown[]) context.collector.add(name); } catch { /* Skip an incomplete array. */ }
      }
      return;
    }
    const rows = parseJson(response);
    if (!Array.isArray(rows) || rows.some((row) => !Array.isArray(record(row)?.dns_names) || (record(row)!.dns_names as unknown[]).some((name) => typeof name !== "string"))) throw new SourceFailure("CertSpotter 返回的数据格式无效");
    if (!rows.length) return;
    rows.forEach((row) => (record(row)!.dns_names as string[]).forEach((name) => context.collector.add(name)));
    if (context.collector.capped) return;
    const lastId = record(rows[rows.length - 1])?.id;
    if (typeof lastId !== "string" || !lastId || lastId.length > 200 || seenCursors.has(lastId)) {
      context.warnings.add("CertSpotter 无法继续分页，已保留当前结果");
      return;
    }
    cursor = lastId;
    seenCursors.add(cursor);
  }
  context.warnings.add("CertSpotter 达到分页上限，结果可能不完整");
}

async function discoverHackerTarget(context: Context): Promise<void> {
  const url = new URL("https://api.hackertarget.com/hostsearch/");
  url.searchParams.set("q", context.domain);
  const response = await readDocument(context, url);
  const text = response.body.toString("utf8");
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (response.truncated && !/\r?\n$/.test(text)) lines.pop();
  if (!lines.length) {
    if (response.truncated) return;
    throw new SourceFailure("HackerTarget 暂无可用数据或已达到调用配额");
  }
  let malformed = 0;
  for (const line of lines) {
    const cells = line.split(",");
    if (cells.length !== 2 || !isIP(cells[1].trim())) { malformed += 1; continue; }
    try { context.collector.add(normalizeDomain(cells[0].trim())); } catch { malformed += 1; }
  }
  if (malformed === lines.length) throw new SourceFailure("HackerTarget 暂无可用数据或已达到调用配额");
  if (malformed) context.warnings.add("HackerTarget 部分记录格式无效，已保留有效线索");
  if (lines.length >= 500) context.warnings.add("HackerTarget 达到免费来源记录上限，结果可能不完整");
}

async function discoverWayback(context: Context): Promise<void> {
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL("https://web.archive.org/cdx/search/cdx");
    url.searchParams.set("url", context.domain);
    url.searchParams.set("matchType", "domain");
    url.searchParams.set("output", "json");
    url.searchParams.set("fl", "original");
    url.searchParams.set("collapse", "urlkey");
    url.searchParams.set("limit", "1000");
    url.searchParams.set("showResumeKey", "true");
    if (cursor) url.searchParams.set("resumeKey", cursor);
    const response = await readDocument(context, url);
    if (response.truncated) {
      for (const match of response.body.toString("utf8").matchAll(/\[\s*("(?:\\.|[^"\\])*")\s*\]/g)) {
        try { context.collector.addUrl(JSON.parse(match[1])); } catch { /* Skip an incomplete URL. */ }
      }
      return;
    }
    const rows = parseJson(response);
    if (!Array.isArray(rows) || rows.some((row) => !Array.isArray(row)) || (rows.length && (rows[0].length !== 1 || rows[0][0] !== "original"))) throw new SourceFailure("Wayback 返回的数据格式无效");
    let nextCursor: string | undefined;
    let hasResumeMarker = false;
    for (let index = 1; index < rows.length; index += 1) {
      const row: unknown[] = rows[index];
      if (!row.length && index === rows.length - 2 && rows[index + 1].length === 1 && typeof rows[index + 1][0] === "string") {
        nextCursor = rows[index + 1][0];
        hasResumeMarker = true;
        break;
      }
      if (row.length !== 1 || typeof row[0] !== "string") throw new SourceFailure("Wayback 返回的数据格式无效");
      context.collector.addUrl(row[0]);
    }
    if (context.collector.capped) return;
    if (hasResumeMarker && !nextCursor) { context.warnings.add("Wayback 无法继续分页，已保留当前结果"); return; }
    if (!nextCursor) return;
    if (nextCursor.length > 1024 || seenCursors.has(nextCursor)) {
      context.warnings.add("Wayback 无法继续分页，已保留当前结果");
      return;
    }
    cursor = nextCursor;
    seenCursors.add(cursor);
  }
  context.warnings.add("Wayback 达到分页上限，结果可能不完整");
}

function extractDocumentUrls(context: Context, text: string): void {
  for (const match of text.matchAll(/(?:https?:\/\/|\/\/)[^\s"'<>]+/gi)) context.collector.addUrl(match[0].replace(/&amp;/gi, "&"));
}

async function discoverWebsite(context: Context): Promise<void> {
  let readable = 0;
  await Promise.all(["/", "/robots.txt", "/sitemap.xml"].map(async (path) => {
    const url = `https://${context.domain}${path}`;
    try {
      const remaining = context.deadline - Date.now();
      if (remaining <= 0 || context.signal.aborted) throw new SourceFailure("来源查询超时或已取消");
      const response = await context.dependencies.fetchDocument(url, { timeoutMs: remaining, maxBytes: 1024 * 1024, signal: context.signal });
      if (response.statusCode >= 200 && response.statusCode < 400) {
        readable += 1;
        if (response.location) {
          try { context.collector.addUrl(new URL(response.location, url).href); } catch { /* Do not follow malformed redirects. */ }
        }
        extractDocumentUrls(context, response.body.toString("utf8"));
        if (response.truncated) context.warnings.add("网站文档达到读取上限，结果可能不完整");
      } else if (response.statusCode === 404 || response.statusCode === 410) readable += 1;
      else context.warnings.add("部分网站文档不可读取，已保留可用线索");
    } catch { context.warnings.add("部分网站文档请求失败，已保留可用线索"); }
  }));
  if (!readable) throw new SourceFailure("网站文档暂时无法读取");
}

function dnsCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

async function discoverDnsMetadata(context: Context): Promise<void> {
  const resolver = context.dependencies.createResolver();
  const onAbort = () => resolver.cancel();
  if (context.signal.aborted) { resolver.cancel(); throw new SourceFailure("来源查询已取消"); }
  context.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const answers = await Promise.allSettled([resolver.resolveNs(context.domain), resolver.resolveMx(context.domain), resolver.resolveTxt(context.domain), resolver.resolveSoa(context.domain)]);
    let operationalErrors = 0;
    let usableQueries = 0;
    answers.forEach((answer) => {
      if (answer.status === "fulfilled" || ABSENT_DNS_CODES.has(dnsCode(answer.reason) ?? "")) usableQueries += 1;
      else operationalErrors += 1;
    });
    if (!usableQueries) throw new SourceFailure("DNS 元数据来源查询失败");
    if (operationalErrors) context.warnings.add("部分 DNS 元数据查询失败，已保留可用线索");
    const [ns, mx, txt, soa] = answers;
    if (ns.status === "fulfilled") (ns.value as string[]).forEach((name) => context.collector.add(name));
    if (mx.status === "fulfilled") (mx.value as Array<{ exchange: string }>).forEach((entry) => context.collector.add(entry.exchange));
    if (txt.status === "fulfilled") {
      for (const chunks of txt.value as string[][]) {
        // Preserve the whole DNS token so an underscore label cannot turn into an invented host.
        for (const match of chunks.join("").matchAll(/(?<![a-z0-9_.-])[a-z0-9_.-]+\.[a-z0-9_.-]+(?![a-z0-9_.-])/gi)) context.collector.add(match[0]);
      }
    }
    // SOA hostmaster encodes an email address, so only its nameserver is a host candidate.
    if (soa.status === "fulfilled") context.collector.add((soa.value as { nsname: string }).nsname);
  } finally {
    context.signal.removeEventListener("abort", onAbort);
    resolver.cancel();
  }
}

/** Gather observed names from one source. No guesses, wordlists or target-domain brute force. */
export async function discoverSubdomains(domainInput: string, source: SubdomainDiscoverySource, timeoutMs = 20000, dependencies = defaults, signal?: AbortSignal): Promise<SubdomainDiscoveryResult> {
  const domain = normalizeDomain(domainInput);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 20000) throw new Error("发现来源超时必须在 1000–20000 毫秒之间");
  if (signal?.aborted) return { source, status: "error", domains: [], message: "来源查询已取消" };
  const collector = new DomainCollector(domain);
  const controller = new AbortController();
  const warnings = new Set<string>();
  const context: Context = { domain, collector, signal: controller.signal, deadline: Date.now() + timeoutMs, dependencies, warnings };
  let onAbort: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const interruption = new Promise<never>((_, reject) => {
    onAbort = () => { controller.abort(); reject(new SourceFailure("来源查询已取消")); };
    timer = setTimeout(() => { controller.abort(); reject(new SourceFailure("来源查询超时")); }, timeoutMs);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const operation = source === "crtsh" ? discoverCrtsh(context) : source === "certspotter" ? discoverCertspotter(context) : source === "hackertarget" ? discoverHackerTarget(context)
      : source === "wayback" ? discoverWayback(context) : source === "website" ? discoverWebsite(context) : source === "dns" ? discoverDnsMetadata(context) : Promise.reject(new SourceFailure("不支持的发现来源"));
    await Promise.race([operation, interruption]);
    if (collector.capped) warnings.add("达到每个来源 5000 个域名上限，结果可能不完整");
    return { source, status: warnings.size ? "partial" : "success", domains: [...collector.domains].sort(), ...(warnings.size ? { message: [...warnings].join("；") } : {}) };
  } catch (error) {
    const message = error instanceof SourceFailure ? error.message : controller.signal.aborted ? "来源查询超时或已取消" : "来源查询失败，请稍后重试";
    return { source, status: collector.domains.size ? "partial" : "error", domains: [...collector.domains].sort(), message };
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    controller.abort();
  }
}
