import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

// A quarantined test that fails is run once more, alone, in a fresh process; the
// job passes only if that run passes. A failure outside the list, a failure bun
// cannot name, or a count that disagrees with the named failures fails at once.
//
// Usage: bun scripts/ci/flaky.ts <test files...>   (bun test with one retry)
export type Quarantined = { file: string; test: string; reason: string };

const ROOT = resolve(import.meta.dir, '../..');

export const QUARANTINE: Quarantined[] = JSON.parse(readFileSync(resolve(import.meta.dir, 'quarantine.json'), 'utf8')).tests;

/** Names of the failed tests in bun test output, or undefined unless every counted failure has one. */
export function failedTests(output: string): string[] | undefined {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
  const names = [...clean.matchAll(/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?\r?$/gm)].map(match => match[1]!);
  const count = [...clean.matchAll(/^\s*(\d+) fail\r?$/gm)].reduce((sum, match) => sum + Number(match[1]), 0);
  return names.length > 0 && names.length === count ? names : undefined;
}

/** The entries that cover every failed test of these files (absolute or repo-relative), or undefined when one is not quarantined. */
export function quarantined(names: string[] | undefined, files: string[], list = QUARANTINE): Quarantined[] | undefined {
  if (!names?.length) return undefined;
  const ran = new Set(files.map(file => relative(ROOT, resolve(ROOT, file)).replaceAll('\\', '/')));
  const entries = names.map(name => list.find(entry => entry.test === name && ran.has(entry.file)));
  return entries.every(Boolean) ? [...new Set(entries as Quarantined[])] : undefined;
}

/** A `bun test -t` pattern selecting exactly these tests: bun prints `a > b` and matches `a b`. */
export function namePattern(entries: Quarantined[]): string {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `^(?:${entries.map(entry => entry.test.split(' > ').map(escape).join(' ')).join('|')})$`;
}

export function announce(entries: Quarantined[]): void {
  for (const entry of entries) console.log(`::warning file=${entry.file},title=Quarantined test retried::${entry.test} (${entry.reason})`);
}

async function run(command: string[]): Promise<{ code: number; output: string }> {
  const child = Bun.spawn(command, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  const forward = async (stream: ReadableStream<Uint8Array>, sink: NodeJS.WriteStream) => {
    const decoder = new TextDecoder();
    let text = '';
    for await (const chunk of stream) {
      sink.write(chunk);
      text += decoder.decode(chunk, { stream: true });
    }
    return text + decoder.decode();
  };
  const [stdout, stderr, code] = await Promise.all([forward(child.stdout, process.stdout), forward(child.stderr, process.stderr), child.exited]);
  return { code, output: `${stdout}\n${stderr}` };
}

if (import.meta.main) {
  const files = process.argv.slice(2);
  if (!files.length) throw new Error('usage: bun scripts/ci/flaky.ts <test files...>');
  const first = await run([process.execPath, 'test', ...files]);
  const retry = first.code === 0 ? undefined : quarantined(failedTests(first.output), files);
  if (retry) {
    announce(retry);
    const again = [...new Set(retry.map(entry => entry.file))];
    console.log(`\nRetrying ${retry.length} quarantined test(s) once in ${again.join(', ')}`);
    const second = await run([process.execPath, 'test', ...again.map(file => resolve(ROOT, file)), '-t', namePattern(retry)]);
    console.log(second.code === 0 ? 'Quarantined tests passed on retry' : 'Quarantined tests failed again');
    process.exitCode = second.code;
  } else process.exitCode = first.code;
}
