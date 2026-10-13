import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { fetchPublicDocument, normalizeDomain, scanSubdomain, type PublicDocumentOptions, type PublicDocumentResult, type SubdomainScanResult } from "./network-scan.js";
import { SubdomainSourceCache } from "./subdomain-source-cache.js";
import { discoverPentestTools, PENTEST_TOOLS_TIMEOUT_MS } from "./pentest-tools-discovery.js";

export type SubdomainDiscoverySource = "subdomaincenter" | "certspotter" | "hackertarget" | "common" | "pentesttools" | "certkit";
export interface SubdomainDiscoveryResult {
  source: SubdomainDiscoverySource;
  status: "success" | "partial" | "error";
  domains: string[];
  message?: string;
}

export interface SubdomainDiscoveryDependencies {
  fetchDocument(url: string, options: PublicDocumentOptions): Promise<PublicDocumentResult>;
  scanDomain?(domain: string, timeoutMs: number, signal: AbortSignal): Promise<SubdomainScanResult>;
}

export interface SubdomainDiscoveryOptions {
  /** Server-only credential; never accepted from a scan request or returned to the browser. */
  sslmateApiKey?: string;
}

const defaults: SubdomainDiscoveryDependencies = {
  fetchDocument: fetchPublicDocument,
  scanDomain: (domain, timeoutMs, signal) => scanSubdomain(domain, timeoutMs, undefined, signal)
};
export const MAX_DISCOVERY_DOMAINS = 5000;
export const MAX_DISCOVERY_BYTES = 4 * 1024 * 1024;
const MAX_PAGES = 8;
const MAX_FREE_HOSTSEARCH_RECORDS = 50;
const MAX_FREE_CERTKIT_CERTIFICATES = 100;
const sourceCache = new SubdomainSourceCache<SubdomainDiscoveryResult>();
export const COMMON_SUBDOMAIN_LABELS = [
  "www", "app", "api", "docs", "game", "play", "mint", "status", "dashboard", "portal", "auth", "login",
  "account", "web", "static", "assets", "cdn", "media", "images", "blog", "news", "help", "support", "mail",
  "shop", "store", "market", "explorer", "rpc", "dev", "test", "staging"
] as const;

class SourceFailure extends Error {}

class DomainCollector {
  readonly domains = new Set<string>();
  readonly wildcardPatterns = new Set<string>();
  capped = false;
  constructor(readonly root: string) {}
  add(input: unknown): void {
    if (typeof input !== "string") return;
    if (input.includes("*")) {
      if (!input.trim().startsWith("*.")) return;
      try {
        const wildcardRoot = normalizeDomain(input.trim().slice(2));
        if (wildcardRoot === this.root || wildcardRoot.endsWith(`.${this.root}`)) this.wildcardPatterns.add(`*.${wildcardRoot}`);
      } catch { /* A wildcard pattern is evidence, never a hostname to probe. */ }
      return;
    }
    let hostname: string;
    try { hostname = normalizeDomain(input.trim()); } catch { return; }
    if (hostname === this.root || !hostname.endsWith(`.${this.root}`) || this.domains.has(hostname)) return;
    if (this.domains.size >= MAX_DISCOVERY_DOMAINS) { this.capped = true; return; }
    this.domains.add(hostname);
    if (this.domains.size === MAX_DISCOVERY_DOMAINS) this.capped = true;
  }
}

interface Context {
  domain: string;
  collector: DomainCollector;
  signal: AbortSignal;
  deadline: number;
  dependencies: SubdomainDiscoveryDependencies;
  warnings: Set<string>;
  notes: Set<string>;
  sslmateApiKey?: string;
  certspotterAuthenticated?: boolean;
}

