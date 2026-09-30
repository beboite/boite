import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ThreadRewind, ThreadSummary } from '@boite/contracts';
import type { Core } from '../core.ts';
import { messageOf, refused } from '../errors.ts';
import { contains, restoreFiles, same, snapshot, workspaceRoot, type FileChange, type FileSnapshot } from './checkpoint-files.ts';

type FileResult = NonNullable<ThreadRewind['files']>;
interface Checkpoint { root: string; messages?: string[]; before?: FileSnapshot; after?: FileSnapshot; reason?: string }
interface Active { threadId: string; turnId: string; checkpoint: Checkpoint }

/** Private file snapshots, independent of the driver's native conversation checkpoints. */
export class CodeCheckpoints {
  private readonly active = new Map<string, Active>();
  private readonly restoring = new Set<string>();
  private pruned: Promise<void> | undefined;

  constructor(private readonly core: Core) {
    this.pruned = this.prune().catch(error => this.core.log('warn', `file checkpoint cleanup failed: ${messageOf(error)}`));
  }
  private folder(threadId: string): string { return join(this.core.dataDir, 'checkpoints', threadId); }
  private objects(threadId: string): string { return join(this.folder(threadId), 'objects'); }

  assertAvailable(cwd: string): void {
    if ([...this.restoring].some(root => contains(root, cwd) || contains(cwd, root))) {
      throw refused('the project files are being restored; wait before starting another turn', { field: 'cwd', path: cwd, reason: 'rewind-in-flight' });
    }
  }

  begin(thread: ThreadSummary, turnId: string): Promise<void> | undefined {
    // Persistent sessions and a workspace containing the database cannot be
    // snapshotted. Preserve synchronous admission when there is no file work.
    if (thread.agentSessionId || contains(thread.cwd, this.core.dataDir)) return;
    return this.capture(thread, turnId);
  }

  private async capture(thread: ThreadSummary, turnId: string): Promise<void> {
    let root: string;
    try { root = await workspaceRoot(thread.cwd); } catch { return; }
    const checkpoint: Checkpoint = { root, messages: [...this.core.journal.walkTurnMessages(thread.id, turnId)].filter(message => message.role === 'user').map(message => message.id) };
    this.assertAvailable(root);
    for (const other of this.active.values()) {
      if (contains(root, other.checkpoint.root) || contains(other.checkpoint.root, root)) {
        checkpoint.reason = other.checkpoint.reason = 'turns ran concurrently in the same workspace';
      }
    }
    this.active.set(turnId, { threadId: thread.id, turnId, checkpoint });
    try {
      this.pruned ??= this.prune();
      await this.pruned;
      checkpoint.before = await snapshot(this.core, thread.id, root, this.objects(thread.id));
      await this.save(thread.id, turnId, checkpoint);
    } catch (error) { checkpoint.reason = messageOf(error); }
  }

  end(turnId: string): Promise<void> | undefined {
    const active = this.active.get(turnId);
    if (!active) return;
    return this.finish(active);
  }

  private async finish(active: Active): Promise<void> {
    const { turnId } = active;
    try {
      const { checkpoint, threadId } = active;
      if (!checkpoint.reason) checkpoint.after = await snapshot(this.core, threadId, checkpoint.root, this.objects(threadId));
      await this.save(threadId, turnId, checkpoint);
    } catch (error) {
      active.checkpoint.reason = messageOf(error);
      try { await this.save(active.threadId, turnId, active.checkpoint); }
      catch (failure) { this.core.log('warn', `file checkpoint ${turnId} unavailable: ${messageOf(failure)}`); }
    } finally { this.active.delete(turnId); }
  }

  /** Hold the workspace through both the file restoration and the journal cut. */
  async rewind<T>(thread: ThreadSummary, turnIds: string[], messageId: string, cut: (files: FileResult) => T): Promise<T> {
    const root = await workspaceRoot(thread.cwd);
    this.assertAvailable(root);
    if ([...this.active.values()].some(active => contains(root, active.checkpoint.root) || contains(active.checkpoint.root, root))) {
      throw refused('another turn is working in this project; stop it before restoring files', { field: 'cwd', path: root, reason: 'turn-in-flight' });
    }
    this.restoring.add(root);
    try {
      const { files, changes } = await this.restore(thread, root, turnIds, messageId);
      try { return cut(files); }
      catch (error) {
        await restoreFiles(root, this.objects(thread.id), changes.map(change => ({ name: change.name, before: change.after, after: change.before })));
        throw error;
      }
    }
    finally { this.restoring.delete(root); }
  }

  private async restore(thread: ThreadSummary, root: string, turnIds: string[], messageId: string): Promise<{ files: FileResult; changes: FileChange[] }> {
    const unavailable = (reason: string) => ({ files: { status: 'unavailable' as const, count: 0, reason }, changes: [] });
    const changes = new Map<string, FileChange>();
    for (const turnId of turnIds) {
      let checkpoint: Checkpoint;
      try { checkpoint = JSON.parse(await readFile(join(this.folder(thread.id), `${turnId}.json`), 'utf8')) as Checkpoint; }
      catch { return unavailable('this turn has no saved file checkpoint'); }
      if (checkpoint.reason || !checkpoint.before || !checkpoint.after || checkpoint.root !== root) {
        return unavailable(checkpoint.reason ?? 'this turn has no complete checkpoint in the current folder');
      }
      if (this.core.journal.getMessage(messageId)?.turnId === turnId && !checkpoint.messages?.includes(messageId)) {
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
    await restoreFiles(root, this.objects(thread.id), modified);
    return { files: { status: modified.length ? 'restored' : 'unchanged', count: modified.length }, changes: modified };
  }

  private async save(threadId: string, turnId: string, checkpoint: Checkpoint): Promise<void> {
    const folder = this.folder(threadId);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const path = join(folder, `${turnId}.json`);
    await writeFile(`${path}.tmp`, JSON.stringify(checkpoint), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  }

  async discard(threadIds: string[]): Promise<void> {
    for (const threadId of threadIds) await rm(this.folder(threadId), { recursive: true, force: true });
  }

  /** Deletions kept undoable in a session are purged by the journal on restart. */
  private async prune(): Promise<void> {
    let entries;
    try { entries = await readdir(join(this.core.dataDir, 'checkpoints'), { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (!this.core.journal.isClosed()) await this.discard(entries.filter(entry => entry.isDirectory() && !this.core.journal.getThread(entry.name)).map(entry => entry.name));
  }
}
