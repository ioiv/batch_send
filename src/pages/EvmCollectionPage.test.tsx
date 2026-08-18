import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EvmCollectionPage } from "./EvmCollectionPage";

describe("EvmCollectionPage NFT workbench", () => {
  it("renders the local-first discovery and review path without a hidden contract prerequisite", () => {
    const markup = renderToStaticMarkup(<EvmCollectionPage fixedStandard="nft" />);

    expect(markup.match(/id="nft-quick-contract"/g)).toHaveLength(1);
    expect(markup).toContain("识别持仓");
    expect(markup).toContain("待归集资产");
    expect(markup).toContain("仅链上 Gas · 平台费 0");
    expect(markup).toContain("只读地址识别");
    expect(markup).toContain("私钥归集");
    expect(markup).toContain("预检准备项");
    expect(markup).toContain("识别来源");
    expect(markup).toContain("签名密钥");
    expect(markup).toContain("不上传密钥、不收平台费、不调用收费归集合约");
    expect(markup).not.toContain("加入并生成归集预览");
    expect(markup).not.toContain("执行结果");

    expect(markup.indexOf("来源钱包")).toBeLessThan(markup.indexOf("添加方式"));
    expect(markup.indexOf("添加方式")).toBeLessThan(markup.indexOf("待归集资产"));
    expect(markup.indexOf("待归集资产")).toBeLessThan(markup.indexOf("归集到"));
  });

  it("uses the same source-first workbench for ERC20 collection", () => {
    const markup = renderToStaticMarkup(<EvmCollectionPage fixedStandard="erc20" />);
    const sourceIndex = markup.indexOf('id="collection-source-title"');
    const walletListIndex = markup.indexOf('id="collection-results-title"');
    const networkIndex = markup.indexOf('id="evm-collection-network"');
    const assetIndex = markup.indexOf('id="collection-assets-title"');
    const targetIndex = markup.indexOf('id="collection-target-title"');
    const commandIndex = markup.indexOf('id="collection-command-title"');

    expect(markup).toContain("collection-workbench-panel");
    expect(markup).toContain("collection-source-section collection-source-board");
    expect(markup).toContain("collection-results is-embedded");
    expect(markup).toContain("collection-settings-grid");
    expect(markup).toContain("collection-command-panel collection-command-panel--inline");
    expect(markup).not.toContain("collection-command-rail");

    expect(sourceIndex).toBeGreaterThan(-1);
    expect(sourceIndex).toBeLessThan(walletListIndex);
    expect(walletListIndex).toBeLessThan(networkIndex);
    expect(networkIndex).toBeLessThan(assetIndex);
    expect(assetIndex).toBeLessThan(targetIndex);
    expect(targetIndex).toBeLessThan(commandIndex);
  });
});
