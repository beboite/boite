import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { chmod, copyFile, link, lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { restoreFiles, type FileChange, type FileEntry } from '../packages/core/src/threads/checkpoint-files.ts';
import { collectSharedBlobs } from '../packages/core/src/threads/checkpoint-files.ts';
import { decodeManifest, readBlob, StoreMigration, trimFolder } from '../packages/core/src/threads/checkpoint-store.ts';
import { KEEP_TURNS } from '../packages/core/src/threads/code-checkpoints.ts';

// Runs the checkpoint store passes on a copy of a real checkpoints folder.
//
//   bun run bench/checkpoint-store.ts --source <checkpoints dir> [--dest <dir>] [--phase copy|run|rewinds|clean|all]
//
// copy: copies the source, opened read-only, into the destination with its
// hard links rebuilt by file ID. run: measures the copy, prepares 20 rewinds
// from kept turns, runs the adoption and compression pass, the 50-turn
// retention (newest manifests by modification time: the journal is not read,
// so the archived-thread rule is not applied) and a collection, measures
// again and runs the 20 rewinds through `restoreFiles`, checking every
// restored file's SHA-256. rewinds: those 20 rewinds alone, on the copy as
// it is. clean: removes the copy and the rewound files. The destination must
// lie outside the source, and the bench only writes or removes a destination
// that holds its mark file, so a wrong --dest cannot touch real data.

const arg = (name: string) => { const index = process.argv.indexOf(`--${name}`); return index < 0 ? undefined : process.argv[index + 1]; };
const source = arg('source');
if (!source) throw new Error('--source <checkpoints dir>: expected the folder to copy');
const dest = resolve(arg('dest') ?? 'D:/Dev/.temp/2026-10-17-boite-opti/bench-tmp');
const phase = arg('phase') ?? 'all';
const copy = join(dest, 'checkpoints');
const rewinds = join(dest, 'rewinds');
const mark = join(dest, '.checkpoint-store-bench');

/** `path` with junctions and links resolved through its nearest existing parent, case-folded on Windows. */
function canonical(path: string): string {
  let head = resolve(path);
  const tail: string[] = [];
  while (!existsSync(head) && dirname(head) !== head) { tail.unshift(basename(head)); head = dirname(head); }
  const full = join(realpathSync.native(head), ...tail);
  return process.platform === 'win32' ? full.toLowerCase() : full;
}
const within = (child: string, parent: string) => { const path = relative(parent, child); return path === '' || (!path.startsWith('..') && !isAbsolute(path)); };
{
  const from = canonical(source), to = canonical(dest);
  if (within(to, from) || within(from, to)) throw new Error(`--dest ${dest}: expected a folder outside --source ${source} that does not contain it`);
}

/** Claims the destination: an empty or missing folder gets the mark, one with other files and no mark is refused. */
async function claim(): Promise<void> {
  if (existsSync(mark)) return;
  const present = (await readdir(dest).catch(() => [] as string[])).filter(name => name === 'checkpoints' || name === 'rewinds');
  if (present.length) throw new Error(`--dest ${dest}: holds ${present.join(' and ')} without the bench's mark file; expected a folder this bench created`);
  await mkdir(dest, { recursive: true });
  await writeFile(mark, 'checkpoint-store bench scratch\n', { flag: 'wx' });
}
const owned = () => {
  if (!existsSync(mark)) throw new Error(`--dest ${dest}: no ${basename(mark)}; expected a folder the copy phase created`);
};
const MiB = 1024 * 1024;

async function pool<T>(items: T[], width: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: width }, async () => { while (next < items.length) await work(items[next++]!); }));
}

/** Every file under `root`, counted once per file ID. */
async function measure(root: string) {
  const inodes = new Map<string, number>();
  let names = 0, manifests = 0, manifestBytes = 0;
  const walk = async (folder: string) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) { await walk(path); continue; }
      const info = await lstat(path, { bigint: true });
      names += 1;
      inodes.set(`${info.dev}:${info.ino}`, Number(info.size));
      if (entry.name.endsWith('.json')) { manifests += 1; manifestBytes += Number(info.size); }
    }
  };
  await walk(root);
  const sizes = [...inodes.values()];
  return {
    names, inodes: inodes.size, manifests,
    bytesMiB: Math.round(sizes.reduce((sum, size) => sum + size, 0) / MiB),
    // NTFS and ext4 allocate 4 KiB clusters; tiny files can sit in the file table instead.
    allocatedMiB: Math.round(sizes.reduce((sum, size) => sum + Math.ceil(size / 4096) * 4096, 0) / MiB),
    manifestMiB: Math.round(manifestBytes / MiB),
  };
}

