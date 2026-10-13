import { useId, type Ref } from "react";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type { DistributionAmountMode } from "../lib/distribution-generator";
import "./distribution-workbench.css";

export type DistributionListEditorProps = {
  addressInputRef?: Ref<HTMLTextAreaElement>;
  collapseAddressInput?: boolean;
  addressEditorOpen?: boolean;
  onAddressEditorOpenChange?: (open: boolean) => void;
  addressPlaceholder: string;
  addresses: string;
  disabled?: boolean;
  fixedAmount: string;
  fixedAmountStep: string;
  generationDisabled?: boolean;
  idPrefix?: string;
  maxAmount: string;
  minAmount: string;
  mode: DistributionAmountMode;
  onAddressesChange: (value: string) => void;
  onFixedAmountChange: (value: string) => void;
  onMaxAmountChange: (value: string) => void;
  onMinAmountChange: (value: string) => void;
  onModeChange: (mode: DistributionAmountMode) => void;
  randomAmountStep: string;
  symbol?: string;
};

export function DistributionListEditor({
  addressInputRef,
  collapseAddressInput = false,
  addressEditorOpen = false,
  onAddressEditorOpenChange,
  addressPlaceholder,
  addresses,
  disabled = false,
  fixedAmount,
  fixedAmountStep,
  generationDisabled = false,
  idPrefix,
  maxAmount,
  minAmount,
  mode,
  onAddressesChange,
  onFixedAmountChange,
  onMaxAmountChange,
  onMinAmountChange,
  onModeChange,
  randomAmountStep,
  symbol
}: DistributionListEditorProps) {
  const generatedId = useId().replace(/:/g, "");
  const fieldPrefix = idPrefix || generatedId;
  const amountSuffix = symbol ? `（${symbol}）` : "";
  const amountControlsDisabled = disabled || generationDisabled;
  const addressField = (
    <Field>
      <FieldLabel htmlFor={`${fieldPrefix}-addresses`}>{mode === "per-row" ? "收款地址与金额" : "收款地址"}</FieldLabel>
      <Textarea
        className="address-only-input"
        disabled={disabled}
        id={`${fieldPrefix}-addresses`}
        placeholder={mode === "per-row" ? addressPlaceholder.split("\n").map((address) => `${address},0.1`).join("\n") : addressPlaceholder}
        ref={addressInputRef}
        spellCheck={false}
        value={addresses}
        onChange={(event) => onAddressesChange(event.target.value)}
      />
    </Field>
  );

  return (
    <section
      aria-disabled={disabled || undefined}
      aria-label="分发清单编辑"
      id="distribution-input"
      className="distribution-list-editor grid min-w-0 gap-4"
    >
      {collapseAddressInput ? (
        <details className="distribution-source-editor" open={addressEditorOpen} onToggle={event => onAddressEditorOpenChange?.(event.currentTarget.open)}>
          <summary>编辑原始清单</summary>
          {addressField}
        </details>
      ) : addressField}

      <Tabs
        className="generator-mode-row distribution-amount-row"
        onValueChange={(value) => {
          if (value === "fixed" || value === "random" || value === "per-row") onModeChange(value);
        }}
        value={mode}
      >
        <TabsList aria-label="批量金额模式">
          <TabsTrigger disabled={amountControlsDisabled} value="fixed">固定金额</TabsTrigger>
          <TabsTrigger disabled={amountControlsDisabled} value="random">随机区间</TabsTrigger>
          <TabsTrigger disabled={amountControlsDisabled} value="per-row">逐行金额</TabsTrigger>
        </TabsList>
        <TabsContent value="fixed">
          <div className="amount-grid generator-amount-grid" data-mode="fixed">
            <Field>
              <FieldLabel htmlFor={`${fieldPrefix}-fixed-amount`}>每个地址的金额{amountSuffix}</FieldLabel>
              <Input
                disabled={amountControlsDisabled}
                id={`${fieldPrefix}-fixed-amount`}
                min="0"
                inputMode="decimal"
                step={fixedAmountStep}
                type="number"
                value={fixedAmount}
                onChange={(event) => onFixedAmountChange(event.target.value)}
              />
            </Field>
          </div>
        </TabsContent>
        <TabsContent value="random">
          <div className="amount-grid generator-amount-grid" data-mode="random">
            <Field>
              <FieldLabel htmlFor={`${fieldPrefix}-min-amount`}>随机最小值{amountSuffix}</FieldLabel>
              <Input
                disabled={amountControlsDisabled}
                id={`${fieldPrefix}-min-amount`}
                min="0"
                inputMode="decimal"
                step={randomAmountStep}
                type="number"
                value={minAmount}
                onChange={(event) => onMinAmountChange(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${fieldPrefix}-max-amount`}>随机最大值{amountSuffix}</FieldLabel>
              <Input
                disabled={amountControlsDisabled}
                id={`${fieldPrefix}-max-amount`}
                min="0"
                inputMode="decimal"
                step={randomAmountStep}
                type="number"
                value={maxAmount}
                onChange={(event) => onMaxAmountChange(event.target.value)}
              />
            </Field>
          </div>
        </TabsContent>
        <TabsContent value="per-row">
          <p className="hint">每行填写“地址,金额”，按原金额发送。切换到固定金额或随机区间会重新计算金额。</p>
        </TabsContent>
      </Tabs>
    </section>
  );
}
