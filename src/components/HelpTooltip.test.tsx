// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HelpTooltip, helpTooltipDelayMs } from "./HelpTooltip";

describe("HelpTooltip", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows help only after the pointer stays for 450ms", () => {
    render(<HelpTooltip label="并发钱包数说明">自动并发说明</HelpTooltip>);

    const trigger = screen.getByLabelText("并发钱包数说明");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    fireEvent.mouseEnter(trigger);
    act(() => vi.advanceTimersByTime(helpTooltipDelayMs - 1));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("tooltip")).toHaveTextContent("自动并发说明");

    fireEvent.mouseLeave(trigger);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("does not show help on click or focus", () => {
    render(<HelpTooltip label="数量说明">合计数量说明</HelpTooltip>);

    const trigger = screen.getByLabelText("数量说明");
    fireEvent.click(trigger);
    fireEvent.focus(trigger);
    act(() => vi.advanceTimersByTime(helpTooltipDelayMs));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});
