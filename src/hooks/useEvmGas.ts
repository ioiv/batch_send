import { useCallback, useEffect, useMemo, useState } from "react";
import type { EvmChainConfig } from "../lib/evm";
import {
  autoEvmGasSettings,
  getEvmFeeCapPerGas,
  getEvmGasRecommendations,
  getLiveEvmFeeQuote,
  parseGweiToWei,
  type EvmFeeQuote,
  type EvmGasRecommendationTier,
  type EvmGasSettings
} from "../lib/evm-gas";

export type EvmGasMode = "auto" | "custom";
export type EvmGasChoice = "auto" | EvmGasRecommendationTier | "custom";

export type EvmGasPriceState = {
  gasPriceWei: bigint | null;
  message: string;
  quote: EvmFeeQuote | null;
  status: "idle" | "loading" | "success" | "error";
  updatedAt: number | null;
};

const initialGasPriceState: EvmGasPriceState = {
  gasPriceWei: null,
  message: "正在读取当前 Gas",
  quote: null,
  status: "loading",
  updatedAt: null
};

export function useEvmGas({
  enabled = true,
  network,
  refreshIntervalMs = 3_000,
  rpcEndpoint
}: {
  enabled?: boolean;
  network: EvmChainConfig;
  refreshIntervalMs?: number;
  rpcEndpoint: string;
}) {
  const [choice, setChoice] = useState<EvmGasChoice>("auto");
  const [customGasPriceGwei, setCustomGasPriceGwei] = useState("");
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [live, setLive] = useState<EvmGasPriceState>(initialGasPriceState);
  const customGasPriceWei = useMemo(
    () => parseGweiToWei(customGasPriceGwei),
    [customGasPriceGwei]
  );

  useEffect(() => {
    let active = true;
    let timeoutId: number | undefined;

    if (!enabled) {
      setLive({
        gasPriceWei: null,
        message: "网络确认后显示实时 Gas",
        quote: null,
        status: "idle",
        updatedAt: null
      });
      return () => {
        active = false;
      };
    }

    const refresh = async () => {
      setLive((current) => current.gasPriceWei === null
        ? { ...initialGasPriceState }
        : { ...current, message: "正在刷新当前 Gas", status: "loading" });
      try {
        const quote = await getLiveEvmFeeQuote({ network, rpcEndpoint });
        if (!active) return;
        setLive({
          gasPriceWei: getEvmFeeCapPerGas(quote),
          message: "当前 Gas 已更新",
          quote,
          status: "success",
          updatedAt: quote.sampledAt
        });
      } catch (error) {
        if (!active) return;
        setLive((current) => ({
          ...current,
          message: error instanceof Error ? error.message : "无法读取当前 Gas",
          status: "error"
        }));
      } finally {
        if (active) {
          timeoutId = window.setTimeout(() => void refresh(), refreshIntervalMs);
        }
      }
    };

    void refresh();
    return () => {
      active = false;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [enabled, network.chainId, refreshIntervalMs, refreshNonce, rpcEndpoint]);

  const refresh = useCallback(() => setRefreshNonce((value) => value + 1), []);
  const mode: EvmGasMode = choice === "auto" ? "auto" : "custom";
  const recommendations = useMemo(
    () => live.quote ? getEvmGasRecommendations(live.quote) : null,
    [live.quote]
  );
  const customGasPriceIsValid = choice !== "custom" || customGasPriceWei !== null;
  const gasSettings = useMemo<EvmGasSettings | null>(() => {
    if (choice === "auto") return autoEvmGasSettings;
    if (choice !== "custom") {
      const recommendation = recommendations?.[choice];
      return recommendation
        ? { fee: recommendation.fee, mode: "custom" }
        : null;
    }
    if (customGasPriceWei === null) return null;
    return {
      fee: { gasPrice: customGasPriceWei, type: "legacy" },
      mode: "custom"
    };
  }, [choice, customGasPriceWei, recommendations]);
  const settingsKey = choice === "custom"
    ? customGasPriceWei === null
      ? "custom:invalid"
      : `custom:legacy:${customGasPriceWei.toString()}`
    : choice === "auto"
      ? "auto"
      : `preset:${choice}`;
  const setMode = useCallback((nextMode: EvmGasMode) => setChoice(nextMode), []);

  return {
    choice,
    customGasPriceGwei,
    customGasPriceIsValid,
    customGasPriceWei,
    gasSettings,
    live,
    mode,
    recommendations,
    refresh,
    refreshCycle: live.updatedAt ?? 0,
    refreshIntervalMs,
    setChoice,
    setCustomGasPriceGwei,
    setMode,
    settingsKey
  };
}

export type EvmGasController = ReturnType<typeof useEvmGas>;
