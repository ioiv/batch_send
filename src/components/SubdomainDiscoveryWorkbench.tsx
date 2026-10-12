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
import { downloadScanCsv, normalizeDomain } from "../lib/network-scan";
import {
  SUBDOMAIN_DISCOVERY_SOURCES,
  discoverSubdomains,
  exportDiscoveredSubdomainsCsv,
  type DiscoveredSubdomainResult,
  type SubdomainDiscoveryProgress,
  type SubdomainDiscoverySourceResult,
  type SubdomainDiscoverySummary
} from "../lib/subdomain-discovery";
import "./network-scan.css";

type DiscoveryState = "editing" | "running" | "stopping" | "stopped" | "complete" | "error";
type ResultFilter = "all" | "resolved" | "wildcard" | "unresolved" | "error";
type InputField = "domain" | "concurrency" | "timeout";
type SourceId = SubdomainDiscoverySourceResult["source"];
type DiscoveryJob = { controller: AbortController };
const RESULTS_PER_PAGE = 100;

function resultGroup(result: DiscoveredSubdomainResult): Exclude<ResultFilter, "all"> {
  if (result.status === "error") return "error";
  if (result.status === "not-found") return "unresolved";
  return result.wildcard ? "wildcard" : "resolved";
}

const resultLabels: Record<Exclude<ResultFilter, "all">, string> = {
  resolved: "当前已解析", wildcard: "疑似通配解析", unresolved: "当前未解析", error: "验证错误"
};

function sourceLabel(source: SourceId) {
  return SUBDOMAIN_DISCOVERY_SOURCES.find((item) => item.id === source)?.label || source;
}

const shortSourceLabels: Record<SourceId, string> = {
  crtsh: "crt.sh", certspotter: "CertSpotter", hackertarget: "HackerTarget", dns: "DNS", website: "网页", wayback: "Wayback"
};

function DiscoverySources({ result }: { result: DiscoveredSubdomainResult }) {
  if (!result.sources.length) return <>—</>;
  return <span className="subdomain-discovery-compact-cell">
    <span>{shortSourceLabels[result.sources[0]]}{result.sources.length > 1 ? ` +${result.sources.length - 1}` : ""}</span>
    <HelpTooltip label={`${result.domain} 的发现来源`}><ul>{result.sources.map(source => <li key={source}>{sourceLabel(source)}</li>)}</ul></HelpTooltip>
  </span>;
}

function DiscoveryDetails({ result }: { result: DiscoveredSubdomainResult }) {
  const group = resultGroup(result);
  const message = result.message || (group === "unresolved" ? "公开来源曾记录该域名，当前未查到 DNS 记录" : group === "wildcard" ? "与随机子域名解析相似，请进一步核对" : "");
  if (!result.addresses.length && !result.cname && !message) return <>—</>;
  return <span className="subdomain-discovery-compact-cell">
    <span>{result.addresses.length ? `${result.addresses.length} 个地址` : result.cname ? "CNAME" : "查看"}</span>
    <HelpTooltip label={`${result.domain} 的解析详情`}>
      {result.addresses.length ? <div><strong>解析地址</strong><ul>{result.addresses.map(address => <li className="network-scan-address" key={address}>{address}</li>)}</ul></div> : null}
      {result.cname ? <div><strong>CNAME</strong><p className="network-scan-address">{result.cname}</p></div> : null}
      {message ? <p>{message}</p> : null}
    </HelpTooltip>
  </span>;
}

function sourceStatusLabel(result: SubdomainDiscoverySourceResult | undefined, state: DiscoveryState) {
  if (result) return result.status === "success" ? "已读取" : result.status === "partial" ? "部分结果" : "不可用";
  return state === "editing" ? "待开始" : state === "stopped" || state === "stopping" ? "未完成" : state === "running" ? "读取中" : "未返回";
}

