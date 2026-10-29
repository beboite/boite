/**
 * What the agent sends during a prompt, drawn on its turn: the message and
 * thought chunks, the tool calls, the usage and the plan, and the permission
 * requests and Antigravity's questions, answered by the user.
 */
import type {
  PermissionOption,
  PermissionOptionKind,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import { antigravitySubagentKind, isAntigravityQuestion } from '../antigravity.ts';
import { usdCostOf, type AcpTurn } from './turn.ts';

type Update = SessionNotification['update'];
type Fields = Record<string, unknown>;

const TOOL_STATUSES = new Set(['pending', 'in_progress', 'completed', 'failed']);
const PLAN_STATUSES = new Set(['pending', 'in_progress', 'completed']);
const PLAN_PRIORITIES = new Set(['high', 'medium', 'low']);

function fields(value: unknown): Fields | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : null;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** An optional string as the schema reads one: anything else is left out. */
function optionalString(value: unknown): string | null | undefined {
  return isString(value) || value === null ? value : undefined;
}

/** The entries of a list that pass, the others skipped, as the schema's lists do. */
function entries<T>(value: unknown, keep: (entry: Fields) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  const kept: T[] = [];
  for (const entry of value) {
    const record = fields(entry);
    const checked = record === null ? null : keep(record);
    if (checked !== null) kept.push(checked);
  }
  return kept;
}

/** A content block, with the fields Boite reads checked for the text and image kinds. */
function contentBlock(value: unknown): Fields | null {
  const block = fields(value);
  if (block === null || !isString(block['type'])) return null;
  if (block['type'] === 'text' && !isString(block['text'])) return null;
  if (block['type'] === 'image' && (!isString(block['data']) || !isString(block['mimeType']))) return null;
  return block;
}

function toolContent(entry: Fields): Fields | null {
  if (entry['type'] === 'diff') {
    if (!isString(entry['path']) || !isString(entry['newText'])) return null;
    return { ...entry, oldText: optionalString(entry['oldText']) };
  }
  if (entry['type'] === 'content') return contentBlock(entry['content']) === null ? null : entry;
  return isString(entry['type']) ? entry : null;
}

function toolFields(update: Fields, call: boolean): Fields | null {
  if (!isString(update['toolCallId'])) return null;
  if (call && !isString(update['title'])) return null;
  const content = update['content'];
  return {
    ...update,
    ...(call ? {} : { title: optionalString(update['title']) }),
    name: optionalString(update['name']),
    status: isString(update['status']) && TOOL_STATUSES.has(update['status']) ? update['status'] : undefined,
    content: call || Array.isArray(content) ? entries(content, toolContent) : undefined,
  };
}

function configOption(entry: Fields): Fields | null {
  if (!isString(entry['id']) || !isString(entry['name'])) return null;
  const base = { ...entry, category: optionalString(entry['category']) };
  if (entry['type'] === 'boolean') return typeof entry['currentValue'] === 'boolean' ? base : null;
  if (entry['type'] !== 'select' || !isString(entry['currentValue']) || !Array.isArray(entry['options'])) return null;
  const choice = (option: Fields): Fields | null => (isString(option['value']) && isString(option['name']) ? option : null);
  const grouped = entry['options'].length > 0 && fields(entry['options'][0])?.['group'] !== undefined;
  const options = grouped
    ? entries(entry['options'], (group) => (isString(group['group']) && isString(group['name']) ? { ...group, options: entries(group['options'], choice) } : null))
    : entries(entry['options'], choice);
  // A list that is neither all choices nor all groups is refused whole, as the schema does.
  if (options.length !== entry['options'].length) return null;
  return { ...base, options };
}

/**
 * The fields of one update that Boite reads, checked by hand: the SDK's own
 * parse of every `session/update` costs about fifteen times a `JSON.parse`
 * and runs twice per line. A required field that is missing or of the wrong
 * type drops the update; an optional one is left out; a list keeps the
 * entries that pass. Kinds Boite does not draw pass with their tag alone.
 */
function checkedUpdate(update: Fields): Fields | null {
  switch (update['sessionUpdate']) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
    case 'user_message_chunk':
      return contentBlock(update['content']) === null ? null : update;
    case 'tool_call':
      return toolFields(update, true);
    case 'tool_call_update':
      return toolFields(update, false);
    case 'plan':
      return {
        ...update,
        entries: entries(update['entries'], (entry) =>
          isString(entry['content']) && isString(entry['status']) && PLAN_STATUSES.has(entry['status'])
          && isString(entry['priority']) && PLAN_PRIORITIES.has(entry['priority']) ? entry : null),
      };
    case 'available_commands_update':
      return {
        ...update,
        availableCommands: entries(update['availableCommands'], (command) => {
          if (!isString(command['name']) || !isString(command['description'])) return null;
          const input = fields(command['input']);
          return { ...command, input: input !== null && isString(input['hint']) ? input : undefined };
        }),
      };
    case 'current_mode_update':
      return isString(update['currentModeId']) ? update : null;
    case 'config_option_update':
      return { ...update, configOptions: entries(update['configOptions'], configOption) };
    case 'usage_update': {
      if (typeof update['used'] !== 'number' || typeof update['size'] !== 'number') return null;
      const cost = fields(update['cost']);
      return { ...update, cost: cost !== null && typeof cost['amount'] === 'number' && isString(cost['currency']) ? cost : undefined };
    }
    case 'compaction_update':
      if (!isString(update['compactionId']) || !isString(update['status'])) return null;
      return { ...update, error: optionalString(update['error']) };
    default:
      return update;
  }
}

