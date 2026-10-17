import { createHash } from "node:crypto";
import { Resolver } from "node:dns/promises";
import type { ClientRequest, IncomingMessage, ServerResponse } from "node:http";
import type { RequestOptions } from "node:https";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import type { SubdomainDiscoveryOptions, SubdomainDiscoveryResult, SubdomainDiscoverySource } from "./subdomain-discovery.js";
import type { WebsitePathDiscoveryResult, WebsitePathDiscoverySource } from "./website-path-discovery.js";
import { requestWithConfiguredProxy } from "./network-scan-proxy.js";
import { ProxyDnsFailure, resolveConfiguredProxyAddresses } from "./network-scan-proxy-dns.js";

export interface SubdomainScanResult {
  domain: string;
  status: "resolved" | "not-found" | "error";
  addresses: string[];
  cname?: string;
  message?: string;
}

export interface PathScanResult {
  url: string;
  status: "responded" | "error";
  statusCode?: number;
  title?: string;
  contentLength?: number;
  location?: string;
  fingerprint?: string;
  message?: string;
  decodedBodyLength?: number;
  durationMs?: number;
}

export type NetworkScanResult = SubdomainScanResult | PathScanResult | SubdomainDiscoveryResult | WebsitePathDiscoveryResult;
export type NetworkScanPayload =
  | { kind: "subdomain"; domain: string; timeoutMs: number }
  | { kind: "subdomain-discovery"; domain: string; source: SubdomainDiscoverySource; timeoutMs: number }
  | { kind: "path-discovery"; baseUrl: string; url: string; documentUrl?: string; scanId?: string; source: WebsitePathDiscoverySource; timeoutMs: number }
  | { kind: "path"; url: string; timeoutMs: number };

interface DnsResolver {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
  resolveCname(hostname: string): Promise<string[]>;
  cancel(): void;
}

/** Injectable transport keeps security and response tests independent of live targets. */
export interface NetworkScanDependencies {
  createResolver(): DnsResolver;
  request(protocol: "http:" | "https:", options: RequestOptions, callback: (response: IncomingMessage) => void, address?: string): ClientRequest;
  resolveProxyAddresses?(hostname: string, protocol: "http:" | "https:", timeoutMs: number, signal?: AbortSignal): Promise<string[] | undefined>;
}

const defaults: NetworkScanDependencies = {
  createResolver: () => new Resolver(),
  request: (protocol, options, callback, address) => requestWithConfiguredProxy(protocol, options, callback, address ?? ""),
  resolveProxyAddresses: resolveConfiguredProxyAddresses
};

const MAX_PAYLOAD_BYTES = 8192;
export const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_URL_LENGTH = 2048;
const DEFAULT_TIMEOUT_MS = 5000;
const NOT_FOUND_CODES = new Set(["ENOTFOUND", "ENODATA"]);
const CONNECTION_FAILURE_CODES = new Set(["ENETUNREACH", "EHOSTUNREACH", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"]);
const MAX_CONNECTION_ATTEMPTS = 3;

class ValidationError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); }
}

class ScanFailure extends Error {
  constructor(readonly reason: "timeout" | "dns" | "private" | "request", readonly retryable = reason !== "private") { super(reason); }
}

/** Only failures before HTTP headers arrive may switch to another already vetted address. */
class ConnectionFailure extends ScanFailure {
  constructor() { super("request"); }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function failureMessage(error: unknown): string {
  if (error instanceof ScanFailure && error.reason === "timeout") return "请求超时";
  if (error instanceof ScanFailure && error.reason === "private") return "目标未通过公网地址检查";
  if (error instanceof ScanFailure && error.reason === "dns") return "DNS 查询失败";
  return "请求失败";
}

/** Public discovery diagnostics never expose transport internals or credentials. */
export function publicDocumentFailure(error: unknown) {
  return { message: failureMessage(error), retryable: error instanceof ScanFailure && error.retryable };
}

function ipv4Number(address: string): number {
  return address.split(".").reduce((value, part) => value * 256 + Number(part), 0);
}

function ipv4InRange(address: number, base: string, bits: number): boolean {
  const divisor = 2 ** (32 - bits);
  return Math.floor(address / divisor) === Math.floor(ipv4Number(base) / divisor);
}

function ipv6Number(address: string): bigint {
  let normalized = address.toLowerCase();
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    const ipv4 = ipv4Number(normalized.slice(lastColon + 1));
    normalized = `${normalized.slice(0, lastColon)}:${Math.floor(ipv4 / 65536).toString(16)}:${(ipv4 % 65536).toString(16)}`;
  }
  const [left, right] = normalized.split("::");
  const before = left ? left.split(":") : [];
  const after = right ? right.split(":") : [];
  const parts = right === undefined ? before : [...before, ...Array<string>(8 - before.length - after.length).fill("0"), ...after];
  return parts.reduce((value, part) => (value << 16n) | BigInt(`0x${part}`), 0n);
}