function DiscoveryResultTable({ results }: { results: DiscoveredSubdomainResult[] }) {
  return <div className="network-scan-table subdomain-discovery-table"><Table aria-label="子域名发现结果">
    <TableHeader><TableRow><TableHead>子域名</TableHead><TableHead>当前 DNS 状态</TableHead><TableHead>发现来源</TableHead><TableHead>解析详情</TableHead></TableRow></TableHeader>
    <TableBody>{results.map((result) => {
      const group = resultGroup(result);
      return <TableRow data-scan-status={group === "wildcard" ? "suspected" : group === "resolved" ? "found" : group === "unresolved" ? "missing" : "error"} key={result.domain}>
        <TableCell className="network-scan-result__target">{result.status === "resolved" ? <a className="network-scan-link" href={`https://${result.domain}`} rel="noopener noreferrer" target="_blank">{result.domain}</a> : <span className="network-scan-address">{result.domain}</span>}</TableCell>
        <TableCell className="network-scan-result__status"><Badge variant="outline">{resultLabels[group]}</Badge></TableCell>
        <TableCell className="network-scan-result__detail" data-label="发现来源"><DiscoverySources result={result} /></TableCell>
        <TableCell className="network-scan-result__detail" data-label="解析详情"><DiscoveryDetails result={result} /></TableCell>
      </TableRow>;
    })}</TableBody>
  </Table></div>;
}