async function readDocument(context: Context, url: URL | string, maxBytes = MAX_DISCOVERY_BYTES, headers?: Readonly<Record<string, string>>, body?: string): Promise<PublicDocumentResult> {
  const remaining = context.deadline - Date.now();
  if (remaining <= 0 || context.signal.aborted) throw new SourceFailure("来源查询超时或已取消");
  const response = await context.dependencies.fetchDocument(url.toString(), { timeoutMs: remaining, maxBytes, signal: context.signal, ...(headers ? { headers } : {}), ...(body !== undefined ? { method: "POST", body } : {}) });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    if (new URL(url).hostname === "api.certspotter.com") {
      let code: unknown;
      try { code = record(JSON.parse(response.body.toString("utf8")))?.code; } catch { /* Only known error codes are safe to expose. */ }
      if (code === "disabled_credentials") throw new SourceFailure("SSLMate Key 已停用，请在账户中启用或更换");
      if (code === "bad_credentials" || response.statusCode === 401) throw new SourceFailure("SSLMate Key 无效，请检查服务端配置");
      if (code === "unauthorized") throw new SourceFailure("SSLMate Key 没有 CT Search 权限，请检查 Key 的 Usage");
      if (code === "not_allowed_by_plan" || response.statusCode === 403) throw new SourceFailure("SSLMate 账户或 Key 无权进行此查询，请检查 CT Search 权限与套餐");
      if (code === "payment_required" || response.statusCode === 402) throw new SourceFailure("SSLMate CT Search 订阅不可用，请检查账户状态");
      if (code === "rate_limited" || response.statusCode === 429) throw new SourceFailure("SSLMate 查询限流：配额或速率已达上限，请稍后重试");
      if (code === "timeout") throw new SourceFailure("SSLMate 查询超过套餐时限，已保留此前结果");
    }
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

async function discoverIndexedNames(context: Context): Promise<void> {
  const url = new URL("https://api.subdomain.center/");
  url.searchParams.set("domain", context.domain);
  const response = await readDocument(context, url);
  if (response.truncated) {
    // Recover only complete JSON strings from the bounded array sample.
    for (const match of response.body.toString("utf8").matchAll(/"(?:\\.|[^"\\])*"/g)) {
      try { context.collector.add(JSON.parse(match[0])); } catch { /* Ignore incomplete entries. */ }
    }
    return;
  }
  const names = parseJson(response);
  if (!Array.isArray(names) || names.some(name => typeof name !== "string")) throw new SourceFailure("Subdomain Center 返回的数据格式无效");
  names.forEach(name => context.collector.add(name));
  context.notes.add("使用免费匿名查询，最多返回 500 个随机样本");
  if (names.length >= 500) context.warnings.add("Subdomain Center 达到免费抽样上限，结果可能不完整");
  if (!names.length) context.notes.add("免费数据库暂无此域名的收录");
}