function ipv6InRange(address: bigint, base: string, bits: number): boolean {
  const shift = BigInt(128 - bits);
  return address >> shift === ipv6Number(base) >> shift;
}

/** Conservative globally routable addresses only, including rejection of transition/mapped forms. */
export function isPublicIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Number(address);
    return ![
      ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
      ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
      ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
      ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3]
    ].some(([base, bits]) => ipv4InRange(value, base as string, bits as number));
  }
  if (family === 6 && !address.includes("%")) {
    const value = ipv6Number(address);
    return ipv6InRange(value, "2000::", 3) && ![
      ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3ffe::", 16], ["3fff::", 20]
    ].some(([base, bits]) => ipv6InRange(value, base as string, bits as number));
  }
  return false;
}

export function normalizeDomain(input: string): string {
  if (input.length > 254 || input.trim() !== input) throw new ValidationError("请输入有效的公网域名");
  const domain = domainToASCII(input.replace(/\.$/, "")).toLowerCase();
  const labels = domain.split(".");
  if (domain.length > 253 || labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    || isIP(domain) || /^\d+$/.test(labels[labels.length - 1])
    || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example|onion|arpa)$/.test(domain)) {
    throw new ValidationError("请输入有效的公网域名");
  }
  return domain;
}

export function normalizeUrl(input: string): URL {
  if (input.length > MAX_URL_LENGTH || input.trim() !== input || /[\u0000-\u0020\u007f\\]/.test(input)) throw new ValidationError("请输入有效的网站 URL");
  let url: URL;
  try { url = new URL(input); } catch { throw new ValidationError("请输入有效的网站 URL"); }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.port || url.hash || /^[a-z]+:\/\/[^/]*@/i.test(input)) {
    throw new ValidationError("仅支持默认端口的 HTTP / HTTPS URL，且不能包含凭据或片段");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname)) {
    if (!isPublicIp(hostname)) throw new ValidationError("仅支持公网目标");
  } else {
    url.hostname = normalizeDomain(hostname);
  }
  return url;
}

function timeoutValue(value: unknown): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1000 || value > 10000) throw new ValidationError("超时必须在 1000–10000 毫秒之间");
  return value;
}

