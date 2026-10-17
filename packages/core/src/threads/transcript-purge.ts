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
import type { Database } from 'bun:sqlite';
import type { Core } from '../core.ts';
import { ownIsolationDir } from '../accounts.ts';
import { messageOf } from '../errors.ts';

/** What Claude Code names a session with; anything else could leave the folder. */
const SESSION_ID = /^[A-Za-z0-9_-]+$/;

export interface NativeSession {
  accountId: string;
  sessionId: string;
}

function fieldOf(text: string | null, field: 'accountId' | 'sessionId'): string | null {
  if (text === null) return null;
  try {
    const value = (JSON.parse(text) as Record<string, unknown>)[field];
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Every session the threads ran on, with the account it ran under: the
 * current one, and each turn's frozen execution and checkpoint, which keep
 * the sessions an account change or a fresh retry left behind.
 */
export function threadSessions(db: Database, threadIds: readonly string[]): NativeSession[] {
  const out = new Map<string, NativeSession>();
  const add = (accountId: string, sessionId: string | null) => {
    if (sessionId !== null) out.set(`${accountId}\0${sessionId}`, { accountId, sessionId });
  };
  const threadQuery = db.query('SELECT account_id, session_id FROM threads WHERE id = ?');
  const turnQuery = db.query('SELECT execution, checkpoint FROM turns WHERE thread_id = ?');
  for (const id of threadIds) {
    const thread = threadQuery.get(id) as { account_id: string; session_id: string | null } | null;
    if (thread === null) continue;
    add(thread.account_id, thread.session_id);
    for (const turn of turnQuery.all(id) as { execution: string | null; checkpoint: string | null }[]) {
      const accountId = fieldOf(turn.execution, 'accountId') ?? thread.account_id;
      add(accountId, fieldOf(turn.execution, 'sessionId'));
      add(accountId, fieldOf(turn.checkpoint, 'sessionId'));
    }
  }
  return [...out.values()];
}

/** The sessions any thread still in the journal names; a fork can resume its source's. */
function referencedSessions(db: Database): Set<string> {
  const out = new Set<string>();
  for (const row of db.query('SELECT session_id FROM threads WHERE session_id IS NOT NULL').all() as { session_id: string }[]) out.add(row.session_id);
  const turns = db.query(`SELECT
      CASE WHEN json_valid(execution) THEN json_extract(execution, '$.sessionId') END AS execution,
      CASE WHEN json_valid(checkpoint) THEN json_extract(checkpoint, '$.sessionId') END AS checkpoint
    FROM turns WHERE execution IS NOT NULL OR checkpoint IS NOT NULL`);
  for (const row of turns.iterate() as Iterable<{ execution: unknown; checkpoint: unknown }>) {
    if (typeof row.execution === 'string') out.add(row.execution);
    if (typeof row.checkpoint === 'string') out.add(row.checkpoint);
  }
  return out;
}

/** `projects/<folder>` directories of a config directory, links left out. */
function projectFolders(dir: string): string[] {
  const projects = join(dir, 'projects');
  try {
    if (lstatSync(projects).isSymbolicLink()) return [];
    return readdirSync(projects, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
      .map(entry => join(projects, entry.name));
  } catch {
    return [];
  }
}

/** A real file or directory; a link, or nothing, is null. */
function kindOf(path: string): 'file' | 'dir' | null {
  try {
    const stat = lstatSync(path);
    return stat.isSymbolicLink() ? null : stat.isFile() ? 'file' : stat.isDirectory() ? 'dir' : null;
  } catch {
    return null;
  }
}

/**
 * Removes the transcripts of sessions no thread names anymore, in accounts
 * Boite isolated itself. A missing file is fine; failures are logged once for
 * the whole pass and never undo the purge. Resolves to the paths removed.
 */
export async function removeTranscripts(core: Core, sessions: readonly NativeSession[]): Promise<string[]> {
  if (sessions.length === 0) return [];
  const removed: string[] = [];
  const failures: string[] = [];
  try {
    // Read before the first await: the journal as the purge left it.
    const kept = referencedSessions(core.journal.db);
    const byAccount = new Map<string, string[]>();
    for (const { accountId, sessionId } of sessions) {
      if (kept.has(sessionId) || !SESSION_ID.test(sessionId)) continue;
      byAccount.set(accountId, [...(byAccount.get(accountId) ?? []), sessionId]);
    }
    for (const [accountId, ids] of byAccount) {
      const account = core.journal.getAccount(accountId);
      if (account === null || core.providers.get(account.providerId)?.protocol !== 'claude-sdk') continue;
      const dir = ownIsolationDir(core.dataDir, account);
      if (dir === null) continue;
      const folders = projectFolders(dir);
      for (const sessionId of ids) {
        for (const folder of folders) {
          for (const [path, kind] of [[join(folder, `${sessionId}.jsonl`), 'file'], [join(folder, sessionId), 'dir']] as const) {
            if (kindOf(path) !== kind) continue;
            try {
              await rm(path, { recursive: kind === 'dir', force: true });
              removed.push(path);
            } catch (error) {
              failures.push(`${path}: ${messageOf(error)}`);
            }
          }
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