async function discoverCertspotter(context: Context): Promise<void> {
  const key = context.sslmateApiKey?.trim();
  if (key && (key.length > 2048 || !/^[A-Za-z0-9._~+\/-]+=*$/.test(key))) throw new SourceFailure("SSLMate Key 格式无效，请检查服务端配置");
  const headers = key ? { Authorization: `Bearer ${key}` } : undefined;
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL("https://api.certspotter.com/v1/issuances");
    url.searchParams.set("domain", context.domain);
    url.searchParams.set("include_subdomains", "true");
    url.searchParams.set("expand", "dns_names");
    if (cursor) url.searchParams.set("after", cursor);
    // Credentials are sent only to this fixed HTTPS endpoint, including subsequent pages.
    const response = await readDocument(context, url, MAX_DISCOVERY_BYTES, headers);
    if (key) context.certspotterAuthenticated = true;
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

async function discoverCertkit(context: Context): Promise<void> {
  // The public tool queries this endpoint directly, without a session or API key.
  // Keep the request within its advertised free 100-certificate limit.
  const response = await readDocument(context, "https://ct.certkit.io/search", MAX_DISCOVERY_BYTES,
    { Accept: "application/json", "Content-Type": "application/json" },
    JSON.stringify({ domain: context.domain, limit: MAX_FREE_CERTKIT_CERTIFICATES, sort: "" }));
  context.notes.add("使用免费免登录 CT 查询，最多返回 100 张证书，包含历史记录");
  if (response.truncated) {
    const text = response.body.toString("utf8");
    for (const match of text.matchAll(/"commonName"\s*:\s*("(?:\\.|[^"\\])*")/g)) {
      try { context.collector.add(JSON.parse(match[1])); } catch { /* Ignore an incomplete field. */ }
    }
    for (const match of text.matchAll(/"dnsNames"\s*:\s*(\[(?:\s*"(?:\\.|[^"\\])*"\s*,?)*\s*\])/g)) {
      try { for (const name of JSON.parse(match[1]) as unknown[]) context.collector.add(name); } catch { /* Ignore an incomplete array. */ }
    }
    return;
  }
  const data = record(parseJson(response));
  const rows = data?.results;
  const totalCount = data?.totalCount;
  if (!Array.isArray(rows) || typeof totalCount !== "number" || !Number.isSafeInteger(totalCount)
    || totalCount < rows.length || totalCount < 0) throw new SourceFailure("CertKit 返回的数据格式无效");
  let malformed = 0;
  for (const value of rows) {
    const row = record(value);
    if (!row || !Array.isArray(row.dnsNames) || row.dnsNames.some(name => typeof name !== "string")
      || row.commonName !== undefined && row.commonName !== null && typeof row.commonName !== "string") {
      malformed++;
      continue;
    }
    context.collector.add(row.commonName);
    row.dnsNames.forEach(name => context.collector.add(name));
  }
  if (malformed && malformed === rows.length) throw new SourceFailure("CertKit 返回的数据格式无效");
  if (malformed) context.warnings.add("CertKit 部分证书记录格式无效，已保留有效名称");
  if (totalCount > rows.length) context.warnings.add(`CertKit 共收录 ${totalCount} 张证书，免费查询仅返回 ${rows.length} 张（最多 100 张），结果可能不完整`);
  if (!rows.length && !totalCount) context.notes.add("CT 记录暂无此域名的收录");
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
  if (lines.length >= MAX_FREE_HOSTSEARCH_RECORDS) context.warnings.add("HackerTarget 达到免费来源记录上限，结果可能不完整");
}

function sameDnsAnswer(candidate: SubdomainScanResult, control: SubdomainScanResult): boolean {
  if (candidate.cname && control.cname) return candidate.cname.toLowerCase() === control.cname.toLowerCase();
  return Boolean(candidate.addresses.length && candidate.addresses.some(address => control.addresses.includes(address)));
}

async function discoverCommonNames(context: Context): Promise<void> {
  const scan = context.dependencies.scanDomain ?? defaults.scanDomain!;
  const query = async (hostname: string) => {
    const remaining = context.deadline - Date.now();
    if (remaining <= 0 || context.signal.aborted) throw new SourceFailure("常用名称 DNS 查询超时或已取消");
    // The shared DNS probe accepts at least one second; the source-wide signal still
    // ends every in-flight probe at this source's tighter deadline.
    const result = await scan(hostname, Math.max(1000, Math.min(2000, remaining)), context.signal);
    if (context.signal.aborted) throw new SourceFailure("常用名称 DNS 查询已取消");
    return result;
  };
  // Two independent controls avoid counting catch-all DNS responses as published names.
  const controls = await Promise.all(Array.from({ length: 2 }, () => query(`chainkit-check-${randomUUID().replaceAll("-", "")}.${context.domain}`)));
  if (controls.some(control => control.status === "error")) throw new SourceFailure("通配 DNS 校验未完成，未把常用名称计入发现");
  const resolvingControls = controls.filter(control => control.status === "resolved");
  const stableControls = controls[0].cname || controls[1].cname
    ? Boolean(controls[0].cname && controls[0].cname === controls[1].cname)
    : Boolean(controls[0].addresses.length && JSON.stringify([...controls[0].addresses].sort()) === JSON.stringify([...controls[1].addresses].sort()));
  if (resolvingControls.length && (resolvingControls.length !== 2 || !stableControls)) {
    context.warnings.add("随机名称的 DNS 响应不稳定，未把常用名称计入发现，以免通配解析产生误报");
    return;
  }
  let next = 0;
  let failed = 0;
  let wildcardMatches = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (!context.signal.aborted && next < COMMON_SUBDOMAIN_LABELS.length) {
      const label = COMMON_SUBDOMAIN_LABELS[next++];
      const hostname = `${label}.${context.domain}`;
      const result = await query(hostname);
      if (result.status === "error") { failed += 1; continue; }
      if (result.status !== "resolved") continue;
      if (resolvingControls.some(control => sameDnsAnswer(result, control))) { wildcardMatches += 1; continue; }
      // An unstable wildcard may use rotating answers. Without distinct CNAME evidence,
      // an address-only guess cannot establish that a real named record exists.
      if (resolvingControls.length && !result.cname) { wildcardMatches += 1; continue; }
      context.collector.add(hostname);
    }
  }));
  if (failed) context.warnings.add(`${failed} 个常用名称 DNS 查询失败，已保留成功结果`);
  if (wildcardMatches) context.warnings.add(`${wildcardMatches} 个名称可能来自通配 DNS，未计入发现`);
}

