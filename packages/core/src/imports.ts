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

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Account, AccountId, ImportableSession, Project, ProjectId, ThreadSummary } from '@boite/contracts';
import type { Core } from './core.ts';
import { notFound, refused } from './errors.ts';
import { claudeProjectFolder, listTranscript, readTranscript } from './imports/claude.ts';
import type { TranscriptListing } from './imports/claude.ts';
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

export class ImportStore {
  /**
   * The sessions being read right now. The server dispatches frames without
   * awaiting the previous one, so a double click sends two `imports.run` for
   * one session and both pass the "already a thread" check while the transcript
   * is still being read.
   */
  private readonly running = new Set<string>();
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

  private sessionFile(dir: string, project: Project, sessionId: string): string {
    return join(dir, 'projects', claudeProjectFolder(project.path), `${sessionId}.jsonl`);
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
    for (const thread of this.core.journal.listThreads()) {
      if (thread.sessionId !== null) known.set(thread.sessionId, thread.id);
    }
    const out: ImportableSession[] = [];
    for (const { account, dir } of this.roots()) {
      const folder = join(dir, 'projects', claudeProjectFolder(project.path));
      if (!existsSync(folder)) {
        this.listed.delete(folder);
        continue;
      }
      const before = this.listed.get(folder);
      const now = new Map<string, { size: number; mtimeMs: number; listing: TranscriptListing | null }>();
      for (const name of readdirSync(folder)) {
        if (!name.endsWith('.jsonl')) continue;
        const sessionId = name.slice(0, -'.jsonl'.length);
        const file = join(folder, name);
        const stat = statSync(file);
        if (!stat.isFile()) continue;
        const kept = before?.get(name);
        const head =
          kept !== undefined && kept.size === stat.size && kept.mtimeMs === stat.mtimeMs ? kept.listing : await listTranscript(file);
        now.set(name, { size: stat.size, mtimeMs: stat.mtimeMs, listing: head });
        if (head === null) continue;
        if (head.cwd !== null && !sameFolder(head.cwd, project.path)) {
          this.core.log('warn', `import: ${file} was recorded in ${head.cwd}, not ${project.path}; skipped`);
          continue;
        }
        out.push({
          providerId: account.providerId,
          accountId: account.id,
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
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
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
    const file = this.sessionFile(dir, project, params.sessionId);
    if (!existsSync(file)) throw notFound(`no transcript at ${file}`, { file, sessionId: params.sessionId });

    this.running.add(params.sessionId);
    try {
      const transcript = await readTranscript(file);
      if (transcript.turns.length === 0) throw refused('this transcript has no prompt to import', { file });
      const first = transcript.turns[0]!;
      const known = transcript.model !== null && provider.models.some((model) => model.id === transcript.model);
      const summary = this.core.threads.createImported(
        {
          projectId: project.id,
          providerId: provider.id,
          accountId: account.id,
          title: transcript.agentTitle ?? titleFromPrompt(first.prompt),
          cwd: project.path,
          ...(known ? { model: transcript.model! } : {}),
        },
        {
          sessionId: params.sessionId,
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

  /** Refuses a session already imported, and one being imported right now. */
  private checkFree(sessionId: string): void {
    const taken = this.core.journal.listThreads().find((thread) => thread.sessionId === sessionId);
    if (taken !== undefined) {
      throw refused('this session is already a thread', { sessionId, threadId: taken.id });
    }
    if (this.running.has(sessionId)) {
      throw refused('this session is already being imported', { sessionId });
    }
  }
}

export function registerImportMethods(core: Core): void {
  core.router.register('imports.list', (params) => core.imports.list(params.projectId));
  core.router.register('imports.run', (params) => core.imports.run(params));
}
