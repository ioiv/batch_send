// @vitest-environment jsdom

import { useState } from "react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NftAssetInput } from "./NftAssetInput";

afterEach(cleanup);

const contractOne = "0x1111111111111111111111111111111111111111";
const contractTwo = "0x2222222222222222222222222222222222222222";

function Harness({ auto = false, autoOnly = false, disabled = false, initialValue = "", initialContract = "" }) {
  const [value, setValue] = useState(initialValue);
  const [contractAddress, setContractAddress] = useState(initialContract);
  return (
    <NftAssetInput
      autoOnly={autoOnly}
      autoDiscovery={auto ? <div>发现结果</div> : undefined}
      contractAddress={contractAddress}
      defaultMode={auto ? "auto" : "manual"}
      disabled={disabled}
      onChange={setValue}
      onContractAddressChange={setContractAddress}
      value={value}
    />
  );
}

describe("NftAssetInput", () => {
  it("can expose automatic discovery without a manual-entry mode selector", () => {
    render(<Harness auto autoOnly />);

    expect(screen.getByText("发现结果")).toBeVisible();
    expect(screen.queryByRole("tab", { name: "自动识别" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "手工 / 文件" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Token ID / 区间")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "原始编辑" })).not.toBeInTheDocument();
  });

  it("merges manual and file entry into one tab", () => {
    render(<Harness />);
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "手工 / 文件" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "导入 TXT/CSV" })).toBeEnabled();
    expect(screen.queryByRole("tab", { name: "文件导入" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "高级编辑" })).not.toBeInTheDocument();
  });

  it("switches between automatic discovery and the merged entry panel", async () => {
    const user = userEvent.setup();
    render(<Harness auto />);
    expect(screen.getByRole("tab", { name: "自动识别" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("发现结果")).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "手工 / 文件" }));
    expect(screen.getByLabelText("Token ID / 区间")).toBeVisible();
  });

  it("preserves the controlled contract value and disables every active entry control", () => {
    const onChange = vi.fn();
    render(
      <NftAssetInput
        contractAddress={contractOne}
        disabled
        onChange={onChange}
        onContractAddressChange={vi.fn()}
        value={`${contractOne},7`}
      />
    );
    expect(screen.getByLabelText("NFT 合约")).toHaveValue(contractOne);
    expect(screen.getByRole("tab", { name: "手工 / 文件" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "导入 TXT/CSV" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "移除第 1 行 NFT" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "移除全部" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "选择全部" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("checkbox", { name: "选择第 1 行 NFT" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("button", { name: "原始编辑" })).not.toBeInTheDocument();
  });

  it("shows manually added Token IDs and keeps the remaining entries after removing one", async () => {
    const user = userEvent.setup();
    render(<Harness initialContract={contractOne} />);

    await user.type(screen.getByLabelText("Token ID / 区间"), "7,9-10");
    await user.click(screen.getByRole("button", { name: "加入清单" }));

    const table = screen.getByRole("table", { name: "ERC721 待归集资产清单" });
    expect(screen.getByLabelText("Token ID / 区间")).toHaveValue("");
    expect(within(table).getByText("7")).toBeVisible();
    expect(within(table).getByText("9")).toBeVisible();
    expect(within(table).getByText("10")).toBeVisible();
    expect(screen.getByText("3 个有效")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "移除第 2 行 NFT" }));

    expect(within(table).queryByText("9")).not.toBeInTheDocument();
    expect(within(table).getByText("7")).toBeVisible();
    expect(within(table).getByText("10")).toBeVisible();
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(screen.getByText("2 个有效")).toBeVisible();
  });

  it("distinguishes the same Token ID on different contracts when removing an entry", async () => {
    const user = userEvent.setup();
    render(<Harness initialContract={contractOne} />);

    await user.type(screen.getByLabelText("Token ID / 区间"), "42");
    await user.click(screen.getByRole("button", { name: "加入清单" }));
    await user.clear(screen.getByLabelText("NFT 合约"));
    await user.type(screen.getByLabelText("NFT 合约"), contractTwo);
    await user.type(screen.getByLabelText("Token ID / 区间"), "42");
    await user.click(screen.getByRole("button", { name: "加入清单" }));

    const table = screen.getByRole("table", { name: "ERC721 待归集资产清单" });
    expect(within(table).getAllByText("42")).toHaveLength(2);
    expect(within(table).getByTitle(contractOne)).toBeVisible();
    expect(within(table).getByTitle(contractTwo)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "移除第 1 行 NFT" }));

    expect(within(table).getAllByText("42")).toHaveLength(1);
    expect(within(table).queryByTitle(contractOne)).not.toBeInTheDocument();
    expect(within(table).getByTitle(contractTwo)).toBeVisible();
    expect(screen.getByText("1 个有效")).toBeVisible();
  });

  it("shows file imports in the same editable inventory", async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness initialValue={`${contractOne},7`} />);
    const file = new File([`${contractTwo},42`], "nfts.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", { value: vi.fn().mockResolvedValue(`${contractTwo},42`) });

    await user.upload(container.querySelector<HTMLInputElement>('input[type="file"]')!, file);

    const table = screen.getByRole("table", { name: "ERC721 待归集资产清单" });
    expect(within(table).getByText("7")).toBeVisible();
    expect(within(table).getByText("42")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "移除第 2 行 NFT" }));
    expect(within(table).getByText("7")).toBeVisible();
    expect(within(table).queryByText("42")).not.toBeInTheDocument();
    expect(screen.getByText("1 个有效")).toBeVisible();
  });

  it("locks inventory changes while a file import is pending", async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness initialValue={`${contractOne},7`} />);
    let finishRead!: (value: string) => void;
    const file = new File([`${contractTwo},42`], "nfts.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", {
      value: () => new Promise<string>((resolve) => { finishRead = resolve; })
    });

    await user.upload(container.querySelector<HTMLInputElement>('input[type="file"]')!, file);

    expect(screen.getByRole("button", { name: "正在导入" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "移除第 1 行 NFT" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "移除全部" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "移除第 1 行 NFT" }));
    expect(screen.getByText("7")).toBeVisible();

    await act(async () => finishRead(`${contractTwo},42`));

    expect(screen.getByText("2 个有效")).toBeVisible();
    expect(screen.getByRole("button", { name: "移除第 1 行 NFT" })).toBeEnabled();
  });

  it("uses the current controlled inventory and standard after switching NFT standards", async () => {
    const user = userEvent.setup();
    function StandardHarness() {
      const [standard, setStandard] = useState<"erc721" | "erc1155">("erc721");
      const [values, setValues] = useState({
        erc721: `${contractOne},7`,
        erc1155: `${contractTwo},42`
      });
      return (
        <NftAssetInput
          contractAddress={contractOne}
          onChange={(value) => setValues((previous) => ({ ...previous, [standard]: value }))}
          onContractAddressChange={vi.fn()}
          onStandardChange={setStandard}
          standard={standard}
          value={values[standard]}
        />
      );
    }
    render(<StandardHarness />);

    expect(screen.getByRole("table", { name: "ERC721 待归集资产清单" })).toBeVisible();
    expect(screen.getByText("7")).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "ERC1155" }));

    const erc1155Table = screen.getByRole("table", { name: "ERC1155 待归集资产清单" });
    expect(within(erc1155Table).getByText("42")).toBeVisible();
    expect(within(erc1155Table).getByText("全部余额")).toBeVisible();
    expect(within(erc1155Table).queryByText("7")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "移除第 1 行 NFT" }));
    expect(screen.getByText("暂无资产")).toBeVisible();

    await user.click(screen.getByRole("tab", { name: "ERC721" }));
    expect(screen.getByRole("table", { name: "ERC721 待归集资产清单" })).toBeVisible();
    expect(screen.getByText("7")).toBeVisible();
    expect(screen.getByText("1 个有效")).toBeVisible();
  });
});
