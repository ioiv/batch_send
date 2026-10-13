import { fetchPublicDocument, normalizeUrl, type PublicDocumentResult } from "./network-scan.js";
import { createBrotliDecompress, createGunzip, createInflate, constants } from "node:zlib";
import { pathResourceKind } from "../src/lib/website-path-kind.js";

export type WebsitePathDiscoverySource = "links" | "scripts" | "robots" | "sitemap" | "wayback";
export type WebsitePathCandidateKind = "page" | "script" | "sitemap" | "asset" | "probe";
/** Fixed exposure probes are a client-side concern; only these kinds consume document limits. */
type CountedKind = "page" | "script" | "sitemap";
export interface WebsitePathCandidate {
  url: string;
  kind: WebsitePathCandidateKind;
  source: WebsitePathDiscoverySource;
  sources?: WebsitePathDiscoverySource[];
  documentUrl?: string;
  clientRoute?: boolean;
}
export interface WebsitePathDiscoveryResult {
  source: WebsitePathDiscoverySource;
  url: string;
  status: "success" | "partial" | "error";
  candidates: WebsitePathCandidate[];
  ignoredUrls?: string[];
  canonicalUrl?: string;
  message?: string;
}
export interface WebsitePathDiscoveryDependencies {
  fetchDocument(url: string, options: { timeoutMs: number; maxBytes: number; signal?: AbortSignal }): Promise<PublicDocumentResult>;
}
const defaults: WebsitePathDiscoveryDependencies = { fetchDocument: fetchPublicDocument };
export const MAX_PATH_DISCOVERY_CANDIDATES = 2000;
export const MAX_PATH_DISCOVERY_BYTES = 1024 * 1024;
const MAX_ARCHIVE_PAGES = 4;
const SOURCES: WebsitePathDiscoverySource[] = ["links", "scripts", "robots", "sitemap", "wayback"];
class SourceFailure extends Error {}

