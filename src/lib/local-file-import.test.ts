import { describe, expect, it } from "vitest";
import {
  beginLocalFileImport,
  cancelLocalFileImport,
  isCurrentLocalFileImport,
  type LocalFileImportEpoch
} from "./local-file-import";

describe("local file import epochs", () => {
  it("invalidates a delayed read after cancellation", async () => {
    const epoch: LocalFileImportEpoch = { current: 0 };
    const requestId = beginLocalFileImport(epoch);
    let resolveRead!: (value: string) => void;
    const delayedRead = new Promise<string>((resolve) => { resolveRead = resolve; });

    cancelLocalFileImport(epoch);
    resolveRead("late file contents");
    await delayedRead;

    expect(isCurrentLocalFileImport(epoch, requestId)).toBe(false);
  });

  it("keeps only the newest overlapping read current", () => {
    const epoch: LocalFileImportEpoch = { current: 0 };
    const first = beginLocalFileImport(epoch);
    const second = beginLocalFileImport(epoch);

    expect(isCurrentLocalFileImport(epoch, first)).toBe(false);
    expect(isCurrentLocalFileImport(epoch, second)).toBe(true);
  });
});
