// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DistributionListGenerator, type DistributionListGeneratorHandle } from "./DistributionListGenerator";
import type { GeneratedDistributionList } from "../lib/distribution-generator";

const xlsxReader = vi.hoisted(() => vi.fn());
vi.mock("../lib/wallet-xlsx-import", () => ({ readWalletXlsxFile: xlsxReader }));

const one = `0x${"1".repeat(40)}`;
const two = `0x${"2".repeat(40)}`;
const three = `0x${"3".repeat(40)}`;
afterEach(() => { cleanup(); xlsxReader.mockReset(); });

function file(text: string, name = "wallets.csv") {
  const value = new File([text], name, { type: name.endsWith("json") ? "application/json" : "text/csv" });
  Object.defineProperty(value, "text", { configurable: true, value: vi.fn().mockResolvedValue(text) });
  return value;
}

function setup(initialAddresses = "") {
  const user = userEvent.setup();
  const onResultChange = vi.fn<(value: GeneratedDistributionList) => void>();
  const rendered = render(<DistributionListGenerator addressKind="evm" decimals={18} initialAddresses={initialAddresses} onResultChange={onResultChange} symbol="ETH" />);
  return {
    ...rendered,
    user,
    onResultChange,
    result: () => onResultChange.mock.calls.at(-1)![0],
    upload: async (text: string, name?: string) => user.upload(document.querySelector<HTMLInputElement>('input[type="file"]')!, file(text, name))
  };
}

