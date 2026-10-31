import { permissionAutoDecision } from '@boite/contracts';
import {
  answerAttachmentError,
  type Attachment,
  type Message,
  type MessageId,
  type MessagePart,
  type PermissionRequest,
  type ProviderDescriptor,
  type QuestionAnswer,
  type QuestionRequest,
  type RequestId,
  type Settings,
  type SettingAsk,
  type SettingRequestParams,
  checkSettingRequest,
  isMachineSetting,
  MACHINE_SETTINGS,
  type SettingMachine,
  settledExperiment,
  type ClientPreferences,
  type ExperimentId,
  settingAnswerText,
  settledSetting,
  settledMachineSetting,
  type CoordinationPeer,
  type ThreadId,
  type ThreadSummary,
  type Turn,
} from '@boite/contracts';
import { checkSurface } from '../agent.ts';
import { answerText, attachToAnswer } from '../attachments.ts';
import type { Core } from '../core.ts';
import type { PermissionTicket, QuestionAsk, QuestionTicket } from '../drivers/types.ts';
import { PeerRefusal } from '../coordination-wire.ts';
import { invalidParams, messageOf, notFound, refused, RpcFailure, unavailable } from '../errors.ts';
import { memberNamed } from './group-spawn.ts';
import { newId } from '../ids.ts';
import type { ThreadStore } from '../threads.ts';
import { nativeCommandPrompt } from './operations.ts';
import { withLoad } from './records.ts';
import { markRunning } from './lifecycle.ts';

/** Why open cards were cleared, as the log says it. */
export type CardClearReason = 'turn end' | 'stop' | 'mode change' | 'archive' | 'rewind';
const CLEARED_BECAUSE: Record<CardClearReason, string> = {
  'turn end': 'the turn ended', stop: 'the turn was stopped', 'mode change': 'the permission mode changed',
  archive: 'the thread was archived', rewind: 'the conversation was rewound',
};

/** Tool name, decision, who decided and how long it waited: never the tool input or the question text. */
function logCard(core: Core, request: PermissionRequest | QuestionRequest, event: string, message: string, data: Record<string, string | number | boolean>): void {
  // A clock stepped back would make the wait negative.
  const waited = Math.max(0, Date.now() - request.createdAt);
  core.logs.record(waited >= 60_000 ? 'info' : 'debug', `${message} after ${Math.round(waited / 1000)} s`, {
    source: 'permissions', event, threadId: request.threadId, turnId: request.turnId, requestId: request.id, durationMs: waited,
    data: { ...('toolName' in request ? { tool: request.toolName } : {}), ...data },
  });
}

interface PendingPermission {
  request: PermissionRequest;
  resolve: (decision: 'allow' | 'deny') => void;
}

interface PendingQuestion {
  request: QuestionRequest;
  /** Null resolves a question without an answer, on skip or cancellation. */
  resolve: (answer: QuestionAnswer | null) => void;
}

/**
 * The cards a thread waits on: permission requests and questions, the
 * asynchronous ones included. Each map has this one owner.
 */
export class ThreadCards {
  readonly #permissions = new Map<RequestId, PendingPermission>();
  readonly #announced = new Map<string, { seq: number; value: unknown }>();
  #announcements = 0;
  readonly questions = new Map<RequestId, PendingQuestion>();
  /** Where each open asynchronous card is drawn, so its answer can be written back after its turn ended. */
  readonly asyncCards = new Map<RequestId, { threadId: ThreadId; messageId: MessageId; partIndex: number; part: Extract<MessagePart, { type: 'question' }> }>();

  readonly #core: Core;