export function validateScanPayload(payload: unknown): NetworkScanPayload {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new ValidationError("请求格式无效");
  const input = payload as Record<string, unknown>;
  const discovery = input.kind === "subdomain-discovery" || input.kind === "path-discovery";
  const pentesttools = input.kind === "subdomain-discovery" && input.source === "pentesttools";
  const scriptDiscovery = input.kind === "path-discovery" && input.source === "scripts";
  const discoveryTimeoutMs = pentesttools ? 120000 : scriptDiscovery ? 45000 : 20000;
  const timeoutMs = discovery ? (input.timeoutMs === undefined ? discoveryTimeoutMs : input.timeoutMs) : timeoutValue(input.timeoutMs);
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > (discovery ? discoveryTimeoutMs : 10000)) throw new ValidationError(`发现来源超时必须在 1000–${discoveryTimeoutMs} 毫秒之间`);
  const allowed = input.kind === "path-discovery" ? ["kind", "baseUrl", "url", "documentUrl", "scanId", "source", "timeoutMs"] : discovery ? ["kind", "domain", "source", "timeoutMs"] : input.kind === "subdomain" ? ["kind", "domain", "timeoutMs"] : ["kind", "url", "timeoutMs"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new ValidationError("请求包含不支持的字段");
  if (input.kind === "path-discovery" && typeof input.baseUrl === "string" && typeof input.url === "string" && typeof input.source === "string" && ["links", "scripts", "robots", "sitemap", "wayback"].includes(input.source)) {
    if (input.scanId !== undefined && (typeof input.scanId !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(input.scanId))) throw new ValidationError("扫描轮次标识无效");
    const baseUrl = normalizeUrl(input.baseUrl);
    const url = normalizeUrl(input.url);
    if (url.origin !== baseUrl.origin) throw new ValidationError("发现文档必须与扫描网站同源");
    let documentUrl: URL | undefined;
    if (input.documentUrl !== undefined) {
      if (typeof input.documentUrl !== "string") throw new ValidationError("脚本所属网页地址无效");
      documentUrl = normalizeUrl(input.documentUrl);
      if (documentUrl.origin !== baseUrl.origin) throw new ValidationError("脚本所属网页必须与扫描网站同源");
      documentUrl.search = "";
    }
    baseUrl.search = "";
    url.search = "";
    return { kind: "path-discovery", baseUrl: baseUrl.href, url: url.href, ...(documentUrl ? { documentUrl: documentUrl.href } : {}), ...(input.scanId ? { scanId: input.scanId } : {}), source: input.source as WebsitePathDiscoverySource, timeoutMs };
  }
  if (input.kind === "subdomain-discovery" && typeof input.domain === "string" && typeof input.source === "string" && ["subdomaincenter", "certspotter", "hackertarget", "common", "pentesttools", "certkit"].includes(input.source)) {
    return { kind: "subdomain-discovery", domain: normalizeDomain(input.domain), source: input.source as SubdomainDiscoverySource, timeoutMs };
  }
  if (input.kind === "subdomain" && typeof input.domain === "string") return { kind: "subdomain", domain: normalizeDomain(input.domain), timeoutMs };
  if (input.kind === "path" && typeof input.url === "string") return { kind: "path", url: normalizeUrl(input.url).href, timeoutMs };
  throw new ValidationError("请求格式无效");
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, cancel: () => void, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new ScanFailure("timeout")); cancel(); }, Math.max(1, timeoutMs));
    onAbort = () => { reject(new ScanFailure("request")); cancel(); };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([operation, timeout]); } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

async function resolvePublicAddresses(hostname: string, timeoutMs: number, dependencies: NetworkScanDependencies, includeCname: boolean, signal?: AbortSignal, enforcePublic = true, protocol?: "http:" | "https:"): Promise<{ addresses: string[]; cname?: string; privateRecords?: boolean }> {
  const startedAt = Date.now();
  if (signal?.aborted) throw new ScanFailure("request");
  if (isIP(hostname)) {
    if (!isPublicIp(hostname)) throw new ScanFailure("private");
    return { addresses: [hostname] };
  }
  const resolver = dependencies.createResolver();
  let cancelled = false;
  // resolver.cancel() releases the handle; a timeout, an abort and the finally block
  // can all fire, so every path shares one guarded cancel.
  const cancelResolver = () => {
    if (cancelled) return;
    cancelled = true;
    try { resolver.cancel(); } catch { /* Cancelling an already finished resolver is not a scan failure. */ }
  };
  try {
    const answers = await withTimeout(Promise.allSettled([
      resolver.resolve4(hostname), resolver.resolve6(hostname), ...(includeCname ? [resolver.resolveCname(hostname)] : [])
    ]), timeoutMs, cancelResolver, signal);
    const addresses = [...new Set(answers.slice(0, 2).flatMap((answer) => answer.status === "fulfilled" ? answer.value : []))];
    if (addresses.length > 64 || addresses.some((address) => !isIP(address))) throw new ScanFailure("dns");
    let privateRecords = addresses.some((address) => !isPublicIp(address));
    if (enforcePublic && privateRecords) throw new ScanFailure("private");
    if (enforcePublic && protocol && dependencies.resolveProxyAddresses) {
      const remaining = timeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) throw new ScanFailure("timeout");
      let trusted: string[] | undefined;
      const trustedController = new AbortController();
      try { trusted = await withTimeout(dependencies.resolveProxyAddresses(hostname, protocol, remaining, trustedController.signal), remaining, () => trustedController.abort(), signal); }
      catch (error) { throw error instanceof ScanFailure ? error : new ScanFailure(error instanceof ProxyDnsFailure ? error.reason : "dns"); }
      finally { trustedController.abort(); }
      if (trusted) {
        if (trusted.length > 64 || trusted.some(address => !isIP(address))) throw new ScanFailure("dns");
        if (trusted.some(address => !isPublicIp(address))) throw new ScanFailure("private");
        return { addresses: [...new Set(trusted)] };
      }
    }
    if (answers.some((answer) => answer.status === "rejected" && !NOT_FOUND_CODES.has(errorCode(answer.reason) ?? ""))) throw new ScanFailure("dns");
    if (!addresses.length && answers.slice(0, 2).some((answer) => answer.status === "fulfilled")) throw new ScanFailure("dns");
    const cnameAnswer = answers[2];
    const cnameInput = cnameAnswer?.status === "fulfilled" ? cnameAnswer.value[0] : undefined;
    let cname: string | undefined;
    if (cnameInput) {
      try { cname = normalizeDomain(cnameInput); } catch {
        if (enforcePublic) throw new ScanFailure("private");
        const name = domainToASCII(cnameInput.replace(/\.$/, "")).toLowerCase();
        if (name.length > 253 || name.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new ScanFailure("dns");
        cname = name;
        privateRecords = true;
      }
    }
    return { addresses, ...(cname ? { cname } : {}), ...(privateRecords ? { privateRecords: true } : {}) };
  } finally { cancelResolver(); }
}

