/*
 * Sessions an agent ran outside Boite, brought in as threads. Only Claude Code
 * keeps transcripts Boite can read today: every account on the `claude-sdk`
 * protocol has a config directory (its isolation directory, or the user's own
 * `~/.claude`), and `projects/<folder>` under it holds one `.jsonl` per
 * session of that working directory. A listing reads each file's first
 * prompt and its last title record, and reuses them while the file is
 * unchanged; an import reads it whole and writes one finished turn per prompt, then sets
 * the session id so the next turn resumes where the CLI left off.
 */

import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Account, AccountId, ImportableSession, Project, ProjectId, ThreadSummary } from '@boite/contracts';
import type { Core } from './core.ts';
import { notFound, refused } from './errors.ts';
import { claudeProjectFolder, listTranscript, readTranscript } from './imports/claude.ts';
import type { TranscriptListing } from './imports/claude.ts';
import { sessionThreads } from './journal/thread-rows.ts';
import { currentOs } from './paths.ts';
import { titleFromPrompt } from './titles.ts';

const SESSION_ID = /^[A-Za-z0-9_-]+$/;

/** The same folder whatever the case of the drive letter or a separator's direction, on Windows. */
function sameFolder(a: string, b: string): boolean {
  const norm = (path: string): string => {
    const slashed = path.replace(/[\\/]+/g, '/').replace(/\/$/, '');
    return currentOs() === 'windows' ? slashed.toLowerCase() : slashed;
  };
  return norm(a) === norm(b);
}

