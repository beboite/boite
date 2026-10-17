/*
 * A purged thread's native transcripts, in an account Boite isolated itself.
 * Claude Code files each session as `<config dir>/projects/<folder>/<id>.jsonl`
 * with its subagents' sidechains in the `<id>/` folder beside it. Once the
 * journal no longer names a session, nothing in Boite reads it again, so the
 * purge removes both. The user's own `~/.claude` and any directory Boite did
 * not make are never touched (`ownIsolationDir`). Other drivers file their
 * sessions by date or by an id Boite does not keep, so they are left alone.
 */

import { lstatSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Core } from '../core.ts';
import { ownIsolationDir } from '../accounts.ts';
import { messageOf } from '../errors.ts';
import { sessionReferenced, type NativeSession } from './native-sessions.ts';

export { threadSessions, type NativeSession } from './native-sessions.ts';

/** What Claude Code names a session with; anything else could leave the folder. */
const SESSION_ID = /^[A-Za-z0-9_-]+$/;

/** Nothing there, which is no failure; anything else is one the pass reports. */
function missing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** `projects/<folder>` directories of a config directory, links left out. */
function projectFolders(dir: string, failures: string[]): string[] {
  const projects = join(dir, 'projects');
  try {
    if (lstatSync(projects).isSymbolicLink()) return [];
    return readdirSync(projects, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
      .map(entry => join(projects, entry.name));
  } catch (error) {
    if (!missing(error)) failures.push(`${projects}: ${messageOf(error)}`);
    return [];
  }
}

/** A real file or directory; a link, or nothing, is null. */
function kindOf(path: string, failures: string[]): 'file' | 'dir' | null {
  try {
    const stat = lstatSync(path);
    return stat.isSymbolicLink() ? null : stat.isFile() ? 'file' : stat.isDirectory() ? 'dir' : null;
  } catch (error) {
    if (!missing(error)) failures.push(`${path}: ${messageOf(error)}`);
    return null;
  }
}

/**
 * Removes the transcripts of sessions no thread names anymore, in accounts
 * Boite isolated itself. Each path is checked against the journal and the
 * imports in flight right before it goes, since the disk is awaited between
 * paths, and a session being removed cannot be imported meanwhile. A missing
 * file is fine; failures are logged once for the whole pass and never undo
 * the purge. Resolves to the paths removed.
 */
export async function removeTranscripts(core: Core, sessions: readonly NativeSession[]): Promise<string[]> {
  if (sessions.length === 0) return [];
  const removed: string[] = [];
  const failures: string[] = [];
  const free = (sessionId: string): boolean =>
    !core.journal.isClosed() && !core.imports.busy(sessionId) && !sessionReferenced(core.journal.db, sessionId);
  try {
    const byAccount = new Map<string, string[]>();
    for (const { accountId, sessionId } of sessions) {
      if (!SESSION_ID.test(sessionId) || !free(sessionId)) continue;
      byAccount.set(accountId, [...(byAccount.get(accountId) ?? []), sessionId]);
    }
    for (const [accountId, ids] of byAccount) {
      const account = core.journal.getAccount(accountId);
      if (account === null || core.providers.get(account.providerId)?.protocol !== 'claude-sdk') continue;
      const dir = ownIsolationDir(core.dataDir, account);
      if (dir === null) continue;
      const folders = projectFolders(dir, failures);
      for (const sessionId of ids) {
        core.imports.removing.add(sessionId);
        try {
          for (const folder of folders) {
            for (const [path, kind] of [[join(folder, `${sessionId}.jsonl`), 'file'], [join(folder, sessionId), 'dir']] as const) {
              if (kindOf(path, failures) !== kind || !free(sessionId)) continue;
              try {
                await rm(path, { recursive: kind === 'dir', force: true });
                removed.push(path);
              } catch (error) {
                failures.push(`${path}: ${messageOf(error)}`);
              }
            }
          }
        } finally {
          core.imports.removing.delete(sessionId);
        }
      }
    }
  } catch (error) {
    failures.push(messageOf(error));
  }
  if (failures.length > 0) {
    core.log('warn', `thread purge: ${failures.length} native transcript path(s) stay on disk, first ${failures[0]}`);
  }
  return removed;
}
