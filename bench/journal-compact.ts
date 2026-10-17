/**
 * What the journal compaction (schema 36) does to a real journal: sizes per
 * table before and after the background passes, the passes' own cost, what a
 * `VACUUM INTO` gives back, and the page and full reads of the largest
 * threads before and after.
 *
 *   bun bench/journal-compact.ts --journal <journal.db> [--runs 3] [--tmp <dir>]
 *
 * The source is opened read-only and copied with `VACUUM INTO` into a fresh
 * directory under `--tmp` (the system temporary directory by default), so
 * nothing is ever written next to it; the directory is deleted at the end.
 * On the copy, the real `Journal` migrates the file, then the compaction
 * steps (`compactionSteps`) and the event retention (`pruneEventsOnce`) run
 * to completion in a loop, with no timer. Read times are medians over the
 * runs; each run reads every thread once.
 */
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MESSAGE_PAGE } from '../packages/contracts/src/index.ts';
import { Journal } from '../packages/core/src/journal.ts';
import { compactionSteps, pruneEventsOnce } from '../packages/core/src/journal/retention.ts';

const flag = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};
const source = flag('--journal');
if (source === undefined) throw new Error('--journal: expected the path of a journal.db to copy');
const runs = Number(flag('--runs') ?? 3);
if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs: expected a whole number from 1 up, received ${flag('--runs')}`);
const dir = mkdtempSync(join(resolve(flag('--tmp') ?? tmpdir()), 'journal-compact-'));
const MiB = 1024 * 1024;
const mib = (bytes: number) => (bytes / MiB).toFixed(1);
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const ms = (value: number) => value.toFixed(value < 10 ? 2 : 0);
const sqlPath = (path: string) => path.replaceAll('\\', '/').replaceAll("'", "''");

function vacuumInto(from: string, to: string, readonly: boolean): number {
  const db = new Database(from, { readonly });
  try {
    const at = performance.now();
    db.exec(`VACUUM INTO '${sqlPath(to)}'`);
    return performance.now() - at;
  } finally { db.close(); }
}

/** Pages per table, its indexes included, and the bytes of its large columns. */
function sizes(db: Database): Map<string, { pages: number; rows: number; column: number }> {
  const objects = db.query("SELECT name, tbl_name AS tableName FROM sqlite_master WHERE type IN ('table', 'index')").all() as { name: string; tableName: string }[];
  const owner = new Map(objects.map(row => [row.name, row.tableName]));
  const pages = db.query('SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name').all() as { name: string; bytes: number }[];
  const out = new Map<string, { pages: number; rows: number; column: number }>();
  for (const row of pages) {
    const table = owner.get(row.name) ?? row.name;
    const entry = out.get(table) ?? { pages: 0, rows: 0, column: 0 };
    entry.pages += row.bytes;
    out.set(table, entry);
  }
  // `preview` exists from schema 36 on; a column missing from the file counts 0.
  const columns: Record<string, string[]> = {
    part_blobs: ['data', 'preview'], messages: ['parts'], processes: ['command_line'], events: ['payload'], command_lines: ['text'],
  };
  for (const [table, entry] of out) {
    if (!/^[a-z_]+$/.test(table) || table.startsWith('sqlite_')) continue;
    entry.rows = (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const present = new Set((db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(column => column.name));
    for (const column of (columns[table] ?? []).filter(name => present.has(name))) {
      entry.column += (db.query(`SELECT SUM(octet_length(${column})) AS n FROM ${table}`).get() as { n: number | null }).n ?? 0;
    }
  }
  return out;
}

/** The threads holding the most bytes, row and moved values together. */
function largestThreads(db: Database, count: number): { id: string; messages: number; bytes: number }[] {
  return db.query(`SELECT m.thread_id AS id, m.messages, m.bytes + COALESCE(b.bytes, 0) AS bytes
    FROM (SELECT thread_id, COUNT(*) AS messages, SUM(octet_length(parts)) AS bytes FROM messages GROUP BY thread_id) m
    LEFT JOIN (SELECT thread_id, SUM(octet_length(data)) AS bytes FROM part_blobs GROUP BY thread_id) b ON b.thread_id = m.thread_id
    ORDER BY bytes DESC LIMIT ?`).all(count) as { id: string; messages: number; bytes: number }[];
}

interface Reads { page: number; previews: number; full: number; pageBytes: number; previewBytes: number; digest: number }

/**
 * One `threads.get` page with and without tool previews, and every message of
 * the thread hydrated, with a digest of what the full read returned. Messages
 * are hashed one at a time and collected between threads: the largest thread
 * hydrates to hundreds of MiB, and the machine's memory guard stops a process
 * that holds several copies.
 */
function reads(journal: Journal, threadIds: string[]): Map<string, Reads> {
  const samples = new Map(threadIds.map(id => [id, { page: [] as number[], previews: [] as number[], full: [] as number[], pageBytes: 0, previewBytes: 0, digest: 0 }]));
  for (let run = 0; run < runs; run++) {
    for (const id of threadIds) {
      const sample = samples.get(id)!;
      let at = performance.now();
      const page = journal.listMessagePage(id, { limit: MESSAGE_PAGE });
      sample.page.push(performance.now() - at);
      sample.pageBytes = JSON.stringify(page.sent).length;
      at = performance.now();
      const previews = journal.listMessagePage(id, { limit: MESSAGE_PAGE, toolPreviews: true });
      sample.previews.push(performance.now() - at);
      sample.previewBytes = JSON.stringify(previews.sent).length;
      at = performance.now();
      const messages = journal.listMessages(id);
      sample.full.push(performance.now() - at);
      if (run === 0) sample.digest = messages.reduce((hash, message) => Number(Bun.hash.wyhash(JSON.stringify(message), BigInt(hash)) & 0xffffffffn), 0);
      Bun.gc(true);
    }
  }
  return new Map([...samples].map(([id, sample]) => [id, { page: median(sample.page), previews: median(sample.previews), full: median(sample.full), pageBytes: sample.pageBytes, previewBytes: sample.previewBytes, digest: sample.digest }]));
}

/** Closed before the directory is deleted, also when the bench throws: an open file cannot be removed on Windows. */
const opened: { close(): void }[] = [];
const STEP_NAMES = ['values of 32 KiB and more', 'tool outputs of 4 to 32 KiB', 'part_blobs recode', 'command lines', 'trace prune', 'unused command lines'];

try {
  console.log(`# journal-compact ${new Date().toISOString().slice(0, 10)}, Bun ${Bun.version}, ${source}`);
  const before = join(dir, 'before.db');
  const copyMs = vacuumInto(source, before, true);
  const sourceBytes = statSync(source).size, beforeBytes = statSync(before).size;
  console.log(`\nsource ${mib(sourceBytes)} MiB; copy by VACUUM INTO ${mib(beforeBytes)} MiB in ${(copyMs / 1000).toFixed(1)} s`);

  const raw = new Database(before);
  opened.push(raw);
  const sizesBefore = sizes(raw);
  const threads = largestThreads(raw, 5);
  const schemaBefore = (raw.query('PRAGMA user_version').get() as { user_version: number }).user_version;
  // What the first `PRAGMA optimize=0x10002` costs on a file that has no statistics, apart from the migration.
  let at = performance.now();
  raw.exec('PRAGMA optimize=0x10002');
  const firstOptimizeMs = performance.now() - at;
  raw.close();

  at = performance.now();
  const journal = new Journal(before);
  opened.push(journal);
  const openMs = performance.now() - at;
  console.log(`first PRAGMA optimize=0x10002 ${ms(firstOptimizeMs)} ms; Journal open with the schema ${schemaBefore} to ${journal.schema.to} migration ${ms(openMs)} ms`);
  const readsBefore = reads(journal, threads.map(thread => thread.id));
  console.log(`reads before done, RSS ${mib(process.memoryUsage.rss())} MiB`);

  // The passes, one call per tick as the timer would make them, timed per step.
  const steps = compactionSteps(journal);
  const stepStats = steps.map(() => ({ ticks: 0, total: 0, max: 0 }));
  const now = Date.now();
  at = performance.now();
  for (let index = 0; index < steps.length;) {
    const started = performance.now();
    const result = steps[index]!(now);
    const took = performance.now() - started;
    const stat = stepStats[index]!;
    stat.ticks++; stat.total += took; stat.max = Math.max(stat.max, took);
    if (result === 'busy') throw new Error('a message is open in a copied journal');
    if (result === 'done') index++;
  }
  const passesMs = performance.now() - at;
  const events = { ticks: 0, total: 0, max: 0 };
  for (let more = true; more;) {
    const started = performance.now();
    more = pruneEventsOnce(journal, now);
    const took = performance.now() - started;
    events.ticks++; events.total += took; events.max = Math.max(events.max, took);
  }
  at = performance.now();
  journal.optimize();
  const optimizeMs = performance.now() - at;

  console.log(`\n## Passes (${(passesMs / 1000).toFixed(1)} s in all, no pause between ticks)\n`);
  console.log('| step | ticks | total ms | longest tick ms |');
  console.log('| --- | ---: | ---: | ---: |');
  stepStats.forEach((stat, index) => console.log(`| ${STEP_NAMES[index]} | ${stat.ticks} | ${ms(stat.total)} | ${ms(stat.max)} |`));
  console.log(`| event retention | ${events.ticks} | ${ms(events.total)} | ${ms(events.max)} |`);

  const readsAfter = reads(journal, threads.map(thread => thread.id));
  const same = threads.every(thread => readsAfter.get(thread.id)!.digest === readsBefore.get(thread.id)!.digest);
  const sizesAfter = sizes(journal.db);
  const commandIndex = (journal.db.query("SELECT SUM(pgsize) AS n FROM dbstat WHERE name = 'processes_by_command'").get() as { n: number | null }).n ?? 0;
  journal.close();
  // What `PRAGMA optimize=0x10002` costs at a later start, once statistics exist.
  const reopened = new Database(before);
  opened.push(reopened);
  at = performance.now();
  reopened.exec('PRAGMA optimize=0x10002');
  const laterOptimizeMs = performance.now() - at;
  reopened.close();
  const afterBytes = statSync(before).size;
  const vacuumed = join(dir, 'after.db');
  const vacuumMs = vacuumInto(before, vacuumed, true);
  const vacuumedBytes = statSync(vacuumed).size;

  console.log(`\n## Sizes (dbstat pages, indexes included; column = octet_length of the large columns)\n`);
  console.log('| table | rows before | rows after | pages before MiB | pages after MiB | column before MiB | column after MiB |');
  console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  const tables = [...new Set([...sizesBefore.keys(), ...sizesAfter.keys()])]
    .sort((a, b) => (sizesBefore.get(b)?.pages ?? 0) - (sizesBefore.get(a)?.pages ?? 0)).slice(0, 10);
  for (const table of tables) {
    const b = sizesBefore.get(table), a = sizesAfter.get(table);
    console.log(`| ${table} | ${b?.rows ?? 0} | ${a?.rows ?? 0} | ${mib(b?.pages ?? 0)} | ${mib(a?.pages ?? 0)} | ${mib(b?.column ?? 0)} | ${mib(a?.column ?? 0)} |`);
  }
  const total = (map: typeof sizesBefore) => [...map.values()].reduce((sum, entry) => sum + entry.pages, 0);
  console.log(`| all | | | ${mib(total(sizesBefore))} | ${mib(total(sizesAfter))} | | |`);
  console.log(`\nfile: copy ${mib(beforeBytes)} MiB, after the passes ${mib(afterBytes)} MiB (free pages stay in the file), VACUUM INTO ${mib(vacuumedBytes)} MiB in ${(vacuumMs / 1000).toFixed(1)} s`);
  console.log(`processes_by_command index: ${mib(commandIndex)} MiB; daily PRAGMA optimize ${ms(optimizeMs)} ms; PRAGMA optimize=0x10002 at a later start ${ms(laterOptimizeMs)} ms`);
  console.log(`peak RSS ${mib(process.resourceUsage().maxRSS * 1024)} MiB`);

  console.log(`\n## Reads of the 5 largest threads (median of ${runs} runs, ms; page = listMessagePage limit ${MESSAGE_PAGE})\n`);
  console.log(`messages read back identical after the passes: ${same}\n`);
  console.log('| thread | messages | MiB | page before | page after | previews before | previews after | page KiB before/after | full before | full after |');
  console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const thread of threads) {
    const b = readsBefore.get(thread.id)!, a = readsAfter.get(thread.id)!;
    console.log(`| ${thread.id.slice(0, 8)} | ${thread.messages} | ${mib(thread.bytes)} | ${ms(b.page)} | ${ms(a.page)} | ${ms(b.previews)} | ${ms(a.previews)} | ${(b.previewBytes / 1024).toFixed(0)}/${(a.previewBytes / 1024).toFixed(0)} | ${ms(b.full)} | ${ms(a.full)} |`);
  }
} finally {
  for (const handle of opened) try { handle.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
}
