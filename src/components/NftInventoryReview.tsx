import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  parseEvmCollectionAssets,
  type EvmCollectionAsset,
  type EvmCollectionStandard
} from "../lib/evm-collection";

export type NftInventoryStandard = Extract<EvmCollectionStandard, "erc721" | "erc1155">;

export type NftInventoryReviewProps = {
  assetInput: string;
  contractLabels?: ReadonlyMap<string, string>;
  disabled?: boolean;
  onChange: (value: string) => void;
  standard: NftInventoryStandard;
};

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function contractLabel(contractLabels: ReadonlyMap<string, string> | undefined, address: string) {
  const label = contractLabels?.get(address)
    || contractLabels?.get(address.toLowerCase())
    || [...(contractLabels?.entries() || [])].find(([key]) => key.toLowerCase() === address.toLowerCase())?.[1];
  return label?.trim() || "未读取名称";
}

function getAssetTokenId(asset: EvmCollectionAsset) {
  return "tokenId" in asset ? asset.tokenId.toString() : "";
}

/**
 * Removes only parsed NFT assets. Invalid source rows are deliberately retained so
 * a review action can never silently discard input that the parser could not read.
 */
export function removeValidNftInventoryAssets(
  assetInput: string,
  standard: NftInventoryStandard,
  assetKeys: Iterable<string>
) {
  const selectedKeys = new Set(assetKeys);
  if (!selectedKeys.size) return assetInput;

  const parsed = parseEvmCollectionAssets(assetInput, standard);
  const removableLines = new Set(
    parsed.rows
      .filter((row) => row.asset && selectedKeys.has(row.asset.key))
      .map((row) => row.line)
  );
  if (!removableLines.size) return assetInput;

  const lineBreak = assetInput.includes("\r\n") ? "\r\n" : "\n";
  return assetInput
    .split(/\r?\n/)
    .filter((_, index) => !removableLines.has(index + 1))
    .join(lineBreak);
}

