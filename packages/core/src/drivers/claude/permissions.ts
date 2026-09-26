import type { CanUseTool, HookInput, HookJSONOutput, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { QuestionAnswer } from '@boite/contracts';
import type { TurnContext } from '../types.ts';
import type { ClaudeTurn } from './turn.ts';

const DENIED = 'Denied in Boite';

/** Settles `withdrawn` when the CLI cancels the request `signal` belongs to; never otherwise. */
function abortedBy(signal: AbortSignal | undefined): Promise<'withdrawn'> {
  return new Promise((resolve) => {
    if (signal === undefined) return;
    if (signal.aborted) resolve('withdrawn');
    else signal.addEventListener('abort', () => resolve('withdrawn'), { once: true });
  });
}

/** The tool whose questions Boite answers itself, as cards. */
const ASK_TOOL = 'AskUserQuestion';

interface AskedQuestion {
  question: string;
  multiSelect: boolean;
  options: { label: string; description?: string }[];
}

/** `AskUserQuestion`'s `questions`, read defensively: a malformed entry is skipped, never thrown. */
function askedQuestions(raw: unknown): AskedQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: AskedQuestion[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (typeof record['question'] !== 'string' || record['question'].length === 0) continue;
    const options = Array.isArray(record['options'])
      ? (record['options'] as unknown[]).flatMap((option) => {
        if (option === null || typeof option !== 'object') return [];
        const fields = option as Record<string, unknown>;
        if (typeof fields['label'] !== 'string' || fields['label'].length === 0) return [];
        return [{ label: fields['label'], ...(typeof fields['description'] === 'string' && fields['description'].length > 0 ? { description: fields['description'] } : {}) }];
      })
      : [];
    out.push({ question: record['question'], multiSelect: record['multiSelect'] === true, options });
  }
  return out;
}

/** What the gate reads from its session: the turn the CLI is on, and the context of the last turn attached. */
export interface GateHost {
  head(): ClaudeTurn | null;
  ctx(): TurnContext;
}

/** The permission callback and the two tool hooks one session hands the SDK. */
export interface ToolGate {
  canUseTool: CanUseTool;
  preToolUse: (input: HookInput) => Promise<HookJSONOutput>;
  postToolUse: (input: HookInput) => Promise<HookJSONOutput>;
}

export function toolGate(host: GateHost): ToolGate {
  /** Reached only when the CLI itself needs to ask. Every call is journalled by the hook. */
  const canUseTool: CanUseTool = async (toolName, input, options): Promise<PermissionResult> => {
    const turn = host.head();
    if (turn === null) {
      host.ctx().log('warn', `claude asked for ${toolName} with no turn running: denied`);
      return { behavior: 'deny', message: DENIED };
    }
    if (toolName === ASK_TOOL) return askUser(turn, input);
    const ticket = turn.ctx.requestPermission(toolName, input, options.title ?? options.description ?? null);
    const index = turn.takeIndex();
    turn.part(index, { type: 'permission', requestId: ticket.requestId, toolName, decision: null });
    // The ticket alone never settles when the CLI dies with the card open: the
    // turn ends, and the deny the core then writes would land behind
    // `message.completed`. Every other driver races the turn's stop here.
    // The CLI also aborts `signal` when it cancels the call by itself: the card
    // is taken back then, so it does not stay clickable for nobody.
    const decision = await Promise.race([ticket, turn.stopped.then(() => 'cancelled' as const), abortedBy(options.signal)]);
    if (decision === 'cancelled') return { behavior: 'deny', message: DENIED };
    if (decision === 'withdrawn') {
      ticket.withdraw();
      turn.part(index, { type: 'permission', requestId: ticket.requestId, toolName, decision: 'deny' });
      return { behavior: 'deny', message: DENIED };
    }
    turn.part(index, { type: 'permission', requestId: ticket.requestId, toolName, decision });
    if (decision === 'allow') return { behavior: 'allow', updatedInput: input };
    return { behavior: 'deny', message: DENIED };
  };

  /** No matcher: this hook sees every tool call, which is what makes it the single gate. */
  const preToolUse = async (input: HookInput): Promise<HookJSONOutput> => {
    // A subagent's tool calls are its own conversation: no card on the main message.
    // The assistant frame already drew the parsed input: the hook only draws a
    // call no frame announced, so one call is not written twice.
    if (input.hook_event_name === 'PreToolUse' && input.agent_id === undefined) {
      const turn = host.head();
      if (turn !== null && !turn.hasParsedTool(input.tool_use_id)) {
        turn.upsertTool(input.tool_use_id, input.tool_name, input.tool_input);
      }
    }
    return {};
  };

  /**
   * Only the coordination context. The tool's result is the `tool_result` the
   * CLI sends next, with its own text and error flag; `tool_response` here is
   * the raw object, a whole `originalFile` for an Edit, that no card shows.
   */
  const postToolUse = async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name === 'PostToolUse') {
      const additionalContext = host.head()?.ctx.coordination?.();
      if (additionalContext) return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext } };
    }
    return {};
  };

  return { canUseTool, preToolUse, postToolUse };
}

/**
 * `AskUserQuestion`: each question becomes a card, asked in order, and the
 * answers go back in the tool's own input (`answers`, keyed by the question
 * text, labels joined by a comma), which is what the CLI hands the model.
 */
async function askUser(turn: ClaudeTurn, input: Record<string, unknown>): Promise<PermissionResult> {
  const answers: Record<string, string> = {};
  for (const question of askedQuestions(input['questions'])) {
    const options = question.options.map((option, at) => ({
      id: String(at + 1),
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
    }));
    const ask = { text: question.question, options, allowText: true, multiple: question.multiSelect };
    const ticket = turn.ctx.askQuestion(ask);
    const index = turn.takeIndex();
    turn.part(index, { type: 'question', questionId: ticket.questionId, ...ask, answer: null });
    const answer: QuestionAnswer | null = await Promise.race([ticket, turn.stopped.then(() => null)]);
    if (answer === null) return { behavior: 'deny', message: DENIED };
    turn.part(index, { type: 'question', questionId: ticket.questionId, ...ask, answer });
    const labels = answer.optionIds.map(id => options.find(option => option.id === id)?.label ?? id);
    answers[question.question] = [...labels, ...(answer.text ? [answer.text] : [])].join(', ');
  }
  return { behavior: 'allow', updatedInput: { ...input, answers } };
}
