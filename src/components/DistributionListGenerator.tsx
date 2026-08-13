import { useEffect, useId, useMemo, useState } from "react";
import { getDuplicateAddressKey, type AddressKind } from "../lib/address";
import {
  dedupeDistributionAddresses,
  generateDistributionList,
  getDistributionAmountStep,
  type DistributionAmountMode,
  type GeneratedDistributionList
} from "../lib/distribution-generator";

type DistributionListGeneratorProps = {
  addressKind: AddressKind;
  decimals: number;
  disabled?: boolean;
  generationDisabled?: boolean;
  initialAddresses?: string;
  initialFixedAmount?: string;
  onDirty?: () => void;
  onResultChange: (result: GeneratedDistributionList) => void;
  symbol: string;
  unavailableMessage?: string;
  validateAddress?: (address: string) => boolean;
};

const randomEntropyBytes = 128;
const randomEntropyRange = 1n << BigInt(randomEntropyBytes * 8);

function createRandomEntropy() {
  const bytes = crypto.getRandomValues(new Uint8Array(randomEntropyBytes));
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) + BigInt(byte);
  return value;
}

function extendRandomEntropies(
  addresses: string,
  addressKind: AddressKind,
  current: Map<string, bigint>
) {
  const next = new Map(current);
  addresses.split(/\n+/).map((address) => address.trim()).filter(Boolean).forEach((address) => {
    const key = getDuplicateAddressKey(address, addressKind);
    if (!next.has(key)) next.set(key, createRandomEntropy());
  });
  return next;
}