export async function scanSubdomain(domainInput: string, timeoutMs = DEFAULT_TIMEOUT_MS, dependencies = defaults, signal?: AbortSignal): Promise<SubdomainScanResult> {
  const domain = normalizeDomain(domainInput);
  timeoutValue(timeoutMs);
  try {
    const { addresses, cname, privateRecords } = await resolvePublicAddresses(domain, timeoutMs, dependencies, true, signal, false);
    return { domain, status: addresses.length || cname ? "resolved" : "not-found", addresses, ...(cname ? { cname } : {}), ...(privateRecords ? { message: "DNS 记录包含非公网地址，仅展示解析结果" } : {}) };
  } catch (error) {
    return { domain, status: "error", addresses: [], message: failureMessage(error) };
  }
}

function responseTitle(body: Buffer): string | undefined {
  const title = body.toString("utf8").match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1];
  if (!title) return undefined;
  return title.replace(/<[^>]*>/g, " ").replace(/&(?:amp|lt|gt|quot|apos|#39|nbsp);/g, (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#39;": "'", "&nbsp;": " " })[entity] ?? entity)
    .replace(/\s+/g, " ").trim().slice(0, 200) || undefined;
}

/** Server-controlled transport options; browser scan payloads cannot supply them. */
export interface PublicDocumentOptions {
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
  headers?: Readonly<Record<string, string>>;
  method?: "GET" | "POST";
  body?: string;
}

export interface PublicDocumentResult {
  url: string;
  statusCode: number;
  body: Buffer;
  truncated: boolean;
  contentLength?: number;
  contentType?: string;
  contentEncoding?: string;
  location?: string;
  setCookies?: string[];
}

/** Use the same bounded fingerprint for a discovered document and a standalone probe. */
export function publicDocumentPathResult(response: PublicDocumentResult, options: { decodedBody?: boolean; durationMs?: number } = {}): PathScanResult {
  const sample = response.body.subarray(0, MAX_RESPONSE_BYTES);
  const title = responseTitle(sample);
  return { url: response.url, status: "responded", statusCode: response.statusCode,
    ...(title ? { title } : {}), ...(response.contentLength === undefined ? {} : { contentLength: response.contentLength }),
    ...(response.location ? { location: response.location } : {}),
    ...(options.decodedBody && !response.truncated ? { decodedBodyLength: response.body.length } : {}),
    ...(options.durationMs === undefined ? {} : { durationMs: options.durationMs }),
    fingerprint: createHash("sha256").update(sample).digest("hex") };
}

function getResponseAtAddress(url: URL, address: string, timeoutMs: number, dependencies: NetworkScanDependencies, signal?: AbortSignal, maxBytes = MAX_RESPONSE_BYTES, headers?: Readonly<Record<string, string>>, method: "GET" | "POST" = "GET", requestBody?: string): Promise<PublicDocumentResult> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  return new Promise((resolve, reject) => {
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let settled = false;
    let byteLength = 0;
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => fail(new ScanFailure("timeout")), Math.max(1, timeoutMs));
    let onAbort: () => void = () => undefined;
    const cleanup = () => {
      clearTimeout(timer);
      response?.removeListener("data", onData);
      response?.removeListener("end", finish);
      response?.removeListener("aborted", onAborted);
      response?.removeListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
      // destroy() can emit a later request error (for example ECONNRESET before
      // headers arrive). Keep its listener; fail() ignores errors after settling.
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
      response?.destroy();
      request?.destroy();
    };
    const finish = (truncated = false) => {
      if (settled || !response) return;
      settled = true;
      cleanup();
      const body = Buffer.concat(chunks, byteLength);
      const contentLengthHeader = response.headers["content-length"];
      const contentLength = typeof contentLengthHeader === "string" && /^\d+$/.test(contentLengthHeader) ? Number(contentLengthHeader) : undefined;
      const location = typeof response.headers.location === "string" ? response.headers.location.slice(0, MAX_URL_LENGTH) : undefined;
      const contentType = typeof response.headers["content-type"] === "string" ? response.headers["content-type"].slice(0, 200) : undefined;
      const contentEncoding = typeof response.headers["content-encoding"] === "string" ? response.headers["content-encoding"].slice(0, 100) : undefined;
      const setCookies = response.headers["set-cookie"];
      resolve({
        url: url.href, statusCode: response.statusCode ?? 0, body, truncated,
        ...(contentType ? { contentType } : {}), ...(contentEncoding ? { contentEncoding } : {}), ...(Number.isSafeInteger(contentLength) ? { contentLength } : {}),
        ...(location ? { location } : {}), ...(setCookies?.length ? { setCookies: [...setCookies] } : {})
      });
      // Destroy immediately after the bounded sample; never download the rest or follow a redirect.
      response.destroy();
      request?.destroy();
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const sample = buffer.subarray(0, maxBytes - byteLength);
      chunks.push(Buffer.from(sample));
      byteLength += sample.length;
      if (byteLength === maxBytes) finish(true);
    };
    const onAborted = () => fail(new ScanFailure("request"));
    onAbort = () => fail(new ScanFailure("request", false));
    const onClose = () => { if (!response?.complete) fail(new ScanFailure("request")); };
    const onRequestError = (error: unknown) => fail(!response && CONNECTION_FAILURE_CODES.has(errorCode(error) ?? "") ? new ConnectionFailure() : new ScanFailure("request", CONNECTION_FAILURE_CODES.has(errorCode(error) ?? "")));
    try {
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener("abort", onAbort, { once: true });
      request = dependencies.request(url.protocol as "http:" | "https:", {
        protocol: url.protocol, hostname, family: isIP(address), method, path: `${url.pathname}${url.search}`, agent: false,
        ...(isIP(hostname) ? {} : { servername: hostname }),
        headers: { "User-Agent": "ToolboxNetworkScanner/1.0", Accept: "text/html,application/xhtml+xml,*/*;q=0.5", "Accept-Encoding": "identity", ...headers },
        lookup: (_name, options, callback) => {
          const selected = !options.family || isIP(address) === options.family ? address : undefined;
          if (!selected) { callback(Object.assign(new Error("Address unavailable"), { code: "EAI_NONAME" }), ""); return; }
          if (options.all) callback(null, [{ address: selected, family: isIP(selected) }]);
          else callback(null, selected, isIP(selected));
        }
      }, (incoming) => {
        if (settled) { incoming.destroy(); return; }
        response = incoming;
        response.on("data", onData);
        response.once("end", finish);
        response.once("aborted", onAborted);
        response.once("close", onClose);
        response.on("error", () => fail(new ScanFailure("request")));
      }, address);
      request.on("error", onRequestError);
      request.end(requestBody);
    } catch { fail(new ScanFailure("request", false)); }
  });
}

