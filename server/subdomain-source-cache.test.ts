import { describe, expect, it } from "vitest";
import { SubdomainSourceCache, type CacheableSubdomainSourceResult } from "./subdomain-source-cache";

function result(status: CacheableSubdomainSourceResult["status"] = "success"): CacheableSubdomainSourceResult {
  return { source: "subdomaincenter", status, domains: status === "error" ? [] : ["app.example.com"], message: "来源说明" };
}

function cacheWithClock() {
  let now = 0;
  const cache = new SubdomainSourceCache<CacheableSubdomainSourceResult>({ clock: () => now });
  return { cache, setTime: (value: number) => { now = value; } };
}

describe("completed subdomain source response cache", () => {
  it.each(["success", "partial"] as const)("expires %s responses after exactly ten minutes", status => {
    const { cache, setTime } = cacheWithClock();
    const value = result(status);
    cache.write("subdomaincenter:example.com:anonymous", value);
    setTime(10 * 60 * 1000 - 1);
    expect(cache.read("subdomaincenter:example.com:anonymous")).toEqual(value);
    setTime(10 * 60 * 1000);
    expect(cache.read("subdomaincenter:example.com:anonymous")).toBeUndefined();
  });

  it("keeps errors for only thirty seconds without shortening successful responses", () => {
    const { cache, setTime } = cacheWithClock();
    cache.write("subdomaincenter:example.com:anonymous", result("error"));
    cache.write("center:example.com:anonymous", result());
    setTime(29_999);
    expect(cache.read("subdomaincenter:example.com:anonymous")?.status).toBe("error");
    setTime(30_000);
    expect(cache.read("subdomaincenter:example.com:anonymous")).toBeUndefined();
    expect(cache.read("center:example.com:anonymous")?.status).toBe("success");
  });

  it("isolates stored responses from both write-input and read-output mutations", () => {
    const { cache } = cacheWithClock();
    const original = result();
    cache.write("key", original);
    original.domains.push("input-mutation.example.com");
    original.message = "changed input message";
    const first = cache.read("key")!;
    expect(first).toEqual(result());
    first.domains.push("reader-mutation.example.com");
    first.message = "changed reader message";
    const second = cache.read("key")!;
    expect(second).toEqual(result());
    expect(second).not.toBe(first);
    expect(second.domains).not.toBe(first.domains);
    expect(second.domains).not.toBe(original.domains);
  });

  it("bounds storage to 128 entries and evicts the oldest completed write", () => {
    const { cache } = cacheWithClock();
    for (let index = 0; index < 128; index += 1) cache.write(`key-${index}`, result());
    // Cache reads do not extend the lifetime or retain an old response indefinitely.
    expect(cache.read("key-0")).toEqual(result());
    cache.write("key-128", result());
    expect(cache.read("key-0")).toBeUndefined();
    expect(cache.read("key-1")).toEqual(result());
    expect(cache.read("key-128")).toEqual(result());
  });

  it("cleans expired responses before evicting a still-current response", () => {
    const { cache, setTime } = cacheWithClock();
    cache.write("oldest-success", result());
    for (let index = 0; index < 127; index += 1) cache.write(`error-${index}`, result("error"));
    setTime(30_000);
    cache.write("new-success", result());
    expect(cache.read("oldest-success")).toEqual(result());
    expect(cache.read("new-success")).toEqual(result());
    expect(cache.read("error-126")).toBeUndefined();
  });

  it("refreshes an overwritten response TTL and eviction order without evicting another key", () => {
    const { cache, setTime } = cacheWithClock();
    for (let index = 0; index < 128; index += 1) cache.write(`key-${index}`, result("error"));
    setTime(20_000);
    cache.write("key-0", result());
    expect(cache.read("key-1")?.status).toBe("error");
    cache.write("extra-key", result());
    expect(cache.read("key-1")).toBeUndefined();
    expect(cache.read("key-0")?.status).toBe("success");
    setTime(10 * 60 * 1000 + 19_999);
    expect(cache.read("key-0")?.status).toBe("success");
    setTime(10 * 60 * 1000 + 20_000);
    expect(cache.read("key-0")).toBeUndefined();
  });

  it("keeps domain and credential partitions independent and clears all completed responses", () => {
    const { cache } = cacheWithClock();
    cache.write("certspotter:example.com:credential-a", result());
    cache.write("certspotter:example.com:credential-b", result("error"));
    cache.write("certspotter:other.example:credential-a", result("partial"));
    expect(cache.read("certspotter:example.com:credential-a")?.status).toBe("success");
    expect(cache.read("certspotter:example.com:credential-b")?.status).toBe("error");
    expect(cache.read("certspotter:other.example:credential-a")?.status).toBe("partial");
    cache.clear();
    expect(cache.read("certspotter:example.com:credential-a")).toBeUndefined();
    expect(cache.read("certspotter:example.com:credential-b")).toBeUndefined();
    expect(cache.read("certspotter:other.example:credential-a")).toBeUndefined();
  });
});