async function copyPhase(): Promise<void> {
  await claim();
  await rm(copy, { recursive: true, force: true });
  const started = performance.now();
  const files: string[] = [];
  const walk = async (folder: string) => {
    await mkdir(join(copy, folder), { recursive: true });
    for (const entry of await readdir(join(source!, folder), { withFileTypes: true })) {
      const name = folder ? join(folder, entry.name) : entry.name;
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) files.push(name);
    }
  };
  await walk('');
  const first = new Map<string, string>();
  let copied = 0, linked = 0, gone = 0;
  // Files of one inode are linked to the first copy; a second pass keeps that order simple.
  const later: [string, string][] = [];
  for (const name of files) {
    const info = await lstat(join(source!, name), { bigint: true }).catch(() => null);
    if (!info) { gone += 1; continue; }
    const key = `${info.dev}:${info.ino}`;
    const original = first.get(key);
    if (original) later.push([original, name]);
    else first.set(key, name);
  }
  await pool([...first.values()], 4, async name => {
    try { await copyFile(join(source!, name), join(copy, name)); copied += 1; } catch { gone += 1; }
  });
  await pool(later, 4, async ([original, name]) => {
    try { await link(join(copy, original), join(copy, name)); linked += 1; } catch { gone += 1; }
  });
  console.log(JSON.stringify({ phase: 'copy', names: files.length, copied, linked, gone, seconds: Math.round((performance.now() - started) / 1000) }));
}

interface Checkpoint { root: string; before?: Record<string, FileEntry>; after?: Record<string, FileEntry>; reason?: string }

/** The newest `KEEP_TURNS` manifests of each thread folder, by the source's modification times. */
async function keptTurns(): Promise<Map<string, Set<string>>> {
  const kept = new Map<string, Set<string>>();
  for (const folder of await readdir(copy)) {
    if (folder === 'objects') continue;
    const names = (await readdir(join(copy, folder)).catch(() => [] as string[])).filter(name => name.endsWith('.json'));
    const dated = await Promise.all(names.map(async name => ({ name, at: (await lstat(join(source!, folder, name)).catch(() => lstat(join(copy, folder, name)))).mtimeMs })));
    dated.sort((a, b) => a.at - b.at);
    kept.set(folder, new Set(dated.slice(-KEEP_TURNS).map(({ name }) => name.slice(0, -'.json'.length))));
  }
  return kept;
}

interface Sample { folder: string; turnId: string; root: string; changes: FileChange[] }

/**
 * Twenty kept turns that changed backed files, chosen evenly through the
 * folders, with the files as each turn left them written under `rewinds/`.
 */