async function getResponse(url: URL, addresses: string[], deadline: number, dependencies: NetworkScanDependencies, signal?: AbortSignal, maxBytes = MAX_RESPONSE_BYTES, headers?: Readonly<Record<string, string>>, method: "GET" | "POST" = "GET", requestBody?: string): Promise<PublicDocumentResult> {
  if (addresses.some((address) => !isPublicIp(address))) throw new ScanFailure("private");
  const families = [addresses.filter((address) => isIP(address) === 4), addresses.filter((address) => isIP(address) === 6)];
  // Prefer IPv4 whenever it exists: dual-stack hosts with broken IPv6 connectivity would
  // otherwise spend the whole budget before the reachable family is tried.
  if (!families[0].length || (families[1].length && isIP(addresses[0] ?? "") === 6)) families.reverse();
  const candidates: string[] = [];
  for (let index = 0; candidates.length < MAX_CONNECTION_ATTEMPTS; index += 1) {
    const next = families.flatMap((family) => family[index] ? [family[index]] : []);
    if (!next.length) break;
    candidates.push(...next.slice(0, MAX_CONNECTION_ATTEMPTS - candidates.length));
  }
  if (!candidates.length) throw new ScanFailure("dns");
  for (const address of candidates) {
    if (signal?.aborted) throw new ScanFailure("request");
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ScanFailure("timeout");
    try { return await getResponseAtAddress(url, address, remaining, dependencies, signal, maxBytes, headers, method, requestBody); }
    // POST may already have created a remote job even if headers never arrived.
    catch (error) { if (method === "POST" || !(error instanceof ConnectionFailure)) throw error; }
  }
  throw new ScanFailure("request");
}

