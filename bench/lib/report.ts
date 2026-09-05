import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Row {
  metric: string;
  boite2: string;
  legacy: string;
  note: string;
}

export interface Report {
  date: string;
  host: { platform: string; arch: string; cpus: number; bun: string };
  rows: Row[];
  raw: Record<string, unknown>;
  notMeasured: { what: string; why: string }[];
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

export function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)] as number;
}

export function ms(value: number): string {
  return `${Math.round(value)} ms`;
}

export function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(0)} KB`;
}

export function today(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

const COMPARISON = [
  'A thread is not the same object on the two sides. In Boite 2 a thread is a row in a journal and a',
  'session id: it owns no process until a turn runs, and a hundred of them left the core working set lower',
  'than it started, so the per thread figure is noise rather than a cost. In Boite Legacy a thread is a PTY',
  'with a shell behind it, so it costs a `cmd.exe` and a `conhost.exe` from the moment it opens, and once an',
  'agent is started inside that shell it also costs the CLI process, which stays until the terminal closes.',
  '',
  'The turn figures measure the core, not a model. The echo driver streams the prompt back from memory and',
  'never reaches the network, so `turns.echo50` reports what the scheduler, the journal and the WebSocket',
  'cost for fifty concurrent turns and nothing else. Boite Legacy has no equivalent: its server relays',
  'bytes between a socket and a PTY and does not run turns, so those rows carry no legacy figure.',
  '',
  'The two cold starts are not the same work either. The Boite 2 figure is a TypeScript core interpreted by',
  'Bun, opening SQLite and loading its descriptors. The legacy figure is a compiled Rust binary. The shell',
  'row and the live legacy app row are the closest pair in the table, and even there the legacy figure is',
  'an app with terminals open, not an idle one.',
];

export function toMarkdown(report: Report): string {
  const lines: string[] = [];
  lines.push(`# Boite 2 against Boite Legacy, ${report.date}`);
  lines.push('');
  lines.push(
    `${report.host.platform} ${report.host.arch}, ${report.host.cpus} logical cores, Bun ${report.host.bun}.`,
  );
  lines.push('');
  lines.push('| metric | Boite 2 | Boite Legacy | note |');
  lines.push('| --- | --- | --- | --- |');
  for (const row of report.rows) {
    lines.push(`| ${row.metric} | ${row.boite2} | ${row.legacy} | ${row.note} |`);
  }
  lines.push('');
  lines.push('## What is comparable');
  lines.push('');
  lines.push(...COMPARISON);
  lines.push('');
  lines.push('## Not measured');
  lines.push('');
  for (const entry of report.notMeasured) {
    lines.push(`- ${entry.what}: ${entry.why}`);
  }
  lines.push('');
  return lines.join('\n');
}

export function write(report: Report, directory: string): { json: string; md: string } {
  mkdirSync(directory, { recursive: true });
  const json = join(directory, `${report.date}.json`);
  const md = join(directory, `${report.date}.md`);
  writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(md, toMarkdown(report), 'utf8');
  return { json, md };
}
