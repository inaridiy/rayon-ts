/**
 * AST analysis for "use parallel" kernels.
 *
 * Finds outermost directive-marked functions, then runs a scope analysis over
 * each kernel body to classify every identifier reference as local, global, or
 * captured. Captured references get rewritten to `__env.name` when the kernel
 * is extracted for workers; illegal constructs (assigning to captures, `this`,
 * async, JSX, ...) become compile-time diagnostics, which is where most of the
 * Rayon-like "Send/Sync bound" feeling comes from.
 */
import { parseSync } from "oxc-parser";

// oxc-parser exposes ESTree-shaped nodes with start/end offsets; we walk them
// structurally, so a loose node type keeps this independent of oxc's TS types.
interface Node {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

export interface Diagnostic {
  message: string;
  start: number;
  end: number;
}

interface RefSite {
  name: string;
  start: number;
  end: number;
  /** Shorthand object property `{ a }` — must expand to `{ a: __env.a }`. */
  shorthand: boolean;
}

interface ImportBinding {
  local: string;
  source: string;
  sourceStart: number;
  sourceEnd: number;
  declarationStart: number;
  declarationEnd: number;
}

export interface KernelAnalysis {
  node: Node;
  start: number;
  end: number;
  /** Function name (declaration or named function expression), if any. */
  name: string | null;
  kind: "declaration" | "expression";
  /** Function declaration is a direct module-level declaration (and is hoisted). */
  topLevel: boolean;
  /** Safe containing-block offset for hoisted nested declaration registration. */
  registrationOffset: number | null;
  /** Free variables captured from enclosing scopes, sorted. */
  captured: string[];
  /** Every captured reference site, for rewriting inside the extracted source. */
  rewrites: RefSite[];
  /** Static import declarations needed by the worker bundle. */
  imports: ImportBinding[];
  diags: Diagnostic[];
}

export interface ModuleAnalysis {
  kernels: KernelAnalysis[];
  parseErrors: string[];
  /** Safe insertion point after a hashbang and module directive prologue. */
  headerEnd: number;
}

const RESERVED_ENV = "__env";

const GLOBALS = new Set([
  "undefined", "NaN", "Infinity", "global", "globalThis",
  "Math", "JSON", "Number", "String", "Boolean", "Object", "Array", "BigInt", "Symbol",
  "Date", "RegExp", "Error", "TypeError", "RangeError", "SyntaxError", "EvalError",
  "ReferenceError", "URIError", "AggregateError",
  "Map", "Set", "WeakMap", "WeakSet", "WeakRef", "Promise", "Proxy", "Reflect",
  "FinalizationRegistry",
  "parseInt", "parseFloat", "isNaN", "isFinite",
  "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI",
  "structuredClone", "queueMicrotask", "console", "performance", "crypto",
  "AbortController", "AbortSignal", "Blob", "BroadcastChannel", "CustomEvent",
  "DOMException", "Event", "EventTarget", "File", "FormData", "Headers",
  "MessageChannel", "MessageEvent", "MessagePort", "Request", "Response",
  "ByteLengthQueuingStrategy", "CompressionStream", "CountQueuingStrategy",
  "DecompressionStream", "ReadableByteStreamController", "ReadableStream",
  "ReadableStreamBYOBReader", "ReadableStreamBYOBRequest",
  "ReadableStreamDefaultController", "ReadableStreamDefaultReader",
  "TextDecoderStream", "TextEncoderStream", "TransformStream",
  "TransformStreamDefaultController", "WritableStream",
  "WritableStreamDefaultController", "WritableStreamDefaultWriter",
  "Crypto", "CryptoKey", "SubtleCrypto",
  "Performance", "PerformanceEntry", "PerformanceMark", "PerformanceMeasure",
  "PerformanceObserver", "PerformanceObserverEntryList",
  "PerformanceResourceTiming",
  "TextEncoder", "TextDecoder", "URL", "URLSearchParams",
  "atob", "btoa", "fetch",
  "Atomics", "SharedArrayBuffer", "ArrayBuffer", "DataView",
  "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array",
  "Int32Array", "Uint32Array", "Float32Array", "Float64Array",
  "BigInt64Array", "BigUint64Array",
  "Intl", "WebAssembly", "Buffer", "process",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate",
  "clearImmediate",
  "RAYON_THREAD_ID",
]);

const FN_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

// TS wrapper nodes whose inner expression is real runtime code.
const TS_EXPR_WRAPPERS = new Set([
  "TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression",
  "TSInstantiationExpression", "TSTypeAssertion",
]);

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && typeof (value as Node).type === "string";
}

