import { queue } from "async";
import { Wallet, getAddress, keccak256, parseUnits } from "ethers";
import { parseEvmPrivateKeyInput } from "./evm-collection";

export type EvmContractCallConfig = {
  contractAddress: string;
  calldataTemplate: string;
  rpcEndpoint: string;
  /** If provided, both target inspection and execution must use this network. */
  expectedChainId?: number;
  /** Amounts use native currency units with exactly 18 supported decimal places. */
  amount: { mode: "fixed" | "random"; fixed: string; min: string; max: string };
  randomId: { min: string; max: string };
  /** Independent calls per wallet; omitted configurations retain one call. */
  callsPerWallet?: number;
  taskNum: number;
  /** A wallet worker waits between calls, including before its next wallet. */
  delay: { mode: "fixed" | "random"; minMs: number; maxMs: number };
  /** Blank means estimate separately for each wallet, then add a 20% buffer. */
  gasLimit?: string;
  /** Blank means read the RPC's legacy gas price, in gwei. */
  gasPriceGwei?: string;
  requestTimeoutMs?: number;
};

export type EvmContractCallStatus =
  | "pending" | "preparing" | "signing" | "sending"
  | "submitted" | "failed" | "unknown" | "cancelled";

export type EvmContractCallRow = {
  id: string;
  index: number;
  walletIndex: number;
  callIndex: number;
  callsPerWallet: number;
  line: number;
  address: string;
  label: string;
  status: EvmContractCallStatus;
  amountWei: bigint;
  randomId: bigint;
  calldata: string;
  hash: string | null;
  message: string;
};

/** Signers are held privately in memory; no secrets are attached to this object. */
export type EvmContractCallBatch = {
  readonly rows: readonly EvmContractCallRow[];
  readonly config: Readonly<EvmContractCallConfig>;
};

export type EvmContractCallExecutionOptions = {
  onUpdate?: (row: EvmContractCallRow) => void;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

type NormalizedConfig = {
  contractAddress: string;
  template: string;
  rpcEndpoint: string;
  expectedChainId?: number;
  amountMin: bigint;
  amountMax: bigint;
  idMin: bigint;
  idMax: bigint;
  callsPerWallet: number;
  taskNum: number;
  delayMin: number;
  delayMax: number;
  gasLimit?: bigint;
  gasPrice?: bigint;
  timeoutMs: number;
};
type PrivateBatch = { signers: Wallet[]; config: NormalizedConfig; rows: EvmContractCallRow[]; delays: number[]; started: boolean };
const privateBatches = new WeakMap<EvmContractCallBatch, PrivateBatch>();
const maximumUint256 = (1n << 256n) - 1n;
const maximumDelayMs = 300_000;
const maximumTemplateCharacters = 256 * 1024;
export const maximumEvmContractCallsPerWallet = 100;
export const maximumEvmContractCalls = 10_000;
const maximumBatchCalldataCharacters = 16 * 1024 * 1024;
const hashPattern = /^0x[0-9a-fA-F]{64}$/;

function invalid(message: string): never { throw new Error(message); }

function unsignedInteger(value: string, label: string, positive = false) {
  const text = value.trim();
  if (!/^\d{1,78}$/.test(text)) invalid(`${label}必须是 uint256 范围内的十进制整数`);
  const result = BigInt(text);
  if (result > maximumUint256 || (positive && result === 0n)) invalid(`${label}超出允许范围`);
  return result;
}

function decimalAmount(value: string, decimals: number, label: string, positive = false) {
  const text = value.trim();
  if (!new RegExp(`^\\d{1,78}(?:\\.\\d{1,${decimals}})?$`).test(text)) {
    invalid(`${label}必须是非负十进制数，最多 ${decimals} 位小数`);
  }
  let amount: bigint;
  try { amount = parseUnits(text, decimals); } catch { return invalid(`${label}无效`); }
  if (amount > maximumUint256 || (positive && amount === 0n)) invalid(`${label}超出允许范围`);
  return amount;
}

function validateTemplate(template: string) {
  const text = template.trim();
  if (text.length > maximumTemplateCharacters) invalid("calldata 模板过长");
  const replaced = text.replace(/\{(?:address|random|randomId|randowId)\}/g, "0".repeat(64));
  if (replaced.length > maximumTemplateCharacters) invalid("展开后的 calldata 过长");
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(replaced)) {
    invalid("calldata 必须是 0x 开头、完整字节的十六进制；仅支持 {address}、{random}、{randomId}（兼容 {randowId}）");
  }
  return text;
}

