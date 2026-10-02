import type { PermissionRequest, QuestionRequest, RequestId, ThreadId } from '@boite/contracts';
import { mergeRequests, requestsOf, type RequestScope } from '../requests';
import type { StoreContext } from './context';
import type { Client } from '../client';
import { SnapshotReads } from './snapshot-reads';

/** The permission and question cards: what is pending, and what was asked on the open thread. */
export class Requests {
  #permissions = new SnapshotReads<PermissionRequest>(row => row.threadId);
  #questions = new SnapshotReads<QuestionRequest>(row => row.threadId);
  pendingPermissions = $state<PermissionRequest[]>([]);
  /**
   * Kept after the answer so a resolved card still shows what was asked. Only
   * the open thread has cards on the screen, so only its entries are held: this
   * record grew for the life of the page before that.
   */
  permissionRequests = $state<Record<RequestId, PermissionRequest>>({});
  pendingQuestions = $state<QuestionRequest[]>([]);
  /** Kept after the answer so a folded card still shows what was asked. Same bound. */
  questionRequests = $state<Record<RequestId, QuestionRequest>>({});

  constructor(private readonly ctx: StoreContext) {}

  /**
   * The two records exist for the cards of the thread on the screen, so they
   * hold that thread and nothing else. Called when a thread opens, when the
   * chat goes to a draft, and when a thread is archived or removed: before
   * this, a page left open all day kept every request it had ever been told
   * about.
   */
  keepRequestsOf(threadId: ThreadId | null): void {
    const mine = (id: ThreadId): boolean => id === threadId;
    this.permissionRequests = requestsOf(this.permissionRequests, mine);
    this.questionRequests = requestsOf(this.questionRequests, mine);
  }

  /** The same, for a thread that is gone while another one stays open. */
  dropRequestsOf(threadId: ThreadId): void {
    const others = (id: ThreadId): boolean => id !== threadId;
    this.permissionRequests = requestsOf(this.permissionRequests, others);
    this.questionRequests = requestsOf(this.questionRequests, others);
  }

  /** A list or an event of requests over the cards held: `mergeRequests` says what `scope` drops. */
  mergePermissions(requests: PermissionRequest[], scope: RequestScope): void {
    if (scope === 'one') for (const row of requests) this.#permissions.change(row.id, row);
    ({ pending: this.pendingPermissions, records: this.permissionRequests } = mergeRequests(this.pendingPermissions, this.permissionRequests, requests, scope));
  }

  mergeQuestions(requests: QuestionRequest[], scope: RequestScope): void {
    if (scope === 'one') for (const row of requests) this.#questions.change(row.id, row);
    ({ pending: this.pendingQuestions, records: this.questionRequests } = mergeRequests(this.pendingQuestions, this.questionRequests, requests, scope));
  }

  permissionRead(client: Client, scope: ThreadId | 'all') {
    const read = this.#permissions.begin(scope), generation = this.ctx.clientGeneration;
    return {
      promise: client.call('permissions.list', scope === 'all' ? {} : { threadId: scope }).catch(error => { read.cancel(); throw error; }),
      apply: (rows: PermissionRequest[]) => {
        if (this.ctx.currentClient(client, generation) && read.active) this.mergePermissions(read.apply(rows, this.pendingPermissions), 'all');
        else read.cancel();
      },
      cancel: () => read.cancel()
    };
  }

  questionRead(client: Client, scope: ThreadId | 'all') {
    const read = this.#questions.begin(scope), generation = this.ctx.clientGeneration;
    return {
      promise: client.call('questions.list', scope === 'all' ? {} : { threadId: scope }).catch(error => { read.cancel(); throw error; }),
      apply: (rows: QuestionRequest[]) => {
        if (this.ctx.currentClient(client, generation) && read.active) this.mergeQuestions(read.apply(rows, this.pendingQuestions), 'all');
        else read.cancel();
      },
      cancel: () => read.cancel()
    };
  }

  cancelReads(): void { this.#permissions.clear(); this.#questions.clear(); }
  resolvePermission(id: RequestId): void { this.#permissions.change(id, null); this.pendingPermissions = this.pendingPermissions.filter(row => row.id !== id); }
  resolveQuestion(id: RequestId): void { this.#questions.change(id, null); this.pendingQuestions = this.pendingQuestions.filter(row => row.id !== id); }

  async answerQuestion(
    threadId: ThreadId,
    questionId: string,
    optionIds: string[],
    text?: string
  ): Promise<boolean> {
    const client = this.ctx.client;
    const generation = this.ctx.clientGeneration;
    if (!client) return false;
    try {
      await client.call('questions.answer', {
        threadId,
        questionId,
        optionIds,
        ...(text === undefined || text.length === 0 ? {} : { text })
      });
      if (!this.ctx.currentClient(client, generation)) return false;
      this.resolveQuestion(questionId);
      return true;
    } catch (error) {
      // False gives the card back: a drop on a bad link must not leave it greyed out.
      if (this.ctx.currentClient(client, generation)) this.ctx.fail(error);
      return false;
    }
  }

  async skipQuestion(threadId: ThreadId, questionId: RequestId): Promise<boolean> {
    const client = this.ctx.client;
    const generation = this.ctx.clientGeneration;
    if (!client) return false;
    try {
      await client.call('questions.skip', { threadId, questionId });
      if (!this.ctx.currentClient(client, generation)) return false;
      this.resolveQuestion(questionId);
      return true;
    } catch (error) {
      if (!this.ctx.currentClient(client, generation)) return false;
      this.ctx.fail(error);
      return false;
    }
  }

  async answer(requestId: string, decision: 'allow' | 'deny'): Promise<void> {
    const client = this.ctx.client;
    const generation = this.ctx.clientGeneration;
    if (!client) return;
    try {
      await client.call('permissions.answer', { requestId, decision });
      if (this.ctx.currentClient(client, generation)) this.resolvePermission(requestId);
    } catch (error) {
      if (this.ctx.currentClient(client, generation)) this.ctx.fail(error);
    }
  }
}
