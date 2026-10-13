import { createSubdomainValidator, formatScanCsv, normalizeDomain, requestNetworkScan, type SubdomainScanResult } from "./network-scan";
import { createStreamingScanQueue } from "./streaming-scan-queue";

export type AutomaticSubdomainDiscoverySource = "subdomaincenter" | "certspotter" | "hackertarget" | "common" | "pentesttools" | "certkit";
export type SubdomainDiscoverySource = AutomaticSubdomainDiscoverySource | "manual" | "cname";

export const SUBDOMAIN_DISCOVERY_SOURCES: { id: AutomaticSubdomainDiscoverySource; label: string }[] = [
  { id: "common", label: "常用名称 · DNS 补充" },
  { id: "subdomaincenter", label: "Subdomain Center · 免费数据库" },
  { id: "certspotter", label: "SSLMate / Cert Spotter · 证书记录" },
  { id: "hackertarget", label: "HackerTarget · 被动 DNS" },
  { id: "pentesttools", label: "Pentest-Tools · 子域名扫描" },
  { id: "certkit", label: "CertKit · CT 证书记录" }
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
  discoveryCompleted?: number;
  discoveryTotal?: number;
}

export interface SubdomainDiscoverySummary {
  discovered: number;
  validated: number;
  truncated: boolean;
  sources: SubdomainDiscoverySourceResult[];
}

interface DiscoveryOptions {
  domain: string;
  additionalDomains?: readonly string[];
  concurrency: number;
  timeoutMs: number;
  signal: AbortSignal;
  onSource: (result: SubdomainDiscoverySourceResult) => void;
  onResult: (result: DiscoveredSubdomainResult) => void;
  onProgress?: (progress: SubdomainDiscoveryProgress) => void;
}

