// @vitest-environment jsdom

import { useState } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  CollectionExecutionControls,
  ConfirmActionDialog,
  ReviewPanel,
  WalletChooserDialog,
  WorkbenchPanel
} from "@/components/WorkbenchPrimitives";
import { SearchableSelect } from "@/components/SearchableSelect";

afterEach(cleanup);

describe("shadcn Base UI interactions", () => {
  it("keeps collection progress visible and toggles pause and resume", async () => {
    const user = userEvent.setup();

    function Harness() {
      const [paused, setPaused] = useState(false);
      return (
        <CollectionExecutionControls
          current={2}
          label="EVM 归集进度"
          onPausedChange={setPaused}
          paused={paused}
          total={5}
        />
      );
    }

    render(<Harness />);
    expect(screen.getByRole("progressbar", { name: "EVM 归集进度" })).toBeVisible();
    expect(screen.getByText("2/5")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "暂停归集" }));
    expect(screen.getByRole("button", { name: "继续归集" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("progressbar", { name: "EVM 归集进度（已暂停）" })).toBeVisible();
  });

  it("keeps a panel footer as the final visible card region", () => {
    render(
      <WorkbenchPanel footer={<Button>运行预检</Button>} title="任务配置">
        <div>长表单内容</div>
      </WorkbenchPanel>
    );

    const panel = screen.getByText("任务配置").closest('[data-slot="card"]');
    const footer = screen.getByRole("button", { name: "运行预检" }).closest('[data-slot="card-footer"]');
    expect(panel).toHaveClass("workbench-panel", "overflow-visible");
    expect(footer).toHaveClass("workbench-panel__footer");
    expect(panel?.lastElementChild).toBe(footer);
  });

  it("keeps review details collapsed until requested and opens them for attention", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ReviewPanel summary={<span>预检通过</span>} title="预检与结果">
        <div>完整预检清单</div>
      </ReviewPanel>
    );

    expect(screen.getByText("预检通过")).toBeVisible();
    expect(screen.queryByText("完整预检清单")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "展开预检与结果" }));
    expect(screen.getByText("完整预检清单")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "收起预检与结果" }));
    expect(screen.queryByText("完整预检清单")).not.toBeInTheDocument();

    rerender(
      <ReviewPanel autoOpen stateKey="error" summary={<span>预检未通过</span>} title="预检与结果">
        <div>完整预检清单</div>
      </ReviewPanel>
    );
    await waitFor(() => expect(screen.getByText("完整预检清单")).toBeVisible());
    await user.click(screen.getByRole("button", { name: "收起预检与结果" }));

    rerender(
      <ReviewPanel autoOpen stateKey="error" summary={<span>仍有一项需处理</span>} title="预检与结果">
        <div>完整预检清单</div>
      </ReviewPanel>
    );
    expect(screen.queryByText("完整预检清单")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "展开预检与结果" }));

    rerender(
      <ReviewPanel stateKey="ready" summary={<span>预检通过</span>} title="预检与结果">
        <div>完整预检清单</div>
      </ReviewPanel>
    );
    await waitFor(() => expect(screen.queryByText("完整预检清单")).not.toBeInTheDocument());
  });

  it("respects the review panel default-open state", () => {
    render(
      <ReviewPanel defaultOpen summary={<span>等待处理</span>} title="预检与结果">
        <div>默认展示的详情</div>
      </ReviewPanel>
    );

    expect(screen.getByText("默认展示的详情")).toBeVisible();
    expect(screen.getByRole("button", { name: "收起预检与结果" })).toHaveAttribute("aria-expanded", "true");
  });

  it("supports pointer and keyboard selection in Tabs", async () => {
    const user = userEvent.setup();

    function Harness() {
      const [value, setValue] = useState("first");
      return (
        <Tabs onValueChange={setValue} value={value}>
          <TabsList aria-label="视图">
            <TabsTrigger value="first">第一个</TabsTrigger>
            <TabsTrigger value="second">第二个</TabsTrigger>
          </TabsList>
          <TabsContent value="first">内容一</TabsContent>
          <TabsContent value="second">内容二</TabsContent>
        </Tabs>
      );
    }

    render(<Harness />);
    const first = screen.getByRole("tab", { name: "第一个" });
    first.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "第二个" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByText("内容二")).toBeVisible();
  });

  it("traps focus in Dialog and restores it to the trigger", async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger render={<Button />}>打开钱包</DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>选择钱包</DialogTitle>
            <DialogDescription>钱包列表</DialogDescription>
          </DialogHeader>
          <DialogClose render={<Button variant="outline" />}>关闭钱包</DialogClose>
        </DialogContent>
      </Dialog>
    );

    const trigger = screen.getByRole("button", { name: "打开钱包" });
    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "选择钱包" })).toBeVisible();
    await user.tab();
    expect(screen.getByRole("dialog", { name: "选择钱包" })).toContainElement(document.activeElement as HTMLElement);
    await user.click(screen.getByRole("button", { name: "关闭钱包" }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("exposes wallet choices as list items and selects one", async () => {
    const user = userEvent.setup();
    const onChoose = vi.fn();
    render(
      <WalletChooserDialog
        choices={[
          { id: "one", name: "钱包一" },
          { id: "two", name: "钱包二" }
        ]}
        label="选择钱包"
        onChoose={onChoose}
        selectedId="one"
      />
    );

    await user.click(screen.getByRole("button", { name: "选择钱包" }));
    const list = screen.getByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    await user.click(within(list).getByRole("button", { name: "钱包二" }));
    expect(onChoose).toHaveBeenCalledWith("two");
  });

  it("cancels and confirms AlertDialog without double controls", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmActionDialog
        confirmLabel="确认执行"
        description="2 笔交易"
        onConfirm={onConfirm}
        title="确认批量发送？"
        triggerLabel="执行"
      />
    );

    const trigger = screen.getByRole("button", { name: "执行" });
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(onConfirm).not.toHaveBeenCalled();
    await waitFor(() => expect(trigger).toHaveFocus());

    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "确认执行" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("closes Sheet with Escape and restores focus", async () => {
    const user = userEvent.setup();
    render(
      <Sheet>
        <SheetTrigger render={<Button />}>原始编辑</SheetTrigger>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>原始资产清单</SheetTitle>
            <SheetDescription>编辑资产</SheetDescription>
          </SheetHeader>
          <SheetClose render={<Button variant="outline" />}>完成</SheetClose>
        </SheetContent>
      </Sheet>
    );

    const trigger = screen.getByRole("button", { name: "原始编辑" });
    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "原始资产清单" })).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "原始资产清单" })).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    });
  });

  it("filters and selects a Combobox option and honors disabled state", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const options = [
      { label: "Ethereum", meta: "1", value: "ethereum" },
      { label: "Base", meta: "8453", value: "base" },
      { label: "Base Sepolia", meta: "84532", value: "base-sepolia" }
    ] as const;

    const { rerender } = render(
      <SearchableSelect id="network" onChange={onChange} options={options} value="ethereum" />
    );
    const input = screen.getByRole("combobox", { name: "搜索选项" });
    expect(screen.getByRole("button", { name: "网络选择" })).toBeEnabled();
    await user.click(input);
    await user.clear(input);
    await user.type(input, "8453");
    const baseOption = screen.getByRole("option", { name: /Base.*8453/ });
    expect(baseOption).toBeVisible();
    expect(baseOption).toHaveClass("pr-7");
    expect(screen.queryByRole("option", { name: /Base Sepolia/ })).not.toBeInTheDocument();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenCalledWith("base");

    rerender(<SearchableSelect disabled id="network" onChange={onChange} options={options} value="ethereum" />);
    expect(screen.getByRole("combobox", { name: "搜索选项" })).toBeDisabled();
  });
});