async function prepareRewinds(kept: Map<string, Set<string>>): Promise<Sample[]> {
  await rm(rewinds, { recursive: true, force: true });
  const candidates: [string, string][] = [];
  for (const [folder, turns] of kept) for (const turnId of [...turns].sort()) candidates.push([folder, turnId]);
  const samples: Sample[] = [];
  // Spread through every folder: a stride first, then the turns it skipped.
  const step = Math.max(1, Math.floor(candidates.length / 60));
  const order = Array.from({ length: step }, (_, offset) => candidates.filter((_, index) => index % step === offset)).flat();
  for (const [folder, turnId] of order) {
    if (samples.length >= 20) break;
    let checkpoint: Checkpoint;
    try { checkpoint = await decodeManifest<Checkpoint>(await readFile(join(copy, folder, `${turnId}.json`))); } catch { continue; }
    if (checkpoint.reason || !checkpoint.before || !checkpoint.after) continue;
    const changes: FileChange[] = [];
    for (const name of new Set([...Object.keys(checkpoint.before), ...Object.keys(checkpoint.after)])) {
      const before = checkpoint.before[name], after = checkpoint.after[name];
      if (before?.hash === after?.hash && before?.mode === after?.mode) continue;
      if (before?.link !== undefined || after?.link !== undefined || before?.unbacked || after?.unbacked) { changes.length = 0; break; }
      changes.push({ name, before, after });
    }
    if (!changes.some(change => change.before)) continue;
    const objects = join(copy, folder, 'objects');
    const root = join(rewinds, `${samples.length}`);
    let usable = true;
    for (const change of changes) {
      if (change.before && !await readBlob(join(objects, change.before.hash), change.before.hash)) { usable = false; break; }
      if (!change.after) continue;
      const bytes = await readBlob(join(objects, change.after.hash), change.after.hash);
      if (!bytes) { usable = false; break; }
      const path = join(root, change.name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
      await chmod(path, change.after.mode);
    }
    if (!usable) { await rm(root, { recursive: true, force: true }); continue; }
    samples.push({ folder, turnId, root, changes });
  }
  return samples;
}

/** The 20 rewinds alone, on the copy as it is now. */
async function rewindPhase(): Promise<void> {
  const samples = await prepareRewinds(await keptTurns());
  console.log(JSON.stringify({ phase: 'rewinds', ...await runRewinds(samples) }, null, 1));
}

async function runRewinds(samples: Sample[]) {
  const checked = [];
  for (const sample of samples) {
    const objects = join(copy, sample.folder, 'objects');
    let result = 'restored';
    try {
      await restoreFiles(sample.root, objects, sample.changes);
      for (const change of sample.changes) {
        const bytes = await readFile(join(sample.root, change.name)).catch(() => null);
        const exact = change.before ? bytes !== null && createHash('sha256').update(bytes).digest('hex') === change.before.hash : bytes === null;
        if (!exact) { result = `mismatch on ${change.name}`; break; }
      }
    } catch (error) { result = error instanceof Error ? error.message : String(error); }
    checked.push({ thread: sample.folder, turn: sample.turnId, files: sample.changes.length, result });
  }
  return { sampled: checked.length, exact: checked.filter(item => item.result === 'restored').length, files: checked.reduce((sum, item) => sum + item.files, 0), failed: checked.filter(item => item.result !== 'restored') };
}

async function runPhase(): Promise<void> {
  const before = await measure(copy);
  const kept = await keptTurns();
  const samples = await prepareRewinds(kept);
  const shared = join(copy, 'objects');
  const migration = new StoreMigration(shared);
  let started = performance.now();
  for (const folder of (await readdir(copy)).sort()) {
    if (folder === 'objects') continue;
    for (const name of await readdir(join(copy, folder, 'objects')).catch(() => [] as string[])) await migration.blob(join(copy, folder, 'objects'), name);
    for (const name of await readdir(join(copy, folder))) if (name.endsWith('.json')) await migration.manifest(join(copy, folder, name));
  }
  const storeSeconds = (performance.now() - started) / 1000;
  const afterStore = await measure(copy);
  started = performance.now();
  const trimmed = { manifests: 0, blobs: 0 };
  for (const [folder, turns] of kept) {
    const removed = await trimFolder(join(copy, folder), turns);
    trimmed.manifests += removed.manifests; trimmed.blobs += removed.blobs;
  }
  const collected = await collectSharedBlobs(shared, 0);
  const retainSeconds = (performance.now() - started) / 1000;
  const after = await measure(copy);

  const rewound = await runRewinds(samples);
  const { bytesRead, ...counts } = migration.counts;
  console.log(JSON.stringify({
    phase: 'run', before, afterStore, after,
    store: { ...counts, readMiB: Math.round(bytesRead / MiB), seconds: Math.round(storeSeconds) },
    retention: { keepTurns: KEEP_TURNS, ...trimmed, collected, seconds: Math.round(retainSeconds) },
    rewinds: rewound,
  }, null, 1));
}

if (phase === 'copy' || phase === 'all') await copyPhase();
if (phase !== 'copy') owned();
if (phase === 'run' || phase === 'all') await runPhase();
if (phase === 'rewinds') await rewindPhase();
// Only what this bench wrote goes: the destination may hold other work.
if (phase === 'clean' || phase === 'all') { await rm(copy, { recursive: true, force: true }); await rm(rewinds, { recursive: true, force: true }); await rm(mark, { force: true }); }
