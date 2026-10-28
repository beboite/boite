import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Account, Project, ProviderDescriptor, RpcParams, ThreadId, ThreadSummary } from '@boite/contracts';
import type { Core } from '../core.ts';
import { refused } from '../errors.ts';
import { logMessageOf } from '../log-errors.ts';
import { newId } from '../ids.ts';
import { checkContext } from '../context-mode.ts';
import { checkCwd, draftFolderName, makeDraftFolder, titleOf } from './inputs.ts';
import { checkIncognito, incognitoRoot, makeIncognitoFolder } from './incognito.ts';
import { DRAFT_CLEANUP_TIMEOUT_MS, type BeforeDraftMutation } from './draft-reservation-ledger.ts';
import { checkEffort, checkModel, checkSpeed, defaultModel } from './selection.ts';

type CreateParams = RpcParams<'threads.create'>;

/** Plans final workspaces separately from publishing conversations. */
export class ThreadCreation {
  constructor(private readonly core: Core) {}
  /**
   * The thread in its own git worktree: the branch and directory are made
   * first, under the id the thread will carry, and the record is written only
   * once git succeeded. Everything a refusal can come from is checked before
   * git makes anything, and a refusal after that removes the worktree and its
   * branch again, so nothing is left behind but the trace of the git processes.
   */
  async createInWorktree(params: CreateParams, publish = true, beforeMutation?: BeforeDraftMutation): Promise<ThreadSummary> {
    if (params.cwd !== undefined) {
      throw refused('cwd and worktree exclude each other: a worktree is the working directory', { cwd: params.cwd });
    }
    if (params.incognito === true) {
      throw refused('incognito and worktree exclude each other: an incognito conversation works in a folder the core makes', { field: 'incognito', expected: 'absent or false with worktree' });
    }
    const { project, provider, account } = this.check(params);
    if (project.kind === 'drafts') {
      throw refused('a draft has no worktree: the drafts folder is not a git repository', { projectId: project.id });
    }
    const model = checkModel(provider, account.id, params.model ?? defaultModel(provider));
    checkEffort(provider, account.id, model, params.effort ?? null);
    checkSpeed(provider, account.id, model, params.speed ?? null);
    const id = newId('thr_');
    const placed = await this.core.worktrees.add(id, project, params.worktree?.branch, undefined, beforeMutation ? {
      beforeMutation: placed => beforeMutation({ threadId: id, project, path: placed.path, branch: placed.branch, kind: 'worktree' }),
      assertActive: () => beforeMutation.assertActive?.(id), timeoutMs: DRAFT_CLEANUP_TIMEOUT_MS,
    } : undefined);
    try {
      return this.create({ ...params, cwd: placed.path }, { id, branch: placed.branch, branchNamingPending: placed.namingPending }, publish);
    } catch (error) {
      try {
        await this.core.worktrees.remove(id, project, placed, beforeMutation ? DRAFT_CLEANUP_TIMEOUT_MS : undefined);
      } catch (cleanupError) {
        this.core.log('warn', `could not clean up the worktree ${placed.path} after creation failed: ${logMessageOf(cleanupError)}`, { threadId: id });
      }
      throw error;
    }
  }

  create(params: CreateParams, placed?: { id: ThreadId; branch: string | null; branchNamingPending?: boolean; parentThreadId?: ThreadId }, publish = true, beforeMutation?: BeforeDraftMutation): ThreadSummary {
    const { project, provider, account } = this.check(params);
    const incognito = checkIncognito(params, project, placed !== undefined);

    const now = Date.now();
    const model = checkModel(provider, account.id, params.model ?? defaultModel(provider));
    const effort = checkEffort(provider, account.id, model, params.effort ?? null);
    const speed = checkSpeed(provider, account.id, model, params.speed ?? null), contextMode = checkContext(provider, params.context);
    const id = placed?.id ?? newId('thr_');
    // A worktree's directory is the core's own and uses the configured storage;
    // anything a client names has to be inside it. A draft with no directory
    // named gets a new folder of its own, made once everything else passed;
    // an incognito one gets it in the data directory, away from the drafts.
    const cwd =
      params.cwd !== undefined && params.cwd.length > 0
        ? placed !== undefined
          ? params.cwd
          : checkCwd(project, params.cwd)
        : incognito
          ? this.makeIncognito(id, project, beforeMutation)
          : project.kind === 'drafts'
            ? makeDraftFolder(project.path, publish ? draftFolderName(titleOf(params.title), new Date(now)) : `${draftFolderName('Draft', new Date(now))}-${id.slice(4)}`,
              beforeMutation ? path => beforeMutation({ threadId: id, project, path, branch: null, kind: 'draft' }) : undefined)
            : project.path;
    const thread: ThreadSummary = {
      id,
      ...(placed?.parentThreadId ? { parentThreadId: placed.parentThreadId } : {}), ...(contextMode ? { contextMode } : {}),
      ...(incognito ? { incognito: true as const } : {}),
      projectId: project.id,
      title: titleOf(params.title),
      titleSource: 'prompt',
      providerId: provider.id,
      accountId: account.id,
      model,
      effort,
      speed,
      cwd,
      branch: placed?.branch ?? null,
      branchNamingPending: placed?.branchNamingPending ?? false,
      permissionMode: params.permissionMode ?? 'default',
      status: 'idle',
      unread: false,
      archived: false,
      pinned: false,
      sessionId: null,
      sessionGeneration: 0,
      selectionVersion: 0,
      load: null,
      context: null,
      createdAt: now,
      updatedAt: now,
    };
    return publish ? this.publish(thread) : thread;
  }

  publish(thread: ThreadSummary): ThreadSummary {
    this.core.worktrees.reservations.assertFree(thread.cwd, 'a new conversation', { threadId: thread.id });
    this.core.journal.append({ type: 'thread.created', threadId: thread.id, version: 1, payload: thread }, () => this.core.journal.putThread(thread));
    // Capture inherited shared authority before an idle child can outlive its parent's board goal.
    if (thread.parentThreadId) this.core.sharedAccess.bound(thread.id);
    this.core.bus.emit('thread.created', thread);
    if (thread.projectId && this.core.projects.require(thread.projectId).archived) this.core.projects.archive(thread.projectId, false);
    return thread;
  }

  private makeIncognito(id: ThreadId, project: Project, beforeMutation?: BeforeDraftMutation): string {
    if (beforeMutation) {
      const path = join(incognitoRoot(this.core.dataDir), id);
      if (existsSync(path)) throw refused(`the incognito folder already exists: ${path}`, { path });
      beforeMutation({ threadId: id, project, path, branch: null, kind: 'incognito' });
    }
    return makeIncognitoFolder(this.core.dataDir, id);
  }

  validate(params: CreateParams): void {
    const { project, provider, account } = this.check(params);
    checkIncognito(params, project, params.worktree !== undefined);
    const model = checkModel(provider, account.id, params.model ?? defaultModel(provider));
    checkEffort(provider, account.id, model, params.effort ?? null);
    checkSpeed(provider, account.id, model, params.speed ?? null);
    checkContext(provider, params.context);
    if (params.cwd) checkCwd(project, params.cwd);
  }

  check(params: CreateParams): { project: Project; provider: ProviderDescriptor; account: Account } {
    const project = this.core.projects.require(params.projectId);
    const provider = this.core.providers.require(params.providerId);
    const account = this.core.accounts.require(params.accountId);
    if (account.providerId !== provider.id) throw refused('the account belongs to another provider', { accountId: account.id, providerId: provider.id });
    return { project, provider, account };
  }
}