function formatStepUnits(units: bigint, decimals: number) {
  if (decimals === 0) return units.toString();

  const padded = units.toString().padStart(decimals + 1, "0");
  const integer = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${integer}.${fraction}` : integer;
}

export function DistributionListGenerator({
  addressKind,
  decimals,
  disabled = false,
  generationDisabled = false,
  initialAddresses = "",
  initialFixedAmount = "0.1",
  onDirty,
  onResultChange,
  symbol,
  unavailableMessage,
  validateAddress
}: DistributionListGeneratorProps) {
  const instanceId = useId().replace(/:/g, "");
  const [addresses, setAddresses] = useState(initialAddresses);
  const [mode, setMode] = useState<DistributionAmountMode>("fixed");
  const [fixedAmount, setFixedAmount] = useState(initialFixedAmount);
  const [minAmount, setMinAmount] = useState("0.5");
  const [maxAmount, setMaxAmount] = useState("1");
  const [randomEntropies, setRandomEntropies] = useState<Map<string, bigint>>(() => new Map());
  const randomBigInt = useMemo(() => {
    if (mode !== "random") return undefined;

    return (min: bigint, max: bigint, address: string) => {
      const key = getDuplicateAddressKey(address, addressKind);
      const entropy = randomEntropies.get(key) ?? 0n;
      const range = max - min + 1n;
      const selectedOffset = entropy * range / randomEntropyRange;
      return min + selectedOffset;
    };
  }, [addressKind, mode, randomEntropies]);
  const result = useMemo(() => generateDistributionList({
    addresses,
    addressKind,
    decimals,
    fixedAmount,
    maxAmount,
    minAmount,
    mode,
    randomBigInt,
    validateAddress
  }), [addressKind, addresses, decimals, fixedAmount, maxAmount, minAmount, mode, randomBigInt, validateAddress]);
  const fixedStep = formatStepUnits(getDistributionAmountStep(fixedAmount, decimals), decimals);
  const randomStep = formatStepUnits(getDistributionAmountStep(minAmount, maxAmount, decimals), decimals);
  const statusLabel = unavailableMessage
    ? "等待资产精度"
    : result.invalid > 0
    ? `${result.invalid} 处需修正`
    : result.duplicates > 0
      ? `${result.duplicates} 个重复地址`
      : result.validCount > 0
        ? `${result.validCount} 个地址已就绪`
        : "等待地址";
  const statusClassName = unavailableMessage
    ? ""
    : result.invalid > 0 || result.duplicates > 0
      ? " error"
      : result.validCount > 0
        ? " ready"
        : "";

  useEffect(() => {
    onResultChange(result);
  }, [onResultChange, result]);

  const regenerateRandomAmounts = () => {
    onDirty?.();
    setRandomEntropies(extendRandomEntropies(addresses, addressKind, new Map()));
  };

  const updateValue = (setter: (value: string) => void, value: string) => {
    onDirty?.();
    setter(value);
  };

  const updateAddresses = (value: string) => {
    onDirty?.();
    setAddresses(value);
    if (mode === "random") {
      setRandomEntropies(extendRandomEntropies(value, addressKind, randomEntropies));
    }
  };

  return (
    <section
      aria-disabled={disabled || undefined}
      className={`distribution-generator${disabled ? " disabled" : ""}${generationDisabled ? " generation-disabled" : ""}`}
      aria-label="批量金额清单生成器"
    >
      <div className="generator-heading">
        <label htmlFor={`${instanceId}-addresses`}>收款地址</label>
        <span className={`pill generator-status${statusClassName}`} aria-live="polite">
          {statusLabel}
        </span>
      </div>

      {unavailableMessage ? (
        <div className="notice compact-notice">
          <strong>金额生成暂不可用</strong>
          <span>{unavailableMessage}</span>
        </div>
      ) : null}

      <div className="field">
        <textarea
          className="address-only-input"
          disabled={disabled}
          id={`${instanceId}-addresses`}
          placeholder={addressKind === "evm"
            ? "0x0000000000000000000000000000000000000001\n0x0000000000000000000000000000000000000002"
            : "11111111111111111111111111111111\nBPFLoader1111111111111111111111111111111111"}
          spellCheck={false}
          value={addresses}
          onChange={(event) => updateAddresses(event.target.value)}
        />
      </div>

      <div className="mode-row generator-mode-row" role="radiogroup" aria-label="批量金额模式">
        <label className="mode">
          <span className="mode-head">
            <input
              checked={mode === "fixed"}
              disabled={disabled || generationDisabled}
              name={`${instanceId}-amount-mode`}
              type="radio"
              value="fixed"
              onChange={() => {
                onDirty?.();
                setMode("fixed");
              }}
            />
            固定金额
          </span>
        </label>
        <label className="mode">
          <span className="mode-head">
            <input
              checked={mode === "random"}
              disabled={disabled || generationDisabled}
              name={`${instanceId}-amount-mode`}
              type="radio"
              value="random"
              onChange={() => {
                setMode("random");
                regenerateRandomAmounts();
              }}
            />
            随机区间
          </span>
        </label>
      </div>

      {mode === "fixed" ? (
        <div className="amount-grid generator-amount-grid fixed">
          <div className="field">
            <label htmlFor={`${instanceId}-fixed-amount`}>每个地址的金额（{symbol}）</label>
            <input
              disabled={disabled || generationDisabled}
              id={`${instanceId}-fixed-amount`}
              min="0"
              step={fixedStep}
              type="number"
              value={fixedAmount}
              onChange={(event) => updateValue(setFixedAmount, event.target.value)}
            />
          </div>
        </div>
      ) : (
        <div className="amount-grid generator-amount-grid random">
          <div className="field">
            <label htmlFor={`${instanceId}-min-amount`}>随机最小值（{symbol}）</label>
            <input
              disabled={disabled || generationDisabled}
              id={`${instanceId}-min-amount`}
              min="0"
              step={randomStep}
              type="number"
              value={minAmount}
              onChange={(event) => updateValue(setMinAmount, event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor={`${instanceId}-max-amount`}>随机最大值（{symbol}）</label>
            <input
              disabled={disabled || generationDisabled}
              id={`${instanceId}-max-amount`}
              min="0"
              step={randomStep}
              type="number"
              value={maxAmount}
              onChange={(event) => updateValue(setMaxAmount, event.target.value)}
            />
          </div>
        </div>
      )}

      <div className="actions generator-actions">
        <div className="action-group">
          {mode === "random" ? (
            <button
              className="button ghost"
              disabled={disabled || generationDisabled || !result.output}
              type="button"
              onClick={regenerateRandomAmounts}
            >重新随机</button>
          ) : null}
          <button
            className="button ghost"
            disabled={disabled || result.duplicates === 0}
            type="button"
            onClick={() => updateAddresses(dedupeDistributionAddresses(addresses, addressKind))}
          >去重</button>
          <button
            className="button danger"
            disabled={disabled || !addresses.trim()}
            type="button"
            onClick={() => {
              updateAddresses("");
              setRandomEntropies(new Map());
            }}
          >清空</button>
        </div>
      </div>

      <div className="invalid-list" aria-live="polite">
        {result.issues.slice(0, 5).map((issue) => <div key={issue}>{issue}</div>)}
        {result.duplicates > 0 ? <div>发现 {result.duplicates} 个重复地址，请先去重后再发送。</div> : null}
      </div>
    </section>
  );
}
