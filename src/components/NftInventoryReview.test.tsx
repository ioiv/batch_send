import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseEvmCollectionAssets } from "../lib/evm-collection";
import {
  NftInventoryReview,
  removeValidNftInventoryAssets
} from "./NftInventoryReview";

const contractOne = "0x00000000000000000000000000000000000000a1";
const contractTwo = "0x00000000000000000000000000000000000000b2";

function renderReview(props: Partial<Parameters<typeof NftInventoryReview>[0]> = {}) {
  return renderToStaticMarkup(
    <NftInventoryReview
      assetInput=""
      onChange={() => undefined}
      standard="erc721"
      {...props}
    />
  );
}

describe("NftInventoryReview", () => {
  it("renders an accessible empty inventory without NFT artwork", () => {
    const markup = renderReview();

    expect(markup).toContain("待归集资产");
    expect(markup).toContain("资产清单还是空的");
    expect(markup).toContain("无效原始行仍会保留");
    expect(markup).not.toContain("<img");
  });

  it("shows contract names, short addresses, token IDs, selection, and single-row removal", () => {
    const markup = renderReview({
      assetInput: `${contractOne},42\n${contractTwo},9007199254740993`,
      contractLabels: new Map([[contractOne.toLowerCase(), "Inference Angels"]])
    });

    expect(markup).toContain("Inference Angels");
    expect(markup).toContain("未读取名称");
    expect(markup).toMatch(/0x0000…00A1/i);
    expect(markup).toContain(">42<");
    expect(markup).toContain(">9007199254740993<");
    expect(markup).toContain("1 枚");
    expect(markup).toContain('aria-label="选择第 1 行 NFT"');
    expect(markup).toContain('aria-label="移除第 2 行 NFT"');
    expect(markup).toContain("选择全部用于移除");
    expect(markup).toContain("已选 0 项待移除");
    expect(markup).toContain("清空选择");
    expect(markup).toContain("移除选中项");
    expect(markup).toContain("移除全部");
  });

  it("explains ERC1155 all-balance semantics and retains invalid source rows in review", () => {
    const markup = renderReview({
      assetInput: `${contractOne},7\nnot-an-address,8`,
      standard: "erc1155"
    });

    expect(markup).toContain("全部余额");
    expect(markup).toContain("执行时读取该 Token ID 的可转余额");
    expect(markup).toContain("第 2 行无效");
    expect(markup).toContain("not-an-address,8");
    expect(markup).toContain("合约地址格式不正确");
    expect(markup).toContain("保留原始行");
    expect(markup.match(/type="checkbox"/g)).toHaveLength(2);
  });

  it("disables every inventory mutation control when requested", () => {
    const markup = renderReview({ assetInput: `${contractOne},1`, disabled: true });

    expect(markup.match(/<input(?=[^>]*type="checkbox")(?=[^>]*disabled="")[^>]*>/g)).toHaveLength(2);
    expect(markup.match(/<button(?=[^>]*disabled="")[^>]*>/g)).toHaveLength(4);
  });
});

describe("removeValidNftInventoryAssets", () => {
  it("removes selected valid assets while preserving invalid source rows verbatim", () => {
    const input = `${contractOne},1\n  not-an-address,2  \n${contractTwo},3\n`;
    const parsed = parseEvmCollectionAssets(input, "erc721");
    const result = removeValidNftInventoryAssets(input, "erc721", [parsed.assets[0].key]);

    expect(result).toBe(`  not-an-address,2  \n${contractTwo},3\n`);
  });

  it("clears all valid and duplicate asset rows but never drops malformed input", () => {
    const input = `${contractOne},1\r\nbad,2\r\n${contractOne},1`;
    const parsed = parseEvmCollectionAssets(input, "erc1155");
    const result = removeValidNftInventoryAssets(
      input,
      "erc1155",
      parsed.assets.map((asset) => asset.key)
    );

    expect(result).toBe("bad,2");
  });
});