  constructor(core: Core, private readonly threads: ThreadStore) {
    this.#core = core;}

  /**
   * The requests still waiting for an answer, oldest first. Answering one or
   * finishing its turn takes it out, so what this returns is what a client has
   * to show, whether it was subscribed when the request fired or not.
   */
  listPermissions(threadId?: ThreadId): PermissionRequest[] {
    const pending = [...this.#permissions.values()].map((entry) => entry.request);
    const scoped = threadId === undefined ? pending : pending.filter((r) => r.threadId === threadId);
    return scoped.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** A live mode change also settles tool approvals already waiting on the user. */
  applyPermissionMode(threadId: ThreadId, mode: ThreadSummary['permissionMode']): void {
    const decision = permissionAutoDecision(mode);
    if (decision === null) return;
    for (const request of this.listPermissions(threadId)) this.answerPermission({ requestId: request.id, decision }, `permission mode ${mode}`);
  }

  /**
   * Is anything of this thread still waiting on the user? An agent can run two
   * tools at once and raise a card for each, so answering one does not mean the
   * turn is running again. A secret card holds the turn the same way.
   */
  waitingOn(threadId: ThreadId): boolean {
    for (const entry of this.#permissions.values()) if (entry.request.threadId === threadId) return true;
    for (const entry of this.questions.values()) if (entry.request.threadId === threadId && entry.request.async !== true) return true;
    return this.#core.secrets.waiting(threadId);
  }

  /** How many questions asked without stopping still wait on the user: the row says it needs them. */
  openAsyncCount(threadId: ThreadId): number {
    let count = 0;
    for (const entry of this.questions.values()) if (entry.request.threadId === threadId && entry.request.async === true) count += 1;
    return count;
  }

  /** An asynchronous card came or went: the status did not move, so the row is sent by itself. */
  #asyncChanged(threadId: ThreadId): void {
    const thread = this.#core.journal.getThread(threadId);
    if (thread !== null) this.#core.bus.emit('thread.updated', withLoad(this.#core, thread));
  }

  answerPermission(params: { requestId: RequestId; decision: 'allow' | 'deny' }, by = 'user'): void {
    const pending = this.#permissions.get(params.requestId);
    if (pending === undefined) throw notFound(`unknown permission request ${params.requestId}`, params);
    this.#permissions.delete(params.requestId);
    const threadId = pending.request.threadId;
    logCard(this.#core, pending.request, 'permission.decided', `Permission for ${pending.request.toolName} ${params.decision === 'allow' ? 'allowed' : 'denied'} by ${by}`, { decision: params.decision, by });
    this.#core.journal.append(
      { type: 'permission.resolved', threadId, version: 1, payload: { ...params } },
      () => undefined,
    );
    this.#core.bus.emit('permission.resolved', { requestId: params.requestId, threadId, decision: params.decision });
    markRunning(this.#core, threadId);
    pending.resolve(params.decision);
  }

  /**
   * The questions still waiting for an answer, oldest first. The same rule as
   * the permissions: answering one or finishing its turn takes it out, so a
   * client that was not subscribed when it fired still draws the card.
   */
  listQuestions(threadId?: ThreadId): QuestionRequest[] {
    const pending = [...this.questions.values()].map((entry) => entry.request);
    const scoped = threadId === undefined ? pending : pending.filter((q) => q.threadId === threadId);
    return scoped.sort((a, b) => a.createdAt - b.createdAt);
  }

  skipQuestion(params: { threadId: ThreadId; questionId: RequestId }, by = 'user'): void {
    const pending = this.questions.get(params.questionId);
    if (pending === undefined) throw notFound(`unknown question ${params.questionId}`, params);
    const request = pending.request;
    if (request.threadId !== params.threadId) {
      throw refused('the question belongs to another thread', { ...params, expected: request.threadId });
    }
    this.questions.delete(request.id);
    logCard(this.#core, request, 'question.skipped', `Question skipped by ${by}`, { async: request.async === true, by });
    this.#core.journal.append(
      { type: 'question.answered', threadId: request.threadId, version: 1, payload: { questionId: request.id, answer: null } },
      () => undefined,
    );
    this.#core.bus.emit('question.answered', { questionId: request.id, threadId: request.threadId, answer: null });
    this.#foldAsyncCard(request.id, null);
    if (request.async !== true) markRunning(this.#core, request.threadId);
    else this.#asyncChanged(request.threadId);
    pending.resolve(null);
  }

  answerQuestion(params: {
    threadId: ThreadId;
    questionId: RequestId;
    optionIds: string[];
    text?: string;
    attachments?: Attachment[];
  }, by = 'user'): void {
    const pending = this.questions.get(params.questionId);
    if (pending === undefined) throw notFound(`unknown question ${params.questionId}`, params);
    const request = pending.request;
    if (request.threadId !== params.threadId) {
      throw refused('the question belongs to another thread', {
        questionId: params.questionId,
        threadId: params.threadId,
        expected: request.threadId,
      });
    }

    const known = new Set(request.options.map((option) => option.id));
    const unknown = params.optionIds.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw refused('the question does not offer these options', {
        questionId: request.id,
        unknown,
        expected: [...known],
      });
    }
    if (!request.multiple && params.optionIds.length > 1) {
      throw refused('the question takes one option', { questionId: request.id, optionIds: params.optionIds });
    }
    const text = params.text ?? '';
    if (text.length > 0 && !request.allowText) {
      throw refused('the question takes no free text', { questionId: request.id });
    }
    const files = params.attachments ?? [];
    if (files.length > 0 && !request.allowText) {
      throw refused('the question takes no files', { questionId: request.id });
    }
    const badFiles = answerAttachmentError(files);
    if (badFiles !== null) throw refused(badFiles.message, { questionId: request.id, ...badFiles.data });
    this.#core.sharedAccess.uploads(request.threadId, files);
    if (params.optionIds.length === 0 && text.length === 0 && files.length === 0) {
      throw refused('an answer needs an option or some text', { questionId: request.id });
    }

    const answer: QuestionAnswer = text.length > 0 ? { optionIds: params.optionIds, text } : { optionIds: params.optionIds };
    if (files.length > 0) answer.attachments = attachToAnswer(this.#core.dataDir, answer, files);
    if (request.async === true) {
      this.#settleAsync(pending, answer, by);
      return;
    }
    this.#recordAnswer(request, answer, by);
    markRunning(this.#core, request.threadId);
    pending.resolve(answer);
  }

  #recordAnswer(request: QuestionRequest, answer: QuestionAnswer, by: string): void {
    this.questions.delete(request.id);
    this.#core.journal.append(
      {
        type: 'question.answered',
        threadId: request.threadId,
        version: 1,
        payload: { questionId: request.id, answer },
      },
      () => undefined,
    );
    this.#core.bus.emit('question.answered', { questionId: request.id, threadId: request.threadId, answer });
    logCard(this.#core, request, 'question.answered', `Question answered by ${by} with ${answer.optionIds.length} options${answer.text ? ' and text' : ''}`, { options: answer.optionIds.length, text: Boolean(answer.text), async: request.async === true, by });
  }

  /** An asynchronous card answered: folded where it was drawn, and the answer goes to the agent as a message. */
  #settleAsync(pending: PendingQuestion, answer: QuestionAnswer, by: string): void {
    const request = pending.request;
    this.#recordAnswer(request, answer, by);
    this.#foldAsyncCard(request.id, answer);
    this.#asyncChanged(request.threadId);
    pending.resolve(answer);
    const text = request.agentSetting === undefined ? answerTextOf(request, answer) : this.#core.workforce.settingCards.answerText(request.agentSetting, answer);
    this.threads.deferred.deliverAnswer(request.threadId, `> ${request.text}\n\n${text}`);
  }

  /**
   * `boite settings request|open`: a settings card, asked without stopping.
   * The reason is the card's text. A change offers only Refuse as an answer:
   * Apply is `settings.set`, the owner's, and `settleSettings` closes the card
   * when the value moves, so a paired phone cannot answer "applied".
   */
  requestSetting(params: SettingRequestParams): { questionId: RequestId; setting: SettingAsk } | Promise<{ questionId: RequestId; setting: SettingAsk }> {
    if (params.machine !== undefined) return this.#requestMachineSetting(params);
    return this.#drawSetting(params, this.#core.settings.get(), null);
  }

  /**
   * A card about another machine of the group: that machine says what it
   * has now (`setting.read`), and says again when the owner changes it
   * (`setting.changed`), which settles the card.
   */
  /**
   * `setting.changed` from a member: the cards about that setting settle. The
   * last value heard is kept, numbered, for a card whose read crossed it.
   */
  machineSettingChanged(peer: CoordinationPeer, key: string, value: unknown): void {
    this.#announced.set(`${peer.coreId}:${key}`, { seq: ++this.#announcements, value });
    this.settle(request => (request.setting === undefined ? null : settledMachineSetting(request.setting, peer.coreId, key, value)), `${peer.name}'s settings`);
  }

  async #requestMachineSetting(params: SettingRequestParams): Promise<{ questionId: RequestId; setting: SettingAsk }> {
    this.threads.require(params.threadId);
    if (typeof params.machine !== 'string' || params.machine.trim().length === 0 || params.machine.length > 128) throw invalidParams('settings.request.machine: expected a machine name or core id');
    if (!isMachineSetting(params.key)) throw refused(`${String(params.key)} is this machine's own; a card for another machine asks about ${MACHINE_SETTINGS.join(', ')}`, { field: 'key', expected: MACHINE_SETTINGS });
    const peer = memberNamed(this.#core, params.machine, 'settings.request');
    const since = this.#announcements;
    let read: { value?: unknown };
    try { read = (await this.#core.coordination.request(peer, 'setting.read', { key: params.key })) as { value?: unknown }; }
    catch (error) {
      if (error instanceof PeerRefusal) throw refused(`Boite on ${peer.name} cannot answer about ${params.key}: ${error.message}; the owner updates it in Settings, Machines and updates`, { field: 'machine' });
      throw unavailable(`${peer.name} did not answer: ${messageOf(error)}`, { field: 'machine' });
    }
    // The owner flipped it while the read was on its way back: the announcement, newer, is what that machine has.
    const late = this.#announced.get(`${peer.coreId}:${params.key}`);
    const value = late !== undefined && late.seq > since ? late.value : read?.value;
    return this.#drawSetting(params, { ...this.#core.settings.get(), [params.key]: value as Settings[typeof params.key] }, { coreId: peer.coreId, name: peer.name });
  }

  #drawSetting(params: SettingRequestParams, settings: Settings, machine: SettingMachine | null): { questionId: RequestId; setting: SettingAsk } {
    const thread = this.threads.require(params.threadId);
    if (thread.archived) throw refused('cannot ask on an archived thread', { threadId: thread.id });
    const open = [...this.questions.values()].flatMap(entry => (entry.request.threadId === thread.id && entry.request.setting ? [entry.request.setting] : []));
    const checked = checkSettingRequest(params, settings, patch => {
      try {
        return { ok: true, patch: this.#core.settings.normalize(patch) };
      } catch (error) {
        if (!(error instanceof RpcFailure)) throw error;
        const field = (error.data as { field?: unknown } | undefined)?.field;
        return { ok: false, message: error.message, field: typeof field === 'string' ? field : 'value' };
      }
    }, open, this.#core.clients.current(), machine);
    if (!checked.ok) throw refused(checked.message, checked.data);
    const { reason, setting, options } = checked;
    const { questionId } = this.drawAsync(thread, { text: reason, options, allowText: false, multiple: false, async: true, setting });
    return { questionId, setting };
  }

  /**
   * The settings changed, from a card's Apply or from the page: every change
   * card whose setting left the value it was asked from settles, as applied
   * when it holds the proposed value and as changed when it holds another.
   */
  settleSettings(next: Settings): void {
    this.settle(request => (request.setting === undefined ? null : settledSetting(request.setting, next)), 'a settings change');
  }

  /** An app reported: every experiment card whose switch it flipped settles (`settledExperiment`). */
  settleClient(preferences: ClientPreferences, before: readonly ExperimentId[] | null): void {
    this.settle(request => (request.setting === undefined ? null : settledExperiment(request.setting, preferences, before)), 'an app change');
  }

  /**
   * Every open card `pick` has an answer for settles with it; `close` closes it
   * unanswered. A card a nested settle already took is passed over.
   */
  settle(pick: (request: QuestionRequest) => QuestionAnswer | 'close' | null, by: string): void {
    for (const pending of [...this.questions.values()]) {
      if (!this.questions.has(pending.request.id)) continue;
      const answer = pick(pending.request);
      if (answer === 'close') this.skipQuestion({ threadId: pending.request.threadId, questionId: pending.request.id }, by);
      else if (answer !== null) this.#settleAsync(pending, answer, by);
    }
  }

  /**
   * `boite ask`: an agent asks without stopping. The card goes in the running
   * turn, or under the last one when the agent asks between turns (from a
   * background shell of its own, say), in a message of its own.
   */
  askAsync(params: { threadId: ThreadId; text: string; options?: string[]; multiple?: boolean; open?: string }): { questionId: RequestId } {
    const thread = this.threads.require(params.threadId);
    if (thread.archived) throw refused('cannot ask on an archived thread', { threadId: thread.id });
    const text = typeof params.text === 'string' ? params.text.trim() : '';
    if (text.length === 0 || text.length > 2000) throw refused('text must hold 1 to 2000 characters', { field: 'text' });
    const labels = params.options ?? [];
    if (!Array.isArray(labels) || labels.length > 12 || labels.some(label => typeof label !== 'string' || label.trim().length === 0 || label.length > 200)) {
      throw refused('options must be at most 12 labels of 1 to 200 characters', { field: 'options' });
    }
    if (params.multiple !== undefined && typeof params.multiple !== 'boolean') throw refused('multiple must be a boolean', { field: 'multiple' });
    // The page opens as `boite browse` would open it; a user name or password in it would sit on the card and in the journal.
    const page = params.open === undefined ? undefined : checkSurface(thread.cwd, { kind: 'browser', url: params.open });
    const credentials = page?.kind === 'browser' ? new URL(page.url) : null;
    if (credentials && (credentials.username || credentials.password)) throw refused('open: an address with a user name or password in it is refused', { field: 'open' });
    return this.drawAsync(thread, {
      text,
      options: labels.map((label, index) => ({ id: String(index + 1), label: label.trim() })),
      allowText: true,
      multiple: params.multiple === true && labels.length > 1,
      async: true,
      ...(page?.kind === 'browser' ? { open: { url: page.url } } : {}),
    });
  }

  /** An asynchronous card drawn in the running turn, or under the last one, in a message of its own. */
  drawAsync(thread: ThreadSummary, ask: QuestionAsk): { questionId: RequestId } {
    const turn = this.#core.journal.runningTurn(thread.id) ?? this.#core.journal.lastTurn(thread.id);
    if (turn === null) throw refused('the thread has no turn to ask in yet', { threadId: thread.id });
    const ticket = this.askQuestion(thread, turn, ask);
    const part: Extract<MessagePart, { type: 'question' }> = { type: 'question', questionId: ticket.questionId, ...ask, answer: null };
    const message: Message = { id: newId('msg_'), threadId: thread.id, turnId: turn.id, role: 'assistant', parts: [part], state: 'complete', createdAt: Date.now() };
    this.#core.journal.append({ type: 'message.started', threadId: thread.id, version: 1, payload: message }, () => this.#core.journal.putMessage(message));
    this.#core.bus.emit('message.started', message);
    this.#core.bus.emit('message.completed', { threadId: thread.id, messageId: message.id, state: 'complete' });
    this.asyncCards.set(ticket.questionId, { threadId: thread.id, messageId: message.id, partIndex: 0, part });
    return { questionId: ticket.questionId };
  }

  /** The answered card, written back where it was drawn, whichever turn that was. */
  #foldAsyncCard(questionId: RequestId, answer: QuestionAnswer | null): void {
    const card = this.asyncCards.get(questionId);
    if (card === undefined) return;
    this.asyncCards.delete(questionId);
    const threadId = card.threadId;
    const part: MessagePart = { ...card.part, answer };
    this.#core.journal.append(
      { type: 'message.part', threadId, version: 1, payload: { messageId: card.messageId, partIndex: card.partIndex, part } },
      () => this.#core.journal.setMessagePart(card.messageId, card.partIndex, part),
    );
    this.#core.bus.emit('message.part', { threadId, messageId: card.messageId, partIndex: card.partIndex, part });
  }

  requestPermission(
    thread: ThreadSummary,
    turn: Turn,
    toolName: string,
    input: unknown,
    description: string | null,
  ): PermissionTicket {
    // A thread that must run no tool (a memory pass, `TOOL_FREE_CONTEXT`) gets none, whatever its driver let through.
    if (thread.contextMode?.tools?.length === 0) {
      this.#core.logs.info(`Permission for ${toolName} denied: this conversation runs no tool`, { source: 'permissions', event: 'permission.denied', threadId: thread.id, turnId: turn.id, data: { tool: toolName } });
      return Object.assign(Promise.resolve('deny' as const), { requestId: newId('req_'), withdraw: () => undefined });
    }
    const request: PermissionRequest = {
      id: newId('req_'),
      threadId: thread.id,
      turnId: turn.id,
      toolName,
      input,
      description,
      createdAt: Date.now(),
    };
    let resolve: (decision: 'allow' | 'deny') => void = () => undefined;
    const promise = new Promise<'allow' | 'deny'>((done) => {
      resolve = done;
    });
    this.#permissions.set(request.id, { request, resolve });
    this.#core.journal.append(
      { type: 'permission.requested', threadId: thread.id, version: 1, payload: request },
      () => undefined,
    );
    markRunning(this.#core, thread.id);
    this.#core.bus.emit('permission.requested', request);
    this.#core.logs.debug(`Permission requested for ${toolName}`, { source: 'permissions', event: 'permission.requested', threadId: thread.id, turnId: turn.id, requestId: request.id, data: { tool: toolName, permissionMode: thread.permissionMode } });
    const withdraw = (): void => {
      if (this.#permissions.has(request.id)) this.answerPermission({ requestId: request.id, decision: 'deny' }, 'the agent, which withdrew it');
    };
    return Object.assign(promise, { requestId: request.id, withdraw });
  }

  askQuestion(thread: ThreadSummary, turn: Turn, ask: QuestionAsk): QuestionTicket {
    const request: QuestionRequest = {
      id: newId('qst_'),
      threadId: thread.id,
      turnId: turn.id,
      text: ask.text,
      options: ask.options,
      allowText: ask.allowText,
      multiple: ask.multiple,
      ...(ask.async === true ? { async: true } : {}),
      ...(ask.setting === undefined ? {} : { setting: ask.setting }),
      ...(ask.agentSetting === undefined ? {} : { agentSetting: ask.agentSetting }),
      ...(ask.team === undefined ? {} : { team: ask.team }),
      ...(ask.open === undefined ? {} : { open: ask.open }),
      createdAt: Date.now(),
    };
    let resolve: (answer: QuestionAnswer | null) => void = () => undefined;
    const promise = new Promise<QuestionAnswer | null>((done) => {
      resolve = done;
    });
    this.questions.set(request.id, { request, resolve });
    this.#core.journal.append(
      { type: 'question.asked', threadId: thread.id, version: 1, payload: request },
      () => undefined,
    );
    // Nobody waits on an asynchronous card: the thread keeps its status.
    if (ask.async !== true) markRunning(this.#core, thread.id);
    else this.#asyncChanged(thread.id);
    this.#core.bus.emit('question.asked', request);
    this.#core.logs.debug(`Question asked with ${ask.options.length} options${ask.async === true ? ', without stopping the turn' : ''}`, { source: 'permissions', event: 'question.asked', threadId: thread.id, turnId: turn.id, requestId: request.id, data: { options: ask.options.length, async: ask.async === true, allowText: ask.allowText, multiple: ask.multiple } });
    return Object.assign(promise, { questionId: request.id });
  }

  /**
   * A stopped core takes this map with it, and an asynchronous card is meant
   * to outlive its turn: the ones nobody answered come back from the journal,
   * each with the part it is drawn in. A card whose message a rewind removed,
   * or whose thread is put away or gone, stays closed.
   */
  restoreAsyncQuestions(): number {
    let restored = 0;
    for (const request of this.#core.journal.openAsyncQuestions()) {
      if (this.questions.has(request.id) || this.#core.journal.getThread(request.threadId)?.archived !== false) continue;
      for (const message of this.#core.journal.walkTurnMessages(request.threadId, request.turnId, { blobs: false })) {
        const partIndex = message.parts.findIndex(part => part.type === 'question' && part.questionId === request.id && (part.answer ?? null) === null);
        if (partIndex < 0) continue;
        const part = message.parts[partIndex] as Extract<MessagePart, { type: 'question' }>;
        // Whoever awaited the ticket died with the old core; the answer travels as a message.
        this.questions.set(request.id, { request, resolve: () => undefined });
        this.asyncCards.set(request.id, { threadId: request.threadId, messageId: message.id, partIndex, part });
        restored += 1;
        break;
      }
    }
    return restored;
  }

  /** An asynchronous card closed without an answer is written down, or the next start would open it again. */
  #closeUnanswered(request: QuestionRequest): void {
    if (request.async !== true) return;
    this.#core.journal.append(
      { type: 'question.answered', threadId: request.threadId, version: 1, payload: { questionId: request.id, answer: null } },
      () => undefined,
    );
  }

  /**
   * The turn ended with a question still open: it is cancelled, so the driver
   * settles. An asynchronous card outlives its turn and goes only with `all`,
   * when the thread is put away.
   */
  clearQuestionsOf(threadId: ThreadId, all = false, reason: CardClearReason = 'turn end'): void {
    let asyncGone = false;
    for (const [id, pending] of [...this.questions]) {
      if (pending.request.threadId !== threadId) continue;
      if (pending.request.async === true && !all) continue;
      this.questions.delete(id);
      this.asyncCards.delete(id);
      this.#closeUnanswered(pending.request);
      asyncGone ||= pending.request.async === true;
      logCard(this.#core, pending.request, 'question.cancelled', `Question cancelled because ${CLEARED_BECAUSE[reason]}`, { async: pending.request.async === true, by: 'the core', reason });
      this.#core.bus.emit('question.answered', { questionId: id, threadId, answer: null });
      pending.resolve(null);
    }
    if (asyncGone) this.#asyncChanged(threadId);
  }

  /** The agent gave up waiting on one card by itself: it goes like a cancelled one. */
  withdrawQuestion(threadId: ThreadId, questionId: QuestionTicket['questionId']): void {
    const pending = this.questions.get(questionId);
    if (pending === undefined || pending.request.threadId !== threadId) return;
    logCard(this.#core, pending.request, 'question.withdrawn', 'Question withdrawn by the agent before an answer', { async: pending.request.async === true });
    this.questions.delete(questionId);
    this.asyncCards.delete(questionId);
    this.#closeUnanswered(pending.request);
    this.#core.bus.emit('question.answered', { questionId, threadId, answer: null });
    if (pending.request.async !== true) markRunning(this.#core, threadId);
    else this.#asyncChanged(threadId);
    pending.resolve(null);
  }

  /** The turn ended with a card still open: it is denied, and every client is told so. */
  clearPermissionsOf(threadId: ThreadId, reason: CardClearReason = 'turn end'): void {
    for (const [id, pending] of [...this.#permissions]) {
      if (pending.request.threadId !== threadId) continue;
      this.#permissions.delete(id);
      logCard(this.#core, pending.request, 'permission.decided', `Permission for ${pending.request.toolName} denied because ${CLEARED_BECAUSE[reason]}`, { decision: 'deny', by: 'the core', reason });
      // Without this the card stays on screen with live buttons, and pressing
      // one answers `unknown permission request`.
      this.#core.bus.emit('permission.resolved', { requestId: id, threadId, decision: 'deny' });
      pending.resolve('deny');
    }
  }

  /**
   * Once per agent session, how to ask without stopping. Codex has its own
   * asynchronous questions, and echo is the test agent.
   */
  askInstructions(thread: ThreadSummary, provider: ProviderDescriptor, turn: Turn, prompt: string): string {
    if (thread.sessionId !== null || turn.execution?.operation || nativeCommandPrompt(prompt)) return '';
    if (provider.protocol === 'codex-appserver' || provider.protocol === 'echo') return '';
    if (this.#core.settings.get().asyncQuestions === false) return '';
    // Boite's guide already teaches the command in the same prompt.
    if (this.#core.brain.config().boiteGuide !== false) return '';
    return ASK_INSTRUCTIONS;
  }
}

/** Told once per session to agents that have no asynchronous questions of their own. */
export const ASK_INSTRUCTIONS = '\n\nBoite: to ask the user something without stopping, run `boite ask "<question>" [option ...]` and keep working on what does not depend on it. The answer arrives later as a message quoting the question; if none comes, go on with a sensible default and say which.';

/** What the agent reads for an answer: the labels picked, then what the user typed. */
function answerTextOf(request: QuestionRequest, answer: QuestionAnswer): string {
  if (request.setting !== undefined) return settingAnswerText(request.setting, answer);
  const labels = answer.optionIds.map(id => request.options.find(option => option.id === id)?.label ?? id);
  return [labels.join(', '), answerText(answer)].filter(line => line.length > 0).join('\n');
}
