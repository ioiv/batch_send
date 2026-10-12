import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { WalletChooserDialog } from "@/components/WorkbenchPrimitives";
import type { EvmWalletState } from "@/hooks/useEvmWallet";

function WalletIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 7.5h12.5a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2.5 2.5 0 0 1-2.5-2.5v-6A2.5 2.5 0 0 1 5 7.5Z" stroke="currentColor" strokeWidth="1.8" />
      <path d="M16 13h4v3h-4a1.5 1.5 0 0 1 0-3Z" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

export function EvmWalletConnectionControl({ disabled = false, wallet }: { disabled?: boolean; wallet: EvmWalletState }) {
  const busy = disabled || wallet.status === "connecting";
  const hasChoices = wallet.wallets.length > 1 && !wallet.connected;

  return (
    <div className="wallet" id="wallet-connection" data-connected={wallet.connected}>
      <Badge
        aria-live="polite"
        className="wallet-status"
        data-status={wallet.connected ? "connected" : wallet.status}
        title={wallet.address || wallet.message || wallet.statusText}
        variant="outline"
      >
        <span aria-hidden="true" className="wallet-status__dot" />
        <span className="wallet-status__text">{wallet.statusText}</span>
        {wallet.connected ? <span className="wallet-status__mobile-address">{wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}</span> : null}
      </Badge>
      {hasChoices ? (
        <WalletChooserDialog
          choices={wallet.wallets}
          disabled={busy}
          label="选择 EVM 钱包"
          onChoose={(walletId) => void wallet.connectWallet(walletId)}
          selectedId={wallet.selectedWalletId}
        />
      ) : (
        <Button
          disabled={busy}
          onClick={() => wallet.connected ? wallet.disconnectWallet() : void wallet.connectWallet()}
          type="button"
          variant={wallet.connected ? "outline" : "default"}
        >
          <WalletIcon />
          {wallet.buttonLabel}
        </Button>
      )}
    </div>
  );
}