export function SubdomainDiscoveryWorkbench() {
  const [domain, setDomain] = useState("");
  const [concurrency, setConcurrency] = useState("4");
  const [timeout, setTimeoutValue] = useState("5");
  const [state, setState] = useState<DiscoveryState>("editing");
  const [inputError, setInputError] = useState<{ field: InputField; message: string } | null>(null);
  const [scanError, setScanError] = useState("");
  const [roundDomain, setRoundDomain] = useState("");
  const [sources, setSources] = useState<Partial<Record<SourceId, SubdomainDiscoverySourceResult>>>({});
  const [results, setResults] = useState<DiscoveredSubdomainResult[]>([]);
  const [summary, setSummary] = useState<SubdomainDiscoverySummary | null>(null);
  const [progress, setProgress] = useState<SubdomainDiscoveryProgress>({ phase: "discovering", completed: 0, total: SUBDOMAIN_DISCOVERY_SOURCES.length, discovered: 0 });
  const [filter, setFilter] = useState<ResultFilter>("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const jobRef = useRef<DiscoveryJob | null>(null);
  const inputRefs = useRef<Partial<Record<InputField, HTMLInputElement | null>>>({});
  const busy = state === "running" || state === "stopping";

  useEffect(() => () => {
    jobRef.current?.controller.abort();
    jobRef.current = null;
  }, []);

  const counts = useMemo(() => {
    const value = { resolved: 0, wildcard: 0, unresolved: 0, error: 0 };
    results.forEach((result) => { value[resultGroup(result)] += 1; });
    return value;
  }, [results]);
  const visibleResults = useMemo(() => {
    const search = query.trim().toLowerCase();
    return results.filter((result) => (filter === "all" || resultGroup(result) === filter)
      && (!search || [result.domain, result.addresses.join(" "), result.cname, result.message, resultLabels[resultGroup(result)], result.sources.map(sourceLabel).join(" ")].join(" ").toLowerCase().includes(search)));
  }, [filter, query, results]);
  const pageCount = Math.max(1, Math.ceil(visibleResults.length / RESULTS_PER_PAGE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageResults = visibleResults.slice(currentPage * RESULTS_PER_PAGE, (currentPage + 1) * RESULTS_PER_PAGE);
  const partialSources = summary?.sources.some((source) => source.status !== "success") || false;
  const statusLabel = state === "running" ? progress.phase === "discovering" ? "发现中" : "DNS 验证中"
    : state === "stopping" ? "停止中" : state === "stopped" ? "已停止" : state === "error" ? "扫描失败"
      : state === "complete" ? partialSources || summary?.truncated ? "扫描完成 · 数据不完整" : "扫描完成" : "编辑中";
  const pageStatus: WorkbenchStatus = busy ? "running" : state === "error" ? "error" : state === "complete" ? "success" : "editing";

  function changeInput(field: InputField, value: string) {
    if (busy) return;
    ({ domain: setDomain, concurrency: setConcurrency, timeout: setTimeoutValue })[field](value);
    if (inputError?.field === field) setInputError(null);
  }

  function formatDomain() {
    if (busy) return;
    try {
      setDomain(normalizeDomain(domain));
      if (inputError?.field === "domain") setInputError(null);
    } catch { /* Keep incomplete input available for editing and validation. */ }
  }

  function pasteDomain(event: ClipboardEvent<HTMLInputElement>) {
    if (busy) return;
    try {
      const normalized = normalizeDomain(event.clipboardData.getData("text"));
      event.preventDefault();
      changeInput("domain", normalized);
    } catch { /* Let the browser paste incomplete input for editing. */ }
  }

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (jobRef.current) return;
    let field: InputField = "domain";
    let normalized: string;
    let parallel: number;
    let timeoutMs: number;
    try {
      normalized = normalizeDomain(domain);
      setDomain(normalized);
      field = "concurrency";
      parallel = Number(concurrency);
      if (!Number.isInteger(parallel) || parallel < 1 || parallel > 8) throw new Error("并发数需要是 1–8 的整数");
      field = "timeout";
      const seconds = Number(timeout);
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 10) throw new Error("DNS 超时需要是 1–10 秒的整数");
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
    setRoundDomain(normalized);
    setProgress({ phase: "discovering", completed: 0, total: SUBDOMAIN_DISCOVERY_SOURCES.length, discovered: 0 });
    setFilter("all");
    setQuery("");
    setPage(0);
    setState("running");
    const current = () => jobRef.current === job && !job.controller.signal.aborted;
    try {
      const completed = await discoverSubdomains({
        domain: normalized, concurrency: parallel, timeoutMs, signal: job.controller.signal,
        onSource: (source) => {
          if (current()) setSources((previous) => ({ ...previous, [source.source]: source }));
        },
        onResult: (result) => {
          if (!current()) return;
          setResults((previous) => {
            const index = previous.findIndex((item) => item.domain === result.domain);
            return index < 0 ? [...previous, result] : previous.map((item, row) => row === index ? result : item);
          });
        },
        onProgress: (next) => {
          if (current()) setProgress({ ...next, completed: Math.min(next.total, Math.max(0, next.completed)) });
        }
      });
      if (current()) {
        setSummary(completed);
        setSources(Object.fromEntries(completed.sources.map((source) => [source.source, source])));
        setProgress({ phase: "validating", completed: completed.validated, total: completed.validated, discovered: completed.discovered });
        setState("complete");
      }
    } catch (error) {
      if (current()) {
        setScanError(error instanceof Error ? error.message : "子域名发现失败，请重试");
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

  const inputProps = (field: InputField) => ({
    "aria-invalid": inputError?.field === field || undefined,
    "aria-describedby": inputError?.field === field ? "subdomain-discovery-input-error" : undefined,
    disabled: busy
  });

  const progressLabel = progress.phase === "discovering" ? "公开来源发现进度" : "DNS 验证进度";
  const progressText = progress.phase === "discovering" ? `已读取 ${progress.completed} / ${progress.total} 个来源` : `已验证 ${progress.completed} / ${progress.total} 项`;

  return <ToolPageLayout className="network-scan-workbench" currentToolId="subdomain-scan" status={pageStatus} statusLabel={statusLabel} title="子域名扫描">
    <form noValidate onSubmit={(event) => { void start(event); }}>
      <WorkbenchPanel title={<span className="network-scan-label">多源子域名发现<HelpTooltip label="多源子域名发现">自动汇总 crt.sh、Cert Spotter 的证书透明度记录、HackerTarget 被动 DNS、主域名的 NS / MX / TXT 记录、网站首页及 robots / sitemap、Wayback 历史记录，再去重并验证当前 DNS。来源请求最多等待 20 秒，DNS 验证每轮最多 5,000 项。公开来源可能有历史记录、遗漏或 API 限制，无法保证发现全部子域名。仅用于你有权测试的公网域名。</HelpTooltip></span>} summary="汇总公开记录，自动发现并验证子域名" footer={<div className="network-scan-actions">
        <span className="network-scan-note">{busy ? state === "stopping" ? "正在结束本轮请求…" : progress.phase === "discovering" ? "正在汇总公开来源…" : `正在验证 ${roundDomain} 的子域名…` : "自动查询 6 个来源，无需提供字典"}</span>
        <div>{busy ? <Button disabled={state === "stopping"} onClick={stop} type="button" variant="outline">{state === "stopping" ? "停止中…" : "停止扫描"}</Button> : <Button type="submit">{roundDomain ? "重新扫描" : "开始扫描"}</Button>}</div>
      </div>}>
        <div className="network-scan-fields">
          <div className="network-scan-field"><div className="network-scan-label"><Label htmlFor="subdomain-discovery-domain">主域名</Label><HelpTooltip label="域名输入">可粘贴完整网址或包含网址的文本，粘贴时自动提取域名；手动输入会在离开输入框或开始扫描时提取。多个网址取第一个。</HelpTooltip></div><Input {...inputProps("domain")} autoCapitalize="none" autoComplete="off" id="subdomain-discovery-domain" onBlur={formatDomain} onChange={(event) => changeInput("domain", event.target.value)} onPaste={pasteDomain} placeholder="域名或完整网址" ref={(element) => { inputRefs.current.domain = element; }} spellCheck={false} value={domain} /></div>
          <div className="network-scan-options">
            <div className="network-scan-field"><Label htmlFor="subdomain-discovery-concurrency">DNS 验证并发数</Label><Input {...inputProps("concurrency")} id="subdomain-discovery-concurrency" max={8} min={1} onChange={(event) => changeInput("concurrency", event.target.value)} ref={(element) => { inputRefs.current.concurrency = element; }} step={1} type="number" value={concurrency} /></div>
            <div className="network-scan-field"><Label htmlFor="subdomain-discovery-timeout">单项 DNS 超时（秒）</Label><Input {...inputProps("timeout")} id="subdomain-discovery-timeout" max={10} min={1} onChange={(event) => changeInput("timeout", event.target.value)} ref={(element) => { inputRefs.current.timeout = element; }} step={1} type="number" value={timeout} /></div>
          </div>
          {inputError ? <p className="network-scan-error" id="subdomain-discovery-input-error" role="alert">{inputError.message}</p> : null}
        </div>
      </WorkbenchPanel>
    </form>
    <WorkbenchPanel summary={roundDomain ? `本轮目标：${roundDomain}` : "各来源独立读取，自动合并重复记录"} title="发现来源">
      <div aria-label="公开发现来源" className="subdomain-discovery-sources" role="list">{SUBDOMAIN_DISCOVERY_SOURCES.map((source) => {
        const result = sources[source.id];
        return <div className="subdomain-discovery-source" data-source-status={result?.status} key={source.id} role="listitem">
          <div className="subdomain-discovery-source__heading"><strong>{source.label}</strong><Badge variant="outline">{sourceStatusLabel(result, state)}</Badge></div>
          {result ? <p className="network-scan-note">{result.status === "error" ? "来源读取失败" : `发现 ${new Set(result.domains).size.toLocaleString()} 项`}</p> : null}
          {result?.message ? <p className="network-scan-note">{result.message}</p> : null}
        </div>;
      })}</div>
      {roundDomain ? <div className="network-scan-progress"><ExecutionProgress current={progress.completed} label={progressLabel} total={progress.total} /><p aria-live="polite" className="network-scan-note" role="status">{statusLabel} · {progressText} · 发现 {progress.discovered.toLocaleString()} 个子域名</p></div> : null}
      {scanError ? <p className="network-scan-error" role="alert">{scanError}</p> : null}
      {summary?.truncated ? <p className="network-scan-note subdomain-discovery-partial">发现数量超过验证上限，本轮仅验证前 5,000 个子域名。</p> : null}
      {state === "complete" && partialSources ? <p className="network-scan-note subdomain-discovery-partial">部分来源不可用或仅返回部分记录；本轮结果可能不完整，详情见各来源状态。</p> : null}
    </WorkbenchPanel>
    <WorkbenchPanel actions={<Button disabled={!results.length} onClick={() => downloadScanCsv(`subdomain-discovery-${new Date().toISOString().slice(0, 10)}.csv`, exportDiscoveredSubdomainsCsv(results))} size="sm" type="button" variant="outline">导出 CSV</Button>} title="子域名结果">
      <div className="network-scan-results">
        <WorkbenchSummary items={[
          { label: "已发现", value: progress.discovered.toLocaleString() },
          { label: "当前已解析", value: counts.resolved.toLocaleString() },
          { label: <span className="network-scan-label">疑似通配解析<HelpTooltip label="疑似通配解析">解析结果与随机子域名相似，可能是通配 DNS。公开记录和解析响应不能单独确认它仍提供独立网站。</HelpTooltip></span>, value: counts.wildcard.toLocaleString() },
          { label: "当前未解析", value: counts.unresolved.toLocaleString() },
          { label: "验证错误", value: counts.error.toLocaleString() }
        ]} />
        <div className="network-scan-result-controls"><Tabs onValueChange={(value) => { setFilter(value as ResultFilter); setPage(0); }} value={filter}><TabsList aria-label="筛选子域名发现结果"><TabsTrigger value="all">全部</TabsTrigger><TabsTrigger value="resolved">当前已解析</TabsTrigger><TabsTrigger value="wildcard">疑似通配</TabsTrigger><TabsTrigger value="unresolved">当前未解析</TabsTrigger><TabsTrigger value="error">验证错误</TabsTrigger></TabsList></Tabs><Input aria-label="搜索子域名发现结果" onChange={(event) => { setQuery(event.target.value); setPage(0); }} placeholder="搜索域名、IP、CNAME 或来源" type="search" value={query} /></div>
        <p className="network-scan-note">显示 {visibleResults.length.toLocaleString()} / {results.length.toLocaleString()} 条 · CSV 导出本轮全部已验证结果</p>
        {visibleResults.length ? <DiscoveryResultTable results={pageResults} /> : <div className="network-scan-empty">{results.length ? "暂无匹配结果" : busy ? progress.phase === "discovering" ? "正在发现子域名，随后验证当前 DNS…" : "等待 DNS 验证结果…" : state === "complete" ? partialSources ? "本轮未发现可验证子域名，公开来源未完整返回，请查看来源状态" : "公开来源本轮未发现子域名，不能据此确认没有子域名" : state === "stopped" ? "扫描已停止，暂无验证结果" : "开始扫描后在这里查看发现结果"}</div>}
        {pageCount > 1 ? <nav aria-label="子域名结果分页" className="subdomain-discovery-pagination"><span className="network-scan-note">第 {currentPage + 1} / {pageCount} 页 · 每页 {RESULTS_PER_PAGE} 条</span><Button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} size="sm" type="button" variant="outline">上一页</Button><Button disabled={currentPage === pageCount - 1} onClick={() => setPage(currentPage + 1)} size="sm" type="button" variant="outline">下一页</Button></nav> : null}
      </div>
    </WorkbenchPanel>
  </ToolPageLayout>;
}
