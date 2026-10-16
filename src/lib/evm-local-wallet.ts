import { createWalletClient, type Chain, type Transport } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { getChainId, getTransactionCount } from "viem/actions";
import type { EvmCollectionWalletClient } from "./evm-collection";

type CollectionTransactionRequest = {
  account?: PrivateKeyAccount | string | null;
  chain?: Chain | null;
  chainId?: number;
  nonce?: number;
  gas?: bigint;
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
};

/** Uses standard RPC methods for already estimated local collection transactions. */
export function createEvmLocalWalletClient({
  account,
  beforeSign,
  chain,
  transport
}: {
  account: PrivateKeyAccount;
  /** Run pause/cancellation checks before reading fresh transaction parameters. */
  beforeSign?: () => void | Promise<void>;
  chain: Chain;
  transport: Transport;
}): EvmCollectionWalletClient {
  const wallet = createWalletClient({ account, chain, transport });

  async function prepareRequest<T extends CollectionTransactionRequest>(request: T) {
    const hasFees = typeof request.gasPrice === "bigint"
      || (typeof request.maxFeePerGas === "bigint" && typeof request.maxPriorityFeePerGas === "bigint");
    if (typeof request.gas !== "bigint" || !hasFees) {
      throw new Error("归集交易缺少已核验的 Gas 或费用参数，已阻止签名");
    }
    const requestAddress = typeof request.account === "string" ? request.account : request.account?.address;
    if (requestAddress && requestAddress.toLowerCase() !== account.address.toLowerCase()) {
      throw new Error("归集交易来源账户不一致，已阻止签名");
    }
    if (request.chain === null || (request.chain && request.chain.id !== chain.id)
      || (request.chainId !== undefined && request.chainId !== chain.id)) {
      throw new Error("归集交易网络不一致，已阻止签名");
    }
    if (request.nonce !== undefined && (!Number.isSafeInteger(request.nonce) || request.nonce < 0)) {
      throw new Error("归集交易 Nonce 无效，已阻止签名");
    }

    await beforeSign?.();
    const actualChainId = await getChainId(wallet);
    if (actualChainId !== chain.id) {
      throw new Error(`RPC 网络不匹配：预期 Chain ID ${chain.id}，实际 ${actualChainId}，已阻止签名`);
    }
    const nonce = request.nonce ?? await getTransactionCount(wallet, {
      address: account.address,
      blockTag: "pending"
    });
    if (!Number.isSafeInteger(nonce) || nonce < 0) {
      throw new Error("RPC 返回无效 Nonce，已阻止签名");
    }

    // Supplying chainId/nonce as well as the checked gas/fees keeps viem on its
    // normal signing path without probing the optional eth_fillTransaction RPC.
    return { ...request, account, chain, chainId: actualChainId, nonce };
  }

  // The collection runner serializes transactions from the same source wallet.
  return {
    async sendTransaction(request) {
      return wallet.sendTransaction(await prepareRequest(request as CollectionTransactionRequest) as never);
    },
    async writeContract(request) {
      return wallet.writeContract(await prepareRequest(request as CollectionTransactionRequest) as never);
    }
  };
}
