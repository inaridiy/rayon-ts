import { describe, expect, it } from "vitest";
import { RayonTransformError, transformModule } from "../src/plugin/emit.js";

const t = (code: string, name = "mod.ts") => transformModule(name, code, { moduleName: name });

describe("kernel detection", () => {
  it("returns null for modules without kernels", () => {
    expect(t(`export const x = 1;`)).toBeNull();
    expect(t(`const s = "use parallel"; // just a string`)).toBeNull();
  });

  it("registers a named function declaration kernel", () => {
    const out = t(`
const K = 3;
export function triple(x: number): number {
  "use parallel";
  return x * K;
}
`);
    expect(out).not.toBeNull();
    expect(out!.code).toContain(`import { __rayonRegister as __rayon$register } from "rayon-ts/runtime";`);
    expect(out!.code).toContain(`__rayon$register(triple, { id: "mod.ts::triple@`);
    expect(out!.code).toContain(`getEnv: () => ({ K })`);
    // worker source: types stripped, capture rewritten
    expect(out!.code).toContain(`x * __env.K`);
    expect(out!.code).not.toContain(`__env.x`);
    // original body untouched
    expect(out!.code).toContain(`return x * K;`);
  });

  it("registers hoisted module functions before an earlier call site", () => {
    const out = t(`
import { par } from "rayon-ts";
export const result = par.range(0, 3).map(later).sum();
export function later(value: number): number {
  "use parallel";
  return value + 1;
}
`);
    expect(out!.code.indexOf("__rayon$register(later")).toBeLessThan(
      out!.code.indexOf("export const result"),
    );
  });

  it("registers a hoisted nested declaration at its containing block entry", () => {
    const out = t(`
import { par } from "rayon-ts";
export function run(offset: number) {
  "use strict";
  const result = par.range(0, 3).map(later).sum();
  function later(value: number): number {
    "use parallel";
    return value + offset;
  }
  return result;
}
`);
    const strictEnd = out!.code.indexOf('"use strict";') + '"use strict";'.length;
    const dispatch = out!.code.indexOf("const result");
    const registration = out!.code.indexOf("__rayon$register(later", strictEnd);
    expect(registration).toBeGreaterThan(strictEnd);
    expect(registration).toBeLessThan(dispatch);
  });

  it("wraps inline arrow kernels in place", () => {
    const out = t(`
import { par } from "rayon-ts";
export function render(width: number) {
  return par.range(0, width).map((i: number) => {
    "use parallel";
    return i * width;
  }).sum();
}
`);
    expect(out!.code).toMatch(/\.map\(__rayon\$register\(\(i: number\) => \{/);
    expect(out!.code).toContain(`getEnv: () => ({ width })`);
    expect(out!.code).toContain(`i * __env.width`);
  });

  it("ignores directives nested inside a kernel", () => {
    const out = t(`
export function outer(x: number): number {
  "use parallel";
  const inner = (y: number) => { "use parallel"; return y + 1; };
  return inner(x);
}
`);
    const registers = out!.code.match(/__rayon\$register\(/g);
    expect(registers).toHaveLength(1);
  });
});

describe("capture analysis", () => {
  it("does not capture locals, params, or self-recursion", () => {
    const out = t(`
export function fib(n: number): number {
  "use parallel";
  const two = 2;
  return n < two ? n : fib(n - 1) + fib(n - 2);
}
`);
    expect(out!.code).toContain(`getEnv: () => ({  })`);
    expect(out!.code).not.toContain("__env.fib");
  });

  it("does not capture shadowed names or globals", () => {
    const out = t(`
const data = [1, 2, 3];
export function f(x: number): number {
  "use parallel";
  const data = x * 2;
  return Math.min(data, Number.MAX_SAFE_INTEGER);
}
`);
    expect(out!.code).toContain(`getEnv: () => ({  })`);
  });

  it("captures kernel-to-kernel references", () => {
    const out = t(`
export function sq(x: number): number {
  "use parallel";
  return x * x;
}
export function sqPlus1(x: number): number {
  "use parallel";
  return sq(x) + 1;
}
`);
    expect(out!.code).toContain(`getEnv: () => ({ sq })`);
    expect(out!.code).toContain(`__env.sq(x) + 1`);
  });

  it("bundles statically imported bindings instead of capturing functions", () => {
    const out = t(`
import { basename } from "node:path";
export function f(value: string): number {
  "use parallel";
  return basename(value).length;
}
`);
    expect(out!.code).toContain(`"format":"bundle"`);
    expect(out!.code).toContain(`getEnv: () => ({  })`);
    expect(out!.code).not.toContain("__env.basename");
  });

  it("shares one imported-code bundle across kernels with the same imports", () => {
    const out = t(`
import { basename } from "node:path";
export function first(value: string): string {
  "use parallel";
  return basename(value);
}
export function second(value: string): number {
  "use parallel";
  return basename(value).length;
}
`);
    expect(out!.code.match(/const __rayon\$src\$\d+ =/g)).toHaveLength(1);
    expect(out!.code).toContain(`factoryName: "kernel0"`);
    expect(out!.code).toContain(`factoryName: "kernel1"`);
    const ids = out!.code.match(/id: "mod\.ts::bundle@[a-f0-9]+"/g);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
  });

  it("keeps kernels with unrelated imports in separate bundles", () => {
    const out = t(`
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
export function first(value: string): string {
  "use parallel";
  return basename(value);
}
export function second(value: URL): string {
  "use parallel";
  return fileURLToPath(value);
}
`);
    expect(out!.code.match(/const __rayon\$src\$\d+ =/g)).toHaveLength(2);
    const ids = out!.code.match(/id: "mod\.ts::bundle@[a-f0-9]+"/g);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("locates a bundle failure at the kernel with the bad import", () => {
    const code = `
import { basename } from "node:path";
import { missing } from "./definitely-missing.js";
export function valid(value: string): string {
  "use parallel";
  return basename(value);
}
export function invalid(value: string): unknown {
  "use parallel";
  return missing(value);
}
`;
    try {
      t(code);
      throw new Error("expected the transform to fail");
    } catch (cause) {
      expect(cause).toBeInstanceOf(RayonTransformError);
      const error = cause as RayonTransformError;
      expect(error.diagnostics[0]?.start).toBe(code.indexOf("function invalid"));
      expect(error.message).toContain("Could not resolve");
    }
  });

  it("can leave configured packages external to the worker bundle", () => {
    const out = transformModule(
      "/app/kernel.ts",
      `
import MagicString from "magic-string";
export function f(value: string): number {
  "use parallel";
  return new MagicString(value).append("!").length();
}
`,
      {
        moduleName: "kernel.ts",
        external: ["magic-string"],
      },
    );
    expect(out!.code).toMatch(/require\(\\?"magic-string\\?"\)/);
  });

  it("does not mistake an imported binding for a same-named global", () => {
    const out = t(`
import { basename as URL } from "node:path";
export function f(value: string): number {
  "use parallel";
  return URL(value).length;
}
`);
    expect(out!.code).toContain(`"format":"bundle"`);
    expect(out!.code).not.toContain("__env.URL");
  });

  it("captures module bindings that shadow standard globals", () => {
    const out = t(`
const Math = { base: 7 };
export function f(value: number): number {
  "use parallel";
  return value + Math.base;
}
`);
    expect(out!.code).toContain("__env.Math.base");
    expect(out!.code).toContain("getEnv: () => ({ Math })");
  });

  it("expands shorthand object properties", () => {
    const out = t(`
const width = 10;
export function f(i: number) {
  "use parallel";
  return JSON.stringify({ width, i });
}
`);
    // the kernel source is a JSON string, so newlines appear as \n escapes
    expect(out!.code).toContain("width: __env.width");
  });

  it("ignores identifiers in type positions", () => {
    const out = t(`
interface Config { n: number }
const conf = { n: 1 };
export function f(x: Config["n"]): number {
  "use parallel";
  const y: Config = { n: x };
  return y.n;
}
`);
    expect(out!.code).toContain(`getEnv: () => ({  })`);
  });

  it("var hoisting keeps early references local", () => {
    const out = t(`
export function f(n: number): number {
  "use parallel";
  let total = 0;
  for (let i = 0; i < n; i++) { if (i > 2) { var extra = i; total += extra; } }
  return total + (extra ?? 0);
}
`);
    expect(out!.code).toContain(`getEnv: () => ({  })`);
  });

  it("does not hoist static-block var declarations into the kernel scope", () => {
    const out = t(`
const value = 5;
export function f(): number {
  "use parallel";
  class Local {
    static { var value = 1; void value; }
  }
  void Local;
  return value;
}
`);
    expect(out!.code).toContain(`getEnv: () => ({ value })`);
    expect(out!.code).toContain("return __env.value");
  });

  it("recognizes constructors provided by the minimum Node 20 runtime", () => {
    const out = t(`
export function f(): number {
  "use parallel";
  return [
    File, CompressionStream, DecompressionStream,
    ByteLengthQueuingStrategy, CountQueuingStrategy,
    TextEncoderStream, TextDecoderStream, SubtleCrypto, CryptoKey,
    global, clearImmediate
  ].length;
}
`);
    expect(out!.code).toContain(`getEnv: () => ({  })`);
  });

  it("bundles syntax that needs Node 20 lowering helpers", () => {
    const out = t(`
export function f(): number {
  "use parallel";
  using resource = null;
  return 1;
}
`);
    expect(out!.code).toContain(`"format":"bundle"`);
    expect(out!.code).toContain("__callDispose");
  });

  it("keeps TDZ-bound block names local before their declaration", () => {
    const out = t(`
const value = 99;
export function f(flag: boolean): number {
  "use parallel";
  if (flag) {
    return value;
    let value = 1;
  }
  return value;
}
`);
    expect(out!.code.match(/__env\.value/g)).toHaveLength(1);
  });

  it("rewrites defaults in hoisted var patterns exactly once", () => {
    const out = t(`
const fallback = 7;
export function f(input: { value?: number }): number {
  "use parallel";
  var { value = fallback } = input;
  return value;
}
`);
    expect(out!.code.match(/__env\.fallback/g)).toHaveLength(1);
  });

  it("allows this, arguments, and generators inside nested regular functions", () => {
    const out = t(`
export function f(base: number): number {
  "use parallel";
  function local(this: { base: number }, value: number): number {
    function* values() { yield arguments[0] as number; }
    return this.base + [...values()][0]!;
  }
  return local.call({ base }, 2);
}
`);
    expect(out).not.toBeNull();
  });
});

describe("diagnostics", () => {
  const expectError = (code: string, pattern: RegExp) => {
    expect(() => t(code)).toThrowError(RayonTransformError);
    try {
      t(code);
    } catch (err) {
      expect((err as Error).message).toMatch(pattern);
    }
  };

  it("rejects assignment to captured variables", () => {
    expectError(
      `
let total = 0;
export function f(x: number) {
  "use parallel";
  total += x;
  return total;
}
`,
      /cannot assign to captured variable "total"/,
    );
  });

  it("allows writes into captured arrays (element writes are reads of the binding)", () => {
    const out = t(`
declare const out: Float64Array;
export function f(x: number, i: number) {
  "use parallel";
  out[i] = x;
  return x;
}
`);
    expect(out!.code).toContain(`getEnv: () => ({ out })`);
    expect(out!.code).toContain(`__env.out[i] = x`);
  });

  it("rejects calling a top-level non-kernel function", () => {
    expectError(
      `
function helper(x: number) { return x + 1; }
export function f(x: number) {
  "use parallel";
  return helper(x);
}
`,
      /not marked "use parallel"/,
    );
  });

  it("rejects this / async / methods", () => {
    expectError(`export function f(this: { n: number }) { "use parallel"; return this.n; }`, /cannot use "this"/);
    expectError(`export async function f(x: number) { "use parallel"; return x; }`, /must be synchronous/);
    expectError(
      `export const o = { m() { "use parallel"; return 1; } };`,
      /methods cannot be "use parallel" kernels/,
    );
  });

  it("rejects arguments with the documented compile-time diagnostic", () => {
    expectError(
      `export function f() { "use parallel"; return arguments.length; }`,
      /cannot use "arguments"/,
    );
  });

  it("rejects __env usage", () => {
    expectError(`export function f(__env: number) { "use parallel"; return __env; }`, /"__env" is reserved/);
  });
});

describe("module augmentation safety", () => {
  it("preserves hashbangs and directive prologues ahead of injected imports", () => {
    const out = t(`#!/usr/bin/env node
"use server";
export function f(x: number) { "use parallel"; return x + 1; }
`);
    expect(out!.code.startsWith('#!/usr/bin/env node\n"use server";\nimport ')).toBe(true);
  });

  it("chooses collision-free injected bindings", () => {
    const out = t(`
const __rayon$register = 1;
const __rayon$src$0 = 2;
export function f(x: number) { "use parallel"; return x + 1; }
`);
    expect(out!.code).toMatch(/__rayonRegister as __rayon\$register\$\d+/);
    expect(out!.code).toMatch(/const __rayon\$src\$0\$\d+ =/);
  });
});
