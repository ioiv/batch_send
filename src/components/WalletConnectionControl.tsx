import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
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

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function WalletConnectionControl({ disabled = false, wallet }: { disabled?: boolean; wallet: SolanaWalletState }) {
  const [chooserOpen, setChooserOpen] = useState(false);
  const chooserTitleId = useId();
  const chooserDialogId = `${chooserTitleId}-dialog`;
  const chooserRef = useRef<HTMLElement>(null);
  const connectWalletRef = useRef(wallet.connectWallet);
  const pendingWalletIdRef = useRef<string | null>(null);
  const triggerButtonRef = useRef<HTMLButtonElement>(null);
  const wasChooserOpenRef = useRef(false);
  connectWalletRef.current = wallet.connectWallet;
  const stateClass = wallet.connected ? "connected" : wallet.status === "connecting" ? "pending" : wallet.status === "error" ? "error" : "";
  const hasWalletChoices = wallet.wallets.length > 1 && !wallet.connected;
  const handleClick = () => {
    if (wallet.connected) {
      void wallet.disconnectWallet();
      return;
    }
    if (hasWalletChoices) {
      pendingWalletIdRef.current = null;
      setChooserOpen(true);
      return;
    }
    void wallet.connectWallet();
  };
  const connectSelectedWallet = (walletId: string) => {
    pendingWalletIdRef.current = walletId;
    setChooserOpen(false);
  };
  const closeChooser = () => {
    pendingWalletIdRef.current = null;
    setChooserOpen(false);
  };

  useLayoutEffect(() => {
    if (chooserOpen) {
      wasChooserOpenRef.current = true;
      const chooser = chooserRef.current;
      const initialFocus = chooser?.querySelector<HTMLElement>(".wallet-choice.selected")
        || chooser?.querySelector<HTMLElement>(".wallet-choice")
        || chooser?.querySelector<HTMLElement>(".wallet-modal-close")
        || chooser;
      initialFocus?.focus();
      return;
    }

    if (!wasChooserOpenRef.current) return;
    wasChooserOpenRef.current = false;
    triggerButtonRef.current?.focus();

    const pendingWalletId = pendingWalletIdRef.current;
    pendingWalletIdRef.current = null;
    if (pendingWalletId) void connectWalletRef.current(pendingWalletId);
  }, [chooserOpen]);

  useEffect(() => {
    if (!chooserOpen) return undefined;
    const bodyOverflow = document.body.style.overflow;
    const rootOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        pendingWalletIdRef.current = null;
        setChooserOpen(false);
        return;
      }

      if (event.key !== "Tab") return;
      const chooser = chooserRef.current;
      if (!chooser) return;
      const focusableElements = Array.from(chooser.querySelectorAll<HTMLElement>([
        "a[href]:not([tabindex='-1'])",
        "button:not([disabled]):not([tabindex='-1'])",
        "input:not([disabled]):not([tabindex='-1'])",
        "select:not([disabled]):not([tabindex='-1'])",
        "textarea:not([disabled]):not([tabindex='-1'])",
        "[contenteditable='true']:not([tabindex='-1'])",
        "[tabindex]:not([tabindex='-1'])"
      ].join(",")));

      if (!focusableElements.length) {
        event.preventDefault();
        chooser.focus();
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement;
      if (!chooser.contains(activeElement)) {
        event.preventDefault();
        (event.shiftKey ? lastElement : firstElement).focus();
      } else if (event.shiftKey && activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = bodyOverflow;
      document.documentElement.style.overflow = rootOverflow;
    };
  }, [chooserOpen]);

  useEffect(() => {
    if (wallet.connected || wallet.status === "connecting" || wallet.wallets.length <= 1) setChooserOpen(false);
  }, [wallet.connected, wallet.status, wallet.wallets.length]);

  return (
    <div className="wallet">
      <span className={`wallet-status ${stateClass}`} aria-live="polite" title={wallet.address || wallet.message || wallet.statusText}>
        <span className="dot" aria-hidden="true" />
        <span>{wallet.statusText}</span>
      </span>
      <button
        aria-controls={hasWalletChoices ? chooserDialogId : undefined}
        aria-expanded={hasWalletChoices ? chooserOpen : undefined}
        aria-haspopup={hasWalletChoices ? "dialog" : undefined}
        className="button primary"
        type="button"
        disabled={disabled || wallet.status === "connecting"}
        onClick={handleClick}
        ref={triggerButtonRef}
      >
        <WalletIcon />
        <span>{wallet.buttonLabel}</span>
      </button>
      {chooserOpen ? (
        <div className="wallet-modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeChooser();
        }}>
          <section
            aria-labelledby={chooserTitleId}
            aria-modal="true"
            className="wallet-modal"
            id={chooserDialogId}
            ref={chooserRef}
            role="dialog"
            tabIndex={-1}
          >
            <div className="wallet-modal-header">
              <div>
                <h3 id={chooserTitleId}>选择 Solana 钱包</h3>
              </div>
              <button className="wallet-modal-close" type="button" aria-label="关闭钱包选择" onClick={closeChooser}>
                <CloseIcon />
              </button>
            </div>
            <div className="wallet-choice-list" role="list">
              {wallet.wallets.map((detectedWallet) => {
                const selected = detectedWallet.id === wallet.selectedWalletId;
                return (
                  <button
                    className={`wallet-choice${selected ? " selected" : ""}`}
                    key={detectedWallet.id}
                    type="button"
                    onClick={() => connectSelectedWallet(detectedWallet.id)}
                  >
                    <span className="wallet-choice-mark" aria-hidden="true">{detectedWallet.name.slice(0, 1)}</span>
                    <span className="wallet-choice-copy">
                      <strong>{detectedWallet.name}</strong>
                      {selected ? <span>当前选中</span> : null}
                    </span>
                    <span className="wallet-choice-action">连接</span>
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
