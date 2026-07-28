import type {
  JobMessage,
  TerminalSpec,
} from "../runtime/protocol.js";

type Kernel = (...args: unknown[]) => unknown;

export type ChunkRunner = (
  start: number,
  end: number,
  accumulator: unknown,
) => unknown;

type ChunkRunnerFactory = (
  chain: Kernel[],
  combine: Kernel | undefined,
  input: JobMessage["input"],
  out: JobMessage["out"],
  sourceLen: number,
  chunkLen: number,
  rangeStart: number,
) => ChunkRunner;

type SourceMode =
  | "range"
  | "input"
  | "rangeChunks"
  | "arrayChunks"
  | "typedChunks";

interface TerminalCode {
  key: string;
  setup: string;
  consume: string;
  result: string;
}

// Keep specialization focused on normal, short pipelines. Dynamically built
// services can otherwise create unbounded shape/code caches, and emitting one
// giant function for an extreme chain is slower than the ordinary stage loop.
const MAX_SPECIALIZED_STAGES = 64;
const MAX_CACHED_FACTORIES = 256;
const factories = new Map<string, ChunkRunnerFactory>();

function sourceMode(
  input: JobMessage["input"],
  chunkLen: number,
): SourceMode {
  if (chunkLen === 0) return input === null ? "range" : "input";
  if (input === null) return "rangeChunks";
  return Array.isArray(input) ? "arrayChunks" : "typedChunks";
}

function sourceCode(mode: SourceMode): string {
  switch (mode) {
    case "range":
      return "let value = rangeStart + i;";
    case "input":
      return "let value = input[i];";
    case "rangeChunks":
      return `
        const chunkStart = i * chunkLen;
        const chunkEnd = Math.min(chunkStart + chunkLen, sourceLen);
        let value = {
          start: rangeStart + chunkStart,
          end: rangeStart + chunkEnd,
        };
      `;
    case "arrayChunks":
      return `
        const chunkStart = i * chunkLen;
        const chunkEnd = Math.min(chunkStart + chunkLen, sourceLen);
        let value = input.slice(chunkStart, chunkEnd);
      `;
    case "typedChunks":
      return `
        const chunkStart = i * chunkLen;
        const chunkEnd = Math.min(chunkStart + chunkLen, sourceLen);
        let value = input.subarray(chunkStart, chunkEnd);
      `;
  }
}

function terminalCode(terminal: TerminalSpec): TerminalCode {
  switch (terminal.kind) {
    case "forEach":
      return {
        key: "forEach",
        setup: "",
        consume: "",
        result: "return undefined;",
      };
    case "sum":
      return {
        key: "sum",
        setup: "",
        consume: "accumulator += value;",
        result: "return accumulator;",
      };
    case "min":
      return {
        key: "min",
        setup: "",
        consume: "if (value < accumulator) accumulator = value;",
        result: "return accumulator;",
      };
    case "max":
      return {
        key: "max",
        setup: "",
        consume: "if (value > accumulator) accumulator = value;",
        result: "return accumulator;",
      };
    case "count":
      return {
        key: "count",
        setup: "",
        consume: "accumulator += 1;",
        result: "return accumulator;",
      };
    case "fold":
      return {
        key: "fold",
        setup: "",
        consume: "accumulator = combine(accumulator, value);",
        result: "return accumulator;",
      };
    case "collect":
      return terminal.filtered
        ? {
            key: "collectFiltered",
            setup: "const collected = [];",
            consume: "collected.push(value);",
            result: "return collected;",
          }
        : {
            key: "collect",
            setup: "",
            consume: "out[i] = value;",
            result: "return undefined;",
          };
    case "collectValues":
      return {
        key: "collectValues",
        setup: "const collected = [];",
        consume: "collected.push(value);",
        result: "return collected;",
      };
    case "invoke":
      throw new Error("internal: invoke jobs do not use a chunk runner");
  }
}

