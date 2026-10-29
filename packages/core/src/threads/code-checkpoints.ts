import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { ThreadRewind, ThreadSummary } from '@boite/contracts';
import type { Core } from '../core.ts';
import { messageOf, refused } from '../errors.ts';
import { collectSharedBlobs, contains, overlap, restoreFiles, same, snapshot, workspaceRoot, type FileChange, type FileSnapshot, type SnapshotCache } from './checkpoint-files.ts';
import { decodeManifest, encodeManifest, StoreMigration, trimFolder } from './checkpoint-store.ts';

type FileResult = NonNullable<ThreadRewind['files']>;
interface Checkpoint { root: string; messages?: string[]; before?: FileSnapshot; after?: FileSnapshot; reason?: string }
interface Active { threadId: string; turnId: string; checkpoint: Checkpoint }

/** About 300 bytes each: the metadata cache stays near 30 MB at worst. */
const CACHED_FILES = 100_000;
/** Blobs written this recently stay through a collection: a snapshot may be linking them. */
const COLLECT_GRACE_MS = 10 * 60_000;
/** The shared blob store, beside the thread folders; never a thread id. */
const SHARED = 'objects';
/** Turns of one thread that keep their checkpoints; older ones lose their rewind. */
export const KEEP_TURNS = 50;
/** A thread archived or done longer than this keeps no checkpoint. */
export const IDLE_THREAD_MS = 7 * 86_400_000;
/** A thread is trimmed at the end of a turn once it holds this many more manifests than it keeps. */
const TRIM_SLACK = 10;
/** The background pass: first a few minutes after start, then bounded ticks, then a retention sweep now and then. */
const STORE_FIRST_MS = 3 * 60_000;
const STORE_TICK_MS = 200;
const STORE_WAIT_MS = 1000;
const RETAIN_EVERY_MS = 6 * 3_600_000;
const TICK_NAMES = 500;
const TICK_BYTES = 16 * 1024 * 1024;
/** The last thread folder moved to the shared, compressed form; `true` once every folder was. */
const STORE_CURSOR = 'checkpoints:stored-through';

/** `paths`: the blobs, then the manifests, of the folder under way. */
interface Walk { folders: string[]; index: number; paths?: string[]; next: number }

/** Private file snapshots, independent of the driver's native conversation checkpoints. */
export class CodeCheckpoints {
  readonly #active = new Map<string, Active>();
  readonly #restoring = new Set<string>();
  /** Threads a rewind is reading; a trim waits for them. */
  readonly #rewinding = new Set<string>();
  /** A trim in flight per thread, which a turn or a rewind of that thread waits for. */
  readonly #trims = new Map<string, Promise<void>>();
  /** File metadata per real workspace root, least recently used first. */
  readonly #previous = new Map<string, SnapshotCache>();
  #pruned: Promise<void> | undefined;
  #collecting: Promise<number> | undefined;
  /** Snapshots and saves under way; the background pass waits while any is. */
  private writing = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #pass: Promise<void> | undefined;
  #walk: Walk | undefined;
  #migration: StoreMigration | undefined;
  #closed = false;

  readonly #core: Core;
  constructor(core: Core) {
    this.#core = core;
    this.#pruned = this.#prune().catch(error => this.#core.log('warn', `file checkpoint cleanup failed: ${messageOf(error)}`));
    void this.#pruned.then(() => this.collect());
    this.#arm(STORE_FIRST_MS);
  }
  #root(): string { return join(this.#core.dataDir, 'checkpoints'); }
  #folder(threadId: string): string { return join(this.#root(), threadId); }
  #objects(threadId: string): string { return join(this.#folder(threadId), 'objects'); }
  #shared(): string { return join(this.#root(), SHARED); }

