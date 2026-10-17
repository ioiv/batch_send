import type { ClientRequest, IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { isPublicIp, normalizeDomain } from "./network-scan.js";
import { configuredNetworkProxy, requestWithConfiguredProxy } from "./network-scan-proxy.js";

const MAX_DNS_BYTES = 64 * 1024;
const MAX_DNS_TTL_MS = 30000;
const BOOTSTRAP_ADDRESS = "1.1.1.1";
const RESOLVER_HOST = "cloudflare-dns.com";
export class ProxyDnsFailure extends Error {
  constructor(readonly reason: "dns" | "private" | "timeout" = "dns") { super("可信 DNS 查询失败"); }
}
interface Answer { name: string; type: number; TTL: number; data: string }
interface DnsResult { addresses: string[]; ttlMs: number }
interface Entry { controller: AbortController; promise: Promise<DnsResult>; consumers: number; settled: boolean }
export type ProxyDnsLoader = (hostname: string, proxy: URL, signal: AbortSignal) => Promise<DnsResult>;

/** Validate all returned addresses before retaining any part of a DNS answer. */
export function parseProxyDnsAnswer(input: unknown, hostname: string, type: 1 | 28): DnsResult {
  if (!input || typeof input !== "object") throw new ProxyDnsFailure();
  const data = input as Record<string, unknown>;
  const question = data.Question as { name?: unknown; type?: unknown }[] | undefined;
  if (![0, 3].includes(data.Status as number) || data.TC === true || !Array.isArray(question) || question.length !== 1
    || typeof question[0]?.name !== "string" || question[0].name.toLowerCase().replace(/\.$/, "") !== hostname || question[0].type !== type) throw new ProxyDnsFailure();
  const answer = data.Answer ?? [];
  const additional = data.Additional ?? [];
  if (!Array.isArray(answer) || !Array.isArray(additional) || answer.length + additional.length > 128) throw new ProxyDnsFailure();
  for (const record of [...answer, ...additional] as Answer[]) {
    if (!record || typeof record.name !== "string" || !Number.isInteger(record.type) || typeof record.data !== "string" || record.data.length > 2048
      || !Number.isFinite(record.TTL) || record.TTL < 0) throw new ProxyDnsFailure();
    if (record.type === 1 || record.type === 28) {
      if (isIP(record.data) !== (record.type === 1 ? 4 : 6)) throw new ProxyDnsFailure();
      if (!isPublicIp(record.data)) throw new ProxyDnsFailure("private");
    }
  }
  const reachable = new Set([hostname]);
  for (let pass = 0; pass < 8; pass++) for (const record of answer as Answer[]) {
    if (record.type === 5 && reachable.has(record.name.toLowerCase().replace(/\.$/, ""))) {
      try { reachable.add(normalizeDomain(record.data)); } catch { throw new ProxyDnsFailure(); }
    }
  }
  const addresses = (answer as Answer[]).filter(record => record.type === type && reachable.has(record.name.toLowerCase().replace(/\.$/, "")));
  const chain = (answer as Answer[]).filter(record => (record.type === type || record.type === 5) && reachable.has(record.name.toLowerCase().replace(/\.$/, "")));
  return { addresses: [...new Set(addresses.map(record => record.data))], ttlMs: Math.min(MAX_DNS_TTL_MS, ...chain.map(record => record.TTL * 1000)) };
}

function readDnsJson(hostname: string, type: 1 | 28, proxy: URL, signal: AbortSignal): Promise<DnsResult> {
  const path = `/dns-query?${new URLSearchParams({ name: hostname, type: String(type) })}`;
  return new Promise((resolve, reject) => {
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let settled = false;
    let size = 0;
    const chunks: Buffer[] = [];
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
    const fail = (error: unknown = new ProxyDnsFailure()) => {
      if (settled) return;
      settled = true; cleanup();
      reject(error instanceof ProxyDnsFailure ? error : new ProxyDnsFailure());
      response?.destroy(); request?.destroy();
    };
    const abort = () => fail();
    const timer = setTimeout(() => fail(new ProxyDnsFailure("timeout")), 10000);
    if (signal.aborted) { fail(); return; }
    signal.addEventListener("abort", abort, { once: true });
    try {
      request = requestWithConfiguredProxy("https:", { protocol: "https:", hostname: RESOLVER_HOST, servername: RESOLVER_HOST, rejectUnauthorized: true,
        method: "GET", path, agent: false, headers: { Accept: "application/dns-json", "Accept-Encoding": "identity" },
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [{ address: BOOTSTRAP_ADDRESS, family: 4 }]);
          else callback(null, BOOTSTRAP_ADDRESS, 4);
        }
      }, incoming => {
        if (settled) { incoming.destroy(); return; }
        response = incoming;
        if (incoming.statusCode !== 200) { fail(); return; }
        incoming.on("error", fail);
        incoming.once("aborted", fail);
        incoming.once("close", () => { if (!incoming.complete) fail(); });
        incoming.on("data", (chunk: Buffer | string) => {
          if (settled) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.length;
          if (size > MAX_DNS_BYTES) { fail(); return; }
          chunks.push(buffer);
        });
        incoming.once("end", () => {
          if (settled) return;
          try {
            let body = Buffer.concat(chunks, size);
            const encoding = String(incoming.headers["content-encoding"] ?? "identity").toLowerCase();
            if (encoding === "gzip") body = gunzipSync(body, { maxOutputLength: MAX_DNS_BYTES });
            else if (encoding === "br") body = brotliDecompressSync(body, { maxOutputLength: MAX_DNS_BYTES });
            else if (encoding === "deflate") body = inflateSync(body, { maxOutputLength: MAX_DNS_BYTES });
            else if (encoding !== "identity") throw new ProxyDnsFailure();
            const result = parseProxyDnsAnswer(JSON.parse(body.toString("utf8")), hostname, type);
            settled = true; cleanup(); resolve(result); response?.destroy(); request?.destroy();
          } catch (error) { fail(error); }
        });
      }, BOOTSTRAP_ADDRESS, { HTTPS_PROXY: proxy.href });
      request.on("error", fail);
      request.end();
    } catch (error) { fail(error); }
  });
}

