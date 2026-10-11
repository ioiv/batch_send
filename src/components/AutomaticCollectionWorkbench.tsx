import { useEffect, useMemo, useRef, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { isAddress, parseUnits, zeroAddress } from 'viem';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field, FieldLabel } from '@/components/ui/field';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SecretKeyInput, type SecretKeyInputHandle, type SecretKeyInputSnapshot } from './SecretKeyInput';
import { HelpTooltip } from './HelpTooltip';
import { SearchableSelect } from './SearchableSelect';
import { CompactNotice } from './CompactNotice';
import { ToolPageLayout, type WorkbenchStatus } from './ToolPageLayout';
import { ActionBar, WorkbenchPanel, WorkbenchSection, WorkbenchSummary, ConfirmActionDialog, ExecutionLogDialog, ReviewPanel } from './WorkbenchPrimitives';
import { CollectionResults } from './CollectionResults';
import { EvmGasBadge, EvmGasSettings } from './EvmGasControl';
import { useEvmGas } from '../hooks/useEvmGas';
import { getEvmDistributionNetworks, getEvmNetworkConfig } from '../lib/evm';
import { solanaNetworks, type SolanaNetworkId } from '../lib/solana';
import { isRpcEndpoint } from '../lib/rpc-preferences';
import { getAutomaticEvmIndexer } from '../lib/evm-wallet-inventory';
import { prepareAutomaticEvmCollection } from '../lib/automatic-evm-collection';
import { prepareAutomaticSolCollection } from '../lib/automatic-sol-collection';
import { automaticPhaseLabels, executeAutomaticCollection, type AutomaticCollectionPhase, type AutomaticCollectionWallet } from '../lib/collection-orchestrator';
import { CollectionPauseController } from '../lib/collection-execution';
import { buildWalletAssetOverview } from '../lib/wallet-asset-overview';
import { downloadCollectionResults, sanitizeRoundArchiveText, type CollectionDisplayResult } from '../lib/collection-results';
import './automatic-collection.css';

export type CollectionModeConfig = { networkId: string; rpcEndpoint: string; targetAddress: string };
export type AutomaticCollectionRound = { label: string; results: CollectionDisplayResult[] };
type WalletView = Pick<AutomaticCollectionWallet, 'address' | 'complete' | 'issues' | 'native'> & { holdings: NonNullable<AutomaticCollectionWallet['tasks'][number]['holding']>[] };