describe("recipient wallet import", () => {
  it.each(["", " \r\n\t\r\n"])("explains empty file imports and preserves the current list (%j)", async (text) => {
    const { upload, result } = setup(one);
    const originalResult = result();
    await upload(text, "empty.txt");
    const dialog = await screen.findByRole("dialog", { name: "导入收款钱包" });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("文件为空，未导入地址；当前清单保持原样");
    expect(within(dialog).getByRole("button", { name: "替换当前清单" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "追加到当前清单" })).toBeDisabled();
    expect(within(dialog).getByRole("textbox", { name: "粘贴地址或清单" })).toHaveValue("");
    expect(result()).toEqual(originalResult);
  });

  it("uses the collection-style entry, previews pasted table columns, and deduplicates on confirmation", async () => {
    const { user, result } = setup();
    expect(screen.getByRole("textbox", { name: "收款地址" })).not.toBeVisible();
    await user.click(screen.getByRole("button", { name: "导入收款钱包" }));
    const dialog = screen.getByRole("dialog", { name: "导入收款钱包" });
    const draft = within(dialog).getByRole("textbox", { name: "粘贴地址或清单" });
    fireEvent.input(draft, { target: { value: `备注\t金额\t地址\n一\t0.1\t${one}\n二\t0.2\t${two}\n重复\t0.1\t${one}` } });
    expect(within(dialog).getByText("2 个 · 自动去重 1 条")).toBeVisible();
    expect(within(dialog).getByText("逐行原金额（不重新计算）")).toBeVisible();
    expect(result().output).toBe("");
    await user.click(within(dialog).getByRole("button", { name: "确认导入清单" }));
    expect(result()).toMatchObject({ output: `${one},0.1\n${two},0.2`, duplicates: 0, totalUnits: 300_000_000_000_000_000n });
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("本次发送 2 / 2 个钱包")).toBeVisible();
  });

  it("extracts public columns from a wallet file without exposing its private columns", async () => {
    const { user, upload, result } = setup();
    const secret = "ab".repeat(32);
    await upload(JSON.stringify({ wallets: [{ privateKey: secret, address: one, amount: "0.123456789012345678" }, { secretKey: secret, address: two, amount: "0.2" }] }), "wallets.json");
    const dialog = await screen.findByRole("dialog", { name: "导入收款钱包" });
    expect(within(dialog).getByRole("textbox", { name: "粘贴地址或清单" })).toHaveValue(`${one},0.123456789012345678\n${two},0.2`);
    expect(dialog.textContent).not.toContain(secret);
    expect(dialog.textContent).not.toContain("privateKey");
    await user.click(within(dialog).getByRole("button", { name: "确认导入清单" }));
    expect(result().output).toBe(`${one},0.123456789012345678\n${two},0.2`);
    expect(document.body.textContent).not.toContain(secret);
  });

  it("imports an XLSX worksheet through the shared reader and preserves precise per-row amounts", async () => {
    const { user, result } = setup();
    const secret = "ab".repeat(32);
    const workbook = file("binary workbook", "wallets.xlsx");
    xlsxReader.mockResolvedValue([{ name: "发送名单", text: `备注,金额,地址,私钥\n一,0.100000000000000001,${one},${secret}\n二,0.000000000000000001,${two},${secret}` }]);
    await user.upload(document.querySelector<HTMLInputElement>('input[type="file"]')!, workbook);
    const dialog = await screen.findByRole("dialog", { name: "导入收款钱包" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "确认导入清单" })).toBeEnabled());
    expect(xlsxReader).toHaveBeenCalledWith(workbook, 5001);
    expect(workbook.text).not.toHaveBeenCalled();
    expect(within(dialog).getByText("当前工作表：发送名单。只导入当前工作表的内容。")).toBeVisible();
    expect(within(dialog).getByText(/XLSX · 收款地址、金额/)).toBeVisible();
    expect(within(dialog).getByRole("textbox", { name: "粘贴地址或清单" })).toHaveValue(`${one},0.100000000000000001\n${two},0.000000000000000001`);
    expect(dialog.textContent).not.toContain(secret);
    expect(dialog.textContent).not.toContain("私钥");
    await user.click(within(dialog).getByRole("button", { name: "确认导入清单" }));
    expect(result()).toMatchObject({ output: `${one},0.100000000000000001\n${two},0.000000000000000001`, totalUnits: 100_000_000_000_000_002n });
  });

  it("previews the first XLSX worksheet, switches preview, and imports only the chosen worksheet", async () => {
    const { user, upload, result } = setup();
    xlsxReader.mockResolvedValue([
      { name: "首批", text: `地址,金额\n${one},0.123456789012345678` },
      { name: "第二批", text: `金额,地址\n0.000000000000000002,${two}\n0.3,${three}` }
    ]);
    await upload("binary workbook", "wallets.XLSX");
    const dialog = await screen.findByRole("dialog", { name: "导入收款钱包" });
    const selector = await within(dialog).findByRole("combobox", { name: "导入工作表" });
    expect(selector).toHaveValue("0");
    expect(within(dialog).getByRole("textbox", { name: "粘贴地址或清单" })).toHaveValue(`${one},0.123456789012345678`);
    expect(result().output).toBe("");
    await user.selectOptions(selector, "1");
    expect(within(dialog).getByText("当前工作表：第二批。只导入当前工作表的内容。")).toBeVisible();
    expect(within(dialog).getByRole("textbox", { name: "粘贴地址或清单" })).toHaveValue(`${two},0.000000000000000002\n${three},0.3`);
    await user.click(within(dialog).getByRole("button", { name: "确认导入清单" }));
    expect(result().output).toBe(`${two},0.000000000000000002\n${three},0.3`);
    expect(result().validCount).toBe(2);
  });

  it("lets the user choose a valid worksheet after the default worksheet fails recognition", async () => {
    const { user, upload, result } = setup(one);
    xlsxReader.mockResolvedValue([
      { name: "填写说明", text: "请在发送名单填写收款地址和金额" },
      { name: "发送名单", text: `地址,金额\n${two},0.2` }
    ]);
    await upload("binary workbook", "wallets.xlsx");
    const dialog = await screen.findByRole("dialog", { name: "导入收款钱包" });
    await waitFor(() => expect(within(dialog).getByRole("alert")).toBeVisible());
    expect(within(dialog).getByRole("textbox", { name: "粘贴地址或清单" })).toHaveValue("");
    expect(within(dialog).getByRole("button", { name: "替换当前清单" })).toBeDisabled();
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "导入工作表" }), "1");
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "替换当前清单" }));
    expect(result().output).toBe(`${two},0.2`);
  });

  it("ignores a late XLSX read after cancellation and clears all worksheet choices", async () => {
    const { user, upload, result } = setup(one);
    let resolveWorkbook!: (sheets: { name: string; text: string }[]) => void;
    xlsxReader.mockImplementation(() => new Promise(resolve => { resolveWorkbook = resolve; }));
    await upload("binary workbook", "wallets.xlsx");
    await user.click(within(screen.getByRole("dialog", { name: "导入收款钱包" })).getByRole("button", { name: "取消" }));
    await act(async () => resolveWorkbook([{ name: "旧文件", text: `地址,金额,私钥\n${two},0.2,${"ab".repeat(32)}` }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(result().output).toBe(`${one},0.1`);
    await user.click(screen.getByRole("button", { name: "继续导入收款钱包" }));
    const dialog = screen.getByRole("dialog", { name: "导入收款钱包" });
    expect(within(dialog).getByRole("textbox", { name: "粘贴地址或清单" })).toHaveValue("");
    expect(within(dialog).queryByText(/当前工作表/)).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "替换当前清单" })).toBeDisabled();
  });

  it("clears XLSX worksheet choices on pagehide and rejects a stale reader result", async () => {
    const { user, upload, result } = setup(one);
    let resolveWorkbook!: (sheets: { name: string; text: string }[]) => void;
    xlsxReader.mockImplementation(() => new Promise(resolve => { resolveWorkbook = resolve; }));
    await upload("binary workbook", "wallets.xlsx");
    fireEvent(window, new Event("pagehide"));
    await act(async () => resolveWorkbook([{ name: "旧文件", text: `地址,金额\n${two},0.2` }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(result().output).toBe(`${one},0.1`);
    await user.click(screen.getByRole("button", { name: "继续导入收款钱包" }));
    expect(screen.queryByText(/当前工作表/)).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "粘贴地址或清单" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "替换当前清单" })).toBeDisabled();
  });

  it("supports file drop and reports conflicts without importing a partial list", async () => {
    const { result } = setup(one);
    fireEvent.drop(screen.getByRole("button", { name: "继续导入收款钱包" }), { dataTransfer: { files: [file(`${two},0.1\n${two},0.2`)] } });
    const dialog = await screen.findByRole("dialog", { name: "导入收款钱包" });
    await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent(/金额.*不同|金额.*冲突/));
    expect(within(dialog).getByRole("button", { name: "替换当前清单" })).toBeDisabled();
    expect(result().output).toBe(`${one},0.1`);
  });

  it("blocks append when an existing wallet has a different amount and keeps replacement reviewable", async () => {
    const { user, upload, result } = setup(one);
    await user.click(screen.getByRole("tab", { name: "逐行金额" }));
    await upload(`${one},0.2\n${two},0.000000000000000001`);
    const dialog = await screen.findByRole("dialog", { name: "导入收款钱包" });
    expect(within(dialog).getByRole("button", { name: "追加到当前清单" })).toBeDisabled();
    expect(within(dialog).getByText(/重复钱包的金额与当前清单不同/)).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "替换当前清单" }));
    expect(result().output).toBe(`${one},0.2\n${two},0.000000000000000001`);
    await user.click(screen.getByRole("button", { name: "撤销导入" }));
    expect(result().output).toBe(`${one},0.1`);
  });

  it.each([
    ["0.1", "0.2"],
    ["0.100000000000000001", "0.100000000000000002"],
    ["1", "1.0.5"]
  ])("blocks append without dropping conflicting original rows: %s / %s", async (firstAmount, secondAmount) => {
    const address = "0x00000000000000000000000000000000000000ab";
    const uppercaseAddress = address.toUpperCase().replace("0X", "0x");
    const originalRows = `${address},${firstAmount}\n${uppercaseAddress},${secondAmount}`;
    const { user, upload, result } = setup(address);
    await user.click(screen.getByRole("tab", { name: "逐行金额" }));
    await user.click(screen.getByText("编辑原始清单", { selector: "summary" }));
    const source = screen.getByRole("textbox", { name: "收款地址与金额" });
    fireEvent.change(source, { target: { value: originalRows } });
    const originalResult = result();
    expect(originalResult.duplicates + originalResult.invalid).toBeGreaterThan(0);

    await upload(`${two},0.3`);
    const dialog = await screen.findByRole("dialog", { name: "导入收款钱包" });
    const append = within(dialog).getByRole("button", { name: "追加到当前清单" });
    expect(append).toBeDisabled();
    expect(within(dialog).getByText(/当前清单中同一钱包存在不同金额/)).toBeVisible();
    await user.click(append);
    expect(result()).toEqual(originalResult);
    expect(source).toHaveValue(originalRows);
    await user.click(within(dialog).getByRole("button", { name: "替换当前清单" }));
    expect(result()).toMatchObject({ output: `${two},0.3`, duplicates: 0, invalid: 0 });
    await user.click(screen.getByRole("button", { name: "撤销导入" }));
    expect(source).toHaveValue(originalRows);
    expect(result()).toEqual(originalResult);
  });

  it.each([
    ["0.1", "000.1000"],
    ["1", "001.0000"],
    ["0.100000000000000001", "000.100000000000000001"]
  ])("merges original and imported duplicate rows with equivalent amounts: %s / %s", async (firstAmount, equivalentAmount) => {
    const address = "0x00000000000000000000000000000000000000ab";
    const uppercaseAddress = address.toUpperCase().replace("0X", "0x");
    const { user, upload, result } = setup(address);
    await user.click(screen.getByRole("tab", { name: "逐行金额" }));
    await user.click(screen.getByText("编辑原始清单", { selector: "summary" }));
    const source = screen.getByRole("textbox", { name: "收款地址与金额" });
    fireEvent.change(source, { target: { value: `${address},${firstAmount}\n${uppercaseAddress},${equivalentAmount}` } });
    expect(result()).toMatchObject({ duplicates: 1, invalid: 0 });

    await upload(`${uppercaseAddress},${equivalentAmount}\n${two},0.3`);
    const dialog = await screen.findByRole("dialog", { name: "导入收款钱包" });
    expect(within(dialog).getByRole("button", { name: "追加到当前清单" })).toBeEnabled();
    await user.click(within(dialog).getByRole("button", { name: "追加到当前清单" }));
    expect(source).toHaveValue(`${address},${firstAmount}\n${two},0.3`);
    expect(result()).toMatchObject({ output: `${address},${firstAmount}\n${two},0.3`, duplicates: 0, invalid: 0 });
  });

  it("excludes unchecked wallets from sending while preserving exact amounts, search, and removal", async () => {
    const { user, upload, result } = setup();
    await upload(`${one},0.100000000000000001\n${two},0.2\n${three},0.3`);
    await user.click(within(await screen.findByRole("dialog", { name: "导入收款钱包" })).getByRole("button", { name: "确认导入清单" }));
    await user.click(screen.getByRole("checkbox", { name: `选择收款钱包 ${two}` }));
    expect(result().output).toBe(`${one},0.100000000000000001\n${three},0.3`);
    expect(screen.getByText("本次发送 2 / 3 个钱包")).toBeVisible();
    await user.type(screen.getByRole("searchbox", { name: "搜索收款钱包" }), two);
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "选择搜索结果 (1)" }));
    expect(result().output).toBe(`${one},0.100000000000000001\n${two},0.2\n${three},0.3`);
    await user.click(screen.getByRole("button", { name: `移除收款钱包 ${two}` }));
    expect(result().output).toBe(`${one},0.100000000000000001\n${three},0.3`);
  });

  it("does not regenerate random amounts when toggling wallet selection or converting to per-row amounts", async () => {
    const { user, result } = setup(`${one}\n${two}`);
    await user.click(screen.getByRole("tab", { name: "随机区间" }));
    const amounts = result().output;
    await user.click(screen.getByRole("checkbox", { name: `选择收款钱包 ${two}` }));
    expect(result().output).toBe(amounts.split("\n")[0]);
    await user.click(screen.getByRole("tab", { name: "逐行金额" }));
    await user.click(screen.getByRole("checkbox", { name: `选择收款钱包 ${two}` }));
    expect(result().output).toBe(amounts);
  });

  it("cancels an unfinished file read when the dialog closes and ignores its late result", async () => {
    const { user, result } = setup(one);
    let resolveText!: (text: string) => void;
    const pendingFile = file(two);
    Object.defineProperty(pendingFile, "text", { configurable: true, value: () => new Promise<string>(resolve => { resolveText = resolve; }) });
    await user.upload(document.querySelector<HTMLInputElement>('input[type="file"]')!, pendingFile);
    await user.click(within(screen.getByRole("dialog", { name: "导入收款钱包" })).getByRole("button", { name: "取消" }));
    await act(async () => resolveText(two));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(result().output).toBe(`${one},0.1`);
    await user.click(screen.getByRole("button", { name: "继续导入收款钱包" }));
    expect(screen.getByRole("textbox", { name: "粘贴地址或清单" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "替换当前清单" })).toBeDisabled();
  });

  it("clears the import draft and read lock on pagehide without changing the active recipients", async () => {
    const { user, result } = setup(one);
    await user.click(screen.getByRole("button", { name: "继续导入收款钱包" }));
    const draft = screen.getByRole("textbox", { name: "粘贴地址或清单" });
    fireEvent.input(draft, { target: { value: `address,privateKey\n${two},${"ab".repeat(32)}` } });
    fireEvent(window, new Event("pagehide"));
    expect(draft).toHaveValue("");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(result().output).toBe(`${one},0.1`);
    await user.click(screen.getByRole("button", { name: "继续导入收款钱包" }));
    expect(screen.getByRole("textbox", { name: "粘贴地址或清单" })).toHaveValue("");
  });

  it("opens the source editor and locates the selected invalid row after an earlier wallet is unchecked", async () => {
    const user = userEvent.setup();
    const controlRef = { current: null as DistributionListGeneratorHandle | null };
    render(<DistributionListGenerator addressKind="evm" decimals={18} initialAddresses={`${one}\ninvalid-address\n${two}`} controlRef={controlRef} onResultChange={() => undefined} symbol="ETH" />);
    await user.click(screen.getByRole("checkbox", { name: `选择收款钱包 ${one}` }));
    await act(async () => { controlRef.current!.focusProblem("invalid"); await new Promise(resolve => window.requestAnimationFrame(resolve)); });
    const input = screen.getByRole("textbox", { name: "收款地址" }) as HTMLTextAreaElement;
    expect(input.closest("details")).toHaveAttribute("open");
    expect(input.selectionStart).toBe(one.length + 1);
    expect(input.value.slice(input.selectionStart, input.selectionEnd)).toBe("invalid-address");
  });

  it("rejects oversized pasted content instead of silently importing a truncated clipboard", async () => {
    const { user, result } = setup(one);
    await user.click(screen.getByRole("button", { name: "继续导入收款钱包" }));
    const draft = screen.getByRole("textbox", { name: "粘贴地址或清单" });
    fireEvent.paste(draft, { clipboardData: { getData: () => "a".repeat(512 * 1024 + 1) } });
    expect(screen.getByRole("alert")).toHaveTextContent("粘贴内容不能超过 512 KB");
    expect(screen.getByRole("button", { name: "替换当前清单" })).toBeDisabled();
    expect(draft).toHaveValue("");
    expect(result().output).toBe(`${one},0.1`);
  });
});
