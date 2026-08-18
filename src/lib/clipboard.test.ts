import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("copyText", () => {
  it("returns true only after the clipboard write succeeds", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await expect(copyText("address,1")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("address,1");
  });

  it("returns false when clipboard access is unavailable", async () => {
    vi.stubGlobal("navigator", {});

    await expect(copyText("address,1")).resolves.toBe(false);
  });

  it("returns false when the browser rejects clipboard access", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("permission denied")) }
    });

    await expect(copyText("address,1")).resolves.toBe(false);
  });
});