function compileFactory(
  mode: SourceMode,
  terminal: TerminalCode,
  stageKinds: readonly ("map" | "filter")[],
): ChunkRunnerFactory {
  const key = `${mode}:${stageKinds.join(",")}:${terminal.key}`;
  const cached = factories.get(key);
  if (cached !== undefined) {
    factories.delete(key);
    factories.set(key, cached);
    return cached;
  }

  const functionBindings = stageKinds
    .map((_kind, index) => `const fn${index} = chain[${index}];`)
    .join("\n");
  const pipeline = stageKinds
    .map((kind, index) =>
      kind === "map"
        ? `value = fn${index}(value, i);`
        : `if (!fn${index}(value, i)) continue elements;`,
    )
    .join("\n");

  // This is an intentional dynamic-code boundary. Every interpolated fragment
  // is selected from the fixed templates above; no user source reaches it.
  const compiled = new Function(`
    "use strict";
    return (chain, combine, input, out, sourceLen, chunkLen, rangeStart) => {
      ${functionBindings}
      return (start, end, accumulator) => {
        ${terminal.setup}
        elements: for (let i = start; i < end; i++) {
          ${sourceCode(mode)}
          ${pipeline}
          ${terminal.consume}
        }
        ${terminal.result}
      };
    };
    //# sourceURL=rayon-worker-pipeline://${key}
  `)() as ChunkRunnerFactory;
  factories.set(key, compiled);
  if (factories.size > MAX_CACHED_FACTORIES) {
    const oldest = factories.keys().next().value;
    if (oldest !== undefined) factories.delete(oldest);
  }
  return compiled;
}

function createGenericChunkRunner(
  job: JobMessage,
  input: JobMessage["input"],
  chain: Array<{ kind: "map" | "filter"; fn: Kernel }>,
  combine: Kernel | undefined,
): ChunkRunner {
  const {
    chunkLen,
    out,
    rangeStart,
    sourceLen,
    terminal,
  } = job;
  return (start, end, initial) => {
    let accumulator = initial;
    const collected: unknown[] | undefined =
      (terminal.kind === "collect" && terminal.filtered) ||
      terminal.kind === "collectValues"
        ? []
        : undefined;
    elements: for (let index = start; index < end; index++) {
      let value: unknown;
      if (chunkLen > 0) {
        const chunkStart = index * chunkLen;
        const chunkEnd = Math.min(chunkStart + chunkLen, sourceLen);
        if (input === null) {
          value = {
            start: rangeStart + chunkStart,
            end: rangeStart + chunkEnd,
          };
        } else if (Array.isArray(input)) {
          value = input.slice(chunkStart, chunkEnd);
        } else {
          value = input.subarray(chunkStart, chunkEnd);
        }
      } else {
        value = input === null ? rangeStart + index : input[index];
      }
      for (const stage of chain) {
        if (stage.kind === "map") {
          value = stage.fn(value, index);
        } else if (!stage.fn(value, index)) {
          continue elements;
        }
      }
      switch (terminal.kind) {
        case "forEach":
          break;
        case "sum":
          accumulator = (accumulator as number) + (value as number);
          break;
        case "min":
          if ((value as number) < (accumulator as number)) accumulator = value;
          break;
        case "max":
          if ((value as number) > (accumulator as number)) accumulator = value;
          break;
        case "count":
          accumulator = (accumulator as number) + 1;
          break;
        case "fold":
          accumulator = combine!(accumulator, value);
          break;
        case "collect":
          if (terminal.filtered) collected!.push(value);
          else out![index] = value as number;
          break;
        case "collectValues":
          collected!.push(value);
          break;
        case "invoke":
          throw new Error("internal: invoke jobs do not use a chunk runner");
      }
    }
    return collected ?? accumulator;
  };
}

export function createChunkRunner(
  job: JobMessage,
  input: JobMessage["input"],
  chain: Array<{ kind: "map" | "filter"; fn: Kernel }>,
  combine: Kernel | undefined,
): ChunkRunner {
  if (chain.length > MAX_SPECIALIZED_STAGES) {
    return createGenericChunkRunner(job, input, chain, combine);
  }
  const mode = sourceMode(input, job.chunkLen);
  const terminal = terminalCode(job.terminal);
  const factory = compileFactory(
    mode,
    terminal,
    chain.map((stage) => stage.kind),
  );
  return factory(
    chain.map((stage) => stage.fn),
    combine,
    input,
    job.out,
    job.sourceLen,
    job.chunkLen,
    job.rangeStart,
  );
}
