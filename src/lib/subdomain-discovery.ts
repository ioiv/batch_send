import { formatScanCsv, normalizeDomain, requestNetworkScan, scanSubdomains, type SubdomainScanResult } from "./network-scan";

export type SubdomainDiscoverySource = "crtsh" | "certspotter" | "hackertarget" | "dns" | "website" | "wayback";

export const SUBDOMAIN_DISCOVERY_SOURCES: { id: SubdomainDiscoverySource; label: string }[] = [
  { id: "crtsh", label: "crt.sh · 证书记录" },
  { id: "certspotter", label: "Cert Spotter · 证书记录" },
  { id: "hackertarget", label: "HackerTarget · 被动 DNS" },
  { id: "dns", label: "域名 DNS 记录" },
  { id: "website", label: "网站公开链接" },
  { id: "wayback", label: "Wayback · 历史网页" }
];

export const MAX_DISCOVERED_SUBDOMAINS = 5000;

export interface SubdomainDiscoverySourceResult {
  source: SubdomainDiscoverySource;
  status: "success" | "partial" | "error";
  domains: string[];
  message?: string;
}

export interface DiscoveredSubdomainResult extends SubdomainScanResult {
  sources: SubdomainDiscoverySource[];
}

export interface SubdomainDiscoveryProgress {
  phase: "discovering" | "validating";
  completed: number;
  total: number;
  discovered: number;
}

export interface SubdomainDiscoverySummary {
  discovered: number;
  validated: number;
  truncated: boolean;
  sources: SubdomainDiscoverySourceResult[];
}

interface DiscoveryOptions {
  domain: string;
  concurrency: number;
  timeoutMs: number;
  signal: AbortSignal;
  onSource: (result: SubdomainDiscoverySourceResult) => void;
  onResult: (result: DiscoveredSubdomainResult) => void;
  onProgress?: (progress: SubdomainDiscoveryProgress) => void;
}

