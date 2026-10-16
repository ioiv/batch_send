// @vitest-environment jsdom

import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Keypair } from "@solana/web3.js";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretKeyInput, type SecretKeyInputHandle } from "@/components/SecretKeyInput";
import { buildWalletAssetOverview } from "@/lib/wallet-asset-overview";
import * as xlsxImport from "@/lib/wallet-xlsx-import";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function binaryWalletFile(name = "wallets.xlsx") {
  const file = new File([new Uint8Array([80, 75, 3, 4])], name, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(4) });
  Object.defineProperty(file, "text", { value: vi.fn(async () => { throw new Error("read as binary"); }) });
  return file;
}

describe("Excel private-wallet import", () => {
  it("previews the selected sheet and imports only that sheet", async () => {
    const user = userEvent.setup();
    const ref = createRef<SecretKeyInputHandle>();
    const first = `0x${"91".repeat(32)}` as const;
    const second = `0x${"92".repeat(32)}` as const;
    const firstAddress = privateKeyToAccount(first).address;
    const secondAddress = privateKeyToAccount(second).address;
    vi.spyOn(xlsxImport, "readWalletXlsxFile").mockResolvedValue([
      { name: "运营钱包", text: `备注,address,private_key,seed_phrase\n运营,${firstAddress},${first},abandon ability able about above absent absorb abstract absurd abuse access accident` },
      { name: "备用钱包", text: `private_key\n${second}` }
    ]);
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    render(<SecretKeyInput mode="evm" ref={ref} />);
    await user.click(screen.getByRole("button", { name: "导入钱包" }));
    await user.upload(document.querySelector<HTMLInputElement>('input[type="file"]')!, binaryWalletFile());
    const dialog = screen.getByRole("dialog", { name: "导入来源钱包" });
    const select = await within(dialog).findByRole("combobox", { name: "Excel 工作表" });
    expect(select).toHaveValue("0");
    expect(within(dialog).getByLabelText("钱包导入预览")).toHaveTextContent(firstAddress);
    expect(dialog).toHaveTextContent("当前工作表：运营钱包。只导入当前工作表的内容。");
    expect(dialog.textContent).not.toContain(first);
    expect(dialog.textContent).not.toContain(second);
    expect(within(dialog).getByLabelText("粘贴私钥")).toHaveValue("");
    expect(within(dialog).queryByRole("textbox", { name: "粘贴私钥" })).not.toBeInTheDocument();
    expect(dialog.textContent).not.toContain("abandon ability");
    await user.selectOptions(select, "1");
    expect(within(dialog).getByLabelText("钱包导入预览")).toHaveTextContent(secondAddress);
    expect(within(dialog).getByLabelText("钱包导入预览")).not.toHaveTextContent(firstAddress);
    expect(within(dialog).getByLabelText("粘贴私钥")).toHaveValue("");
    expect(ref.current!.read()).toBe("");
    await user.click(within(dialog).getByRole("button", { name: "确认导入" }));
    expect(ref.current!.read()).toBe(second);
    expect(screen.queryByRole("combobox", { name: "Excel 工作表" })).not.toBeInTheDocument();
    expect(storageWrite).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "继续导入钱包" }));
    expect(screen.getByRole("textbox", { name: "粘贴私钥" })).toHaveValue("");
    expect(screen.queryByRole("combobox", { name: "Excel 工作表" })).not.toBeInTheDocument();
  });

  it("can switch from a header-only sheet and forgets the workbook after a pasted edit", async () => {
    const user = userEvent.setup();
    const secret = `0x${"93".repeat(32)}`;
    vi.spyOn(xlsxImport, "readWalletXlsxFile").mockResolvedValue([{ name: "说明", text: "private_key" }, { name: "钱包", text: `private_key\n${secret}` }]);
    render(<SecretKeyInput mode="evm" />);
    await user.click(screen.getByRole("button", { name: "导入钱包" }));
    await user.upload(document.querySelector<HTMLInputElement>('input[type="file"]')!, binaryWalletFile());
    const select = await screen.findByRole("combobox", { name: "Excel 工作表" });
    expect(screen.getByRole("button", { name: "确认导入" })).toBeDisabled();
    await user.selectOptions(select, "1");
    expect(screen.getByRole("button", { name: "确认导入" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "改为粘贴输入" }));
    expect(screen.queryByRole("combobox", { name: "Excel 工作表" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认导入" })).toBeDisabled();
    fireEvent.input(screen.getByRole("textbox", { name: "粘贴私钥" }), { target: { value: secret } });
    expect(screen.queryByRole("combobox", { name: "Excel 工作表" })).not.toBeInTheDocument();
  });

  it.each(["cancel", "disable", "pagehide", "unmount"])("clears and ignores a late workbook result after %s", async (action) => {
    const user = userEvent.setup();
    const ref = createRef<SecretKeyInputHandle>();
    const secret = `0x${"94".repeat(32)}`;
    let resolveRead!: (sheets: { name: string; text: string }[]) => void;
    vi.spyOn(xlsxImport, "readWalletXlsxFile").mockImplementation(() => new Promise((resolve) => { resolveRead = resolve; }));
    const onImportingChange = vi.fn();
    const mounted = render(<SecretKeyInput mode="evm" ref={ref} onImportingChange={onImportingChange} />);
    await user.click(screen.getByRole("button", { name: "导入钱包" }));
    const draft = screen.getByRole("textbox", { name: "粘贴私钥" }) as HTMLTextAreaElement;
    await user.upload(document.querySelector<HTMLInputElement>('input[type="file"]')!, binaryWalletFile());
    expect(onImportingChange).toHaveBeenLastCalledWith(true);
    if (action === "cancel") await user.click(screen.getByRole("button", { name: "取消" }));
    else if (action === "disable") mounted.rerender(<SecretKeyInput disabled mode="evm" ref={ref} onImportingChange={onImportingChange} />);
    else if (action === "pagehide") act(() => window.dispatchEvent(new Event("pagehide")));
    else mounted.unmount();
    await act(async () => resolveRead([{ name: "钱包", text: `private_key\n${secret}` }]));
    expect(draft.value).toBe("");
    expect(screen.queryByRole("combobox", { name: "Excel 工作表" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("钱包导入预览")).not.toBeInTheDocument();
    expect(onImportingChange).toHaveBeenLastCalledWith(false);
    if (action !== "unmount") expect(ref.current!.read()).toBe("");
  });

  it("clears the loaded workbook when a new file replaces it", async () => {
    const user = userEvent.setup();
    const secret = `0x${"95".repeat(32)}`;
    vi.spyOn(xlsxImport, "readWalletXlsxFile").mockResolvedValue([{ name: "旧钱包", text: `private_key\n${secret}` }]);
    render(<SecretKeyInput mode="evm" />);
    await user.click(screen.getByRole("button", { name: "导入钱包" }));
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await user.upload(fileInput, binaryWalletFile());
    await screen.findByRole("combobox", { name: "Excel 工作表" });
    const textFile = new File(["bad"], "addresses.txt", { type: "text/plain" });
    Object.defineProperty(textFile, "text", { value: async () => "bad" });
    await user.upload(fileInput, textFile);
    await screen.findByRole("alert");
    expect(screen.getByLabelText("粘贴私钥")).toHaveValue("");
    expect(screen.queryByRole("combobox", { name: "Excel 工作表" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认导入" })).toBeDisabled();
  });

  it.each(["cancel", "disable", "pagehide", "unmount"])("clears a loaded workbook and its detached draft DOM after %s", async (action) => {
    const user = userEvent.setup();
    const secret = `0x${"96".repeat(32)}`;
    vi.spyOn(xlsxImport, "readWalletXlsxFile").mockResolvedValue([{ name: "钱包", text: `private_key\n${secret}` }]);
    const mounted = render(<SecretKeyInput mode="evm" />);
    await user.click(screen.getByRole("button", { name: "导入钱包" }));
    await user.upload(document.querySelector<HTMLInputElement>('input[type="file"]')!, binaryWalletFile());
    await screen.findByRole("combobox", { name: "Excel 工作表" });
    const draft = screen.getByLabelText("粘贴私钥") as HTMLTextAreaElement;
    expect(draft.value).toBe("");
    expect(screen.getByLabelText("钱包导入预览")).toHaveTextContent("有效钱包 1");
    if (action === "cancel") await user.click(screen.getByRole("button", { name: "取消" }));
    else if (action === "disable") mounted.rerender(<SecretKeyInput disabled mode="evm" />);
    else if (action === "pagehide") act(() => window.dispatchEvent(new Event("pagehide")));
    else mounted.unmount();
    expect(draft.value).toBe("");
    expect(screen.queryByRole("combobox", { name: "Excel 工作表" })).not.toBeInTheDocument();
    if (action === "cancel" || action === "pagehide") {
      await user.click(screen.getByRole("button", { name: "导入钱包" }));
      expect(screen.getByRole("textbox", { name: "粘贴私钥" })).toHaveValue("");
      expect(screen.queryByRole("combobox", { name: "Excel 工作表" })).not.toBeInTheDocument();
    }
  });
});

describe("wallet file drop", () => {
  it("reads a dropped file into the import dialog and waits for confirmation", async () => {
    const user = userEvent.setup();
    const ref = createRef<SecretKeyInputHandle>();
    const secret = `0x${"41".repeat(32)}`;
    const file = new File([secret], "wallets.txt", { type: "text/plain" });
    Object.defineProperty(file, "text", { value: async () => secret });
    render(<SecretKeyInput mode="evm" ref={ref} />);
    const dropzone = screen.getByRole("button", { name: "导入钱包" });
    fireEvent.drop(dropzone, { dataTransfer: { files: [file] } });
    const dialog = await screen.findByRole("dialog", { name: "导入来源钱包" });
    await within(dialog).findByLabelText("钱包导入预览");
    expect(within(dialog).getByLabelText("粘贴私钥")).toHaveValue("");
    expect(within(dialog).queryByRole("textbox", { name: "粘贴私钥" })).not.toBeInTheDocument();
    expect(ref.current?.read()).toBe("");
    await user.click(within(dialog).getByRole("button", { name: "确认导入" }));
    expect(ref.current?.read()).toBe(secret);
    expect(screen.getByRole("button", { name: "继续导入钱包" })).toHaveTextContent("已导入 1 个钱包");
  });

  it("does not read a dropped file while controls are locked", async () => {
    const read = vi.fn(async () => "");
    const file = new File([], "wallets.txt", { type: "text/plain" });
    Object.defineProperty(file, "text", { value: read });
    render(<SecretKeyInput disabled mode="evm" />);
    fireEvent.drop(screen.getByRole("button", { name: "导入钱包" }), { dataTransfer: { files: [file] } });
    expect(screen.queryByRole("dialog", { name: "导入来源钱包" })).not.toBeInTheDocument();
    expect(read).not.toHaveBeenCalled();
  });
});

describe("file import paste layout", () => {
  it.each(["evm", "solana"] as const)("collapses the empty paste field and can replace the file with pasted content (%s)", async (mode) => {
    const user = userEvent.setup();
    const ref = createRef<SecretKeyInputHandle>();
    const first = mode === "evm" ? `0x${"44".repeat(32)}` : JSON.stringify(Array.from(Keypair.fromSeed(new Uint8Array(32).fill(44)).secretKey));
    const second = mode === "evm" ? `0x${"45".repeat(32)}` : JSON.stringify(Array.from(Keypair.fromSeed(new Uint8Array(32).fill(45)).secretKey));
    const file = new File([first], "wallets.txt", { type: "text/plain" });
    Object.defineProperty(file, "text", { value: async () => first });
    render(<SecretKeyInput mode={mode} ref={ref} />);
    await user.click(screen.getByRole("button", { name: "导入钱包" }));
    const dialog = screen.getByRole("dialog", { name: "导入来源钱包" });
    const draft = within(dialog).getByRole("textbox", { name: "粘贴私钥" });
    await user.upload(document.querySelector<HTMLInputElement>('input[type="file"]')!, file);
    await within(dialog).findByLabelText("钱包导入预览");
    expect(draft).toHaveValue("");
    expect(draft).not.toBeVisible();
    expect(within(dialog).getByText("wallets.txt · 已读取 1 条")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "确认导入" })).toBeEnabled();

    await user.click(within(dialog).getByRole("button", { name: "改为粘贴输入" }));
    await waitFor(() => expect(draft).toHaveFocus());
    expect(draft).toBeVisible();
    expect(draft).toHaveValue("");
    expect(within(dialog).queryByLabelText("钱包导入预览")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("wallets.txt · 已读取 1 条")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "确认导入" })).toBeDisabled();
    fireEvent.input(draft, { target: { value: second } });
    await user.click(within(dialog).getByRole("button", { name: "确认导入" }));
    expect(ref.current!.read()).toBe(second);
    await user.click(screen.getByRole("button", { name: "继续导入钱包" }));
    expect(screen.getByRole("textbox", { name: "粘贴私钥" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "粘贴私钥" })).toHaveValue("");
  });
});

describe("private wallet file privacy", () => {
  it.each(["csv", "json"])("keeps private and unused mnemonic columns out of visible fields and error previews (%s)", async (extension) => {
    const user = userEvent.setup();
    const ref = createRef<SecretKeyInputHandle>();
    const secret = `0x${"42".repeat(32)}` as const;
    const address = privateKeyToAccount(secret).address;
    const mnemonic = "abandon ability able about above absent absorb abstract absurd abuse access accident";
    const invalidSecret = "invalid-private-key-must-not-display";
    const source = extension === "csv"
      ? `label,address,private_key,seed_phrase\nops,${address},${secret},${mnemonic}\ninvalid,,${invalidSecret},${mnemonic}`
      : JSON.stringify({ wallets: [{ label: "ops", address, private_key: secret, seed_phrase: mnemonic }, { private_key: invalidSecret, seed_phrase: mnemonic }] });
    const file = new File([source], `wallets.${extension}`, { type: extension === "csv" ? "text/csv" : "application/json" });
    Object.defineProperty(file, "text", { value: async () => source });
    render(<SecretKeyInput mode="evm" ref={ref} />);
    await user.click(screen.getByRole("button", { name: "导入钱包" }));
    const dialog = screen.getByRole("dialog", { name: "导入来源钱包" });
    await user.upload(document.querySelector<HTMLInputElement>('input[type="file"]')!, file);
    const preview = await within(dialog).findByLabelText("钱包导入预览");
    expect(preview).toHaveTextContent(address);
    expect(preview).toHaveTextContent("问题 1");
    expect(within(dialog).getByLabelText("粘贴私钥")).toHaveValue("");
    expect(dialog.outerHTML).not.toContain(secret);
    expect(dialog.outerHTML).not.toContain(mnemonic);
    expect(dialog.outerHTML).not.toContain(invalidSecret);
    expect(within(dialog).getByRole("button", { name: "确认导入" })).toBeDisabled();
    await user.click(within(dialog).getByRole("checkbox", { name: "仅导入 1 个有效钱包，跳过 1 个问题条目" }));
    await user.click(within(dialog).getByRole("button", { name: "确认导入" }));
    expect(ref.current!.read()).toBe(`ops,${secret}`);
  });
});

async function importWallets(user: ReturnType<typeof userEvent.setup>, secret: string) {
  await user.click(screen.getByRole("button", { name: /导入钱包/ }));
  const dialog = screen.getByRole("dialog", { name: "导入来源钱包" });
  fireEvent.input(within(dialog).getByRole("textbox", { name: "粘贴私钥" }), {
    target: { value: secret }
  });
  await user.click(within(dialog).getByRole("button", { name: "确认导入" }));
}

describe("SecretKeyInput DOM-only lifecycle", () => {
  it("hands off every wallet and restores just the selected subset without storage", async () => {
    const user = userEvent.setup();
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    const ref = createRef<SecretKeyInputHandle>();
    const secrets = ["71", "72"].map((byte) => (`0x${byte.repeat(32)}`) as `0x${string}`);
    const addresses = secrets.map((secret) => privateKeyToAccount(secret).address);
    const { unmount } = render(<SecretKeyInput mode="evm" ref={ref} />);
    await importWallets(user, secrets.join("\n"));
    await user.click(screen.getByRole("checkbox", { name: new RegExp(addresses[1], "i") }));
    const snapshot = ref.current!.handoff();
    expect(snapshot).toEqual({ keys: secrets.join("\n"), selectedIds: [addresses[0].toLowerCase()] });
    const store = document.querySelector<HTMLTextAreaElement>(".secret-dom-store")!;
    unmount();
    expect(store.value).toBe("");
    const readInitialWallets = vi.fn(() => snapshot);
    const mounted = render(<SecretKeyInput mode="evm" ref={ref} readInitialWallets={readInitialWallets} />);
    expect(screen.getByText("已选择 1 / 2")).toBeVisible();
    expect(ref.current!.read()).toBe(secrets[0]);
    expect(ref.current!.handoff().keys).toBe(secrets.join("\n"));
    mounted.rerender(<SecretKeyInput mode="evm" ref={ref} readInitialWallets={readInitialWallets} />);
    expect(readInitialWallets).toHaveBeenCalledTimes(1);
    expect(storageWrite).not.toHaveBeenCalled();
  });

  it("never selects incomplete scans or positive native dust as zero balances", async () => {
    const user = userEvent.setup();
    const ref = createRef<SecretKeyInputHandle>();
    const secrets = ["73", "74", "75", "76"].map((byte) => (`0x${byte.repeat(32)}`) as `0x${string}`);
    const ids = secrets.map((secret) => privateKeyToAccount(secret).address.toLowerCase());
    const zero = { holdings: [], complete: true, native: { symbol: "ETH", raw: 0n, decimals: 18 } };
    const overviews = {
      [ids[0]]: buildWalletAssetOverview(zero),
      [ids[1]]: buildWalletAssetOverview({ ...zero, complete: false }),
      [ids[2]]: buildWalletAssetOverview({ ...zero, native: { ...zero.native, raw: 1n } }),
      [ids[3]]: buildWalletAssetOverview({ ...zero, native: { ...zero.native, raw: null } })
    };
    render(<SecretKeyInput mode="evm" ref={ref} walletAssetOverviews={overviews} />);
    await importWallets(user, secrets.join("\n"));
    await user.click(screen.getByRole("button", { name: "选中余额为零 (1)" }));
    expect(ref.current!.read()).toBe(secrets[0]);
    expect(screen.getByText("已选择 1 / 4")).toBeVisible();
    expect(screen.getAllByText("扫描不完整")).toHaveLength(2);
  });

  it("imports, selects, deletes, reads and clears without writing storage", async () => {
    const user = userEvent.setup();
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    const inputRef = createRef<SecretKeyInputHandle>();
    render(<SecretKeyInput mode="evm" ref={inputRef} />);

    const sentinel = (`0x${"11".repeat(32)}`) as `0x${string}`;
    const address = privateKeyToAccount(sentinel).address;
    await importWallets(user, sentinel);

    expect(screen.getByText(address.slice(0, 8) + "…" + address.slice(-8))).toBeVisible();
    expect(inputRef.current?.read()).toBe(sentinel);
    expect(storageWrite).not.toHaveBeenCalled();

    const checkbox = screen.getByRole("checkbox", { name: new RegExp(address, "i") });
    await user.click(checkbox);
    expect(inputRef.current?.read()).toBe("");
    await user.click(checkbox);
    expect(inputRef.current?.read()).toBe(sentinel);

    const removeButton = screen.getByRole("button", { name: new RegExp(`删除.*${address}`, "i") });
    expect(removeButton).toHaveClass("imported-wallet-remove");
    await user.click(removeButton);
    expect(inputRef.current?.read()).toBe("");
    expect(screen.queryByLabelText("已导入来源钱包")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导入钱包" })).toBeVisible();

    await importWallets(user, sentinel);
    inputRef.current?.clear();
    expect(inputRef.current?.read()).toBe("");
    expect(document.querySelector<HTMLTextAreaElement>(".secret-dom-store")).toHaveValue("");
  });

  it("copies the complete imported wallet address", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    const sentinel = (`0x${"12".repeat(32)}`) as `0x${string}`;
    const address = privateKeyToAccount(sentinel).address;
    render(<SecretKeyInput mode="evm" />);
    await importWallets(user, sentinel);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await user.click(screen.getByRole("button", {
      name: new RegExp(`复制.*${address}.*地址`, "i")
    }));

    expect(writeText).toHaveBeenCalledWith(address);
    expect(screen.getByRole("button", {
      name: new RegExp(`复制.*${address}.*地址`, "i")
    })).toHaveTextContent("已复制");
  });

  it("automatically deduplicates wallets across continued imports", async () => {
    const user = userEvent.setup();
    const inputRef = createRef<SecretKeyInputHandle>();
    const onDirty = vi.fn();
    const firstSecret = (`0x${"13".repeat(32)}`) as `0x${string}`;
    const secondSecret = (`0x${"14".repeat(32)}`) as `0x${string}`;
    const firstAddress = privateKeyToAccount(firstSecret).address;
    const secondAddress = privateKeyToAccount(secondSecret).address;
    render(<SecretKeyInput mode="evm" onDirty={onDirty} ref={inputRef} />);

    await importWallets(user, firstSecret);
    await importWallets(user, [firstSecret, secondSecret, secondSecret].join("\n"));

    expect(screen.getByText("已选择 2 / 2")).toBeVisible();
    expect(screen.getByTitle(firstAddress)).toBeVisible();
    expect(screen.getByTitle(secondAddress)).toBeVisible();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(inputRef.current?.read().split("\n")).toEqual([firstSecret, secondSecret]);
    expect(onDirty).toHaveBeenCalledTimes(2);

    await importWallets(user, secondSecret);
    expect(screen.getByText("已选择 2 / 2")).toBeVisible();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(inputRef.current?.read().split("\n")).toEqual([firstSecret, secondSecret]);
    expect(onDirty).toHaveBeenCalledTimes(2);
  });

  it("automatically deduplicates Solana wallets across continued imports", async () => {
    const user = userEvent.setup();
    const inputRef = createRef<SecretKeyInputHandle>();
    const first = Keypair.fromSeed(new Uint8Array(32).fill(21));
    const second = Keypair.fromSeed(new Uint8Array(32).fill(22));
    const firstSecret = JSON.stringify(Array.from(first.secretKey));
    const secondSecret = JSON.stringify(Array.from(second.secretKey));
    render(<SecretKeyInput mode="solana" ref={inputRef} />);

    await importWallets(user, firstSecret);
    await importWallets(user, [firstSecret, secondSecret, firstSecret].join("\n"));

    expect(screen.getByText("已选择 2 / 2")).toBeVisible();
    expect(screen.getByTitle(first.publicKey.toBase58())).toBeVisible();
    expect(screen.getByTitle(second.publicKey.toBase58())).toBeVisible();
    expect(inputRef.current?.read().split("\n")).toEqual([firstSecret, secondSecret]);
  });

  it("clears imported file controls, page lifecycle restores, and unmount", async () => {
    const user = userEvent.setup();
    const inputRef = createRef<SecretKeyInputHandle>();
    const { unmount } = render(<SecretKeyInput mode="evm" ref={inputRef} />);
    const secretStore = document.querySelector<HTMLTextAreaElement>(".secret-dom-store")!;
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const sentinel = (`0x${"22".repeat(32)}`) as `0x${string}`;

    await user.click(screen.getByRole("button", { name: "导入钱包" }));
    const dialog = screen.getByRole("dialog", { name: "导入来源钱包" });
    const draft = within(dialog).getByRole("textbox", { name: "粘贴私钥" });
    await user.upload(fileInput, new File([sentinel], "wallets.txt", { type: "text/plain" }));
    await within(dialog).findByLabelText("钱包导入预览");
    expect(draft).toHaveValue("");
    expect(fileInput.value).toBe("");
    await user.click(within(dialog).getByRole("button", { name: "确认导入" }));
    expect(inputRef.current?.read()).toContain(sentinel);

    act(() => window.dispatchEvent(new Event("pagehide")));
    expect(secretStore).toHaveValue("");

    await importWallets(user, sentinel);
    act(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    expect(secretStore).toHaveValue("");

    await importWallets(user, sentinel);
    unmount();
    expect(secretStore.value).toBe("");
  });

  it("keeps wallet rows compact and opens execution details in a side sheet", async () => {
    const user = userEvent.setup();
    const sentinel = (`0x${"33".repeat(32)}`) as `0x${string}`;
    const address = privateKeyToAccount(sentinel).address;
    const hash = `0x${"ab".repeat(32)}`;
    const explorerUrl = `https://explorer.test/tx/${hash}`;
    render(
      <SecretKeyInput
        compactStatuses
        mode="evm"
        walletStatuses={{
          [address.toLowerCase()]: [
            {
              amount: "4",
              asset: "ERC1155 #9",
              explorerUrl,
              hash,
              message: "批量归集交易已确认",
              status: "success"
            },
            {
              amount: "2",
              asset: "ERC1155 #10",
              explorerUrl,
              hash,
              message: "批量归集交易已确认",
              status: "success"
            }
          ]
        }}
      />
    );
    await importWallets(user, sentinel);

    const walletRow = screen.getByTitle(address).closest('[role="listitem"]') as HTMLElement;
    expect(within(walletRow).getByText("ERC1155 · 2 个 Token ID")).toBeVisible();
    expect(within(walletRow).getByText("已完成")).toBeVisible();
    const transactionLink = within(walletRow).getByRole("link", { name: `查看交易 ${hash}` });
    expect(transactionLink).toHaveTextContent("0xabababab…ababab");
    expect(transactionLink).toHaveAttribute("href", explorerUrl);

    await user.click(within(walletRow).getByRole("button", { name: new RegExp(`查看.*${address}.*归集详情`, "i") }));
    const details = screen.getByRole("dialog", { name: "归集详情" });
    expect(within(details).getByText("成功 2")).toBeVisible();
    expect(within(details).getByText("ERC1155 #9 · 4")).toBeVisible();
    expect(within(details).getByText("ERC1155 #10 · 2")).toBeVisible();
    const detailLinks = within(details).getAllByRole("link", { name: `查看交易 ${hash}` });
    expect(detailLinks).toHaveLength(2);
    detailLinks.forEach((link) => {
      expect(link).toHaveTextContent("0xabababab…ababab");
      expect(link).toHaveAttribute("href", explorerUrl);
    });
  });

  it("deletes the selected wallets in one confirmed step", async () => {
    const user = userEvent.setup();
    const inputRef = createRef<SecretKeyInputHandle>();
    const onDirty = vi.fn();
    const secrets = ["51", "52", "53"].map((byte) => (`0x${byte.repeat(32)}`) as `0x${string}`);
    const addresses = secrets.map((secret) => privateKeyToAccount(secret).address);
    render(<SecretKeyInput mode="evm" onDirty={onDirty} ref={inputRef} />);
    await importWallets(user, secrets.join("\n"));

    await user.click(screen.getByRole("checkbox", { name: new RegExp(addresses[2], "i") }));
    await user.click(screen.getByRole("button", { name: "删除选中 (2)" }));
    let dialog = screen.getByRole("alertdialog", { name: "删除 2 个已选钱包？" });
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(3);

    onDirty.mockClear();
    await user.click(screen.getByRole("button", { name: "删除选中 (2)" }));
    dialog = screen.getByRole("alertdialog", { name: "删除 2 个已选钱包？" });
    await user.click(within(dialog).getByRole("button", { name: "删除 2 个钱包" }));

    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByTitle(addresses[2])).toBeVisible();
    expect(screen.getByText("已选择 0 / 1")).toBeVisible();
    expect(screen.getByRole("button", { name: "删除选中" })).toBeDisabled();
    expect(onDirty).toHaveBeenCalledWith("remove", [addresses[0], addresses[1]]);
    expect(inputRef.current?.read()).toBe("");
    await user.click(screen.getByRole("checkbox", { name: new RegExp(addresses[2], "i") }));
    expect(inputRef.current?.read()).toBe(secrets[2]);
  });

  it("selects only wallets whose every read balance is exactly zero", async () => {
    const user = userEvent.setup();
    const inputRef = createRef<SecretKeyInputHandle>();
    const onDirty = vi.fn();
    const secrets = ["61", "62", "63", "64", "65"].map((byte) => (`0x${byte.repeat(32)}`) as `0x${string}`);
    // The fifth wallet was never queried and has no balances at all.
    const [empty, tokenOnly, dust, unread] = secrets.map((secret) => (
      privateKeyToAccount(secret).address.toLowerCase()
    ));
    const walletBalances = {
      [empty]: [{ amount: "0", symbol: "ETH", zero: true }, { amount: "0", symbol: "TOK", zero: true }],
      [tokenOnly]: [{ amount: "0", symbol: "ETH", zero: true }, { amount: "5", symbol: "TOK", zero: false }],
      // Rounds to "0" on screen but holds dust: only the raw flag counts.
      [dust]: [{ amount: "0", symbol: "ETH" }],
      [unread]: [{ amount: "读取失败", symbol: "ETH" }]
    };
    const { rerender } = render(<SecretKeyInput mode="evm" onDirty={onDirty} ref={inputRef} />);
    await importWallets(user, secrets.join("\n"));
    expect(screen.getByRole("button", { name: "选中余额为零" })).toBeDisabled();

    rerender(<SecretKeyInput mode="evm" onDirty={onDirty} ref={inputRef} walletBalances={walletBalances} />);
    onDirty.mockClear();
    await user.click(screen.getByRole("button", { name: "选中余额为零 (1)" }));

    expect(screen.getByText("已选择 1 / 5")).toBeVisible();
    expect(inputRef.current?.read()).toBe(secrets[0]);
    expect(onDirty).toHaveBeenCalledWith("selection");
  });

  it("imports a large pasted batch and incrementally renders wallets while scrolling", async () => {
    const user = userEvent.setup();
    render(<SecretKeyInput mode="evm" />);
    const secrets = Array.from({ length: 85 }, (_, index) => (
      `0x${(index + 1).toString(16).padStart(64, "0")}`
    ));

    await user.click(screen.getByRole("button", { name: "导入钱包" }));
    const dialog = screen.getByRole("dialog", { name: "导入来源钱包" });
    const draft = within(dialog).getByRole("textbox", { name: "粘贴私钥" });
    fireEvent.input(draft, { target: { value: secrets.join("\n") } });

    expect(within(dialog).getByText("85 / 1,000")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "确认导入" })).toHaveTextContent("导入 85 个钱包");
    await user.click(within(dialog).getByRole("button", { name: "确认导入" }));

    const walletBrowser = screen.getByLabelText("已导入来源钱包");
    const walletList = within(walletBrowser).getByRole("list");
    expect(within(walletBrowser).getByText("已显示 40 / 85")).toBeVisible();
    expect(within(walletList).getAllByRole("listitem")).toHaveLength(40);

    fireEvent.scroll(walletList);
    expect(within(walletBrowser).getByText("已显示 80 / 85")).toBeVisible();
    expect(within(walletList).getAllByRole("listitem")).toHaveLength(80);

    fireEvent.scroll(walletList);
    expect(within(walletBrowser).queryByText(/已显示/)).not.toBeInTheDocument();
    expect(within(walletList).getAllByRole("listitem")).toHaveLength(85);
    expect(within(walletBrowser).queryByRole("button", { name: "加载更多钱包" })).not.toBeInTheDocument();
  });
});

