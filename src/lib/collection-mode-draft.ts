import type { EvmGasChoice } from '../hooks/useEvmGas';
import type { CollectionAmountPolicy } from './collection-amount';

/** Form values only. Wallet secrets, signers, balances and execution plans never belong in a draft. */
type CollectionAmountDraft = {
  amountMode: CollectionAmountPolicy['mode'];
  percentageAmount: string;
  fixedAmount: string;
  randomMinimum: string;
  randomMaximum: string;
  concurrency: string;
  minimumDelay: string;
  maximumDelay: string;
};

export type EvmManualCollectionDraft = CollectionAmountDraft & {
  kind: 'evm';
  erc20AssetInput: string;
  nftAssetInputs: { erc721: string; erc1155: string };
  discoveryContract: string;
  tokenRangeStart: string;
  tokenRangeEnd: string;
  nftAmountMode: 'all' | 'fixed';
  nftFixedAmount: string;
  nftStandard: 'erc721' | 'erc1155';
  maxFeeAmount: string;
  gasChoice: EvmGasChoice;
  customGasPriceGwei: string;
};

export type SolManualCollectionDraft = CollectionAmountDraft & {
  kind: 'solana';
  tokenMintInput: string;
  reserveAmount: string;
  minimumAmount: string;
};

export type CollectionManualDraft = EvmManualCollectionDraft | SolManualCollectionDraft;

export function describeCollectionAmount(
  draft: Pick<CollectionAmountDraft, 'amountMode' | 'percentageAmount' | 'fixedAmount' | 'randomMinimum' | 'randomMaximum'>,
  unit: string
) {
  if (draft.amountMode === 'percentage') return `每钱包可归集余额的 ${draft.percentageAmount}%`;
  if (draft.amountMode === 'fixed') return `每钱包每资产 ${draft.fixedAmount} ${unit}`;
  if (draft.amountMode === 'random') return `每钱包每资产随机 ${draft.randomMinimum}–${draft.randomMaximum} ${unit}`;
  return '全部可归集余额';
}