function decodeEntities(input: string): string {
  return input.replace(/&(?:#(x[0-9a-f]+|[0-9]+)|(amp|lt|gt|quot|apos|sol|colon|num|quest|equals));/gi, (entity, number: string | undefined, name: string | undefined) => {
    if (number) {
      const value = number[0].toLowerCase() === "x" ? Number.parseInt(number.slice(1), 16) : Number.parseInt(number, 10);
      return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : entity;
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", sol: "/", colon: ":", num: "#", quest: "?", equals: "=" } as Record<string, string>)[name!.toLowerCase()] ?? entity;
  });
}

/** Only literal, concrete URLs are useful evidence; dynamic route templates are not requests. */
function concreteValue(value: string): boolean {
  let decoded = value;
  try { decoded = decodeURIComponent(value); } catch { return false; }
  return value.length > 0 && value.length <= 2048 && !/[\u0000-\u0020\u007f\\]/.test(value)
    && !/[\u0000-\u001f\u007f\\{}<>]/.test(decoded) && !/\$\{|(^|\/):[a-z_]/i.test(decoded)
    && !decoded.includes("*") && decoded !== "/&" && !decoded.split("/").some(part => part === ":" || part === "$") && !/^[#?]/.test(value);
}

function pathKind(url: string): WebsitePathCandidateKind {
  return pathResourceKind(url) ?? "page";
}

class CandidateCollector {
  readonly candidates = new Map<string, WebsitePathCandidate>();
  readonly ignoredUrls = new Set<string>();
  ignoredUrlsCapped = false;
  readonly counts = { page: 0, script: 0, sitemap: 0 };
  readonly cappedKinds = new Set<CountedKind>();
  capped = false;
  constructor(readonly origin: string, readonly source: WebsitePathDiscoverySource) {}
  add(value: string, documentUrl: URL, kind?: WebsitePathCandidateKind, ownerDocument?: URL, observedSource = this.source, clientRoute = false): void {
    // Queries and fragments are intentionally not scanned; their templates/tracking must not discard an observed concrete pathname.
    const raw = value.trim().split(/[?#]/, 1)[0];
    if (!concreteValue(raw)) return;
    let url: URL;
    try { url = new URL(raw, documentUrl); } catch { return; }
    if (url.origin !== this.origin || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) return;
    url.search = "";
    url.hash = "";
    try { normalizeUrl(url.href); } catch { return; }
    const candidate: WebsitePathCandidate = { url: url.href, kind: kind === "page" || kind === undefined ? pathKind(url.href) : kind, source: observedSource };
    if (clientRoute && candidate.kind === "page") candidate.clientRoute = true;
    if (candidate.kind === "script" && ownerDocument) {
      if (ownerDocument.origin !== this.origin || ownerDocument.username || ownerDocument.password || ownerDocument.port) candidate.kind = "asset";
      else {
        const owner = new URL(ownerDocument);
        owner.search = "";
        owner.hash = "";
        candidate.documentUrl = owner.href;
      }
    }
    if (candidate.kind === "asset") {
      if (!pathResourceKind(url.href)) {
        if (this.ignoredUrls.size < MAX_PATH_DISCOVERY_CANDIDATES) this.ignoredUrls.add(url.href);
        else if (!this.ignoredUrls.has(url.href)) this.ignoredUrlsCapped = true;
        const previous = this.candidates.get(url.href);
        if (previous) {
          this.counts[previous.kind as "page" | "script" | "sitemap"]--;
          this.candidates.delete(url.href);
        }
      }
      return;
    }
    if (this.ignoredUrls.has(url.href)) return;
    const existing = this.candidates.get(url.href);
    if (existing) {
      if (candidate.clientRoute && existing.kind === "page") existing.clientRoute = true;
      const sources = new Set(existing.sources ?? [existing.source]);
      sources.add(candidate.source);
      if (sources.size > 1) existing.sources = [...sources];
      // Explicit script/sitemap clues should survive a less specific navigation link.
      if (candidate.kind === "sitemap" || (candidate.kind === "script" && existing.kind !== "sitemap")) {
        if (existing.kind !== candidate.kind) {
          const limit = candidate.kind === "script" ? 40 : 20;
          const candidateKind = candidate.kind as CountedKind;
          if (this.counts[candidateKind] >= limit) {
            this.cappedKinds.add(candidateKind);
            this.counts[existing.kind as CountedKind]--;
            this.candidates.delete(url.href);
            return;
          }
          this.counts[existing.kind as CountedKind]--;
          this.counts[candidateKind]++;
        }
        existing.kind = candidate.kind;
        delete existing.clientRoute;
        if (candidate.documentUrl) existing.documentUrl = candidate.documentUrl;
      }
      return;
    }
    const candidateKind = candidate.kind as CountedKind;
    const limit = candidateKind === "page" ? MAX_PATH_DISCOVERY_CANDIDATES : candidateKind === "script" ? 40 : 20;
    if (this.counts[candidateKind] >= limit) { this.cappedKinds.add(candidateKind); if (candidateKind === "page") this.capped = true; return; }
    this.candidates.set(url.href, candidate);
    this.counts[candidateKind]++;
  }
  archive(value: string, current: URL): void {
    let historical: URL;
    try { historical = new URL(value); } catch { return; }
    if (!["http:", "https:"].includes(historical.protocol) || historical.hostname !== current.hostname || historical.port || historical.username || historical.password) return;
    // An archived HTTP path remains useful after a site's move to HTTPS.
    this.add(`${current.origin}${historical.pathname}${historical.search}${historical.hash}`, current);
  }
}

interface Context {
  documentUrl: URL;
  ownerDocument: URL;
  source: WebsitePathDiscoverySource;
  collector: CandidateCollector;
  deadline: number;
  signal: AbortSignal;
  dependencies: WebsitePathDiscoveryDependencies;
  warnings: Set<string>;
  note?: string;
  canonicalUrl?: string;
}

async function readDocument(context: Context, url: URL): Promise<PublicDocumentResult> {
  const remaining = context.deadline - Date.now();
  if (remaining <= 0 || context.signal.aborted) throw new SourceFailure("发现查询超时或已取消");
  let response = await context.dependencies.fetchDocument(url.href, { timeoutMs: remaining, maxBytes: MAX_PATH_DISCOVERY_BYTES, signal: context.signal });
  if ((!response.contentEncoding || response.contentEncoding === "identity") && response.body[0] === 0x1f && response.body[1] === 0x8b) response = { ...response, contentEncoding: "gzip" };
  if (response.contentEncoding && response.contentEncoding.toLowerCase() !== "identity") response = await decodeDocument(context, response);
  if (response.truncated) context.warnings.add("文档达到读取上限，已保留完整线索");
  return response;
}

async function decodeDocument(context: Context, response: PublicDocumentResult): Promise<PublicDocumentResult> {
  const encoding = response.contentEncoding!.toLowerCase().trim();
  const decoder = encoding === "gzip" || encoding === "x-gzip" ? createGunzip({ finishFlush: constants.Z_SYNC_FLUSH })
    : encoding === "deflate" ? createInflate({ finishFlush: constants.Z_SYNC_FLUSH }) : encoding === "br" ? createBrotliDecompress() : undefined;
  if (!decoder) throw new SourceFailure("文档使用暂不支持的压缩格式");
  return new Promise((resolve, reject) => {
    let settled = false;
    let size = 0;
    const chunks: Buffer[] = [];
    const finish = (truncated: boolean) => {
      if (settled) return;
      settled = true;
      context.signal.removeEventListener("abort", onAbort);
      decoder.destroy();
      resolve({ ...response, body: Buffer.concat(chunks, size), truncated: response.truncated || truncated, contentEncoding: "identity" });
    };
    const fail = () => {
      if (settled) return;
      if (response.truncated && size) { finish(true); return; }
      settled = true;
      context.signal.removeEventListener("abort", onAbort);
      decoder.destroy();
      reject(new SourceFailure(context.signal.aborted ? "发现查询超时或已取消" : "压缩文档无法读取"));
    };
    const onAbort = () => fail();
    decoder.on("data", (chunk: Buffer) => {
      if (settled) return;
      const remaining = MAX_PATH_DISCOVERY_BYTES - size;
      if (remaining > 0) { const sampled = chunk.subarray(0, remaining); chunks.push(sampled); size += sampled.length; }
      if (chunk.length >= remaining) finish(true);
    });
    decoder.once("error", fail);
    decoder.once("end", () => finish(false));
    if (context.signal.aborted) { fail(); return; }
    context.signal.addEventListener("abort", onAbort, { once: true });
    decoder.end(response.body);
  });
}

function attributes(tag: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const match of tag.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
    const name = match[1].toLowerCase();
    if (!values.has(name)) values.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""));
  }
  return values;
}

function decodeJsLiteral(literal: string): string | undefined {
  const contents = literal.slice(1, -1);
  if (literal[0] === "`" && contents.includes("${")) return;
  try {
    return contents.replace(/\\(?:u\{([0-9a-f]{1,6})\}|u([0-9a-f]{4})|x([0-9a-f]{2})|([\s\S]))/gi, (_whole, unicode: string | undefined, unit: string | undefined, byte: string | undefined, escape: string | undefined) => {
      if (unicode || unit || byte) return String.fromCodePoint(Number.parseInt(unicode ?? unit ?? byte!, 16));
      return ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" } as Record<string, string>)[escape!] ?? escape!;
    });
  } catch { return; }
}

interface JavascriptToken { 0: string; index: number; comment: boolean }
/** A static lexer keeps nested template literals from shifting every subsequent string boundary. */
function javascriptTokens(text: string): JavascriptToken[] {
  const tokens: JavascriptToken[] = [];
  const commentEnd = (start: number) => text[start + 1] === "/" ? (() => {
    const end = text.indexOf("\n", start + 2); return end < 0 ? text.length : end;
  })() : (() => { const end = text.indexOf("*/", start + 2); return end < 0 ? text.length : end + 2; })();
  const regexStart = (start: number) => {
    const previous = text.slice(Math.max(0, start - 60), start).trimEnd();
    return !previous || /[=(:,!&|?;\[{]$/.test(previous) || /\b(?:return|throw|case|yield|void|typeof|delete)\s*$/.test(previous);
  };
  const regexEnd = (start: number) => {
    let characterClass = false;
    for (let index = start + 1; index < text.length; index++) {
      if (text[index] === "\\") { index++; continue; }
      if (text[index] === "\n" || text[index] === "\r") return start + 1;
      if (text[index] === "[") characterClass = true;
      else if (text[index] === "]") characterClass = false;
      else if (text[index] === "/" && !characterClass) {
        index++;
        while (/[a-z]/i.test(text[index] ?? "") && index < text.length) index++;
        return index;
      }
    }
    return start + 1;
  };
  const quotedEnd = (start: number, level: number): number => {
    if (level > 32) return text.length;
    const quote = text[start];
    let index = start + 1;
    while (index < text.length) {
      if (text[index] === "\\") { index += 2; continue; }
      if (text[index] === quote) return index + 1;
      if (quote !== "`" && /[\r\n]/.test(text[index])) return index;
      if (quote === "`" && text[index] === "$" && text[index + 1] === "{") {
        index += 2;
        let braces = 1;
        while (index < text.length && braces) {
          const current = text[index];
          if (["'", '"', "`"].includes(current)) { index = quotedEnd(index, level + 1); continue; }
          if (current === "/" && ["/", "*"].includes(text[index + 1])) { index = commentEnd(index); continue; }
          if (current === "/" && regexStart(index)) { index = regexEnd(index); continue; }
          if (current === "{") braces++;
          else if (current === "}") braces--;
          index++;
        }
        continue;
      }
      index++;
    }
    return index;
  };
  for (let index = 0; index < text.length;) {
    const current = text[index];
    const comment = current === "/" && ["/", "*"].includes(text[index + 1]);
    const regex = current === "/" && !comment && regexStart(index);
    if (comment || regex || ["'", '"', "`"].includes(current)) {
      const end = comment ? commentEnd(index) : regex ? regexEnd(index) : quotedEnd(index, 0);
      tokens.push({ 0: text.slice(index, end), index, comment: comment || regex });
      index = Math.max(index + 1, end);
    } else index++;
  }
  return tokens;
}
function maskJavascriptTokens(text: string, tokens: JavascriptToken[], commentsOnly = false): string {
  const parts: string[] = [];
  let offset = 0;
  for (const token of tokens) {
    if (commentsOnly && !token.comment) continue;
    parts.push(text.slice(offset, token.index), token[0].replace(/[^\r\n]/g, " "));
    offset = token.index + token[0].length;
  }
  parts.push(text.slice(offset));
  return parts.join("");
}
const JS_IDENTIFIER = "[a-zA-Z_$][\\w$]*";
function escapePattern(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function closingDelimiter(syntax: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let index = start; index < syntax.length; index++) {
    if (syntax[index] === open) depth++;
    else if (syntax[index] === close && --depth === 0) return index;
  }
  return -1;
}

/** Resolve only route templates backed by a literal prefix, a simple navigation helper and published parameter values. */
function extractClientRouteManifests(context: Context, code: string, ownerBase: URL, tokens: JavascriptToken[]): void {
  const deadline = Math.min(context.deadline, Date.now() + 300);
  const withinBudget = () => {
    if (Date.now() < deadline && !context.signal.aborted) return true;
    context.warnings.add("达到静态前端路由解析时间上限，已保留解析结果");
    return false;
  };
  const allLiterals = tokens.filter(match => !match.comment);
  const literals = allLiterals.slice(0, 20000);
  if (allLiterals.length > literals.length) context.warnings.add("达到静态前端路由字符串读取上限，已保留解析结果");
  const syntax = maskJavascriptTokens(code, tokens);
  const scopeDepth = new Uint16Array(syntax.length + 1);
  let depth = 0;
  for (let index = 0; index < syntax.length; index++) {
    scopeDepth[index] = depth;
    if (syntax[index] === "{") depth++;
    else if (syntax[index] === "}") depth = Math.max(0, depth - 1);
  }
  const constants = new Map<string, Set<string>>();
  for (const match of literals) {
    if (!withinBudget()) return;
    const value = decodeJsLiteral(match[0]);
    if (value === undefined) continue;
    const assignment = new RegExp(`(?:^|[;,{}]|\\b(?:const|let|var))\\s*(${JS_IDENTIFIER})\\s*=\\s*$`).exec(code.slice(Math.max(0, match.index! - 100), match.index));
    if (!assignment || scopeDepth[match.index!] !== 0 || !/^\s*[,;})]/.test(code.slice(match.index! + match[0].length, match.index! + match[0].length + 12))) continue;
    const values = constants.get(assignment[1]) ?? new Set<string>();
    values.add(value);
    constants.set(assignment[1], values);
  }
  const prefixValue = (binding: string) => {
    const values = constants.get(binding);
    if (values?.size !== 1) return;
    const writes = [...syntax.matchAll(new RegExp(`\\b${escapePattern(binding)}\\s*=(?!=)`, "g"))].filter(match => scopeDepth[match.index!] === 0);
    return writes.length === 1 ? [...values][0] : undefined;
  };
  const routes: { prefix: string; key: string }[] = [];
  const routeKeys = new Set<string>();
  for (const match of literals) {
    if (!withinBudget()) return;
    if (!/\bpath\s*:\s*$/.test(code.slice(Math.max(0, match.index! - 35), match.index))) continue;
    const contents = match[0].slice(1, -1);
    const template = /^\$\{([a-zA-Z_$][\w$]*)\}(\/[^${}]*)\/:([a-zA-Z_][\w]*)$/.exec(contents)
      ?? /^\$\{([a-zA-Z_$][\w$]*)\}()\/:([a-zA-Z_][\w]*)$/.exec(contents);
    const direct = /^([^${}]*)\/:([a-zA-Z_][\w]*)$/.exec(contents);
    const prefix = template ? prefixValue(template[1]) : direct?.[1];
    if (prefix === undefined) continue;
    const resolved = `${prefix}${template?.[2] ?? ""}`.replace(/\/$/, "");
    if (!resolved.startsWith("/") || !concreteValue(resolved || "/")) continue;
    const key = template?.[3] ?? direct![2];
    if (routeKeys.has(`${resolved}:${key}`)) continue;
    if (routes.length === 20) { context.warnings.add("达到静态前端路由清单读取上限，已保留解析结果"); break; }
    routeKeys.add(`${resolved}:${key}`);
    routes.push({ prefix: resolved, key });
  }
  for (const route of routes) {
    if (!withinBudget()) return;
    let helper: string | undefined;
    for (const match of literals) {
      if (!withinBudget()) return;
      if (match[0][0] !== "`") continue;
      const before = code.slice(Math.max(0, match.index! - 160), match.index);
      const declaration = new RegExp(`\\bfunction\\s+(${JS_IDENTIFIER})\\s*\\(\\s*(${JS_IDENTIFIER})\\s*\\)\\s*\\{\\s*return\\s*$`).exec(before);
      if (!declaration || !/^\s*;?\s*}/.test(code.slice(match.index! + match[0].length, match.index! + match[0].length + 12))) continue;
      const contents = match[0].slice(1, -1);
      const variable = new RegExp(`^\\$\\{(${JS_IDENTIFIER})\\}/\\$\\{${escapePattern(declaration[2])}\\}$`).exec(contents);
      const literal = contents.endsWith(`/\${${declaration[2]}}`) ? contents.slice(0, -(`/\${${declaration[2]}}`.length)) : undefined;
      const helperPrefix = variable ? prefixValue(variable[1]) : literal;
      if (helperPrefix?.replace(/\/$/, "") !== route.prefix) continue;
      const navigation = new RegExp(`\\b(?:to|href)\\s*:\\s*${escapePattern(declaration[1])}\\s*\\(\\s*${JS_IDENTIFIER}\\.${escapePattern(route.key)}\\s*\\)`);
      if (navigation.test(code)) { helper = declaration[1]; break; }
    }
    if (!helper) continue;
    // Restrict values to an actual array consumed by the navigation map. Unrelated slug objects are not route declarations.
    const arrayPattern = new RegExp(`(?:^|[;,{}]|\\b(?:const|let|var))\\s*(${JS_IDENTIFIER})\\s*=\\s*\\[`, "g");
    let arrays = 0;
    for (const array of syntax.matchAll(arrayPattern)) {
      if (!withinBudget()) return;
      const start = array.index! + array[0].lastIndexOf("[");
      if (scopeDepth[start] !== 0) continue;
      const end = closingDelimiter(syntax, start, "[", "]");
      if (end < 0) continue;
      let cursor = start + 1;
      let braces = 0;
      let arraysDepth = 0;
      let parentheses = 0;
      const keyPattern = new RegExp(`\\b${escapePattern(route.key)}\\s*:\\s*$`);
      const values = literals.filter(match => {
        if (match.index! <= start || match.index! >= end) return false;
        for (; cursor < match.index!; cursor++) {
          const character = syntax[cursor];
          if (character === "{") braces++; else if (character === "}") braces--;
          else if (character === "[") arraysDepth++; else if (character === "]") arraysDepth--;
          else if (character === "(") parentheses++; else if (character === ")") parentheses--;
        }
        return braces === 1 && arraysDepth === 0 && parentheses === 0 && keyPattern.test(code.slice(Math.max(start, match.index! - 80), match.index));
      });
      if (!values.length) continue;
      if (++arrays > 32) { context.warnings.add("达到静态前端路由数组读取上限，已保留解析结果"); break; }
      const aliases = new Set([array[1]]);
      const groupedAliases = new Set<string>();
      for (let pass = 0; pass < 4; pass++) {
        if (!withinBudget()) return;
        const size = aliases.size;
        for (const alias of [...aliases]) {
          if (!withinBudget()) return;
          const derived = new RegExp(`\\b(${JS_IDENTIFIER})\\s*=\\s*${escapePattern(alias)}\\.(filter|slice|reduce)\\s*\\(`, "g");
          for (const match of syntax.matchAll(derived)) {
            if (aliases.size >= 8) break;
            if (match[2] === "reduce") {
              const begin = match.index! + match[0].lastIndexOf("(");
              const finish = closingDelimiter(syntax, begin, "(", ")");
              const body = code.slice(begin + 1, finish);
              const reducer = new RegExp(`^\\s*\\(\\s*${JS_IDENTIFIER}\\s*,\\s*(${JS_IDENTIFIER})\\s*\\)\\s*=>`).exec(body);
              if (!reducer || !new RegExp(`\\bpages\\s*:\\s*\\[(?:\\.\\.\\.${JS_IDENTIFIER}\\.pages\\s*,\\s*)?${escapePattern(reducer[1])}\\s*\\]`).test(body)
                || new RegExp(`\\b${escapePattern(reducer[1])}\\s*(?:\\.\\s*${escapePattern(route.key)}\\s*)?=(?!=)`).test(body)) continue;
              groupedAliases.add(match[1]);
            }
            if (groupedAliases.has(alias)) groupedAliases.add(match[1]);
            aliases.add(match[1]);
          }
        }
        if (aliases.size === size) break;
      }
      const rendered = [...aliases].some(alias => {
        if (!withinBudget()) return false;
        for (const map of syntax.matchAll(new RegExp(`\\b${escapePattern(alias)}\\.map\\s*\\(`, "g"))) {
          if (!withinBudget()) return false;
          const begin = map.index! + map[0].lastIndexOf("(");
          const finish = closingDelimiter(syntax, begin, "(", ")");
          const body = code.slice(begin + 1, finish);
          const callback = new RegExp(`^\\s*\\(?\\s*(${JS_IDENTIFIER})(?:\\s*,\\s*${JS_IDENTIFIER})?\\s*\\)?\\s*=>`).exec(body);
          if (finish >= 0 && callback && new RegExp(`\\b(?:to|href)\\s*:\\s*${escapePattern(helper!)}\\s*\\(\\s*${escapePattern(callback[1])}\\.${escapePattern(route.key)}\\s*\\)`).test(body)) return true;
          if (finish < 0 || !callback || !groupedAliases.has(alias)) continue;
          const pagesMap = new RegExp(`\\b${escapePattern(callback[1])}\\.pages\\.map\\s*\\(\\s*\\(?\\s*(${JS_IDENTIFIER})(?:\\s*,\\s*${JS_IDENTIFIER})?\\s*\\)?\\s*=>`, "g");
          for (const nested of body.matchAll(pagesMap)) {
            const nestedBegin = begin + 1 + nested.index! + nested[0].indexOf("(");
            const nestedEnd = closingDelimiter(syntax, nestedBegin, "(", ")");
            if (nestedEnd >= 0 && new RegExp(`\\b(?:to|href)\\s*:\\s*${escapePattern(helper!)}\\s*\\(\\s*${escapePattern(nested[1])}\\.${escapePattern(route.key)}\\s*\\)`).test(code.slice(nestedBegin, nestedEnd + 1))) return true;
          }
        }
        return false;
      });
      if (!rendered) continue;
      for (const match of values) {
        const value = decodeJsLiteral(match[0]);
        if (!value || !concreteValue(value) || /[/?#]/.test(value)) continue;
        if (!/^\s*[,}]/.test(code.slice(match.index! + match[0].length, match.index! + match[0].length + 12))) continue;
        context.collector.add(`${route.prefix}/${value}`, ownerBase, "page", undefined, "scripts", true);
      }
    }
  }
}

function extractJavascript(context: Context, text: string, scriptBase: URL, ownerBase: URL): void {
  const tokens = javascriptTokens(text);
  const code = maskJavascriptTokens(text, tokens, true);
  extractClientRouteManifests(context, code, ownerBase, tokens);
  for (const match of tokens) {
    if (match.comment) continue;
    const value = decodeJsLiteral(match[0]);
    if (!value) continue;
    const prefix = code.slice(Math.max(0, match.index! - 140), match.index);
    const suffix = code.slice(match.index! + match[0].length, match.index! + match[0].length + 140);
    if (/\+\s*$/.test(prefix) || /^\s*(?:\+|\.concat\s*\()/.test(suffix)) continue;
    const request = /(?:\bfetch|\baxios\.(?:get|post|put|patch|delete|head|options)|\b(?:get|post|put|patch|delete|head|options)|\bimport|\bimportScripts)\s*\(\s*$/.test(prefix)
      || /\.open\s*\(\s*['"](?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"]\s*,\s*$/i.test(prefix);
    const moduleImport = /(?:\bimport\s*\(\s*|\bimport\s*(?:[^;\n]*?\bfrom\s*)?|\bexport\s+[^;\n]*?\bfrom\s*)$/.test(prefix);
    const workerImport = /\bimportScripts\s*\(\s*$/.test(prefix);
    const importMetaUrl = /\bnew\s+URL\s*\(\s*$/.test(prefix) && /^\s*,\s*import\.meta\.url\s*\)/.test(suffix);
    // Bare module names need import-map resolution; resolving them as relative paths invents URLs.
    if (moduleImport && !/^(?:https?:\/\/|\/\/|\/|\.\.?\/)/i.test(value)) continue;
    if (!request && !moduleImport && !workerImport && !importMetaUrl && !/^(?:https?:\/\/|\/\/|\/(?!\/))/i.test(value)) continue;
    const base = moduleImport || workerImport || importMetaUrl ? scriptBase : ownerBase;
    context.collector.add(value, base, moduleImport || workerImport ? "script" : undefined, ownerBase, "scripts");
  }
}

function extractHtml(context: Context, input: string): void {
  const text = input.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  const markup = text.replace(/(<script\b(?:[^>"']|"[^"]*"|'[^']*')*>)[\s\S]*?<\/script\s*>/gi, "$1</script>");
  const tags = [...markup.matchAll(/<([a-z][\w:-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)];
  let base = context.documentUrl;
  const baseTag = tags.find((tag) => tag[1].toLowerCase() === "base" && attributes(tag[0]).has("href"));
  if (baseTag) {
    const href = attributes(baseTag[0]).get("href")!;
    try {
      const value = href.trim().split(/[?#]/, 1)[0];
      if (concreteValue(value)) { base = new URL(value, context.documentUrl); base.search = ""; base.hash = ""; }
    } catch { /* Browser ignores a malformed base URL. */ }
  }
  for (const tag of tags) {
    const name = tag[1].toLowerCase();
    const attrs = attributes(tag[0]);
    if (name === "base" || name === "form") continue;
    if (["a", "area", "link"].includes(name) && attrs.has("href")) {
      const rel = (attrs.get("rel") ?? "").toLowerCase().split(/\s+/);
      context.collector.add(attrs.get("href")!, base, rel.includes("sitemap") ? "sitemap" : rel.includes("modulepreload") || rel.includes("preload") && attrs.get("as")?.toLowerCase() === "script" ? "script" : rel.includes("stylesheet") || rel.includes("icon") ? "asset" : undefined, base);
    }
    if (attrs.has("src") && ["script", "img", "iframe", "source", "audio", "video", "embed", "input"].includes(name)) {
      context.collector.add(attrs.get("src")!, base, name === "script" ? base.origin === context.collector.origin ? "script" : "asset" : name === "iframe" ? "page" : "asset", base);
    }
    if (["img", "source"].includes(name) && attrs.has("srcset")) {
      for (const entry of attrs.get("srcset")!.split(",")) context.collector.add(entry.trim().split(/\s+/)[0] ?? "", base, "asset");
    }
  }
  if (base.origin !== context.collector.origin || base.username || base.password || base.port) context.warnings.add("网页 base 指向站外或无效地址，部分相对脚本线索无法解析");
  for (const script of text.matchAll(/<script\b(?:[^>"']|"[^"]*"|'[^']*')*>([\s\S]*?)<\/script\s*>/gi)) extractJavascript(context, script[1], base, base);
}

function completeLines(text: string, truncated: boolean): string[] {
  const lines = text.split(/\r?\n/);
  if (truncated && !/\r?\n$/.test(text)) lines.pop();
  return lines;
}

function extractRobots(context: Context, text: string, truncated: boolean): void {
  for (const line of completeLines(text, truncated)) {
    const directive = /^\s*(sitemap|allow|disallow)\s*:\s*(.*?)\s*(?:#.*)?$/i.exec(line);
    if (!directive || !directive[2]) continue;
    const value = directive[2].trim();
    if (directive[1].toLowerCase() === "sitemap") context.collector.add(value, context.documentUrl, "sitemap");
    else if (value.startsWith("/") && !value.includes("$") && !value.includes("*")) context.collector.add(value, context.documentUrl);
  }
}

function extractSitemap(context: Context, text: string, truncated: boolean): void {
  text = text.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  if (/^\s*(?:<\?xml[^>]*>\s*)?</.test(text)) {
    if (!/<(?:[\w.-]+:)?(?:sitemapindex|urlset)\b/i.test(text)) throw new SourceFailure("网站地图格式无效");
    const sitemapIndex = /<(?:[\w.-]+:)?sitemapindex\b/i.test(text);
    for (const match of text.matchAll(/<(?:[\w.-]+:)?loc\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?loc\s*>/gi)) {
      const value = match[1].replace(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/, "$1");
      context.collector.add(decodeEntities(value.trim()), context.documentUrl, sitemapIndex ? "sitemap" : undefined);
    }
  } else {
    const lines = completeLines(text, truncated).map((line) => line.trim()).filter(Boolean);
    if (lines.some((line) => !/^https?:\/\//i.test(line))) throw new SourceFailure("网站地图格式无效");
    for (const line of lines) context.collector.add(line, context.documentUrl);
  }
}

async function discoverDocument(context: Context): Promise<void> {
  const response = await readDocument(context, context.documentUrl);
  if (response.statusCode >= 300 && response.statusCode < 400) {
    if (response.location && context.source === "links" && context.documentUrl.protocol === "http:") {
      try {
        const destination = new URL(response.location, context.documentUrl);
        destination.search = "";
        destination.hash = "";
        if (destination.protocol === "https:" && destination.hostname === context.documentUrl.hostname
          && !destination.username && !destination.password && !destination.port && concreteValue(destination.pathname)) {
          context.canonicalUrl = normalizeUrl(destination.href).href;
          context.note = "网站入口已跳转到同主机 HTTPS 地址";
          return;
        }
      } catch { /* Only a concrete, observed same-host HTTPS upgrade can change the scan scope. */ }
    }
    if (response.location) context.collector.add(response.location, context.documentUrl, context.source === "scripts" ? "script" : context.source === "sitemap" ? "sitemap" : "page");
    if (!context.collector.candidates.size) throw new SourceFailure("文档重定向至站外或无可用地址");
    context.warnings.add("文档返回重定向，已保留同源跳转地址");
    return;
  }
  if ((response.statusCode === 404 || response.statusCode === 410) && ["robots", "sitemap"].includes(context.source)) { context.note = "网站未提供此文档"; return; }
  if (response.statusCode < 200 || response.statusCode >= 300) throw new SourceFailure(response.statusCode === 429 ? "网站暂时限流，请稍后重试" : `文档返回 HTTP ${response.statusCode}`);
  const text = response.body.toString("utf8");
  if (context.source === "links") {
    if (response.contentType && !/\b(?:html|xhtml)\b/i.test(response.contentType)) { context.note = "此响应不是网页文档"; return; }
    extractHtml(context, text);
  } else if (context.source === "scripts") {
    if (response.contentType && !/\b(?:javascript|ecmascript|x-javascript|plain|octet-stream)\b/i.test(response.contentType)) throw new SourceFailure("此响应不是脚本文档");
    extractJavascript(context, text, context.documentUrl, context.ownerDocument);
  }
  else if (context.source === "robots") extractRobots(context, text, response.truncated);
  else extractSitemap(context, text, response.truncated);
}

async function discoverArchive(context: Context): Promise<void> {
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  for (let page = 0; page < MAX_ARCHIVE_PAGES; page += 1) {
    const url = new URL("https://web.archive.org/cdx/search/cdx");
    url.searchParams.set("url", context.documentUrl.hostname);
    url.searchParams.set("matchType", "host");
    url.searchParams.set("output", "json");
    url.searchParams.set("fl", "original");
    url.searchParams.set("collapse", "urlkey");
    url.searchParams.set("limit", "1000");
    url.searchParams.set("showResumeKey", "true");
    url.searchParams.set("gzip", "false");
    if (cursor) url.searchParams.set("resumeKey", cursor);
    const response = await readDocument(context, url);
    if (response.statusCode < 200 || response.statusCode >= 300) throw new SourceFailure(response.statusCode === 429 ? "Wayback 暂时限流，请稍后重试" : `Wayback 返回 HTTP ${response.statusCode}`);
    const text = response.body.toString("utf8");
    if (response.truncated) {
      for (const match of text.matchAll(/\[\s*("(?:\\.|[^"\\])*")\s*\]/g)) {
        try { context.collector.archive(JSON.parse(match[1]) as string, context.documentUrl); } catch { /* Only complete JSON string fields are evidence. */ }
      }
      return;
    }
    let rows: unknown;
    try { rows = JSON.parse(text); } catch { throw new SourceFailure("Wayback 返回的数据格式无效"); }
    if (!Array.isArray(rows) || rows.some((row) => !Array.isArray(row)) || (rows.length && (rows[0].length !== 1 || rows[0][0] !== "original"))) throw new SourceFailure("Wayback 返回的数据格式无效");
    let next: string | undefined;
    for (let index = 1; index < rows.length; index += 1) {
      const row: unknown[] = rows[index];
      if (!row.length && index === rows.length - 2 && rows[index + 1].length === 1 && typeof rows[index + 1][0] === "string") { next = rows[index + 1][0]; break; }
      if (row.length !== 1 || typeof row[0] !== "string") throw new SourceFailure("Wayback 返回的数据格式无效");
      context.collector.archive(row[0], context.documentUrl);
    }
    if (context.collector.capped) return;
    if (next === undefined) return;
    if (!next || next.length > 1024 || seenCursors.has(next)) { context.warnings.add("Wayback 无法继续分页，已保留当前结果"); return; }
    cursor = next;
    seenCursors.add(next);
  }
  context.warnings.add("Wayback 达到分页上限，结果可能不完整");
}

/** Discover paths from actual documents and archived URLs; never execute scripts or invent route names. */
export async function discoverWebsitePaths(baseInput: string, documentInput: string, source: WebsitePathDiscoverySource, timeoutMs = 20000, dependencies = defaults, signal?: AbortSignal, ownerDocumentInput?: string): Promise<WebsitePathDiscoveryResult> {
  const base = normalizeUrl(baseInput);
  const documentUrl = normalizeUrl(documentInput);
  base.search = "";
  documentUrl.search = "";
  const ownerDocument = ownerDocumentInput ? normalizeUrl(ownerDocumentInput) : base;
  ownerDocument.search = "";
  if (documentUrl.origin !== base.origin) throw new Error("发现文档必须与扫描网站同源");
  if (ownerDocument.origin !== base.origin) throw new Error("脚本所属网页必须与扫描网站同源");
  if (!SOURCES.includes(source)) throw new Error("不支持的发现来源");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 20000) throw new Error("发现来源超时必须在 1000–20000 毫秒之间");
  const collector = new CandidateCollector(base.origin, source);
  const controller = new AbortController();
  const context: Context = { documentUrl, ownerDocument, source, collector, deadline: Date.now() + timeoutMs, signal: controller.signal, dependencies, warnings: new Set() };
  let onAbort: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = (status: WebsitePathDiscoveryResult["status"], message?: string): WebsitePathDiscoveryResult => ({ source, url: documentUrl.href, status, candidates: [...collector.candidates.values()], ...(collector.ignoredUrls.size ? { ignoredUrls: [...collector.ignoredUrls] } : {}), ...(context.canonicalUrl ? { canonicalUrl: context.canonicalUrl } : {}), ...(message ? { message } : {}) });
  if (signal?.aborted) return result("error", "发现查询已取消");
  const interruption = new Promise<never>((_, reject) => {
    onAbort = () => { controller.abort(); reject(new SourceFailure("发现查询已取消")); };
    timer = setTimeout(() => { controller.abort(); reject(new SourceFailure("发现查询超时")); }, timeoutMs);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([source === "wayback" ? discoverArchive(context) : discoverDocument(context), interruption]);
    if (collector.capped) context.warnings.add("达到每份文档 2000 个路径上限，结果可能不完整");
    if (collector.cappedKinds.has("script")) context.warnings.add("达到每份文档 40 份脚本线索上限，已保留实际路径");
    if (collector.cappedKinds.has("sitemap")) context.warnings.add("达到每份文档 20 份地图线索上限，已保留实际路径");
    if (collector.ignoredUrlsCapped) context.warnings.add("部分无扩展名资源超过 2000 项标记上限，筛选可能不完整");
    return result(context.warnings.size ? "partial" : "success", context.warnings.size ? [...context.warnings].join("；") : context.note);
  } catch (error) {
    return result(collector.candidates.size ? "partial" : "error", error instanceof SourceFailure ? error.message : controller.signal.aborted ? "发现查询超时或已取消" : "文档查询失败，请稍后重试");
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    controller.abort();
  }
}