function childNodes(node: Node): Node[] {
  const out: Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range") continue;
    if (isNode(value)) out.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) out.push(item);
    }
  }
  return out;
}

function hasUseParallelDirective(fn: Node): boolean {
  const body = fn.body as Node | undefined;
  if (body === undefined || body.type !== "BlockStatement") return false;
  for (const stmt of body.body as Node[]) {
    if (stmt.type !== "ExpressionStatement" || typeof stmt.directive !== "string") break;
    if (stmt.directive === "use parallel") return true;
  }
  return false;
}

/** Pass 1: collect outermost kernel functions (inner directives are inert). */
function findKernels(program: Node): Node[] {
  const kernels: Node[] = [];
  const visit = (node: Node): void => {
    if (FN_TYPES.has(node.type) && hasUseParallelDirective(node)) {
      kernels.push(node);
      return; // closures inside a kernel already run in the worker
    }
    for (const child of childNodes(node)) visit(child);
  };
  visit(program);
  return kernels;
}

/** Top-level function names -> kernel-ness, for early "capture of plain fn" errors. */
function topLevelFunctionKinds(program: Node): Map<string, boolean> {
  const kinds = new Map<string, boolean>();
  for (const raw of program.body as Node[]) {
    const stmt = raw.type === "ExportNamedDeclaration" || raw.type === "ExportDefaultDeclaration"
      ? ((raw.declaration as Node | null) ?? raw)
      : raw;
    if (stmt.type === "FunctionDeclaration" && isNode(stmt.id)) {
      kinds.set((stmt.id as Node).name as string, hasUseParallelDirective(stmt));
    } else if (stmt.type === "VariableDeclaration") {
      for (const decl of stmt.declarations as Node[]) {
        const id = decl.id as Node;
        const init = decl.init as Node | null;
        if (id?.type === "Identifier" && init !== null && isNode(init) && FN_TYPES.has(init.type)) {
          kinds.set(id.name as string, hasUseParallelDirective(init));
        }
      }
    }
  }
  return kinds;
}

function addPatternNames(pattern: Node | null, names: Set<string>): void {
  if (pattern === null || !isNode(pattern)) return;
  switch (pattern.type) {
    case "Identifier":
      names.add(pattern.name as string);
      return;
    case "ObjectPattern":
      for (const property of pattern.properties as Node[]) {
        addPatternNames(
          (property.type === "RestElement" ? property.argument : property.value) as Node,
          names,
        );
      }
      return;
    case "ArrayPattern":
      for (const element of pattern.elements as (Node | null)[]) addPatternNames(element, names);
      return;
    case "AssignmentPattern":
      addPatternNames(pattern.left as Node, names);
      return;
    case "RestElement":
      addPatternNames(pattern.argument as Node, names);
      return;
  }
}