/**
 * The SDK's params parser for `session/update`: the notification when the
 * fields Boite reads have the types it reads them as, else null, which the
 * session drops.
 */
export function sessionNotificationOf(params: unknown): SessionNotification | null {
  const notification = fields(params);
  const update = fields(notification?.['update']);
  if (notification === null || update === null || !isString(notification['sessionId']) || !isString(update['sessionUpdate'])) return null;
  const checked = checkedUpdate(update);
  return checked === null ? null : ({ ...notification, update: checked as Update } as SessionNotification);
}

/** One `session/update` of the prompt in flight. */
export function drawUpdate(turn: AcpTurn, update: Update): void {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      if (update.content.type === 'text') turn.writeText(update.content.text);
      break;
    case 'agent_thought_chunk':
      if (update.content.type === 'text') turn.writeThinking(update.content.text);
      break;
    case 'tool_call':
      turn.upsertTool(
        update.toolCallId,
        update.name ?? update.title,
        update.rawInput,
        update.rawOutput,
        update.status,
        update.content,
        turn.antigravity ? antigravitySubagentKind(update) : null,
      );
      break;
    case 'tool_call_update':
      turn.upsertTool(
        update.toolCallId,
        update.name ?? (turn.ctx.provider.id === 'opencode-v2' ? null : update.title ?? null),
        update.rawInput,
        update.rawOutput,
        update.status,
        update.content,
        turn.antigravity ? antigravitySubagentKind(update) : null,
        update.title ?? null,
      );
      break;
    case 'usage_update': {
      const cost = usdCostOf(update);
      if (cost !== null) turn.costUsdEquivalent = cost;
      turn.noteContext(update.used, update.size);
      break;
    }
    case 'plan':
      turn.ctx.tasks?.(update.entries.map((entry, index) => ({ id: String(index), text: entry.content, status: entry.status })));
      break;
    case 'compaction_update':
      turn.ctx.reportProgress?.(update.status === 'in_progress' ? 'compacting' : 'working', update.error ?? null);
      break;
    default:
      // user_message_chunk, plan, plan_update, plan_removed,
      // config_option_update, session_info_update and the compaction
      // updates have no MessagePart in the contract, so they are dropped.
      break;
  }
}

/** A permission request or an Antigravity question, put to the user; with no prompt in flight, cancelled. */
export async function answerPermission(turn: AcpTurn | null, params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
  // `RequestPermissionResponse.outcome` is itself the tagged outcome object.
  if (turn === null || turn.isStopped) return { outcome: { outcome: 'cancelled' } };
  const call = params.toolCall;
  // Antigravity carries questions on this method, using its own option ids.
  const question = turn.antigravity && isAntigravityQuestion(params);
  if (question) {
    const ask = {
      text: call.title ?? 'Antigravity asks',
      options: params.options.map((option) => ({ id: option.optionId, label: option.name })),
      allowText: false, multiple: false,
    };
    const ticket = turn.ctx.askQuestion(ask);
    const index = turn.takeIndex();
    turn.part(index, { type: 'question', questionId: ticket.questionId, ...ask, answer: null });
    const answer = await Promise.race([ticket, turn.stopped.then(() => null)]);
    if (answer === null) return { outcome: { outcome: 'cancelled' } };
    turn.part(index, { type: 'question', questionId: ticket.questionId, ...ask, answer });
    const optionId = answer.optionIds[0];
    if (!params.options.some((option) => option.optionId === optionId)) return { outcome: { outcome: 'cancelled' } };
    return { outcome: { outcome: 'selected', optionId: optionId! } };
  }
  const toolName = call.name ?? call.title ?? call.toolCallId;
  if (turn.ctx.thread.permissionMode === 'yolo') {
    const optionId = pickOption(params.options, 'allow');
    return optionId === null ? { outcome: { outcome: 'cancelled' } } : { outcome: { outcome: 'selected', optionId } };
  }
  const ticket = turn.ctx.requestPermission(toolName, call.rawInput ?? null, call.title ?? null);
  const index = turn.takeIndex();
  turn.part(index, { type: 'permission', requestId: ticket.requestId, toolName, decision: null });
  const answer = await Promise.race([ticket, turn.stopped.then(() => 'cancelled' as const)]);
  if (answer === 'cancelled') return { outcome: { outcome: 'cancelled' } };
  turn.part(index, { type: 'permission', requestId: ticket.requestId, toolName, decision: answer });
  const optionId = pickOption(params.options, answer);
  if (optionId === null) return { outcome: { outcome: 'cancelled' } };
  return { outcome: { outcome: 'selected', optionId } };
}

function pickOption(options: PermissionOption[], decision: 'allow' | 'deny'): string | null {
  const wanted: PermissionOptionKind[] =
    decision === 'allow' ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  for (const kind of wanted) {
    const found = options.find((option) => option.kind === kind);
    if (found !== undefined) return found.optionId;
  }
  return null;
}
