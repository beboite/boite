/**
 * One `session/prompt` as the parts it draws, and the mapping from what ACP
 * carries (tool content, raw output, usage) to the contract's shapes.
 */
import type {
  AvailableCommand,
  ContentBlock,
  PromptResponse,
  ToolCallContent,
  ToolCallStatus,
  Usage as AcpUsage,
} from '@agentclientprotocol/sdk';
import type {
  AgentCommand,
  ImageAttachment,
  MessageId,
  MessagePart,
  ToolDocument,
  ToolStatus,
  Usage,
} from '@boite/contracts';
import { ANTHROPIC_DEFAULT, openAiCacheLife } from '../../prompt-cache.ts';
import { normalizeAntigravityTool } from '../antigravity.ts';
import { imageDocument } from '../documents.ts';
import type { PromptCacheLife, TurnContext, TurnResult } from '../types.ts';

/**
 * The prompt cache lifetime of an ACP agent's turn, from the thread's model.
 * Only OpenCode has one: its `provider/model` ids name the vendor, it marks
 * Anthropic prompts with a `cache_control` that carries no `ttl`, and it sends
 * OpenAI no retention option. Grok, Gemini behind Antigravity, and OpenCode's
 * own gateway publish no lifetime, so their threads show no timer.
 */
export function acpCacheLife(providerId: string, model: string | null): PromptCacheLife | null {
  if (providerId !== 'opencode' || model === null) return null;
  if (model.startsWith('anthropic/')) return ANTHROPIC_DEFAULT;
  if (model.startsWith('openai/')) return openAiCacheLife(model);
  return null;
}

/** What one tool part keeps of its output, and of each text document, in the journal. */
const TOOL_TEXT_MAX = 64 * 1024;

/** One `ContentBlock::Image` per attachment, `mimeType` and `data` as ACP names them. */
export function imageBlocksOf(attachments: ImageAttachment[]): ContentBlock[] {
  return attachments.map((attachment) => ({
    type: 'image' as const,
    mimeType: attachment.mimeType,
    data: attachment.data,
  }));
}

interface ToolEntry {
  index: number;
  name: string;
  input: unknown;
  output: string | null;
  status: ToolStatus;
  documents: ToolDocument[];
}

/**
 * A tool call's `content` as documents. A `diff` member is a file the call
 * wrote, a text block is markdown, an image block an image. `terminal`, audio
 * and resource blocks have no document in the contract, so they are dropped.
 * This is not the tool's output: `rawOutput` stays what it always was. Text is
 * cut at `TOOL_TEXT_MAX`, since the whole part is journalled and sent again on
 * every `tool_call_update`; a diff that large becomes a line saying so, because
 * half a diff would read as a real change.
 */
function documentsOf(content: ToolCallContent[]): ToolDocument[] {
  const documents: ToolDocument[] = [];
  for (const entry of content) {
    if (entry.type === 'diff') {
      // No `oldText` is a file the call created.
      const oldText = entry.oldText ?? '';
      const size = oldText.length + entry.newText.length;
      if (size > TOOL_TEXT_MAX) {
        documents.push({ kind: 'markdown', title: entry.path, text: `The change is too large to show here (${size} characters).` });
        continue;
      }
      documents.push({ kind: 'diff', path: entry.path, oldText, newText: entry.newText });
      continue;
    }
    if (entry.type !== 'content') continue;
    const block = entry.content;
    if (block.type === 'text') documents.push({ kind: 'markdown', title: null, text: boundText(block.text) });
    else if (block.type === 'image') documents.push(imageDocument(block.mimeType, block.data, null));
  }
  return documents;
}

/** The head of a text, with a line saying where it was cut. */
function boundText(text: string, max = TOOL_TEXT_MAX): string {
  return text.length > max ? `${text.slice(0, max)}\n[cut at ${max} characters]` : text;
}

/** `AvailableCommand` as the contract's `AgentCommand`: no `input` means no hint. */
export function commandsOf(list: AvailableCommand[]): AgentCommand[] {
  return list.map((command) => ({
    name: command.name,
    description: command.description || null,
    hint: command.input?.hint ?? null,
  }));
}

/**
 * One `session/prompt` and what it wrote. The parts are drawn the way every
 * other driver draws them: one text part the chunks append to, one part per
 * tool call, one part per permission question.
 */
export class AcpTurn {
  private messageId: MessageId | null = null;
  private nextIndex = 0;
  private textIndex: number | null = null;
  private thinkingIndex: number | null = null;
  private readonly tools = new Map<string, ToolEntry>();

