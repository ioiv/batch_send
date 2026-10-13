import { normalizeDomain } from "./network-scan";

export const MAX_SUBDOMAIN_SUPPLEMENT_DOMAINS = 5000;
export const MAX_SUBDOMAIN_SUPPLEMENT_CHARACTERS = 2 * 1024 * 1024;

export interface SubdomainSupplementResult {
  domains: string[];
  duplicates: number;
  issueCount: number;
  issues: { line: number; message: string }[];
  truncated: boolean;
}

const headers = new Set(["domain", "domains", "subdomain", "subdomains", "host", "hostname", "hostnames", "url", "urls", "ip", "ipaddress", "address", "name", "status", "source", "ports", "子域名", "域名", "网址", "名称", "状态", "来源", "备注", "序号"]);

function isHeader(value: string) {
  const cells = value.split(/[,\t;|]/u).map(cell => cell.trim().replace(/^["']|["']$/gu, "").toLowerCase().replace(/[\s_-]/gu, ""));
  return cells.some(Boolean) && cells.every(cell => !cell || headers.has(cell));
}

/** Extract names from pasted reports locally; only concrete, scoped hostnames leave this parser. */
export function parseSubdomainSupplement(text: string, domainInput: string): SubdomainSupplementResult {
  const result: SubdomainSupplementResult = { domains: [], duplicates: 0, issueCount: 0, issues: [], truncated: false };
  const issue = (line: number, message: string) => {
    result.issueCount += 1;
    if (result.issues.length < 20) result.issues.push({ line, message });
  };
  if (!text.trim()) return result;
  if (text.length > MAX_SUBDOMAIN_SUPPLEMENT_CHARACTERS) {
    issue(1, "补充内容不能超过 2 MB，请分批粘贴。");
    return result;
  }
  let root: string;
  try { root = normalizeDomain(domainInput); }
  catch { issue(1, "请先填写有效的主域名，再解析外部结果。"); return result; }
  const seen = new Set<string>();
  const include = (value: string, line: number) => {
    if (value.includes("*")) { issue(line, "通配名称不能作为具体子域名补充。"); return; }
    let domain: string;
    try { domain = normalizeDomain(value); }
    catch { issue(line, "域名或网址格式无效。"); return; }
    if (domain === root) { issue(line, "主域名本身不计入子域名补充。"); return; }
    if (!domain.endsWith(`.${root}`)) { issue(line, "名称不属于当前主域名，已跳过。"); return; }
    if (seen.has(domain)) { result.duplicates += 1; return; }
    seen.add(domain);
    if (result.domains.length === MAX_SUBDOMAIN_SUPPLEMENT_DOMAINS) {
      if (!result.truncated) issue(line, "最多补充 5,000 个子域名，已保留前 5,000 个。");
      else result.issueCount += 1;
      result.truncated = true;
      return;
    }
    result.domains.push(domain);
  };
  const lines = text.replace(/^\uFEFF/u, "").split(/\r\n?|\n/u);
  for (const [index, raw] of lines.entries()) {
    const line = index + 1;
    const value = raw.trim();
    if (!value || value.startsWith("#") || isHeader(value)) continue;
    let matched = false;
    const entries: { position: number; domain?: string; message?: string }[] = [];
    // Mask entire URLs so an out-of-scope URL cannot supply a candidate through
    // its path/query, and a URL's hostname is not counted again as a bare name.
    const readUrl = (urlText: string, position: number) => {
      matched = true;
      try {
        const url = new URL(urlText.startsWith("//") ? `https:${urlText}` : /^[a-z][a-z0-9+.-]*:\/\//iu.test(urlText) ? urlText : `https://${urlText}`);
        if (!/^https?:$/u.test(url.protocol) || url.username || url.password) entries.push({ position, message: "仅支持不含账号信息的 HTTP / HTTPS 网址。" });
        else entries.push({ position, domain: url.hostname });
      } catch { entries.push({ position, message: "域名或网址格式无效。" }); }
      return " ".repeat(urlText.length);
    };
    const remaining = value.replace(/(?:[a-z][a-z0-9+.-]*:\/\/|\/\/)[^\s,;|<>"'`]+/giu, readUrl)
      .replace(/(?<![\p{L}\p{N}_.@*\/-])(?:\*\.)?[\p{L}\p{N}_-]+(?:[.\u3002\uff0e\uff61][\p{L}\p{N}_-]+)+(?::\d+)?[/?#][^\s,;|<>"'`]*/gu, readUrl);
    for (const match of remaining.matchAll(/(?<![\p{L}\p{N}_.@*\/-])(?:\*\.)?[\p{L}\p{N}_-]+(?:[.\u3002\uff0e\uff61][\p{L}\p{N}_-]+)+(?:\.)?(?![\p{L}\p{N}_.@*-])/gu)) {
      if (/^\d+(?:\.\d+){3}\.?$/u.test(match[0])) continue;
      matched = true;
      entries.push({ position: match.index, domain: match[0] });
    }
    entries.sort((first, second) => first.position - second.position).forEach(entry => {
      if (entry.message) issue(line, entry.message);
      else include(entry.domain!, line);
    });
    if (!matched) issue(line, "未识别到域名或网址，请粘贴具体子域名或结果表格。");
  }
  return result;
}
