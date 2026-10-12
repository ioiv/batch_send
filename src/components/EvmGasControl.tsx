import { useId, type CSSProperties } from "react";
import { Popover } from "@base-ui/react/popover";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FieldError } from "./ui/field";
import type { EvmGasChoice, EvmGasController } from "@/hooks/useEvmGas";
import { formatGasPriceGwei, getEvmFeeCapPerGas } from "@/lib/evm-gas";

const recommendationTiers = ["slow", "standard", "fast"] as const;

function formatRecommendation(gas: EvmGasController, tier: typeof recommendationTiers[number]) {
  const recommendation = gas.recommendations?.[tier];
  return recommendation
    ? formatGasPriceGwei(getEvmFeeCapPerGas(recommendation.fee))
    : "--";
}

export function EvmGasBadge({ gas, networkLabel }: { gas: EvmGasController; networkLabel?: string }) {
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
    <Popover.Root modal={false}>
      <Popover.Trigger
        aria-label={ariaLabel}
        className="gas-live-badge"
        data-state={gas.live.status}
        title={title}
        render={<Button className="gas-live-badge" size="sm" variant="outline" />}
      >
        <span aria-hidden="true" className="gas-live-badge__dot" />
        <span className="gas-live-badge__prefix">Gas</span>
        {hasRecommendations ? <strong>{formatRecommendation(gas, "standard")}</strong> : <span>{fallback}</span>}
        {hasRecommendations ? <span className="gas-live-badge__unit">Gwei</span> : null}
        {networkLabel ? <span className="gas-live-badge__network">· {networkLabel}</span> : null}
        <span aria-hidden="true" className="gas-live-badge__refresh-track">
          <span
            className="gas-live-badge__refresh-progress"
            data-active={gas.refreshCycle > 0 && gas.live.status !== "loading" ? "true" : "false"}
            key={gas.refreshCycle}
            style={{ "--gas-refresh-duration": `${gas.refreshIntervalMs}ms` } as CSSProperties}
          />
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="start" className="gas-live-popover__positioner" collisionPadding={8} side="bottom" sideOffset={8}>
          <Popover.Popup className="gas-live-popover">
            <Popover.Title>实时 Gas{networkLabel ? ` · ${networkLabel}` : ""}</Popover.Title>
            <dl className="gas-live-popover__tiers">
              {values.map(({ label, tier, value }) => <div key={tier}><dt>{label || ({ slow: "慢", standard: "中", fast: "快" } as const)[tier]}</dt><dd>{value} Gwei</dd></div>)}
            </dl>
            <p>{hasRecommendations ? `${feeType} · ${updatedAt} 更新` : gas.live.message}</p>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function EvmGasSettings({
  disabled = false,
  feeEstimate,
  gas,
  onSettingsChange
}: {
  disabled?: boolean;
  feeEstimate?: string;
  gas: EvmGasController;
  onSettingsChange?: () => void;
}) {
  const customOpen = gas.choice === "custom";
  const customGasPriceId = useId();
  const changeChoice = (nextChoice: string) => {
    if (!["auto", "slow", "standard", "fast", "custom"].includes(nextChoice)) return;
    gas.setChoice(nextChoice as EvmGasChoice);
    onSettingsChange?.();
  };

  return (
    <div className="gas-settings" aria-label="Gas 设置">
      <div className="gas-settings__bar">
        <div className="gas-settings__label" title="行情每 3 秒刷新；推荐值分别为 RPC 报价的 90%、100% 和 120%">
          <strong>费率</strong>
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

        {customOpen ? (
          <div className="gas-settings__custom-control">
            <label className="sr-only" htmlFor={customGasPriceId}>Gas Price（Gwei）</label>
            <InputGroup className="gas-settings__input-wrap">
              <InputGroupInput
                aria-invalid={!gas.customGasPriceIsValid || undefined}
                aria-describedby={!gas.customGasPriceIsValid ? `${customGasPriceId}-error` : undefined}
                autoComplete="off"
                disabled={disabled}
                id={customGasPriceId}
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
              <InputGroupAddon align="inline-end" className="gas-settings__input-unit">Gwei</InputGroupAddon>
            </InputGroup>
          </div>
        ) : null}

        {feeEstimate ? (
          <div className="gas-settings__fee" aria-label={`预估网络费 ${feeEstimate}`}>
            <span>预估网络费</span>
            <strong>{feeEstimate}</strong>
          </div>
        ) : null}
      </div>

      {customOpen && !gas.customGasPriceIsValid ? <FieldError id={`${customGasPriceId}-error`}>请输入有效的 Gas Price（Gwei）</FieldError> : null}

      <span className={gas.live.status === "error" ? "gas-settings__status" : "sr-only"} role="status">
        {gas.live.message}
      </span>
    </div>
  );
}
