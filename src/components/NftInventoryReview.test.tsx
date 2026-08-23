// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEvmCollectionAssets } from "../lib/evm-collection";
import { NftInventoryReview, removeValidNftInventoryAssets } from "./NftInventoryReview";

const contractOne = "0x00000000000000000000000000000000000000a1";
const contractTwo = "0x00000000000000000000000000000000000000b2";

afterEach(cleanup);

describe("NftInventoryReview", () => {
  it("renders a concise accessible empty state", () => {
    render(<NftInventoryReview assetInput="" onChange={vi.fn()} standard="erc721" />);
    expect(screen.getByRole("heading", { name: "当前待归集资产" })).toBeVisible();
    expect(screen.getByText("暂无资产")).toBeVisible();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("renders an accessible table and removes one selected asset", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <NftInventoryReview
        assetInput={`${contractOne},42\n${contractTwo},9007199254740993`}
        contractLabels={new Map([[contractOne.toLowerCase(), "Inference Angels"]])}
        onChange={onChange}
        standard="erc721"
      />
    );

    expect(screen.getByRole("table", { name: "ERC721 待归集资产清单" })).toBeVisible();
    expect(screen.getByText("Inference Angels")).toBeVisible();
    expect(screen.getByText("9007199254740993")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "移除第 2 行 NFT" }));
    expect(onChange).toHaveBeenCalledWith(`${contractOne},42`);
  });

  it("keeps malformed rows and confirms remove-all through AlertDialog", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <NftInventoryReview
        assetInput={`${contractOne},7\nnot-an-address,8`}
        onChange={onChange}
        standard="erc1155"
      />
    );

    expect(screen.getByText("全部余额")).toBeVisible();
    expect(screen.getByText("第 2 行无效")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "移除全部" }));
    const cancelDialog = screen.getByRole("alertdialog", { name: "移除全部有效资产？" });
    expect(cancelDialog).toBeVisible();
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(onChange).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "移除全部" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "移除全部" }));
    expect(onChange).toHaveBeenCalledWith("not-an-address,8");
  });

  it("disables every inventory mutation control", () => {
    render(<NftInventoryReview assetInput={`${contractOne},1`} disabled onChange={vi.fn()} standard="erc721" />);
    expect(screen.getByRole("checkbox", { name: "选择全部" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("checkbox", { name: "选择第 1 行 NFT" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "移除第 1 行 NFT" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "移除全部" })).toBeDisabled();
  });

  it("shows execution state in the asset row and renders a successful hash as a green explorer link", () => {
    const assetKey = `erc721:${contractOne.toLowerCase()}:42`;
    const hash = `0x${"ab".repeat(32)}`;
    render(
      <NftInventoryReview
        assetInput={`${contractOne},42`}
        onChange={vi.fn()}
        results={[{
          address: contractTwo,
          asset: "ERC721 #42",
          assetKey,
          explorerUrl: `https://scan.example/tx/${hash}`,
          hash,
          label: "来源一",
          message: "交易已确认",
          status: "success"
        }]}
        standard="erc721"
      />
    );

    const link = screen.getByRole("link", { name: new RegExp(`查看 来源一 的交易 ${hash}`) });
    expect(screen.getByRole("heading", { name: "本轮资产结果" })).toBeVisible();
    expect(screen.getByText("完成 1")).toBeVisible();
    expect(screen.queryByRole("checkbox", { name: "选择全部" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "移除第 1 行 NFT" })).not.toBeInTheDocument();
    expect(link).toHaveAttribute("href", `https://scan.example/tx/${hash}`);
    expect(link).toHaveTextContent(/^0xabababab…ababab$/);
    expect(link).toHaveClass("nft-inventory-review__hash");
  });

  it("confirms single and bulk retry while excluding uncertain failures", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const firstKey = `erc721:${contractOne.toLowerCase()}:42`;
    const secondKey = `erc721:${contractTwo.toLowerCase()}:7`;
    render(
      <NftInventoryReview
        assetInput={`${contractOne},42\n${contractTwo},7`}
        onChange={vi.fn()}
        onRetry={onRetry}
        results={[
          {
            address: contractTwo,
            asset: "ERC721 #42",
            assetKey: firstKey,
            executionId: "retry-42",
            message: "RPC 请求失败",
            retryable: true,
            status: "error"
          },
          {
            address: contractOne,
            asset: "ERC721 #42",
            assetKey: firstKey,
            executionId: "uncertain-42",
            hash: `0x${"cd".repeat(32)}`,
            message: "确认状态不确定",
            retryable: false,
            status: "error",
            uncertain: true
          },
          {
            address: contractOne,
            asset: "ERC721 #7",
            assetKey: secondKey,
            executionId: "retry-7",
            message: "模拟失败",
            retryable: true,
            status: "error"
          }
        ]}
        standard="erc721"
      />
    );

    expect(screen.getByText("需核对")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /重试 .*Token ID 42/ }));
    await user.click(within(screen.getByRole("alertdialog", { name: "重试该失败项？" }))
      .getByRole("button", { name: "确认重试" }));
    expect(onRetry).toHaveBeenLastCalledWith(["retry-42"]);

    await user.click(screen.getByRole("button", { name: "重试全部失败项 (2)" }));
    await user.click(within(screen.getByRole("alertdialog", { name: "重试全部可安全重试的失败项？" }))
      .getByRole("button", { name: "重试 2 个失败项" }));
    expect(onRetry).toHaveBeenLastCalledWith(["retry-42", "retry-7"]);
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
    const result = removeValidNftInventoryAssets(input, "erc1155", parsed.assets.map((asset) => asset.key));
    expect(result).toBe("bad,2");
  });
});
