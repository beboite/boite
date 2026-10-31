/** Permission requests and questions: asked by a turn, answered by the user. */
import { RpcErrorCode, agentSettingAnswerText, checkClientPreferences, checkSettingRequest, isMachineSetting, MACHINE_SETTINGS, settledMachineSetting, settledExperiment, type SettingMachine, type ClientPreferences, type ExperimentId, checkSettingsPatch, readSettings, settingAnswerText, settledSetting, type Message, type MessagePart, type PermissionRequest, type QuestionAnswer, type QuestionOption, type QuestionRequest, type AgentSettingAsk, type SettingAsk, type SettingRequestParams, type Settings, type TeamAsk, type Thread, type ThreadId, type Turn } from '@boite/contracts';
import { RpcFailure } from '../client';
import { fakeCore } from './coordination';
import { checkAnswer, checkAsk } from './checks';
import { QUESTION_OPTIONS, QUESTION_TEXT } from './conversation';
import type { FakeContext, FakeMethods } from './context';

export async function askPermission(ctx: FakeContext, thread: Thread, turn: Turn, message: Message): Promise<void> {
  if (thread.permissionMode === 'yolo') return;
  const requestId = `req-${++ctx.seq}`;
  const partIndex = message.parts.length;
  const part: MessagePart = {
    type: 'permission',
    requestId,
    toolName: 'Write',
    decision: null
  };
  message.parts.push(part);
  ctx.emitToThread(thread.id, 'message.part', {
    threadId: thread.id,
    messageId: message.id,
    partIndex,
    part: structuredClone(part)
  });

  const request: PermissionRequest = {
    id: requestId,
    threadId: thread.id,
    turnId: turn.id,
    toolName: 'Write',
    input: { path: `${thread.cwd}\\notes.md`, contents: 'the thing you asked for' },
    description: 'Write a file inside the working directory',
    createdAt: ctx.now()
  };
  thread.status = 'waiting';
  ctx.touch(thread);
  ctx.emit('permission.requested', structuredClone(request));

  const decision = await new Promise<'allow' | 'deny'>((resolve) => {
    ctx.pendingPermissions.set(requestId, { request, resolve });
  });

  settlePermission(ctx, thread, message, partIndex, request, decision);
  thread.status = 'running';
  ctx.touch(thread);
}

export async function askQuestion(ctx: FakeContext, thread: Thread, turn: Turn, message: Message): Promise<void> {
  const questionId = `qst-${++ctx.seq}`;
  const partIndex = message.parts.length;
  const asked = {
    text: QUESTION_TEXT,
    options: QUESTION_OPTIONS,
    allowText: true,
    multiple: false
  };
  const part: MessagePart = { type: 'question', questionId, ...asked, answer: null };
  message.parts.push(part);
  ctx.emitToThread(thread.id, 'message.part', {
    threadId: thread.id,
    messageId: message.id,
    partIndex,
    part: structuredClone(part)
  });

  const request: QuestionRequest = {
    id: questionId,
    threadId: thread.id,
    turnId: turn.id,
    ...asked,
    createdAt: ctx.now()
  };
  thread.status = 'waiting';
  ctx.touch(thread);
  ctx.emit('question.asked', structuredClone(request));

  const answer = await new Promise<QuestionAnswer | null>((resolve) => {
    ctx.pendingQuestions.set(questionId, { request, resolve });
  });

  settleQuestion(ctx, thread, message, partIndex, request, answer);
  thread.status = 'running';
  ctx.touch(thread);
}

/** The answer written into the part, then the event, whichever path answered. */
export function settleQuestion(
  ctx: FakeContext,
  thread: Thread,
  message: Message,
  partIndex: number,
  request: QuestionRequest,
  answer: QuestionAnswer | null
): void {
  const stored = message.parts[partIndex];
  if (stored && stored.type === 'question') stored.answer = answer;
  ctx.emitToThread(thread.id, 'message.part', {
    threadId: thread.id,
    messageId: message.id,
    partIndex,
    part: {
      type: 'question',
      questionId: request.id,
      text: request.text,
      options: request.options,
      allowText: request.allowText,
      multiple: request.multiple,
      ...(request.async === true ? { async: true } : {}),
      ...(request.setting === undefined ? {} : { setting: request.setting }),
      ...(request.agentSetting === undefined ? {} : { agentSetting: request.agentSetting }),
      ...(request.open === undefined ? {} : { open: request.open }),
      answer
    }
  });
  ctx.emit('question.answered', { questionId: request.id, threadId: thread.id, answer });
}

