import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SolCollectionPage } from "./SolCollectionPage";

describe("SolCollectionPage workbench", () => {
  it("renders one continuous source-to-execution flow", () => {
    const markup = renderToStaticMarkup(<SolCollectionPage />);
    const sourceIndex = markup.indexOf('id="sol-collection-source-title">来源钱包');
    const walletListIndex = markup.indexOf('id="collection-results-title">钱包清单');
    const networkIndex = markup.indexOf('id="sol-collection-network-title">网络与节点');
    const targetIndex = markup.indexOf('id="sol-collection-target-title">目标与金额');
    const commandIndex = markup.indexOf('id="sol-collection-command-title">检查并执行');

    expect(markup).toContain("批量归集工作台");
    expect(markup).toContain("collection-ready-count");
    expect(markup).toContain("collection-workbench-panel");
    expect(markup).toContain("collection-source-section collection-source-board");
    expect(markup).toContain("collection-results is-embedded");
    expect(markup).toContain("collection-settings-grid");
    expect(markup).toContain("collection-flow-section collection-network-section");
    expect(markup).toContain("collection-flow-section collection-target-section");
    expect(markup).toContain("collection-command-panel collection-command-panel--inline");
    expect(markup).not.toContain("collection-command-rail");

    expect(sourceIndex).toBeGreaterThan(-1);
    expect(sourceIndex).toBeLessThan(walletListIndex);
    expect(walletListIndex).toBeLessThan(networkIndex);
    expect(networkIndex).toBeLessThan(targetIndex);
    expect(targetIndex).toBeLessThan(commandIndex);
  });
});
