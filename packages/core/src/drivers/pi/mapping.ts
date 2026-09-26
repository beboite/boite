import { join } from 'node:path';
import type { AgentCommand, ImageAttachment } from '@boite/contracts';
import { resolveDataDir } from '../../paths.ts';
import { ANTHROPIC_DEFAULT, openAiCacheLife } from '../../prompt-cache.ts';
import type { PromptCacheLife, TurnContext } from '../types.ts';
import { AGENT_ENV, AGENT_OWN_MODEL, SESSION_ROOT } from './protocol.ts';
import type { PiAssistantMessage, PiCommand } from './protocol.ts';

/** The OpenAI Responses shapes pi sends to OpenAI's own endpoint, with an API key or a ChatGPT login. */
const PI_OPENAI_APIS = new Set(['openai-responses', 'openai-codex-responses']);

/**
 * The prompt cache lifetime one pi request left. On Anthropic pi passes the
 * API's own split through as `cacheWrite1h`, so the lifetime is reported; a
 * pi too old to carry the field gets Anthropic's default. On OpenAI's own
 * endpoint the model's published default applies, whatever `PI_CACHE_RETENTION`
 * asks for: on a pre-5.6 model its `long` is the 24 hour retention an
 * organization already defaults to, and from 5.6 on it is the 30 minutes that
 * are the default anyway. Anything else has no published lifetime. A request
 * that wrote nothing on Anthropic names nothing, like the Claude driver.
 */
export function piCacheLife(message: PiAssistantMessage): PromptCacheLife | null {
  const usage = message.usage;
  if (message.api === 'anthropic-messages' && message.provider === 'anthropic') {
    if (usage === undefined || (usage.cacheWrite ?? 0) <= 0) return null;
    if (usage.cacheWrite1h === undefined) return ANTHROPIC_DEFAULT;
    return usage.cacheWrite1h > 0 ? { ttlSeconds: 3600, source: 'reported' } : { ttlSeconds: 300, source: 'reported' };
  }
  if (message.api !== undefined && PI_OPENAI_APIS.has(message.api) && (message.provider === 'openai' || message.provider === 'openai-codex')) {
    return openAiCacheLife(message.model ?? null);
  }
  return null;
}

/** `process.env` plus what Boite forces, plus the account's own isolation, which wins. */
export function agentEnv(accountEnv: Record<string, string>): Record<string, string | undefined> {
  return { ...process.env, ...AGENT_ENV, ...accountEnv };
}

/** One `ImageContent` per attachment, `data` and `mimeType` as `docs/rpc.md` names them. */
export function imagesOf(attachments: ImageAttachment[]): { type: 'image'; data: string; mimeType: string }[] {
  return attachments.map((attachment) => ({
    type: 'image' as const,
    data: attachment.data,
    mimeType: attachment.mimeType,
  }));
}

/** `get_commands`' list as the contract's `AgentCommand`. pi carries no argument hint. */
export function commandsOf(list: PiCommand[]): AgentCommand[] {
  const commands: AgentCommand[] = [];
  for (const entry of list) {
    if (entry.name === undefined || entry.name.length === 0) continue;
    commands.push({ name: entry.name, description: entry.description ?? null, hint: null });
  }
  return commands;
}

export function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * A `ToolResult`, whose `content` is the block list every pi tool answers with.
 * The text blocks are the output the card shows; anything else is described
 * rather than dropped, so a card is never silently empty.
 */
export function contentText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return stringify(value);
  const parts: string[] = [];
  for (const block of content) {
    const entry = block as Record<string, unknown>;
    if (entry['type'] === 'text') parts.push(textOf(entry['text']));
    else parts.push(`[${textOf(entry['type']) || 'content'}]`);
  }
  return parts.length === 0 ? null : parts.join('\n');
}

function stringify(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return String(value);
  }
}

/**
 * Where this thread's transcript lives: its own directory under the account's
 * isolation directory, or under the core's data directory for an account on the
 * provider's own location, which must never write into the user's real `~/.pi`.
 */
export function sessionDirOf(ctx: TurnContext): string {
  const base = ctx.account.isolationDir ?? resolveDataDir();
  return join(base, SESSION_ROOT, ctx.thread.id);
}

/**
 * pi takes the model on the command line and nowhere else at launch:
 * `--model provider/id`, with `:<thinking>` appended for the reasoning level.
 * `default` is Boite's own id for "the agent keeps its own", so it sends
 * nothing at all.
 */
export function modelArgs(ctx: TurnContext): string[] {
  const model = ctx.thread.model;
  if (model === null || model === AGENT_OWN_MODEL) return [];
  return ['--model', ctx.thread.effort === null ? model : `${model}:${ctx.thread.effort}`];
}

/**
 * What a session was started with. A turn that differs on any of it needs its
 * own, because pi reads all of it once, on the command line. A change from one
 * named model or level to another is not in here: pi's RPC mode takes both on
 * a running session (`set_model`, `set_thinking_level`), which `align` sends.
 * Going back to pi's own model, or to no level at all, has no RPC call, so
 * whether the thread names each one is in the key. The permission mode is not
 * in here: pi has no approval gate in RPC mode, so nothing about it ever
 * reaches the agent and changing it would drop a process for nothing.
 */
export function sessionKey(ctx: TurnContext): string {
  const model = ctx.thread.model;
  return JSON.stringify({
    ownModel: model === null || model === AGENT_OWN_MODEL,
    ownEffort: ctx.thread.effort === null,
    cwd: ctx.thread.cwd,
    accountId: ctx.account.id,
    providerId: ctx.provider.id,
    env: ctx.accountEnv,
  });
}
