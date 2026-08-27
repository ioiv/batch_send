import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";
import { Metric } from "@/components/Metric";
import {
  downloadCollectionResults,
  filterCollectionResults,
  getCollectionResultCounts,
  shortenTransactionHash,
  type CollectionDisplayResult,
  type CollectionResultFilter,
  type CollectionResultStatus
} from "@/lib/collection-results";

const statusLabels: Record<CollectionResultStatus, string> = {
  confirming: "确认中",
  error: "失败",
  pending: "待处理",
  scanning: "读取中",
  skipped: "已跳过",
  submitting: "提交中",
  success: "已完成"
};

const filterOptions: Array<{ label: string; value: CollectionResultFilter }> = [
  { label: "全部", value: "all" },
  { label: "处理中", value: "active" },
  { label: "完成", value: "success" },
  { label: "跳过", value: "skipped" },
  { label: "失败", value: "error" }
];

type IndexedCollectionResult = {
  originalIndex: number;
  result: CollectionDisplayResult;
};

export function getCollectionResultSetIdentity(results: CollectionDisplayResult[]) {
  return JSON.stringify(results.map((result) => [result.address, result.asset, result.label || ""]));
}

export function getIndexedCollectionResults(
  results: CollectionDisplayResult[],
  filter: CollectionResultFilter,
  query: string
): IndexedCollectionResult[] {
  const matchingResults = new Set(filterCollectionResults(results, { query, status: filter }));
  return results.flatMap((result, originalIndex) => (
    matchingResults.has(result) ? [{ originalIndex, result }] : []
  ));
}

export function getCollectionResultSourceCount(results: CollectionDisplayResult[]) {
  return new Set(
    results
      .map((result) => result.address.trim().toLowerCase())
      .filter((address) => Boolean(address) && address !== "—")
  ).size;
}

function CollectionResultsBody({ results }: { results: CollectionDisplayResult[] }) {
  const [filter, setFilter] = useState<CollectionResultFilter>("all");
  const [query, setQuery] = useState("");
  const counts = getCollectionResultCounts(results);
  const sourceCount = getCollectionResultSourceCount(results);
  const hasActiveResults = counts.active > 0;
  const previousHasActiveResultsRef = useRef(hasActiveResults);
  const filteredResults = useMemo(
    () => getIndexedCollectionResults(results, filter, query),
    [filter, query, results]
  );

  useEffect(() => {
    if (!previousHasActiveResultsRef.current && hasActiveResults) {
      setFilter("all");
      setQuery("");
    }
    previousHasActiveResultsRef.current = hasActiveResults;
  }, [hasActiveResults]);

  return (
    <div className="collection-results-body">
      <div className="metric-grid" aria-label="归集执行统计">
        <Metric label="资产项" value={String(counts.total)} />
        <Metric label="来源钱包" value={String(sourceCount)} />
        <Metric label="完成" value={String(counts.success)} />
        <Metric label="跳过" value={String(counts.skipped)} />
        <Metric label="失败" value={String(counts.error)} />
      </div>

      <div className="collection-result-toolbar">
        <Tabs onValueChange={(value) => setFilter(value as CollectionResultFilter)} value={filter}>
          <TabsList aria-label="筛选执行结果">
            {filterOptions.map((option) => (
              <TabsTrigger key={option.value} value={option.value}>{option.label}</TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Input
          aria-label="搜索执行结果"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索地址、备注或资产"
          type="search"
          value={query}
        />
      </div>

      {filteredResults.length ? (
        <ScrollArea className="collection-result-table">
          <Table aria-label="归集结果">
            <TableHeader>
              <TableRow>
                <TableHead>来源</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>资产</TableHead>
                <TableHead>数量</TableHead>
                <TableHead>交易</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredResults.map(({ originalIndex, result }) => {
                const resultLabel = result.label || `来源 ${originalIndex + 1}`;
                return (
                  <TableRow data-status={result.status} key={originalIndex}>
                    <TableCell>
                      <strong>{resultLabel}</strong>
                      <code className="collection-result-address">{result.address}</code>
                      <span className="collection-result-message">{result.message}</span>
                    </TableCell>
                    <TableCell>
                      <Badge data-status={result.status} variant={result.status === "error" ? "destructive" : "outline"}>
                        {statusLabels[result.status]}
                      </Badge>
                    </TableCell>
                    <TableCell>{result.asset}</TableCell>
                    <TableCell className="mono">{result.amount || "—"}</TableCell>
                    <TableCell>
                      {result.explorerUrl && result.hash ? (
                        <a
                          aria-label={`查看${resultLabel}的交易`}
                          className={buttonVariants({ variant: "link" })}
                          href={result.explorerUrl}
                          rel="noreferrer"
                          target="_blank"
                          title={result.hash}
                        >{shortenTransactionHash(result.hash)}</a>
                      ) : result.hash ? <code title={result.hash}>{shortenTransactionHash(result.hash)}</code> : "—"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </ScrollArea>
      ) : (
        <Empty className="collection-filter-empty">
          <EmptyHeader><EmptyTitle>无匹配结果</EmptyTitle></EmptyHeader>
          <EmptyContent>
            <Button onClick={() => { setFilter("all"); setQuery(""); }} type="button" variant="outline">清除筛选</Button>
          </EmptyContent>
        </Empty>
      )}
    </div>
  );
}

export function CollectionResults({
  description = "",
  embedded = false,
  emptyMessage = "预检结果会显示在这里。",
  emptyTitle = "等待预检",
  exportFilename,
  results,
  title = "执行结果"
}: {
  description?: string;
  embedded?: boolean;
  emptyMessage?: string;
  emptyTitle?: string;
  exportFilename: string;
  results: CollectionDisplayResult[];
  title?: string;
}) {
  const resultSetIdentity = useMemo(() => getCollectionResultSetIdentity(results), [results]);
  const reviewResults = useMemo(
    () => results.filter((result) => result.status === "error" || result.status === "skipped"),
    [results]
  );
  const reviewExportFilename = exportFilename.replace(/\.csv$/i, "-needs-review.csv");
  const Heading = embedded ? "h3" : "h2";
  const content = (
    <>
      <div className="panel-header collection-results-header">
        <div>
          <Heading className="panel-title" id="collection-results-title">{title}</Heading>
          {description ? <p className="sr-only">{description}</p> : null}
        </div>
        <div className="action-group">
          <Button disabled={!results.length} onClick={() => downloadCollectionResults(results, exportFilename)} type="button" variant="outline">导出全部 CSV</Button>
          <Button disabled={!reviewResults.length} onClick={() => downloadCollectionResults(reviewResults, reviewExportFilename)} type="button" variant="outline">导出失败/跳过项</Button>
        </div>
      </div>

      {results.length ? (
        <CollectionResultsBody key={resultSetIdentity} results={results} />
      ) : (
        <Empty className="collection-empty">
          <EmptyHeader>
            <EmptyTitle>{emptyTitle}</EmptyTitle>
            <EmptyDescription className="sr-only">{emptyMessage}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </>
  );

  if (embedded) {
    return (
      <section aria-labelledby="collection-results-title" className="collection-results is-embedded">
        {content}
      </section>
    );
  }

  return (
    <Card aria-labelledby="collection-results-title" className="collection-results" role="region">
      {content}
    </Card>
  );
}
