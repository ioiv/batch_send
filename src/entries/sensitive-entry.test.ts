import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function read(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));

function resolveSourceImport(importer: string, specifier: string) {
  const base = specifier.startsWith("@/")
    ? resolve(sourceRoot, specifier.slice(2))
    : resolve(dirname(importer), specifier);
  return [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts"), resolve(base, "index.tsx")]
    .find((candidate) => existsSync(candidate)) || null;
}

function collectRelativeModuleGraph(entryPath: string) {
  const pending = [entryPath];
  const visited = new Set<string>();
  while (pending.length) {
    const filePath = pending.pop()!;
    if (visited.has(filePath)) continue;
    visited.add(filePath);
    const source = readFileSync(filePath, "utf8");
    const specifiers = [...source.matchAll(/(?:from\s+|import\s*)["']([^"']+)["']/g)]
      .map((match) => match[1])
      .filter((specifier) => specifier.startsWith(".") || specifier.startsWith("@/"));
    for (const specifier of specifiers) {
      const resolved = resolveSourceImport(filePath, specifier);
      if (resolved) pending.push(resolved);
    }
  }
  return [...visited];
}

describe("sensitive entry isolation", () => {
  it("keeps analytics out of the sensitive renderer", () => {
    const source = read("./render-sensitive.tsx");
    expect(source).not.toContain("@vercel/analytics");
    expect(source).not.toContain("<Analytics");
  });

  it.each([
    "./evm-token-collection.tsx",
    "./evm-nft-collection.tsx",
    "./sol-collection.tsx"
  ])("routes %s through the sensitive renderer", (entryPath) => {
    const source = read(entryPath);
    expect(source).toContain("render-sensitive");
    expect(source).not.toContain("renderPage");
    expect(source).not.toContain("@vercel/analytics");
  });

  it.each([
    "evm-token-collection.tsx",
    "evm-nft-collection.tsx",
    "sol-collection.tsx"
  ])("keeps Analytics out of the complete %s source graph", (entryName) => {
    const entryPath = fileURLToPath(new URL(`./${entryName}`, import.meta.url));
    const graphSources = collectRelativeModuleGraph(entryPath)
      .map((filePath) => readFileSync(filePath, "utf8"))
      .join("\n");
    expect(graphSources).not.toContain("@vercel/analytics");
    expect(graphSources).not.toContain("<Analytics");
  });
});