async function discoverFromSource(root: string, source: SubdomainDiscoverySource, signal: AbortSignal): Promise<SubdomainDiscoverySourceResult> {
  try {
    const result = await requestNetworkScan<SubdomainDiscoverySourceResult>({
      kind: "subdomain-discovery", domain: root, source, timeoutMs: 20_000
    }, signal);
    if (result.source !== source || !["success", "partial", "error"].includes(result.status)
      || !Array.isArray(result.domains) || result.domains.length > MAX_DISCOVERED_SUBDOMAINS
      || (result.message !== undefined && typeof result.message !== "string")) throw new Error("来源返回的数据格式无效。");
    if (result.domains.some(candidate => typeof candidate !== "string" || /[:/\\?#@\s]/.test(candidate)
      || normalizeDomain(candidate) !== candidate || !candidate.endsWith(`.${root}`))) throw new Error("来源返回了范围外的域名。");
    if (result.status === "error" && result.domains.length) throw new Error("来源返回的数据状态不一致。");
    return { ...result, domains: [...new Set(result.domains)] };
  } catch (error) {
    signal.throwIfAborted();
    return { source, status: "error", domains: [], message: error instanceof Error ? error.message : "来源请求失败。" };
  }
}

/** Discover actual published names, merge their provenance, then verify current DNS. */
export async function discoverSubdomains(options: DiscoveryOptions): Promise<SubdomainDiscoverySummary> {
  const root = normalizeDomain(options.domain);
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 8) throw new Error("并发数必须是 1–8 的整数。");
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 10_000) throw new Error("DNS 超时必须在 1–10 秒之间。");
  options.signal.throwIfAborted();
  const sources: SubdomainDiscoverySourceResult[] = [];
  const candidates = new Map<string, Set<SubdomainDiscoverySource>>();
  let truncated = false;
  let nextSource = 0;
  let validated = 0;
  const emitted = new Map<string, DiscoveredSubdomainResult>();
  options.onProgress?.({ phase: "discovering", completed: 0, total: SUBDOMAIN_DISCOVERY_SOURCES.length, discovered: 0 });
  // Provider queries have separate quotas; limit parallel discovery independently of DNS workers.
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (!options.signal.aborted && nextSource < SUBDOMAIN_DISCOVERY_SOURCES.length) {
      const source = SUBDOMAIN_DISCOVERY_SOURCES[nextSource++].id;
      const result = await discoverFromSource(root, source, options.signal);
      options.signal.throwIfAborted();
      for (const domain of result.domains) {
        if (!candidates.has(domain)) {
          if (candidates.size === MAX_DISCOVERED_SUBDOMAINS) { truncated = true; continue; }
          candidates.set(domain, new Set());
        }
        candidates.get(domain)!.add(source);
      }
      sources.push(result);
      options.onSource(result);
      options.onProgress?.({ phase: "discovering", completed: sources.length, total: SUBDOMAIN_DISCOVERY_SOURCES.length, discovered: candidates.size });
    }
  }));
  options.signal.throwIfAborted();
  if (sources.every(source => source.status === "error")) throw new Error("所有发现来源均不可用，请查看来源详情后重试。");
  const domains = [...candidates.keys()].sort();
  options.onProgress?.({ phase: "validating", completed: 0, total: domains.length, discovered: domains.length });
  // The bounded DNS executor accepts 500 per batch; discovery can contain up to 5,000 names.
  for (let offset = 0; offset < domains.length;) {
    options.signal.throwIfAborted();
    const batch = domains.slice(offset, offset + 500);
    offset += batch.length;
    await scanSubdomains({
      domain: root, candidates: batch, concurrency: options.concurrency,
      timeoutMs: options.timeoutMs, signal: options.signal,
      onResult: result => {
        options.signal.throwIfAborted();
        if (result.cname && !/[:/\\?#@\s]/.test(result.cname)) {
          let cname: string | undefined;
          try { cname = normalizeDomain(result.cname); } catch { /* Only real scoped DNS names can expand discovery. */ }
          if (cname?.endsWith(`.${root}`) && cname !== result.domain) {
            let includeCname = candidates.has(cname);
            if (!candidates.has(cname)) {
              if (candidates.size < MAX_DISCOVERED_SUBDOMAINS) {
                candidates.set(cname, new Set(["dns"]));
                domains.push(cname);
                includeCname = true;
              } else truncated = true;
            } else candidates.get(cname)!.add("dns");
            if (includeCname) {
              const sourceIndex = sources.findIndex(source => source.source === "dns");
              const dnsSource = sources[sourceIndex];
              if (!dnsSource.domains.includes(cname)) {
                const updated: SubdomainDiscoverySourceResult = { ...dnsSource, domains: [...dnsSource.domains, cname],
                  ...(dnsSource.status === "error" ? { status: "partial", message: "根域名 DNS 元数据未完成；已通过子域名 CNAME 获取部分线索。" } : {}) };
                sources[sourceIndex] = updated;
                options.onSource(updated);
              }
              const existing = emitted.get(cname);
              if (existing && !existing.sources.includes("dns")) {
                const updated = { ...existing, sources: SUBDOMAIN_DISCOVERY_SOURCES.filter(source => candidates.get(cname)!.has(source.id)).map(source => source.id) };
                emitted.set(cname, updated);
                options.onResult(updated);
              }
            }
          }
        }
        const discovered = { ...result, sources: SUBDOMAIN_DISCOVERY_SOURCES.filter(source => candidates.get(result.domain)!.has(source.id)).map(source => source.id) };
        emitted.set(result.domain, discovered);
        options.onResult(discovered);
        options.onProgress?.({ phase: "validating", completed: ++validated, total: domains.length, discovered: domains.length });
      }
    });
  }
  return { discovered: domains.length, validated, truncated,
    sources: SUBDOMAIN_DISCOVERY_SOURCES.map(source => sources.find(result => result.source === source.id)!) };
}

export function exportDiscoveredSubdomainsCsv(results: DiscoveredSubdomainResult[]) {
  return formatScanCsv(["domain", "discovery_sources", "dns_status", "addresses", "cname", "possible_wildcard", "message"],
    results.map(result => [result.domain, result.sources.join("; "), result.status, result.addresses.join("; "), result.cname, Boolean(result.wildcard), result.message]));
}
