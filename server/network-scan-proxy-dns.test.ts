import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseProxyDnsAnswer, ProxyDnsFailure, TrustedProxyDns } from "./network-scan-proxy-dns";
import * as proxy from "./network-scan-proxy";

const hostname = "example.com";
const proxyUrl = new URL("http://127.0.0.1:7897");
const answer = (addresses = ["93.184.216.34"]) => ({ Status: 0, TC: false, Question: [{ name: `${hostname}.`, type: 1 }],
  Answer: addresses.map(data => ({ name: `${hostname}.`, type: 1, TTL: 30, data })) });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("trusted proxy DNS answer checks", () => {
  it("accepts only checked addresses belonging to the queried name or its CNAME chain", () => {
    const input = answer();
    input.Answer = [{ name: "example.com.", type: 5, TTL: 20, data: "cdn.example.net." },
      { name: "cdn.example.net.", type: 1, TTL: 30, data: "93.184.216.34" },
      { name: "unrelated.example.org.", type: 1, TTL: 30, data: "8.8.8.8" }];
    expect(parseProxyDnsAnswer(input, hostname, 1).addresses).toEqual(["93.184.216.34"]);
  });

  it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "198.18.0.1"])("rejects an entire mixed public/private answer containing %s", address => {
    expect(() => parseProxyDnsAnswer(answer(["93.184.216.34", address]), hostname, 1)).toThrow(ProxyDnsFailure);
    try { parseProxyDnsAnswer(answer(["93.184.216.34", address]), hostname, 1); } catch (error) { expect(error).toMatchObject({ reason: "private" }); }
  });

  it("checks additional and opposite-family addresses instead of silently discarding private records", () => {
    expect(() => parseProxyDnsAnswer({ ...answer(), Additional: [{ name: "other.example.", type: 28, TTL: 20, data: "::1" }] }, hostname, 1)).toThrow(ProxyDnsFailure);
    expect(() => parseProxyDnsAnswer({ ...answer(), Answer: [...answer().Answer, { name: "example.com.", type: 28, TTL: 20, data: "fc00::1" }] }, hostname, 1)).toThrow(ProxyDnsFailure);
  });

  it.each([
    { Status: 2 }, { TC: true }, { Question: [{ name: "other.example.", type: 1 }] }, { Question: [{ name: "example.com.", type: 28 }] },
    { Answer: [{ name: "example.com.", type: 1, TTL: 30, data: "not-an-address" }] },
    { Answer: [{ name: "example.com.", type: 1, TTL: -1, data: "93.184.216.34" }] }
  ])("fails closed on malformed, truncated or mismatched resolver results: %o", change => {
    expect(() => parseProxyDnsAnswer({ ...answer(), ...change }, hostname, 1)).toThrow(ProxyDnsFailure);
  });

  it("accepts a complete negative response without fabricating an address", () => {
    expect(parseProxyDnsAnswer({ Status: 3, Question: [{ name: "example.com.", type: 1 }] }, hostname, 1).addresses).toEqual([]);
  });
});

