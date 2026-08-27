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
  shortenTransactionHash,
  type CollectionDisplayResult,
  type CollectionResultStatus
} from "../lib/collection-results";
import {
  removeValidNftInventoryAssets,
  type NftInventoryStandard
} from "../lib/nft-inventory";
import {
  parseEvmCollectionAssets,
  type EvmCollectionAsset
} from "../lib/evm-collection";

export { removeValidNftInventoryAssets } from "../lib/nft-inventory";

export type NftInventoryReviewProps = {
  assetInput: string;
  contractLabels?: ReadonlyMap<string, string>;
  disabled?: boolean;
  onChange: (value: string) => void;
  onRetry?: (executionIds: readonly string[]) => void;
  results?: readonly CollectionDisplayResult[];
  retrying?: boolean;
  standard: NftInventoryStandard;
};

const statusLabels: Record<CollectionResultStatus, string> = {
  confirming: "确认中",
  error: "失败",
  pending: "待处理",
  scanning: "读取中",
  skipped: "已跳过",
  submitting: "提交中",
  success: "成功"
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

export function NftInventoryReview({
  assetInput,
  contractLabels,
  disabled,
  onChange,
  onRetry,
  results = [],
  retrying = false,
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
  const resultsByAssetKey = useMemo(() => {
    const grouped = new Map<string, CollectionDisplayResult[]>();
    results.forEach((result) => {
      if (!result.assetKey) return;
      const current = grouped.get(result.assetKey) || [];
      current.push(result);
      grouped.set(result.assetKey, current);
    });
    return grouped;
  }, [results]);
  const showingRoundResults = results.length > 0;
  const retryableExecutionIds = useMemo(() => [...new Set(results.flatMap((result) => (
    result.status === "error" && result.retryable && result.executionId
      ? [result.executionId]
      : []
  )))], [results]);
  const assetOutcomeCounts = useMemo(() => parsed.assets.reduce((counts, asset) => {
    const assetResults = resultsByAssetKey.get(asset.key) || [];
    if (!assetResults.length) {
      counts.pending += 1;
      return counts;
    }
    const hasSuccess = assetResults.some((result) => result.status === "success");
    const hasError = assetResults.some((result) => result.status === "error");
    const hasActive = assetResults.some((result) => ![
      "success", "skipped", "error"
    ].includes(result.status));
    if (hasActive) counts.active += 1;
    else if (hasError) counts.review += 1;
    else if (hasSuccess) counts.success += 1;
    else counts.pending += 1;
    return counts;
  }, { active: 0, pending: 0, review: 0, success: 0 }), [parsed.assets, resultsByAssetKey]);
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
          <h3 id={titleId}>{showingRoundResults ? "资产结果" : "当前待归集资产"}</h3>
          <p className="sr-only" id={descriptionId}>
            {showingRoundResults
              ? "逐项显示归集状态与交易哈希。"
              : "勾选资产后可从清单移除；无效原始行会保留。"}
          </p>
        </div>
        <div className="nft-inventory-review__summary" aria-live="polite">
          {showingRoundResults ? (
            <>
              <Badge variant="outline">完成 {assetOutcomeCounts.success}</Badge>
              {assetOutcomeCounts.active ? <Badge variant="outline">处理中 {assetOutcomeCounts.active}</Badge> : null}
              {assetOutcomeCounts.review ? <Badge variant="destructive">需处理 {assetOutcomeCounts.review}</Badge> : null}
              {assetOutcomeCounts.pending ? <Badge variant="outline">未发送 {assetOutcomeCounts.pending}</Badge> : null}
              {retryableExecutionIds.length && onRetry ? (
                <ConfirmActionDialog
                  confirmLabel={`重试 ${retryableExecutionIds.length} 个失败项`}
                  description="只会重试尚未提交或已明确执行失败的项目；状态不确定的交易不会自动重发。"
                  disabled={retrying}
                  onConfirm={() => onRetry(retryableExecutionIds)}
                  title="重试全部可安全重试的失败项？"
                  triggerLabel={`重试全部失败项 (${retryableExecutionIds.length})`}
                  triggerVariant="outline"
                />
              ) : null}
            </>
          ) : (
            <Badge variant="outline">
              {parsed.assets.length} 个有效{parsed.invalid ? ` · ${parsed.invalid} 行无效` : ""}
            </Badge>
          )}
        </div>
      </header>

      {parsed.rows.length === 0 ? (
        <Empty className="nft-inventory-review__empty"><EmptyHeader><EmptyTitle>暂无资产</EmptyTitle></EmptyHeader></Empty>
      ) : (
        <>
          {!showingRoundResults ? <div className="nft-inventory-review__toolbar" role="group" aria-label="资产选择与移除">
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
          </div> : null}

          <ScrollArea className="nft-inventory-review__table-wrap">
            <Table aria-label={`${standard === "erc721" ? "ERC721" : "ERC1155"} 待归集资产清单`} className="nft-inventory-review__table">
              <TableHeader>
                <TableRow>
                  {!showingRoundResults ? <TableHead>选择</TableHead> : null}
                  <TableHead>合约</TableHead>
                  <TableHead>Token ID</TableHead>
                  <TableHead>数量</TableHead>
                  <TableHead>状态</TableHead>
                  {!showingRoundResults ? <TableHead><span className="sr-only">操作</span></TableHead> : null}
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
                        {!showingRoundResults ? <TableCell><span aria-label="无效行不可选择">—</span></TableCell> : null}
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
                        {!showingRoundResults ? <TableCell><small>保留原始行</small></TableCell> : null}
                      </TableRow>
                    );
                  }

                  const selected = row.status === "valid" && selectedKeys.has(row.asset.key);
                  const duplicate = row.status === "duplicate";
                  const name = contractLabel(contractLabels, row.asset.contractAddress);
                  const assetResults = resultsByAssetKey.get(row.asset.key) || [];
                  const rowOutcome = assetResults.some((result) => ![
                    "success", "skipped", "error"
                  ].includes(result.status))
                    ? "active"
                    : assetResults.some((result) => result.status === "error")
                      ? "error"
                      : assetResults.some((result) => result.status === "success")
                        ? "success"
                        : assetResults.length ? "skipped" : "pending";
                  return (
                    <TableRow
                      className={`nft-inventory-review__row${duplicate ? " is-duplicate" : ""}${rowOutcome === "success" ? " is-success" : ""}`}
                      data-status={rowOutcome}
                      key={`${row.status}-${row.line}-${row.asset.key}`}
                    >
                      {!showingRoundResults ? <TableCell>
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
                      </TableCell> : null}
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
                        {assetResults.length ? (
                          <div className="nft-inventory-review__statuses">
                            {assetResults.map((result, index) => (
                              <div
                                className="nft-inventory-review__status"
                                data-status={result.status}
                                key={`${result.address}-${index}`}
                                title={result.message}
                              >
                                <span>{result.label || shortAddress(result.address)}</span>
                                <Badge variant={result.status === "error" ? "destructive" : "outline"}>
                                  {result.uncertain ? "需核对" : statusLabels[result.status]}
                                </Badge>
                                {result.hash ? result.explorerUrl ? (
                                  <a
                                    aria-label={`查看 ${result.label || shortAddress(result.address)} 的交易 ${result.hash}`}
                                    className="nft-inventory-review__hash"
                                    href={result.explorerUrl}
                                    rel="noreferrer"
                                    target="_blank"
                                    title={result.hash}
                                  >
                                    {shortenTransactionHash(result.hash)}
                                  </a>
                                ) : <code className={`nft-inventory-review__hash${result.status === "success" ? " is-success" : ""}`} title={result.hash}>{shortenTransactionHash(result.hash)}</code> : null}
                                {result.status === "error" && result.retryable && result.executionId && onRetry ? (
                                  <ConfirmActionDialog
                                    confirmLabel="确认重试"
                                    description={`将重新检查 ${result.label || shortAddress(result.address)} 的链上所有权、余额与网络费后，仅重试该 NFT。`}
                                    disabled={retrying}
                                    onConfirm={() => onRetry([result.executionId!])}
                                    title="重试该失败项？"
                                    triggerAriaLabel={`重试 ${result.label || shortAddress(result.address)} 的 Token ID ${getAssetTokenId(row.asset!)}`}
                                    triggerLabel="重试"
                                    triggerSize="sm"
                                    triggerVariant="outline"
                                  />
                                ) : null}
                              </div>
                            ))}
                          </div>
                        ) : duplicate ? (
                          <>
                            <Badge variant="outline">重复行</Badge>
                            <small>{row.problems.join(" / ")}</small>
                          </>
                        ) : <Badge variant="outline">待归集</Badge>}
                      </TableCell>
                      {!showingRoundResults ? <TableCell>
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
                      </TableCell> : null}
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