/** Runtime bindings that shadow same-named standard globals for this module. */
function topLevelValueBindings(program: Node): Set<string> {
  const names = new Set<string>();
  for (const raw of program.body as Node[]) {
    if (raw.type === "ImportDeclaration" && raw.importKind !== "type") {
      for (const specifier of raw.specifiers as Node[]) {
        if (specifier.importKind !== "type") addPatternNames(specifier.local as Node, names);
      }
      continue;
    }
    const statement =
      raw.type === "ExportNamedDeclaration" || raw.type === "ExportDefaultDeclaration"
        ? ((raw.declaration as Node | null) ?? raw)
        : raw;
    if (statement.type === "VariableDeclaration") {
      for (const declaration of statement.declarations as Node[]) {
        addPatternNames(declaration.id as Node, names);
      }
    } else if (
      statement.type === "FunctionDeclaration" ||
      statement.type === "ClassDeclaration" ||
      statement.type === "TSEnumDeclaration"
    ) {
      addPatternNames(statement.id as Node | null, names);
    }
  }
  return names;
}

function topLevelImportBindings(program: Node): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();
  for (const stmt of program.body as Node[]) {
    if (stmt.type !== "ImportDeclaration" || stmt.importKind === "type") continue;
    const sourceNode = stmt.source as Node;
    const source = sourceNode.value as string;
    for (const specifier of stmt.specifiers as Node[]) {
      if (specifier.importKind === "type") continue;
      const local = specifier.local as Node;
      bindings.set(local.name as string, {
        local: local.name as string,
        source,
        sourceStart: sourceNode.start,
        sourceEnd: sourceNode.end,
        declarationStart: stmt.start,
        declarationEnd: stmt.end,
      });
    }
  }
  return bindings;
}

function moduleHeaderEnd(program: Node, code: string): number {
  const hashbang = program.hashbang as Node | null;
  let end = 0;
  if (isNode(hashbang)) {
    const newline = code.indexOf("\n", hashbang.end);
    end = newline === -1 ? code.length : newline + 1;
  }
  for (const stmt of program.body as Node[]) {
    if (stmt.type !== "ExpressionStatement" || typeof stmt.directive !== "string") break;
    end = stmt.end;
  }
  return end;
}

function nestedDeclarationOffsets(program: Node): Map<Node, number> {
  const offsets = new Map<Node, number>();
  const visit = (node: Node): void => {
    if (node.type === "BlockStatement") {
      const statements = node.body as Node[];
      let offset = node.start + 1;
      for (const statement of statements) {
        if (statement.type !== "ExpressionStatement" || typeof statement.directive !== "string") {
          break;
        }
        offset = statement.end;
      }
      for (const statement of statements) {
        if (statement.type === "FunctionDeclaration") offsets.set(statement, offset);
      }
    }
    for (const child of childNodes(node)) visit(child);
  };
  visit(program);
  return offsets;
}

class Scope {
  readonly names = new Set<string>();
  constructor(
    readonly parent: Scope | null,
    readonly isFunction: boolean,
    readonly thisAllowed: boolean = parent?.thisAllowed ?? false,
  ) {}
  resolve(name: string): boolean {
    return this.names.has(name) || (this.parent?.resolve(name) ?? false);
  }
  functionScope(): Scope {
    return this.isFunction ? this : (this.parent?.functionScope() ?? this);
  }
}

interface PendingRef {
  name: string;
  start: number;
  end: number;
  shorthand: boolean;
  write: boolean;
  scope: Scope;
}

class KernelWalker {
  readonly refs: PendingRef[] = [];
  readonly diags: Diagnostic[] = [];
  readonly usedNames = new Set<string>();

  error(node: Node, message: string): void {
    this.diags.push({ message, start: node.start, end: node.end });
  }

  ref(node: Node, scope: Scope, write: boolean, shorthand = false): void {
    const name = node.name as string;
    this.usedNames.add(name);
    this.refs.push({ name, start: node.start, end: node.end, shorthand, write, scope });
  }

