// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvmContractCallRow } from "../lib/evm-contract-call";
import { EvmContractCallResults } from "./EvmContractCallResults";

afterEach(cleanup);

function makeRows(): EvmContractCallRow[] {
  return Array.from({ length: 60 }, (_, index) => ({
    id: `public-call-${index + 1}`,
    index,
    line: index + 1,
    address: `0x${(index + 1).toString(16).padStart(40, "0")}`,
    label: `来源钱包 ${index + 1}`,
    status: "pending",
    amountWei: BigInt(index + 1),
    randomId: BigInt(index),
    calldata: "0x12345678",
    hash: null,
    message: "已准备，等待发送"
  }));
}

describe("EvmContractCallResults", () => {
  it("returns from a later review page to prioritized problems and preserves the selected filter during updates", async () => {
    const user = userEvent.setup();
    const rows = makeRows();
    const props = {
      contractAddress: `0x${"a".repeat(40)}`,
      networkLabel: "Ethereum · 1",
      nativeSymbol: "ETH",
      footer: null,
      onExport: vi.fn()
    };
    const { rerender } = render(<EvmContractCallResults {...props} rows={rows} phase="review" />);
    const table = () => within(screen.getByRole("table", { name: "合约批量调用结果" }));

    expect(table().getAllByRole("row")).toHaveLength(6);
    expect(table().getByText("来源钱包 1")).toBeVisible();
    expect(table().queryByText("来源钱包 6")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "查看全部 60 笔" }));
    expect(table().getAllByRole("row")).toHaveLength(51);
    await user.click(screen.getByRole("button", { name: "下一页调用结果" }));
    expect(screen.getByText("显示 51–60 笔，共 60 笔")).toBeVisible();
    expect(table().getByText("来源钱包 51")).toBeVisible();
    expect(table().queryByText("来源钱包 1")).not.toBeInTheDocument();

    const runningRows = rows.map((row, index): EvmContractCallRow => index === 0
      ? { ...row, status: "unknown", hash: `0x${"b".repeat(64)}`, message: "广播响应不确定，请核对" }
      : index === 1
        ? { ...row, status: "failed", message: "钱包余额不足" }
        : { ...row, status: "signing", message: "正在本地签名" });
    rerender(<EvmContractCallResults {...props} rows={runningRows} phase="running" />);

    expect(screen.getByText("显示 1–50 笔，共 60 笔")).toBeVisible();
    const prioritizedRows = table().getAllByRole("row");
    expect(within(prioritizedRows[1]).getByText("来源钱包 1")).toBeVisible();
    expect(within(prioritizedRows[1]).getByText("广播响应不确定，请核对")).toBeVisible();
    expect(within(prioritizedRows[2]).getByText("来源钱包 2")).toBeVisible();
    expect(within(prioritizedRows[2]).getByText("钱包余额不足")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "失败，1 笔" }));
    expect(table().getAllByRole("row")).toHaveLength(2);
    expect(table().getByText("来源钱包 2")).toBeVisible();
    expect(table().queryByText("来源钱包 1")).not.toBeInTheDocument();

    const updatedRows = runningRows.map((row, index): EvmContractCallRow => index === 59
      ? { ...row, status: "failed", message: "合约执行回滚" }
      : index === 2
        ? { ...row, status: "submitted", hash: `0x${"c".repeat(64)}`, message: "已提交 RPC" }
        : row);
    rerender(<EvmContractCallResults {...props} rows={updatedRows} phase="running" />);

    expect(screen.getByRole("button", { name: "失败，2 笔" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "全部，60 笔" })).toHaveAttribute("aria-pressed", "false");
    expect(table().getAllByRole("row")).toHaveLength(3);
    expect(table().getByText("来源钱包 2")).toBeVisible();
    expect(table().getByText("来源钱包 60")).toBeVisible();
    expect(table().queryByText("来源钱包 1")).not.toBeInTheDocument();
    expect(table().queryByText("来源钱包 3")).not.toBeInTheDocument();

    rerender(<EvmContractCallResults {...props} rows={updatedRows} phase="result" />);
    expect(screen.getByRole("button", { name: "失败，2 笔" })).toHaveAttribute("aria-pressed", "true");
    expect(table().getAllByRole("row")).toHaveLength(3);
  });
});
