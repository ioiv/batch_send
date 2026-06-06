import type { SolanaWalletState } from "../hooks/useSolanaWallet";

function WalletIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 7.5h12.5a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2.5 2.5 0 0 1-2.5-2.5v-6A2.5 2.5 0 0 1 5 7.5Z" stroke="currentColor" strokeWidth="1.8" />
      <path d="M16 13h4v3h-4a1.5 1.5 0 0 1 0-3Z" stroke="currentColor" strokeWidth="1.8" />
      <path d="M6 7.5V6.8A2.3 2.3 0 0 1 8.3 4.5h8.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function WalletConnectionControl({ wallet }: { wallet: SolanaWalletState }) {
  const stateClass = wallet.connected ? "connected" : wallet.status === "connecting" ? "pending" : wallet.status === "error" ? "error" : "";
  const handleClick = wallet.connected ? wallet.disconnectWallet : wallet.connectWallet;

  return (
    <div className="wallet">
      {wallet.wallets.length > 1 ? (
        <select
          className="wallet-select"
          aria-label="选择 Solana 钱包"
          disabled={wallet.status === "connecting"}
          value={wallet.selectedWalletId}
          onChange={(event) => wallet.selectWallet(event.target.value)}
        >
          {wallet.wallets.map((detectedWallet) => (
            <option key={detectedWallet.id} value={detectedWallet.id}>
              {detectedWallet.name}
            </option>
          ))}
        </select>
      ) : null}
      <span className={`wallet-status ${stateClass}`} aria-live="polite" title={wallet.address || wallet.message || wallet.statusText}>
        <span className="dot" aria-hidden="true" />
        <span>{wallet.statusText}</span>
      </span>
      <button className="button primary" type="button" disabled={wallet.status === "connecting"} onClick={handleClick}>
        <WalletIcon />
        <span>{wallet.buttonLabel}</span>
      </button>
    </div>
  );
}