function normalizeConfig(config: EvmContractCallConfig): NormalizedConfig {
  let contractAddress: string;
  try { contractAddress = getAddress(config.contractAddress.trim()); }
  catch { return invalid("请填写有效的 EVM 合约地址"); }
  if (contractAddress === "0x0000000000000000000000000000000000000000") invalid("合约地址不能为零地址");
  const template = validateTemplate(config.calldataTemplate);
  let rpc: URL;
  try { rpc = new URL(config.rpcEndpoint.trim()); }
  catch { return invalid("请填写有效的 HTTP 或 HTTPS RPC 地址"); }
  if (!["http:", "https:"].includes(rpc.protocol) || rpc.username || rpc.password) {
    invalid("RPC 必须是 HTTP 或 HTTPS 地址，且不能包含用户名或密码");
  }
  if (config.expectedChainId !== undefined && (!Number.isSafeInteger(config.expectedChainId) || config.expectedChainId < 1)) {
    invalid("Chain ID 必须是大于 0 的安全整数");
  }
  if (!Number.isInteger(config.taskNum) || config.taskNum < 1 || config.taskNum > 20) invalid("线程数必须是 1 到 20 的整数");
  const callsPerWallet = config.callsPerWallet === undefined ? 1 : config.callsPerWallet;
  if (!Number.isInteger(callsPerWallet) || callsPerWallet < 1 || callsPerWallet > maximumEvmContractCallsPerWallet) {
    invalid(`每钱包执行次数必须是 1 到 ${maximumEvmContractCallsPerWallet} 的整数`);
  }
  if (!["fixed", "random"].includes(config.amount.mode)) invalid("金额模式无效");
  if (!["fixed", "random"].includes(config.delay.mode)) invalid("延迟模式无效");
  const amountMin = decimalAmount(config.amount.mode === "fixed" ? config.amount.fixed : config.amount.min, 18, "金额");
  const amountMax = config.amount.mode === "fixed" ? amountMin : decimalAmount(config.amount.max, 18, "最大金额");
  if (amountMin > amountMax) invalid("最小金额不能大于最大金额");
  const idMin = unsignedInteger(config.randomId.min, "最小随机数");
  const idMax = unsignedInteger(config.randomId.max, "最大随机数");
  if (idMin > idMax) invalid("最小随机数不能大于最大随机数");
  const delayMin = config.delay.minMs;
  const delayMax = config.delay.mode === "fixed" ? delayMin : config.delay.maxMs;
  if (![delayMin, delayMax].every((value) => Number.isInteger(value) && value >= 0 && value <= maximumDelayMs)) {
    invalid("任务间隔必须是 0 到 300000 毫秒的整数");
  }
  if (delayMin > delayMax) invalid("最小任务间隔不能大于最大任务间隔");
  const timeoutMs = config.requestTimeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) invalid("RPC 超时必须在 1 到 120000 毫秒之间");
  return {
    contractAddress, template, rpcEndpoint: config.rpcEndpoint.trim(), expectedChainId: config.expectedChainId, amountMin, amountMax, idMin, idMax,
    callsPerWallet, taskNum: config.taskNum, delayMin, delayMax, timeoutMs,
    gasLimit: config.gasLimit?.trim() ? unsignedInteger(config.gasLimit, "Gas Limit", true) : undefined,
    gasPrice: config.gasPriceGwei?.trim() ? decimalAmount(config.gasPriceGwei, 9, "Gas Price") : undefined
  };
}

export function validateEvmContractCallConfig(config: EvmContractCallConfig): void { normalizeConfig(config); }