export function NftInventoryReview({
  assetInput,
  contractLabels,
  disabled,
  onChange,
  standard
}: NftInventoryReviewProps) {
  const titleId = useId();
  const descriptionId = useId();
  const masterCheckboxRef = useRef<HTMLInputElement>(null);
  const parsed = useMemo(
    () => parseEvmCollectionAssets(assetInput, standard),
    [assetInput, standard]
  );
  const sourceLines = useMemo(() => assetInput.split(/\r?\n/), [assetInput]);
  const validAssetKeys = useMemo(
    () => parsed.assets.map((asset) => asset.key),
    [parsed.assets]
  );
  const validAssetIdentity = validAssetKeys.join("\u0000");
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setSelectedKeys((current) => {
      const validKeys = new Set(validAssetKeys);
      const next = new Set([...current].filter((key) => validKeys.has(key)));
      return next;
    });
  }, [validAssetIdentity]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedCount = validAssetKeys.reduce(
    (count, key) => count + (selectedKeys.has(key) ? 1 : 0),
    0
  );
  const allSelected = validAssetKeys.length > 0 && selectedCount === validAssetKeys.length;
  const partlySelected = selectedCount > 0 && !allSelected;

  useEffect(() => {
    if (masterCheckboxRef.current) masterCheckboxRef.current.indeterminate = partlySelected;
  }, [partlySelected]);

  const removeAssets = (keys: Iterable<string>) => {
    if (disabled) return;
    const keysToRemove = new Set(keys);
    const nextValue = removeValidNftInventoryAssets(assetInput, standard, keysToRemove);
    if (nextValue === assetInput) return;
    setSelectedKeys((current) => {
      const next = new Set(current);
      for (const key of keysToRemove) next.delete(key);
      return next;
    });
    onChange(nextValue);
  };

  return (
    <section className="nft-inventory-review" aria-labelledby={titleId} aria-describedby={descriptionId}>
      <header className="nft-inventory-review__heading">
        <div>
          <h3 id={titleId}>待归集资产</h3>
          <p id={descriptionId}>
            有效项均会归集；勾选仅用于移除；无效原始行仍会保留。
          </p>
        </div>
        <span className="pill" aria-live="polite">
          {parsed.assets.length} 个有效{parsed.invalid ? ` · ${parsed.invalid} 行无效` : ""}
        </span>
      </header>

      {parsed.rows.length === 0 ? (
        <div className="nft-inventory-review__empty empty">
          <span aria-hidden="true">＋</span>
          <strong>资产清单还是空的</strong>
          <p>识别、添加或导入 NFT。</p>
        </div>
      ) : (
        <>
          <div className="nft-inventory-review__toolbar" role="group" aria-label="资产选择与移除">
            <label className="nft-inventory-review__select-all">
              <input
                className="nft-inventory-review__checkbox"
                checked={allSelected}
                disabled={disabled || validAssetKeys.length === 0}
                onChange={(event) => setSelectedKeys(event.currentTarget.checked
                  ? new Set(validAssetKeys)
                  : new Set())}
                ref={masterCheckboxRef}
                type="checkbox"
              />
              <span>选择全部用于移除</span>
            </label>
            <span className="nft-inventory-review__selection-count">已选 {selectedCount} 项待移除</span>
            <div className="nft-inventory-review__actions">
              <button
                className="button ghost"
                disabled={disabled || selectedCount === 0}
                onClick={() => setSelectedKeys(new Set())}
                type="button"
              >清空选择</button>
              <button
                className="button ghost"
                disabled={disabled || selectedCount === 0}
                onClick={() => removeAssets(selectedKeys)}
                type="button"
              >移除选中项</button>
              <button
                className="button ghost nft-inventory-review__clear-all"
                disabled={disabled || validAssetKeys.length === 0}
                onClick={() => {
                  if (!window.confirm(`确认从清单移除全部 ${validAssetKeys.length} 个有效资产？`)) return;
                  removeAssets(validAssetKeys);
                }}
                type="button"
              >移除全部</button>
            </div>
          </div>

          <div className="nft-inventory-review__table-wrap" role="region" aria-label="NFT 资产清单" tabIndex={0}>
            <table className="nft-inventory-review__table">
              <caption className="sr-only">
                {standard === "erc721" ? "ERC721" : "ERC1155"} 待归集资产清单
              </caption>
              <thead>
                <tr>
                  <th scope="col">选择</th>
                  <th scope="col">合约</th>
                  <th scope="col">Token ID</th>
                  <th scope="col">数量</th>
                  <th scope="col">状态</th>
                  <th scope="col"><span className="sr-only">操作</span></th>
                </tr>
              </thead>
              <tbody>
                {parsed.rows.map((row) => {
                  const rawLine = sourceLines[row.line - 1] || "";
                  if (!row.asset || row.status === "invalid") {
                    return (
                      <tr className="nft-inventory-review__row is-invalid" key={`invalid-${row.line}`}>
                        <td data-label="选择"><span aria-label="无效行不可选择">—</span></td>
                        <th data-label="原始输入" scope="row">
                          <strong>第 {row.line} 行无效</strong>
                          <code>{rawLine || "未能定位原始行"}</code>
                        </th>
                        <td data-label="Token ID">—</td>
                        <td data-label="数量">—</td>
                        <td data-label="状态">
                          <span className="collection-status status-error">需修正</span>
                          <small>{row.problems.join(" / ")}</small>
                        </td>
                        <td data-label="操作"><small>保留原始行</small></td>
                      </tr>
                    );
                  }

                  const selected = row.status === "valid" && selectedKeys.has(row.asset.key);
                  const duplicate = row.status === "duplicate";
                  const name = contractLabel(contractLabels, row.asset.contractAddress);
                  return (
                    <tr
                      className={`nft-inventory-review__row${duplicate ? " is-duplicate" : ""}`}
                      key={`${row.status}-${row.line}-${row.asset.key}`}
                    >
                      <td data-label="选择">
                        {duplicate ? (
                          <span aria-label="重复行不可选择">—</span>
                        ) : (
                          <input
                            aria-label={`选择第 ${row.line} 行 NFT`}
                            checked={selected}
                            className="nft-inventory-review__checkbox"
                            disabled={disabled}
                            onChange={(event) => setSelectedKeys((current) => {
                              const next = new Set(current);
                              if (event.currentTarget.checked) next.add(row.asset!.key);
                              else next.delete(row.asset!.key);
                              return next;
                            })}
                            type="checkbox"
                          />
                        )}
                      </td>
                      <th data-label="合约" scope="row">
                        <strong>{name}</strong>
                        <code title={row.asset.contractAddress}>{shortAddress(row.asset.contractAddress)}</code>
                      </th>
                      <td data-label="Token ID"><code>{getAssetTokenId(row.asset)}</code></td>
                      <td data-label="数量">
                        {standard === "erc1155" ? (
                          <span title="执行时读取该 Token ID 的可转余额">全部余额</span>
                        ) : "1 枚"}
                      </td>
                      <td data-label="状态">
                        {duplicate ? (
                          <>
                            <span className="collection-status status-skipped">重复行</span>
                            <small>{row.problems.join(" / ")}</small>
                          </>
                        ) : <span className="collection-status status-success">可归集</span>}
                      </td>
                      <td data-label="操作">
                        {duplicate ? <small>随对应资产一起移除</small> : (
                          <button
                            aria-label={`移除第 ${row.line} 行 NFT`}
                            className="nft-inventory-review__remove button ghost"
                            disabled={disabled}
                            onClick={() => removeAssets([row.asset!.key])}
                            type="button"
                          >移除</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
