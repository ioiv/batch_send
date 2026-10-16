import "./evm-contract-call-results.css";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CopyButton } from "@/components/CopyButton";
import { WorkbenchPanel } from "@/components/WorkbenchPrimitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { EvmContractCallRow } from "@/lib/evm-contract-call";

export type EvmContractCallResultsProps = {
  rows: readonly EvmContractCallRow[];
  callsPerWallet?: number;
  contractAddress: string;
  networkLabel: string;
  nativeSymbol: string;
  explorerBaseUrl?: string;
  phase: "review" | "running" | "result";
  footer: ReactNode;
  notice?: string;
  onExport: () => void;
};

type ResultFilter = "all" | "failed" | "unknown" | "submitted" | "unsent";

const statusLabels: Record<EvmContractCallRow["status"], string> = {
  pending: "待发送",
  preparing: "准备中",
  signing: "签名中",
  sending: "发送中",
  submitted: "已提交",
  failed: "失败",
  unknown: "待核对",
  cancelled: "未发送"
};

const filterOptions: readonly { value: ResultFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "failed", label: "失败" },
  { value: "unknown", label: "待核对" },
  { value: "submitted", label: "已提交" },
  { value: "unsent", label: "未发送" }
];

const statusOrder: Record<EvmContractCallRow["status"], number> = {
  unknown: 0,
  failed: 1,
  cancelled: 2,
  preparing: 3,
  signing: 3,
  sending: 3,
  submitted: 4,
  pending: 5
};

const pageSize = 50;
const previewSize = 5;
const nativeUnit = 10n ** 18n;

function formatAmount(value: bigint) {
  const sign = value < 0n ? "−" : "";
  const absolute = value < 0n ? -value : value;
  const fraction = (absolute % nativeUnit).toString().padStart(18, "0").replace(/0+$/, "");
  return `${sign}${absolute / nativeUnit}${fraction ? `.${fraction}` : ""}`;
}

function shorten(value: string, start = 8, end = 6) {
  return value.length > start + end + 1 ? `${value.slice(0, start)}…${value.slice(-end)}` : value;
}

