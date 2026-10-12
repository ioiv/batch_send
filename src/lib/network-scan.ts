export const MAX_SCAN_CANDIDATES = 500;

export interface SubdomainScanResult {
  domain: string;
  status: "resolved" | "not-found" | "error";
  addresses: string[];
  cname?: string;
  message?: string;
  wildcard?: boolean;
}

export interface WebsitePathScanResult {
  url: string;
  status: "responded" | "error";
  statusCode?: number;
  title?: string;
  contentLength?: number;
  location?: string;
  fingerprint?: string;
  message?: string;
  soft404?: boolean;
}

function domainFromHostname(hostname: string) {
  const domain = hostname.toLowerCase().replace(/\.$/, "");
  if (domain.length > 253 || !domain.includes(".") || /^\d+(\.\d+){3}$/.test(domain)
    || domain.split(".").some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    || /^\d+$/.test(domain.split(".").at(-1)!)) {
    throw new Error("请输入有效的域名，例如 example.com。");
  }
  return domain;
}

function extractNetworkUrl(input: string): URL {
  let value = input.trim();
  if (!value || value.length > 65_536 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new Error("请输入有效的网址或域名。");
  for (const [open, close] of [['"', '"'], ["'", "'"], ["`", "`"], ["“", "”"], ["‘", "’"], ["「", "」"], ["『", "』"], ["<", ">"], ["(", ")"]]) {
    if (value.startsWith(open) && value.endsWith(close)) value = value.slice(open.length, -close.length).trim();
  }
  const explicitMatch = value.match(/(?:[a-z][a-z0-9+.-]*:\/\/|\/\/)[^\s<>"'`，；！？【】「」『』“”‘’]+/iu);
  const scheme = value.match(/^([a-z][a-z0-9+.-]*):/i)?.[1];
  const hostPort = /^[^:/?#\s]+:\d+(?:[/?#]|$)/.test(value);
  if (scheme && !hostPort && (!/^https?$/i.test(scheme) || !/^https?:\/\//i.test(value))
    && (!explicitMatch || explicitMatch.index === 0)) throw new Error("请输入 HTTP / HTTPS 网址或域名。");
  const explicit = explicitMatch?.[0];
  const bare = !explicit ? value.match(/(?:^|[\s：:([{<，；“"'`])((?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?)(?:[.\u3002\uff0e\uff61][\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?)+(?::\d+)?(?:[/?#][^\s<>"'`，；！？【】「」『』“”‘’]*)?)(?=$|[\s<>"'`，。；！？、)\]}])/iu)?.[1] : undefined;
  let candidate = explicit ?? bare ?? value;
  const quotedEnd = explicitMatch && /["'`”’」』]/u.test(value[explicitMatch.index! + explicitMatch[0].length] ?? "");
  if (candidate !== value && !quotedEnd) candidate = candidate.replace(/[，。；！？、,;!.]+$/u, "");
  // Closing prose/Markdown brackets are trimmed only when they are not balanced inside the URL.
  if (candidate !== value) {
    for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
      while (candidate.endsWith(close) && candidate.split(close).length > candidate.split(open).length) candidate = candidate.slice(0, -1);
    }
  }
  if (!candidate || candidate.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(candidate)) throw new Error("请输入有效的网址或域名。");
  const uri = candidate.startsWith("//") ? `https:${candidate}` : candidate.includes("://") ? candidate : `https://${candidate}`;
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(uri)) throw new Error("网址不能包含账号信息。");
  let url: URL;
  try { url = new URL(uri); } catch { throw new Error("请输入有效的网址或域名。"); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("请输入 HTTP / HTTPS 网址或域名。");
  url.hostname = url.hostname.replace(/\.$/, "");
  return url;
}

export function normalizeDomain(input: string): string {
  return domainFromHostname(extractNetworkUrl(input).hostname);
}

export function normalizeWebsiteUrl(input: string): string {
  const url = extractNetworkUrl(input);
  if (url.port) throw new Error("网站地址仅支持 HTTP / HTTPS 默认端口。");
  if (!/^\d+(?:\.\d+){3}$/.test(url.hostname) && !url.hostname.startsWith("[")) domainFromHostname(url.hostname);
  url.search = "";
  url.hash = "";
  return url.href;
}

interface ScanOptions<T> {
  candidates: string[];
  concurrency: number;
  timeoutMs: number;
  signal: AbortSignal;
  onResult: (result: T) => void;
  onProgress?: (completed: number, total: number) => void;
}

function validateOptions<T>(options: ScanOptions<T>) {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 8) {
    throw new Error("并发数必须是 1–8 的整数。");
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 10_000) {
    throw new Error("超时时间必须在 1–10 秒之间。");
  }
  if (!options.candidates.length || options.candidates.length > MAX_SCAN_CANDIDATES) {
    throw new Error(`每轮需要 1–${MAX_SCAN_CANDIDATES} 个扫描条目。`);
  }
  if (new Set(options.candidates).size !== options.candidates.length) throw new Error("扫描条目重复，请先去重。");
  options.signal.throwIfAborted();
}

class ScanRequestTimeout extends Error {
  constructor() { super("扫描服务响应超时"); }
}

async function readScanResponse<T>(payload: object, signal: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/api/network-scan", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload), signal, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer"
    });
  } catch {
    signal.throwIfAborted();
    throw new Error("无法连接扫描服务，请检查网络后重试。");
  }
  let data: { result?: T; error?: unknown };
  try { data = await response.json(); }
  catch { throw new Error("扫描服务不可用；请使用本地开发服务或部署包含扫描 API 的版本。"); }
  if (!response.ok) {
    throw new Error(typeof data?.error === "string" ? data.error.slice(0, 300) : "扫描服务请求失败，请稍后重试。");
  }
  if (!data || typeof data.result !== "object" || !data.result) throw new Error("扫描服务返回了无效结果。");
  return data.result;
}

export async function requestNetworkScan<T>(payload: { timeoutMs: number } & Record<string, unknown>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const controller = new AbortController();
  let cancel!: (reason: unknown) => void;
  const cancellation = new Promise<never>((_, reject) => { cancel = reject; });
  const stop = () => {
    controller.abort(signal.reason);
    cancel(signal.reason ?? new DOMException("Aborted", "AbortError"));
  };
  signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(() => {
    const error = new ScanRequestTimeout();
    controller.abort(error);
    cancel(error);
  }, payload.timeoutMs + 2000);
  try { return await Promise.race([readScanResponse<T>(payload, controller.signal), cancellation]); }
  finally { clearTimeout(timer); signal.removeEventListener("abort", stop); }
}

async function subdomainRequest(domain: string, timeoutMs: number, signal: AbortSignal) {
  let result: SubdomainScanResult;
  try { result = await requestNetworkScan<SubdomainScanResult>({ kind: "subdomain", domain, timeoutMs }, signal); }
  catch (error) {
    if (error instanceof ScanRequestTimeout) return { domain, status: "error", addresses: [], message: error.message } satisfies SubdomainScanResult;
    throw error;
  }
  if (result.domain !== domain || !["resolved", "not-found", "error"].includes(result.status)
    || !Array.isArray(result.addresses) || result.addresses.some(address => typeof address !== "string")
    || (result.cname !== undefined && typeof result.cname !== "string")) throw new Error("扫描服务返回了无效 DNS 结果。");
  return result;
}

async function pathRequest(url: string, timeoutMs: number, signal: AbortSignal) {
  let result: WebsitePathScanResult;
  try { result = await requestNetworkScan<WebsitePathScanResult>({ kind: "path", url, timeoutMs }, signal); }
  catch (error) {
    if (error instanceof ScanRequestTimeout) return { url, status: "error", message: error.message } satisfies WebsitePathScanResult;
    throw error;
  }
  if (result.url !== url || !["responded", "error"].includes(result.status)
    || (result.status === "responded" && (!Number.isInteger(result.statusCode) || result.statusCode! < 100 || result.statusCode! > 599))
    || (result.title !== undefined && typeof result.title !== "string")
    || (result.location !== undefined && typeof result.location !== "string")
    || (result.fingerprint !== undefined && typeof result.fingerprint !== "string")
    || (result.contentLength !== undefined && (!Number.isFinite(result.contentLength) || result.contentLength < 0))) {
    throw new Error("扫描服务返回了无效网站结果。");
  }
  return result;
}

async function runQueue<T>(options: ScanOptions<T>, signal: AbortSignal, scan: (candidate: string, requestSignal: AbortSignal) => Promise<T>) {
  const controller = new AbortController();
  const stop = () => controller.abort(signal.reason);
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  let index = 0;
  let completed = 0;
  let failed = false;
  let firstError: unknown;
  try { await Promise.all(Array.from({ length: Math.min(options.concurrency, options.candidates.length) }, async () => {
    while (!failed && !signal.aborted && index < options.candidates.length) {
      const candidate = options.candidates[index++];
      try {
        const result = await scan(candidate, controller.signal);
        if (failed || signal.aborted) return;
        options.onResult(result);
        options.onProgress?.(++completed, options.candidates.length);
      } catch (error) {
        if (!failed) { failed = true; firstError = error; controller.abort(); }
      }
    }
  })); } finally { signal.removeEventListener("abort", stop); }
  signal.throwIfAborted();
  if (failed) throw firstError;
}

function probeToken() {
  return `chainkit-${crypto.randomUUID().replace(/-/g, "")}`;
}

function dnsSignature(result: SubdomainScanResult) {
  if (result.status !== "resolved") return undefined;
  if (result.cname) return `cname:${result.cname.toLowerCase().replace(/\.$/, "")}`;
  return result.addresses.length ? [...new Set(result.addresses)].sort().join(",") : undefined;
}

export async function scanSubdomains(options: ScanOptions<SubdomainScanResult> & { domain: string }): Promise<void> {
  validateOptions(options);
  const root = normalizeDomain(options.domain);
  if (options.candidates.some(candidate => normalizeDomain(candidate) !== candidate || !candidate.endsWith(`.${root}`))) {
    throw new Error("扫描范围必须是当前域名的子域名。");
  }
  options.onProgress?.(0, options.candidates.length);
  const first = await subdomainRequest(`${probeToken()}.${root}`, options.timeoutMs, options.signal);
  let wildcardSignature: string | undefined;
  if (dnsSignature(first)) {
    const second = await subdomainRequest(`${probeToken()}.${root}`, options.timeoutMs, options.signal);
    if (dnsSignature(first) === dnsSignature(second)) wildcardSignature = dnsSignature(first);
  }
  await runQueue(options, options.signal, async (candidate, signal) => {
    const result = await subdomainRequest(candidate, options.timeoutMs, signal);
    return { ...result, wildcard: Boolean(wildcardSignature && dnsSignature(result) === wildcardSignature) };
  });
}

export async function scanWebsitePaths(options: ScanOptions<WebsitePathScanResult> & { baseUrl: string }): Promise<void> {
  validateOptions(options);
  const base = new URL(normalizeWebsiteUrl(options.baseUrl));
  if (options.candidates.some(candidate => {
    try {
      const url = new URL(candidate);
      return /[\s\\]/.test(candidate) || candidate.length > 2048 || url.href !== candidate
        || url.origin !== base.origin || Boolean(url.username || url.password || url.hash);
    } catch { return true; }
  })) throw new Error("扫描范围必须是当前网站的路径。");
  options.onProgress?.(0, options.candidates.length);
  const missing = await pathRequest(new URL(probeToken(), base).href, options.timeoutMs, options.signal);
  const redirectKey = (result: WebsitePathScanResult) => {
    if (!result.location) return "";
    try { return new URL(result.location, result.url).href; }
    catch { return result.location; }
  };
  await runQueue(options, options.signal, async (candidate, signal) => {
    const result = await pathRequest(candidate, options.timeoutMs, signal);
    return { ...result, soft404: Boolean(result.status === "responded" && missing.status === "responded"
      && result.statusCode === missing.statusCode && result.statusCode !== 404 && result.statusCode !== 410
      && result.fingerprint && result.fingerprint === missing.fingerprint
      && (result.contentLength === undefined || missing.contentLength === undefined || result.contentLength === missing.contentLength)
      && (!(result.statusCode! >= 300 && result.statusCode! < 400) || redirectKey(result) === redirectKey(missing))) };
  });
}

function csvCell(value: unknown) {
  let text = value === undefined || value === null ? "" : String(value);
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function formatScanCsv(headers: string[], rows: unknown[][]) {
  return [headers.join(","), ...rows.map(row => row.map(csvCell).join(","))].join("\r\n");
}

export function exportPathResultsCsv(results: WebsitePathScanResult[]) {
  return formatScanCsv(["url", "status", "http_status", "title", "content_length", "redirect_location", "possible_soft_404", "message"],
    results.map(result => [result.url, result.status, result.statusCode, result.title, result.contentLength, result.location, Boolean(result.soft404), result.message]));
}

export function downloadScanCsv(filename: string, content: string) {
  const url = URL.createObjectURL(new Blob(["\uFEFF", content], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