function validateCallWorkload(callCount: number, calldataCharacters: number) {
  if (callCount > maximumEvmContractCalls) invalid(`调用总数不能超过 ${maximumEvmContractCalls} 笔，请减少钱包数或每钱包执行次数`);
  if (calldataCharacters > maximumBatchCalldataCharacters) invalid("调用数据总量过大，请减少钱包数、每钱包执行次数或调用数据长度");
}

/** Unbiased, cryptographically secure, inclusive integer sampling, without Number conversion. */
export function randomEvmContractCallInteger(min: bigint, max: bigint): bigint {
  if (min < 0n || max < min || max > maximumUint256) invalid("随机数范围无效");
  const span = max - min + 1n;
  if (span === 1n) return min;
  const bits = (span - 1n).toString(2).length;
  const byteCount = Math.ceil(bits / 8);
  const mask = 0xff >>> (byteCount * 8 - bits);
  for (;;) {
    const bytes = new Uint8Array(byteCount);
    globalThis.crypto.getRandomValues(bytes);
    bytes[0] &= mask;
    let candidate = 0n;
    for (const byte of bytes) candidate = (candidate << 8n) | BigInt(byte);
    if (candidate < span) return min + candidate;
  }
}

function hexWord(value: bigint) {
  if (value < 0n || value > maximumUint256) invalid("模板参数超出 uint256 范围");
  return value.toString(16).padStart(64, "0");
}

export function fillEvmCalldataTemplate({ template, address, amountWei, randomId }: {
  template: string; address: string; amountWei: bigint; randomId: bigint;
}) {
  const checked = validateTemplate(template);
  let checkedAddress: string;
  try { checkedAddress = getAddress(address); } catch { return invalid("钱包地址无效"); }
  const values = {
    address: checkedAddress.slice(2).toLowerCase().padStart(64, "0"),
    random: hexWord(amountWei),
    randomId: hexWord(randomId),
    randowId: hexWord(randomId)
  };
  return checked.replace(/\{(address|random|randomId|randowId)\}/g, (_match, token: keyof typeof values) => values[token]);
}

function readEvmContractCallWallets(privateKeyInput: string) {
  const parsed = parseEvmPrivateKeyInput(privateKeyInput);
  if (parsed.invalid) invalid("私钥列表包含无效条目，请先修正后再预览");
  const lines = privateKeyInput.split(/\r?\n/);
  const signers = parsed.accounts.map(({ line }) => {
    const source = lines[line - 1].trim();
    const key = source.slice(source.indexOf(",") + 1).trim();
    try { return new Wallet(key); } catch { return invalid("私钥无效或无法派生地址"); }
  });
  return { accounts: parsed.accounts, signers };
}

function createEvmContractCallBatch(config: EvmContractCallConfig, normalized: NormalizedConfig, signers: Wallet[], rows: EvmContractCallRow[]) {
  // Public snapshots cannot be mutated to change the transactions that were previewed.
  const batch: EvmContractCallBatch = Object.freeze({
    rows: Object.freeze(rows.map((row) => Object.freeze({ ...row }))),
    config: Object.freeze({ ...config, callsPerWallet: normalized.callsPerWallet, amount: Object.freeze({ ...config.amount }), randomId: Object.freeze({ ...config.randomId }), delay: Object.freeze({ ...config.delay }) })
  });
  const delays = rows.map(() => Number(randomEvmContractCallInteger(BigInt(normalized.delayMin), BigInt(normalized.delayMax))));
  privateBatches.set(batch, { signers, config: normalized, rows, delays, started: false });
  return batch;
}

