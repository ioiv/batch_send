export type WalletAssetHolding = {
  kind: "token" | "nft";
  /** Stable asset identity, including the Token ID for an NFT. */
  key: string;
  address: string;
  symbol: string | null;
  raw: bigint | null;
  decimals: number | null;
};

export type WalletNativeBalance = {
  symbol: string;
  raw: bigint | null;
  decimals: number | null;
};

export type WalletAssetOverview = {
  scanned: boolean;
  complete: boolean;
  native: WalletNativeBalance | null;
  tokens: readonly WalletAssetHolding[];
  nfts: readonly WalletAssetHolding[];
};

function normalizedAddress(address: string) {
  return /^0x[\da-f]{40}$/iu.test(address) ? address.toLowerCase() : address;
}

function validDecimals(decimals: number | null): decimals is number {
  return decimals !== null && Number.isInteger(decimals) && decimals >= 0 && decimals <= 255;
}

export function shortenAssetAddress(address: string) {
  return address.length > 15 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

export function getWalletAssetSymbol(holding: Pick<WalletAssetHolding, "symbol" | "address">) {
  return holding.symbol?.trim() || shortenAssetAddress(holding.address) || "未知资产";
}

/** Never converts raw balances to Number, including while formatting previews. */
export function formatWalletAssetAmount(
  raw: bigint | null,
  decimals: number | null,
  { compact = false }: { compact?: boolean } = {}
) {
  if (raw === null || raw < 0n || !validDecimals(decimals)) return "数量未知";
  const digits = raw.toString().padStart(decimals + 1, "0");
  const whole = decimals ? digits.slice(0, -decimals) : digits;
  const fraction = decimals ? digits.slice(-decimals).replace(/0+$/u, "") : "";
  if (!compact) return fraction ? `${whole}.${fraction}` : whole;
  if (whole.length > 12) {
    const significant = whole.slice(0, 6).replace(/0+$/u, "");
    return `${significant[0]}${significant.length > 1 ? `.${significant.slice(1)}` : ""}e${whole.length - 1}`;
  }
  const shortFraction = fraction.slice(0, 6).replace(/0+$/u, "");
  if (raw > 0n && whole === "0" && !shortFraction) return "<0.000001";
  return shortFraction ? `${whole}.${shortFraction}` : whole;
}

/** Aggregates token accounts by contract/Mint rather than by their symbol. */
export function buildWalletAssetOverview({
  holdings,
  complete,
  scanned = true,
  native = null
}: {
  holdings: readonly WalletAssetHolding[];
  complete: boolean;
  scanned?: boolean;
  native?: WalletNativeBalance | null;
}): WalletAssetOverview {
  const combined = new Map<string, WalletAssetHolding>();
  let trustworthy = complete;
  for (const holding of holdings) {
    const raw = holding.raw !== null && holding.raw >= 0n ? holding.raw : null;
    const decimals = validDecimals(holding.decimals) ? holding.decimals : null;
    if (raw === null || decimals === null) trustworthy = false;
    const identity = holding.kind === "token"
      ? `token:${normalizedAddress(holding.address)}`
      : `nft:${normalizedAddress(holding.address)}:${holding.key}`;
    const previous = combined.get(identity);
    if (!previous) {
      combined.set(identity, { ...holding, raw, decimals });
      continue;
    }
    const compatible = previous.decimals !== null && previous.decimals === decimals;
    if (!compatible || previous.raw === null || raw === null) trustworthy = false;
    combined.set(identity, {
      ...previous,
      symbol: previous.symbol?.trim() || holding.symbol,
      raw: compatible && previous.raw !== null && raw !== null ? previous.raw + raw : null,
      decimals: compatible ? decimals : null
    });
  }
  const nonempty = [...combined.values()].filter((holding) => holding.raw !== 0n);
  const normalizedNative = native ? {
    ...native,
    raw: native.raw !== null && native.raw >= 0n ? native.raw : null,
    decimals: validDecimals(native.decimals) ? native.decimals : null
  } : null;
  if (normalizedNative && (normalizedNative.raw === null || normalizedNative.decimals === null)) trustworthy = false;
  return {
    scanned,
    complete: scanned && trustworthy,
    native: normalizedNative,
    tokens: nonempty.filter((holding) => holding.kind === "token"),
    nfts: nonempty.filter((holding) => holding.kind === "nft")
  };
}

export function isWalletOverviewZeroBalance(overview: WalletAssetOverview) {
  return overview.scanned && overview.complete && overview.native?.raw === 0n
    && [...overview.tokens, ...overview.nfts].every((holding) => holding.raw === 0n);
}

export function getWalletNftCount(overview: WalletAssetOverview) {
  let count = 0n;
  for (const holding of overview.nfts) {
    if (holding.raw === null) return null;
    count += holding.raw;
  }
  return count;
}