/** Resolve aliases when present, retaining a usable input when the directory is gone. */
function resolved(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

export class ImportStore {
  /**
   * The sessions being read right now. The server dispatches frames without
   * awaiting the previous one, so a double click sends two `imports.run` for
   * one session and both pass the "already a thread" check while the transcript
   * is still being read.
   */
  private readonly running = new Set<string>();
  /** Sessions whose transcripts a thread purge is removing right now (`threads/transcript-purge.ts`). */
  readonly removing = new Set<string>();
  /**
   * What each transcript folder listed, by file name, kept while a file's size
   * and modification time stay the same: reopening the list reads nothing new.
   */
  private readonly listed = new Map<string, Map<string, { size: number; mtimeMs: number; listing: TranscriptListing | null }>>();
  /** A listing under way, which a second client or a quick reopen shares. */
  private readonly listing = new Map<ProjectId, Promise<ImportableSession[]>>();

  constructor(private readonly core: Core) {}

  /** The claude accounts and where each keeps its transcripts; an account with no directory is skipped. */
  private roots(): { account: Account; dir: string }[] {
    const out: { account: Account; dir: string }[] = [];
    for (const account of this.core.accounts.list()) {
      const provider = this.core.providers.get(account.providerId);
      if (provider === undefined || provider.protocol !== 'claude-sdk') continue;
      const dir = account.isolationDir ?? this.core.accounts.defaultLocation(provider);
      if (dir !== null) out.push({ account, dir });
    }
    return out;
  }

  private folders(dir: string, project: Project): string[] {
    // Match agentShape: prefer the entered path before its canonical variant.
    return [...new Set([project.path, resolved(project.path)])].map(path => join(dir, 'projects', claudeProjectFolder(path)));
  }

  list(projectId: ProjectId): Promise<ImportableSession[]> {
    const running = this.listing.get(projectId);
    if (running !== undefined) return running;
    const scan = this.scan(projectId).finally(() => this.listing.delete(projectId));
    this.listing.set(projectId, scan);
    return scan;
  }

  private async scan(projectId: ProjectId): Promise<ImportableSession[]> {
    const project = this.core.projects.require(projectId);
    const known = new Map<string, string>();
    for (const thread of sessionThreads(this.core.journal.db)) {
      known.set(thread.sessionId, thread.id);
    }
    const out = new Map<string, ImportableSession>();
    const cwd = resolved(project.path);
    for (const { account, dir } of this.roots()) {
      const seen = new Set<string>();
      for (const folder of this.folders(dir, project)) {
        if (!existsSync(folder)) {
          this.listed.delete(folder);
          continue;
        }
        const before = this.listed.get(folder);
        const now = new Map<string, { size: number; mtimeMs: number; listing: TranscriptListing | null }>();
        for (const name of readdirSync(folder)) {
          if (!name.endsWith('.jsonl')) continue;
          const sessionId = name.slice(0, -'.jsonl'.length);
          if (seen.has(sessionId)) continue;
          const file = join(folder, name);
          const stat = statSync(file);
          if (!stat.isFile()) continue;
          const kept = before?.get(name);
          const head =
            kept !== undefined && kept.size === stat.size && kept.mtimeMs === stat.mtimeMs ? kept.listing : await listTranscript(file);
          now.set(name, { size: stat.size, mtimeMs: stat.mtimeMs, listing: head });
          if (head === null) continue;
          if (head.cwd !== null && !sameFolder(resolved(head.cwd), cwd)) {
            this.core.log('warn', `import: ${file} was recorded in ${head.cwd}, not ${project.path}; skipped`);
            continue;
          }
          seen.add(sessionId);
          const key = resolved(file);
          const existing = out.get(key);
          if (existing !== undefined) {
            if (!existing.accountIds!.includes(account.id)) existing.accountIds!.push(account.id);
            continue;
          }
          out.set(key, {
            providerId: account.providerId,
            accountId: account.id,
            accountIds: [account.id],
            sessionId,
            file,
            title: head.agentTitle ?? titleFromPrompt(head.prompt),
            startedAt: head.promptAt,
            updatedAt: stat.mtimeMs,
            bytes: stat.size,
            threadId: known.get(sessionId) ?? null,
          });
        }
        this.listed.set(folder, now);
      }
    }
    return [...out.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async run(params: { projectId: ProjectId; accountId: AccountId; sessionId: string }): Promise<ThreadSummary> {
    const project = this.core.projects.require(params.projectId);
    const account = this.core.accounts.require(params.accountId);
    const provider = this.core.providers.require(account.providerId);
    if (provider.protocol !== 'claude-sdk') {
      throw refused('only a Claude account keeps sessions Boite can import', {
        accountId: account.id,
        providerId: provider.id,
        protocol: provider.protocol,
      });
    }
    if (!SESSION_ID.test(params.sessionId)) {
      throw refused('a session id is letters, digits, dashes and underscores', { sessionId: params.sessionId });
    }
    this.checkFree(params.sessionId);
    const dir = account.isolationDir ?? this.core.accounts.defaultLocation(provider);
    if (dir === null) throw refused('this account has no transcript directory', { accountId: account.id });
    const paths = this.folders(dir, project).map(folder => join(folder, `${params.sessionId}.jsonl`));
    const files = paths.filter(path => existsSync(path));
    if (files.length === 0) throw notFound(`no transcript at ${paths[0]}`, { file: paths[0], sessionId: params.sessionId });

    this.running.add(params.sessionId);
    try {
      let file = files[0]!;
      let transcript: Awaited<ReturnType<typeof readTranscript>> | null = null;
      let foreign: { file: string; cwd: string } | undefined;
      for (const candidate of files) {
        const read = await readTranscript(candidate);
        if (read.cwd !== null && !sameFolder(resolved(read.cwd), resolved(project.path))) {
          foreign = { file: candidate, cwd: read.cwd };
          continue;
        }
        if (read.turns.length === 0) continue;
        file = candidate;
        transcript = read;
        break;
      }
      if (transcript === null) {
        if (foreign) throw refused(`transcript cwd: expected ${project.path}`, { ...foreign, field: 'cwd', expected: project.path });
        throw refused('this transcript has no prompt to import', { file });
      }
      const first = transcript.turns[0]!;
      const summary = this.core.threads.createImported(
        {
          projectId: project.id,
          providerId: provider.id,
          accountId: account.id,
          title: transcript.agentTitle ?? titleFromPrompt(first.prompt),
          cwd: project.path,
        },
        {
          sessionId: params.sessionId,
          model: transcript.model,
          titleSource: transcript.agentTitle === null ? 'prompt' : 'agent',
          turns: transcript.turns,
        },
      );
      this.core.log('info', `imported claude session ${params.sessionId} into ${summary.id} (${transcript.turns.length} turns)`);
      return summary;
    } finally {
      this.running.delete(params.sessionId);
    }
  }

  /** True while the session's transcript is being read for an import: a purge leaves it alone. */
  busy(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  /** Refuses a session already imported, one being imported right now, and one whose transcript is being removed. */
  private checkFree(sessionId: string): void {
    const taken = sessionThreads(this.core.journal.db).find((thread) => thread.sessionId === sessionId);
    if (taken !== undefined) {
      throw refused('this session is already a thread', { sessionId, threadId: taken.id });
    }
    if (this.running.has(sessionId)) {
      throw refused('this session is already being imported', { sessionId });
    }
    if (this.removing.has(sessionId)) {
      throw refused('this session belonged to a deleted thread and its transcript is being removed', { sessionId });
    }
  }
}

export function registerImportMethods(core: Core): void {
  core.router.register('imports.list', (params) => core.imports.list(params.projectId));
  core.router.register('imports.run', (params) => core.imports.run(params));
}
