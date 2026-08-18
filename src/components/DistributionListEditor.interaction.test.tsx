// @vitest-environment jsdom

import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { DistributionListEditor } from "./DistributionListEditor";
import { DistributionListGenerator } from "./DistributionListGenerator";
import type { DistributionAmountMode } from "../lib/distribution-generator";

afterEach(cleanup);

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
  it("exposes one named file-import action instead of the hidden native input", () => {
    render(
      <DistributionListGenerator
        addressKind="solana"
        decimals={9}
        onResultChange={() => undefined}
        symbol="SOL"
      />
    );

    expect(screen.getByRole("button", { name: "导入 TXT/CSV" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Choose File" })).not.toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).toHaveAttribute("aria-hidden", "true");
    expect(document.querySelector('input[type="file"]')).toHaveAttribute("hidden");
  });

  it("controls the shared address and fixed/random amount fields", async () => {
    const user = userEvent.setup();
    render(<ControlledEditor />);

    expect(screen.getByRole("tablist", { name: "批量金额模式" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "固定金额" })).toHaveAttribute("aria-controls");
    expect(screen.getByRole("tabpanel")).toBeVisible();

    const addresses = screen.getByRole("textbox", { name: "收款地址" });
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
