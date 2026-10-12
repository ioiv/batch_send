// @vitest-environment jsdom

import { expandSettings } from "../test/workbench";

import { useRef, useState, type ReactNode } from "react";
import { Keypair } from "@solana/web3.js";
import { privateKeyToAccount } from "viem/accounts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretKeyInput, type SecretKeyInputHandle, type SecretKeyInputSnapshot } from "../components/SecretKeyInput";
import { type CollectionModeConfig } from "../components/AutomaticCollectionWorkbench";
import { CollectionModePage } from "./CollectionModePage";

vi.mock("../hooks/useEvmGas", () => ({ useEvmGas: () => ({ gasSettings: { gasLimit: "auto", gasPrice: "auto" } }) }));
vi.mock("../components/EvmGasControl", () => ({ EvmGasBadge: () => null, EvmGasSettings: () => null }));
vi.mock("../lib/automatic-sol-collection", () => ({ prepareAutomaticSolCollection: vi.fn() }));
vi.mock("../lib/automatic-evm-collection", () => ({ prepareAutomaticEvmCollection: vi.fn() }));
vi.mock("../components/ToolPageLayout", () => ({
  ToolPageLayout: ({ children, modeSwitch }: { children: ReactNode; modeSwitch: ReactNode }) => <main>{modeSwitch}{children}</main>
}));
vi.mock("./EvmCollectionPage", () => ({ EvmCollectionPage: (props: ManualProps) => <ManualPage mode="evm" {...props} /> }));
vi.mock("./SolCollectionPage", () => ({ SolCollectionPage: (props: ManualProps) => <ManualPage mode="solana" {...props} /> }));

type ManualProps = {
  mode?: "evm" | "solana";
  fixedStandard?: "erc20" | "nft";
  readInitialWallets: () => SecretKeyInputSnapshot | null;
  initialConfig?: CollectionModeConfig;
  onAutomatic: (snapshot: SecretKeyInputSnapshot, config: CollectionModeConfig) => void;
};