/**
 * The core's `askAsync`: the card goes on the running message, or on a new
 * assistant message of the last turn, and nothing waits on it. The answer
 * comes back as a prompt quoting the question, once the thread is free.
 */
export function askAsync(ctx: FakeContext, thread: Thread, turn: Turn, running: Message | null, text: string, labels: string[], multiple: boolean, open?: string): string {
  return drawAsync(ctx, thread, turn, running, { text, options: labels.map((label, index) => ({ id: String(index + 1), label })), allowText: true, multiple, ...(open === undefined ? {} : { open: { url: open } }) });
}

/** The core's `requestSetting`: a settings card, drawn and answered like any card asked without stopping. */
export function askSetting(ctx: FakeContext, thread: Thread, turn: Turn, reason: string, options: QuestionOption[], setting: SettingAsk): string {
  return drawAsync(ctx, thread, turn, null, { text: reason, options, allowText: false, multiple: false, setting });
}

/** The core's `AgentSettingCards.request`: an agent setting card, drawn and answered like any card asked without stopping. */
export function askAgentSetting(ctx: FakeContext, thread: Thread, turn: Turn, reason: string, options: QuestionOption[], agentSetting: AgentSettingAsk): string {
  return drawAsync(ctx, thread, turn, null, { text: reason, options, allowText: false, multiple: false, agentSetting });
}

/** The core's `TeamStore` cards: a bot's proposal, drawn like any card asked without stopping; Apply is the owner's team method. */
export function askTeam(ctx: FakeContext, thread: Thread, turn: Turn, text: string, team: TeamAsk): string {
  return drawAsync(ctx, thread, turn, null, { text, options: [{ id: 'refuse', label: 'Refuse' }], allowText: false, multiple: false, team });
}

/** As the core's `AgentSettingCards.answerText`: what the asking thread reads, projects by name. */
function agentSettingText(ctx: FakeContext, setting: AgentSettingAsk, answer: QuestionAnswer): string {
  const names = new Map(ctx.projects.map((project) => [project.id, project.name]));
  return agentSettingAnswerText(setting, answer, (value) => JSON.stringify(setting.key === 'projects' && Array.isArray(value) ? value.map((id) => names.get(String(id)) ?? id) : value ?? null));
}

/**
 * As the core's `settleSettings`, or `settleClient` with `report`: a core
 * setting's card closes once its setting left the value it was asked from, an
 * experiment's once an app flipped its switch.
 */
export function settleSettings(ctx: FakeContext, settings: Settings, report?: { preferences: ClientPreferences; before: readonly ExperimentId[] | null }): void {
  settleWith(ctx, setting => (report ? settledExperiment(setting, report.preferences, report.before) : settledSetting(setting, settings)));
}

/** As the core's `setting.changed`: the cards of `ctx` about that machine's setting settle. */
export function settleMachineSetting(ctx: FakeContext, coreId: string, key: string, value: unknown): void {
  settleWith(ctx, setting => settledMachineSetting(setting, coreId, key, value));
}

function settleWith(ctx: FakeContext, pick: (setting: SettingAsk) => QuestionAnswer | null): void {
  for (const [questionId, pending] of [...ctx.pendingQuestions]) {
    const setting = pending.request.setting;
    const answer = setting === undefined ? null : pick(setting);
    if (answer === null) continue;
    ctx.pendingQuestions.delete(questionId);
    pending.resolve(answer);
  }
}

