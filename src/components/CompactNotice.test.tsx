// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompactNotice, NoticeDetail, NoticeTitle } from "./CompactNotice";
import { Button } from "./ui/button";

afterEach(cleanup);

describe("CompactNotice", () => {
  it("keeps status and recovery visible while putting detail in help", async () => {
    const retry = vi.fn();
    const user = userEvent.setup();
    render(<CompactNotice variant="destructive"><NoticeTitle>余额读取失败</NoticeTitle><NoticeDetail>RPC 请求超时，请切换节点后重试。</NoticeDetail><Button onClick={retry}>重试</Button></CompactNotice>);
    expect(screen.getByRole("alert")).toHaveTextContent("余额读取失败");
    expect(screen.queryByText("RPC 请求超时，请切换节点后重试。")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(retry).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "说明：余额读取失败" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("RPC 请求超时");
  });

  it("also preserves direct buttons when a separate summary is supplied", () => {
    render(<CompactNotice summary="查询失败" tone="error">完整错误<Button>重试读取</Button></CompactNotice>);
    expect(screen.getByRole("button", { name: "重试读取" })).toBeVisible();
    expect(screen.queryByText("完整错误")).not.toBeInTheDocument();
  });

  it("renders static explanation as a question mark without a notice panel", async () => {
    const user = userEvent.setup();
    render(<CompactNotice>扫描不发送交易</CompactNotice>);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText("扫描不发送交易")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "说明：详细说明" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("扫描不发送交易");
  });
});
