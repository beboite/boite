import type { Attachment, PermissionRequest, QuestionRequest, RequestId, ThreadId } from '@boite/contracts';
import { mergeRequests, requestsOf, type RequestScope } from '../requests';
import { needsUser } from '../thread-state';
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
   * hold that thread and its direct children, whose questions its dock shows,
   * and nothing else. Called when a thread opens, when the chat goes to a
   * draft, and when a thread is archived or removed: before this, a page left
   * open all day kept every request it had ever been told about.
   */
  keepRequestsOf(threadId: ThreadId | null): void {
    const children = new Set(threadId === null ? [] : this.ctx.threads.threads.filter(row => row.parentThreadId === threadId).map(row => row.id));
    const mine = (id: ThreadId): boolean => id === threadId || children.has(id);
    this.permissionRequests = requestsOf(this.permissionRequests, mine);
    this.questionRequests = requestsOf(this.questionRequests, mine);
  }

  /**
   * The requests of the open thread's direct children that wait on the user,
   * read from the core: the parent's dock carries them, and a child's
   * `question.asked` or `permission.requested` may have gone out before this
   * page listened. `only` reads that one child, the one that just turned to
   * the user. A refused or failed read leaves the dock as it was.
   */
  readChildren(client: Client, parentId: ThreadId, only?: ThreadId): void {
    for (const child of this.ctx.threads.threads) {
      if (child.parentThreadId !== parentId || child.archived || !needsUser(child) || (only !== undefined && child.id !== only)) continue;
      const permissions = this.permissionRead(client, child.id), questions = this.questionRead(client, child.id);
      void permissions.promise.then(permissions.apply, () => undefined);
      void questions.promise.then(questions.apply, () => undefined);
    }
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

  permissionRead(client: Client, scope: ThreadId | 'all', fetch?: () => Promise<PermissionRequest[]>) {
    const read = this.#permissions.begin(scope), generation = this.ctx.clientGeneration;
    return {
      promise: (fetch ? fetch() : client.call('permissions.list', scope === 'all' ? {} : { threadId: scope })).catch(error => { read.cancel(); throw error; }),
      apply: (rows: PermissionRequest[]) => {
        if (this.ctx.currentClient(client, generation) && read.active) this.mergePermissions(read.apply(rows, this.pendingPermissions), 'all');
        else read.cancel();
      },
      cancel: () => read.cancel()
    };
  }

  questionRead(client: Client, scope: ThreadId | 'all', fetch?: () => Promise<QuestionRequest[]>) {
    const read = this.#questions.begin(scope), generation = this.ctx.clientGeneration;
    return {
      promise: (fetch ? fetch() : client.call('questions.list', scope === 'all' ? {} : { threadId: scope })).catch(error => { read.cancel(); throw error; }),
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

  /**
   * The answers out to the core, by request: a second tap while one is in
   * flight gets the first one's outcome instead of sending again. Keys carry
   * the kind, so a permission and a question never share one.
   */
  readonly #answering = new Map<string, Promise<boolean>>();

  #once(key: string, send: () => Promise<boolean>): Promise<boolean> {
    const inFlight = this.#answering.get(key);
    if (inFlight) return inFlight;
    const sent = send().finally(() => this.#answering.delete(key));
    this.#answering.set(key, sent);
    return sent;
  }

  answerQuestion(
    threadId: ThreadId,
    questionId: string,
    optionIds: string[],
    text?: string,
    attachments: Attachment[] = []
  ): Promise<boolean> {
    return this.#once(`question:${questionId}`, () => this.#answerQuestion(threadId, questionId, optionIds, text, attachments));
  }

  async #answerQuestion(
    threadId: ThreadId,
    questionId: string,
    optionIds: string[],
    text?: string,
    attachments: Attachment[] = []
  ): Promise<boolean> {
    const client = this.ctx.client;
    const generation = this.ctx.clientGeneration;
    if (!client) return false;
    try {
      await client.call('questions.answer', {
        threadId,
        questionId,
        optionIds,
        ...(text === undefined || text.length === 0 ? {} : { text }),
        ...(attachments.length === 0 ? {} : { attachments })
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

  skipQuestion(threadId: ThreadId, questionId: RequestId): Promise<boolean> {
    return this.#once(`question:${questionId}`, () => this.#skipQuestion(threadId, questionId));
  }

  async #skipQuestion(threadId: ThreadId, questionId: RequestId): Promise<boolean> {
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

  /**
   * True once the core took the decision. False gives the card its buttons
   * back, and the error is shown; a second call while the first is out sends
   * nothing and answers what the first one does.
   */
  answer(requestId: string, decision: 'allow' | 'deny'): Promise<boolean> {
    return this.#once(`permission:${requestId}`, () => this.#answerPermission(requestId, decision));
  }

  async #answerPermission(requestId: string, decision: 'allow' | 'deny'): Promise<boolean> {
    const client = this.ctx.client;
    const generation = this.ctx.clientGeneration;
    if (!client) return false;
    try {
      await client.call('permissions.answer', { requestId, decision });
      // Another connection holds the card now: false hands its buttons back.
      if (!this.ctx.currentClient(client, generation)) return false;
      this.resolvePermission(requestId);
      return true;
    } catch (error) {
      if (this.ctx.currentClient(client, generation)) this.ctx.fail(error);
      return false;
    }
  }
}
