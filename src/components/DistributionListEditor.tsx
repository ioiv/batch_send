import { useId, type Ref } from "react";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type { DistributionAmountMode } from "../lib/distribution-generator";

export type DistributionListEditorProps = {
  addressInputRef?: Ref<HTMLTextAreaElement>;
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

  return (
    <section
      aria-disabled={disabled || undefined}
      aria-label="分发清单编辑"
      className="distribution-list-editor grid min-w-0 gap-4"
    >
      <Field>
        <FieldLabel htmlFor={`${fieldPrefix}-addresses`}>收款地址</FieldLabel>
        <Textarea
          className="address-only-input"
          disabled={disabled}
          id={`${fieldPrefix}-addresses`}
          placeholder={addressPlaceholder}
          ref={addressInputRef}
          spellCheck={false}
          value={addresses}
          onChange={(event) => onAddressesChange(event.target.value)}
        />
      </Field>

      <Tabs
        className="generator-mode-row"
        onValueChange={(value) => {
          if (value === "fixed" || value === "random") onModeChange(value);
        }}
        value={mode}
      >
        <TabsList aria-label="批量金额模式">
          <TabsTrigger disabled={amountControlsDisabled} value="fixed">固定金额</TabsTrigger>
          <TabsTrigger disabled={amountControlsDisabled} value="random">随机区间</TabsTrigger>
        </TabsList>
        <TabsContent value="fixed">
          <div className="amount-grid generator-amount-grid" data-mode="fixed">
            <Field>
              <FieldLabel htmlFor={`${fieldPrefix}-fixed-amount`}>每个地址的金额{amountSuffix}</FieldLabel>
              <Input
                disabled={amountControlsDisabled}
                id={`${fieldPrefix}-fixed-amount`}
                min="0"
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
                step={randomAmountStep}
                type="number"
                value={maxAmount}
                onChange={(event) => onMaxAmountChange(event.target.value)}
              />
            </Field>
          </div>
        </TabsContent>
      </Tabs>
    </section>
  );
}
