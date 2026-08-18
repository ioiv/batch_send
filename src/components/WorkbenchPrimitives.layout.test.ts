import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appCss = readFileSync(new URL("../app.css", import.meta.url), "utf8");

function readRule(selector: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = appCss.match(new RegExp(`${escapedSelector}\\s*\\{([^}]+)\\}`));
  expect(match, `missing CSS rule for ${selector}`).not.toBeNull();
  return match?.[1] || "";
}

describe("workbench layout CSS contract", () => {
  it("keeps actions visible in a bounded panel without covering its content", () => {
    const actionableRule = readRule(".workbench-panel--actionable");
    expect(actionableRule).toContain("position: sticky");
    expect(actionableRule).toContain("max-height:");
    expect(actionableRule).toContain("overflow: hidden");
    const footerRule = readRule(".workbench-panel__footer");
    expect(footerRule).toContain("position: static");
    expect(footerRule).toContain("background:");
  });

  it("collapses the shared workbench grid at the 1024px boundary", () => {
    const compactRules = appCss.match(/@media \(max-width: 64rem\) \{([\s\S]*?)@media \(max-width: 48rem\)/)?.[1] || "";
    expect(compactRules).toMatch(/\.workbench-grid,[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(compactRules).toMatch(/\.workbench-panel--actionable\s*\{[\s\S]*?position:\s*static/);
  });

  it("keeps the fixed distribution amount in normal flow at full width", () => {
    expect(readRule('.generator-amount-grid[data-mode="fixed"]'))
      .toContain("grid-template-columns: minmax(0, 1fr)");
  });
});
