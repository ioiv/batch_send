import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type FormEvent } from "react";
import { HelpTooltip } from "./HelpTooltip";
import { ToolPageLayout, type WorkbenchStatus } from "./ToolPageLayout";
import { ExecutionProgress, WorkbenchPanel, WorkbenchSummary } from "./WorkbenchPrimitives";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { downloadScanCsv, normalizeWebsiteUrl } from "../lib/network-scan";
import {
  PATH_DISCOVERY_SOURCES,
  discoverWebsitePaths,
  exportDiscoveredWebsitePathsCsv,
  type DiscoveredWebsitePathResult,
  type PathDiscoverySourceResult,
  type WebsitePathDiscoveryProgress,
  type WebsitePathDiscoverySummary
} from "../lib/website-path-discovery";
import "./network-scan.css";

type ScanState = "editing" | "running" | "stopping" | "stopped" | "complete" | "error";
type ResultFilter = "all" | "found" | "suspected" | "missing" | "error";
type InputField = "target" | "concurrency" | "timeout";
type SourceId = PathDiscoverySourceResult["source"];
type ScanJob = { controller: AbortController };
const RESULTS_PER_PAGE = 100;
const shortSourceLabels: Record<SourceId, string> = { links: "页面", scripts: "脚本", robots: "robots", sitemap: "Sitemap", wayback: "Wayback" };

function resultGroup(result: DiscoveredWebsitePathResult): Exclude<ResultFilter, "all"> {
  if (result.status === "error") return "error";
  if (result.soft404) return "suspected";
  return result.statusCode === 404 || result.statusCode === 410 ? "missing" : "found";
}

function resultLabel(result: DiscoveredWebsitePathResult) {
  const group = resultGroup(result);
  if (group === "error") return "请求错误";
  const code = result.statusCode === undefined ? "" : ` · ${result.statusCode}`;
  if (group === "suspected") return `疑似软 404${code}`;
  if (group === "missing") return `未找到${code}`;
  if (result.statusCode && result.statusCode >= 300 && result.statusCode < 400) return `重定向${code}`;
  if (result.statusCode === 401 || result.statusCode === 403) return `访问受限${code}`;
  return `有响应${code}`;
}

function sourceLabel(source: SourceId) {
  return PATH_DISCOVERY_SOURCES.find((item) => item.id === source)?.label || source;
}

function sourceStatusLabel(result: PathDiscoverySourceResult | undefined, state: ScanState) {
  if (result) return result.status === "success" ? "已读取" : result.status === "partial" ? "部分结果" : "不可用";
  return state === "editing" ? "待开始" : state === "stopped" || state === "stopping" ? "未完成" : state === "running" ? "读取中" : "未返回";
}

function displayPath(url: string) {
  try { return new URL(url).pathname; } catch { return url; }
}