/** Another fake core of this page's group, as `memberNamed` finds it: by name, core id or a prefix of six hex digits. */
export function fakeMember(ctx: FakeContext, query: string, method: string): SettingMachine {
  const wanted = query.trim();
  const fold = (name: string) => name.trim().replace(/\s+/g, '-').toLowerCase();
  const roster = ctx.roster;
  if (roster === null) throw new RpcFailure({ code: RpcErrorCode.Refused, message: `${method}.machine: this machine is in no group; --machine names another machine of its group`, data: { field: 'machine' } });
  const refuse = (message: string, expected?: string[]) => new RpcFailure({ code: RpcErrorCode.Refused, message: `${method}.machine: ${message}`, data: { field: 'machine', ...(expected === undefined ? {} : { expected }) } });
  const others = roster.cores.filter(core => core.coreId !== ctx.identity.coreId);
  const found = others.filter(core => core.coreId === wanted || fold(core.name) === fold(wanted) || (/^[0-9a-f]{6,}$/.test(wanted) && core.coreId.startsWith(wanted)));
  const self = roster.cores.find(core => core.coreId === ctx.identity.coreId);
  if (self !== undefined && (self.coreId === wanted || (fold(self.name) === fold(wanted) && found.length === 0))) throw refuse(`${self.name} is this machine; leave --machine out`);
  if (found.length === 1) return { coreId: found[0]!.coreId, name: found[0]!.name };
  const names = others.map(core => roster.cores.some(other => other.coreId !== core.coreId && fold(other.name) === fold(core.name)) ? core.coreId.slice(0, 8) : core.name.replace(/\s+/g, '-'));
  if (found.length === 0) throw refuse(`no machine ${wanted} in this group; ${names.length === 0 ? 'it has no other machine' : `the others are ${names.join(', ')}`}`, names);
  throw refuse(`${found.length} machines are named ${wanted}; name one by a core id prefix: ${found.map(core => core.coreId.slice(0, 8)).join(', ')}`);
}

/** `settings.request` on a thread whose turn is known; the fake agent's `[settings]` markers come here too. */
export function requestSetting(ctx: FakeContext, thread: Thread, turn: Turn, params: SettingRequestParams): { questionId: string; setting: SettingAsk } {
  const open = [...ctx.pendingQuestions.values()].flatMap((pending) => (pending.request.threadId === thread.id && pending.request.setting ? [pending.request.setting] : []));
  let settings = ctx.settings;
  let machine: SettingMachine | null = null;
  if (params.machine !== undefined) {
    if (!isMachineSetting(params.key)) throw new RpcFailure({ code: RpcErrorCode.Refused, message: `${String(params.key)} is this machine's own; a card for another machine asks about ${MACHINE_SETTINGS.join(', ')}`, data: { field: 'key' } });
    machine = fakeMember(ctx, params.machine, 'settings.request');
    const other = fakeCore(machine.coreId);
    if (other === undefined) throw new RpcFailure({ code: RpcErrorCode.Unavailable, message: `${machine.name} did not answer`, data: { field: 'machine' } });
    settings = { ...ctx.settings, [params.key]: other.settings[params.key] };
  }
  const checked = checkSettingRequest(params, settings, (patch) => {
    const result = checkSettingsPatch(patch);
    return result.ok ? { ok: true, patch: result.patch } : { ok: false, message: result.message, field: result.field };
  }, open, ctx.clientPreferences, machine);
  if (!checked.ok) throw new RpcFailure({ code: RpcErrorCode.Refused, message: checked.message, data: checked.data });
  return { questionId: askSetting(ctx, thread, turn, checked.reason, checked.options, checked.setting), setting: checked.setting };
}