export function prepareEvmContractCallBatch(privateKeyInput: string, config: EvmContractCallConfig): EvmContractCallBatch {
  const normalized = normalizeConfig(config);
  const { accounts, signers } = readEvmContractCallWallets(privateKeyInput);
  if (!accounts.length) invalid("请至少导入一个有效的 EVM 私钥");
  const callCount = accounts.length * normalized.callsPerWallet;
  const expandedLength = normalized.template.replace(/\{(?:address|random|randomId|randowId)\}/g, "0".repeat(64)).length;
  validateCallWorkload(callCount, callCount * expandedLength);
  const rows = accounts.flatMap((account, walletIndex) => Array.from({ length: normalized.callsPerWallet }, (_, call): EvmContractCallRow => {
    const amountWei = randomEvmContractCallInteger(normalized.amountMin, normalized.amountMax);
    const randomId = randomEvmContractCallInteger(normalized.idMin, normalized.idMax);
    return {
      id: `contract-call-${account.line}-${call + 1}`, index: walletIndex * normalized.callsPerWallet + call,
      walletIndex, callIndex: call + 1, callsPerWallet: normalized.callsPerWallet,
      line: account.line, address: signers[walletIndex].address,
      label: account.label, amountWei, randomId,
      calldata: fillEvmCalldataTemplate({ template: normalized.template, address: signers[walletIndex].address, amountWei, randomId }),
      status: "pending", hash: null, message: "已准备，等待发送"
    };
  }));
  return createEvmContractCallBatch(config, normalized, rows.map(row => signers[row.walletIndex]), rows);
}

/** Continue only calls known not to have been broadcast, preserving their prepared transaction data. */
export function retryEvmContractCallBatch(
  privateKeyInput: string,
  config: EvmContractCallConfig,
  previousRows: readonly EvmContractCallRow[]
): EvmContractCallBatch {
  const normalized = normalizeConfig(config);
  const eligible = previousRows.filter(row => (row.status === "failed" || row.status === "cancelled") && row.hash === null);
  if (!eligible.length) invalid("没有可继续的未广播调用；已提交或待核对项不能直接重发");
  const { signers: importedSigners } = readEvmContractCallWallets(privateKeyInput);
  const signerByAddress = new Map(importedSigners.map(signer => [signer.address.toLowerCase(), signer]));
  const seenCalls = new Set<string>();
  const seenIds = new Set<string>();
  validateCallWorkload(eligible.length, eligible.reduce((sum, row) => sum + (typeof row.calldata === "string" ? row.calldata.length : 0), 0));
  const rows = eligible.map((previous): EvmContractCallRow => {
    let address: string;
    try { address = getAddress(previous.address).toLowerCase(); }
    catch { return invalid("待继续项的钱包地址无效，请核对原始结果"); }
    if (!Number.isInteger(previous.callIndex) || previous.callIndex < 1 || previous.callIndex > normalized.callsPerWallet
      || previous.callsPerWallet !== normalized.callsPerWallet) invalid("待继续项的执行次数或序号无效，请核对原始结果");
    const callKey = `${address}:${previous.callIndex}`;
    if (seenCalls.has(callKey) || seenIds.has(previous.id)) invalid("待继续项包含重复调用或记录，请核对原始结果");
    seenCalls.add(callKey); seenIds.add(previous.id);
    const signer = signerByAddress.get(address);
    if (!signer) invalid(`钱包 ${previous.walletIndex + 1} 缺少私钥，请重新导入后继续`);
    if (typeof previous.amountWei !== "bigint" || previous.amountWei < 0n || previous.amountWei > maximumUint256
      || typeof previous.randomId !== "bigint" || previous.randomId < 0n || previous.randomId > maximumUint256
      || typeof previous.calldata !== "string" || previous.calldata.length > maximumTemplateCharacters
      || !/^0x(?:[0-9a-fA-F]{2})*$/.test(previous.calldata)) {
      invalid("待继续项的原始调用数据无效，请核对原始结果");
    }
    return { ...previous, status: "pending", hash: null, message: "已保留原调用参数，等待继续发送" };
  }).sort((left, right) => left.walletIndex - right.walletIndex || left.callIndex - right.callIndex);
  // Match each call after sorting; imported wallet order may differ from the preview.
  const orderedSigners = rows.map(row => signerByAddress.get(row.address.toLowerCase())!);
  return createEvmContractCallBatch(config, normalized, orderedSigners, rows);
}

export function disposeEvmContractCallBatch(batch: EvmContractCallBatch): void { privateBatches.delete(batch); }

