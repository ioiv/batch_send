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
  symbol?: string;
  tokenId?: string;
};

/** Public, copyable confirmation context. Signing accounts never enter this view. */
export function CollectionAssetReview({ items }: { items: CollectionAssetReviewItem[] }) {
  const contracts = new Map<string, CollectionAssetReviewItem[]>();
  for (const item of items) {
    const key = `${item.standard}:${item.contractAddress?.toLowerCase() || "native"}`;
    contracts.set(key, [...(contracts.get(key) || []), item]);
  }
  return <section aria-label="本次归集资产与来源数量" className="collection-asset-review">
    {[...contracts].map(([key, rows]) => {
      const asset = rows[0];
      const identity = [asset.name, asset.symbol && asset.symbol !== asset.name ? asset.symbol : undefined].filter(Boolean).join(" · ");
      return <div className="collection-asset-review__contract" key={key}>
        <div className="collection-asset-review__heading"><strong>{identity || "名称未提供"}</strong><span>{asset.standard.toUpperCase()}</span></div>
        {asset.contractAddress ? <div className="collection-asset-review__address"><code>{asset.contractAddress}</code><CopyButton label="复制合约地址" value={asset.contractAddress} /></div> : null}
        <div className="collection-asset-review__sources">{rows.map((row, index) => <div className="collection-asset-review__source" key={`${row.sourceAddress}:${row.tokenId || ""}:${index}`}>
          <span>{row.sourceLabel ? `${row.sourceLabel} · ` : ""}<code>{row.sourceAddress}</code></span>
          <strong>{row.tokenId !== undefined ? `Token ID ${row.tokenId} · ` : ""}{row.amountLabel || "估计数量"} {row.amount}</strong>
          {row.message ? <small>{row.message}</small> : null}
        </div>)}</div>
      </div>;
    })}
  </section>;
}
