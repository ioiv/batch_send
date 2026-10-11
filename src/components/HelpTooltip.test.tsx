// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HelpTooltip, helpTooltipDelayMs } from "./HelpTooltip";

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("HelpTooltip", () => {
  it("opens on delayed hover and renders outside clipped containers", async () => {
    const user = userEvent.setup();
    render(<div data-testid="clipped" style={{ overflow: "hidden" }}><HelpTooltip label="数量说明">完整数量说明</HelpTooltip></div>);
    const trigger = screen.getByRole("button", { name: "说明：数量说明" });
    await user.hover(trigger);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("dialog", { name: "数量说明" })).toBeVisible(), { timeout: helpTooltipDelayMs + 700 });
    expect(screen.getByTestId("clipped")).not.toContainElement(screen.getByRole("dialog"));
    await user.unhover(trigger);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("toggles by click and closes when clicking outside", async () => {
    const user = userEvent.setup();
    render(<><HelpTooltip label="RPC">RPC 地址说明</HelpTooltip><button>外部</button></>);
    const trigger = screen.getByRole("button", { name: "说明：RPC" });
    await user.click(trigger);
    expect(screen.getByRole("dialog")).toHaveTextContent("RPC 地址说明");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await user.click(trigger);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "外部" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("opens with Enter or Space and Escape returns focus to its button", async () => {
    const user = userEvent.setup();
    render(<HelpTooltip label="Gas">网络费说明</HelpTooltip>);
    const trigger = screen.getByRole("button", { name: "说明：Gas" });
    trigger.focus();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog")).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    await user.keyboard(" ");
    expect(screen.getByRole("dialog")).toBeVisible();
  });

  it("supports a touch click without checking an enclosing label or submitting", async () => {
    const submit = vi.fn();
    const parentClick = vi.fn();
    const user = userEvent.setup();
    render(<form onSubmit={submit}><label onClick={parentClick}><input type="checkbox" />原生币<HelpTooltip label="原生币说明">最后转出原生币</HelpTooltip></label></form>);
    const trigger = screen.getByRole("button", { name: "说明：原生币说明" });
    fireEvent.pointerDown(trigger, { pointerType: "touch" });
    fireEvent.pointerUp(trigger, { pointerType: "touch" });
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByRole("dialog")).toBeVisible());
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(parentClick).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
  });

  it("keeps interactive detail available without bubbling clicks", async () => {
    const user = userEvent.setup();
    const copy = vi.fn();
    const parent = vi.fn();
    render(<div onClick={parent}><HelpTooltip label="资产明细"><button onClick={copy}>复制地址</button></HelpTooltip></div>);
    await user.click(screen.getByRole("button", { name: "说明：资产明细" }));
    await user.click(screen.getByRole("button", { name: "复制地址" }));
    expect(copy).toHaveBeenCalledOnce();
    expect(parent).not.toHaveBeenCalled();
  });
  it("does not steal focus when the user moves to a field as the popup closes", async () => {
    const user = userEvent.setup();
    render(<><HelpTooltip label="说明内容">详情</HelpTooltip><input aria-label="目标地址" /></>);
    const trigger = screen.getByRole("button", { name: "说明：说明内容" });
    trigger.focus();
    await user.keyboard("{Enter}");
    fireEvent.keyDown(trigger, { key: "Escape", code: "Escape" });
    const field = screen.getByRole("textbox", { name: "目标地址" });
    field.focus();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(field).toHaveFocus();
    await user.keyboard("0x123");
    expect(field).toHaveValue("0x123");
  });
});