  private status: TurnResult['status'] = 'done';
  private error: string | null = null;
  private usage: Usage | null = null;
  private resolve: (result: TurnResult) => void = () => undefined;
  private wake: () => void = () => undefined;

  readonly done: Promise<TurnResult>;
  /** Resolves on `stop()`, so a permission still waiting can answer "cancelled". */
  readonly stopped: Promise<void>;

  sessionId: string | null;
  /**
   * The last USD cost an `usage_update` carried. The protocol defines it as the
   * session's running total, so the turn's own cost is what it added to
   * `costBefore`.
   */
  costUsdEquivalent: number | null = null;
  /** What the session had already cost when this turn began: see `AcpSession.costBaseline`. */
  costBefore = 0;
  /** `used` and `size` of the last `usage_update`, reported once when the turn ends. */
  contextUse: { tokens: number; window: number | null } | null = null;
  /**
   * The agent refused to load the thread's session in a way that says it no
   * longer has it: the thread's next turn starts a new session and carries the
   * conversation so far in its prompt.
   */
  sessionLost = false;
  isStopped = false;
  settled = false;

  /** This agent's dialect fixes, read once from the descriptor. */
  readonly antigravity: boolean;

  constructor(readonly ctx: TurnContext) {
    this.antigravity = ctx.provider.quirks?.includes('antigravity') === true;
    this.sessionId = ctx.sessionId;
    this.done = new Promise<TurnResult>((resolve) => {
      this.resolve = resolve;
    });
    this.stopped = new Promise<void>((resolve) => {
      this.wake = resolve;
    });
  }

  noteSession(sessionId: string): void {
    this.sessionId = sessionId;
  }

  markStopped(): void {
    this.isStopped = true;
    this.wake();
  }

  /**
   * A stop that ended the turn before the agent answered it: the process was
   * closed under a pending request. The turn is stopped, not failed, so no
   * error part; a turn that already failed stays failed.
   */
  stopNow(): void {
    if (this.settled || this.status === 'error') return;
    this.status = 'stopped';
  }

  /** `usage_update`: only the latest reading counts, and it is reported once, at the end. */
  noteContext(used: number, size: number): void {
    if (!Number.isFinite(used) || used < 0) return;
    this.contextUse = { tokens: used, window: Number.isFinite(size) && size > 0 ? size : null };
  }

  settle(): void {
    if (this.settled) return;
    this.settled = true;
    this.wake();
    if (this.contextUse !== null) this.ctx.context(this.contextUse);
    if (this.messageId !== null) {
      this.ctx.emit.complete(this.messageId, this.status === 'error' ? 'error' : 'complete');
    }
    this.resolve({
      status: this.status,
      sessionId: this.sessionId,
      usage: this.usage,
      error: this.error ?? undefined,
      promptCache: acpCacheLife(this.ctx.provider.id, this.ctx.thread.model),
      ...(this.sessionLost ? { sessionLost: true } : {}),
    });
  }

  /** The turn's share of the session's running cost; a total below what came before is a session that started over. */
  private turnCost(): number | null {
    const total = this.costUsdEquivalent;
    if (total === null) return null;
    return total >= this.costBefore ? total - this.costBefore : total;
  }

  /** The prompt response: the stop reason becomes the status, the usage the numbers. */
  finish(response: PromptResponse): void {
    this.usage = mapUsage(response.usage ?? null, this.turnCost());
    switch (response.stopReason) {
      case 'end_turn':
        break;
      case 'cancelled':
        this.status = 'stopped';
        break;
      default:
        this.fail(`the agent stopped: ${response.stopReason}`);
        break;
    }
  }

  fail(reason: string): void {
    if (this.status === 'error') return;
    this.status = 'error';
    this.error = reason;
    this.part(this.takeIndex(), { type: 'error', message: reason });
  }

  // -- parts ----------------------------------------------------------------

  private message(): MessageId {
    if (this.messageId === null) this.messageId = this.ctx.emit.startMessage('assistant');
    return this.messageId;
  }

  part(index: number, part: MessagePart): void {
    this.ctx.emit.part(this.message(), index, part);
  }

  takeIndex(): number {
    this.textIndex = null;
    this.thinkingIndex = null;
    const index = this.nextIndex;
    this.nextIndex += 1;
    return index;
  }

  writeText(text: string): void {
    if (text.length === 0) return;
    if (this.textIndex === null) {
      const index = this.nextIndex;
      this.nextIndex += 1;
      this.textIndex = index;
      // A text chunk after a thought chunk answers in its own part.
      this.thinkingIndex = null;
      this.part(index, { type: 'text', text: '' });
    }
    this.ctx.emit.delta(this.message(), this.textIndex, text);
  }