describe("smart private-wallet import preview", () => {
  it("shows only public addresses and requires explicit consent to skip invalid rows", async () => {
    const user = userEvent.setup();
    const ref = createRef<SecretKeyInputHandle>();
    const first = `0x${"77".repeat(32)}` as const;
    const second = `0x${"78".repeat(32)}` as const;
    const address = privateKeyToAccount(first).address;
    const source = `label,address,private_key\nops,${address},${first}\ninvalid,${address},${second}\nduplicate,${address},${first}`;
    const file = new File([source], "export.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", { value: async () => source });
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    render(<SecretKeyInput mode="evm" ref={ref} />);
    await user.click(screen.getByRole("button", { name: "导入钱包" }));
    const dialog = screen.getByRole("dialog", { name: "导入来源钱包" });
    await user.upload(document.querySelector<HTMLInputElement>('input[type="file"]')!, file);
    await waitFor(() => expect(within(dialog).getByLabelText("钱包导入预览")).toBeVisible());
    const preview = within(dialog).getByLabelText("钱包导入预览");
    expect(preview).toHaveTextContent("有效钱包 1");
    expect(preview).toHaveTextContent("重复 1");
    expect(preview).toHaveTextContent("问题 1");
    expect(preview).toHaveTextContent(address);
    expect(preview.textContent).not.toContain(first);
    expect(preview.textContent).not.toContain(second);
    expect(dialog.textContent).toContain("第 3 行 / 条");
    expect(within(dialog).getByLabelText("粘贴私钥")).toHaveValue("");
    expect(within(dialog).getByRole("button", { name: "确认导入" })).toBeDisabled();
    expect(ref.current!.read()).toBe("");
    await user.click(within(dialog).getByRole("checkbox", { name: /仅导入 1 个有效钱包/ }));
    await user.click(within(dialog).getByRole("button", { name: "确认导入" }));
    expect(ref.current!.read()).toBe(`ops,${first}`);
    expect(ref.current!.read()).not.toContain(second);
    expect(storageWrite).not.toHaveBeenCalled();
  });

  it("lets the user fix an invalid row and resets permission to skip when content changes", async () => {
    const user = userEvent.setup();
    const ref = createRef<SecretKeyInputHandle>();
    const first = `0x${"79".repeat(32)}`;
    const second = `0x${"80".repeat(32)}`;
    render(<SecretKeyInput mode="evm" ref={ref} />);
    await user.click(screen.getByRole("button", { name: "导入钱包" }));
    const dialog = screen.getByRole("dialog", { name: "导入来源钱包" });
    const draft = within(dialog).getByRole("textbox", { name: "粘贴私钥" });
    fireEvent.input(draft, { target: { value: `${first}\nbad` } });
    await user.click(within(dialog).getByRole("checkbox", { name: /仅导入 1 个有效钱包/ }));
    expect(within(dialog).getByRole("button", { name: "确认导入" })).toBeEnabled();
    fireEvent.input(draft, { target: { value: `${first}\nother-bad` } });
    expect(within(dialog).getByRole("checkbox", { name: /仅导入 1 个有效钱包/ })).not.toBeChecked();
    expect(within(dialog).getByRole("button", { name: "确认导入" })).toBeDisabled();
    fireEvent.input(draft, { target: { value: `${first}\n${second}` } });
    expect(within(dialog).queryByRole("checkbox", { name: /仅导入/ })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "确认导入" }));
    expect(ref.current!.read()).toBe(`${first}\n${second}`);
  });

  it("imports JSON objects through the same preview and preserves safe labels", async () => {
    const user = userEvent.setup();
    const ref = createRef<SecretKeyInputHandle>();
    const pair = Keypair.fromSeed(new Uint8Array(32).fill(39));
    const bytes = Array.from(pair.secretKey);
    const source = JSON.stringify({ wallets: [{ name: "备用钱包", publicKey: pair.publicKey.toBase58(), secretKey: bytes }] });
    const file = new File([source], "wallets.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: async () => source });
    render(<SecretKeyInput mode="solana" ref={ref} />);
    await user.click(screen.getByRole("button", { name: "导入钱包" }));
    const dialog = screen.getByRole("dialog", { name: "导入来源钱包" });
    await user.upload(document.querySelector<HTMLInputElement>('input[type="file"]')!, file);
    await waitFor(() => expect(within(dialog).getByLabelText("钱包导入预览")).toHaveTextContent(pair.publicKey.toBase58()));
    expect(within(dialog).getByLabelText("钱包导入预览")).toHaveTextContent("备用钱包");
    expect(dialog.textContent).not.toContain(JSON.stringify(bytes));
    await user.click(within(dialog).getByRole("button", { name: "确认导入" }));
    expect(ref.current!.read()).toBe(`备用钱包,${JSON.stringify(bytes)}`);
  });

  it.each(["cancel", "disable", "unmount"])("ignores file results after %s", async (action) => {
    const user = userEvent.setup();
    const ref = createRef<SecretKeyInputHandle>();
    const secret = `0x${"81".repeat(32)}`;
    let resolveRead!: (value: string) => void;
    const file = new File([secret], "keys.txt", { type: "text/plain" });
    Object.defineProperty(file, "text", { value: () => new Promise<string>((resolve) => { resolveRead = resolve; }) });
    const onImportingChange = vi.fn();
    const mounted = render(<SecretKeyInput mode="evm" onImportingChange={onImportingChange} ref={ref} />);
    const secretStore = document.querySelector<HTMLTextAreaElement>(".secret-dom-store")!;
    await user.click(screen.getByRole("button", { name: "导入钱包" }));
    const dialog = screen.getByRole("dialog", { name: "导入来源钱包" });
    const draft = within(dialog).getByRole("textbox", { name: "粘贴私钥" }) as HTMLTextAreaElement;
    await user.upload(document.querySelector<HTMLInputElement>('input[type="file"]')!, file);
    expect(onImportingChange).toHaveBeenLastCalledWith(true);
    if (action === "cancel") await user.click(within(dialog).getByRole("button", { name: "取消" }));
    else if (action === "disable") mounted.rerender(<SecretKeyInput disabled mode="evm" onImportingChange={onImportingChange} ref={ref} />);
    else mounted.unmount();
    await act(async () => resolveRead(secret));
    expect(secretStore.value).toBe("");
    expect(draft.value).toBe("");
    expect(screen.queryByLabelText("钱包导入预览")).not.toBeInTheDocument();
    expect(onImportingChange).toHaveBeenLastCalledWith(false);
    if (action !== "unmount") expect(ref.current!.read()).toBe("");
  });
});
