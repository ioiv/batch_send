// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DistributionListGenerator } from "./DistributionListGenerator";
import type { GeneratedDistributionList } from "../lib/distribution-generator";

const one = "11111111111111111111111111111111";
const two = "BPFLoader1111111111111111111111111111111111";
const three = "Vote111111111111111111111111111111111111111";
afterEach(cleanup);

function setup() {
  const onResultChange = vi.fn<(result: GeneratedDistributionList) => void>();
  const user = userEvent.setup();
  render(<DistributionListGenerator addressKind="solana" decimals={9} initialAddresses={one} initialFixedAmount="0.1" onResultChange={onResultChange} symbol="SOL" />);
  const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  return {
    user,
    result: () => onResultChange.mock.calls.at(-1)![0],
    upload: async (text: string) => {
      const file = new File([text], "sol-unsent-distribution.csv", { type: "text/csv" });
      Object.defineProperty(file, "text", { value: vi.fn().mockResolvedValue(text) });
      await user.upload(fileInput, file);
    }
  };
}

describe("DistributionListGenerator per-row amounts", () => {
  it("imports an exported unsent CSV without changing its original amounts and can undo", async () => {
    const { user, upload, result } = setup();
    const exact = `${two},0.123456789\n${three},0.987654321`;
    await upload(exact);
    const dialog = await screen.findByRole("dialog", { name: "确认导入收款清单" });
    expect(within(dialog).getByText("逐行原金额（不重新计算）")).toBeVisible();
    expect(within(dialog).getByText(`${two},0.123456789`)).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "追加到当前清单" })).toBeDisabled();
    expect(within(dialog).getByText(/文件金额与当前金额规则不同，只能替换/)).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "替换当前清单" }));
    expect(screen.getByRole("textbox", { name: "收款地址与金额" })).toHaveValue(exact);
    expect(screen.getByRole("tab", { name: "逐行金额" })).toHaveAttribute("aria-selected", "true");
    expect(result()).toMatchObject({ output: exact, totalUnits: 1_111_111_110n, invalid: 0 });
    await user.click(screen.getByRole("button", { name: "撤销导入" }));
    expect(screen.getByRole("textbox", { name: "收款地址" })).toHaveValue(one);
    expect(screen.getByRole("spinbutton", { name: "每个地址的金额（SOL）" })).toHaveValue(0.1);
    expect(result().output).toBe(`${one},0.1`);
  });

  it("keeps current random amounts intact on import cancellation, undo, and conversion", async () => {
    const { user, upload, result } = setup();
    await user.click(screen.getByRole("tab", { name: "随机区间" }));
    const randomOutput = result().output;
    await upload(`${two},0.123456789\n${three},0.987654321`);
    let dialog = await screen.findByRole("dialog", { name: "确认导入收款清单" });
    expect(within(dialog).getByRole("button", { name: "追加到当前清单" })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(result().output).toBe(randomOutput);
    await upload(`${two},0.123456789\n${three},0.987654321`);
    dialog = await screen.findByRole("dialog", { name: "确认导入收款清单" });
    await user.click(within(dialog).getByRole("button", { name: "替换当前清单" }));
    await user.click(screen.getByRole("button", { name: "撤销导入" }));
    expect(result().output).toBe(randomOutput);
    expect(screen.getByRole("tab", { name: "随机区间" })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("tab", { name: "逐行金额" }));
    expect(result().output).toBe(randomOutput);
    expect(screen.getByRole("textbox", { name: "收款地址与金额" })).toHaveValue(randomOutput);
    expect(screen.queryByRole("button", { name: "重新随机" })).not.toBeInTheDocument();
  });

  it("appends exact rows in per-row mode and deduplicates by address without replacing its amount", async () => {
    const { user, upload, result } = setup();
    await user.click(screen.getByRole("tab", { name: "逐行金额" }));
    await upload(`${one},9\n${two},0.000000001`);
    const dialog = await screen.findByRole("dialog", { name: "确认导入收款清单" });
    expect(within(dialog).getByText("1 条（导入后可去重）")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "追加到当前清单" }));
    expect(screen.getByRole("textbox", { name: "收款地址与金额" })).toHaveValue(`${one},0.1\n${one},9\n${two},0.000000001`);
    expect(result().duplicates).toBe(1);
    await user.click(screen.getByRole("button", { name: "去重" }));
    expect(result()).toMatchObject({ output: `${one},0.1\n${two},0.000000001`, duplicates: 0, totalUnits: 100_000_001n });
  });

  it.each([
    `${two},0.123456789\n${three}`,
    `${two},0`,
    `${two},0.0000000001`,
    `${two},18446744073.709551616`,
    `${two},1\n${two},0`,
    `${two},1,2`,
    `${two},`
  ])("rejects missing or invalid amounts without mutating the current list: %s", async (text) => {
    const { upload, result } = setup();
    await upload(text);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("未修改当前清单"));
    expect(screen.queryByRole("dialog", { name: "确认导入收款清单" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "收款地址" })).toHaveValue(one);
    expect(result().output).toBe(`${one},0.1`);
  });

  it("rejects a pure-address file in per-row mode rather than assigning an unstated amount", async () => {
    const { user, upload, result } = setup();
    await user.click(screen.getByRole("tab", { name: "逐行金额" }));
    await upload(two);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("文件未提供金额"));
    expect(result().output).toBe(`${one},0.1`);
  });

  it("allows only replacement when an amount-bearing file differs from the fixed rule", async () => {
    const { upload } = setup();
    await upload(`${two},0.2`);
    const dialog = await screen.findByRole("dialog", { name: "确认导入收款清单" });
    expect(within(dialog).getByRole("button", { name: "追加到当前清单" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "替换当前清单" })).toBeEnabled();
  });
});