  /**
   * Blobs live once in the shared store, so threads on the same root reuse
   * one metadata map; a hit only links the blob into the thread's folder.
   */
  async #cachedSnapshot(threadId: string, root: string): Promise<FileSnapshot> {
    const files = this.#previous.get(root) ?? new Map();
    this.#previous.delete(root);
    this.#previous.set(root, files);
    let total = 0;
    for (const cached of this.#previous.values()) total += cached.size;
    for (const [key, cached] of this.#previous) {
      if (total <= CACHED_FILES || key === root) break;
      total -= cached.size;
      this.#previous.delete(key);
    }
    this.writing += 1;
    try { return await snapshot(this.#core, threadId, root, this.#objects(threadId), files, this.#shared()); }
    finally { this.writing -= 1; }
  }

  /** Cached metadata that names a folder whose blobs were removed is forgotten. */
  #forget(objects: string): void {
    for (const files of this.#previous.values()) for (const [name, cached] of files) if (cached.objects === objects) files.delete(name);
  }

  /**
   * Remove shared blobs that no thread folder links to, in the background.
   * Runs after startup cleanup and after a discard, one pass after another.
   */
  collect(graceMs = COLLECT_GRACE_MS): Promise<number> {
    const pass = (this.#collecting ?? Promise.resolve(0)).then(() => collectSharedBlobs(this.#shared(), graceMs))
      .catch(error => { this.#core.log('warn', `file checkpoint blob cleanup failed: ${messageOf(error)}`); return 0; });
    this.#collecting = pass;
    return pass;
  }

  assertAvailable(cwd: string): void {
    if ([...this.#restoring].some(root => contains(root, cwd) || contains(cwd, root))) {
      throw refused('the project files are being restored; wait before starting another turn', { field: 'cwd', path: cwd, reason: 'rewind-in-flight' });
    }
  }

  begin(thread: ThreadSummary, turnId: string): Promise<void> | undefined {
    // Persistent sessions and a workspace containing the database cannot be
    // snapshotted. Preserve synchronous admission when there is no file work.
    if (thread.agentSessionId || contains(thread.cwd, this.#core.dataDir)) return;
    return this.#capture(thread, turnId);
  }

  async #capture(thread: ThreadSummary, turnId: string): Promise<void> {
    let root: string;
    try { root = await workspaceRoot(thread.cwd); } catch { return; }
    const checkpoint: Checkpoint = { root, messages: [...this.#core.journal.walkTurnMessages(thread.id, turnId, { blobs: false })].filter(message => message.role === 'user').map(message => message.id) };
    this.assertAvailable(root);
    // Registered first: a turn that starts while this one compares sees it.
    const others = [...this.#active.values()];
    this.#active.set(turnId, { threadId: thread.id, turnId, checkpoint });
    try {
      for (const other of others) {
        if (await overlap(this.#core, thread.id, root, other.checkpoint.root)) checkpoint.reason = other.checkpoint.reason = 'turns ran concurrently in the same workspace';
      }
      this.#pruned ??= this.#prune();
      await this.#pruned;
      await this.#trims.get(thread.id);
      checkpoint.before = await this.#cachedSnapshot(thread.id, root);
      await this.#save(thread.id, turnId, checkpoint);
    } catch (error) { checkpoint.reason = messageOf(error); }
  }

  end(turnId: string): Promise<void> | undefined {
    const active = this.#active.get(turnId);
    if (!active) return;
    return this.#finish(active);
  }

  async #finish(active: Active): Promise<void> {
    const { turnId } = active;
    try {
      const { checkpoint, threadId } = active;
      if (!checkpoint.reason) checkpoint.after = await this.#cachedSnapshot(threadId, checkpoint.root);
      await this.#save(threadId, turnId, checkpoint);
    } catch (error) {
      active.checkpoint.reason = messageOf(error);
      try { await this.#save(active.threadId, turnId, active.checkpoint); }
      catch (failure) { this.#core.log('warn', `file checkpoint ${turnId} unavailable: ${messageOf(failure)}`); }
    } finally { this.#active.delete(turnId); }
    void this.#trimFull(active.threadId);
  }

  /** Hold the workspace through both the file restoration and the journal cut. */
  async rewind<T>(thread: ThreadSummary, turnIds: string[], messageId: string, cut: (files: FileResult) => T): Promise<T> {
    this.#core.sharedAccess.denyTool(thread.id);
    this.#rewinding.add(thread.id);
    try {
      await this.#trims.get(thread.id);
      return await this.#rewindHeld(thread, turnIds, messageId, cut);
    } finally { this.#rewinding.delete(thread.id); }
  }

  async #rewindHeld<T>(thread: ThreadSummary, turnIds: string[], messageId: string, cut: (files: FileResult) => T): Promise<T> {
    let root: string;
    try { root = await workspaceRoot(thread.cwd); }
    catch (error) { return cut({ status: 'unavailable', count: 0, reason: `the working directory is unavailable: ${messageOf(error)}` }); }
    this.assertAvailable(root);
    // Held before comparing, so no turn starts here while the files are restored.
    this.#restoring.add(root);
    try {
      // A turn still working here (a sub-agent winding down after a Stop, a
      // second conversation) ran beside the removed ones, so their checkpoint
      // is not exact, and restoring would write under that agent. The edit
      // still goes through; only the files stay as they are.
      for (const active of [...this.#active.values()]) {
        if (await overlap(this.#core, thread.id, root, active.checkpoint.root)) {
          return cut({ status: 'unavailable', count: 0, reason: 'another turn is working in this folder; files were left as they are', busy: true });
        }
      }
      const { files, changes } = await this.#restore(thread, root, turnIds, messageId);
      try { return cut(files); }
      catch (error) {
        await restoreFiles(root, this.#objects(thread.id), changes.map(change => ({ name: change.name, before: change.after, after: change.before })));
        throw error;
      }
    }
    finally { this.#restoring.delete(root); }
  }

  async #restore(thread: ThreadSummary, root: string, turnIds: string[], messageId: string): Promise<{ files: FileResult; changes: FileChange[] }> {
    const unavailable = (reason: string) => ({ files: { status: 'unavailable' as const, count: 0, reason }, changes: [] });
    const changes = new Map<string, FileChange>();
    for (const turnId of turnIds) {
      let checkpoint: Checkpoint;
      try { checkpoint = await decodeManifest<Checkpoint>(await readFile(join(this.#folder(thread.id), `${turnId}.json`))); }
      catch { return unavailable(this.#beyondKept(thread.id, turnId) ? `file checkpoints are kept for the newest ${KEEP_TURNS} turns of a conversation` : 'this turn has no saved file checkpoint'); }
      if (checkpoint.reason || !checkpoint.before || !checkpoint.after || checkpoint.root !== root) {
        return unavailable(checkpoint.reason ?? 'this turn has no complete checkpoint in the current folder');
      }
      if (this.#core.journal.getMessage(messageId)?.turnId === turnId && !checkpoint.messages?.includes(messageId)) {
        return unavailable('no file checkpoint inside a running turn');
      }
      for (const name of new Set([...Object.keys(checkpoint.before), ...Object.keys(checkpoint.after)])) {
        const before = Object.hasOwn(checkpoint.before, name) ? checkpoint.before[name] : undefined;
        const after = Object.hasOwn(checkpoint.after, name) ? checkpoint.after[name] : undefined;
        const previous = changes.get(name);
        if (previous && !same(previous.after, before)) {
          throw refused(`cannot rewind: ${name} changed between the removed turns`, { field: 'path', path: name, reason: 'file-conflict' });
        }
        if (previous) previous.after = after;
        else if (!same(before, after)) changes.set(name, { name, before, after });
      }
    }
    const modified = [...changes.values()].filter(change => !same(change.before, change.after));
    const unbacked = modified.find(change => change.before?.unbacked || change.after?.unbacked);
    if (unbacked) return unavailable(`${unbacked.name} had a version over the 16 MiB checkpoint limit, which has no backup`);
    await restoreFiles(root, this.#objects(thread.id), modified);
    return { files: { status: modified.length ? 'restored' : 'unchanged', count: modified.length }, changes: modified };
  }

  /** Whether `turnId` is older than the turns whose checkpoints a thread keeps. */
  #beyondKept(threadId: string, turnId: string): boolean {
    const turns = this.#core.journal.listTurns(threadId);
    const index = turns.findIndex(turn => turn.id === turnId);
    return index >= 0 && turns.length - index > KEEP_TURNS;
  }

  async #save(threadId: string, turnId: string, checkpoint: Checkpoint): Promise<void> {
    const folder = this.#folder(threadId);
    this.writing += 1;
    try {
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const path = join(folder, `${turnId}.json`);
      await writeFile(`${path}.tmp`, await encodeManifest(checkpoint), { mode: 0o600 });
      await rename(`${path}.tmp`, path);
    } finally { this.writing -= 1; }
  }

  async discard(threadIds: string[]): Promise<void> {
    const folders = threadIds.filter(threadId => threadId !== SHARED);
    for (const threadId of folders) await rm(this.#folder(threadId), { recursive: true, force: true });
    if (folders.length) void this.collect();
  }

  /** Deletions kept undoable in a session are purged by the journal on restart. */
  async #prune(): Promise<void> {
    let entries;
    try { entries = await readdir(this.#root(), { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (!this.#core.journal.isClosed()) await this.discard(entries.filter(entry => entry.isDirectory() && !this.#core.journal.getThread(entry.name)).map(entry => entry.name));
  }

  /**
   * Run one trim of a thread at a time, never beside its turn or its rewind:
   * blobs a snapshot just wrote are in no manifest yet.
   */
  #trim(threadId: string, work: () => Promise<void>): Promise<void> {
    if (this.#trims.has(threadId) || this.#rewinding.has(threadId) || [...this.#active.values()].some(active => active.threadId === threadId)) return Promise.resolve();
    const running = work().catch(error => { if (!this.#closed) this.#core.log('warn', `file checkpoint retention for ${threadId} failed: ${messageOf(error)}`); })
      .finally(() => this.#trims.delete(threadId));
    this.#trims.set(threadId, running);
    return running;
  }

  /** At the end of a turn, a thread far over its kept turns drops the oldest. */
  async #trimFull(threadId: string): Promise<void> {
    const names = await readdir(this.#folder(threadId)).catch(() => [] as string[]);
    if (names.filter(name => name.endsWith('.json')).length > KEEP_TURNS + TRIM_SLACK) await this.retainThread(threadId);
  }

  /**
   * Keep the newest `KEEP_TURNS` turns of a thread, and nothing for a thread
   * archived or done longer than `IDLE_THREAD_MS`. The shared blobs no folder
   * links any more leave at the next collection.
   */
  retainThread(threadId: string, now = Date.now()): Promise<void> {
    return this.#trim(threadId, async () => {
      const thread = this.#core.journal.isClosed() ? null : this.#core.journal.getThread(threadId);
      if (!thread) return;
      // Restoring clears `doneAt`; the archived flag is still the one that counts.
      const since = thread.archived ? thread.doneAt ?? thread.archivedAt ?? thread.updatedAt : null;
      if (since != null && now - since > IDLE_THREAD_MS) {
        await rm(this.#folder(threadId), { recursive: true, force: true });
        this.#forget(this.#objects(threadId));
        return;
      }
      const names = (await readdir(this.#folder(threadId)).catch(() => [] as string[])).filter(name => name.endsWith('.json')).map(name => name.slice(0, -'.json'.length));
      if (names.length <= KEEP_TURNS) return;
      const order = new Map(this.#core.journal.listTurns(threadId).map((turn, index) => [turn.id, index]));
      names.sort((a, b) => (order.get(a) ?? -1) - (order.get(b) ?? -1));
      const removed = await trimFolder(this.#folder(threadId), new Set(names.slice(-KEEP_TURNS)));
      if (removed.blobs) this.#forget(this.#objects(threadId));
    });
  }

  /**
   * The background pass, to completion: thread folders moved to the shared,
   * compressed form (once), retention on every thread, then a collection.
   * The timer runs it in bounded ticks; tests and the restart path call it whole.
   */
  async maintain(now = Date.now()): Promise<void> {
    while (!this.#closed && !await this.migrateSome(Infinity)) { /* until every folder is done */ }
    await this.#retainAll(now);
    await this.collect();
  }

  #arm(delay: number): void {
    if (this.#closed) return;
    this.#timer = setTimeout(() => { this.#timer = null; this.#pass = this.#tick(); }, delay);
    this.#timer.unref?.();
  }

  async #tick(): Promise<void> {
    if (this.#closed || this.#core.journal.isClosed()) return;
    if (this.writing > 0 || this.#restoring.size > 0) { this.#arm(STORE_WAIT_MS); return; }
    try {
      if (!await this.migrateSome(TICK_NAMES)) { this.#arm(STORE_TICK_MS); return; }
      await this.#retainAll(Date.now());
      await this.collect();
    } catch (error) {
      if (this.#closed) return;
      this.#core.log('warn', `file checkpoint store pass failed: ${messageOf(error)}`);
    }
    this.#arm(RETAIN_EVERY_MS);
  }

  /**
   * Up to `names` blobs and manifests of the walk, stopping early when a
   * snapshot starts. True once every thread folder was moved, which a setting
   * keeps across restarts.
   */
  private async migrateSome(names: number): Promise<boolean> {
    if (this.#core.journal.isClosed()) return true;
    const cursor = this.#core.journal.getSetting(STORE_CURSOR);
    if (cursor === true) return true;
    if (!this.#walk) {
      const after = typeof cursor === 'string' ? cursor : '';
      const entries = await readdir(this.#root(), { withFileTypes: true }).catch(() => []);
      this.#walk = { folders: entries.filter(entry => entry.isDirectory() && entry.name !== SHARED && entry.name > after).map(entry => entry.name).sort(), index: 0, next: 0 };
    }
    const walk = this.#walk;
    const migration = this.#migration ??= new StoreMigration(this.#shared());
    const bytes = migration.counts.bytesRead + TICK_BYTES;
    let done = 0;
    while (walk.index < walk.folders.length) {
      const threadId = walk.folders[walk.index]!;
      if (!walk.paths) {
        const objects = (await readdir(this.#objects(threadId)).catch(() => [] as string[])).map(name => join(this.#objects(threadId), name));
        const manifests = (await readdir(this.#folder(threadId)).catch(() => [] as string[])).filter(name => name.endsWith('.json')).map(name => join(this.#folder(threadId), name));
        walk.paths = [...objects, ...manifests];
      }
      while (walk.next < walk.paths.length) {
        if (this.#closed || (names !== Infinity && (done >= names || migration.counts.bytesRead >= bytes || this.writing > 0))) return false;
        const path = walk.paths[walk.next]!;
        if (!path.endsWith('.json')) await migration.blob(dirname(path), basename(path));
        else if (!this.#active.has(basename(path, '.json'))) await migration.manifest(path);
        walk.next += 1; done += 1;
      }
      if (this.#core.journal.isClosed()) return true;
      this.#core.journal.setSetting(STORE_CURSOR, threadId);
      walk.index += 1; walk.paths = undefined; walk.next = 0;
    }
    if (this.#core.journal.isClosed()) return true;
    this.#core.journal.setSetting(STORE_CURSOR, true);
    const { linked, adopted, compressed, manifests, mismatched, unlinked } = migration.counts;
    this.#core.log('info', `file checkpoint store: ${linked} copies linked, ${adopted} adopted, ${compressed} blobs and ${manifests} manifests compressed, ${mismatched} not matching their name, ${unlinked} kept without a hard link`);
    this.#walk = undefined; this.#migration = undefined;
    return true;
  }

  async #retainAll(now: number): Promise<void> {
    const entries = await readdir(this.#root(), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (this.#closed) return;
      if (entry.isDirectory() && entry.name !== SHARED) await this.retainThread(entry.name, now);
    }
  }

  /** Stops the background pass and waits for the step under way. */
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    await this.#pass;
    await Promise.all(this.#trims.values());
  }
}