describe("bounded trusted DNS reads", () => {
  it("queries both families through the configured proxy with a fixed bootstrap IP and normal TLS hostname", async () => {
    const request = vi.spyOn(proxy, "requestWithConfiguredProxy").mockImplementation((protocol, options, callback) => {
      const outgoing = new EventEmitter() as ClientRequest;
      outgoing.destroy = vi.fn(() => outgoing);
      outgoing.end = vi.fn(() => {
        queueMicrotask(() => {
          const url = new URL(String(options.path), "https://cloudflare-dns.com");
          const type = Number(url.searchParams.get("type"));
          const response = Object.assign(new PassThrough(), { statusCode: 200, headers: {}, complete: true }) as unknown as IncomingMessage;
          callback(response);
          (response as unknown as PassThrough).end(JSON.stringify({ Status: 0, Question: [{ name: "example.com.", type }],
            Answer: [{ name: "example.com.", type, TTL: 30, data: type === 1 ? "93.184.216.34" : "2606:4700:4700::1111" }] }));
        });
        return outgoing;
      }) as ClientRequest["end"];
      return outgoing;
    });
    const resolver = new TrustedProxyDns();
    expect(await resolver.resolve(hostname, proxyUrl, 1000)).toEqual(["93.184.216.34", "2606:4700:4700::1111"]);
    expect(request).toHaveBeenCalledTimes(2);
    for (const [protocol, options, _callback, address, environment] of request.mock.calls) {
      expect(protocol).toBe("https:");
      expect(address).toBe("1.1.1.1");
      expect(options).toMatchObject({ hostname: "cloudflare-dns.com", servername: "cloudflare-dns.com", rejectUnauthorized: true, method: "GET", headers: { Accept: "application/dns-json" } });
      expect(environment).toEqual({ HTTPS_PROXY: proxyUrl.href });
      expect(new URL(String(options.path), "https://cloudflare-dns.com").searchParams.get("name")).toBe(hostname);
    }
  });

  it("shares concurrent work and reuses valid answers only until their TTL expires", async () => {
    vi.useFakeTimers();
    const loader = vi.fn(async () => ({ addresses: ["93.184.216.34"], ttlMs: 1000 }));
    const resolver = new TrustedProxyDns(loader);
    expect(await Promise.all([resolver.resolve(hostname, proxyUrl, 2000), resolver.resolve(hostname, proxyUrl, 2000)])).toEqual([["93.184.216.34"], ["93.184.216.34"]]);
    expect(loader).toHaveBeenCalledTimes(1);
    await resolver.resolve(hostname, proxyUrl, 2000);
    expect(loader).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1001);
    await resolver.resolve(hostname, proxyUrl, 2000);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("detaches cancellation without aborting a sibling consumer", async () => {
    let finish!: (result: { addresses: string[]; ttlMs: number }) => void;
    let shared!: AbortSignal;
    const resolver = new TrustedProxyDns((_hostname, _proxy, signal) => {
      shared = signal;
      return new Promise(resolve => { finish = resolve; });
    });
    const controller = new AbortController();
    const first = resolver.resolve(hostname, proxyUrl, 1000, controller.signal);
    const second = resolver.resolve(hostname, proxyUrl, 1000);
    await Promise.resolve();
    controller.abort();
    await expect(first).rejects.toMatchObject({ reason: "dns" });
    expect(shared.aborted).toBe(false);
    finish({ addresses: ["93.184.216.34"], ttlMs: 1000 });
    await expect(second).resolves.toEqual(["93.184.216.34"]);
  });

  it("cancels abandoned or timed-out reads and never caches their result", async () => {
    vi.useFakeTimers();
    let shared!: AbortSignal;
    const loader = vi.fn((_hostname: string, _proxy: URL, signal: AbortSignal) => {
      shared = signal;
      return new Promise<{ addresses: string[]; ttlMs: number }>((_resolve, reject) => signal.addEventListener("abort", () => reject(new ProxyDnsFailure()), { once: true }));
    });
    const resolver = new TrustedProxyDns(loader);
    const pending = resolver.resolve(hostname, proxyUrl, 100);
    const rejected = expect(pending).rejects.toMatchObject({ reason: "timeout" });
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(shared.aborted).toBe(true);
    loader.mockImplementationOnce(async () => ({ addresses: ["93.184.216.34"], ttlMs: 1000 }));
    await expect(resolver.resolve(hostname, proxyUrl, 1000)).resolves.toEqual(["93.184.216.34"]);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("refuses private results even from an injected loader and does not retain failures", async () => {
    const loader = vi.fn().mockResolvedValueOnce({ addresses: ["93.184.216.34", "127.0.0.1"], ttlMs: 1000 }).mockResolvedValue({ addresses: ["93.184.216.34"], ttlMs: 1000 });
    const resolver = new TrustedProxyDns(loader);
    await expect(resolver.resolve(hostname, proxyUrl, 1000)).rejects.toMatchObject({ reason: "private" });
    await expect(resolver.resolve(hostname, proxyUrl, 1000)).resolves.toEqual(["93.184.216.34"]);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
