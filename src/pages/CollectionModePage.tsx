import { useEffect, useRef, useState } from 'react';
import { EvmCollectionPage } from './EvmCollectionPage';
import { SolCollectionPage } from './SolCollectionPage';
import { AutomaticCollectionWorkbench, type AutomaticCollectionRound, type CollectionModeConfig } from '../components/AutomaticCollectionWorkbench';
import type { SecretKeyInputSnapshot } from '../components/SecretKeyInput';

/** Mode transitions transfer the DOM input through a short-lived ref, never React state or storage. */
export function CollectionModePage({ kind, fixedStandard = 'erc20' }: { kind: 'evm' | 'solana'; fixedStandard?: 'erc20' | 'nft' }) {
  const [automatic, setAutomatic] = useState(false);
  const snapshotRef = useRef<SecretKeyInputSnapshot | null>(null);
  const configRef = useRef<CollectionModeConfig | undefined>(undefined);
  const historyRef = useRef<AutomaticCollectionRound[]>([]);
  useEffect(() => {
    const clear = () => { snapshotRef.current = null; };
    window.addEventListener('pagehide', clear);
    return () => { window.removeEventListener('pagehide', clear); clear(); };
  }, []);
  function readInitialWallets() { const snapshot = snapshotRef.current; snapshotRef.current = null; return snapshot; }
  function switchMode(snapshot: SecretKeyInputSnapshot, config: CollectionModeConfig, next: boolean, rounds?: AutomaticCollectionRound[]) {
    snapshotRef.current = snapshot;
    // Keep each mode's form draft while continuing to share the network and destination.
    configRef.current = { ...configRef.current, ...config };
    if (rounds?.length) historyRef.current = [...rounds, ...historyRef.current].slice(0, 10);
    setAutomatic(next);
  }
  if (automatic) return <AutomaticCollectionWorkbench kind={kind}
    currentToolId={kind === 'solana' ? 'sol-collection' : fixedStandard === 'nft' ? 'evm-nft-collection' : 'evm-token-collection'}
    initialConfig={configRef.current!} readInitialWallets={readInitialWallets} historyRef={historyRef}
    onManual={(snapshot, config) => switchMode(snapshot, config, false)} />;
  const props = { initialConfig: configRef.current, readInitialWallets,
    onAutomatic: (snapshot: SecretKeyInputSnapshot, config: CollectionModeConfig, rounds?: AutomaticCollectionRound[]) => switchMode(snapshot, config, true, rounds) };
  return kind === 'solana' ? <SolCollectionPage {...props} /> : <EvmCollectionPage fixedStandard={fixedStandard} {...props} />;
}