class RpcFailure extends Error {
  constructor(message: string, readonly kind: "rejected" | "uncertain" | "cancelled", readonly alreadyKnown = false) { super(message); }
}

function safeRpcMessage(error: unknown) {
  if (!error || typeof error !== "object") return "RPC 返回了无效错误";
  const { code, message } = error as { code?: unknown; message?: unknown };
  const text = typeof message === "string" ? message.toLowerCase() : "";
  if (/\balready known\b|\bknown transaction\b/.test(text)) return "交易已被 RPC 接收";
  if (/insufficient funds/.test(text)) return "钱包余额不足，无法支付金额和手续费";
  if (/nonce too low/.test(text)) return "Nonce 过低，钱包可能已发送其他交易";
  if (/nonce too high/.test(text)) return "Nonce 过高，请检查钱包待处理交易";
  if (/revert/.test(text)) return "合约执行回滚，请检查 calldata、金额和合约条件";
  if (/underpriced|fee too low|base fee/.test(text)) return "Gas Price 过低，RPC 拒绝交易";
  if (/gas required exceeds|out of gas|intrinsic gas too low/.test(text)) return "Gas Limit 不足";
  if (/invalid sender|invalid signature/.test(text)) return "RPC 拒绝交易签名或发送地址";
  return Number.isSafeInteger(code) ? `RPC 拒绝请求（错误码 ${code}）` : "RPC 拒绝请求";
}

function rpcQuantity(value: unknown, label: string, positive = false) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value) || value.length > 66) {
    throw new RpcFailure(`${label}响应无效`, "uncertain");
  }
  const quantity = BigInt(value);
  if (quantity > maximumUint256 || (positive && quantity === 0n)) throw new RpcFailure(`${label}响应超出允许范围`, "uncertain");
  return quantity;
}

function hexQuantity(value: bigint) { return `0x${value.toString(16)}`; }

function checkedChainId(value: unknown, expectedChainId?: number) {
  const chainId = rpcQuantity(value, "Chain ID", true);
  if (chainId > BigInt(Number.MAX_SAFE_INTEGER)) throw new RpcFailure("Chain ID 超出允许范围", "rejected");
  if (expectedChainId !== undefined && chainId !== BigInt(expectedChainId)) {
    throw new RpcFailure(`RPC 网络不匹配：预期 Chain ID ${expectedChainId}，实际 ${chainId}`, "rejected");
  }
  return chainId;
}

function createRpc(config: NormalizedConfig, fetchImpl: typeof fetch, signal?: AbortSignal) {
  let nextId = 0;
  return async (method: string, params: unknown[]) => {
    if (signal?.aborted) throw new RpcFailure("任务已停止", "cancelled");
    const controller = new AbortController();
    const id = ++nextId;
    let rejectInterrupt: (error: RpcFailure) => void = () => {};
    const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupt = reject; });
    const stop = () => { controller.abort(); rejectInterrupt(new RpcFailure("任务已停止", "cancelled")); };
    signal?.addEventListener("abort", stop, { once: true });
    const timeout = setTimeout(() => {
      controller.abort(); rejectInterrupt(new RpcFailure("RPC 请求超时", "uncertain"));
    }, config.timeoutMs);
    try {
      const response = await Promise.race([
        fetchImpl(config.rpcEndpoint, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: controller.signal
        }), interrupted
      ]);
      if (!response.ok) throw new RpcFailure(`RPC HTTP 请求失败（${response.status}）`, "uncertain");
      const payload: unknown = await Promise.race([response.json(), interrupted]);
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new RpcFailure("RPC 响应格式无效", "uncertain");
      const body = payload as { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown };
      if (body.jsonrpc !== "2.0" || body.id !== id || (("result" in body) === ("error" in body))) {
        throw new RpcFailure("RPC 响应格式或请求编号无效", "uncertain");
      }
      if ("error" in body) {
        if (!body.error || typeof body.error !== "object" || !Number.isSafeInteger((body.error as {code?: unknown}).code) || typeof (body.error as {message?: unknown}).message !== "string") {
          throw new RpcFailure("RPC 错误响应格式无效", "uncertain");
        }
        const message = safeRpcMessage(body.error);
        throw new RpcFailure(message, message.startsWith("Nonce 过低") ? "uncertain" : "rejected", message === "交易已被 RPC 接收");
      }
      return body.result;
    } catch (error) {
      if (error instanceof RpcFailure) throw error;
      // Provider errors may echo private material, raw transactions or RPC credentials.
      throw new RpcFailure("无法读取 RPC 响应，请检查网络或 RPC 服务", "uncertain");
    } finally {
      clearTimeout(timeout); signal?.removeEventListener("abort", stop);
    }
  };
}

