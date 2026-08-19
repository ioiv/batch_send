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
  it("uses natural page flow without an action footer covering form fields", () => {
    const actionableRule = readRule(".workbench-panel--actionable");
    expect(actionableRule).toContain("position: static");
    expect(actionableRule).toContain("max-height: none");
    expect(actionableRule).toContain("overflow: visible");
    const footerRule = readRule(".workbench-panel__footer");
    expect(footerRule).toContain("position: static");
    expect(footerRule).not.toMatch(/(?:^|\n)\s*bottom:/);
    expect(footerRule).toContain("background:");
  });

  it("keeps every shared workbench and collection workspace single-column", () => {
    expect(readRule(".workbench-grid"))
      .toContain("grid-template-columns: minmax(0, 1fr)");
    expect(readRule(".collection-workspace.has-results"))
      .toContain("grid-template-columns: minmax(0, 1fr)");
  });

  it("keeps the fixed distribution amount in normal flow at full width", () => {
    expect(readRule('.generator-amount-grid[data-mode="fixed"]'))
      .toContain("grid-template-columns: minmax(0, 1fr)");
  });
});
