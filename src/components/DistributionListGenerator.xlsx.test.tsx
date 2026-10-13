// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DistributionListGenerator } from "./DistributionListGenerator";
import type { GeneratedDistributionList } from "../lib/distribution-generator";

const one = `0x${"1".repeat(40)}`;
const two = `0x${"2".repeat(40)}`;
const three = `0x${"3".repeat(40)}`;
const secret = "ab".repeat(32);
type Cell = string | { numeric: string };
afterEach(cleanup);

const escapeXml = (value: string) => value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/"/gu, "&quot;");

function workbookFile(sheets: { name: string; rows: Cell[][] }[]) {
  const entries: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`),
    "_rels/.rels": strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    "xl/workbook.xml": strToU8(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}</Relationships>`)
  };
  sheets.forEach((sheet, sheetIndex) => {
    entries[`xl/worksheets/sheet${sheetIndex + 1}.xml`] = strToU8(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet.rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((cell, cellIndex) => {
      const reference = `${String.fromCharCode(65 + cellIndex)}${rowIndex + 1}`;
      return typeof cell === "string" ? `<c r="${reference}" t="inlineStr"><is><t>${escapeXml(cell)}</t></is></c>` : `<c r="${reference}"><v>${cell.numeric}</v></c>`;
    }).join("")}</row>`).join("")}</sheetData></worksheet>`);
  });
  const buffer = new Uint8Array(zipSync(entries)).buffer;
  const file = new File([buffer], "wallets.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  Object.defineProperty(file, "arrayBuffer", { value: () => Promise.resolve(buffer) });
  return file;
}

function setup() {
  const user = userEvent.setup();
  const onResultChange = vi.fn<(result: GeneratedDistributionList) => void>();
  render(<DistributionListGenerator addressKind="evm" decimals={18} onResultChange={onResultChange} symbol="ETH" />);
  return { user, result: () => onResultChange.mock.calls.at(-1)![0] };
}

describe("real XLSX recipient import", () => {
  it("reads binary Excel numeric cells without rounding amounts and excludes private columns", async () => {
    const { user, result } = setup();
    const workbook = workbookFile([{ name: "发送名单", rows: [["备注", "金额", "地址", "私钥"], ["一", { numeric: "0.100000000000000001" }, one, secret], ["二", { numeric: "1e-18" }, two, secret]] }]);
    await user.upload(document.querySelector<HTMLInputElement>('input[type="file"]')!, workbook);
    const dialog = await screen.findByRole("dialog", { name: "导入收款钱包" });
    const confirm = within(dialog).getByRole("button", { name: "确认导入清单" });
    await waitFor(() => expect(confirm).toBeEnabled());
    expect(within(dialog).getByRole("textbox", { name: "粘贴地址或清单" })).toHaveValue(`${one},0.100000000000000001\n${two},0.000000000000000001`);
    expect(dialog.textContent).not.toContain(secret);
    await user.click(confirm);
    expect(result()).toMatchObject({ output: `${one},0.100000000000000001\n${two},0.000000000000000001`, totalUnits: 100_000_000_000_000_002n });
  });

  it("keeps real workbook worksheets separate and imports the selected sheet only", async () => {
    const { user, result } = setup();
    const workbook = workbookFile([
      { name: "首批", rows: [["地址", "金额"], [one, { numeric: "0.1" }]] },
      { name: "第二批", rows: [["金额", "地址"], [{ numeric: "0.123456789012345678" }, two], [{ numeric: "3e-18" }, three]] }
    ]);
    await user.upload(document.querySelector<HTMLInputElement>('input[type="file"]')!, workbook);
    const dialog = await screen.findByRole("dialog", { name: "导入收款钱包" });
    const selector = await within(dialog).findByRole("combobox", { name: "导入工作表" });
    await waitFor(() => expect(selector).toBeEnabled());
    expect(selector).toHaveValue("0");
    await user.selectOptions(selector, "1");
    await user.click(within(dialog).getByRole("button", { name: "确认导入清单" }));
    expect(result()).toMatchObject({ output: `${two},0.123456789012345678\n${three},0.000000000000000003`, totalUnits: 123_456_789_012_345_681n, validCount: 2 });
  });
});