function getExplorerBaseUrl(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return undefined;
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

function matchesFilter(row: EvmContractCallRow, filter: ResultFilter) {
  if (filter === "all") return true;
  if (filter === "unsent") return row.status === "pending" || row.status === "cancelled";
  return row.status === filter;
}

function CallDataDetails({ row, walletLabel }: { row: EvmContractCallRow; walletLabel: string }) {
  const [open, setOpen] = useState(false);
  return <details className="contract-call-result-calldata" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary aria-label={`${open ? "收起" : "查看"}${walletLabel}的调用数据`}>
      调用数据 <span>{Math.max(0, (row.calldata.length - 2) / 2).toLocaleString()} bytes</span>
    </summary>
    {open ? <div className="contract-call-result-calldata-content">
      <code>{row.calldata}</code>
      <CopyButton label="复制 calldata" value={row.calldata} />
    </div> : null}
  </details>;
}

function RowDetails({ row, walletLabel }: { row: EvmContractCallRow; walletLabel: string }) {
  const [open, setOpen] = useState(false);
  return <details className="contract-call-result-details" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary aria-label={`${open ? "收起" : "查看"}${walletLabel}的调用详情`}>详情</summary>
    {open ? <div className="contract-call-result-details-content">
      <dl className="contract-call-result-detail-list">
        <div><dt>钱包地址</dt><dd><code>{row.address}</code><CopyButton label="复制地址" value={row.address} /></dd></div>
        <div><dt>执行序号</dt><dd>第 {row.callIndex} / {row.callsPerWallet} 次</dd></div>
        <div><dt>附带金额（wei）</dt><dd><code>{row.amountWei.toString()}</code><CopyButton label="复制 wei 金额" value={row.amountWei.toString()} /></dd></div>
        <div><dt>随机 ID</dt><dd><code>{row.randomId.toString()}</code><CopyButton label="复制随机 ID" value={row.randomId.toString()} /></dd></div>
        {row.hash ? <div><dt>交易哈希</dt><dd><code>{row.hash}</code><CopyButton label="复制交易哈希" value={row.hash} /></dd></div> : null}
        {row.message ? <div><dt>执行说明</dt><dd>{row.message}</dd></div> : null}
      </dl>
      <CallDataDetails row={row} walletLabel={walletLabel} />
    </div> : null}
  </details>;
}

export function EvmContractCallResults({
  rows,
  callsPerWallet,
  contractAddress,
  networkLabel,
  nativeSymbol,
  explorerBaseUrl,
  phase,
  footer,
  notice,
  onExport
}: EvmContractCallResultsProps) {
  const [filter, setFilter] = useState<ResultFilter>("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [showAllReview, setShowAllReview] = useState(false);
  const isReview = phase === "review";
  const previousPhase = useRef(phase);
  useEffect(() => {
    if (previousPhase.current === "review" && phase !== "review") setPage(0);
    previousPhase.current = phase;
  }, [phase]);
  const symbol = nativeSymbol || "原生币";
  const explorer = useMemo(() => getExplorerBaseUrl(explorerBaseUrl), [explorerBaseUrl]);
  const totalAmount = useMemo(() => rows.reduce((total, row) => total + row.amountWei, 0n), [rows]);
  const walletCount = useMemo(() => new Set(rows.map(row => row.address.toLowerCase())).size, [rows]);
  const plannedCallsPerWallet = callsPerWallet ?? rows[0]?.callsPerWallet ?? 1;
  const counts = useMemo(() => {
    const result: Record<ResultFilter, number> = { all: rows.length, failed: 0, unknown: 0, submitted: 0, unsent: 0 };
    rows.forEach(row => {
      if (row.status === "failed" || row.status === "unknown" || row.status === "submitted") result[row.status] += 1;
      if (row.status === "pending" || row.status === "cancelled") result.unsent += 1;
    });
    return result;
  }, [rows]);
  const filteredRows = useMemo(() => {
    if (isReview) return rows;
    const search = query.trim().toLowerCase();
    return rows
      .filter(row => matchesFilter(row, filter) && (!search || [row.address, row.label, row.hash || ""].some(value => value.toLowerCase().includes(search))))
      .map((row, index) => ({ row, index }))
      .sort((left, right) => statusOrder[left.row.status] - statusOrder[right.row.status] || left.index - right.index)
      .map(item => item.row);
  }, [filter, isReview, query, rows]);
  const isPreview = isReview && !showAllReview;
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const currentPage = isPreview ? 0 : Math.min(page, pageCount - 1);
  const visibleRows = isPreview ? filteredRows.slice(0, previewSize) : filteredRows.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const firstVisible = currentPage * pageSize + 1;
  const lastVisible = isPreview ? visibleRows.length : Math.min((currentPage + 1) * pageSize, filteredRows.length);

  const clearFilters = () => { setFilter("all"); setQuery(""); setPage(0); };

  return <WorkbenchPanel
    className="contract-call-result-panel"
    title={isReview ? "核对本次调用" : "调用结果"}
    actions={<Button disabled={!rows.length} onClick={onExport} size="sm" type="button" variant="outline">导出 CSV</Button>}
    footer={footer}
  >
    <div className="contract-call-result-body">
      <div className="contract-call-result-overview">
        <dl className="contract-call-result-summary">
          <div><dt>钱包数</dt><dd>{walletCount.toLocaleString()} <span>个</span></dd></div>
          <div><dt>每钱包计划次数</dt><dd>{plannedCallsPerWallet} <span>次</span></dd></div>
          <div><dt>本次调用</dt><dd>{rows.length.toLocaleString()} <span>笔</span></dd></div>
          <div><dt>网络</dt><dd>{networkLabel || "自定义网络"}</dd></div>
          <div className="contract-call-result-total"><dt>附带金额合计</dt><dd><span className="contract-call-result-amount-value">{formatAmount(totalAmount)}</span> {symbol}<small>不含网络费</small></dd></div>
        </dl>
        <details className="contract-call-result-contract">
          <summary>目标合约 <code>{shorten(contractAddress)}</code><span>查看完整地址</span></summary>
          <div><code>{contractAddress}</code><CopyButton label="复制合约地址" value={contractAddress} /></div>
        </details>
      </div>

      {notice ? <p className="contract-call-result-notice" role="status">{notice}</p> : null}
      {!isReview ? <>
        <p className="contract-call-result-explanation">已提交表示 RPC 已接收，尚未确认上链；待核对项请先通过交易哈希查询。</p>
        <div className="contract-call-result-controls">
          <div className="contract-call-result-filters" role="group" aria-label="筛选调用结果">
            {filterOptions.filter(option => option.value === "all" || counts[option.value] > 0 || filter === option.value).map(option => <Button
              aria-label={`${option.label}，${counts[option.value]} 笔`}
              aria-pressed={filter === option.value}
              className="contract-call-result-filter"
              key={option.value}
              onClick={() => { setFilter(option.value); setPage(0); }}
              size="sm"
              type="button"
              variant={filter === option.value ? "secondary" : "ghost"}
            >{option.label}<span>{counts[option.value]}</span></Button>)}
          </div>
          <Input
            aria-label="搜索调用结果的地址、备注或交易哈希"
            className="contract-call-result-search"
            onChange={event => { setQuery(event.target.value); setPage(0); }}
            placeholder="搜索地址、备注或交易哈希"
            type="search"
            value={query}
          />
        </div>
      </> : null}

      {visibleRows.length ? <div className="contract-call-result-table">
        <Table aria-label="合约批量调用结果">
          <TableHeader><TableRow><TableHead scope="col">钱包</TableHead><TableHead scope="col">附带金额（{symbol}）</TableHead><TableHead scope="col">状态</TableHead><TableHead scope="col">交易 / 详情</TableHead></TableRow></TableHeader>
          <TableBody>{visibleRows.map(row => {
            const walletLabel = row.label || `钱包 ${row.walletIndex + 1}`;
            const callLabel = row.callsPerWallet > 1 ? `${walletLabel}第 ${row.callIndex} 次` : walletLabel;
            const needsAttention = row.status === "failed" || row.status === "unknown";
            return <TableRow className="contract-call-result-row" data-status={row.status} key={row.id}>
              <TableCell className="contract-call-result-wallet"><strong>{walletLabel}</strong>{row.callsPerWallet > 1 ? <small>第 {row.callIndex} / {row.callsPerWallet} 次</small> : null}<code title={row.address}>{shorten(row.address)}</code></TableCell>
              <TableCell className="contract-call-result-amount" data-label={`附带金额（${symbol}）`}>{formatAmount(row.amountWei)}</TableCell>
              <TableCell className="contract-call-result-status"><Badge data-status={row.status} variant={row.status === "failed" ? "destructive" : "outline"}>{statusLabels[row.status]}</Badge></TableCell>
              <TableCell className="contract-call-result-transaction">
                {row.hash ? explorer ? <a aria-label={`在区块浏览器查看${callLabel}的交易`} className="contract-call-result-hash" href={`${explorer}/tx/${encodeURIComponent(row.hash)}`} rel="noopener noreferrer" target="_blank" title={row.hash}>{shorten(row.hash, 10, 6)} ↗</a> : <code className="contract-call-result-hash" title={row.hash}>{shorten(row.hash, 10, 6)}</code> : null}
                {needsAttention && row.message ? <p className="contract-call-result-message">{row.message}</p> : null}
                <RowDetails row={row} walletLabel={callLabel} />
              </TableCell>
            </TableRow>;
          })}</TableBody>
        </Table>
      </div> : <div className="contract-call-result-empty" role="status">
        <p>{rows.length ? "暂无匹配结果" : "暂无调用明细"}</p>
        {rows.length ? <Button onClick={clearFilters} size="sm" type="button" variant="outline">清除筛选</Button> : null}
      </div>}

      {isPreview && rows.length > previewSize ? <div className="contract-call-result-expand">
        <span>已展示前 {previewSize} 笔，其余调用使用相同设置</span>
        <Button onClick={() => { setShowAllReview(true); setPage(0); }} size="sm" type="button" variant="outline">查看全部 {rows.length} 笔</Button>
      </div> : filteredRows.length > 0 && (!isReview || showAllReview) ? <div className="contract-call-result-pagination">
        <span aria-live="polite">显示 {firstVisible}–{lastVisible} 笔，共 {filteredRows.length} 笔</span>
        {pageCount > 1 ? <nav aria-label="调用结果分页">
          <Button aria-label="上一页调用结果" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} size="sm" type="button" variant="outline">上一页</Button>
          <span>{currentPage + 1} / {pageCount}</span>
          <Button aria-label="下一页调用结果" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)} size="sm" type="button" variant="outline">下一页</Button>
        </nav> : null}
      </div> : null}
    </div>
  </WorkbenchPanel>;
}
