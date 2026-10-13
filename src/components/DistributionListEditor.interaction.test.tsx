// @vitest-environment jsdom

import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DistributionListEditor } from "./DistributionListEditor";
import { DistributionListGenerator } from "./DistributionListGenerator";
import type { DistributionAmountMode } from "../lib/distribution-generator";

afterEach(cleanup);

function getAddresses(name = "收款地址") {
  if (!screen.queryByRole("textbox", { name })) {
    fireEvent.click(screen.getByText("编辑原始清单", { selector: "summary" }));
  }
  return screen.getByRole("textbox", { name });
}

function ControlledEditor() {
  const [addresses, setAddresses] = useState("");
  const [fixedAmount, setFixedAmount] = useState("0.1");
  const [minAmount, setMinAmount] = useState("0.5");
  const [maxAmount, setMaxAmount] = useState("1");
  const [mode, setMode] = useState<DistributionAmountMode>("fixed");

  return (
    <DistributionListEditor
      addressPlaceholder="每行一个地址"
      addresses={addresses}
      fixedAmount={fixedAmount}
      fixedAmountStep="0.000000001"
      idPrefix="shared-editor-test"
      maxAmount={maxAmount}
      minAmount={minAmount}
      mode={mode}
      onAddressesChange={setAddresses}
      onFixedAmountChange={setFixedAmount}
      onMaxAmountChange={setMaxAmount}
      onMinAmountChange={setMinAmount}
      onModeChange={setMode}
      randomAmountStep="0.000000001"
      symbol="SOL"
    />
  );
}

describe("DistributionListEditor interactions", () => {
  it('previews imports, supports cancel/append/replace, and restores the previous amount and list on undo', async () => {
    const user = userEvent.setup();
    const one = `0x${'1'.repeat(40)}`;
    const two = `0x${'2'.repeat(40)}`;
    render(<DistributionListGenerator addressKind="evm" decimals={18} initialAddresses={one} initialFixedAmount="0.1" onResultChange={() => undefined} symbol="ETH" />);
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const makeFile = (amount = '0.5') => {
      const file = new File([`${two},${amount}`], 'recipients.csv', { type: 'text/csv' });
      Object.defineProperty(file, 'text', { value: vi.fn().mockResolvedValue(`${two},${amount}`) }); return file;
    };
    await user.upload(fileInput, makeFile());
    let dialog = await screen.findByRole('dialog', { name: '导入收款钱包' });
    expect(within(dialog).getByText('每个地址 0.5 ETH')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(getAddresses()).toHaveValue(one);
    await user.upload(fileInput, makeFile('0.1'));
    dialog = await screen.findByRole('dialog', { name: '导入收款钱包' });
    await user.click(within(dialog).getByRole('button', { name: '追加到当前清单' }));
    expect(getAddresses()).toHaveValue(`${one}\n${two}`);
    expect(screen.getByRole('spinbutton', { name: '每个地址的金额（ETH）' })).toHaveValue(0.1);
    await user.click(screen.getByRole('button', { name: '撤销导入' }));
    expect(getAddresses()).toHaveValue(one);
    await user.upload(fileInput, makeFile());
    dialog = await screen.findByRole('dialog', { name: '导入收款钱包' });
    await user.click(within(dialog).getByRole('button', { name: '替换当前清单' }));
    expect(getAddresses()).toHaveValue(two);
    expect(screen.getByRole('spinbutton', { name: '每个地址的金额（ETH）' })).toHaveValue(0.5);
    await user.click(screen.getByRole('button', { name: '撤销导入' }));
    expect(getAddresses()).toHaveValue(one);
    expect(screen.getByRole('spinbutton', { name: '每个地址的金额（ETH）' })).toHaveValue(0.1);
  });
  it("keeps list actions in its heading and exposes regeneration only for random amounts", async () => {
    const user = userEvent.setup();
    render(
      <DistributionListGenerator addressKind="solana" decimals={9} initialAddresses="11111111111111111111111111111111" onResultChange={() => undefined} symbol="SOL" />
    );
    for (const name of ["去重", "清空"]) {
      expect(screen.getByRole("button", { name }).closest(".distribution-generator__heading")).not.toBeNull();
    }
    expect(screen.queryByRole("button", { name: "重新随机" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "随机区间" }));
    expect(screen.getByRole("button", { name: "重新随机" }).closest(".distribution-generator__heading")).not.toBeNull();
    expect(screen.getByRole("spinbutton", { name: "随机最小值（SOL）" }).closest(".distribution-amount-row"))
      .toBe(screen.getByRole("tab", { name: "随机区间" }).closest(".distribution-amount-row"));
  });

  it("exposes one named file-import action instead of the hidden native input", () => {
    render(
      <DistributionListGenerator
        addressKind="solana"
        decimals={9}
        onResultChange={() => undefined}
        symbol="SOL"
      />
    );

    expect(screen.getByRole("button", { name: "导入收款钱包" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Choose File" })).not.toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).toHaveAttribute("aria-hidden", "true");
    expect(document.querySelector('input[type="file"]')).toHaveAttribute("hidden");
  });

  it("asks before discarding a filled address list", async () => {
    const user = userEvent.setup();
    render(
      <DistributionListGenerator
        addressKind="solana"
        decimals={9}
        onResultChange={() => undefined}
        symbol="SOL"
      />
    );

    const addresses = getAddresses();
    await user.type(addresses, "11111111111111111111111111111111");

    await user.click(screen.getByRole("button", { name: "清空" }));
    expect(addresses).toHaveValue("11111111111111111111111111111111");

    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(addresses).toHaveValue("11111111111111111111111111111111");

    await user.click(screen.getByRole("button", { name: "清空" }));
    await user.click(screen.getByRole("button", { name: "确认清空" }));
    expect(addresses).toHaveValue("");
  });

  it("controls the shared address and fixed/random amount fields", async () => {
    const user = userEvent.setup();
    render(<ControlledEditor />);

    expect(screen.getByRole("tablist", { name: "批量金额模式" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "固定金额" })).toHaveAttribute("aria-controls");
    expect(screen.getByRole("tabpanel")).toBeVisible();

    const addresses = getAddresses();
    await user.type(addresses, "11111111111111111111111111111111");
    expect(addresses).toHaveValue("11111111111111111111111111111111");

    const fixedAmount = screen.getByRole("spinbutton", { name: "每个地址的金额（SOL）" });
    expect(fixedAmount.closest(".generator-amount-grid")).toHaveAttribute("data-mode", "fixed");
    expect(fixedAmount.closest(".generator-amount-grid")).not.toHaveClass("fixed");
    await user.clear(fixedAmount);
    await user.type(fixedAmount, "0.25");
    expect(fixedAmount).toHaveValue(0.25);

    await user.click(screen.getByRole("tab", { name: "随机区间" }));
    expect(screen.getByRole("tab", { name: "随机区间" })).toHaveAttribute("aria-controls");
    const minimum = screen.getByRole("spinbutton", { name: "随机最小值（SOL）" });
    const maximum = screen.getByRole("spinbutton", { name: "随机最大值（SOL）" });
    expect(minimum.closest(".generator-amount-grid")).toHaveAttribute("data-mode", "random");
    expect(minimum).toHaveValue(0.5);
    expect(maximum).toHaveValue(1);

    await user.clear(minimum);
    await user.type(minimum, "0.75");
    expect(minimum).toHaveValue(0.75);
  });
});
