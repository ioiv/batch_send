import { CopyButton } from "./CopyButton";
import "./collection-asset-review.css";

export type CollectionAssetReviewItem = {
  amount: string;
  amountLabel?: string;
  contractAddress?: string;
  message?: string;
  name?: string;
  sourceAddress: string;
  sourceLabel?: string;
  standard: string;
  status?: "ready" | "skipped" | "failed";
  symbol?: string;
  tokenId?: string;
};

function addressKey(address: string) {
  return /^0x[0-9a-f]{40}$/i.test(address) ? address.toLowerCase() : address;
}

/** Sum the displayed decimal quantities without rounding through Number. */
function totalAmount(rows: CollectionAssetReviewItem[]) {
  if (!rows.length || rows.some(row => !/^\d+(?:\.\d+)?$/.test(row.amount))) return null;
  const decimals = Math.max(...rows.map(row => row.amount.split(".")[1]?.length || 0));
  const total = rows.reduce((sum, row) => {
    const [whole, fraction = ""] = row.amount.split(".");
    return sum + BigInt(whole + fraction.padEnd(decimals, "0"));
  }, 0n).toString().padStart(decimals + 1, "0");
  if (!decimals) return total;
  const fraction = total.slice(-decimals).replace(/0+$/, "");
  return `${total.slice(0, -decimals)}${fraction ? `.${fraction}` : ""}`;
}

function AssetGroups({ items, showTotals = true }: { items: CollectionAssetReviewItem[]; showTotals?: boolean }) {
  const contracts = new Map<string, CollectionAssetReviewItem[]>();
  for (const item of items) {
    const key = `${item.standard}:${item.contractAddress ? addressKey(item.contractAddress) : "native"}`;
    contracts.set(key, [...(contracts.get(key) || []), item]);
  }
  return [...contracts].map(([key, rows]) => {
    const asset = rows[0];
    const identity = [asset.name, asset.symbol && asset.symbol !== asset.name ? asset.symbol : undefined].filter(Boolean).join(" · ");
    const readyRows = rows.filter(row => row.status !== "failed");
    const total = showTotals ? totalAmount(readyRows) : null;
    return <div className="collection-asset-review__contract" key={key}>
      <div className="collection-asset-review__heading"><strong>{identity || "名称未提供"}</strong><span>{asset.standard.toUpperCase()}</span></div>
      {total !== null ? <p className="collection-asset-review__total"><span>{asset.amountLabel === "当前余额" ? "当前余额合计" : "估计合计"}</span><strong>{total}{asset.symbol ? ` ${asset.symbol}` : ""}</strong><span>· {new Set(readyRows.map(row => addressKey(row.sourceAddress))).size} 个来源</span></p> : null}
      {asset.contractAddress ? <div className="collection-asset-review__address"><code>{asset.contractAddress}</code><CopyButton label="复制合约地址" value={asset.contractAddress} /></div> : null}
      <div className="collection-asset-review__sources">{rows.map((row, index) => <div className="collection-asset-review__source" key={`${row.sourceAddress}:${row.tokenId || ""}:${index}`}>
        <div className="collection-asset-review__source-address"><span>{row.sourceLabel ? `${row.sourceLabel} · ` : ""}<code>{row.sourceAddress}</code></span><CopyButton label="复制来源地址" value={row.sourceAddress} /></div>
        <strong>{row.tokenId !== undefined ? `Token ID ${row.tokenId} · ` : ""}{row.amountLabel || "估计数量"} {row.amount}</strong>
        {row.message ? <small>{row.message}</small> : null}
      </div>)}</div>
    </div>;
  });
}

/** Public, copyable confirmation context. Signing accounts never enter this view. */
export function CollectionAssetReview({ items }: { items: CollectionAssetReviewItem[] }) {
  const activeItems = items.filter(item => item.status !== "skipped")
    .sort((a, b) => Number(a.status === "failed") - Number(b.status === "failed"));
  const skippedItems = items.filter(item => item.status === "skipped");
  return <section aria-label="本次归集资产与来源数量" className="collection-asset-review">
    {activeItems.length ? <AssetGroups items={activeItems} /> : <p className="collection-asset-review__empty">当前没有可归集资产。</p>}
    {skippedItems.length ? <details className="collection-asset-review__skipped">
      <summary>零余额 / 跳过 {skippedItems.length} 项 · {new Set(skippedItems.map(item => addressKey(item.sourceAddress))).size} 个来源</summary>
      <AssetGroups items={skippedItems} showTotals={false} />
    </details> : null}
  </section>;
}