const defaultLoader: ProxyDnsLoader = async (hostname, proxy, signal) => {
  const answers = await Promise.all([readDnsJson(hostname, 1, proxy, signal), readDnsJson(hostname, 28, proxy, signal)]);
  const addresses = [...new Set(answers.flatMap(answer => answer.addresses))];
  if (addresses.length > 64) throw new ProxyDnsFailure();
  return { addresses, ttlMs: Math.min(...answers.map(answer => answer.ttlMs)) };
};

/** Share bounded DoH reads across concurrent scans; a cancelled consumer cannot cancel its siblings. */
export class TrustedProxyDns {
  private readonly cache = new Map<string, DnsResult & { expires: number }>();
  private readonly pending = new Map<string, Entry>();
  constructor(private readonly loader: ProxyDnsLoader = defaultLoader) {}

  async resolve(hostname: string, proxy: URL, timeoutMs: number, signal?: AbortSignal): Promise<string[]> {
    hostname = normalizeDomain(hostname);
    if (signal?.aborted) throw new ProxyDnsFailure();
    const key = `${proxy.href}|${hostname}`;
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return [...cached.addresses];
    this.cache.delete(key);
    let entry = this.pending.get(key);
    if (!entry) {
      if (this.pending.size >= 32) throw new ProxyDnsFailure();
      const controller = new AbortController();
      entry = { controller, consumers: 0, settled: false, promise: undefined! };
      const created = entry;
      this.pending.set(key, created);
      created.promise = Promise.resolve().then(() => this.loader(hostname, proxy, controller.signal)).then(result => {
        if (result.addresses.length > 64 || result.addresses.some(address => !isPublicIp(address))) throw new ProxyDnsFailure("private");
        if (result.ttlMs > 0 && !controller.signal.aborted) {
          while (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!);
          this.cache.set(key, { ...result, addresses: [...result.addresses], expires: Date.now() + Math.min(MAX_DNS_TTL_MS, result.ttlMs) });
        }
        return result;
      }).finally(() => {
        created.settled = true;
        if (this.pending.get(key) === created) this.pending.delete(key);
        controller.abort();
      });
      void created.promise.catch(() => {});
    }
    const selected = entry;
    selected.consumers++;
    let abort!: () => void;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancellation = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new ProxyDnsFailure());
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => reject(new ProxyDnsFailure("timeout")), Math.max(1, timeoutMs));
    });
    try { return [...(await Promise.race([selected.promise, cancellation])).addresses]; }
    finally {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (--selected.consumers === 0 && !selected.settled) {
        if (this.pending.get(key) === selected) this.pending.delete(key);
        selected.controller.abort();
      }
    }
  }
}

const trustedDns = new TrustedProxyDns();
export async function resolveConfiguredProxyAddresses(hostname: string, protocol: "http:" | "https:", timeoutMs: number, signal?: AbortSignal): Promise<string[] | undefined> {
  const proxy = configuredNetworkProxy(protocol, hostname);
  return proxy ? trustedDns.resolve(hostname, proxy, timeoutMs, signal) : undefined;
}