  declarePattern(pattern: Node | null, scope: Scope, kind: "var" | "lexical"): void {
    if (pattern === null || !isNode(pattern)) return;
    switch (pattern.type) {
      case "Identifier": {
        const name = pattern.name as string;
        if (name === "this") return; // TS this-parameter
        this.usedNames.add(name);
        (kind === "var" ? scope.functionScope() : scope).names.add(name);
        return;
      }
      case "ObjectPattern":
        for (const prop of pattern.properties as Node[]) {
          if (prop.type === "RestElement") this.declarePattern(prop.argument as Node, scope, kind);
          else {
            if (prop.computed === true) this.visit(prop.key as Node, scope);
            this.declarePattern(prop.value as Node, scope, kind);
          }
        }
        return;
      case "ArrayPattern":
        for (const el of pattern.elements as (Node | null)[]) this.declarePattern(el, scope, kind);
        return;
      case "AssignmentPattern":
        this.declarePattern(pattern.left as Node, scope, kind);
        this.visit(pattern.right as Node, scope); // default value is runtime code
        return;
      case "RestElement":
        this.declarePattern(pattern.argument as Node, scope, kind);
        return;
      default:
        if (pattern.type.startsWith("TS")) return;
        for (const child of childNodes(pattern)) this.declarePattern(child, scope, kind);
    }
  }

  /** Declares only binding names; unlike declarePattern(), evaluates no defaults. */
  declarePatternNames(pattern: Node | null, scope: Scope, kind: "var" | "lexical"): void {
    if (pattern === null || !isNode(pattern)) return;
    switch (pattern.type) {
      case "Identifier": {
        const name = pattern.name as string;
        if (name === "this") return;
        this.usedNames.add(name);
        (kind === "var" ? scope.functionScope() : scope).names.add(name);
        return;
      }
      case "ObjectPattern":
        for (const prop of pattern.properties as Node[]) {
          this.declarePatternNames(
            (prop.type === "RestElement" ? prop.argument : prop.value) as Node,
            scope,
            kind,
          );
        }
        return;
      case "ArrayPattern":
        for (const element of pattern.elements as (Node | null)[]) {
          this.declarePatternNames(element, scope, kind);
        }
        return;
      case "AssignmentPattern":
        this.declarePatternNames(pattern.left as Node, scope, kind);
        return;
      case "RestElement":
        this.declarePatternNames(pattern.argument as Node, scope, kind);
        return;
      default:
        return;
    }
  }

  /** Predeclares block-scoped bindings so TDZ references stay local. */
  predeclareStatements(statements: readonly Node[], scope: Scope): void {
    for (const statement of statements) {
      if (statement.type === "VariableDeclaration" && statement.kind !== "var") {
        for (const declaration of statement.declarations as Node[]) {
          this.declarePatternNames(declaration.id as Node, scope, "lexical");
        }
      } else if (statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") {
        const id = statement.id as Node | null;
        if (isNode(id)) this.declarePatternNames(id, scope, "lexical");
      }
    }
  }

  /** Marks assignment targets as writes; nested member expressions stay reads. */
  assignTarget(pattern: Node, scope: Scope): void {
    switch (pattern.type) {
      case "Identifier":
        this.ref(pattern, scope, true);
        return;
      case "MemberExpression":
        this.visit(pattern.object as Node, scope);
        if (pattern.computed === true) this.visit(pattern.property as Node, scope);
        return;
      case "ObjectPattern":
        for (const prop of pattern.properties as Node[]) {
          if (prop.type === "RestElement") this.assignTarget(prop.argument as Node, scope);
          else {
            if (prop.computed === true) this.visit(prop.key as Node, scope);
            this.assignTarget(prop.value as Node, scope);
          }
        }
        return;
      case "ArrayPattern":
        for (const el of pattern.elements as (Node | null)[]) if (el !== null) this.assignTarget(el, scope);
        return;
      case "AssignmentPattern":
        this.assignTarget(pattern.left as Node, scope);
        this.visit(pattern.right as Node, scope);
        return;
      case "RestElement":
        this.assignTarget(pattern.argument as Node, scope);
        return;
      default:
        if (TS_EXPR_WRAPPERS.has(pattern.type)) this.assignTarget(pattern.expression as Node, scope);
        else this.visit(pattern, scope);
    }
  }

