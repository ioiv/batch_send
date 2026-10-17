import { parse } from "@babel/parser";
import { decodeJsLiteral, javascriptTokens } from "./website-path-javascript.js";

export type ScriptPathEvidenceKind = "request" | "navigation" | "route" | "import";
export interface ScriptPathEvidence { url: string; kind: ScriptPathEvidenceKind; clientRoute?: boolean; method?: string; documentRelative?: true; workerContext?: true }
export interface WebsiteScriptPathOptions {
  deadline?: number;
  signal?: AbortSignal;
  /** Unread trailing source may contain writes or declarations that change bindings. */
  truncated?: boolean;
  maxDurationMs?: number;
  maxNodes?: number;
  maxBytes?: number;
}
export interface WebsiteScriptPathResult {
  candidates: ScriptPathEvidence[];
  partial: boolean;
  warnings: string[];
  suppressedLiteralOffsets: number[];
}

// Babel owns JavaScript syntax. This layer only interprets a small, side-effect-free
// string language and proven browser request contexts; it never evaluates source.
type Node = { type: string; start?: number | null; end?: number | null; [key: string]: any };
interface Scope { parent?: Scope; functionScope: boolean; owner?: Node; bindings: Map<string, Binding> }
interface Binding { name: string; scope: Scope; node: Node; init?: Node; fn?: Node; constant: boolean; invalid: boolean; imported?: string }
interface Value { text: string; literals: Set<number> }
interface ArgumentReference { node?: Node; scope: Scope; values: Map<Binding, Value>; arguments: Map<Binding, ArgumentReference> }
type PropertyResult = { state: "value"; references: ArgumentReference[]; absent?: boolean } | { state: "absent" } | { state: "unknown" };
interface Sink { expression: Node; scope: Scope; kind: "request" | "navigation"; call: Node; options?: Node; methodExpression?: Node; fixedMethod?: string; defaultMethod?: string }
const DYNAMIC = "\u0000";
const METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ObjectMethod", "ClassMethod", "ClassPrivateMethod"]);
const MUTATORS = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "copyWithin", "fill"]);
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_NODES = 1000000;
const MAX_CANDIDATES = 2000;
const MAX_IMPORT_CANDIDATES = 2000;
const MAX_VALUE = 4096;