/** Combine published evidence, remote Light scans and fixed common-name DNS checks. */
export async function discoverSubdomains(domainInput: string, source: SubdomainDiscoverySource, timeoutMs = source === "pentesttools" ? PENTEST_TOOLS_TIMEOUT_MS : 20000, dependencies = defaults, signal?: AbortSignal, options: SubdomainDiscoveryOptions = { sslmateApiKey: process.env.SSLMATE_API_KEY }): Promise<SubdomainDiscoveryResult> {
  const domain = normalizeDomain(domainInput);
  const maxTimeoutMs = source === "pentesttools" ? PENTEST_TOOLS_TIMEOUT_MS : 20000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > maxTimeoutMs) throw new Error(`发现来源超时必须在 1000–${maxTimeoutMs} 毫秒之间`);
  if (signal?.aborted) return { source, status: "error", domains: [], message: "来源查询已取消" };
  const cachedSource = dependencies === defaults && ["subdomaincenter", "certspotter", "hackertarget", "pentesttools", "certkit"].includes(source);
  // Different credentials must never share authenticated data or cached permission failures.
  const cacheKey = cachedSource ? `${source}:${domain}:${source === "certspotter" ? createHash("sha256").update(options.sslmateApiKey ?? "").digest("hex") : "anonymous"}` : undefined;
  if (cacheKey) {
    const cached = sourceCache.read(cacheKey);
    if (cached) return cached;
  }
  const completedResult = (result: SubdomainDiscoveryResult) => {
    // A disconnected caller must not turn cancellation into a cached provider outage.
    if (cacheKey && !signal?.aborted && !controller.signal.aborted) sourceCache.write(cacheKey, result);
    return result;
  };
  const collector = new DomainCollector(domain);
  const controller = new AbortController();
  const warnings = new Set<string>();
  const context: Context = { domain, collector, signal: controller.signal, deadline: Date.now() + timeoutMs, dependencies, warnings, notes: new Set(), sslmateApiKey: options.sslmateApiKey };
  let onAbort: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const interruption = new Promise<never>((_, reject) => {
    onAbort = () => { controller.abort(); reject(new SourceFailure("来源查询已取消")); };
    timer = setTimeout(() => { controller.abort(); reject(new SourceFailure("来源查询超时")); }, timeoutMs);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const operation = source === "pentesttools" ? (async () => {
      const result = await discoverPentestTools({ domain, timeoutMs, signal: controller.signal, fetchDocument: dependencies.fetchDocument }, dependencies === defaults);
      result.domains.forEach(name => collector.add(name));
      if (result.status === "error") throw new SourceFailure(result.message || "Pentest-Tools 来源查询失败");
      if (result.status === "partial") warnings.add(result.message || "Pentest-Tools 仅返回部分结果");
      else if (result.message) context.notes.add(result.message);
    })() : source === "subdomaincenter" ? discoverIndexedNames(context) : source === "certspotter" ? discoverCertspotter(context) : source === "certkit" ? discoverCertkit(context) : source === "hackertarget" ? discoverHackerTarget(context)
      : source === "common" ? discoverCommonNames(context) : Promise.reject(new SourceFailure("不支持的发现来源"));
    await Promise.race([operation, interruption]);
    if (collector.wildcardPatterns.size) warnings.add(source === "certspotter" || source === "certkit"
      ? collector.domains.size ? "证书包含通配名称，具体子域名仍需其他来源或 DNS 验证补充" : "证书仅公开通配名称，无法从证书列出具体子域名"
      : "来源包含通配名称，无法据此列出具体子域名");
    if (collector.capped) warnings.add("达到每个来源 5000 个域名上限，结果可能不完整");
    const messages = [...(context.certspotterAuthenticated ? ["已通过 SSLMate 认证查询"] : []), ...context.notes, ...warnings];
    return completedResult({ source, status: warnings.size ? "partial" : "success", domains: [...collector.domains].sort(), ...(messages.length ? { message: messages.join("；") } : {}) });
  } catch (error) {
    const message = error instanceof SourceFailure ? error.message : controller.signal.aborted ? "来源查询超时或已取消" : "来源查询失败，请稍后重试";
    return completedResult({ source, status: collector.domains.size ? "partial" : "error", domains: [...collector.domains].sort(), message });
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    controller.abort();
  }
}
