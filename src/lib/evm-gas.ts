import { createPublicClient, http } from "viem";
import type { EvmChainConfig } from "./evm";

export const GWEI_IN_WEI = 1_000_000_000n;

export type EvmFeeParameters =
  | {
      gasPrice: bigint;
      type: "legacy";
    }
  | {
      maxFeePerGas: bigint;
      maxPriorityFeePerGas: bigint;
      type: "eip1559";
    };

export type EvmGasSettings =
  | { mode: "auto" }
  | {
      fee: EvmFeeParameters;
      mode: "custom";
    };

export type EvmFeeQuote = EvmFeeParameters & {
  sampledAt: number;
  source: "custom" | "rpc";
};

export type EvmGasRecommendationTier = "slow" | "standard" | "fast";

export type EvmGasRecommendationLabels = {
  slow: "慢";
  standard: "中";
  fast: "快";
};

export type EvmGasRecommendationMultipliers = {
  slow: 90;
  standard: 100;
  fast: 120;
};

export type EvmGasRecommendation<
  TTier extends EvmGasRecommendationTier = EvmGasRecommendationTier
> = {
  fee: EvmFeeParameters;
  label: EvmGasRecommendationLabels[TTier];
  multiplierPercent: EvmGasRecommendationMultipliers[TTier];
  tier: TTier;
};

export type EvmGasRecommendations = {
  [TTier in EvmGasRecommendationTier]: EvmGasRecommendation<TTier>;
};

export type EvmFeeClient = {
  estimateFeesPerGas?: () => Promise<unknown>;
  getGasPrice(): Promise<bigint>;
};

export const autoEvmGasSettings: EvmGasSettings = { mode: "auto" };

function assertPositiveFee(value: bigint, label: string) {
  if (value <= 0n) throw new Error(`${label} 必须大于 0`);
}

function assertEip1559Fee(maxFeePerGas: bigint, maxPriorityFeePerGas: bigint) {
  assertPositiveFee(maxFeePerGas, "Max Fee");
  if (maxPriorityFeePerGas < 0n) throw new Error("Priority Fee 不能小于 0");
  if (maxPriorityFeePerGas > maxFeePerGas) {
    throw new Error("Priority Fee 不能高于 Max Fee");
  }
}

function scaleFeeValue(value: bigint, multiplierPercent: bigint) {
  if (value === 0n) return 0n;
  return (value * multiplierPercent + 99n) / 100n;
}

function scaleFeeParameters(
  fee: EvmFeeParameters,
  multiplierPercent: bigint
): EvmFeeParameters {
  if (fee.type === "legacy") {
    assertPositiveFee(fee.gasPrice, "Gas Price");
    return {
      gasPrice: scaleFeeValue(fee.gasPrice, multiplierPercent),
      type: "legacy"
    };
  }

  assertEip1559Fee(fee.maxFeePerGas, fee.maxPriorityFeePerGas);
  return {
    maxFeePerGas: scaleFeeValue(fee.maxFeePerGas, multiplierPercent),
    maxPriorityFeePerGas: scaleFeeValue(fee.maxPriorityFeePerGas, multiplierPercent),
    type: "eip1559"
  };
}

/**
 * Builds deterministic fee presets from one RPC snapshot. Values are rounded
 * up so a recommendation never falls below its percentage target.
 */
export function getEvmGasRecommendations(
  rpcQuote: EvmFeeParameters
): EvmGasRecommendations {
  return {
    slow: {
      fee: scaleFeeParameters(rpcQuote, 90n),
      label: "慢",
      multiplierPercent: 90,
      tier: "slow"
    },
    standard: {
      fee: scaleFeeParameters(rpcQuote, 100n),
      label: "中",
      multiplierPercent: 100,
      tier: "standard"
    },
    fast: {
      fee: scaleFeeParameters(rpcQuote, 120n),
      label: "快",
      multiplierPercent: 120,
      tier: "fast"
    }
  };
}

function normalizeCustomQuote(fee: EvmFeeParameters): EvmFeeQuote {
  if (fee.type === "legacy") {
    assertPositiveFee(fee.gasPrice, "Gas Price");
    return {
      gasPrice: fee.gasPrice,
      sampledAt: Date.now(),
      source: "custom",
      type: "legacy"
    };
  }

  assertEip1559Fee(fee.maxFeePerGas, fee.maxPriorityFeePerGas);
  return {
    maxFeePerGas: fee.maxFeePerGas,
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
    sampledAt: Date.now(),
    source: "custom",
    type: "eip1559"
  };
}