function safeHttpUrl(value: string, base?: string) {
  try {
    const url = new URL(value, base);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch { return undefined; }
}

function ResultSources({ result }: { result: DiscoveredWebsitePathResult }) {
  if (!result.sources.length) return <>—</>;
  return <span className="website-path-discovery-compact-cell"><span>{shortSourceLabels[result.sources[0]]}{result.sources.length > 1 ? ` +${result.sources.length - 1}` : ""}</span><HelpTooltip label={`${result.url} 的发现来源`}><ul>{result.sources.map((source) => <li key={source}>{sourceLabel(source)}</li>)}</ul></HelpTooltip></span>;
}

function ResultDetails({ result }: { result: DiscoveredWebsitePathResult }) {
  const location = result.location ? safeHttpUrl(result.location, result.url) : undefined;
  return <span className="website-path-discovery-compact-cell"><span>查看</span><HelpTooltip label={`${result.url} 的响应详情`}>
    <div><strong>完整地址</strong><p className="network-scan-address">{result.url}</p></div>
    {result.contentLength === undefined ? null : <div><strong>响应声明大小</strong><p>{result.contentLength.toLocaleString()} B</p></div>}
    {result.location ? <div><strong>跳转地址</strong><p>{location ? <a className="network-scan-link" href={location} rel="noopener noreferrer" target="_blank">{result.location}</a> : result.location}</p></div> : null}
    {result.message ? <p>{result.message}</p> : result.soft404 ? <p>与随机不存在路径的响应相似，请进一步核对</p> : null}
  </HelpTooltip></span>;
}

function ScanResultTable({ results }: { results: DiscoveredWebsitePathResult[] }) {
  return <div className="network-scan-table website-path-discovery-table"><Table aria-label="网站路径扫描结果">
    <TableHeader><TableRow><TableHead>路径</TableHead><TableHead>状态</TableHead><TableHead>页面标题</TableHead><TableHead>发现来源</TableHead><TableHead>响应详情</TableHead></TableRow></TableHeader>
    <TableBody>{results.map((result) => {
      const href = result.status === "responded" ? safeHttpUrl(result.url) : undefined;
      return <TableRow data-scan-status={resultGroup(result)} key={result.url}>
        <TableCell className="network-scan-result__target">{href ? <a className="network-scan-link" href={href} rel="noopener noreferrer" target="_blank" title={result.url}>{displayPath(result.url)}</a> : <span className="network-scan-address" title={result.url}>{displayPath(result.url)}</span>}</TableCell>
        <TableCell className="network-scan-result__status"><Badge variant="outline">{resultLabel(result)}</Badge></TableCell>
        <TableCell className="network-scan-result__detail" data-label="页面标题"><div className="website-path-discovery-title" title={result.title}>{result.title || "—"}</div></TableCell>
        <TableCell className="network-scan-result__detail" data-label="发现来源"><ResultSources result={result} /></TableCell>
        <TableCell className="network-scan-result__detail" data-label="响应详情"><ResultDetails result={result} /></TableCell>
      </TableRow>;
    })}</TableBody>
  </Table></div>;
}

export function NetworkScanWorkbench() {
  const toolId = "website-path-scan";
  const [target, setTarget] = useState("");
  const [concurrency, setConcurrency] = useState("4");
  const [timeout, setTimeoutValue] = useState("5");
  const [state, setState] = useState<ScanState>("editing");
  const [inputError, setInputError] = useState<{ field: InputField; message: string } | null>(null);
  const [scanError, setScanError] = useState("");
  const [roundTarget, setRoundTarget] = useState("");
  const [results, setResults] = useState<DiscoveredWebsitePathResult[]>([]);
  const [sources, setSources] = useState<Partial<Record<SourceId, PathDiscoverySourceResult>>>({});
  const [summary, setSummary] = useState<WebsitePathDiscoverySummary | null>(null);
  const [progress, setProgress] = useState<WebsitePathDiscoveryProgress>({ phase: "discovering", completed: 0, total: 0, discovered: 0 });
  const [filter, setFilter] = useState<ResultFilter>("all");
  const [httpStatus, setHttpStatus] = useState<number | "all">("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const jobRef = useRef<ScanJob | null>(null);
  const inputRefs = useRef<Partial<Record<InputField, HTMLInputElement | null>>>({});
  const busy = state === "running" || state === "stopping";

  useEffect(() => () => {
    jobRef.current?.controller.abort();
    jobRef.current = null;
  }, []);

  const counts = useMemo(() => {
    const value = { found: 0, suspected: 0, missing: 0, error: 0 };
    results.forEach((result) => { value[resultGroup(result)] += 1; });
    return value;
  }, [results]);
  const httpStatusCounts = useMemo(() => {
    const codes = new Map<number, number>();
    results.forEach((result) => {
      if (resultGroup(result) === "found" && result.statusCode !== undefined) {
        codes.set(result.statusCode, (codes.get(result.statusCode) ?? 0) + 1);
      }
    });
    // Keep the chosen code visible if live updates remove its final matching row.
    if (httpStatus !== "all" && !codes.has(httpStatus)) codes.set(httpStatus, 0);
    return [...codes].sort(([first], [second]) => first - second);
  }, [httpStatus, results]);
  const visibleResults = useMemo(() => {
    const search = query.trim().toLowerCase();
    return results.filter((result) => (filter === "all" || resultGroup(result) === filter)
      && (filter !== "found" || httpStatus === "all" || result.statusCode === httpStatus)
      && (!search || [result.url, resultLabel(result), result.message, result.title, result.location, result.statusCode, result.sources.map(sourceLabel).join(" ")].join(" ").toLowerCase().includes(search)));
  }, [filter, httpStatus, query, results]);
  const pageCount = Math.max(1, Math.ceil(visibleResults.length / RESULTS_PER_PAGE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageResults = visibleResults.slice(currentPage * RESULTS_PER_PAGE, (currentPage + 1) * RESULTS_PER_PAGE);
  const partialSources = summary?.sources.some((source) => source.status !== "success") || false;
  const incomplete = partialSources || summary?.truncated;
  const statusLabel = state === "running" ? progress.phase === "discovering" ? "发现中" : "响应验证中"
    : state === "stopping" ? "停止中" : state === "stopped" ? "已停止" : state === "error" ? "扫描失败"
      : state === "complete" ? incomplete ? "扫描完成 · 数据不完整" : "扫描完成" : "编辑中";

  function changeInput(field: InputField, value: string) {
    if (busy) return;
    ({ target: setTarget, concurrency: setConcurrency, timeout: setTimeoutValue })[field](value);
    if (inputError?.field === field) setInputError(null);
  }

  function formatTarget() {
    if (busy) return;
    try {
      setTarget(normalizeWebsiteUrl(target));
      if (inputError?.field === "target") setInputError(null);
    } catch { /* Keep incomplete input available for editing and validation. */ }
  }

  function pasteTarget(event: ClipboardEvent<HTMLInputElement>) {
    if (busy) return;
    try {
      const normalized = normalizeWebsiteUrl(event.clipboardData.getData("text"));
      event.preventDefault();
      changeInput("target", normalized);
    } catch { /* Let the browser paste incomplete input for editing. */ }
  }

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (jobRef.current) return;
    let field: InputField = "target";
    let normalized: string;
    let parallel: number;
    let timeoutMs: number;
    try {
      normalized = normalizeWebsiteUrl(target);
      setTarget(normalized);
      field = "concurrency";
      parallel = Number(concurrency);
      if (!Number.isInteger(parallel) || parallel < 1 || parallel > 8) throw new Error("并发数需要是 1–8 的整数");
      field = "timeout";
      const seconds = Number(timeout);
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 10) throw new Error("超时需要是 1–10 秒的整数");
      timeoutMs = seconds * 1000;
    } catch (error) {
      setInputError({ field, message: error instanceof Error ? error.message : "请检查扫描配置" });
      inputRefs.current[field]?.focus();
      return;
    }
    const job = { controller: new AbortController() };
    jobRef.current = job;
    setInputError(null);
    setScanError("");
    setResults([]);
    setSources({});
    setSummary(null);
    setRoundTarget(normalized);
    setProgress({ phase: "discovering", completed: 0, total: 0, discovered: 0 });
    setFilter("all");
    setHttpStatus("all");
    setQuery("");
    setPage(0);
    setState("running");
    const current = () => jobRef.current === job && !job.controller.signal.aborted;
    try {
      const completed = await discoverWebsitePaths({
        baseUrl: normalized, concurrency: parallel, timeoutMs, signal: job.controller.signal,
        onSource: (source) => { if (current()) setSources((previous) => ({ ...previous, [source.source]: source })); },
        onResult: (result) => {
          if (!current()) return;
          setResults((previous) => {
            const index = previous.findIndex((item) => item.url === result.url);
            return index < 0 ? [...previous, result] : previous.map((item, row) => row === index ? result : item);
          });
        },
        onProgress: (next) => { if (current()) setProgress({ ...next, completed: Math.min(next.total, Math.max(0, next.completed)) }); }
      });
      if (current()) {
        setSummary(completed);
        setSources(Object.fromEntries(completed.sources.map((source) => [source.source, source])));
        setProgress({ phase: "validating", completed: completed.validated, total: completed.validated, discovered: completed.discovered });
        setState("complete");
      }
    } catch (error) {
      if (current()) {
        setScanError(error instanceof Error ? error.message : "路径发现失败，请重试");
        setState("error");
      }
    } finally {
      if (jobRef.current === job) {
        jobRef.current = null;
        if (job.controller.signal.aborted) setState("stopped");
      }
    }
  }

  function stop() {
    if (!jobRef.current || jobRef.current.controller.signal.aborted) return;
    jobRef.current.controller.abort();
    setState("stopping");
  }

  const pageStatus: WorkbenchStatus = busy ? "running" : state === "error" ? "error" : state === "complete" ? "success" : "editing";
  const inputProps = (field: InputField) => ({
    "aria-invalid": inputError?.field === field || undefined,
    "aria-describedby": inputError?.field === field ? `${toolId}-input-error` : undefined,
    disabled: busy
  });
  const progressLabel = progress.phase === "discovering" ? "路径发现进度" : "路径响应验证进度";
  const progressText = progress.phase === "discovering" ? `已处理 ${progress.completed} / ${progress.total} 个发现请求` : `已验证 ${progress.completed} / ${progress.total} 项`;

  return <ToolPageLayout className="network-scan-workbench" currentToolId={toolId} status={pageStatus} statusLabel={statusLabel} title="网站路径扫描">
    <form noValidate onSubmit={(event) => { void start(event); }}>
      <WorkbenchPanel title={<span className="network-scan-label">自动路径发现<HelpTooltip label="自动路径发现">从同源页面链接、脚本中的路径线索、robots.txt、Sitemap 和 Wayback 历史记录自动发现路径，去重后验证 HTTP 响应。CSS、JavaScript、图片等静态文件不进入结果或导出，脚本和 Sitemap 仍用于提取路径线索。发现阶段最多 90 秒，每轮最多验证 2,000 个路径，最多读取 100 个页面、40 个脚本、20 个 Sitemap，抓取深度最多 3 层；范围为当前网站，包含入口目录之外的同源路径。站点请求使用下方所设的超时，历史记录查询最长 20 秒。去除查询参数与片段，不执行 JavaScript、不登录，可能遗漏动态路由和未公开引用的路径。只扫描你有权测试的公网网站。请求使用 GET，单次请求不自动跟随跳转；同源跳转地址作为线索单独读取和验证，跨源跳转不跟随。响应验证最多分析前 64 KiB，响应大小为 Content-Length 声明值。</HelpTooltip></span>} footer={<div className="network-scan-actions">
        <span className="network-scan-note">{busy ? state === "stopping" ? "正在结束本轮请求…" : progress.phase === "discovering" ? "正在自动发现网站路径…" : "正在验证已发现路径…" : "自动发现同源路径，无需提供字典"}</span>
        <div>{busy ? <Button disabled={state === "stopping"} onClick={stop} type="button" variant="outline">{state === "stopping" ? "停止中…" : "停止扫描"}</Button> : <Button type="submit">{roundTarget ? "重新扫描" : "开始扫描"}</Button>}</div>
      </div>}>
        <div className="network-scan-fields">
          <div className="network-scan-field"><div className="network-scan-label"><Label htmlFor={`${toolId}-target`}>网站地址</Label><HelpTooltip label="网站地址输入">可粘贴完整网址或包含网址的文本，粘贴时自动提取网站地址；手动输入会在离开输入框或开始扫描时提取。保留入口路径并去掉查询参数与片段，多个网址取第一个。</HelpTooltip></div><Input {...inputProps("target")} autoCapitalize="none" autoComplete="off" id={`${toolId}-target`} onBlur={formatTarget} onChange={(event) => changeInput("target", event.target.value)} onPaste={pasteTarget} placeholder="粘贴网址，自动提取网站地址" ref={(element) => { inputRefs.current.target = element; }} spellCheck={false} value={target} /></div>
          <div className="network-scan-options">
            <div className="network-scan-field"><Label htmlFor={`${toolId}-concurrency`}>响应验证并发数</Label><Input {...inputProps("concurrency")} id={`${toolId}-concurrency`} max={8} min={1} onChange={(event) => changeInput("concurrency", event.target.value)} ref={(element) => { inputRefs.current.concurrency = element; }} step={1} type="number" value={concurrency} /></div>
            <div className="network-scan-field"><Label htmlFor={`${toolId}-timeout`}>站点请求超时（秒）</Label><Input {...inputProps("timeout")} id={`${toolId}-timeout`} max={10} min={1} onChange={(event) => changeInput("timeout", event.target.value)} ref={(element) => { inputRefs.current.timeout = element; }} step={1} type="number" value={timeout} /></div>
          </div>
          {inputError ? <p className="network-scan-error" id={`${toolId}-input-error`} role="alert">{inputError.message}</p> : null}
        </div>
      </WorkbenchPanel>
    </form>
    <WorkbenchPanel actions={<Button disabled={!results.length} onClick={() => downloadScanCsv(`website-path-discovery-${new Date().toISOString().slice(0, 10)}.csv`, exportDiscoveredWebsitePathsCsv(results))} size="sm" type="button" variant="outline">导出 CSV</Button>} summary={roundTarget ? `本轮目标：${roundTarget}` : undefined} title="发现结果">
      <div className="network-scan-results">
        <div aria-label="路径发现来源" className="website-path-discovery-sources" role="list">{PATH_DISCOVERY_SOURCES.map((source) => {
          const result = sources[source.id];
          const status = sourceStatusLabel(result, state);
          return <span className="website-path-discovery-source" data-source-status={result?.status} key={source.id} role="listitem"><Badge variant="outline">{source.label} · {result && result.status !== "error" ? `${new Set(result.urls).size.toLocaleString()}${result.status === "partial" ? "（部分）" : ""}` : status}</Badge><HelpTooltip label={`${source.label} 的发现状态`}><strong>{source.label} · {status}</strong>{result?.message ? <p>{result.message}</p> : null}{result && result.status !== "error" ? <p>发现 {new Set(result.urls).size.toLocaleString()} 个同源路径</p> : null}</HelpTooltip></span>;
        })}</div>
        {roundTarget ? <div className="network-scan-progress"><ExecutionProgress current={progress.completed} label={progressLabel} total={progress.total} /><p aria-live="polite" className="network-scan-note" role="status">{statusLabel} · {progressText} · 发现 {progress.discovered.toLocaleString()} 个路径</p></div> : null}
        {scanError ? <p className="network-scan-error" role="alert">{scanError}</p> : null}
        {state === "complete" && incomplete ? <p className="network-scan-note website-path-discovery-partial">{summary?.truncated ? "已达到本轮发现上限，仅验证已保留的路径。" : ""}{partialSources ? "部分来源受限或未完整返回，详情见来源说明。" : ""}本轮结果可能不完整。</p> : null}
        <WorkbenchSummary items={[{ label: "已发现", value: progress.discovered.toLocaleString() }, { label: "有响应", value: counts.found }, { label: <span className="network-scan-label">疑似软 404<HelpTooltip label="疑似软 404">与随机不存在路径的响应相似，可能是统一页面，不能据此确认该路径仍存在。随机对比请求不计入结果进度及导出。</HelpTooltip></span>, value: counts.suspected }, { label: "未找到", value: counts.missing }, { label: "请求错误", value: counts.error }]} />
        <div className="network-scan-result-controls"><Tabs onValueChange={(value) => { setFilter(value as ResultFilter); setHttpStatus("all"); setPage(0); }} value={filter}><TabsList aria-label="筛选扫描结果"><TabsTrigger value="all">全部</TabsTrigger><TabsTrigger value="found">有响应</TabsTrigger><TabsTrigger value="suspected">疑似软 404</TabsTrigger><TabsTrigger value="missing">未找到</TabsTrigger><TabsTrigger value="error">请求错误</TabsTrigger></TabsList></Tabs><Input aria-label="搜索扫描结果" onChange={(event) => { setQuery(event.target.value); setPage(0); }} placeholder="搜索路径、标题、状态码或来源" type="search" value={query} /></div>
        {filter === "found" ? <div aria-label="HTTP状态码筛选" className="website-path-status-filter" role="group">
          <span className="network-scan-note">状态码</span>
          <Button aria-pressed={httpStatus === "all"} onClick={() => { setHttpStatus("all"); setPage(0); }} size="sm" type="button" variant={httpStatus === "all" ? "default" : "outline"}>全部状态 · {counts.found.toLocaleString()}</Button>
          {httpStatusCounts.map(([code, count]) => <Button aria-pressed={httpStatus === code} key={code} onClick={() => { setHttpStatus(code); setPage(0); }} size="sm" type="button" variant={httpStatus === code ? "default" : "outline"}>{code} · {count.toLocaleString()}</Button>)}
        </div> : null}
        <p className="network-scan-note">匹配 {visibleResults.length.toLocaleString()} / {results.length.toLocaleString()} 条 · CSV 导出本轮全部已验证结果</p>
        {visibleResults.length ? <ScanResultTable results={pageResults} /> : <div className="network-scan-empty">{results.length ? "暂无匹配结果" : busy ? progress.phase === "discovering" ? "正在自动发现路径，随后验证响应…" : "等待响应验证结果…" : state === "complete" ? incomplete ? "本轮未返回验证结果，部分来源未完整读取，请查看来源说明" : "本轮未发现可验证路径，不能据此确认网站没有其他路径" : state === "stopped" ? "扫描已停止，暂无验证结果" : "开始扫描后在这里查看发现结果"}</div>}
        {pageCount > 1 ? <nav aria-label="路径结果分页" className="website-path-discovery-pagination"><span className="network-scan-note">第 {currentPage + 1} / {pageCount} 页 · 每页 {RESULTS_PER_PAGE} 条</span><Button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} size="sm" type="button" variant="outline">上一页</Button><Button disabled={currentPage === pageCount - 1} onClick={() => setPage(currentPage + 1)} size="sm" type="button" variant="outline">下一页</Button></nav> : null}
      </div>
    </WorkbenchPanel>
  </ToolPageLayout>;
}
