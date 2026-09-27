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

  it("gives a wallet's execution status its own line instead of overlapping the address", () => {
    // In the two-column form the wallet list is about 34rem wide; a status block
    // squeezed beside the address collapsed the address column to 0px under it.
    expect(readRule(".imported-wallet-row")).toContain("grid-template-columns: auto minmax(10rem, 1fr)");
    expect(readRule(".imported-wallet-statuses,\n.imported-wallet-status-summary"))
      .toContain("grid-column: 2 / -1");
    expect(readRule(".imported-wallet-statuses")).not.toMatch(/min-width:\s*min\(/);
    // Explicit tracks: a row without balances must not slide its status into
    // the balance column.
    expect(readRule(".imported-wallet-balances")).toContain("grid-area: 1 / 3");
    expect(readRule(".imported-wallet-remove")).toContain("grid-area: 1 / 4");
    // The row answers to the list's width, not the viewport's.
    expect(readRule(".imported-wallet-browser")).toContain("container: imported-wallets / inline-size");
  });

  it("caps the pasted address list so it cannot outgrow the settings column", () => {
    expect(appCss).toMatch(/\.address-only-input \{\s*max-height: min\(22rem, 50dvh\);\s*overflow-y: auto;/);
  });
});