function children(node: Node): Node[] {
  const found: Node[] = [];
  for (const key of Object.keys(node)) {
    if (["loc", "extra", "tokens", "comments", "errors"].includes(key)) continue;
    const value: unknown = node[key];
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item === "object" && typeof item.type === "string") found.push(item as Node);
    } else if (value && typeof value === "object" && "type" in value && typeof value.type === "string") found.push(value as Node);
  }
  return found;
}
function identifiers(pattern: Node | undefined): Node[] {
  if (!pattern) return [];
  if (pattern.type === "Identifier") return [pattern];
  if (pattern.type === "AssignmentPattern") return identifiers(pattern.left);
  if (pattern.type === "RestElement") return identifiers(pattern.argument);
  if (pattern.type === "ArrayPattern") return pattern.elements.flatMap((item: Node) => identifiers(item));
  if (pattern.type === "ObjectPattern") return pattern.properties.flatMap((item: Node) => identifiers(item.type === "RestElement" ? item.argument : item.value));
  return [];
}
function member(node: Node | undefined): string | undefined {
  if (!node || !["MemberExpression", "OptionalMemberExpression"].includes(node.type)) return;
  return !node.computed && node.property?.type === "Identifier" ? node.property.name : node.computed && node.property?.type === "StringLiteral" ? node.property.value : undefined;
}
function untyped(node: Node | undefined): Node | undefined {
  while (node && ["TSAsExpression", "TSTypeAssertion", "TSNonNullExpression", "ParenthesizedExpression"].includes(node.type)) node = node.expression;
  return node;
}
function property(node: Node | undefined, key: string): Node | undefined {
  node = untyped(node);
  if (node?.type !== "ObjectExpression") return;
  const values = node.properties.filter((item: Node) => item.type === "ObjectProperty" && !item.computed && (item.key?.name ?? item.key?.value) === key);
  return values.length === 1 ? values[0].value : undefined;
}
function pathname(value: string, kind: ScriptPathEvidenceKind): string | undefined {
  const path = value.split(/[?#]/, 1)[0];
  if (!path || path.length > 2048 || /[\u0000-\u0020\u007f\\{}<>]/.test(path)) return;
  if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^https?:\/\//i.test(path)) return;
  if (kind === "import" && !/^(?:\.?\.?\/|https?:\/\/)/i.test(path)) return;
  let decoded: string;
  try { decoded = decodeURIComponent(path); } catch { return; }
  if (/[\u0000-\u001f\u007f\\{}<>*]/.test(decoded) || /(?:^|\/):[a-z_$]|\[(?:\[|\.\.\.)?[\w$]+\]?\]/i.test(decoded)) return;
  return path;
}

/** Extract URLs with syntax evidence, preserving lexical scope and invalidating writes. */
export function extractWebsiteScriptPaths(source: string, options: WebsiteScriptPathOptions = {}): WebsiteScriptPathResult {
  const candidates = new Map<string, ScriptPathEvidence>();
  const requestOrder = new WeakMap<ScriptPathEvidence, number>();
  let emissionOrder = Infinity;
  const candidateCounts = { paths: 0, imports: 0 };
  const warnings = new Set<string>();
  const suppressed = new Set<number>();
  const started = performance.now();
  const defaultDuration = source.length > 1024 * 1024 ? 5000 : source.length > 512 * 1024 ? 4000 : 2000;
  const duration = Math.min(Math.max(options.maxDurationMs ?? defaultDuration, 1), 5000);
  // The 4 MiB document allowance includes compiled wallet SDKs larger than the
  // app entry. A single 350k-node ceiling discarded a complete 1.9 MiB / 434k-node
  // published bundle. Size tiers bound analysis while allowing that real input.
  const defaultNodes = source.length > 2.5 * 1024 * 1024 ? MAX_NODES : source.length > 1024 * 1024 ? 700000 : 350000;
  const maxNodes = Math.min(Math.max(options.maxNodes ?? defaultNodes, 1), MAX_NODES);
  const maxBytes = Math.min(Math.max(options.maxBytes ?? MAX_BYTES, 1), MAX_BYTES);
  let stopped = false;
  const budget = () => {
    if (stopped) return false;
    if (options.signal?.aborted) warnings.add("脚本语法分析已取消，已保留确认结果");
    else if (performance.now() - started >= duration || (options.deadline !== undefined && Date.now() >= options.deadline)) warnings.add("达到脚本语法分析时间上限，已保留确认结果");
    else return true;
    stopped = true;
    return false;
  };
  const finish = (): WebsiteScriptPathResult => ({ candidates: [...candidates.values()].sort((left, right) => {
    const rank = (kind: ScriptPathEvidenceKind) => kind === "import" ? 0 : kind === "request" ? 1 : 2;
    return rank(left.kind) - rank(right.kind) || (left.kind === "request" && right.kind === "request" ? (requestOrder.get(left) ?? Infinity) - (requestOrder.get(right) ?? Infinity) : 0);
  }), partial: warnings.size > 0, warnings: [...warnings], suppressedLiteralOffsets: [...suppressed].sort((a, b) => a - b) });
  const emit = (value: Value | undefined, kind: ScriptPathEvidenceKind, clientRoute = false, method?: string, documentRelative = false, workerContext = false) => {
    if (!value) return;
    const url = pathname(value.text, kind);
    if (!url) return;
    const key = `${kind}:${url}:${method ?? ""}:${documentRelative}:${workerContext}`;
    const quota = kind === "import" ? "imports" : "paths";
    const limit = quota === "imports" ? MAX_IMPORT_CANDIDATES : MAX_CANDIDATES;
    if (!candidates.has(key)) {
      if (candidateCounts[quota] >= limit) {
        if (kind === "request") {
          const lowerPriority = [...candidates].find(([, candidate]) => candidate.kind === "navigation" || candidate.kind === "route");
          if (lowerPriority) {
            candidates.delete(lowerPriority[0]);
            candidateCounts.paths--;
            warnings.add("脚本路径达到数量上限，优先保留明确请求路径");
          }
        }
      }
      if (candidateCounts[quota] >= limit) {
        warnings.add(quota === "imports" ? "达到脚本模块导入候选数量上限，已保留请求路径" : "达到脚本路径候选数量上限");
        return;
      }
      candidateCounts[quota]++;
    }
    const order = Math.min(requestOrder.get(candidates.get(key)!) ?? Infinity, emissionOrder);
    const candidate: ScriptPathEvidence = { url, kind, ...(clientRoute ? { clientRoute: true } : {}), ...(method ? { method } : {}), ...(documentRelative ? { documentRelative: true as const } : {}), ...(workerContext ? { workerContext: true as const } : {}) };
    requestOrder.set(candidate, order);
    candidates.set(key, candidate);
    for (const offset of value.literals) suppressed.add(offset);
  };
  if (!budget()) return finish();
  const oversized = source.length > maxBytes || Buffer.byteLength(source, "utf8") > maxBytes;
  if (oversized) {
    // Slicing code units first also bounds allocation for a direct caller that
    // supplies more text than the network reader normally permits.
    source = Buffer.from(source.slice(0, maxBytes), "utf8").subarray(0, maxBytes).toString("utf8");
    warnings.add("达到脚本语法文档读取上限，仅恢复独立完整的请求字面量与模块导入");
  }
  if (options.truncated) warnings.add("脚本文档已截断，仅恢复独立完整的请求字面量与模块导入");
  // Keep independent complete evidence before spending the AST budget. Large or
  // broken bundles must still expose their imports and explicit literal requests.
  // These candidates are used only when the full scope analysis cannot finish.
  const basic: { value: Value; kind: ScriptPathEvidenceKind }[] = [];
  const basicWarnings = new Set<string>();
  recoverLiterals(source, (resolved, kind) => {
    if (resolved) basic.push({ value: resolved, kind });
  }, budget, warning => basicWarnings.add(warning));
  const partialFinish = () => {
    for (const warning of basicWarnings) warnings.add(warning);
    for (const evidence of basic) emit(evidence.value, evidence.kind);
    return finish();
  };
  if (oversized || options.truncated) return partialFinish();
  if (!budget()) return partialFinish();
  let ast: Node;
  try {
    ast = parse(source, { sourceType: "unambiguous", errorRecovery: true, createImportExpressions: true, plugins: ["jsx"], allowReturnOutsideFunction: true }) as unknown as Node;
  } catch {
    warnings.add("脚本语法不完整，仅恢复独立完整的请求字面量与模块导入");
    return partialFinish();
  }
  if (ast.errors?.length) warnings.add("脚本包含可恢复的语法错误");
  if (!budget()) return partialFinish();
  const root: Scope = { functionScope: true, bindings: new Map() };
  const scopes = new Map<Node, Scope>();
  const all: Node[] = [];
  const parent = new Map<Node, Node>();
  const fnScopes = new Map<Node, Scope>();
  const bind = (scope: Scope, id: Node, node: Node, constant: boolean, init?: Node, fn?: Node, imported?: string) => {
    const existing = scope.bindings.get(id.name);
    if (existing) { existing.invalid = true; return existing; }
    const binding: Binding = { name: id.name, scope, node, constant, invalid: false, ...(init ? { init } : {}), ...(fn ? { fn } : {}), ...(imported ? { imported } : {}) };
    scope.bindings.set(id.name, binding);
    return binding;
  };
  const lookup = (scope: Scope, name: string): Binding | undefined => {
    for (let current: Scope | undefined = scope; current; current = current.parent) {
      const binding = current.bindings.get(name);
      if (binding) return binding;
    }
  };
  const stack: { node: Node; scope: Scope; parent?: Node }[] = [{ node: ast, scope: root }];
  while (stack.length) {
    if (all.length >= maxNodes) { warnings.add("达到脚本语法节点上限，未推断不完整常量或包装函数"); return partialFinish(); }
    if (all.length % 256 === 0 && !budget()) return partialFinish();
    const item = stack.pop()!;
    const node = item.node;
    let scope = item.scope;
    if (item.parent) parent.set(node, item.parent);
    if (node.type === "FunctionDeclaration" && node.id) bind(scope, node.id, node, true, undefined, node);
    if (node.type === "ClassDeclaration" && node.id) bind(scope, node.id, node, false);
    if (FUNCTIONS.has(node.type)) {
      scope = { parent: scope, functionScope: true, owner: node, bindings: new Map() };
      fnScopes.set(node, scope);
      if (node.type === "FunctionExpression" && node.id) bind(scope, node.id, node, true, undefined, node);
      for (const parameter of node.params ?? []) for (const id of identifiers(parameter)) bind(scope, id, parameter, false);
    } else if (["BlockStatement", "CatchClause", "ForStatement", "ForOfStatement", "ForInStatement", "SwitchStatement"].includes(node.type)) {
      scope = { parent: scope, functionScope: false, owner: scope.owner, bindings: new Map() };
      if (node.type === "CatchClause") for (const id of identifiers(node.param)) bind(scope, id, node, false);
    }
    scopes.set(node, scope);
    all.push(node);
    if (node.type === "VariableDeclaration") {
      let owner = scope;
      if (node.kind === "var") while (!owner.functionScope && owner.parent) owner = owner.parent;
      for (const declaration of node.declarations) for (const id of identifiers(declaration.id)) {
        const simple = declaration.id.type === "Identifier";
        bind(owner, id, declaration, node.kind === "const", simple ? declaration.init : undefined, simple && FUNCTIONS.has(declaration.init?.type) ? declaration.init : undefined);
      }
    }
    if (node.type === "ImportDeclaration") for (const specifier of node.specifiers) bind(scope, specifier.local, specifier, true, undefined, undefined, node.source.value);
    const nested = children(node);
    for (let index = nested.length - 1; index >= 0; index--) stack.push({ node: nested[index], scope, parent: node });
  }
  const changedGlobals = new Set<string>();
  const globalBrowserObject = (node: Node | undefined, scope: Scope) => node?.type === "Identifier" && ["window", "globalThis", "self"].includes(node.name) && !lookup(scope, node.name);
  const navigationAssignment = (node: Node, scope: Scope) => {
    const location = (item: Node | undefined) => item?.type === "Identifier" && item.name === "location" && !lookup(scope, "location")
      || member(item) === "location" && globalBrowserObject(item?.object, scope);
    return location(node) || member(node) === "href" && location(node.object);
  };
  const invalidateTarget = (node: Node | undefined, scope: Scope) => {
    if (!node) return;
    if (["MemberExpression", "OptionalMemberExpression"].includes(node.type)) {
      let base = node.object;
      while (base && ["MemberExpression", "OptionalMemberExpression"].includes(base.type)) base = base.object;
      if (base?.type === "Identifier") {
        const binding = lookup(scope, base.name);
        if (binding) binding.invalid = true;
        else if (["window", "globalThis", "self"].includes(base.name)) {
          let api = node;
          while (api.object !== base && api.object) api = api.object;
          const name = member(api);
          if (name) changedGlobals.add(name);
        } else changedGlobals.add(base.name);
      }
    }
    for (const id of identifiers(node)) {
      const binding = lookup(scope, id.name);
      if (binding) binding.invalid = true;
      else changedGlobals.add(id.name);
    }
  };
  // All writes are collected before resolving anything, including writes after a call.
  for (let index = 0; index < all.length; index++) {
    if (index % 256 === 0 && !budget()) return partialFinish();
    const node = all[index], scope = scopes.get(node)!;
    if (node.type === "AssignmentExpression" && !(node.operator === "=" && navigationAssignment(node.left, scope))) invalidateTarget(node.left, scope);
    if (node.type === "UpdateExpression") invalidateTarget(node.argument, scope);
    if (node.type === "UnaryExpression" && node.operator === "delete") invalidateTarget(node.argument, scope);
    if (["CallExpression", "OptionalCallExpression"].includes(node.type) && MUTATORS.has(member(node.callee) ?? "")) invalidateTarget(node.callee.object, scope);
    // A route object/array passed to unknown code, or aliased, could be changed.
    // Strings cannot be mutated through aliases and remain safe to resolve.
    if (node.type === "Identifier") {
      const binding = lookup(scope, node.name), owner = parent.get(node);
      if (binding?.init && ["ArrayExpression", "ObjectExpression"].includes(untyped(binding.init)?.type ?? "") && owner) {
        const routerCall = owner.type === "CallExpression" && owner.callee?.type === "Identifier"
          && ["createBrowserRouter", "createHashRouter", "createMemoryRouter", "useRoutes"].includes(owner.callee.name);
        const callee = owner.callee;
        const bareReader = callee?.type === "Identifier" && ["fetch", "Request"].includes(callee.name) && !lookup(scope, callee.name);
        const axiosReader = callee?.type === "Identifier" && (callee.name === "axios" && !lookup(scope, "axios") || lookup(scope, callee.name)?.imported === "axios")
          || ["request", ...METHODS].includes(member(callee) ?? "") && callee?.object?.type === "Identifier" && (callee.object.name === "axios" && !lookup(scope, "axios") || lookup(scope, callee.object.name)?.imported === "axios");
        const browserReader = ["fetch", "Request"].includes(member(callee) ?? "") && globalBrowserObject(callee.object, scope);
        const requestOptions = untyped(binding.init)?.type === "ObjectExpression" && (bareReader || axiosReader || browserReader);
        if (owner.type === "VariableDeclarator" && owner.init === node
          || ["ReturnStatement", "SpreadElement"].includes(owner.type)
          || ["CallExpression", "OptionalCallExpression", "NewExpression"].includes(owner.type) && owner.arguments.includes(node) && !routerCall && !requestOptions) binding.invalid = true;
      }
    }
  }
  const value = (text: string, literals: Iterable<number> = []): Value => ({ text, literals: new Set(literals) });
  const join = (left: Value, right: Value): Value | undefined => left.text.length + right.text.length <= MAX_VALUE ? value(left.text + right.text, [...left.literals, ...right.literals]) : undefined;
  let steps = 0;
  const evaluate = (input: Node | undefined, scope: Scope, substitutions = new Map<Binding, Value>(), seen = new Set<Binding>(), depth = 0): Value | undefined => {
    if (!input || depth > 32 || (++steps % 128 === 0 && !budget())) return;
    const node = untyped(input)!;
    if (node.type === "StringLiteral") return node.value.length <= MAX_VALUE ? value(node.value, node.start == null ? [] : [node.start]) : undefined;
    if (node.type === "Identifier") {
      const binding = lookup(scope, node.name);
      if (!binding || binding.invalid || seen.has(binding)) return value(DYNAMIC);
      const replacement = substitutions.get(binding);
      if (replacement) return replacement;
      if (!binding.constant || !binding.init) return value(DYNAMIC);
      // Lexical declarations used before initialization are not static evidence.
      if (binding.scope.owner === scope.owner && (binding.node.end ?? 0) > (node.start ?? Infinity)) return value(DYNAMIC);
      return evaluate(binding.init, scopes.get(binding.init) ?? binding.scope, substitutions, new Set([...seen, binding]), depth + 1);
    }
    if (node.type === "BinaryExpression" && node.operator === "+") {
      const left = evaluate(node.left, scope, substitutions, seen, depth + 1), right = evaluate(node.right, scope, substitutions, seen, depth + 1);
      return left && right ? join(left, right) : undefined;
    }
    if (node.type === "TemplateLiteral") {
      let result = value("");
      for (let index = 0; index < node.quasis.length; index++) {
        const quasi = node.quasis[index];
        const next = join(result, value(quasi.value.cooked ?? quasi.value.raw, quasi.start == null ? [] : [quasi.start]));
        if (!next) return;
        result = next;
        if (index < node.expressions.length) {
          const part = evaluate(node.expressions[index], scope, substitutions, seen, depth + 1) ?? value(DYNAMIC);
          const combined = join(result, part);
          if (!combined) return;
          result = combined;
        }
      }
      return result;
    }
    if (node.type === "LogicalExpression") {
      const left = evaluate(node.left, scope, substitutions, seen, depth + 1);
      if (!left || left.text.includes(DYNAMIC)) return value(DYNAMIC);
      if (node.operator === "||") return left.text ? left : evaluate(node.right, scope, substitutions, seen, depth + 1);
      if (node.operator === "&&") return left.text ? evaluate(node.right, scope, substitutions, seen, depth + 1) : left;
      if (node.operator === "??") return left;
    }
    if (node.type === "CallExpression" && member(node.callee) === "trim" && !node.arguments.length) {
      const inputValue = evaluate(node.callee.object, scope, substitutions, seen, depth + 1);
      if (inputValue && !inputValue.text.includes(DYNAMIC)) return value(inputValue.text.trim(), inputValue.literals);
    }
    return value(DYNAMIC);
  };
  // Conditional branches are observations of complete possible request strings.
  // Enumerate at most sixteen combinations; never guess a conditional value.
  const alternatives = (input: Node | undefined, scope: Scope, substitutions = new Map<Binding, Value>(), seen = new Set<Binding>(), depth = 0): Value[] => {
    const node = untyped(input);
    if (!node || depth > 16) return [value(DYNAMIC)];
    if (node.type === "ConditionalExpression") return [
      ...alternatives(node.consequent, scope, substitutions, seen, depth + 1),
      ...alternatives(node.alternate, scope, substitutions, seen, depth + 1),
    ].slice(0, 16);
    if (node.type === "Identifier") {
      const binding = lookup(scope, node.name);
      if (binding && !binding.invalid && binding.constant && binding.init && !substitutions.has(binding) && !seen.has(binding)) {
        if (binding.scope.owner === scope.owner && (binding.node.end ?? 0) > (node.start ?? Infinity)) return [value(DYNAMIC)];
        return alternatives(binding.init, scopes.get(binding.init) ?? binding.scope, substitutions, new Set([...seen, binding]), depth + 1);
      }
    }
    if (node.type === "BinaryExpression" && node.operator === "+") {
      const output: Value[] = [];
      for (const left of alternatives(node.left, scope, substitutions, seen, depth + 1)) {
        for (const right of alternatives(node.right, scope, substitutions, seen, depth + 1)) {
          const combined = join(left, right);
          if (combined) output.push(combined);
          if (output.length >= 16) return output;
        }
      }
      return output;
    }
    return [evaluate(node, scope, substitutions) ?? value(DYNAMIC)];
  };
  const resolveProperty = (reference: ArgumentReference, key: string, depth = 0, seen = new Set<Binding>()): PropertyResult => {
    if (depth > 24 || !budget()) return { state: "unknown" };
    const node = untyped(reference.node);
    if (!node || node.type === "NullLiteral") return { state: "absent" };
    if (node.type === "ConditionalExpression") {
      const branches = [node.consequent, node.alternate].map(branch => resolveProperty({ ...reference, node: branch }, key, depth + 1, seen));
      if (branches.some(branch => branch.state === "unknown")) return { state: "unknown" };
      const references = branches.flatMap(branch => branch.state === "value" ? branch.references : []);
      return references.length ? { state: "value", references: references.slice(0, 16), absent: branches.some(branch => branch.state === "absent" || branch.state === "value" && branch.absent) } : { state: "absent" };
    }
    if (node.type === "Identifier") {
      const binding = lookup(reference.scope, node.name);
      if (!binding || binding.invalid || seen.has(binding)) return { state: "unknown" };
      const replacement = reference.arguments.get(binding);
      if (replacement) return resolveProperty(replacement, key, depth + 1, new Set([...seen, binding]));
      if (!binding.constant || !binding.init) return { state: "unknown" };
      if (binding.scope.owner === reference.scope.owner && (binding.node.end ?? 0) > (node.start ?? Infinity)) return { state: "unknown" };
      return resolveProperty({ ...reference, node: binding.init, scope: scopes.get(binding.init) ?? binding.scope }, key, depth + 1, new Set([...seen, binding]));
    }
    if (node.type !== "ObjectExpression") return { state: "unknown" };
    // Later spreads/properties win. Unknown spreads after an explicit method
    // prevent claiming that method; an explicit final property is authoritative.
    const possible: ArgumentReference[] = [];
    for (let index = node.properties.length - 1; index >= 0; index--) {
      const field = node.properties[index];
      if (field.type === "SpreadElement") {
        const result = resolveProperty({ ...reference, node: field.argument }, key, depth + 1, seen);
        if (result.state === "unknown") return result;
        if (result.state === "value") {
          possible.push(...result.references);
          if (!result.absent) return { state: "value", references: possible.slice(0, 16) };
        }
      } else {
        const name = !field.computed ? field.key?.name ?? field.key?.value : field.key?.type === "StringLiteral" ? field.key.value : undefined;
        if (name === undefined) return { state: "unknown" };
        if (name === key) return field.type === "ObjectProperty"
          ? { state: "value", references: [...possible, { ...reference, node: field.value }].slice(0, 16) }
          : { state: "unknown" };
      }
    }
    return possible.length ? { state: "value", references: possible.slice(0, 16), absent: true } : { state: "absent" };
  };
  const methodValues = (reference: ArgumentReference, depth = 0): string[] => {
    if (depth > 24 || !budget()) return [];
    const node = untyped(reference.node);
    if (!node) return [];
    if (["MemberExpression", "OptionalMemberExpression"].includes(node.type)) {
      const key = member(node);
      if (!key) return [];
      const result = resolveProperty({ ...reference, node: node.object }, key);
      return result.state === "value" && !result.absent ? [...new Set(result.references.flatMap(item => methodValues(item, depth + 1)))] : [];
    }
    const methods = alternatives(node, reference.scope, reference.values).map(item => item.text);
    if (methods.some(method => !/^[A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]{0,31}$/.test(method))) return [];
    return [...new Set(methods.map(method => method.toUpperCase()))];
  };
  const requestMethods = (sink: Sink, values: Map<Binding, Value>, args: Map<Binding, ArgumentReference>): (string | undefined)[] => {
    if (sink.kind !== "request") return [undefined];
    if (sink.fixedMethod) return [sink.fixedMethod];
    const reference: ArgumentReference = { scope: sink.scope, values, arguments: args };
    if (sink.methodExpression) {
      const methods = methodValues({ ...reference, node: sink.methodExpression });
      return methods.length ? methods : [undefined];
    }
    const result = resolveProperty({ ...reference, node: sink.options }, "method");
    if (result.state === "absent") return [sink.defaultMethod];
    if (result.state === "unknown") return [undefined];
    const groups = result.references.map(item => methodValues(item));
    if (groups.some(group => !group.length)) return [undefined];
    const methods = [...new Set([...groups.flat(), ...(result.absent && sink.defaultMethod ? [sink.defaultMethod] : [])])];
    return methods.length ? methods : [undefined];
  };
  const global = (scope: Scope, name: string) => !lookup(scope, name) && !changedGlobals.has(name);
  const browserObject = (node: Node | undefined, scope: Scope) => node?.type === "Identifier" && ["window", "globalThis", "self"].includes(node.name) && global(scope, node.name);
  const browserName = (node: Node | undefined, name: string, scope: Scope): boolean => node?.type === "Identifier" && node.name === name && global(scope, name)
    || member(node) === name && !changedGlobals.has(name) && browserObject(node?.object, scope);
  const axiosObject = (node: Node | undefined, scope: Scope): boolean => {
    if (node?.type !== "Identifier") return false;
    const binding = lookup(scope, node.name);
    return node.name === "axios" && global(scope, "axios") || binding?.imported === "axios" && !binding.invalid;
  };
  const locationObject = (node: Node | undefined, scope: Scope) => browserName(node, "location", scope);
  const importMetaUrl = (node: Node | undefined) => member(node) === "url" && node?.object?.type === "MetaProperty"
    && node.object.meta?.name === "import" && node.object.property?.name === "meta";
  const moduleUrlArgument = (node: Node | undefined, scope: Scope): { value: Value; documentRelative: boolean } | undefined => {
    if (node?.type === "NewExpression" && browserName(node.callee, "URL", scope)) {
      if (!importMetaUrl(node.arguments[1])) return;
      const resolved = evaluate(node.arguments[0], scope);
      return resolved ? { value: resolved, documentRelative: false } : undefined;
    }
    const resolved = evaluate(node, scope);
    if (!resolved) return;
    const absolute = /^(?:\/|\.\.?\/|[a-z][a-z\d+.-]*:)/i.test(resolved.text);
    return { value: absolute ? resolved : value(`./${resolved.text}`, resolved.literals), documentRelative: true };
  };
  const sinks = new Map<Node, Sink>();
  const calls: Node[] = [];
  const moduleSpecifiers: Value[] = [];
  const moduleSpecifier = (resolved: Value | undefined) => {
    if (!resolved) return;
    moduleSpecifiers.push(resolved);
    emit(resolved, "import");
  };
  const routes: { node: Node; scope: Scope }[] = [];
  const rejectRouteRoot = (node: Node | undefined, scope: Scope) => {
    if (node?.type !== "Identifier") return;
    const binding = lookup(scope, node.name);
    if (binding) binding.invalid = true;
  };
  for (let index = 0; index < all.length; index++) {
    if (index % 256 === 0 && !budget()) return partialFinish();
    const node = all[index], scope = scopes.get(node)!;
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) && node.source) moduleSpecifier(evaluate(node.source, scope));
    if (node.type === "ImportExpression") moduleSpecifier(evaluate(node.source, scope));
    if (node.type === "CallExpression" && node.callee?.type === "Import") moduleSpecifier(evaluate(node.arguments[0], scope));
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && /^(?:routes|ROUTES|Routes)$|(?:Routes|_routes|_ROUTES)$/.test(node.id.name)) {
      const binding = lookup(scope, node.id.name);
      if (binding?.constant && !binding.invalid) routes.push({ node: node.id, scope });
    }
    if (["CallExpression", "OptionalCallExpression", "NewExpression"].includes(node.type)) {
      calls.push(node);
      const callee = node.callee, method = member(callee);
      let expression: Node | undefined;
      let kind: Sink["kind"] = "request";
      let options: Node | undefined, methodExpression: Node | undefined, fixedMethod: string | undefined, defaultMethod: string | undefined;
      if (browserName(callee, "fetch", scope) || browserName(callee, "Request", scope)) {
        expression = node.arguments[0]; options = node.arguments[1]; defaultMethod = "GET";
      } else if (axiosObject(callee, scope)) {
        expression = property(node.arguments[0], "url") ?? node.arguments[0];
        options = node.arguments[0]?.type === "ObjectExpression" ? node.arguments[0] : node.arguments[1]; defaultMethod = "GET";
      } else if (method && METHODS.has(method) && axiosObject(callee.object, scope)) {
        expression = node.arguments[0]; fixedMethod = method.toUpperCase();
      } else if (method === "request" && axiosObject(callee.object, scope)) {
        expression = property(node.arguments[0], "url"); options = node.arguments[0]; defaultMethod = "GET";
      }
      else if (method === "open" && callee.object?.type === "Identifier") {
        const binding = lookup(scope, callee.object.name);
        if (binding && !binding.invalid && binding.init?.type === "NewExpression" && browserName(binding.init.callee, "XMLHttpRequest", scopes.get(binding.init)!)) {
          expression = node.arguments[1]; methodExpression = node.arguments[0];
        }
      }
      if (!expression && ["assign", "replace"].includes(method ?? "") && locationObject(callee.object, scope)) { expression = node.arguments[0]; kind = "navigation"; }
      if (!expression && ["pushState", "replaceState"].includes(method ?? "") && browserName(callee.object, "history", scope)) { expression = node.arguments[2]; kind = "navigation"; }
      if (expression) sinks.set(node, { expression, scope, kind, call: node, options, methodExpression, fixedMethod, defaultMethod });
      if (node.type === "NewExpression" && (browserName(callee, "Worker", scope) || browserName(callee, "SharedWorker", scope))) {
        const worker = moduleUrlArgument(node.arguments[0], scope);
        if (worker) emit(worker.value, "import", false, undefined, worker.documentRelative, true);
      }
      if (method === "register" && member(callee.object) === "serviceWorker" && browserName(callee.object.object, "navigator", scope)) {
        const worker = moduleUrlArgument(node.arguments[0], scope);
        if (worker) emit(worker.value, "import", false, undefined, worker.documentRelative, true);
      }
      if (browserName(callee, "importScripts", scope)) {
        for (const argument of node.arguments) for (const item of alternatives(argument, scope)) {
          // importScripts accepts relative URLs without the module-specifier rules.
          const relative = item.text.startsWith("/") || /^https?:\/\//i.test(item.text) || item.text.startsWith(".") ? item : value(`./${item.text}`, item.literals);
          emit(relative, "import", false, undefined, true);
        }
      }
      if (["jsx", "jsxs", "jsxDEV", "createElement"].includes(callee?.name ?? method ?? "")) {
        const element = node.arguments[0], tag = element?.type === "StringLiteral" ? element.value : element?.type === "Identifier" ? element.name : undefined;
        if (["a", "Link", "NavLink"].includes(tag)) {
          const target = property(node.arguments[1], tag === "a" ? "href" : "to") ?? property(node.arguments[1], "href");
          if (target) for (const item of alternatives(target, scope)) emit(item, "navigation");
        }
      }
      if (callee?.type === "Identifier" && ["createBrowserRouter", "createHashRouter", "createMemoryRouter", "useRoutes"].includes(callee.name)) {
        if (callee.name === "createBrowserRouter" && node.arguments.length === 1) routes.push({ node: node.arguments[0], scope });
        else rejectRouteRoot(node.arguments[0], scope);
      }
      if (callee?.type === "Identifier" && ["createRouter", "Router", "VueRouter"].includes(callee.name)) {
        const table = property(node.arguments[0], "routes");
        const history = property(node.arguments[0], "history");
        const rootHistory = history?.type === "CallExpression" && history.callee?.type === "Identifier" && history.callee.name === "createWebHistory" && history.arguments.length === 0;
        if (table && callee.name === "createRouter" && rootHistory) routes.push({ node: table, scope });
        else rejectRouteRoot(table, scope);
      }
      if (["forRoot", "forChild"].includes(method ?? "") && callee.object?.type === "Identifier" && callee.object.name === "RouterModule") {
        if (method === "forRoot" && node.arguments.length === 1) routes.push({ node: node.arguments[0], scope });
        else rejectRouteRoot(node.arguments[0], scope);
      }
    }
    if (node.type === "AssignmentExpression" && node.operator === "=" && (locationObject(node.left, scope) || member(node.left) === "href" && locationObject(node.left.object, scope))) emit(evaluate(node.right, scope), "navigation");
    if (node.type === "JSXAttribute" && ["href", "to"].includes(node.name?.name)) {
      const opening = parent.get(node), tag = opening?.name?.name;
      if (["a", "Link", "NavLink"].includes(tag)) emit(evaluate(node.value?.type === "JSXExpressionContainer" ? node.value.expression : node.value, scope), "navigation");
    }
  }
  const functionCalls = new Map<Node, Node[]>();
  for (const call of calls) {
    const owner = scopes.get(call)?.owner;
    if (owner) { const list = functionCalls.get(owner) ?? []; list.push(call); functionCalls.set(owner, list); }
  }
  // A wrapper is proven by its own request sink, or one transparent helper call.
  // Bindings, rather than names, keep minified repeated parameters and shadowing distinct.
  const expand = (call: Node, substitutions: Map<Binding, Value>, depth: number, active: Set<Node>, argumentReferences = new Map<Binding, ArgumentReference>()): boolean => {
    if (depth > 2 || active.has(call) || !budget()) return false;
    const sink = sinks.get(call);
    if (sink) {
      const paths = alternatives(sink.expression, sink.scope, substitutions).filter(item => pathname(item.text, sink.kind));
      // SDK wrappers often receive runtime-only URLs. Resolve options only for
      // concrete path evidence, keeping the application request budget available.
      if (!paths.length) return true;
      const methods = requestMethods(sink, substitutions, argumentReferences);
      for (const item of paths) for (const method of methods) emit(item, sink.kind, false, method);
      return true;
    }
    const scope = scopes.get(call)!;
    if (call.callee?.type !== "Identifier") return false;
    const binding = lookup(scope, call.callee.name);
    if (!binding?.fn || binding.invalid || !binding.constant) return false;
    const fn = binding.fn, fnScope = fnScopes.get(fn)!;
    let replacements = [new Map(substitutions)];
    const nextReferences = new Map(argumentReferences);
    for (let index = 0; index < (fn.params?.length ?? 0); index++) {
      const parameter = fn.params[index];
      const identifier = parameter.type === "AssignmentPattern" ? parameter.left : parameter;
      if (identifier.type !== "Identifier") continue;
      const parameterBinding = fnScope.bindings.get(identifier.name);
      if (!parameterBinding || parameterBinding.invalid) return false;
      const input = call.arguments[index] ?? (parameter.type === "AssignmentPattern" ? parameter.right : undefined);
      const inputScope = call.arguments[index] ? scope : fnScope;
      nextReferences.set(parameterBinding, { node: input, scope: inputScope, values: substitutions, arguments: argumentReferences });
      const next: Map<Binding, Value>[] = [];
      for (const replacement of replacements) for (const item of alternatives(input, inputScope, substitutions)) {
        const mapped = new Map(replacement);
        mapped.set(parameterBinding, item);
        next.push(mapped);
        if (next.length >= 16) break;
      }
      replacements = next.slice(0, 16);
    }
    let proven = false;
    const seen = new Set([...active, call]);
    for (const replacement of replacements) for (const nested of functionCalls.get(fn) ?? []) if (expand(nested, replacement, depth + 1, seen, nextReferences)) proven = true;
    return proven;
  };
  const priorityCalls = calls.map((call, index) => {
    const argument = untyped(call.arguments[0]);
    const prefix = argument?.type === "StringLiteral" ? argument.value : argument?.type === "TemplateLiteral" ? argument.quasis[0]?.value?.cooked : "";
    const priority = typeof prefix === "string" && /^(?:\/|\.\.?\/|https?:\/\/)/i.test(prefix) ? 2 : sinks.has(call) ? 1 : 0;
    return { call, index, priority };
  }).sort((left, right) => right.priority - left.priority || left.index - right.index);
  for (let index = 0; index < priorityCalls.length; index++) {
    if (index % 128 === 0 && !budget()) return partialFinish();
    emissionOrder = priorityCalls[index].call.start ?? Infinity;
    expand(priorityCalls[index].call, new Map(), 0, new Set());
  }
  // A standard Vite helper is a compact published dependency manifest. Only
  // integer indices used by actual helper calls count as imports. Relative table
  // prefixes are anchored to matching real import specifiers from this module.
  const moduleAnchors = new Map<string, Set<string>>();
  for (const specifier of moduleSpecifiers) {
    const path = specifier.text.split(/[?#]/, 1)[0], slash = path.lastIndexOf("/");
    if (!/^\.\.?\//.test(path)) continue;
    const basename = path.slice(slash + 1), prefixes = moduleAnchors.get(basename) ?? new Set<string>();
    prefixes.add(path.slice(0, slash + 1));
    moduleAnchors.set(basename, prefixes);
  }
  for (const node of all) {
    if (node.type !== "VariableDeclarator" || node.id?.name !== "__vite__mapDeps" || !budget()) continue;
    const scope = scopes.get(node)!;
    const binding = lookup(scope, node.id.name), fn = untyped(node.init);
    if (!binding?.constant || binding.invalid || fn?.type !== "ArrowFunctionExpression" || fn.params.length !== 3) continue;
    const [indices, owner, table] = fn.params;
    if (indices.type !== "Identifier" || owner.type !== "AssignmentPattern" || owner.left.type !== "Identifier" || owner.right.type !== "Identifier" || owner.right.name !== binding.name
      || table.type !== "AssignmentPattern" || table.left.type !== "Identifier") continue;
    const cached = untyped(table.right), assignment = untyped(cached?.right);
    if (cached?.type !== "LogicalExpression" || cached.operator !== "||" || member(cached.left) !== "f" || cached.left.object?.name !== owner.left.name
      || assignment?.type !== "AssignmentExpression" || assignment.operator !== "=" || member(assignment.left) !== "f" || assignment.left.object?.name !== owner.left.name
      || assignment.right?.type !== "ArrayExpression" || assignment.right.elements.length > 5000) continue;
    const entries: Node[] = assignment.right.elements;
    if (entries.some(entry => entry?.type !== "StringLiteral")) continue;
    const body = untyped(fn.body), mapper = body?.arguments?.[0];
    if (body?.type !== "CallExpression" || member(body.callee) !== "map" || body.callee.object?.name !== indices.name || body.arguments.length !== 1
      || mapper?.type !== "ArrowFunctionExpression" || mapper.params.length !== 1 || mapper.params[0].type !== "Identifier"
      || mapper.body?.type !== "MemberExpression" || !mapper.body.computed || mapper.body.object?.name !== table.left.name || mapper.body.property?.name !== mapper.params[0].name) continue;
    let referencesRead = 0;
    const referencesSafe = all.every(reference => {
      if (++referencesRead % 512 === 0 && !budget()) return false;
      if (reference.type !== "Identifier" || reference.name !== binding.name || lookup(scopes.get(reference)!, reference.name) !== binding) return true;
      const ownerNode = parent.get(reference);
      return reference === node.id || reference === owner.right || ownerNode?.type === "CallExpression" && ownerNode.callee === reference;
    });
    if (!referencesSafe) continue;
    const anchors = new Map<string, Set<string>>();
    for (const entry of entries) {
      const tablePath = entry.value.split(/[?#]/, 1)[0], slash = tablePath.lastIndexOf("/");
      const tablePrefix = tablePath.slice(0, slash + 1), basename = tablePath.slice(slash + 1);
      for (const prefix of moduleAnchors.get(basename) ?? []) {
        const mapped = anchors.get(tablePrefix) ?? new Set<string>();
        mapped.add(prefix);
        anchors.set(tablePrefix, mapped);
      }
    }
    for (const call of calls) {
      if (call.type !== "CallExpression" || call.callee?.type !== "Identifier" || lookup(scopes.get(call)!, call.callee.name) !== binding || call.arguments.length !== 1 || call.arguments[0]?.type !== "ArrayExpression") continue;
      for (const index of call.arguments[0].elements) {
        if (index?.type !== "NumericLiteral" || !Number.isSafeInteger(index.value) || index.value < 0 || !entries[index.value]) continue;
        const entry = entries[index.value], path = entry.value.split(/[?#]/, 1)[0];
        if (!/\.(?:[cm]?js|jsx)$/i.test(path)) continue;
        if (/^(?:\/|https?:\/\/)/i.test(path)) { emit(value(path, [entry.start ?? 0]), "import"); continue; }
        const slash = path.lastIndexOf("/"), prefixes = anchors.get(path.slice(0, slash + 1));
        if (prefixes?.size !== 1) continue;
        emit(value(`${[...prefixes][0]}${path.slice(slash + 1)}`, [entry.start ?? 0]), "import");
      }
    }
  }
  const routeArray = (input: Node | undefined, scope: Scope, seen = new Set<Binding>(), depth = 0): Node | undefined => {
    if (depth > 64) { warnings.add("达到静态路由别名解析深度上限"); return; }
    if (!budget()) return;
    const node = untyped(input);
    if (node?.type === "ArrayExpression") return node;
    if (node?.type !== "Identifier") return;
    const binding = lookup(scope, node.name);
    if (!binding?.constant || binding.invalid || !binding.init || seen.has(binding)) return;
    return routeArray(binding.init, scopes.get(binding.init) ?? binding.scope, new Set([...seen, binding]), depth + 1);
  };
  const routeWalk = (input: Node | undefined, scope: Scope, prefix: string | undefined, depth = 0) => {
    if (depth > 32 || !budget()) return;
    const array = routeArray(input, scope);
    if (!array) return;
    for (const item of array.elements) {
      if (!item || item.type !== "ObjectExpression") continue;
      if (item.properties.some((field: Node) => field.type !== "ObjectProperty" || field.computed)) continue;
      const routePath = property(item, "path"), nested = property(item, "children");
      const resolved = routePath ? evaluate(routePath, scopes.get(routePath) ?? scope) : value("");
      let current: string | undefined;
      if (resolved && !resolved.text.includes(DYNAMIC) && !/[?#:*{}[\]\\]/.test(resolved.text) && !resolved.text.split("/").some(part => part === "." || part === "..")) {
        current = resolved.text.startsWith("/") ? resolved.text : prefix === undefined ? undefined : `${prefix.replace(/\/$/, "")}/${resolved.text}`;
        if (current && current !== "/" && routePath) emit(value(current, resolved.literals), "route", true);
      }
      if (nested) routeWalk(nested, scopes.get(nested) ?? scope, current, depth + 1);
    }
  };
  for (const route of routes) routeWalk(route.node, route.scope, "");
  return finish();
}

/** Syntax-error fallback: complete literal calls/imports only, never constant or wrapper guesses. */
function recoverLiterals(source: string, emit: (value: Value | undefined, kind: ScriptPathEvidenceKind) => void, budget: () => boolean, warn: (message: string) => void): void {
  interface Token { text: string; offset: number; literal?: string }
  const recent = new Array<Token>(128);
  let tokenCount = 0, braces = 0;
  let moduleStatement: { kind: "import" | "export"; stage: "start" | "clause" } | undefined;
  const pendingCalls: { value: Value; delimiters: string[]; expectSeparator: boolean; api?: string; kind: ScriptPathEvidenceKind }[] = [];
  const confirmedRequests = new Map<string, { value: Value; api: string; kind: ScriptPathEvidenceKind }>();
  const apis = new Set(["fetch", "Request", "axios", "require"]);
  const shadowed = new Set<string>();
  const opening: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  const previous = (distance: number) => distance <= Math.min(tokenCount, recent.length) ? recent[(tokenCount - distance) % recent.length] : undefined;
  const appendToken = (token: Token): boolean => {
    if (tokenCount % 256 === 0 && !budget()) return false;
    // Module declarations and balanced import() calls do not depend on runtime
    // variable bindings. Recover them without storing the whole token sequence;
    // bare fetch/axios evidence waits for the complete API-shadow scan below.
    const prior = previous(1);
    if (prior && apis.has(prior.text) && prior.literal === undefined) {
      const before = previous(2)?.text;
      if (["const", "let", "var", "function", "class", "import"].includes(before ?? "")
        || token.text !== "(" && !(prior.text === "axios" && token.text === ".") && before !== ".") shadowed.add(prior.text);
    }
    for (let index = pendingCalls.length - 1; index >= 0; index--) {
      const pending = pendingCalls[index];
      if (pending.expectSeparator) {
        if (![",", ")"].includes(token.text)) { pendingCalls.splice(index, 1); continue; }
        pending.expectSeparator = false;
      }
      if (token.literal !== undefined) continue;
      if (["(", "[", "{"].includes(token.text)) {
        if (pending.delimiters.length >= 256) {
          pendingCalls.splice(index, 1);
          warn("达到独立请求和模块恢复括号深度上限，已保留确认结果");
          continue;
        }
        pending.delimiters.push(token.text);
      } else if (Object.hasOwn(opening, token.text)) {
        const matches = pending.delimiters.pop() === opening[token.text];
        if (!matches || !pending.delimiters.length) {
          if (matches && !pending.api) emit(pending.value, pending.kind);
          else if (matches && pending.api) {
            const key = `${pending.api}:${pending.kind}:${pending.value.text}`;
            if (confirmedRequests.size < MAX_CANDIDATES || confirmedRequests.has(key)) confirmedRequests.set(key, { value: pending.value, api: pending.api, kind: pending.kind });
            else warn("达到独立请求字面量恢复数量上限，已保留确认结果");
          }
          pendingCalls.splice(index, 1);
        }
      }
    }
    if (moduleStatement) {
      if (moduleStatement.stage === "start") {
        if (moduleStatement.kind === "import" && token.literal !== undefined) {
          emit({ text: token.literal, literals: new Set([token.offset]) }, "import");
          moduleStatement = undefined;
        } else if (["{", "*"].includes(token.text) || moduleStatement.kind === "import" && /^[a-zA-Z_$][\w$]*$/.test(token.text)) moduleStatement.stage = "clause";
        else moduleStatement = undefined;
      } else if (token.literal !== undefined && previous(1)?.text === "from") {
        emit({ text: token.literal, literals: new Set([token.offset]) }, "import");
        moduleStatement = undefined;
      } else if (token.text === ";") moduleStatement = undefined;
    }
    if (token.literal !== undefined && previous(1)?.text === "(") {
      const name = previous(2)?.text;
      let kind: ScriptPathEvidenceKind | undefined, api: string | undefined;
      if (name === "import" && previous(3)?.text !== ".") kind = "import";
      else if (name && apis.has(name) && ![".", "?"].includes(previous(3)?.text ?? "")) { kind = name === "require" ? "import" : "request"; api = name; }
      else if (METHODS.has(name ?? "") && previous(3)?.text === "." && previous(4)?.text === "axios" && ![".", "?"].includes(previous(5)?.text ?? "")) { kind = "request"; api = "axios"; }
      if (kind) {
        if (pendingCalls.length < 64) pendingCalls.push({ value: { text: token.literal, literals: new Set([token.offset]) }, delimiters: ["("], expectSeparator: true, api, kind });
        else warn("达到独立请求和模块恢复嵌套上限，已保留确认结果");
      }
    }
    if (braces === 0 && ["import", "export"].includes(token.text) && previous(1)?.text !== ".") moduleStatement = { kind: token.text as "import" | "export", stage: "start" };
    if (token.literal === undefined) {
      if (token.text === "{") braces++;
      else if (token.text === "}") braces = Math.max(0, braces - 1);
    }
    recent[tokenCount % recent.length] = token;
    tokenCount++;
    return true;
  };
  const literals = javascriptTokens(source);
  if (!budget()) return;
  let offset = 0;
  const appendSyntax = (start: number, end: number) => {
    const syntax = /[a-zA-Z_$][\w$]*|[^\s]/g;
    syntax.lastIndex = start;
    let match: RegExpExecArray | null;
    while ((match = syntax.exec(source)) && match.index < end) {
      if (!appendToken({ text: match[0], offset: match.index })) return false;
    }
    return true;
  };
  for (const literal of literals) {
    if (!appendSyntax(offset, literal.index)) return;
    if (!literal.comment && !appendToken({ text: literal[0], offset: literal.index, literal: decodeJsLiteral(literal[0]) })) return;
    offset = literal.index + literal[0].length;
  }
  if (!appendSyntax(offset, source.length)) return;
  const final = previous(1);
  if (final && apis.has(final.text) && previous(2)?.text !== ".") shadowed.add(final.text);
  // An incomplete scan cannot rule out later API shadows. Only a complete scan
  // releases bare request evidence; module imports were safe to publish above.
  for (const request of confirmedRequests.values()) if (!shadowed.has(request.api)) emit(request.value, request.kind);
}
