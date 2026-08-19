import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { EvmGasChoice, EvmGasController } from "@/hooks/useEvmGas";
import { formatGasPriceGwei, getEvmFeeCapPerGas } from "@/lib/evm-gas";

const recommendationTiers = ["slow", "standard", "fast"] as const;

function formatRecommendation(gas: EvmGasController, tier: typeof recommendationTiers[number]) {
  const recommendation = gas.recommendations?.[tier];
  return recommendation
    ? formatGasPriceGwei(getEvmFeeCapPerGas(recommendation.fee))
    : "--";
}

export function EvmGasBadge({ gas }: { gas: EvmGasController }) {
  const values = recommendationTiers.map((tier) => ({
    label: gas.recommendations?.[tier].label,
    tier,
    value: formatRecommendation(gas, tier)
  }));
  const hasRecommendations = Boolean(gas.recommendations);
  const fallback = gas.live.status === "loading" ? "读取中" : "暂不可用";
  const ariaLabel = hasRecommendations
    ? `实时 Gas 推荐：${values.map(({ label, value }) => `${label} ${value} Gwei`).join("，")}`
    : `实时 Gas 推荐：${fallback}`;
  const feeType = gas.live.quote?.type === "eip1559" ? "EIP-1559 Max Fee" : "Legacy Gas Price";
  const updatedAt = gas.live.updatedAt
    ? new Date(gas.live.updatedAt).toLocaleTimeString("zh-CN", { hour12: false })
    : "尚未更新";
  const title = hasRecommendations
    ? `${feeType} · 慢 90% / 中 100% / 快 120% · ${updatedAt}`
    : gas.live.message;

  return (
    <Badge
      aria-label={ariaLabel}
      className="gas-live-badge"
      data-state={gas.live.status}
      title={title}
      variant="outline"
    >
      <span aria-hidden="true" className="gas-live-badge__dot" />
      <span className="gas-live-badge__prefix">Gas</span>
      {hasRecommendations ? values.map(({ label, tier, value }) => (
        <span className="gas-live-badge__tier" key={tier}>
          <span>{label}</span>
          <strong>{value}</strong>
        </span>
      )) : <span>{fallback}</span>}
      {hasRecommendations ? <span className="gas-live-badge__unit">Gwei</span> : null}
    </Badge>
  );
}

export function EvmGasSettings({
  disabled = false,
  gas,
  onSettingsChange
}: {
  disabled?: boolean;
  gas: EvmGasController;
  onSettingsChange?: () => void;
}) {
  const changeChoice = (nextChoice: string) => {
    if (!["auto", "slow", "standard", "fast", "custom"].includes(nextChoice)) return;
    gas.setChoice(nextChoice as EvmGasChoice);
    onSettingsChange?.();
  };

  return (
    <div className="gas-settings" aria-label="Gas 设置">
      <div className="gas-settings__bar">
        <div className="gas-settings__label" title="行情每 3 秒刷新；推荐值分别为 RPC 报价的 90%、100% 和 120%">
          <strong>Gas</strong>
          <span>3 秒</span>
        </div>

        <Tabs className="gas-settings__choices" onValueChange={changeChoice} value={gas.choice}>
          <TabsList aria-label="Gas 费率">
            <TabsTrigger disabled={disabled} title="签名前重新读取网络费用" value="auto">自动</TabsTrigger>
            {recommendationTiers.map((tier) => {
              const recommendation = gas.recommendations?.[tier];
              const value = formatRecommendation(gas, tier);
              return (
                <TabsTrigger
                  disabled={disabled || !recommendation}
                  key={tier}
                  title={recommendation ? `${recommendation.label}档 · ${value} Gwei` : "等待实时 Gas"}
                  value={tier}
                >
                  {recommendation?.label || ({ slow: "慢", standard: "中", fast: "快" } as const)[tier]}
                </TabsTrigger>
              );
            })}
            <TabsTrigger disabled={disabled} title="自定义 Legacy Gas Price" value="custom">自定义</TabsTrigger>
          </TabsList>
        </Tabs>

        {gas.choice === "custom" ? (
          <Field className="gas-settings__custom" data-invalid={!gas.customGasPriceIsValid || undefined}>
            <FieldLabel className="sr-only" htmlFor="customGasPriceGwei">Gas Price（Gwei）</FieldLabel>
            <div className="gas-settings__input-wrap">
              <Input
                aria-invalid={!gas.customGasPriceIsValid || undefined}
                autoComplete="off"
                disabled={disabled}
                id="customGasPriceGwei"
                inputMode="decimal"
                min="0"
                onChange={(event) => {
                  gas.setCustomGasPriceGwei(event.target.value);
                  onSettingsChange?.();
                }}
                placeholder={gas.live.gasPriceWei === null ? "1.5" : formatGasPriceGwei(gas.live.gasPriceWei, 6)}
                step="0.000000001"
                type="number"
                value={gas.customGasPriceGwei}
              />
              <span>Gwei</span>
            </div>
            {!gas.customGasPriceIsValid ? <FieldError>请输入大于 0、最多 9 位小数的 Gwei 值</FieldError> : null}
          </Field>
        ) : null}

        <Button
          aria-label="刷新 Gas"
          disabled={disabled || gas.live.status === "loading"}
          onClick={gas.refresh}
          size="xs"
          title="立即刷新 Gas 推荐"
          type="button"
          variant="ghost"
        >
          刷新
        </Button>
      </div>

      <span className={gas.live.status === "error" ? "gas-settings__status" : "sr-only"} role="status">
        {gas.live.message}
      </span>
    </div>
  );
}
