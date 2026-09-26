import type { SDKAssistantMessageError, SDKMessage, SDKResultMessage, SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import type { AgentCommand, BackgroundTask, ToolDocument, Usage } from '@boite/contracts';
import type { PromptCacheLife } from '../types.ts';

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
  message?: { id?: string };
  content_block?: ContentBlock;
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
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
      .map((block) => (block.type === 'text' ? (block.text ?? '') : stringify(block)))
      .join('\n');
  }
  return stringify(content);
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

/**
 * A resumed CLI restores the session's running totals when it still holds them,
 * and `total_cost_usd` then includes the earlier turns. Its per-model token
 * counts are restored with it, so they exceed this turn's own by what those
 * turns used; a CLI that started from zero shows no such gap.
 */
export function restoredCost(result: SDKResultMessage, before: { costUsd: number; tokens: number }): number {
  if (before.costUsd <= 0 || before.tokens <= 0) return 0;
  const held = Object.values(result.modelUsage ?? {}).reduce((sum, model) => sum + model.inputTokens + model.outputTokens + model.cacheReadInputTokens + model.cacheCreationInputTokens, 0);
  const own = mapUsage(result, 0);
  const turn = own.inputTokens + own.outputTokens + own.cacheReadTokens + own.cacheWriteTokens;
  return held - turn >= before.tokens / 2 ? before.costUsd : 0;
}

/** `costBefore` is what the same CLI process already charged to earlier turns of a warm query. */
export function mapUsage(result: SDKResultMessage, costBefore: number): Usage {
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
    // A total under what was already charged is a process that started over.
    costUsdEquivalent: total === null ? null : total >= costBefore ? total - costBefore : total,
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

export function errorSentence(error: SDKAssistantMessageError): string {
  switch (error) {
    case 'authentication_failed':
      return 'Claude refused the login of this account.';
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
      return `Claude failed with ${error}.`;
  }
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
