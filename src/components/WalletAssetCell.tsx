import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { copyText } from "../lib/clipboard";
import {
  formatWalletAssetAmount,
  getWalletAssetSymbol,
  getWalletNftCount,
  type WalletAssetHolding,
  type WalletAssetOverview
} from "../lib/wallet-asset-overview";
import { HelpTooltip } from "./HelpTooltip";
import "./asset-overview.css";

function AssetDetails({ overview }: { overview: WalletAssetOverview }) {
  const [copyStatus, setCopyStatus] = useState<{ key: string; success: boolean } | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  const copyAddress = async (holding: WalletAssetHolding) => {
    const success = await copyText(holding.address);
    setCopyStatus({ key: `${holding.kind}:${holding.address}:${holding.key}`, success });
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopyStatus(null), 1_600);
  };
  const holdings = [...overview.tokens, ...overview.nfts];
  return (
    <div className="wallet-asset-details">
      <strong>资产明细</strong>
      {!overview.complete ? <p className="wallet-asset-details__warning">扫描不完整，下方仅展示已读取的资产，不能视为全部持仓。</p> : null}
      {holdings.length ? (
        <div aria-label="完整代币与 NFT 清单" className="wallet-asset-details__list" role="list">
          {holdings.map((holding) => (
            <div className="wallet-asset-detail" key={`${holding.kind}:${holding.address}:${holding.key}`} role="listitem">
              <div className="wallet-asset-detail__heading">
                <strong>{getWalletAssetSymbol(holding)}</strong>
                <span>{holding.kind === "nft" ? "NFT" : "Token"}</span>
              </div>
              <span className="wallet-asset-detail__amount">{formatWalletAssetAmount(holding.raw, holding.decimals)}</span>
              {holding.kind === "nft" ? <small className="wallet-asset-detail__id">资产 ID：{holding.key}</small> : null}
              <div className="wallet-asset-detail__address">
                <code>{holding.address}</code>
                <Button
                  aria-label={`复制 ${getWalletAssetSymbol(holding)} ${holding.address} 合约或 Mint 地址`}
                  onClick={() => void copyAddress(holding)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  {copyStatus?.key === `${holding.kind}:${holding.address}:${holding.key}` ? copyStatus.success ? "已复制" : "复制失败" : "复制"}
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : <p>{overview.complete ? "没有代币或 NFT" : "尚无已读取的代币或 NFT"}</p>}
      <span aria-live="polite" className="sr-only">
        {copyStatus ? copyStatus.success ? "地址已复制" : "地址复制失败" : ""}
      </span>
    </div>
  );
}

export function WalletAssetCell({
  overview,
  accessibleName = "钱包"
}: {
  overview?: WalletAssetOverview;
  accessibleName?: string;
}) {
  if (!overview?.scanned) return <span className="wallet-asset-cell wallet-asset-cell--empty">—</span>;
  const nftCount = getWalletNftCount(overview);
  const hasAssets = overview.tokens.length > 0 || overview.nfts.length > 0;
  return (
    <div aria-label={`${accessibleName} 代币与 NFT 概览`} className="wallet-asset-cell">
      <div className="wallet-asset-cell__summary">
        {!overview.complete ? <span className="wallet-asset-cell__incomplete">扫描不完整</span> : null}
        {overview.tokens.length > 2 ? <span>共 {overview.tokens.length} 种 Token</span> : overview.tokens.map((holding) => (
          <span className="wallet-asset-cell__token" key={holding.address}>
            <span className="wallet-asset-cell__symbol">{getWalletAssetSymbol(holding)}</span>
            <span>{formatWalletAssetAmount(holding.raw, holding.decimals, { compact: true })}</span>
          </span>
        ))}
        {overview.nfts.length ? <span className="wallet-asset-cell__nfts">NFT {nftCount === null ? "数量未知" : nftCount.toString()}</span> : null}
        {overview.complete && !hasAssets ? <span className="wallet-asset-cell__empty">无资产</span> : null}
      </div>
      {(hasAssets || !overview.complete) ? (
        <HelpTooltip label={`查看 ${accessibleName} 完整资产明细`}>
          <AssetDetails overview={overview} />
        </HelpTooltip>
      ) : null}
    </div>
  );
}

export function WalletNativeAssetCell({
  overview,
  accessibleName = "钱包"
}: {
  overview?: WalletAssetOverview;
  accessibleName?: string;
}) {
  if (!overview?.scanned) return <span className="wallet-native-cell">—</span>;
  const native = overview.native;
  if (!native) return <span className="wallet-native-cell">未读取</span>;
  return (
    <div aria-label={`${accessibleName} 原生币余额`} className="wallet-native-cell">
      <span className="wallet-native-cell__value">{native.raw === null ? "读取失败" : formatWalletAssetAmount(native.raw, native.decimals, { compact: true })}</span>
      <small>{native.symbol}</small>
      <HelpTooltip label={`查看 ${accessibleName} 原生币精确余额`}>
        <span className="wallet-asset-detail__amount">{formatWalletAssetAmount(native.raw, native.decimals)} {native.symbol}</span>
      </HelpTooltip>
    </div>
  );
}
