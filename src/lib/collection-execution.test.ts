import { describe, expect, it } from "vitest";
import {
  mapWithCollectionConcurrency,
  normalizeCollectionExecutionSettings
} from "./collection-execution";

describe("collection execution settings", () => {
  it("normalizes valid settings and rejects unsafe bounds", () => {
    expect(normalizeCollectionExecutionSettings({
      concurrency: 3,
      maximumDelayMs: 2_000,
      minimumDelayMs: 500
    })).toEqual({ concurrency: 3, maximumDelayMs: 2_000, minimumDelayMs: 500 });

    expect(() => normalizeCollectionExecutionSettings({ concurrency: 0 })).toThrow(/1–20/);
    expect(() => normalizeCollectionExecutionSettings({
      maximumDelayMs: 100,
      minimumDelayMs: 200
    })).toThrow(/有效区间/);
  });

  it("limits active workers and preserves result ordering", async () => {
    let active = 0;
    let maximumActive = 0;
    const releases: Array<() => void> = [];
    const started: number[] = [];

    const request = mapWithCollectionConcurrency([1, 2, 3, 4], 2, async (item) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      started.push(item);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return item * 10;
    });

    await Promise.resolve();
    expect(started).toEqual([1, 2]);
    releases.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([1, 2, 3]);
    releases.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([1, 2, 3, 4]);
    releases.splice(0).forEach((release) => release());

    await expect(request).resolves.toEqual([10, 20, 30, 40]);
    expect(maximumActive).toBe(2);
  });
});