export function AutomaticCollectionWorkbench({ kind, currentToolId, initialConfig, readInitialWallets, onManual, historyRef }: {
  kind: 'evm' | 'solana'; currentToolId: 'evm-token-collection' | 'evm-nft-collection' | 'sol-collection';
  initialConfig: CollectionModeConfig; readInitialWallets: () => SecretKeyInputSnapshot | null;
  onManual: (snapshot: SecretKeyInputSnapshot, config: CollectionModeConfig) => void;
  historyRef: React.RefObject<AutomaticCollectionRound[]>;
}) {
  const evmNetworks = useMemo(() => getEvmDistributionNetworks(), []);
  const [networkId, setNetworkId] = useState(initialConfig.networkId);
  const [rpcEndpoint, setRpcEndpoint] = useState(initialConfig.rpcEndpoint);
  const [targetAddress, setTargetAddress] = useState(initialConfig.targetAddress);
  const network = getEvmNetworkConfig(networkId as never, evmNetworks);
  const [indexer, setIndexer] = useState(() => kind === 'evm' ? getAutomaticEvmIndexer(network.chainId) : '');
  const [maxFee, setMaxFee] = useState('0.01');
  const [includeNative, setIncludeNative] = useState(false);
  const [selectedCount, setSelectedCount] = useState(0);
  const [importing, setImporting] = useState(false);
  const [stage, setStage] = useState<'editing' | 'scanning' | 'ready' | 'running' | 'complete' | 'error'>('editing');
  const [phase, setPhase] = useState<AutomaticCollectionPhase>('token');
  const [paused, setPaused] = useState(false);
  const [message, setMessage] = useState('');
  const [wallets, setWallets] = useState<WalletView[]>([]);
  const [results, setResults] = useState<CollectionDisplayResult[]>([]);
  const [history, setHistory] = useState<AutomaticCollectionRound[]>(historyRef.current || []);
  const [needsAcknowledgement, setNeedsAcknowledgement] = useState(false);
  const keyRef = useRef<SecretKeyInputHandle>(null);
  const preparedRef = useRef<AutomaticCollectionWallet[] | null>(null);
  const operationRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const pauseRef = useRef(new CollectionPauseController());
  const mountedRef = useRef(true);
  const gas = useEvmGas({ enabled: kind === 'evm', network, rpcEndpoint });
  const busy = stage === 'scanning' || stage === 'running';
  const locked = busy || importing;
  const config = { networkId, rpcEndpoint, targetAddress };
  const targetValid = kind === 'evm'
    ? isAddress(targetAddress.trim()) && targetAddress.trim().toLowerCase() !== zeroAddress
    : (() => { try { return PublicKey.isOnCurve(new PublicKey(targetAddress.trim()).toBytes()); } catch { return false; } })();
  let fee: bigint | null = null;
  try { if (/^\d+(\.\d+)?$/.test(maxFee)) fee = parseUnits(maxFee, network.nativeCurrency.decimals); } catch { /* Field remains editable. */ }
  const canScan = !locked && !needsAcknowledgement && selectedCount > 0 && targetValid && isRpcEndpoint(rpcEndpoint) && (kind === 'solana' || Boolean(indexer.trim()) && fee !== null && fee > 0n && gas.gasSettings !== null);
  const overview = useMemo(() => Object.fromEntries(wallets.map(wallet => [wallet.address,
    buildWalletAssetOverview({ holdings: wallet.holdings, complete: wallet.complete, native: wallet.native })])), [wallets]);
  const statuses = useMemo(() => {
    const grouped: Record<string, CollectionDisplayResult[]> = {};
    for (const result of results) (grouped[result.address] ||= []).push(result);
    return grouped;
  }, [results]);
  const counts = { token: results.filter(r => r.phase === 'token').length, nft: results.filter(r => r.phase === 'nft').length, native: results.filter(r => r.phase === 'native').length };
  const incomplete = wallets.filter(wallet => !wallet.complete).length;
  const activeResults = stage === 'complete' || stage === 'error' ? results : results.filter(result => includeNative || result.phase !== 'native');
  const done = activeResults.filter(result => ['success', 'error', 'skipped'].includes(result.status)).length;
  const workbenchStatus: WorkbenchStatus = needsAcknowledgement ? 'uncertain' : stage === 'running' ? 'running' : stage === 'scanning' ? 'preflight' : stage === 'ready' ? 'ready' : stage === 'error' || stage === 'complete' && results.some(r => r.status === 'error') ? 'error' : stage === 'complete' ? 'success' : 'editing';

  useEffect(() => {
    mountedRef.current = true;
    const cleanup = () => { abortRef.current?.abort(); pauseRef.current.resume(); preparedRef.current = null; };
    const hide = () => { cleanup(); setWallets([]); setStage(current => current === 'ready' || current === 'scanning' ? 'editing' : current); };
    window.addEventListener('pagehide', hide);
    return () => { mountedRef.current = false; window.removeEventListener('pagehide', hide); cleanup(); };
  }, []);

  function archive() {
    if (!results.length || !['complete', 'error'].includes(stage)) return;
    const next = [{ label: `一键归集 · ${new Date().toLocaleString()}`, results: results.map(r => ({ ...r, message: sanitizeRoundArchiveText(r.message) })) }, ...historyRef.current].slice(0, 10);
    historyRef.current = next; setHistory(next);
  }
  function invalidate() {
    if (operationRef.current) return;
    archive(); abortRef.current?.abort(); preparedRef.current = null;
    setWallets([]); setResults([]); setStage('editing'); setMessage('');
  }
  async function scan() {
    if (!canScan || operationRef.current) return;
    archive(); const abort = new AbortController(); abortRef.current?.abort(); abortRef.current = abort;
    operationRef.current = true; preparedRef.current = null; setStage('scanning'); setWallets([]); setResults([]); setMessage('正在扫描钱包资产…');
    try {
      const keys = keyRef.current?.read() || '';
      const prepared = kind === 'evm'
        ? await prepareAutomaticEvmCollection({ keys, network, rpcEndpoint, targetAddress: targetAddress.trim(), indexer, signal: abort.signal, maxFeePerTransactionWei: fee!, gasSettings: gas.gasSettings! })
        : await prepareAutomaticSolCollection({ keys, networkId: networkId as SolanaNetworkId, rpcEndpoint, targetAddress: targetAddress.trim(), signal: abort.signal });
      if (!mountedRef.current) return;
      if (abort.signal.aborted) { setStage('editing'); setMessage('扫描已取消'); return; }
      preparedRef.current = prepared;
      setWallets(prepared.map(wallet => ({ address: wallet.address, complete: wallet.complete, issues: wallet.issues.map(sanitizeRoundArchiveText), native: wallet.native, holdings: wallet.tasks.flatMap(task => task.holding ? [task.holding] : []) })));
      setResults(prepared.flatMap(wallet => wallet.tasks.map(task => task.preview)));
      setStage('ready'); setMessage(`扫描完成 · ${prepared.length} 个钱包${prepared.some(w => !w.complete) ? ' · 部分扫描不完整' : ''}`);
    } catch (error) {
      if (!mountedRef.current) return;
      setStage(abort.signal.aborted ? 'editing' : 'error');
      setMessage(abort.signal.aborted ? '扫描已取消' : sanitizeRoundArchiveText(error instanceof Error ? error.message : '扫描失败'));
    } finally { operationRef.current = false; }
  }
  async function run() {
    const prepared = preparedRef.current; const abort = abortRef.current;
    if (!prepared || !abort || operationRef.current || needsAcknowledgement || stage !== 'ready') return;
    operationRef.current = true; pauseRef.current.resume(); setPaused(false); setStage('running'); setWallets([]);
    setMessage('开始归集 Token');
    try {
    const final = await executeAutomaticCollection({ wallets: prepared, includeNative, signal: abort.signal, pauseControl: pauseRef.current,
      onPhase(value) { if (mountedRef.current) { setPhase(value); setMessage(`正在归集 ${automaticPhaseLabels[value]}`); } },
      onResult(id, result) { if (mountedRef.current) setResults(current => current.map(item => item.executionId === id ? result : item)); }
    });
    if (!mountedRef.current) return;
    setResults(final); setNeedsAcknowledgement(final.some(result => result.uncertain)); setStage('complete');
    setMessage(`本轮结束 · 成功 ${final.filter(r => r.status === 'success').length} · 失败 ${final.filter(r => r.status === 'error').length} · 跳过 ${final.filter(r => r.status === 'skipped').length}`);
    } catch (error) {
      if (!mountedRef.current) return;
      setResults(current => current.map(result => !['success', 'error', 'skipped'].includes(result.status)
        ? { ...result, status: result.hash ? 'error' : 'skipped', uncertain: Boolean(result.hash), retryable: false, message: result.hash ? '执行中断，请核对已提交交易的链上结果' : '执行中断，未提交' } : result));
      setNeedsAcknowledgement(true); setStage('error');
      setMessage(sanitizeRoundArchiveText(error instanceof Error ? error.message : '归集流程中断，请核对执行日志'));
    } finally { preparedRef.current = null; operationRef.current = false; }
  }
  function changeNetwork(id: string) {
    invalidate(); setNetworkId(id);
    if (kind === 'evm') { const next = getEvmNetworkConfig(id as never, evmNetworks); setRpcEndpoint(next.rpcEndpoint); setIndexer(getAutomaticEvmIndexer(next.chainId)); }
    else setRpcEndpoint(solanaNetworks.find(next => next.id === id)!.endpoint);
  }

  return <ToolPageLayout stickyActions actionBar={<ActionBar
        summary={<WorkbenchSummary items={[{ label: '钱包', value: selectedCount }, { label: '计划总额', value: selectedCount ? results.length ? '按扫描结果归集' : '待扫描资产' : '—' }, { label: 'Token', value: counts.token }, { label: 'NFT', value: counts.nft }, { label: '原生币', value: includeNative ? '最后归集' : '保留' }]} />}
        feedback={message ? <CompactNotice summary={message} tone={workbenchStatus === 'error' || workbenchStatus === 'uncertain' ? 'warning' : 'info'} /> : null}>
        <ExecutionLogDialog disabled={!results.length}><CollectionResults results={activeResults} exportFilename="automatic-collection.csv" /></ExecutionLogDialog>
        {stage === 'scanning' ? <Button variant="outline" onClick={() => abortRef.current?.abort()}>取消扫描</Button> : stage === 'running' ? <>
          <span className="automatic-progress" role="status">{done}/{activeResults.length}</span>
          <Button variant="outline" onClick={() => { if (paused) pauseRef.current.resume(); else pauseRef.current.pause(); setPaused(!paused); }}>{paused ? '继续' : '暂停'}</Button>
          <Button variant="outline" onClick={() => { abortRef.current?.abort(); pauseRef.current.resume(); setPaused(false); setMessage('等待当前交易结束，后续任务已停止'); }}>停止后续任务</Button>
        </> : <>
          <Button disabled={!canScan} onClick={scan} variant="outline">{results.length ? '重新扫描' : '扫描资产'}</Button>
          <ConfirmActionDialog triggerSize="lg" triggerLabel="一键归集" confirmLabel="确认并开始归集" title="确认一键归集？" disabled={stage !== 'ready' || !preparedRef.current || !activeResults.some(result => result.status === 'pending') || needsAcknowledgement || locked}
            onConfirm={run} description={<div className="summary-list"><div><span>目标地址</span><strong className="mono">{targetAddress}</strong></div><div><span>执行顺序</span><strong>Token → NFT{includeNative ? ' → 原生币' : ''}</strong></div><div><span>钱包 / 资产</span><strong>{wallets.length} 个钱包 · {counts.token} 个 Token 项 · {counts.nft} 个 NFT 项</strong></div><div><span>原生币</span><strong>{includeNative ? '资产归集完成且复查通过后，扣除网络费归集' : '保留'}</strong></div>{incomplete ? <div><span>扫描不完整</span><strong>{incomplete} 个钱包；仅处理已发现资产，保留原生币</strong></div> : null}</div>} />
        </>}
      </ActionBar>} currentToolId={currentToolId} title={kind === 'evm' ? 'EVM 一键归集' : 'Solana 一键归集'} status={workbenchStatus}
    statusLabel={stage === 'scanning' ? '扫描中' : stage === 'running' ? paused ? '已暂停' : `${automaticPhaseLabels[phase]} 归集中` : stage === 'ready' ? '待确认' : needsAcknowledgement ? '需核对交易' : stage === 'complete' ? '本轮结束' : '配置'}
    actions={<>{kind === 'evm' ? <EvmGasBadge gas={gas} networkLabel={network.label} /> : null}{kind === 'solana' ? <Badge variant="outline">{solanaNetworks.find(n => n.id === networkId)?.label}</Badge> : null}</>}
    modeSwitch={<Tabs value="automatic" onValueChange={value => { if (value !== 'manual' || locked || needsAcknowledgement) return; archive(); preparedRef.current = null; onManual(keyRef.current?.handoff() || { keys: '', selectedIds: [] }, config); }}><TabsList aria-label="归集模式"><TabsTrigger value="manual" disabled={locked || needsAcknowledgement}>手动归集</TabsTrigger><TabsTrigger value="automatic">一键归集</TabsTrigger></TabsList></Tabs>}>
    <div className="workspace collection-workspace automatic-workspace">
      <WorkbenchPanel title="归集工作台" segmented>
        <WorkbenchSection>
          <SecretKeyInput ref={keyRef} mode={kind} disabled={busy || needsAcknowledgement} readInitialWallets={readInitialWallets} onDirty={invalidate} onImportingChange={setImporting} onLineCountChange={setSelectedCount} walletAssetOverviews={overview} walletStatuses={statuses} compactStatuses />
        </WorkbenchSection>
        <WorkbenchSection title="归集配置">
          <div className="config-grid">
            <Field><FieldLabel htmlFor="automatic-network">选择网络</FieldLabel><SearchableSelect id="automatic-network" searchLabel="选择网络" triggerLabel="选择网络" disabled={locked || needsAcknowledgement} value={networkId} onChange={changeNetwork} options={(kind === 'evm' ? evmNetworks : solanaNetworks).map(n => ({ value: n.id, label: n.label }))} /></Field>
            <Field><FieldLabel htmlFor="automatic-rpc">RPC 节点</FieldLabel><Input id="automatic-rpc" disabled={locked || needsAcknowledgement} value={rpcEndpoint} onChange={e => { invalidate(); setRpcEndpoint(e.target.value); }} /></Field>
            <Field><FieldLabel htmlFor="automatic-target">接收地址</FieldLabel><Input id="automatic-target" disabled={locked || needsAcknowledgement} value={targetAddress} placeholder={kind === 'evm' ? '0x…' : 'Solana 地址'} onChange={e => { invalidate(); setTargetAddress(e.target.value); }} /></Field>
            {kind === 'evm' ? <Field><div className="automatic-field-label"><FieldLabel htmlFor="automatic-indexer">资产索引节点</FieldLabel><HelpTooltip label="资产扫描范围">支持 Blockscout V2，发现 ERC-20、ERC-721 和 ERC-1155 候选，再通过 RPC 核对。扫描不完整时保留原生币。自定义索引网络无法自动核验，不执行原生币归集。</HelpTooltip></div><Input id="automatic-indexer" value={indexer} disabled={locked || needsAcknowledgement} placeholder="https://…blockscout.com" onChange={e => { invalidate(); setIndexer(e.target.value); }} /></Field> : <div className="automatic-field-label"><span>扫描 SPL / Token-2022</span><HelpTooltip label="Solana 资产扫描范围">扫描来源钱包全部 SPL 和 Token-2022 账户。无精度且数量为 1 的持仓按 NFT 显示；暂不支持压缩 NFT、Core 和专用可编程 NFT 归集，冻结或不支持的资产会保留并阻止原生币归集。Token 无可读符号时使用缩短的 Mint 地址。</HelpTooltip></div>}
          </div>
          <div className="automatic-native-option"><label><input type="checkbox" checked={includeNative} disabled={locked || needsAcknowledgement} onChange={e => { if (stage === 'complete' || stage === 'error') invalidate(); setIncludeNative(e.target.checked); }} />最后归集原生币</label><HelpTooltip label="原生币归集保护">默认保留原生币。开启后，只有完整扫描、Token 和 NFT 归集完成，并再次确认没有剩余资产的钱包才归集原生币。执行时重新读取余额并预留网络费；失败或状态不确定时保留原生币。</HelpTooltip></div>
          {kind === 'evm' ? <div className="automatic-gas"><EvmGasSettings disabled={locked || needsAcknowledgement} gas={gas} onSettingsChange={invalidate} /><Field><FieldLabel htmlFor="automatic-fee-cap">单笔最高网络费 ({network.nativeCurrency.symbol})</FieldLabel><Input id="automatic-fee-cap" value={maxFee} disabled={locked || needsAcknowledgement} inputMode="decimal" onChange={e => { invalidate(); setMaxFee(e.target.value); }} /></Field></div> : null}
          {needsAcknowledgement ? <label className="automatic-ack"><input type="checkbox" onChange={e => { if (e.target.checked) { setNeedsAcknowledgement(false); setMessage('已确认核对链上状态，请重新扫描'); } }} />我已核对状态不确定交易的链上结果，可以重新扫描</label> : null}
        </WorkbenchSection>
      </WorkbenchPanel>
      {wallets.length ? <ReviewPanel title="扫描详情" summary={`${wallets.length} 个钱包${incomplete ? ` · ${incomplete} 个不完整` : ''}`}><div className="automatic-scan-details">{wallets.map(wallet => <div key={wallet.address}><code>{wallet.address}</code><span>{wallet.complete ? '扫描完成' : '扫描不完整'}</span>{wallet.issues.map((issue, i) => <p key={i}>{issue}</p>)}</div>)}</div><CollectionResults results={activeResults} exportFilename="automatic-scan.csv" /></ReviewPanel> : null}
      {history.length ? <ReviewPanel title="历史归集记录" summary={`${history.length} 轮`}><div className="automatic-history">{history.map((round, i) => <div key={i}><span>{round.label}</span><ExecutionLogDialog title={round.label}><CollectionResults results={round.results} exportFilename={`automatic-history-${i + 1}.csv`} /></ExecutionLogDialog><Button variant="outline" onClick={() => downloadCollectionResults(round.results, `automatic-history-${i + 1}.csv`)}>导出 CSV</Button></div>)}</div></ReviewPanel> : null}
    </div>
  </ToolPageLayout>;
}
