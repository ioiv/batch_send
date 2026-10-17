import { decodeJsLiteral, isCompleteJavascriptLiteral, javascriptTokens, maskJavascriptTokens, type JavascriptToken } from "./website-path-javascript.js";
import { parse } from "@babel/parser";

export interface PublishedClientRouteOptions {
  /** Reuse a lexed document when available. Token indexes must refer to the supplied code. */
  tokens?: JavascriptToken[];
  /** Absolute wall-clock deadline. This compatibility pass has a bounded size-based ceiling. */
  deadline?: number;
  signal?: AbortSignal;
  /** Resolve output paths to absolute URLs. Without a base, output stays root-relative. */
  baseUrl?: string | URL;
}
export interface PublishedClientRouteResult { urls: string[]; warnings: string[]; partial: boolean }
interface ManifestContext { deadline: number; signal: AbortSignal; warnings: Set<string>; urls: Set<string> }

function concreteValue(value: string): boolean {
  let decoded = value;
  try { decoded = decodeURIComponent(value); } catch { return false; }
  return value.length > 0 && value.length <= 2048 && !/[\u0000-\u0020\u007f\\]/.test(value)
    && !/[\u0000-\u001f\u007f\\{}<>]/.test(decoded) && !/\$\{|(^|\/):[a-z_]/i.test(decoded)
    && !decoded.includes("*") && decoded !== "/&" && !decoded.split("/").some(part => part === ":" || part === "$") && !/^[#?]/.test(value);
}

/** Retain only published parameter values linked by a proven navigation map and route helper. */
export function extractPublishedClientRoutes(code: string, options: PublishedClientRouteOptions = {}): PublishedClientRouteResult {
  const context: ManifestContext = { deadline: Math.min(options.deadline ?? Infinity, Date.now() + (code.length <= 512 * 1024 ? 300 : 1000)), signal: options.signal ?? new AbortController().signal,
    warnings: new Set(), urls: new Set() };
  const tokens = options.tokens ?? javascriptTokens(code);
  analyzeManifest(context, maskJavascriptTokens(code, tokens, true), tokens, code);
  const urls = [...context.urls].map(value => options.baseUrl ? new URL(value, options.baseUrl).href : value);
  return { urls, warnings: [...context.warnings], partial: context.warnings.size > 0 };
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

/** A published array is unknown after escaping, reassignment or mutation through a callback. */
function stableNavigationCollection(syntax: string, aliases: Set<string>, withinBudget: () => boolean): boolean {
  const memberPath = `(?:\\s*(?:\\[[^\\]\\r\\n]{0,512}\\]|\\.\\s*${JS_IDENTIFIER}))*`;
  const write = `(?:=(?![=>])|(?:\\*\\*|&&|\\|\\||\\?\\?|[+*/%&|^\\-])=|\\+\\+|--)`;
  const mutated = (name: string, text: string) => new RegExp(`\\b${escapePattern(name)}${memberPath}\\s*${write}`).test(text)
    || new RegExp(`\\b${escapePattern(name)}${memberPath}\\s*\\.\\s*(?:push|pop|shift|unshift|splice|sort|reverse|copyWithin|fill|set|add|delete|clear)\\s*\\(`).test(text)
    || new RegExp(`\\bdelete\\s+${escapePattern(name)}\\s*(?:\\.|\\[)`).test(text);
  for (const alias of aliases) {
    if (!withinBudget()) return false;
    let declarations = 0;
    for (const occurrence of syntax.matchAll(new RegExp(`\\b${escapePattern(alias)}\\b`, "g"))) {
      if (!withinBudget()) return false;
      const start = occurrence.index!;
      // A similarly named object property is not a reference to this array binding.
      if (/\.\s*$/.test(syntax.slice(Math.max(0, start - 8), start))) continue;
      const after = syntax.slice(start + alias.length);
      if (/^\s*:/.test(after)) continue;
      if (/^\s*=(?!=)/.test(after)) {
        if (++declarations > 1) return false;
        continue;
      }
      const method = /^\s*\.\s*(map|filter|slice|reduce)\s*\(/.exec(after);
      if (!method) return false;
      const begin = start + alias.length + method[0].lastIndexOf("(");
      const end = closingDelimiter(syntax, begin, "(", ")");
      if (end < 0) return false;
      const body = syntax.slice(begin + 1, end);
      const callback = new RegExp(`^\\s*(?:\\(\\s*(${JS_IDENTIFIER}(?:\\s*,\\s*${JS_IDENTIFIER})*)\\s*\\)|(${JS_IDENTIFIER}))\\s*=>`).exec(body);
      for (const parameter of (callback?.[1] ?? callback?.[2] ?? "").split(/\s*,\s*/).filter(Boolean)) {
        if (mutated(parameter, body)) return false;
        // Passing the element itself to an unknown function can change its route field.
        if (new RegExp(`\\(\\s*${escapePattern(parameter)}\\s*[,)]|,\\s*${escapePattern(parameter)}\\s*[,)]`).test(body.slice(callback![0].length))) return false;
      }
    }
    if (declarations !== 1) return false;
  }
  return true;
}

type ManifestNode = { type: string; start?: number | null; end?: number | null; [key: string]: any };
interface ManifestScope { parent?: ManifestScope; functionScope: boolean; bindings: Map<string, ManifestBinding> }
interface ManifestBinding { scope: ManifestScope; value?: string; immutable: boolean; invalid: boolean }
interface ManifestScopeProof {
  prefix(name: string, position: number): string | undefined;
}

/** Validate only applicable manifests; never infer a global prefix through a local shadow. */
function manifestScopeProof(source: string, positions: Set<number>, withinBudget: () => boolean): ManifestScopeProof | undefined {
  if (!withinBudget()) return;
  let ast: ManifestNode;
  try {
    ast = parse(source, { sourceType: "unambiguous", errorRecovery: true, plugins: ["jsx"], allowReturnOutsideFunction: true }) as unknown as ManifestNode;
  } catch { return; }
  if (ast.errors?.length || !withinBudget()) return;
  const root: ManifestScope = { functionScope: true, bindings: new Map() };
  const locations = new Map<number, ManifestScope>();
  const writes: { target: ManifestNode; scope: ManifestScope }[] = [];
  const names = (pattern: ManifestNode | undefined): string[] => {
    const found: string[] = [], pending = pattern ? [pattern] : [];
    while (pending.length) {
      const item = pending.pop()!;
      if (item.type === "Identifier") found.push(item.name);
      else if (item.type === "AssignmentPattern") pending.push(item.left);
      else if (item.type === "RestElement") pending.push(item.argument);
      else if (item.type === "ArrayPattern") pending.push(...item.elements.filter(Boolean));
      else if (item.type === "ObjectPattern") for (const field of item.properties) pending.push(field.type === "RestElement" ? field.argument : field.value);
    }
    return found;
  };
  const declare = (scope: ManifestScope, name: string, immutable = false, value?: string) => {
    const previous = scope.bindings.get(name);
    if (previous) previous.invalid = true;
    else scope.bindings.set(name, { scope, immutable, invalid: false, value });
  };
  const lookup = (scope: ManifestScope | undefined, name: string): ManifestBinding | undefined => {
    for (let current = scope; current; current = current.parent) {
      const binding = current.bindings.get(name);
      if (binding) return binding;
    }
  };
  const functions = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ObjectMethod", "ClassMethod", "ClassPrivateMethod"]);
  const pending: { node: ManifestNode; scope: ManifestScope }[] = [{ node: ast, scope: root }];
  let nodes = 0;
  while (pending.length) {
    if (++nodes % 256 === 0 && !withinBudget()) return;
    const item = pending.pop()!, node = item.node;
    let scope = item.scope;
    if (["FunctionDeclaration", "ClassDeclaration"].includes(node.type) && node.id) declare(scope, node.id.name);
    if (functions.has(node.type)) {
      scope = { parent: scope, functionScope: true, bindings: new Map() };
      if (node.type === "FunctionExpression" && node.id) declare(scope, node.id.name);
      for (const parameter of node.params ?? []) for (const name of names(parameter)) declare(scope, name);
    } else if (["BlockStatement", "CatchClause", "ForStatement", "ForInStatement", "ForOfStatement", "SwitchStatement", "StaticBlock"].includes(node.type)) {
      scope = { parent: scope, functionScope: false, bindings: new Map() };
      if (node.type === "CatchClause") for (const name of names(node.param)) declare(scope, name);
    }
    if (node.start != null && positions.has(node.start)) locations.set(node.start, scope);
    if (node.type === "VariableDeclaration") {
      let declarationScope = scope;
      if (node.kind === "var") while (!declarationScope.functionScope && declarationScope.parent) declarationScope = declarationScope.parent;
      for (const declaration of node.declarations) {
        for (const name of names(declaration.id)) {
          const literal = declaration.id.type !== "Identifier" ? undefined : declaration.init?.type === "StringLiteral" ? declaration.init.value
            : declaration.init?.type === "TemplateLiteral" && declaration.init.expressions.length === 0 ? declaration.init.quasis.map((part: ManifestNode) => part.value.cooked ?? part.value.raw).join("") : undefined;
          declare(declarationScope, name, node.kind === "const", literal);
        }
      }
    }
    if (node.type === "ImportDeclaration") for (const specifier of node.specifiers) declare(scope, specifier.local.name);
    if (node.type === "AssignmentExpression") writes.push({ target: node.left, scope });
    if (node.type === "UpdateExpression") writes.push({ target: node.argument, scope });
    if (["ForInStatement", "ForOfStatement"].includes(node.type) && node.left?.type !== "VariableDeclaration") writes.push({ target: node.left, scope });
    for (const key in node) {
      if (["loc", "extra", "tokens", "comments", "errors"].includes(key)) continue;
      const value = node[key];
      if (Array.isArray(value)) for (let index = value.length - 1; index >= 0; index--) {
        if (value[index] && typeof value[index].type === "string") pending.push({ node: value[index], scope });
      }
      else if (value && typeof value === "object" && typeof value.type === "string") pending.push({ node: value, scope });
    }
  }
  for (const write of writes) for (const name of names(write.target)) {
    const binding = lookup(write.scope, name);
    if (binding) binding.invalid = true;
  }
  return {
    prefix(name, position) {
      const binding = root.bindings.get(name);
      return binding?.immutable && !binding.invalid && lookup(locations.get(position), name) === binding ? binding.value : undefined;
    },
  };
}

/** Resolve only route templates backed by a literal prefix, a simple navigation helper and published parameter values. */
function analyzeManifest(context: ManifestContext, code: string, tokens: JavascriptToken[], originalCode: string): void {
  const deadline = context.deadline;
  const withinBudget = () => {
    if (Date.now() < deadline && !context.signal.aborted) return true;
    context.warnings.add("达到静态前端路由解析时间上限，已保留解析结果");
    return false;
  };
  if (!withinBudget()) return;
  const literals = tokens.filter(match => !match.comment && isCompleteJavascriptLiteral(match[0]));
  // This pass handles published values for parameterized routes. A large SDK
  // without such a route has no applicable manifest, regardless of how many
  // unrelated strings it contains. Inspect all literal positions before the
  // expensive joins so an actual manifest near EOF cannot be silently skipped.
  const routeLiterals = literals.filter(match => /\bpath\s*:\s*$/.test(code.slice(Math.max(0, match.index - 35), match.index))
    && /\/:[a-zA-Z_][\w]*$/.test(match[0].slice(1, -1)));
  if (!routeLiterals.length) return;
  // Only a final whole-parameter interpolation can be one of the supported
  // navigation helpers. Avoid repeatedly inspecting unrelated SDK literals.
  const helperLiterals = literals.filter(match => match[0][0] === "`" && /\/\$\{[a-zA-Z_$][\w$]*\}$/.test(match[0].slice(1, -1)));
  if (!helperLiterals.length) return;
  let proof: ManifestScopeProof | undefined;
  let proofRead = false;
  const scopeProof = () => {
    if (!proofRead) {
      proofRead = true;
      proof = manifestScopeProof(originalCode, new Set([...routeLiterals, ...helperLiterals].map(literal => literal.index)), withinBudget);
    }
    return proof;
  };
  const syntax = maskJavascriptTokens(code, tokens);
  const scopeDepth = new Uint16Array(syntax.length + 1);
  let depth = 0;
  for (let index = 0; index < syntax.length; index++) {
    scopeDepth[index] = depth;
    if (syntax[index] === "{") depth++;
    else if (syntax[index] === "}") depth = Math.max(0, depth - 1);
  }
  // This cheap lookup only joins candidate templates. Its values are never
  // published until a rendered navigation collection passes the scope proof.
  const constants = new Map<string, Set<string>>();
  const assignmentPattern = new RegExp(`(?:^|[;,{}]|\\b(?:const|let|var))\\s*(${JS_IDENTIFIER})\\s*=\\s*$`);
  for (const match of literals) {
    if (!withinBudget()) return;
    const assignment = assignmentPattern.exec(code.slice(Math.max(0, match.index - 100), match.index));
    if (!assignment || scopeDepth[match.index] !== 0 || !/^\s*[,;})]/.test(code.slice(match.index + match[0].length, match.index + match[0].length + 12))) continue;
    const decoded = decodeJsLiteral(match[0]);
    if (decoded === undefined) continue;
    const values = constants.get(assignment[1]) ?? new Set<string>();
    values.add(decoded);
    constants.set(assignment[1], values);
  }
  const prefixValue = (binding: string) => {
    const values = constants.get(binding);
    return values?.size === 1 ? [...values][0] : undefined;
  };
  interface PrefixCheck { binding: string; position: number; expected: string }
  const validPrefix = (check: PrefixCheck | undefined) => !check || scopeProof()?.prefix(check.binding, check.position) === check.expected;
  const routes: { prefix: string; key: string; check?: PrefixCheck }[] = [];
  const routeKeys = new Set<string>();
  for (const match of routeLiterals) {
    if (!withinBudget()) return;
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
    routes.push({ prefix: resolved, key, ...(template ? { check: { binding: template[1], position: match.index, expected: prefix } } : {}) });
  }
  for (const route of routes) {
    if (!withinBudget()) return;
    let helper: string | undefined;
    let helperCheck: PrefixCheck | undefined;
    for (const match of helperLiterals) {
      if (!withinBudget()) return;
      const before = code.slice(Math.max(0, match.index! - 160), match.index);
      const ordinary = new RegExp(`\\bfunction\\s+(${JS_IDENTIFIER})\\s*\\(\\s*(${JS_IDENTIFIER})\\s*\\)\\s*\\{\\s*return\\s*$`).exec(before);
      const arrow = new RegExp(`(?:^|[;,{}]|\\b(?:const|let|var))\\s*(${JS_IDENTIFIER})\\s*=\\s*(?:\\(\\s*(${JS_IDENTIFIER})\\s*\\)|(${JS_IDENTIFIER}))\\s*=>\\s*(\\{\\s*return\\s*)?$`).exec(before);
      if (!ordinary && !arrow) continue;
      const declaration = ordinary ? [ordinary[0], ordinary[1], ordinary[2]] : [arrow![0], arrow![1], arrow![2] ?? arrow![3]];
      const helperName = escapePattern(declaration[1]);
      const helperWrites = [...syntax.matchAll(new RegExp(`\\b${helperName}\\s*=(?![=>])`, "g"))];
      const helperFunctions = [...syntax.matchAll(new RegExp(`\\bfunction\\s+${helperName}\\s*\\(`, "g"))];
      if (helperWrites.length !== (ordinary ? 0 : 1) || helperFunctions.length !== (ordinary ? 1 : 0)) continue;
      const suffix = code.slice(match.index! + match[0].length, match.index! + match[0].length + 12);
      if (ordinary || arrow?.[4]) {
        if (!/^\s*;?\s*}/.test(suffix)) continue;
      } else if (!/^\s*(?:[,;}]|$)/.test(suffix)) continue;
      const contents = match[0].slice(1, -1);
      const variable = new RegExp(`^\\$\\{(${JS_IDENTIFIER})\\}/\\$\\{${escapePattern(declaration[2])}\\}$`).exec(contents);
      const literal = contents.endsWith(`/\${${declaration[2]}}`) ? contents.slice(0, -(`/\${${declaration[2]}}`.length)) : undefined;
      const helperPrefix = variable ? prefixValue(variable[1]) : literal;
      if (helperPrefix?.replace(/\/$/, "") !== route.prefix) continue;
      const navigation = new RegExp(`\\b(?:to|href)\\s*:\\s*${escapePattern(declaration[1])}\\s*\\(\\s*${JS_IDENTIFIER}\\.${escapePattern(route.key)}\\s*\\)`);
      if (navigation.test(syntax)) {
        helper = declaration[1];
        if (variable) helperCheck = { binding: variable[1], position: match.index, expected: helperPrefix! };
        break;
      }
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
              const body = syntax.slice(begin + 1, finish);
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
      if (!stableNavigationCollection(syntax, aliases, withinBudget)) continue;
      const rendered = [...aliases].some(alias => {
        if (!withinBudget()) return false;
        for (const map of syntax.matchAll(new RegExp(`\\b${escapePattern(alias)}\\.map\\s*\\(`, "g"))) {
          if (!withinBudget()) return false;
          const begin = map.index! + map[0].lastIndexOf("(");
          const finish = closingDelimiter(syntax, begin, "(", ")");
          const body = syntax.slice(begin + 1, finish);
          const callback = new RegExp(`^\\s*\\(?\\s*(${JS_IDENTIFIER})(?:\\s*,\\s*${JS_IDENTIFIER})?\\s*\\)?\\s*=>`).exec(body);
          if (finish >= 0 && callback && new RegExp(`\\b(?:to|href)\\s*:\\s*${escapePattern(helper!)}\\s*\\(\\s*${escapePattern(callback[1])}\\.${escapePattern(route.key)}\\s*\\)`).test(body)) return true;
          if (finish < 0 || !callback || !groupedAliases.has(alias)) continue;
          const pagesMap = new RegExp(`\\b${escapePattern(callback[1])}\\.pages\\.map\\s*\\(\\s*\\(?\\s*(${JS_IDENTIFIER})(?:\\s*,\\s*${JS_IDENTIFIER})?\\s*\\)?\\s*=>`, "g");
          for (const nested of body.matchAll(pagesMap)) {
            const nestedBegin = begin + 1 + nested.index! + nested[0].indexOf("(");
            const nestedEnd = closingDelimiter(syntax, nestedBegin, "(", ")");
            if (nestedEnd >= 0 && new RegExp(`\\b(?:to|href)\\s*:\\s*${escapePattern(helper!)}\\s*\\(\\s*${escapePattern(nested[1])}\\.${escapePattern(route.key)}\\s*\\)`).test(syntax.slice(nestedBegin, nestedEnd + 1))) return true;
          }
        }
        return false;
      });
      if (!rendered) continue;
      if (!validPrefix(route.check) || !validPrefix(helperCheck)) continue;
      for (const match of values) {
        const value = decodeJsLiteral(match[0]);
        if (!value || !concreteValue(value) || /[/?#]/.test(value)) continue;
        if (!/^\s*[,}]/.test(code.slice(match.index! + match[0].length, match.index! + match[0].length + 12))) continue;
        context.urls.add(`${route.prefix}/${value}`);
      }
    }
  }
}
