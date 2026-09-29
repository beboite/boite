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
import { isAntigravityQuestion } from '../antigravity.ts';
import { usdCostOf, type AcpTurn } from './turn.ts';

/** One `session/update` of the prompt in flight. */
export function drawUpdate(turn: AcpTurn, update: SessionNotification['update']): void {
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
      );
      break;
    case 'tool_call_update':
      turn.upsertTool(
        update.toolCallId,
        update.name ?? update.title ?? null,
        update.rawInput,
        update.rawOutput,
        update.status,
        update.content,
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
  if (turn === null) return { outcome: { outcome: 'cancelled' } };
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