/** Public-only pinned transport shared by path probes and discovery sources. */
export async function fetchPublicDocument(urlInput: string, options: PublicDocumentOptions, dependencies = defaults): Promise<PublicDocumentResult> {
  const url = normalizeUrl(urlInput);
  if (!Number.isInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > 4 * 1024 * 1024 || !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 45000) throw new ValidationError("读取限制无效");
  const method = options.method ?? "GET";
  if ((method !== "GET" && method !== "POST") || (options.body !== undefined && (method !== "POST" || typeof options.body !== "string" || Buffer.byteLength(options.body) > MAX_PAYLOAD_BYTES))) throw new ValidationError("请求方法或正文无效");
  const headers = method === "POST" ? {
    ...Object.fromEntries(Object.entries(options.headers ?? {}).filter(([name]) => name.toLowerCase() !== "content-length")),
    "Content-Length": String(Buffer.byteLength(options.body ?? ""))
  } : options.headers;
  const deadline = Date.now() + options.timeoutMs;
  const { addresses } = await resolvePublicAddresses(url.hostname.replace(/^\[|\]$/g, ""), options.timeoutMs, dependencies, false, options.signal, true, url.protocol as "http:" | "https:");
  if (!addresses.length) throw new ScanFailure("dns");
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new ScanFailure("timeout");
  return getResponse(url, addresses, deadline, dependencies, options.signal, options.maxBytes, headers, method, options.body);
}

export async function scanWebsitePath(urlInput: string, timeoutMs = DEFAULT_TIMEOUT_MS, dependencies = defaults, signal?: AbortSignal): Promise<PathScanResult> {
  const url = normalizeUrl(urlInput);
  timeoutValue(timeoutMs);
  const deadline = Date.now() + timeoutMs;
  try {
    const { addresses } = await resolvePublicAddresses(url.hostname.replace(/^\[|\]$/g, ""), timeoutMs, dependencies, false, signal, true, url.protocol as "http:" | "https:");
    if (!addresses.length) throw new ScanFailure("dns");
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ScanFailure("timeout");
    const response = await getResponse(url, addresses, deadline, dependencies, signal);
    return publicDocumentPathResult(response);
  } catch (error) {
    return { url: url.href, status: "error", message: failureMessage(error) };
  }
}

type ScanRequest = IncomingMessage & { body?: unknown };

function parseBody(body: string | Buffer): unknown {
  if (Buffer.byteLength(body) > MAX_PAYLOAD_BYTES) throw new ValidationError("请求过大", 413);
  try { return JSON.parse(body.toString()); } catch { throw new ValidationError("请求必须是有效的 JSON"); }
}

