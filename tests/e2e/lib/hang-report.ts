import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * What the test process says about itself when `scripts/ci/hang-watch.ts`
 * stops a run that outlived its deadline. Modules that start something a test
 * can hang on (a browser page, a shell) register a source; the watch asks
 * through the Bun inspector with `hangReportExpression`, and the report lands
 * in a file because the inspector does not await a promise. A test process
 * whose JavaScript thread is blocked never answers: the watch says so and
 * keeps what it can see from outside.
 */
export type HangSource = () => string | Promise<string>;

const KEY = Symbol.for('boite.e2e.hang-report');
/** Each source gets this long; a page that hangs costs its own lines, not the report. */
const SOURCE_TIMEOUT_MS = 20_000;

interface Registry { sources: Map<string, HangSource>; write: (path: string) => number }

// On `globalThis` so that a second copy of this module, loaded under another
// specifier, shares the same sources and the same entry point.
const registry: Registry = ((globalThis as Record<symbol, Registry | undefined>)[KEY] ??= {
  sources: new Map(),
  write: (path: string) => {
    void writeHangReport(path);
    return registry.sources.size;
  },
});

/** Adds `describe` under `name` to the report; the returned function removes it. */
export function reportOnHang(name: string, describe: HangSource): () => void {
  registry.sources.set(name, describe);
  return () => {
    if (registry.sources.get(name) === describe) registry.sources.delete(name);
  };
}

/** The expression the watch evaluates: it starts the report and returns how many sources it has, -1 when none were ever loaded. */
export function hangReportExpression(path: string): string {
  return `globalThis[Symbol.for('boite.e2e.hang-report')]?.write(${JSON.stringify(path)}) ?? -1`;
}

/** Every source's text, each bounded by `timeoutMs`, written to `path` in one rename. */
export async function writeHangReport(path: string, timeoutMs = SOURCE_TIMEOUT_MS): Promise<void> {
  const memory = process.memoryUsage();
  const parts = [
    `Test file: ${Bun.main}`,
    `Memory: rss ${mb(memory.rss)}, heap ${mb(memory.heapUsed)} of ${mb(memory.heapTotal)}`,
  ];
  const texts = await Promise.all([...registry.sources].map(async ([name, describe]) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<string>((resolve) => { timer = setTimeout(() => resolve(`(no answer within ${timeoutMs} ms)`), timeoutMs); });
    const text = await Promise.race([Promise.resolve().then(describe), late])
      .catch((error: unknown) => `(failed: ${error instanceof Error ? error.message : String(error)})`)
      .finally(() => clearTimeout(timer));
    return `== ${name}\n${text}`;
  }));
  parts.push(...(texts.length > 0 ? texts : ['(no browser page or shell registered)']));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.part`, `${parts.join('\n\n')}\n`);
  renameSync(`${path}.part`, path);
}

function mb(bytes: number): string {
  return `${Math.round(bytes / 1048576)} MB`;
}
