import type { SDKAssistantMessageError, SDKMessage, SDKResultMessage, SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import type { AgentCommand, BackgroundTask, ToolDocument, Usage } from '@boite/contracts';
import type { PromptCacheLife } from '../types.ts';
import { stringify } from '../tool-text.ts';

/** `api_retry`: the CLI is running a request that failed and will try again. */
export function isApiRetry(message: SDKMessage): boolean {
  return message.type === 'system' && message.subtype === 'api_retry';
}

/** The JSON boundary: the SDK types these through the Anthropic API package. */
interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

export interface StreamEvent {
  type: string;
  index?: number;
  message?: { id?: string; model?: string };
  content_block?: ContentBlock;
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string | null };
}

/** The SDK's `SlashCommand` as the contract's `AgentCommand`: an empty field becomes null. */
export function commandsOf(list: SlashCommand[]): AgentCommand[] {
  return list.map((command) => ({
    name: command.name,
    description: command.description || null,
    hint: command.argumentHint || null,
  }));
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

/**
 * The diffs a file-writing tool's parsed input already carries, so the card
 * shows the change without waiting for the tool result. `Edit` is one diff,
 * `Write` a diff against nothing, `MultiEdit` one diff per edit on the same
 * path. A tool whose input is still streaming has no parsed object to read, and
 * no other Claude tool describes a file change in its input.
 */
export function editDocuments(name: string, input: unknown): ToolDocument[] {
  if (typeof input !== 'object' || input === null) return [];
  const record = input as Record<string, unknown>;
  const path = stringField(record, 'file_path');
  if (path === null || path.length === 0) return [];
  if (name === 'Edit') {
    const oldText = stringField(record, 'old_string');
    const newText = stringField(record, 'new_string');
    if (oldText === null || newText === null) return [];
    return [{ kind: 'diff', path, oldText, newText }];
  }
  if (name === 'Write') {
    const content = stringField(record, 'content');
    return content === null ? [] : [{ kind: 'diff', path, oldText: '', newText: content }];
  }
  if (name !== 'MultiEdit') return [];
  const edits = record['edits'];
  if (!Array.isArray(edits)) return [];
  const documents: ToolDocument[] = [];
  for (const edit of edits) {
    if (typeof edit !== 'object' || edit === null) continue;
    const one = edit as Record<string, unknown>;
    const oldText = stringField(one, 'old_string');
    const newText = stringField(one, 'new_string');
    if (oldText === null || newText === null) continue;
    documents.push({ kind: 'diff', path, oldText, newText });
  }
  return documents;
}

/** The Agent or Task tool call a message belongs to, or null for the main loop's own. */
export function subagentOf(message: SDKMessage): string | null {
  if (message.type !== 'assistant' && message.type !== 'user' && message.type !== 'stream_event') return null;
  const parent = (message as { parent_tool_use_id?: unknown }).parent_tool_use_id;
  return typeof parent === 'string' && parent.length > 0 ? parent : null;
}

export function contentBlocks(content: unknown): ContentBlock[] {
  if (Array.isArray(content)) return content as ContentBlock[];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}

export function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as ContentBlock[])
      .map((block) => (block.type === 'text' ? (block.text ?? '') : stringify(block) ?? ''))
      .join('\n');
  }
  return stringify(content) ?? '';
}


/**
 * A resumed CLI restores the running totals its transcript saved when its last
 * process ended, and `total_cost_usd` then includes the earlier turns. Its
 * per-model token counts are restored with it, so they exceed this turn's own
 * by what was restored; a CLI that started from zero shows no such gap.
 * `before` is what the session's last process reported (`Turn.agentTotals`),
 * or the sum of its turns when they predate that. Returns the part of the
 * total that earlier turns already account for, or null when an older save
 * came back: what it restored is unknown, so this turn's own share is too.
 */
export function restoredCost(result: SDKResultMessage, before: { costUsd: number; tokens: number }): number | null {
  const total = typeof result.total_cost_usd === 'number' ? result.total_cost_usd : 0;
  if (before.costUsd <= 0 || before.tokens <= 0 || total <= 0) return 0;
  const own = mapUsage(result, 0);
  const turn = own.inputTokens + own.outputTokens + own.cacheReadTokens + own.cacheWriteTokens;
  const restored = heldTokens(result) - turn;
  if (restored >= before.tokens && total >= before.costUsd) return before.costUsd;
  return restored < before.tokens / 2 ? 0 : null;
}

/** Every token of the result's `modelUsage`: the CLI's running count, restored totals included. */
function heldTokens(result: SDKResultMessage): number {
  return Object.values(result.modelUsage ?? {}).reduce((sum, model) => sum + model.inputTokens + model.outputTokens + model.cacheReadInputTokens + model.cacheCreationInputTokens, 0);
}