async function readBody(request: ScanRequest, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) throw new ValidationError("请求已取消");
  const declaredLength = request.headers["content-length"];
  if (typeof declaredLength === "string" && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_PAYLOAD_BYTES)) throw new ValidationError("请求过大", 413);
  if (request.body !== undefined) {
    if (typeof request.body === "string" || Buffer.isBuffer(request.body)) return parseBody(request.body);
    // Vercel's JSON parser supplies an object. The strict field/length checks below bound it.
    return request.body;
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => fail(new ValidationError("读取请求超时", 408)), DEFAULT_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("aborted", onAborted);
      request.removeListener("error", onAborted);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: unknown) => { cleanup(); request.resume(); reject(error); };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_PAYLOAD_BYTES) { fail(new ValidationError("请求过大", 413)); return; }
      chunks.push(buffer);
    };
    const onEnd = () => { cleanup(); try { resolve(parseBody(Buffer.concat(chunks, size))); } catch (error) { reject(error); } };
    const onAborted = () => fail(new ValidationError("请求未完整接收"));
    const onAbort = () => fail(new ValidationError("请求已取消"));
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
    request.once("error", onAborted);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface ClientQuota { startedAt: number; requests: number; active: number }
const clientQuotas = new Map<string, ClientQuota>();
let activeRequests = 0;
let globalWindow = { startedAt: Date.now(), requests: 0 };

function acquireQuota(client: string): (() => void) | undefined {
  const now = Date.now();
  if (now - globalWindow.startedAt >= 60000) globalWindow = { startedAt: now, requests: 0 };
  if (clientQuotas.size >= 4096) {
    for (const [key, quota] of clientQuotas) if (!quota.active && now - quota.startedAt >= 60000) clientQuotas.delete(key);
    if (!clientQuotas.has(client) && clientQuotas.size >= 4096) return undefined;
  }
  let quota = clientQuotas.get(client);
  if (!quota) { quota = { startedAt: now, requests: 0, active: 0 }; clientQuotas.set(client, quota); }
  if (now - quota.startedAt >= 60000) { quota.startedAt = now; quota.requests = 0; }
  if (quota.active >= 8 || activeRequests >= 32 || quota.requests >= 6000 || globalWindow.requests >= 12000) return undefined;
  quota.requests += 1;
  quota.active += 1;
  globalWindow.requests += 1;
  activeRequests += 1;
  return () => { quota.active -= 1; activeRequests -= 1; };
}

function sendJson(response: ServerResponse, statusCode: number, payload: { result: NetworkScanResult } | { error: string }): void {
  if (response.destroyed || response.writableEnded) return;
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(payload));
}

/** Shared Node handler for Vite middleware and the Vercel serverless entry point. */
export async function handleNetworkScanRequest(request: ScanRequest, response: ServerResponse, options?: SubdomainDiscoveryOptions): Promise<void> {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    sendJson(response, 405, { error: "仅支持 POST 请求" });
    return;
  }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
    sendJson(response, 415, { error: "请使用 application/json 请求" });
    return;
  }
  const release = acquireQuota(request.socket?.remoteAddress ?? "unknown");
  if (!release) { response.setHeader("Retry-After", "10"); sendJson(response, 429, { error: "请求过于频繁，请稍后重试" }); return; }
  const controller = new AbortController();
  const onDisconnect = () => controller.abort();
  const onResponseClose = () => { if (!response.writableEnded) controller.abort(); };
  request.once("aborted", onDisconnect);
  response.once("close", onResponseClose);
  try {
    const payload = validateScanPayload(await readBody(request, controller.signal));
    const result = payload.kind === "subdomain-discovery"
      ? await (await import("./subdomain-discovery.js")).discoverSubdomains(payload.domain, payload.source, payload.timeoutMs, undefined, controller.signal, options)
      : payload.kind === "path-discovery" ? await (await import("./website-path-discovery.js")).discoverWebsitePaths(payload.baseUrl, payload.url, payload.source, payload.timeoutMs, undefined, controller.signal, payload.documentUrl, payload.scanId)
      : payload.kind === "subdomain" ? await scanSubdomain(payload.domain, payload.timeoutMs, defaults, controller.signal) : await scanWebsitePath(payload.url, payload.timeoutMs, defaults, controller.signal);
    sendJson(response, 200, { result });
  } catch (error) {
    sendJson(response, error instanceof ValidationError ? error.statusCode : 500, { error: error instanceof ValidationError ? error.message : "扫描服务暂时不可用" });
  } finally {
    request.removeListener("aborted", onDisconnect);
    response.removeListener("close", onResponseClose);
    release();
  }
}