  /** Hoists function-scoped declarations declared anywhere under `body`. */
  hoistVars(node: Node, scope: Scope): void {
    if (
      FN_TYPES.has(node.type) ||
      node.type === "ClassDeclaration" ||
      node.type === "ClassExpression" ||
      node.type === "StaticBlock"
    ) {
      return; // separate var scope
    }
    if (node.type === "VariableDeclaration" && node.kind === "var") {
      for (const decl of node.declarations as Node[]) {
        this.declarePatternNames(decl.id as Node, scope, "var");
      }
    }
    for (const child of childNodes(node)) this.hoistVars(child, scope);
  }

  visitFunction(
    fn: Node,
    outer: Scope,
    options: { declareSelfIn?: Scope; kernelRoot?: boolean } = {},
  ): void {
    if (options.kernelRoot === true && fn.async === true) {
      this.error(fn, `"use parallel" kernels must be synchronous (remove async)`);
    }
    if (options.kernelRoot === true && fn.generator === true) {
      this.error(fn, `"use parallel" kernels cannot be generators`);
    }

    const bindsThis = options.kernelRoot !== true && fn.type !== "ArrowFunctionExpression";
    const scope = new Scope(outer, true, bindsThis || outer.thisAllowed);
    if (options.kernelRoot !== true && fn.type !== "ArrowFunctionExpression") {
      scope.names.add("arguments");
    }
    const id = fn.id as Node | null;
    if (isNode(id)) {
      // named function expressions bind their own name; declarations also
      // export it to the surrounding scope when requested
      scope.names.add(id.name as string);
      this.usedNames.add(id.name as string);
      options.declareSelfIn?.names.add(id.name as string);
    }
    for (const param of fn.params as Node[]) this.declarePattern(param, scope, "lexical");
    const body = fn.body as Node;
    if (body.type === "BlockStatement") {
      this.hoistVars(body, scope);
      this.predeclareStatements(body.body as Node[], scope);
      for (const stmt of body.body as Node[]) this.visit(stmt, scope);
    } else {
      this.visit(body, scope);
    }
  }

