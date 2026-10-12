import { mapWithCollectionConcurrency, type CollectionPauseControl } from './collection-execution';
import { sanitizeRoundArchiveText, type CollectionDisplayResult } from './collection-results';
import type { WalletAssetHolding, WalletNativeBalance } from './wallet-asset-overview';

export type AutomaticCollectionPhase = 'token' | 'nft' | 'native';
export type AutomaticCollectionTask = {
  id: string;
  phase: AutomaticCollectionPhase;
  preview: CollectionDisplayResult;
  holding?: WalletAssetHolding;
  execute: (progress: (result: CollectionDisplayResult) => void, control: CollectionPauseControl) => Promise<CollectionDisplayResult>;
};
export type AutomaticCollectionWallet = {
  address: string;
  complete: boolean;
  issues: string[];
  native: WalletNativeBalance | null;
  tasks: AutomaticCollectionTask[];
  verifyEmpty: () => Promise<boolean>;
};
export type AutomaticCollectionScanProgress = { completed: number; total: number; wallet: AutomaticCollectionWallet };
export const automaticPhaseLabels = { token: 'Token', nft: 'NFT', native: '原生币' } as const;

export function assertAutomaticOperationActive(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('操作已停止', 'AbortError');
}

/** All wallets finish a phase before the next phase starts. Signers live only in task closures. */
export async function executeAutomaticCollection({ wallets, includeNative, selectedTaskIds, pauseControl, signal, onResult, onPhase }: {
  wallets: readonly AutomaticCollectionWallet[];
  includeNative: boolean;
  /** Keep omitted assets in the original inventory so native protection cannot overlook them. */
  selectedTaskIds?: ReadonlySet<string>;
  pauseControl: CollectionPauseControl;
  signal: AbortSignal;
  onResult?: (id: string, result: CollectionDisplayResult) => void;
  onPhase?: (phase: AutomaticCollectionPhase) => void;
}) {
  const results = new Map<string, CollectionDisplayResult>();
  const excludedAssets = new Set(wallets.filter(w => selectedTaskIds && w.tasks.some(task => task.phase !== 'native' && !selectedTaskIds.has(task.id))).map(w => w.address));
  const blockedNative = new Set(wallets.filter(w => !w.complete || excludedAssets.has(w.address)).map(w => w.address));
  const uncertain = new Set<string>();
  const control: CollectionPauseControl = {
    get paused() { return pauseControl.paused; },
    async waitUntilResumed() { assertAutomaticOperationActive(signal); await pauseControl.waitUntilResumed(); assertAutomaticOperationActive(signal); }
  };
  const publish = (task: AutomaticCollectionTask, result: CollectionDisplayResult) => {
    const value = { ...result, executionId: task.id, phase: task.phase, message: sanitizeRoundArchiveText(result.message) };
    results.set(task.id, value); onResult?.(task.id, value);
    return value;
  };
  for (const phase of ['token', 'nft', ...(includeNative ? ['native'] : [])] as AutomaticCollectionPhase[]) {
    onPhase?.(phase);
    await mapWithCollectionConcurrency(wallets, 3, async wallet => {
      const tasks = wallet.tasks.filter(task => task.phase === phase);
      for (const task of tasks) {
        const skip = (message: string) => publish(task, { ...task.preview, status: 'skipped', message, retryable: false });
        if (phase !== 'native' && selectedTaskIds && !selectedTaskIds.has(task.id)) { skip('本次未选择，已保留资产'); continue; }
        if (signal.aborted) { skip('任务已停止，未提交'); continue; }
        if (uncertain.has(wallet.address)) { skip('本钱包存在状态不确定的交易，已停止后续操作'); continue; }
        if (phase === 'native') {
          if (excludedAssets.has(wallet.address)) { skip('本钱包有未选择的资产，已保留原生币'); continue; }
          if (blockedNative.has(wallet.address)) { skip('扫描不完整或资产归集未完成，已保留原生币'); continue; }
          try {
            await control.waitUntilResumed();
            if (!await wallet.verifyEmpty()) { skip('复查仍有资产或无法确认资产已清空，已保留原生币'); continue; }
          } catch { skip('资产复查未完成，已保留原生币'); continue; }
        }
        let latest = task.preview;
        try {
          await control.waitUntilResumed();
          const result = await task.execute(value => { latest = publish(task, value); }, control);
          latest = publish(task, result);
        } catch (error) {
          const submissionUncertain = Boolean(latest.hash) || latest.status === 'submitting' || latest.status === 'confirming';
          latest = publish(task, { ...latest, status: 'error', message: error instanceof Error ? error.message : '执行失败', uncertain: submissionUncertain, retryable: !submissionUncertain });
        }
        if (latest.status !== 'success' && phase !== 'native') blockedNative.add(wallet.address);
        if (latest.uncertain) uncertain.add(wallet.address);
      }
    });
  }
  return [...results.values()];
}