async function discoverFromSource(root: string, source: AutomaticSubdomainDiscoverySource, signal: AbortSignal): Promise<SubdomainDiscoverySourceResult> {
  try {
    const result = await requestNetworkScan<SubdomainDiscoverySourceResult>({
      kind: "subdomain-discovery", domain: root, source, timeoutMs: source === "pentesttools" ? 120_000 : 20_000
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

/** Verify names as each source returns, retaining provenance from later sources. */
export async function discoverSubdomains(options: DiscoveryOptions): Promise<SubdomainDiscoverySummary> {
  const root = normalizeDomain(options.domain);
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 8) throw new Error("并发数必须是 1–8 的整数。");
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 10_000) throw new Error("DNS 超时必须在 1–10 秒之间。");
  options.signal.throwIfAborted();
  const supplement = options.additionalDomains ?? [];
  if (!Array.isArray(supplement) || supplement.length > MAX_DISCOVERED_SUBDOMAINS) throw new Error("补充名单最多包含 5,000 个子域名。");
  const additionalDomains = [...new Set(supplement.map(candidate => {
    if (typeof candidate !== "string" || /[:/\\?#@\s*]/.test(candidate)) throw new Error("补充名单只能包含当前主域名内的具体子域名。");
    const normalized = normalizeDomain(candidate);
    if (!normalized.endsWith(`.${root}`)) throw new Error("补充名单包含当前主域名之外的名称。");
    return normalized;
  }))];
  const discoverySourceOrder: SubdomainDiscoverySource[] = [...SUBDOMAIN_DISCOVERY_SOURCES.map(source => source.id), ...(additionalDomains.length ? ["manual" as const] : [])];
  // CNAME observations retain provenance without adding another discovery provider.
  const sourceOrder: SubdomainDiscoverySource[] = [...discoverySourceOrder, "cname"];
  const controller = new AbortController();
  const stop = () => controller.abort(options.signal.reason);
  options.signal.addEventListener("abort", stop, { once: true });
  const signal = controller.signal;
  const sources = new Map<SubdomainDiscoverySource, SubdomainDiscoverySourceResult>();
  const candidates = new Map<string, Set<SubdomainDiscoverySource>>();
  let truncated = false;
  let nextSource = 0;
  let validated = 0;
  let discoveryFinished = false;
  const emitted = new Map<string, DiscoveredSubdomainResult>();
  const provenance = (domain: string) => sourceOrder.filter(source => candidates.get(domain)!.has(source));
  const progress = () => {
    signal.throwIfAborted();
    options.onProgress?.({ phase: discoveryFinished ? "validating" : "discovering", completed: validated,
      total: candidates.size, discovered: candidates.size, discoveryCompleted: sources.size,
      discoveryTotal: discoverySourceOrder.length });
  };
  const addCandidate = (domain: string, source: SubdomainDiscoverySource) => {
    signal.throwIfAborted();
    const existingSources = candidates.get(domain);
    if (existingSources) {
      if (existingSources.has(source)) return true;
      existingSources.add(source);
      const existing = emitted.get(domain);
      if (existing) {
        const updated = { ...existing, sources: provenance(domain) };
        emitted.set(domain, updated);
        options.onResult(updated);
      }
      return true;
    }
    if (candidates.size === MAX_DISCOVERED_SUBDOMAINS) { truncated = true; return false; }
    candidates.set(domain, new Set([source]));
    queue.add(domain);
    return true;
  };
  let validator: ReturnType<typeof createSubdomainValidator> | undefined;
  const queue = createStreamingScanQueue<SubdomainScanResult>({
    concurrency: Math.min(options.concurrency, 5), signal,
    scan: async (candidate, requestSignal) => {
      try {
        validator ??= createSubdomainValidator({ domain: root, timeoutMs: options.timeoutMs, signal: requestSignal });
        return await (await validator)(candidate, requestSignal);
      } catch (error) { controller.abort(error); throw error; }
    },
    onResult: result => {
      try {
        signal.throwIfAborted();
        if (result.cname && !/[:/\\?#@\s]/.test(result.cname)) {
          let cname: string | undefined;
          try { cname = normalizeDomain(result.cname); } catch { /* Only real scoped DNS names can expand discovery. */ }
          if (cname?.endsWith(`.${root}`) && cname !== result.domain) addCandidate(cname, "cname");
        }
        const discovered = { ...result, sources: provenance(result.domain) };
        emitted.set(result.domain, discovered);
        validated += 1;
        options.onResult(discovered);
        progress();
      } catch (error) { controller.abort(error); throw error; }
    }
  });
  try {
    progress();
    if (additionalDomains.length) {
      const supplementalSource: SubdomainDiscoverySourceResult = { source: "manual", status: "success", domains: additionalDomains };
      for (const domain of additionalDomains) addCandidate(domain, "manual");
      sources.set("manual", supplementalSource);
      options.onSource(supplementalSource);
      progress();
    }
    // Three provider requests and at most five DNS requests share the API while discovering.
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (!signal.aborted && nextSource < SUBDOMAIN_DISCOVERY_SOURCES.length) {
        const source = SUBDOMAIN_DISCOVERY_SOURCES[nextSource++].id;
        const result = await discoverFromSource(root, source, signal);
        signal.throwIfAborted();
        for (const domain of result.domains) addCandidate(domain, source);
        sources.set(source, result);
        options.onSource(result);
        progress();
      }
    }));
    signal.throwIfAborted();
    if ([...sources.values()].every(source => source.status === "error")) throw new Error("所有发现来源均不可用，请查看来源详情后重试。");
    discoveryFinished = true;
    queue.setConcurrency(options.concurrency);
    progress();
    await queue.done();
    signal.throwIfAborted();
    return { discovered: candidates.size, validated, truncated,
      sources: discoverySourceOrder.map(source => sources.get(source)!) };
  } catch (error) {
    controller.abort(error);
    await queue.cancel();
    throw error;
  } finally {
    options.signal.removeEventListener("abort", stop);
  }
}

export function exportDiscoveredSubdomainsCsv(results: DiscoveredSubdomainResult[]) {
  return formatScanCsv(["domain", "discovery_sources", "dns_status", "addresses", "cname", "possible_wildcard", "message"],
    results.map(result => [result.domain, result.sources.join("; "), result.status, result.addresses.join("; "), result.cname, Boolean(result.wildcard), result.message]));
}