function drawAsync(
  ctx: FakeContext,
  thread: Thread,
  turn: Turn,
  running: Message | null,
  asked: { text: string; options: QuestionOption[]; allowText: boolean; multiple: boolean; setting?: SettingAsk; agentSetting?: AgentSettingAsk; team?: TeamAsk; open?: { url: string } }
): string {
  const questionId = `qst-${++ctx.seq}`;
  const text = asked.text;
  let message = running;
  if (message === null) {
    message = { id: `m-${++ctx.seq}`, threadId: thread.id, turnId: turn.id, role: 'assistant', parts: [], state: 'complete', createdAt: ctx.now() };
    thread.messages.push(message);
    ctx.emitToThread(thread.id, 'message.started', structuredClone(message));
  }
  const host = message;
  const partIndex = host.parts.length;
  const part: MessagePart = { type: 'question', questionId, ...asked, async: true, answer: null };
  host.parts.push(part);
  ctx.emitToThread(thread.id, 'message.part', { threadId: thread.id, messageId: host.id, partIndex, part: structuredClone(part) });
  const request: QuestionRequest = { id: questionId, threadId: thread.id, turnId: turn.id, ...asked, async: true, createdAt: ctx.now() };
  ctx.emit('question.asked', structuredClone(request));
  ctx.pendingQuestions.set(questionId, {
    request,
    resolve: (answer) => {
      settleQuestion(ctx, thread, host, partIndex, request, answer);
      countOpenQuestions(ctx, thread);
      if (answer === null) return;
      if (asked.setting) {
        holdAnswer(ctx, thread, `> ${text}\n\n${settingAnswerText(asked.setting, answer)}`);
        return;
      }
      if (asked.agentSetting) {
        holdAnswer(ctx, thread, `> ${text}\n\n${agentSettingText(ctx, asked.agentSetting, answer)}`);
        return;
      }
      const picked = answer.optionIds.map((id) => asked.options.find((option) => option.id === id)?.label ?? id).join(', ');
      const files = (answer.attachments ?? []).map((file) => `[file ${file.mimeType}, ${file.bytes} bytes, ${file.name ?? 'attachment'}]`).join('\n');
      const reply = [picked, answer.text ?? '', files].filter((line) => line.length > 0).join('\n');
      holdAnswer(ctx, thread, `> ${text}\n\n${reply}`);
    }
  });
  countOpenQuestions(ctx, thread);
  return questionId;
}

/** As the core's `openQuestions`: the cards asked without stopping still open, sent with the row. */
function countOpenQuestions(ctx: FakeContext, thread: Thread): void {
  thread.openQuestions = [...ctx.pendingQuestions.values()].filter(pending => pending.request.threadId === thread.id && pending.request.async === true).length;
  ctx.touch(thread);
}

/** As the core's deferred answers: the ones given while a turn runs start one turn together after it. */
function holdAnswer(ctx: FakeContext, thread: Thread, prompt: string): void {
  const held = ctx.heldAnswers.get(thread.id);
  if (held) {
    held.push(prompt);
    thread.pendingAnswers = [...held];
    ctx.touch(thread);
    return;
  }
  ctx.heldAnswers.set(thread.id, [prompt]);
  thread.pendingAnswers = [prompt];
  ctx.touch(thread);
  void flushAnswers(ctx, thread);
}

async function flushAnswers(ctx: FakeContext, thread: Thread): Promise<void> {
  for (let running = ctx.inFlight.get(thread.id); running; running = ctx.inFlight.get(thread.id)) {
    await running.done.catch(() => undefined);
  }
  const held = ctx.heldAnswers.get(thread.id) ?? [];
  ctx.heldAnswers.delete(thread.id);
  thread.pendingAnswers = [];
  ctx.touch(thread);
  if (held.length > 0 && !thread.archived) ctx.startTurn(thread.id, held.join('\n\n'));
}

/** Writes the answer into the part and tells everyone, whichever path asked. */
export function settlePermission(
  ctx: FakeContext,
  thread: Thread,
  message: Message,
  partIndex: number,
  request: PermissionRequest,
  decision: 'allow' | 'deny'
): void {
  const stored = message.parts[partIndex];
  if (stored && stored.type === 'permission') stored.decision = decision;
  ctx.emitToThread(thread.id, 'message.part', {
    threadId: thread.id,
    messageId: message.id,
    partIndex,
    part: { type: 'permission', requestId: request.id, toolName: request.toolName, decision }
  });
  ctx.emit('permission.resolved', { requestId: request.id, threadId: thread.id, decision });
}

/**
 * What the core's recovery does to a thread whose turn it ends: every
 * request still waiting is settled and dropped, the question with a null
 * answer and the permission with a deny (`packages/core/src/threads.ts`).
 */
export function clearRequestsOf(ctx: FakeContext, threadId: ThreadId): void {
  for (const [questionId, pending] of [...ctx.pendingQuestions]) {
    if (pending.request.threadId !== threadId || pending.request.async === true) continue;
    ctx.pendingQuestions.delete(questionId);
    ctx.emit('question.answered', { questionId, threadId, answer: null });
    pending.resolve(null);
  }
  for (const [requestId, pending] of [...ctx.pendingPermissions]) {
    if (pending.request.threadId !== threadId) continue;
    ctx.pendingPermissions.delete(requestId);
    ctx.emit('permission.resolved', { requestId, threadId, decision: 'deny' });
    pending.resolve('deny');
  }
}