/**
 * The CLI's running totals as this result left them, what a later resume
 * restores. None from a result with nothing counted: a startup error reports
 * zeroed totals that say nothing about what the session's transcript holds.
 */
export function agentTotalsOf(result: SDKResultMessage): { costUsd: number; tokens: number } | null {
  if (typeof result.total_cost_usd !== 'number') return null;
  const tokens = heldTokens(result);
  return result.total_cost_usd > 0 || tokens > 0 ? { costUsd: result.total_cost_usd, tokens } : null;
}

/**
 * `costBefore` is what the same CLI process already charged to earlier turns
 * of a warm query, null when that is unknown and so is this turn's cost.
 */
export function mapUsage(result: SDKResultMessage, costBefore: number | null): Usage {
  const total = typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null;
  const usage = result.usage as
    | {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      }
    | undefined;
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
    // A total under what was already charged leaves this turn's share unknown:
    // the CLI restored less than the journal holds. Charging the whole total
    // would count the restored turns again, and the journal's sum, read back
    // as `costBefore` on the next resume, would grow with every cold start.
    costUsdEquivalent: total === null || costBefore === null || total < costBefore ? null : total - costBefore,
  };
}

/**
 * How long the cache written by one API request lives, from the split the API
 * reports under `usage.cache_creation`. A request writing at both lifetimes is
 * as warm as its shorter one, since the conversation's tail is the part the
 * next request needs most. Null when the request wrote nothing: a pure read
 * restarts the clock of whatever lifetime the earlier write had.
 */
export function cacheLifeOf(usage: unknown): PromptCacheLife | null {
  if (usage === null || typeof usage !== 'object') return null;
  const creation = (usage as { cache_creation?: unknown }).cache_creation;
  if (creation === null || typeof creation !== 'object') return null;
  const split = creation as { ephemeral_5m_input_tokens?: unknown; ephemeral_1h_input_tokens?: unknown };
  const short = typeof split.ephemeral_5m_input_tokens === 'number' ? split.ephemeral_5m_input_tokens : 0;
  const long = typeof split.ephemeral_1h_input_tokens === 'number' ? split.ephemeral_1h_input_tokens : 0;
  if (short > 0) return { ttlSeconds: 300, source: 'reported' };
  if (long > 0) return { ttlSeconds: 3600, source: 'reported' };
  return null;
}

/** What one API request carried: its input, plus what it read from and wrote to the cache. */
export function requestTokens(usage: unknown): number | null {
  if (usage === null || typeof usage !== 'object') return null;
  const fields = usage as Record<string, unknown>;
  const input = fields.input_tokens;
  if (typeof input !== 'number' || !Number.isFinite(input)) return null;
  const read = typeof fields.cache_read_input_tokens === 'number' ? fields.cache_read_input_tokens : 0;
  const written = typeof fields.cache_creation_input_tokens === 'number' ? fields.cache_creation_input_tokens : 0;
  return input + read + written;
}

/**
 * The window of the thread's model as the result names it, else of the one
 * model the turn ran on, else null: two models in one turn is a subagent's
 * doing and the meter is the main loop's.
 */
export function contextWindowOf(result: SDKResultMessage, model: string | null): number | null {
  const usage = result.modelUsage as Record<string, { contextWindow?: unknown }> | undefined;
  if (usage === undefined) return null;
  const entries = Object.entries(usage);
  const own = model === null ? undefined : entries.find(([id]) => id === model || id.startsWith(`${model}-`));
  const picked = own ?? (entries.length === 1 ? entries[0] : undefined);
  const window = picked?.[1].contextWindow;
  return typeof window === 'number' && Number.isFinite(window) && window > 0 ? window : null;
}

/** What an API error code means, or the generic sentence for a code that says nothing. */
export function errorSentence(error: SDKAssistantMessageError): string {
  return namedErrorSentence(error) ?? (error === 'unknown' ? 'Claude stopped on an API error and gave no reason.' : `Claude stopped on an API error (${error}).`);
}

function namedErrorSentence(error: SDKAssistantMessageError): string | null {
  switch (error) {
    case 'authentication_failed':
      return 'Claude could not authenticate this account. Sign in again to reconnect.';
    case 'oauth_org_not_allowed':
      return 'The organisation of this login does not allow Claude Code.';
    case 'account_on_hold':
      return 'This Claude account is on hold.';
    case 'billing_error':
      return 'Claude reported a billing problem on this account.';
    case 'rate_limit':
      return 'This Claude account has hit its rate limit.';
    case 'overloaded':
      return 'Claude is overloaded and refused the request.';
    case 'invalid_request':
      return 'Claude refused the request as invalid.';
    case 'model_not_found':
      return 'The model this thread asks for does not exist.';
    case 'max_output_tokens':
      return 'The answer reached the model output limit.';
    case 'server_error':
      return 'Claude returned a server error.';
    default:
      return null;
  }
}

