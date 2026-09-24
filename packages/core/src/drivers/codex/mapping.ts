import type { ImageAttachment, QuestionAnswer, QuestionOption, ToolStatus, Usage } from '@boite/contracts';
import type { TurnContext } from '../types.ts';
import type { CodexItem, CodexQuestion, CodexThreadOpened, CodexTokenUsage, ToolView } from './protocol.ts';
import { AGENT_OWN_MODEL, COMMAND_TOOL_NAME, FILE_CHANGE_TOOL_NAME, SLEEP_TOOL_NAME } from './protocol.ts';

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

export function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function stringify(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return String(value);
  }
}

/** The header and the question itself, whichever of the two the server filled. */
export function questionTextOf(entry: CodexQuestion): string {
  const header = textOf(entry.header).trim();
  const body = textOf(entry.question).trim();
  if (header.length > 0 && body.length > 0 && header !== body) return `${header}: ${body}`;
  return body.length > 0 ? body : header;
}

/** A string option, or an object with an id and a label, becomes one card row. */
export function optionsOf(raw: unknown): QuestionOption[] {
  if (!Array.isArray(raw)) return [];
  const options: QuestionOption[] = [];
  for (const [at, entry] of raw.entries()) {
    if (typeof entry === 'string') {
      options.push({ id: entry, label: entry });
      continue;
    }
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = firstString([record['id'], record['value'], record['label'], record['name']]) ?? String(at);
    const label = firstString([record['label'], record['name'], record['value'], record['id']]) ?? id;
    const description = firstString([record['description']]);
    options.push(description === undefined ? { id, label } : { id, label, description });
  }
  return options;
}

function firstString(values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * What goes back on the wire for one question: the text the user typed when
 * there is one, otherwise the label of what they picked. Codex reads a string
 * per question id, so an answer is flattened here rather than sent as an object.
 */
export function answerTextOf(answer: QuestionAnswer, options: QuestionOption[]): string {
  const picked = answer.optionIds
    .map((id) => options.find((option) => option.id === id)?.label ?? id)
    .join(', ');
  const text = answer.text ?? '';
  if (picked.length > 0 && text.length > 0) return `${picked}: ${text}`;
  return picked.length > 0 ? picked : text;
}

/** `CommandExecutionStatus`, `PatchApplyStatus`, `McpToolCallStatus` all read the same. */
function itemStatus(status: string | undefined): ToolStatus {
  switch (status) {
    case 'completed':
      return 'done';
    case 'failed':
      return 'error';
    case 'declined':
      return 'denied';
    default:
      return 'running';
  }
}

/** The four `ThreadItem` variants that are a tool card. Everything else is dropped. */
export function toolViewOf(item: CodexItem, completed = false): ToolView | null {
  switch (item.type) {
    // The agent waiting on purpose, for a background command or a timer: a
    // card, so the pause reads as a pause and not as a hang.
    case 'sleep':
      return {
        name: SLEEP_TOOL_NAME,
        input: { durationMs: typeof item.durationMs === 'number' ? item.durationMs : null },
        output: null,
        status: completed ? 'done' : 'running',
      };
    case 'commandExecution':
      return {
        name: COMMAND_TOOL_NAME,
        input: { command: item.command ?? '', cwd: item.cwd ?? null },
        output: item.aggregatedOutput ?? null,
        status: itemStatus(item.status),
      };
    case 'fileChange':
      return {
        name: FILE_CHANGE_TOOL_NAME,
        input: { changes: item.changes ?? [] },
        output: null,
        status: itemStatus(item.status),
      };
    case 'mcpToolCall':
      return {
        name: item.tool ?? 'mcp',
        input: item.arguments ?? null,
        output: item.error?.message ?? stringify(item.result),
        status: itemStatus(item.status),
      };
    case 'dynamicToolCall':
      return {
        name: item.tool ?? 'tool',
        input: item.arguments ?? null,
        output: stringify(item.contentItems),
        status: itemStatus(item.status),
      };
    default:
      return null;
  }
}

/**
 * `TokenUsageBreakdown.last`, the numbers of the turn that just ran. Codex
 * carries no price on the wire, so the cost stays null and the UI says so.
 */
export function mapUsage(last: CodexTokenUsage): Usage {
  return {
    inputTokens: last.inputTokens ?? 0,
    outputTokens: last.outputTokens ?? 0,
    cacheReadTokens: last.cachedInputTokens ?? 0,
    cacheWriteTokens: last.cacheWriteInputTokens ?? 0,
    costUsdEquivalent: null,
  };
}

/** The model and model provider a `thread/start` or `thread/resume` answer names. */
export function servedOf(opened: CodexThreadOpened): { model: string | null; provider: string | null } {
  return {
    model: typeof opened.model === 'string' ? opened.model : null,
    provider: typeof opened.modelProvider === 'string' ? opened.modelProvider : null,
  };
}

/**
 * The model this turn asks for, or null for the agent's own. `default` is the
 * descriptor's way of saying "whatever Codex is configured on", and Codex has
 * no model by that name, so it never reaches the wire.
 */
export function modelOf(ctx: TurnContext): string | null {
  const model = ctx.thread.model;
  if (model === null || model === AGENT_OWN_MODEL) return null;
  return model;
}

/** One `UserInput` image variant per attachment, a data URL as the app-server takes it. */
export function imageInputsOf(attachments: ImageAttachment[]): { type: 'image'; url: string }[] {
  return attachments.map((attachment) => ({
    type: 'image' as const,
    url: `data:${attachment.mimeType};base64,${attachment.data}`,
  }));
}

/**
 * What a session was started with and cannot be told to change. A turn that
 * differs on any of it needs its own. The model and the effort are not in here:
 * `turn/start` carries both on every turn, read off the thread as it stands
 * then, so a change reaches the running app-server with the next prompt. The
 * permission mode is, unlike the ACP driver's key: Codex takes the
 * `approvalPolicy` and `sandbox` pair on `thread/start` and `thread/resume` and
 * has no call that changes it on a live thread, so a change there is the one
 * thing that still drops the process.
 */
export function sessionKey(ctx: TurnContext): string {
  return JSON.stringify({
    cwd: ctx.thread.cwd,
    permissionMode: ctx.thread.permissionMode,
    accountId: ctx.account.id,
    providerId: ctx.provider.id,
    env: ctx.accountEnv,
  });
}
