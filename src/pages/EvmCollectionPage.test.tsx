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
});
