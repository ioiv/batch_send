import { describe, expect, it } from "vitest";
import { confirmedExposure, EXPOSURE_PATHS, exposurePathFor, exposureProbeUrls, exposureVerdict, type ExposurePath } from "./exposure-path";

const origin = "https://example.com";

describe("exposure probe list", () => {
  it("keeps a fixed, unique and absolute probe list", () => {
    expect(EXPOSURE_PATHS.length).toBeGreaterThan(0);
    expect(EXPOSURE_PATHS.length).toBeLessThanOrEqual(64);
    const paths = EXPOSURE_PATHS.map(entry => entry.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const entry of EXPOSURE_PATHS) {
      expect(entry.path.startsWith("/")).toBe(true);
      expect(entry.path).not.toContain("?");
      expect(entry.path).not.toContain("*");
      expect(entry.description.length).toBeGreaterThan(0);
      expect(["high", "medium", "low"]).toContain(entry.confidence);
    }
    const urls = exposureProbeUrls(`${origin}/deep/entry`);
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls.every(url => url.startsWith(`${origin}/`))).toBe(true);
    expect(urls.every(url => new URL(url).origin === origin)).toBe(true);
  });

  it("matches only the exact probe pathname and maps severity once", () => {
    expect(exposurePathFor(`${origin}/.env`)).toMatchObject({ path: "/.env", confidence: "high" });
    expect(exposurePathFor(`${origin}/.env.local`)).toMatchObject({ confidence: "high" });
    expect(exposurePathFor(`${origin}/.env/extra`)).toBeUndefined();
    expect(exposurePathFor(`${origin}/not-probed`)).toBeUndefined();
    expect(exposurePathFor("not a url")).toBeUndefined();
    const high = EXPOSURE_PATHS.find(entry => entry.confidence === "high") as ExposurePath;
    const medium = EXPOSURE_PATHS.find(entry => entry.confidence === "medium") as ExposurePath;
    const low = EXPOSURE_PATHS.find(entry => entry.confidence === "low") as ExposurePath;
    expect(exposureVerdict(high)).toBe("high");
    expect(exposureVerdict(medium)).toBe("medium");
    expect(exposureVerdict(low)).toBe("informational");
  });
});

describe("exposure confirmation", () => {
  const responded = (overrides: Record<string, unknown>) => ({ url: `${origin}/.env`, status: "responded", statusCode: 200, fingerprint: "a".repeat(64), ...overrides });
  const missing = { statusCode: 404, fingerprint: "b".repeat(64) };

  it("confirms only a 2xx response that differs from the random missing-path baseline", () => {
    expect(confirmedExposure(responded({}), missing)).toMatchObject({ path: { path: "/.env" }, verdict: "high" });
    expect(confirmedExposure(responded({ statusCode: 204 }), missing)).toMatchObject({ path: { path: "/.env" } });
  });

  it("requires a completed fingerprint comparison before reporting any exposure", () => {
    expect(confirmedExposure(responded({}))).toBeUndefined();
    expect(confirmedExposure(responded({}), { ...missing, fingerprint: "" })).toBeUndefined();
    expect(confirmedExposure(responded({ fingerprint: undefined }), missing)).toBeUndefined();
  });

  it("rejects catch-all, declared-route, non-2xx and low-confidence answers", () => {
    expect(confirmedExposure(responded({ soft404: true }), missing)).toBeUndefined();
    expect(confirmedExposure(responded({ clientRoute: true }), missing)).toBeUndefined();
    expect(confirmedExposure(responded({ statusCode: 403 }), missing)).toBeUndefined();
    expect(confirmedExposure(responded({ statusCode: 302 }), missing)).toBeUndefined();
    expect(confirmedExposure(responded({ status: "error", statusCode: undefined }), missing)).toBeUndefined();
    expect(confirmedExposure(responded({ url: `${origin}/robots.txt` }), missing)).toBeUndefined();
    expect(confirmedExposure(responded({ url: `${origin}/unlisted` }), missing)).toBeUndefined();
  });

  it("suppresses an answer identical to the single missing-path probe", () => {
    const baseline = { statusCode: 200, fingerprint: "b".repeat(64) };
    expect(confirmedExposure(responded({ fingerprint: baseline.fingerprint }), baseline)).toBeUndefined();
    expect(confirmedExposure(responded({ fingerprint: "c".repeat(64) }), baseline)).toMatchObject({ verdict: "high" });
  });
});
