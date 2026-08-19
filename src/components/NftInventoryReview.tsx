import { useEffect, useId, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { FieldLabel } from "@/components/ui/field";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfirmActionDialog } from "@/components/WorkbenchPrimitives";
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
          <p className="sr-only" id={descriptionId}>勾选资产后可从清单移除；无效原始行会保留。</p>
        </div>
        <Badge aria-live="polite" variant="outline">
          {parsed.assets.length} 个有效{parsed.invalid ? ` · ${parsed.invalid} 行无效` : ""}
        </Badge>
      </header>

      {parsed.rows.length === 0 ? (
        <Empty className="nft-inventory-review__empty"><EmptyHeader><EmptyTitle>暂无资产</EmptyTitle></EmptyHeader></Empty>
      ) : (
        <>
          <div className="nft-inventory-review__toolbar" role="group" aria-label="资产选择与移除">
            <FieldLabel className="nft-inventory-review__select-all">
              <Checkbox
                checked={allSelected}
                disabled={disabled || validAssetKeys.length === 0}
                indeterminate={partlySelected}
                onCheckedChange={(checked) => setSelectedKeys(checked
                  ? new Set(validAssetKeys)
                  : new Set())}
              />
              <span>选择全部</span>
            </FieldLabel>
            <span className="nft-inventory-review__selection-count">已选 {selectedCount} 项待移除</span>
            <div className="nft-inventory-review__actions">
              <Button
                disabled={disabled || selectedCount === 0}
                onClick={() => setSelectedKeys(new Set())}
                type="button"
                variant="ghost"
              >清空选择</Button>
              <Button
                disabled={disabled || selectedCount === 0}
                onClick={() => removeAssets(selectedKeys)}
                type="button"
                variant="outline"
              >移除选中项</Button>
              <ConfirmActionDialog
                confirmLabel="移除全部"
                description={`将从清单移除 ${validAssetKeys.length} 个有效资产。无效原始行仍会保留。`}
                disabled={disabled || validAssetKeys.length === 0}
                onConfirm={() => removeAssets(validAssetKeys)}
                title="移除全部有效资产？"
                triggerLabel="移除全部"
                triggerVariant="destructive"
              />
            </div>
          </div>

          <ScrollArea className="nft-inventory-review__table-wrap">
            <Table aria-label={`${standard === "erc721" ? "ERC721" : "ERC1155"} 待归集资产清单`} className="nft-inventory-review__table">
              <TableHeader>
                <TableRow>
                  <TableHead>选择</TableHead>
                  <TableHead>合约</TableHead>
                  <TableHead>Token ID</TableHead>
                  <TableHead>数量</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead><span className="sr-only">操作</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {parsed.rows.map((row) => {
                  const rawLine = sourceLines[row.line - 1] || "";
                  if (
                    !row.asset
                    || row.status === "invalid"
                    || row.asset.standard === "native"
                    || row.asset.standard === "erc20"
                  ) {
                    return (
                      <TableRow className="nft-inventory-review__row is-invalid" key={`invalid-${row.line}`}>
                        <TableCell><span aria-label="无效行不可选择">—</span></TableCell>
                        <TableCell>
                          <strong>第 {row.line} 行无效</strong>
                          <code>{rawLine || "未能定位原始行"}</code>
                        </TableCell>
                        <TableCell>—</TableCell>
                        <TableCell>—</TableCell>
                        <TableCell>
                          <Badge variant="destructive">需修正</Badge>
                          <small>{row.problems.join(" / ")}</small>
                        </TableCell>
                        <TableCell><small>保留原始行</small></TableCell>
                      </TableRow>
                    );
                  }

                  const selected = row.status === "valid" && selectedKeys.has(row.asset.key);
                  const duplicate = row.status === "duplicate";
                  const name = contractLabel(contractLabels, row.asset.contractAddress);
                  return (
                    <TableRow
                      className={`nft-inventory-review__row${duplicate ? " is-duplicate" : ""}`}
                      key={`${row.status}-${row.line}-${row.asset.key}`}
                    >
                      <TableCell>
                        {duplicate ? (
                          <span aria-label="重复行不可选择">—</span>
                        ) : (
                          <Checkbox
                            aria-label={`选择第 ${row.line} 行 NFT`}
                            checked={selected}
                            disabled={disabled}
                            onCheckedChange={(checked) => setSelectedKeys((current) => {
                              const next = new Set(current);
                              if (checked) next.add(row.asset!.key);
                              else next.delete(row.asset!.key);
                              return next;
                            })}
                          />
                        )}
                      </TableCell>
                      <TableCell>
                        <strong>{name}</strong>
                        <code title={row.asset.contractAddress}>{shortAddress(row.asset.contractAddress)}</code>
                      </TableCell>
                      <TableCell><code>{getAssetTokenId(row.asset)}</code></TableCell>
                      <TableCell>
                        {standard === "erc1155" ? (
                          <span title="执行时读取该 Token ID 的可转余额">全部余额</span>
                        ) : "1 枚"}
                      </TableCell>
                      <TableCell>
                        {duplicate ? (
                          <>
                            <Badge variant="outline">重复行</Badge>
                            <small>{row.problems.join(" / ")}</small>
                          </>
                        ) : <Badge variant="outline">可归集</Badge>}
                      </TableCell>
                      <TableCell>
                        {duplicate ? <small>随对应资产一起移除</small> : (
                          <Button
                            aria-label={`移除第 ${row.line} 行 NFT`}
                            className="nft-inventory-review__remove"
                            disabled={disabled}
                            onClick={() => removeAssets([row.asset!.key])}
                            type="button"
                            variant="ghost"
                          >移除</Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </ScrollArea>
        </>
      )}
    </section>
  );
}