export function requestMethods(ctx: FakeContext) {
  return {
    'permissions.list': async (params) => {
      const requests = [...ctx.pendingPermissions.values()]
        .map((pending) => pending.request)
        .filter((request) => params.threadId === undefined || request.threadId === params.threadId)
        .sort((a, b) => a.createdAt - b.createdAt);
      return structuredClone(requests);
    },
    'permissions.answer': async (params) => {
      const pending = ctx.pendingPermissions.get(params.requestId);
      if (!pending) throw ctx.notFound('permission request', params.requestId);
      ctx.pendingPermissions.delete(params.requestId);
      pending.resolve(params.decision);
      return { ok: true };
    },
    'questions.list': async (params) => {
      const requests = [...ctx.pendingQuestions.values()]
        .map((pending) => pending.request)
        .filter((request) => params.threadId === undefined || request.threadId === params.threadId)
        .sort((a, b) => a.createdAt - b.createdAt);
      return structuredClone(requests);
    },
    'questions.ask': async (params) => {
      const thread = ctx.thread(params.threadId);
      if (thread.archived) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'cannot ask on an archived thread', data: { threadId: thread.id } });
      const asked = checkAsk(params);
      const turn = thread.turns.find((entry) => entry.status === 'running') ?? thread.turns.at(-1);
      if (!turn) {
        throw new RpcFailure({
          code: RpcErrorCode.Refused,
          message: 'the thread has no turn to ask in yet',
          data: { threadId: params.threadId }
        });
      }
      return { questionId: askAsync(ctx, thread, turn, null, asked.text, asked.labels, asked.multiple, params.open) };
    },
    'settings.request': async (params) => {
      const thread = ctx.thread(params.threadId);
      if (thread.archived) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'cannot ask on an archived thread', data: { threadId: thread.id } });
      const turn = thread.turns.find((entry) => entry.status === 'running') ?? thread.turns.at(-1);
      if (!turn) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'the thread has no turn to ask in yet', data: { threadId: params.threadId } });
      return requestSetting(ctx, thread, turn, params);
    },
    'agent.settings': async () => ({
      app: ctx.clientPreferences === null ? null : { language: ctx.clientPreferences.language, device: null, client: null },
      settings: readSettings(ctx.settings, ctx.clientPreferences),
    }),
    'client.preferences': async (params) => {
      const checked = checkClientPreferences(params);
      if (!checked.ok) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: checked.message, data: { field: checked.field } });
      const before = ctx.clientApps.get(checked.preferences.app)?.experiments ?? null;
      ctx.clientApps.set(checked.preferences.app, checked.preferences);
      ctx.clientPreferences = checked.preferences;
      settleSettings(ctx, ctx.settings, { preferences: checked.preferences, before });
      return { ok: true, desktop: ctx.desktopExperiments === null ? null : [...ctx.desktopExperiments] };
    },
    'questions.skip': async (params) => {
      const pending = ctx.pendingQuestions.get(params.questionId);
      if (!pending) throw ctx.notFound('question', params.questionId);
      if (pending.request.threadId !== params.threadId) {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'the question belongs to another thread', data: { ...params, expected: pending.request.threadId } });
      }
      ctx.pendingQuestions.delete(params.questionId);
      pending.resolve(null);
      return { ok: true };
    },
    'questions.answer': async (params) => {
      const pending = ctx.pendingQuestions.get(params.questionId);
      if (!pending) throw ctx.notFound('question', params.questionId);
      // Every refusal comes before the delete, so a refused answer leaves the card pending.
      checkAnswer(pending.request, params);
      ctx.pendingQuestions.delete(params.questionId);
      const text = params.text ?? '';
      const answer: QuestionAnswer =
        text.length > 0 ? { optionIds: [...params.optionIds], text } : { optionIds: [...params.optionIds] };
      // The core writes the bytes to its disk and keeps this list on the card.
      const files = params.attachments ?? [];
      if (files.length > 0) answer.attachments = files.map((file) => ({ kind: file.kind, mimeType: file.mimeType, name: file.name, bytes: Math.floor(file.data.length * 3 / 4) - (file.data.match(/=*$/)?.[0].length ?? 0) }));
      pending.resolve(answer);
      return { ok: true };
    },
  } satisfies Partial<FakeMethods>;
}
