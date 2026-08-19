// @vitest-environment jsdom

import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NftAssetInput } from "./NftAssetInput";

afterEach(cleanup);

function Harness({ auto = false, autoOnly = false, disabled = false, initialValue = "" }) {
  const [value, setValue] = useState(initialValue);
  const [contractAddress, setContractAddress] = useState("");
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
        contractAddress="0x1111111111111111111111111111111111111111"
        disabled
        onChange={onChange}
        onContractAddressChange={vi.fn()}
        value=""
      />
    );
    expect(screen.getByLabelText("NFT 合约")).toHaveValue("0x1111111111111111111111111111111111111111");
    expect(screen.getByRole("tab", { name: "手工 / 文件" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "导入 TXT/CSV" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "原始编辑" })).not.toBeInTheDocument();
  });
});