function isEip1559Unsupported(error: unknown) {
  const detail = error instanceof Error ? `${error.name} ${error.message}` : String(error || "");
  return /Eip1559FeesNotSupported|EIP-1559 fees (?:are )?not supported|baseFeePerGas|method not found|unsupported method|-32601/i.test(detail);
}

function asFeeRecord(value: unknown) {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

/**
 * Resolves one immutable fee snapshot. Callers must pass the returned quote to
 * the write request instead of allowing a wallet to estimate a second value.
 */
export async function resolveEvmFeeQuote(
  client: EvmFeeClient,
  settings: EvmGasSettings = autoEvmGasSettings
): Promise<EvmFeeQuote> {
  if (settings.mode === "custom") return normalizeCustomQuote(settings.fee);

  if (client.estimateFeesPerGas) {
    try {
      const estimated = asFeeRecord(await client.estimateFeesPerGas());
      if (
        estimated
        && typeof estimated.maxFeePerGas === "bigint"
        && typeof estimated.maxPriorityFeePerGas === "bigint"
      ) {
        assertEip1559Fee(estimated.maxFeePerGas, estimated.maxPriorityFeePerGas);
        return {
          maxFeePerGas: estimated.maxFeePerGas,
          maxPriorityFeePerGas: estimated.maxPriorityFeePerGas,
          sampledAt: Date.now(),
          source: "rpc",
          type: "eip1559"
        };
      }
      if (estimated && typeof estimated.gasPrice === "bigint") {
        assertPositiveFee(estimated.gasPrice, "RPC Gas Price");
        return {
          gasPrice: estimated.gasPrice,
          sampledAt: Date.now(),
          source: "rpc",
          type: "legacy"
        };
      }
      throw new Error("RPC 未返回有效的 EVM 费用参数");
    } catch (error) {
      if (!isEip1559Unsupported(error)) throw error;
    }
  }

  const gasPrice = await client.getGasPrice();
  assertPositiveFee(gasPrice, "RPC Gas Price");
  return {
    gasPrice,
    sampledAt: Date.now(),
    source: "rpc",
    type: "legacy"
  };
}

export function getEvmFeeCapPerGas(fee: EvmFeeParameters) {
  return fee.type === "eip1559" ? fee.maxFeePerGas : fee.gasPrice;
}

export function getEvmFeeRequest(fee: EvmFeeParameters) {
  return fee.type === "eip1559"
    ? {
        maxFeePerGas: fee.maxFeePerGas,
        maxPriorityFeePerGas: fee.maxPriorityFeePerGas
      }
    : { gasPrice: fee.gasPrice };
}

export function parseGweiToWei(value: string): bigint | null {
  const normalized = value.trim();
  if (!/^(?:\d+|\d*\.\d+)$/.test(normalized)) return null;

  const [whole = "0", fraction = ""] = normalized.split(".");
  if (fraction.length > 9) return null;

  const wei = BigInt(whole || "0") * GWEI_IN_WEI
    + BigInt(fraction.padEnd(9, "0") || "0");
  return wei > 0n ? wei : null;
}

export function formatGasPriceGwei(valueWei: bigint, maxFractionDigits = 4) {
  const safeFractionDigits = Math.max(0, Math.min(9, maxFractionDigits));
  const whole = valueWei / GWEI_IN_WEI;
  if (safeFractionDigits === 0) return whole.toLocaleString("en-US");

  const fraction = (valueWei % GWEI_IN_WEI)
    .toString()
    .padStart(9, "0")
    .slice(0, safeFractionDigits)
    .replace(/0+$/, "");
  return fraction
    ? `${whole.toLocaleString("en-US")}.${fraction}`
    : whole.toLocaleString("en-US");
}

export async function getLiveEvmFeeQuote({
  network,
  rpcEndpoint,
  settings = autoEvmGasSettings
}: {
  network: EvmChainConfig;
  rpcEndpoint: string;
  settings?: EvmGasSettings;
}) {
  const publicClient = createPublicClient({ transport: http(rpcEndpoint) });
  const rpcChainId = await publicClient.getChainId();
  if (rpcChainId !== network.chainId) {
    throw new Error(`RPC 网络不匹配：当前 RPC 是 chainId ${rpcChainId}，请选择 ${network.label} 的 RPC（chainId ${network.chainId}）`);
  }
  return resolveEvmFeeQuote(publicClient, settings);
}

/** Backwards-compatible fee-cap query used by the live Gas badge. */
export async function getLiveEvmGasPrice(parameters: {
  network: EvmChainConfig;
  rpcEndpoint: string;
}) {
  return getEvmFeeCapPerGas(await getLiveEvmFeeQuote(parameters));
}
