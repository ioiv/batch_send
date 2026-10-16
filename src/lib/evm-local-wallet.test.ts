import { describe, expect, it, vi } from "vitest";
import { custom, defineChain, encodeFunctionData, parseAbi, parseTransaction, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createEvmLocalWalletClient } from "./evm-local-wallet";

const chain = defineChain({
  id: 84532,
  name: "Local RPC fixture",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://fixture.invalid"] } }
});
const target = "0x2222222222222222222222222222222222222222";
const contract = "0x3333333333333333333333333333333333333333";
const hash = `0x${"ab".repeat(32)}` as Hex;
const tokenId = 900719925474099312345n;
const abi = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
  "function safeBatchTransferFrom(address from, address to, uint256[] ids, uint256[] amounts, bytes data)"
]);
const legacyFees = { gas: 123456n, gasPrice: 99n, type: "legacy" as const };
const dynamicFees = { gas: 123456n, maxFeePerGas: 123n, maxPriorityFeePerGas: 2n, type: "eip1559" as const };

function harness({
  actualChainId = chain.id,
  beforeSign,
  failMethod
}: { actualChainId?: number; beforeSign?: () => void | Promise<void>; failMethod?: string } = {}) {
  const account = privateKeyToAccount(`0x${"0".repeat(63)}1`);
  const sign = vi.spyOn(account, "signTransaction");
  const requests: { method: string; params?: unknown[] }[] = [];
  const broadcast: Hex[] = [];
  const wallet = createEvmLocalWalletClient({
    account,
    beforeSign,
    chain,
    transport: custom({ async request({ method, params }) {
      requests.push({ method, params: params as unknown[] });
      if (method === failMethod) throw Object.assign(new Error("fixture RPC read failed"), { code: -32000 });
      if (method === "eth_chainId") return `0x${actualChainId.toString(16)}`;
      if (method === "eth_getTransactionCount") return "0x7";
      if (method === "eth_sendRawTransaction") { broadcast.push((params as Hex[])[0]); return hash; }
      throw new Error(`Unexpected RPC method: ${method}`);
    } }, { retryCount: 0 })
  });
  return { account, broadcast, requests, sign, wallet };
}

describe("standard RPC local collection wallet", () => {
  it.each(["native", "erc20", "erc721", "erc1155"] as const)(
    "signs %s with the pending nonce and checked fees without probing eth_fillTransaction",
    async (standard) => {
      const { account, broadcast, requests, sign, wallet } = harness();
      const fees = standard === "erc721" || standard === "erc1155" ? dynamicFees : legacyFees;
      let data: Hex | undefined;
      let result: Hex;
      if (standard === "native") {
        result = await wallet.sendTransaction({ account, chain, ...fees, to: target, value: 987654321n });
      } else {
        const call = standard === "erc20"
          ? { abi, functionName: "transfer", args: [target, 123456789012345678901n] } as const
          : standard === "erc721"
          ? { abi, functionName: "safeTransferFrom", args: [account.address, target, tokenId] } as const
          : { abi, functionName: "safeBatchTransferFrom", args: [account.address, target, [tokenId, 2n], [3n, 4n], "0x"] } as const;
        data = encodeFunctionData(call);
        result = await wallet.writeContract({ account, chain, address: contract, ...fees, ...call } as never);
      }

      expect(result).toBe(hash);
      expect(requests.map(request => request.method)).toEqual(["eth_chainId", "eth_getTransactionCount", "eth_sendRawTransaction"]);
      expect(requests[1].params).toEqual([account.address, "pending"]);
      expect(sign).toHaveBeenCalledTimes(1);
      expect(broadcast).toHaveLength(1);
      const transaction = parseTransaction(broadcast[0]);
      expect(transaction).toMatchObject({ chainId: chain.id, nonce: 7, gas: fees.gas, type: fees.type,
        to: standard === "native" ? target : contract, ...(standard === "native" ? { value: 987654321n } : { data }) });
      expect(transaction).toMatchObject(fees.type === "legacy" ? { gasPrice: fees.gasPrice } : {
        maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas
      });
    }
  );

  it("preserves an explicit nonce and does not read a replacement", async () => {
    const { account, broadcast, requests, wallet } = harness();
    await wallet.sendTransaction({ account, chain, ...legacyFees, to: target, nonce: 42, value: 1n });
    expect(requests.map(request => request.method)).toEqual(["eth_chainId", "eth_sendRawTransaction"]);
    expect(parseTransaction(broadcast[0]).nonce).toBe(42);
  });

  it.each(["eth_chainId", "eth_getTransactionCount"])("does not sign or broadcast if %s fails", async failMethod => {
    const { account, broadcast, sign, wallet } = harness({ failMethod });
    await expect(wallet.sendTransaction({ account, chain, ...legacyFees, to: target, value: 1n })).rejects.toThrow("fixture RPC read failed");
    expect(sign).not.toHaveBeenCalled();
    expect(broadcast).toEqual([]);
  });

  it("does not sign or broadcast on a mismatched RPC network", async () => {
    const { account, broadcast, requests, sign, wallet } = harness({ actualChainId: 1 });
    await expect(wallet.sendTransaction({ account, chain, ...legacyFees, to: target, value: 1n })).rejects.toThrow("预期 Chain ID 84532，实际 1");
    expect(requests.map(request => request.method)).toEqual(["eth_chainId"]);
    expect(sign).not.toHaveBeenCalled();
    expect(broadcast).toEqual([]);
  });

  it("runs the pause/cancellation check before reading a fresh nonce", async () => {
    const beforeSign = vi.fn(async () => { throw new Error("操作已停止"); });
    const { account, broadcast, requests, sign, wallet } = harness({ beforeSign });
    await expect(wallet.sendTransaction({ account, chain, ...legacyFees, to: target, value: 1n })).rejects.toThrow("操作已停止");
    expect(beforeSign).toHaveBeenCalledOnce();
    expect(requests).toEqual([]);
    expect(sign).not.toHaveBeenCalled();
    expect(broadcast).toEqual([]);
  });

  it("rejects incomplete checked fees before signing or probing any RPC", async () => {
    const { account, requests, sign, wallet } = harness();
    await expect(wallet.sendTransaction({ account, chain, gas: 21000n, to: target, value: 1n })).rejects.toThrow("缺少已核验的 Gas 或费用参数");
    expect(requests).toEqual([]);
    expect(sign).not.toHaveBeenCalled();
  });
});