/** Only the manual page's heavy network form is mocked; wallet handoff stays real. */
function ManualPage({ mode = "evm", fixedStandard, readInitialWallets, initialConfig, onAutomatic }: ManualProps) {
  const ref = useRef<SecretKeyInputHandle>(null);
  const [config, setConfig] = useState(initialConfig || { networkId: mode === "evm" ? "ethereum" : "devnet", rpcEndpoint: "https://rpc.example.com", targetAddress: "" });
  return <main data-manual-standard={fixedStandard || "solana"}>
    <SecretKeyInput mode={mode} ref={ref} readInitialWallets={readInitialWallets} />
    <label htmlFor="manual-target">手动接收地址</label><input id="manual-target" value={config.targetAddress} onChange={(event) => setConfig({ ...config, targetAddress: event.target.value })} />
    <label htmlFor="manual-rpc">手动 RPC</label><input id="manual-rpc" value={config.rpcEndpoint} onChange={(event) => setConfig({ ...config, rpcEndpoint: event.target.value })} />
    <button type="button" onClick={() => onAutomatic(ref.current!.handoff(), config)}>进入一键归集</button>
  </main>;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("CollectionModePage DOM handoff", () => {
  it.each([
    { kind: "evm", fixedStandard: "erc20" },
    { kind: "evm", fixedStandard: "nft" },
    { kind: "solana", fixedStandard: "erc20" }
  ] as const)("preserves every wallet, selection and config across $kind / $fixedStandard modes", async ({ kind, fixedStandard }) => {
    const user = userEvent.setup();
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    const evmKeys = ["81", "82"].map((byte) => (`0x${byte.repeat(32)}`) as `0x${string}`);
    const solKeys = [Keypair.fromSeed(new Uint8Array(32).fill(81)), Keypair.fromSeed(new Uint8Array(32).fill(82))];
    const keys = kind === "evm" ? evmKeys : solKeys.map((item) => JSON.stringify([...item.secretKey]));
    const addresses = kind === "evm" ? evmKeys.map((key) => privateKeyToAccount(key).address) : solKeys.map((item) => item.publicKey.toBase58());
    const target = kind === "evm" ? "0x0000000000000000000000000000000000000001" : Keypair.fromSeed(new Uint8Array(32).fill(83)).publicKey.toBase58();
    render(<CollectionModePage kind={kind} fixedStandard={fixedStandard} />);
    expect(screen.getAllByRole("main")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "导入钱包" }));
    const dialog = screen.getByRole("dialog", { name: "导入来源钱包" });
    fireEvent.input(within(dialog).getByRole("textbox", { name: "粘贴私钥" }), { target: { value: keys.join("\n") } });
    await user.click(within(dialog).getByRole("button", { name: "确认导入" }));
    await user.click(screen.getByRole("checkbox", { name: new RegExp(addresses[1], "i") }));
    fireEvent.change(screen.getByRole("textbox", { name: "手动接收地址" }), { target: { value: target } });
    const firstStore = document.querySelector<HTMLTextAreaElement>(".secret-dom-store")!;
    await user.click(screen.getByRole("button", { name: "进入一键归集" }));
    expect(firstStore.value).toBe("");
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getByText("已选择 1 / 2")).toBeVisible();
    expect(screen.getByTitle(addresses[0])).toBeVisible();
    expect(screen.getByTitle(addresses[1])).toBeVisible();
    expect(screen.getByRole("textbox", { name: "接收地址" })).toHaveValue(target);
    expect(document.querySelector<HTMLTextAreaElement>(".secret-dom-store")!.value).toBe(keys.join("\n"));
    const changedRpc = "https://changed-rpc.example.com";
    await user.click(screen.getByRole("checkbox", { name: "最后归集原生币" }));
    if (kind === 'evm') {
      expandSettings("费用保护设置");
      fireEvent.change(screen.getByRole("textbox", { name: /单笔最高网络费/u }), { target: { value: "0.003" } });
      expandSettings("资产索引设置");
      fireEvent.change(screen.getByRole("textbox", { name: "资产索引节点" }), { target: { value: "https://custom.blockscout.example" } });
    }
    expandSettings("修改 RPC");
    fireEvent.change(screen.getByRole("textbox", { name: "RPC 节点" }), { target: { value: changedRpc } });
    const automaticStore = document.querySelector<HTMLTextAreaElement>(".secret-dom-store")!;
    await user.click(screen.getByRole("tab", { name: "手动归集" }));
    expect(automaticStore.value).toBe("");
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getByText("已选择 1 / 2")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "手动接收地址" })).toHaveValue(target);
    expect(screen.getByRole("textbox", { name: "手动 RPC" })).toHaveValue(changedRpc);
    expect(screen.getByRole("checkbox", { name: new RegExp(addresses[0], "i") })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: new RegExp(addresses[1], "i") })).not.toBeChecked();
    const lastStore = document.querySelector<HTMLTextAreaElement>(".secret-dom-store")!;
    expect(lastStore.value).toBe(keys.join("\n"));
    expect(document.body.textContent).not.toContain(keys[0]);
    expect(storageWrite).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "进入一键归集" }));
    expect(screen.getByRole("checkbox", { name: "最后归集原生币" })).toBeChecked();
    if (kind === 'evm') {
      expandSettings("费用保护设置");
      expect(screen.getByRole("textbox", { name: /单笔最高网络费/u })).toHaveValue("0.003");
      expandSettings("资产索引设置");
      expect(screen.getByRole("textbox", { name: "资产索引节点" })).toHaveValue("https://custom.blockscout.example");
    }
    await user.click(screen.getByRole("tab", { name: "手动归集" }));
    const restoredStore = document.querySelector<HTMLTextAreaElement>(".secret-dom-store")!;
    fireEvent(window, new Event("pagehide"));
    expect(restoredStore.value).toBe("");
  });
});