/** Read-only target inspection: no wallet access, signing, simulation or broadcast. */
export async function inspectEvmContractCallTarget(
  config: EvmContractCallConfig,
  { signal, fetchImpl = fetch }: Pick<EvmContractCallExecutionOptions, "signal" | "fetchImpl"> = {}
): Promise<{ chainId: number }> {
  const normalized = normalizeConfig(config);
  const rpc = createRpc(normalized, fetchImpl, signal);
  const [chainId, code] = await Promise.all([
    rpc("eth_chainId", []).then(value => checkedChainId(value, normalized.expectedChainId)),
    rpc("eth_getCode", [normalized.contractAddress, "latest"])
  ]);
  if (typeof code !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(code)) {
    throw new RpcFailure("合约代码响应无效，请检查 RPC 服务", "uncertain");
  }
  if (code === "0x") throw new RpcFailure("目标地址在当前网络没有合约代码，请检查网络和合约地址", "rejected");
  return { chainId: Number(chainId) };
}

function pause(ms: number, signal?: AbortSignal) {
  if (!ms || signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    if (signal?.aborted) done();
  });
}

export async function executeEvmContractCallBatch(
  batch: EvmContractCallBatch,
  { onUpdate, signal, fetchImpl = fetch }: EvmContractCallExecutionOptions = {}
): Promise<EvmContractCallRow[]> {
  const privateBatch = privateBatches.get(batch);
  if (!privateBatch) invalid("预览已失效，请重新准备交易");
  if (privateBatch.started) invalid("该批交易已启动，不能重复发送；请先核对结果");
  privateBatch.started = true;
  const { config, signers, delays } = privateBatch;
  const rows = privateBatch.rows.map((row) => ({ ...row }));
  const emit = (row: EvmContractCallRow, status: EvmContractCallStatus, message: string) => {
    row.status = status; row.message = message;
    try { onUpdate?.({ ...row }); } catch { /* A display callback must never change broadcast behavior. */ }
  };
  const rpc = createRpc(config, fetchImpl, signal);
  const stopped = (row: EvmContractCallRow) => emit(row, "cancelled", "已停止，未广播交易");
  let chainId: bigint;
  let gasPrice: bigint;
  try {
    if (signal?.aborted) { rows.forEach(stopped); privateBatches.delete(batch); return rows; }
    [chainId, gasPrice] = await Promise.all([
      rpc("eth_chainId", []).then((value) => checkedChainId(value, config.expectedChainId)),
      config.gasPrice !== undefined ? Promise.resolve(config.gasPrice) : rpc("eth_gasPrice", []).then((value) => rpcQuantity(value, "Gas Price"))
    ]);
  } catch (error) {
    const cancelled = signal?.aborted;
    rows.forEach((row) => emit(row, cancelled ? "cancelled" : "failed", cancelled ? "已停止，未广播交易" : error instanceof RpcFailure ? error.message : "读取网络配置失败"));
    privateBatches.delete(batch);
    return rows;
  }
  const runCall = async (index: number, nextNonce?: bigint): Promise<bigint | undefined> => {
    const row = rows[index];
    let broadcasting = false;
    let nonce: bigint | undefined;
    try {
      if (signal?.aborted) { stopped(row); return; }
      emit(row, "preparing", "正在读取待处理 Nonce 和 Gas");
      const transaction = { from: row.address, to: config.contractAddress, data: row.calldata, value: hexQuantity(row.amountWei) };
      const [nonceValue, estimatedGas] = await Promise.all([
        rpc("eth_getTransactionCount", [row.address, "pending"]).then((value) => rpcQuantity(value, "Nonce")),
        config.gasLimit !== undefined ? Promise.resolve(config.gasLimit) : rpc("eth_estimateGas", [{ ...transaction, gasPrice: hexQuantity(gasPrice) }]).then((value) => {
          const estimate = rpcQuantity(value, "Gas 估算", true);
          const buffered = (estimate * 120n + 99n) / 100n;
          if (buffered > maximumUint256) throw new RpcFailure("Gas 估算超出允许范围", "rejected");
          return buffered;
        })
      ]);
      nonce = nextNonce !== undefined && nextNonce > nonceValue ? nextNonce : nonceValue;
      if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) throw new RpcFailure("Nonce 超出允许范围", "rejected");
      if (signal?.aborted) { stopped(row); return; }
      emit(row, "signing", "正在本地离线签名");
      const raw = await signers[index].signTransaction({
        type: 0, chainId, nonce: Number(nonce), to: config.contractAddress,
        data: row.calldata, value: row.amountWei, gasLimit: estimatedGas, gasPrice
      });
      if (signal?.aborted) { stopped(row); return; }
      const expectedHash = keccak256(raw);
      row.hash = expectedHash;
      emit(row, "sending", "正在广播已签名交易");
      if (signal?.aborted) { row.hash = null; stopped(row); return; }
      broadcasting = true;
      const returnedHash = await rpc("eth_sendRawTransaction", [raw]);
      if (typeof returnedHash !== "string" || !hashPattern.test(returnedHash) || returnedHash.toLowerCase() !== expectedHash.toLowerCase()) {
        throw new RpcFailure("RPC 未返回匹配的交易哈希", "uncertain");
      }
      emit(row, "submitted", "已提交 RPC，等待链上确认");
      return nonce + 1n;
    } catch (error) {
      if (broadcasting && error instanceof RpcFailure && error.alreadyKnown) {
        emit(row, "submitted", "交易已被 RPC 接收，等待链上确认");
        return nonce! + 1n;
      } else if (broadcasting && (!(error instanceof RpcFailure) || error.kind !== "rejected")) {
        emit(row, "unknown", "广播结果不确定，请用交易哈希核对，勿直接重发");
      } else if (signal?.aborted || (error instanceof RpcFailure && error.kind === "cancelled")) {
        row.hash = null; stopped(row);
      } else {
        if (!broadcasting) row.hash = null;
        emit(row, "failed", error instanceof RpcFailure ? error.message : "本地签名或交易准备失败");
      }
    }
    return undefined;
  };
  const walletCalls = new Map<string, number[]>();
  rows.forEach((row, index) => {
    const key = row.address.toLowerCase();
    const indices = walletCalls.get(key) || [];
    indices.push(index);
    walletCalls.set(key, indices);
  });
  const worker = queue<{ indices: number[] }>(async ({ indices }) => {
    let nextNonce: bigint | undefined;
    for (let position = 0; position < indices.length; position++) {
      const index = indices[position];
      nextNonce = await runCall(index, nextNonce);
      if (nextNonce === undefined) {
        const reason = signal?.aborted ? "已停止，未广播交易"
          : rows[index].status === "unknown" ? "前一次调用待核对，该钱包后续调用未发送"
          : "前一次调用未成功提交，该钱包后续调用未发送";
        indices.slice(position + 1).forEach(remaining => emit(rows[remaining], "cancelled", reason));
        if (!signal?.aborted && worker.length() > 0) await pause(delays[index], signal);
        break;
      }
      if (!signal?.aborted && (position + 1 < indices.length || worker.length() > 0)) await pause(delays[index], signal);
    }
  }, config.taskNum);
  for (const indices of walletCalls.values()) worker.push({ indices });
  await worker.drain();
  privateBatches.delete(batch);
  return rows;
}