  visit(node: Node | null | undefined, scope: Scope): void {
    if (node === null || node === undefined || !isNode(node)) return;
    switch (node.type) {
      case "Identifier":
        if (node.name === "arguments" && !scope.resolve("arguments")) {
          this.error(node, `kernels cannot use "arguments" - use explicit parameters instead`);
          return;
        }
        this.ref(node, scope, false);
        return;
      case "PrivateIdentifier":
      case "Literal":
      case "Super":
        return;
      case "ThisExpression":
        if (!scope.thisAllowed) {
          this.error(node, `kernels cannot use "this" - pass data via parameters or captured variables`);
        }
        return;
      case "MetaProperty":
        this.error(node, `kernels cannot use "${(node.meta as Node).name}.${(node.property as Node).name}"`);
        return;
      case "ImportExpression":
        this.error(node, "kernels cannot use dynamic import()");
        return;
      case "JSXElement":
      case "JSXFragment":
        this.error(node, "kernels cannot contain JSX");
        return;
      case "FunctionDeclaration":
        this.visitFunction(node, scope, { declareSelfIn: scope });
        return;
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        this.visitFunction(node, scope);
        return;
      case "ClassDeclaration":
      case "ClassExpression": {
        const id = node.id as Node | null;
        const classScope = new Scope(scope, false, true);
        if (isNode(id)) {
          classScope.names.add(id.name as string);
          if (node.type === "ClassDeclaration") scope.names.add(id.name as string);
          this.usedNames.add(id.name as string);
        }
        this.visit(node.superClass as Node, classScope);
        const body = node.body as Node;
        for (const member of (body.body as Node[]) ?? []) {
          if (member.computed === true) this.visit(member.key as Node, classScope);
          this.visit(member.value as Node, classScope);
          if (member.type === "StaticBlock") {
            const staticScope = new Scope(classScope, true, true);
            for (const stmt of (member.body as Node[]) ?? []) {
              this.hoistVars(stmt, staticScope);
            }
            this.predeclareStatements((member.body as Node[]) ?? [], staticScope);
            for (const stmt of (member.body as Node[]) ?? []) this.visit(stmt, staticScope);
          }
        }
        return;
      }
      case "BlockStatement": {
        const block = new Scope(scope, false);
        this.predeclareStatements(node.body as Node[], block);
        for (const stmt of node.body as Node[]) this.visit(stmt, block);
        return;
      }
      case "SwitchStatement": {
        this.visit(node.discriminant as Node, scope);
        const block = new Scope(scope, false);
        const cases = node.cases as Node[];
        this.predeclareStatements(
          cases.flatMap((switchCase) => switchCase.consequent as Node[]),
          block,
        );
        for (const switchCase of cases) {
          this.visit(switchCase.test as Node | null, block);
          for (const statement of switchCase.consequent as Node[]) {
            this.visit(statement, block);
          }
        }
        return;
      }
      case "VariableDeclaration": {
        const kind = node.kind === "var" ? "var" : "lexical";
        for (const decl of node.declarations as Node[]) {
          this.declarePattern(decl.id as Node, scope, kind);
          this.visit(decl.init as Node, scope);
        }
        return;
      }
      case "CatchClause": {
        const block = new Scope(scope, false);
        this.declarePattern(node.param as Node | null, block, "lexical");
        this.visit(node.body as Node, block);
        return;
      }
      case "ForStatement": {
        const head = new Scope(scope, false);
        this.visit(node.init as Node, head);
        this.visit(node.test as Node, head);
        this.visit(node.update as Node, head);
        this.visit(node.body as Node, head);
        return;
      }
      case "ForInStatement":
      case "ForOfStatement": {
        const head = new Scope(scope, false);
        const left = node.left as Node;
        if (left.type === "VariableDeclaration") this.visit(left, head);
        else this.assignTarget(left, head);
        this.visit(node.right as Node, head);
        this.visit(node.body as Node, head);
        return;
      }
      case "AssignmentExpression":
        this.assignTarget(node.left as Node, scope);
        this.visit(node.right as Node, scope);
        return;
      case "UpdateExpression":
        this.assignTarget(node.argument as Node, scope);
        return;
      case "MemberExpression": {
        this.visit(node.object as Node, scope);
        if (node.computed === true) this.visit(node.property as Node, scope);
        return;
      }
      case "Property": {
        if (node.shorthand === true) {
          const value = node.value as Node;
          if (value.type === "AssignmentPattern") {
            // `{ a = 1 }` in expression position cannot occur; patterns handled elsewhere
            this.visit(value, scope);
          } else {
            this.ref(value, scope, false, true);
          }
          return;
        }
        if (node.computed === true) this.visit(node.key as Node, scope);
        this.visit(node.value as Node, scope);
        return;
      }
      case "LabeledStatement":
        this.visit(node.body as Node, scope);
        return;
      case "BreakStatement":
      case "ContinueStatement":
        return;
      default: {
        if (node.type.startsWith("TS")) {
          if (TS_EXPR_WRAPPERS.has(node.type)) this.visit(node.expression as Node, scope);
          return;
        }
        if (node.type.startsWith("JSX")) {
          this.error(node, "kernels cannot contain JSX");
          return;
        }
        for (const child of childNodes(node)) this.visit(child, scope);
      }
    }
  }
}

