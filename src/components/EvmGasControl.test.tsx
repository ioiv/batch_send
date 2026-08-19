// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvmChainConfig } from "../lib/evm";
import type {
  EvmFeeQuote,
  EvmGasSettings as EvmGasSettingsConfig
} from "../lib/evm-gas";

const gasMocks = vi.hoisted(() => ({
  getLiveFeeQuote: vi.fn()
}));

vi.mock("../lib/evm-gas", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/evm-gas")>();
  return { ...actual, getLiveEvmFeeQuote: gasMocks.getLiveFeeQuote };
});

import { EvmGasBadge, EvmGasSettings } from "./EvmGasControl";
import { useEvmGas } from "../hooks/useEvmGas";

const network: EvmChainConfig = {
  blockExplorerUrl: "https://scan.example",
  chainId: 1,
  label: "Test EVM",
  nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
  rpcEndpoint: "https://rpc.example"
};

const legacyQuote: EvmFeeQuote = {
  gasPrice: 10_000_000_000n,
  sampledAt: 1_700_000_000_000,
  source: "rpc",
  type: "legacy"
};

const eip1559Quote: EvmFeeQuote = {
  maxFeePerGas: 10_000_000_000n,
  maxPriorityFeePerGas: 2_000_000_000n,
  sampledAt: 1_700_000_000_000,
  source: "rpc",
  type: "eip1559"
};

function serializeSettings(settings: EvmGasSettingsConfig | null) {
  if (!settings) return "invalid";
  if (settings.mode === "auto") return "auto";
  return settings.fee.type === "legacy"
    ? `custom|legacy|${settings.fee.gasPrice}`
    : `custom|eip1559|${settings.fee.maxFeePerGas}|${settings.fee.maxPriorityFeePerGas}`;
}

function GasHarness({ onSettingsChange }: { onSettingsChange?: () => void }) {
  const gas = useEvmGas({ network, rpcEndpoint: network.rpcEndpoint });

  return (
    <>
      <EvmGasBadge gas={gas} />
      <EvmGasSettings gas={gas} onSettingsChange={onSettingsChange} />
      <output aria-label="当前 Gas 设置">{serializeSettings(gas.gasSettings)}</output>
      <output aria-label="Gas 设置键">{gas.settingsKey}</output>
    </>
  );
}

function PollingHarness() {
  useEvmGas({ network, rpcEndpoint: network.rpcEndpoint });
  return null;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  gasMocks.getLiveFeeQuote.mockReset();
});

describe("EVM Gas controls", () => {
  it("requests immediately, polls serially 3 seconds after completion, and stops after unmount", async () => {
    vi.useFakeTimers();
    const firstRequest = createDeferred<EvmFeeQuote>();
    gasMocks.getLiveFeeQuote
      .mockImplementationOnce(() => firstRequest.promise)
      .mockResolvedValue(legacyQuote);

    const { unmount } = render(<PollingHarness />);
    expect(gasMocks.getLiveFeeQuote).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(gasMocks.getLiveFeeQuote).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstRequest.resolve(legacyQuote);
      await firstRequest.promise;
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_999);
    });
    expect(gasMocks.getLiveFeeQuote).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(gasMocks.getLiveFeeQuote).toHaveBeenCalledTimes(2);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(gasMocks.getLiveFeeQuote).toHaveBeenCalledTimes(2);
  });

  it("exposes slow, standard, and fast recommendation values in the compact badge", async () => {
    gasMocks.getLiveFeeQuote.mockResolvedValue(eip1559Quote);
    render(<GasHarness />);

    const badges = await screen.findAllByLabelText(/实时 Gas 推荐：慢 9 Gwei/);
    const accessibleLabel = badges[0].getAttribute("aria-label") || "";
    expect(accessibleLabel).toContain("慢 9 Gwei");
    expect(accessibleLabel).toContain("中 10 Gwei");
    expect(accessibleLabel).toContain("快 12 Gwei");

    const rateTabs = screen.getByRole("tablist", { name: "Gas 费率" });
    expect(within(rateTabs).getByRole("tab", { name: "慢" })).toBeVisible();
    expect(within(rateTabs).getByRole("tab", { name: "中" })).toBeVisible();
    expect(within(rateTabs).getByRole("tab", { name: "快" })).toBeVisible();
  });

  it.each([
    {
      expectedSettings: "custom|legacy|10000000000",
      name: "legacy",
      quote: legacyQuote
    },
    {
      expectedSettings: "custom|eip1559|10000000000|2000000000",
      name: "EIP-1559",
      quote: eip1559Quote
    }
  ])("maps the standard recommendation to the exact $name fee type", async ({ expectedSettings, quote }) => {
    gasMocks.getLiveFeeQuote.mockResolvedValue(quote);
    const onSettingsChange = vi.fn();
    const user = userEvent.setup();
    render(<GasHarness onSettingsChange={onSettingsChange} />);

    const rateTabs = await screen.findByRole("tablist", { name: "Gas 费率" });
    await user.click(within(rateTabs).getByRole("tab", { name: "中" }));

    await waitFor(() => {
      expect(screen.getByLabelText("当前 Gas 设置")).toHaveTextContent(expectedSettings);
      expect(screen.getByLabelText("Gas 设置键")).toHaveTextContent("preset:standard");
    });
    expect(onSettingsChange).toHaveBeenCalled();
  });

  it("keeps custom validation and settings invalidation callbacks in the compact control", async () => {
    gasMocks.getLiveFeeQuote.mockResolvedValue(legacyQuote);
    const onSettingsChange = vi.fn();
    const user = userEvent.setup();
    render(<GasHarness onSettingsChange={onSettingsChange} />);

    const rateTabs = await screen.findByRole("tablist", { name: "Gas 费率" });
    await user.click(within(rateTabs).getByRole("tab", { name: "自定义" }));

    const customInput = screen.getByRole("spinbutton", { name: "Gas Price（Gwei）" });
    expect(customInput).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("请输入大于 0、最多 9 位小数的 Gwei 值")).toBeVisible();
    expect(screen.getByLabelText("当前 Gas 设置")).toHaveTextContent("invalid");
    const callbacksAfterModeChange = onSettingsChange.mock.calls.length;
    expect(callbacksAfterModeChange).toBeGreaterThan(0);

    await user.type(customInput, "2.5");

    await waitFor(() => {
      expect(screen.getByLabelText("当前 Gas 设置")).toHaveTextContent("custom|legacy|2500000000");
      expect(customInput).not.toHaveAttribute("aria-invalid", "true");
    });
    expect(onSettingsChange.mock.calls.length).toBeGreaterThan(callbacksAfterModeChange);
  });
});