/** Native login failures only; billing, model and tool failures keep the login. */
export function isAuthenticationFailure(reason: string): boolean {
  return /\b(?:OAuth (?:session|(?:access )?token) (?:has |is )?(?:expired|revoked)|Signed out of Claude|Invalid API key)\b/i.test(reason);
}

/** The HTTP status of a refused request that a new login cannot cure: a permission, not a credential. */
export const FORBIDDEN = 403;
/** The HTTP status of a refused credential: an expired, revoked or invalid login. */
const UNAUTHORIZED = 401;

/**
 * The HTTP status of the API failure a frame reports: the result's own
 * `api_error_status`, else the status the CLI wrote in its text
 * ("API Error: 403 ..."), which is all an assistant error frame carries.
 */
export function apiErrorStatusOf(message: SDKMessage): number | null {
  if (message.type === 'result' && message.subtype === 'success' && typeof message.api_error_status === 'number') return message.api_error_status;
  const text = message.type === 'assistant'
    ? textOf((message.message as { content?: unknown } | undefined)?.content)
    : message.type === 'result'
      ? (message.subtype === 'success' ? message.result : message.errors.join('; '))
      : '';
  const said = /\bAPI Error: (\d{3})\b/.exec(text);
  return said === null ? null : Number(said[1]);
}

/**
 * The CLI labels an HTTP 403 `authentication_failed` as it does a 401, so the
 * label alone cannot sign an account out: only the result that follows, or a
 * status the frame's own text names, says which it was. True for a frame that
 * may be a credential failure and waits for that result.
 */
export function authenticationSuspectOf(message: SDKMessage): boolean {
  return subagentOf(message) === null && message.type === 'assistant' &&
    message.error === 'authentication_failed' && apiErrorStatusOf(message) !== FORBIDDEN;
}

/**
 * Account-level authentication refusal read from a result; delegated-agent
 * failures cannot sign out their parent, and a 403 is a refused permission
 * that leaves the login valid. `suspect` is an `authentication_failed` frame
 * of the same request (`authenticationSuspectOf`): any other status confirms it.
 */
export function authenticationFailureOf(message: SDKMessage, suspect = false): string | null {
  if (subagentOf(message) !== null || message.type !== 'result') return null;
  const status = apiErrorStatusOf(message);
  if (status === FORBIDDEN) return null;
  // A result can carry the 401 with no labelled frame before it, in words the text matcher does not know.
  if (suspect || status === UNAUTHORIZED) return errorSentence('authentication_failed');
  if (message.subtype === 'success' && !message.is_error) return null;
  const reason = message.subtype === 'success' ? message.result : message.errors.join('; ');
  return isAuthenticationFailure(reason) ? reason : null;
}

/**
 * What a turn refused with a 403 says: the API's own text, behind a sentence
 * that keeps the user from signing in again for nothing. The CLI prefixes it
 * "Failed to authenticate.", which a permission refusal is not.
 */
export function forbiddenReason(said: string): string {
  const text = said.replace(/^Failed to authenticate\.?\s*/i, '').trim();
  const sentence = 'Claude refused this request; the account is still signed in.';
  return text.length === 0 ? sentence : `${sentence} ${text}`;
}

function textOf(content: unknown): string {
  return contentBlocks(content)
    .map((block) => (block.type === 'text' ? (block.text ?? '').trim() : ''))
    .filter((text) => text.length > 0)
    .join(' ');
}

/**
 * The error sentence, then the text the CLI wrote with it. The code alone
 * hides the cause: a request over a proxy's body limit and a malformed one
 * are both `invalid_request`, and only the text says "Request too large".
 * A code the CLI could not name (`unknown`, as when a proxy cuts the stream)
 * adds nothing, so the text alone is the reason.
 */
export function apiErrorReason(error: SDKAssistantMessageError, content: unknown): string {
  const said = textOf(content);
  if (said.length === 0) return errorSentence(error);
  const sentence = namedErrorSentence(error);
  if (sentence === null) return said;
  return said === sentence ? sentence : `${sentence} ${said}`;
}

/** The CLI's `task_type` as the kinds the UI draws. */
export function backgroundKind(type: string): BackgroundTask['kind'] {
  switch (type) {
    case 'local_bash':
      return 'shell';
    case 'local_agent':
    case 'remote_agent':
      return 'agent';
    case 'monitor':
    case 'mcp_task':
      return 'monitor';
    case 'local_workflow':
      return 'workflow';
    default:
      return 'other';
  }
}