function analyzeKernel(
  fn: Node,
  topLevel: boolean,
  registrationOffset: number | null,
  topLevelFns: Map<string, boolean>,
  topLevelBindings: Set<string>,
  importBindings: Map<string, ImportBinding>,
): KernelAnalysis {
  const walker = new KernelWalker();
  const rootScope = new Scope(null, true);
  walker.visitFunction(fn, rootScope, { kernelRoot: true });

  const capturedSet = new Map<string, RefSite[]>();
  const imported = new Map<string, ImportBinding>();
  const diags = [...walker.diags];

  for (const ref of walker.refs) {
    if (ref.scope.resolve(ref.name)) continue;
    if (ref.name === RESERVED_ENV) {
      diags.push({ message: `"${RESERVED_ENV}" is reserved inside "use parallel" kernels`, start: ref.start, end: ref.end });
      continue;
    }
    if (ref.write) {
      diags.push({
        message:
          `cannot assign to captured variable "${ref.name}" inside a kernel - ` +
          `each worker sees a copy. Use a reduction (.sum()/.reduce()) or write into a shared typed array instead`,
        start: ref.start,
        end: ref.end,
      });
      continue;
    }
    const importBinding = importBindings.get(ref.name);
    if (importBinding !== undefined) {
      imported.set(ref.name, importBinding);
      continue;
    }
    const topLevelFn = topLevelFns.get(ref.name);
    if (topLevelFn === false) {
      diags.push({
        message:
          `kernel calls "${ref.name}", which is not marked "use parallel" - ` +
          `workers cannot see it. Add the "use parallel" directive to "${ref.name}"`,
        start: ref.start,
        end: ref.end,
      });
      continue;
    }
    if (GLOBALS.has(ref.name) && !topLevelBindings.has(ref.name)) continue;
    const sites = capturedSet.get(ref.name) ?? [];
    sites.push({ name: ref.name, start: ref.start, end: ref.end, shorthand: ref.shorthand });
    capturedSet.set(ref.name, sites);
  }

  if (walker.usedNames.has(RESERVED_ENV)) {
    // declared locally — still refuse, the extracted source injects __env
    const already = diags.some((d) => d.message.includes(RESERVED_ENV));
    if (!already) diags.push({ message: `"${RESERVED_ENV}" is reserved inside "use parallel" kernels`, start: fn.start, end: fn.end });
  }

  const id = fn.id as Node | null;
  return {
    node: fn,
    start: fn.start,
    end: fn.end,
    name: isNode(id) ? (id.name as string) : null,
    kind: fn.type === "FunctionDeclaration" ? "declaration" : "expression",
    topLevel,
    registrationOffset,
    captured: [...capturedSet.keys()].sort(),
    rewrites: [...capturedSet.values()].flat().sort((a, b) => a.start - b.start),
    imports: [...imported.values()].sort((a, b) => a.declarationStart - b.declarationStart),
    diags,
  };
}

export function analyzeModule(filename: string, code: string): ModuleAnalysis {
  const parsed = parseSync(filename, code);
  if (parsed.errors.length > 0) {
    return { kernels: [], parseErrors: parsed.errors.map((e) => e.message), headerEnd: 0 };
  }
  const program = parsed.program as unknown as Node;
  const kernelNodes = findKernels(program);
  const headerEnd = moduleHeaderEnd(program, code);
  if (kernelNodes.length === 0) return { kernels: [], parseErrors: [], headerEnd };
  const topLevelFns = topLevelFunctionKinds(program);
  const topLevelBindings = topLevelValueBindings(program);
  const importBindings = topLevelImportBindings(program);
  const registrationOffsets = nestedDeclarationOffsets(program);
  const topLevelDeclarations = new Set<Node>();
  for (const raw of program.body as Node[]) {
    const statement =
      raw.type === "ExportNamedDeclaration" || raw.type === "ExportDefaultDeclaration"
        ? ((raw.declaration as Node | null) ?? raw)
        : raw;
    if (statement.type === "FunctionDeclaration") topLevelDeclarations.add(statement);
  }
  return {
    kernels: kernelNodes.map((fn) =>
      analyzeKernel(
        fn,
        topLevelDeclarations.has(fn),
        registrationOffsets.get(fn) ?? null,
        topLevelFns,
        topLevelBindings,
        importBindings,
      ),
    ),
    parseErrors: [],
    headerEnd,
  };
}