  /** `agent_thought_chunk`, the reasoning the UI folds. Its own part, like the text. */
  writeThinking(text: string): void {
    if (text.length === 0) return;
    if (this.thinkingIndex === null) {
      const index = this.nextIndex;
      this.nextIndex += 1;
      this.thinkingIndex = index;
      this.textIndex = null;
      this.part(index, { type: 'thinking', text: '' });
    }
    this.ctx.emit.delta(this.message(), this.thinkingIndex, text);
  }

  /**
   * `tool_call` opens the part, `tool_call_update` replaces the same one by id.
   * `content` replaces the documents when the agent sends one, the protocol's
   * own word for that field; null or absent leaves the ones already there.
   */
  upsertTool(
    toolCallId: string,
    name: string | null,
    input: unknown,
    output: unknown,
    status: ToolCallStatus | null | undefined,
    content: ToolCallContent[] | null | undefined,
  ): void {
    const entry = this.tools.get(toolCallId) ?? {
      index: this.takeIndex(),
      name: toolCallId,
      input: null,
      output: null,
      status: 'running' as ToolStatus,
      documents: [] as ToolDocument[],
    };
    if (name !== null && name.length > 0) entry.name = name;
    // Antigravity carries a shell call's command, its cwd and its combined
    // output under half a dozen spellings, and pads `_meta` with base64
    // images: the quirk folds those into what the card already draws.
    const native = this.antigravity ? normalizeAntigravityTool(input, output) : null;
    if (native !== null) {
      if (native.input !== undefined) entry.input = native.input;
      if (native.output !== undefined) entry.output = native.output;
    } else {
      if (input !== undefined) entry.input = input;
      // Journalled whole and sent again on every update: a file read or a
      // command's output can be megabytes.
      if (output !== undefined && output !== null) entry.output = boundText(toolOutputText(output));
    }
    if (status !== null && status !== undefined) entry.status = toolStatus(status);
    if (content !== null && content !== undefined) entry.documents = documentsOf(content);
    this.tools.set(toolCallId, entry);
    this.part(entry.index, {
      type: 'tool',
      toolId: toolCallId,
      name: entry.name,
      input: entry.input,
      output: entry.output,
      status: entry.status,
      ...(entry.documents.length > 0 ? { documents: entry.documents } : {}),
    });
  }
}

/**
 * `rawOutput` as the text a person reads. Agents wrap it their own way: OpenCode
 * answers `{ output, metadata }`, Grok answers a tagged object whose `output`
 * is the bytes of the text with `output_for_prompt` beside it, and its file
 * tools nest the text under `FileContent.content` or `Content.content`. A shape
 * nobody knows stays the JSON it was.
 */
export function toolOutputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === null || typeof output !== 'object' || Array.isArray(output)) return stringify(output);
  const record = output as Record<string, unknown>;
  const inner = record['output'];
  if (typeof inner === 'string') return inner;
  if (Array.isArray(inner) && inner.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    return new TextDecoder().decode(Uint8Array.from(inner as number[]));
  }
  if (typeof record['output_for_prompt'] === 'string') return record['output_for_prompt'];
  for (const key of ['FileContent', 'Content']) {
    const nested = record[key];
    if (nested !== null && typeof nested === 'object') {
      const content = (nested as Record<string, unknown>)['content'];
      if (typeof content === 'string') return content;
    }
  }
  return stringify(output);
}

function toolStatus(status: ToolCallStatus): ToolStatus {
  switch (status) {
    case 'completed':
      return 'done';
    case 'failed':
      return 'error';
    default:
      return 'running';
  }
}

/** A `usage_update`'s running cost when it is a finite USD amount, the only currency a turn records. */
export function usdCostOf(update: { cost?: { amount: number; currency: string } | null }): number | null {
  const cost = update.cost;
  if (cost == null || cost.currency !== 'USD' || !Number.isFinite(cost.amount) || cost.amount < 0) return null;
  return cost.amount;
}

/** `PromptResponse.usage` is experimental: a cost the agent reported without it is still the turn's cost. */
function mapUsage(usage: AcpUsage | null, costUsdEquivalent: number | null): Usage | null {
  if (usage === null) {
    if (costUsdEquivalent === null) return null;
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsdEquivalent };
  }
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cachedReadTokens ?? 0,
    cacheWriteTokens: usage.cachedWriteTokens ?? 0,
    costUsdEquivalent,
  };
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
