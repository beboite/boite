import type { PermissionRequest, QuestionRequest, RequestId, ThreadId } from '@boite/contracts';
import { mergeRequests, requestsOf, type RequestScope } from '../requests';
import type { StoreContext } from './context';

/** The permission and question cards: what is pending, and what was asked on the open thread. */
export class Requests {
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
    ({ pending: this.pendingPermissions, records: this.permissionRequests } = mergeRequests(this.pendingPermissions, this.permissionRequests, requests, scope));
  }

  mergeQuestions(requests: QuestionRequest[], scope: RequestScope): void {
    ({ pending: this.pendingQuestions, records: this.questionRequests } = mergeRequests(this.pendingQuestions, this.questionRequests, requests, scope));
  }

  async answerQuestion(
    threadId: ThreadId,
    questionId: string,
    optionIds: string[],
    text?: string
  ): Promise<boolean> {
    const client = this.ctx.client;
    if (!client) return false;
    try {
      await client.call('questions.answer', {
        threadId,
        questionId,
        optionIds,
        ...(text === undefined || text.length === 0 ? {} : { text })
      });
      this.pendingQuestions = this.pendingQuestions.filter((q) => q.id !== questionId);
      return true;
    } catch (error) {
      // False gives the card back: a drop on a bad link must not leave it greyed out.
      this.ctx.fail(error);
      return false;
    }
  }

  async answer(requestId: string, decision: 'allow' | 'deny'): Promise<void> {
    const client = this.ctx.client;
    if (!client) return;
    try {
      await client.call('permissions.answer', { requestId, decision });
      this.pendingPermissions = this.pendingPermissions.filter((p) => p.id !== requestId);
    } catch (error) {
      this.ctx.fail(error);
    }
  }
}
