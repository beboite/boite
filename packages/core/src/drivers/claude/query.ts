import type { EffortLevel, Options, PermissionMode as SdkPermissionMode, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ImageAttachment, PermissionMode } from '@boite/contracts';
import type { SessionContext } from '../types.ts';
import { fitImages } from './images.ts';
import { CONTEXT_ENV, CONTEXT_GUIDES_ENV } from '../../context-mode.ts';

export const STDERR_MAX = 400;

/** The effort levels the SDK takes as an option; see `Options['effort']`. */
const SDK_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/** The one level the CLI has no option for: it is a word in the prompt. */
export const PROMPT_EFFORT = 'ultrathink';

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query;

export interface ClaudeDeps {
  /** Resolved on the first turn: importing the SDK costs about 69 MB of resident memory. */
  loadQuery: () => Promise<QueryFn>;
}

/** The native settings a warm or running query can change without another prompt. */
export interface LiveSetup {
  model: string | null;
  /**
   * Null is the model's own default, and both cases land there: a thread with
   * no effort, and `ultrathink`, which is a word in the prompt and no option at
   * all. `applyFlagSettings` takes null as "clear it from the flag layer", so
   * the drift back to the default is one call like any other.
   */
  effortLevel: EffortLevel | null;
  fastMode: boolean;
  /**
   * What the CLI runs in: the mode Boite set, or one the CLI reported entering
   * by itself (EnterPlanMode, or an ExitPlanMode it was refused), which can be
   * one Boite has no name for.
   */
  permissionMode: Exclude<PermissionMode, 'yolo'> | SdkPermissionMode;
  disableHooks: boolean;
}

/** What this turn asks the running query to be, whatever the last one asked for. */
export function liveSetup(thread: { model: string | null; effort: string | null; permissionMode: PermissionMode; speed?: string | null; contextMode?: { hooks: boolean } | null }, protectedExecution = false): LiveSetup {
  const effort = thread.effort;
  return {
    model: thread.model,
    effortLevel: effort !== null && SDK_EFFORTS.includes(effort) ? (effort as EffortLevel) : null,
    fastMode: thread.speed === 'fast',
    permissionMode: thread.permissionMode === 'yolo' ? 'bypassPermissions' : thread.permissionMode,
    // A context mode without hooks keeps them off whatever the permission mode.
    disableHooks: protectedExecution || thread.permissionMode === 'yolo' || thread.contextMode?.hooks === false,
  };
}

function userMessage(uuid: string, text: string, images: ImageAttachment[] = []): SDKUserMessage {
  const content =
    images.length === 0
      ? text
      : [
          { type: 'text', text },
          ...images.map((image) => ({
            type: 'image',
            source: { type: 'base64', media_type: image.mimeType, data: image.data },
          })),
        ];
  return { type: 'user', uuid, message: { role: 'user', content }, parent_tool_use_id: null } as SDKUserMessage;
}

/**
 * The user messages of a warm session, in order. The SDK reads this once and
 * answers every message with its own `result`, so one generator carries every
 * turn of the thread until the session ends.
 */
export class PromptQueue {
  /** A message with images waits for them to be fitted; the order stays the push order. */
  private readonly items: (SDKUserMessage | Promise<SDKUserMessage>)[] = [];
  private notify: (() => void) | null = null;
  private ended = false;

  /**
   * Returns the message's uuid. The CLI lists it in `user_message_uuids` on
   * the result that answers it, also when it folds the message into a run
   * already going.
   */
  push(text: string, attachments: ImageAttachment[]): string {
    const uuid = crypto.randomUUID();
    this.items.push(attachments.length === 0 ? userMessage(uuid, text) : fitImages(attachments).then((images) => userMessage(uuid, text, images)));
    this.wake();
    return uuid;
  }

  end(): void {
    this.ended = true;
    this.wake();
  }

  async *stream(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = this.items.shift();
      if (next !== undefined) {
        const message = await next;
        yield message;
        // Asking for the next prompt means the SDK wrote this one. Its loop and
        // this generator still hold the object until then: let the images go.
        const content = message.message.content;
        if (typeof content !== 'string') message.message.content = content.filter(block => block.type !== 'image');
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.notify = resolve;
      });
    }
  }

  private wake(): void {
    const notify = this.notify;
    this.notify = null;
    notify?.();
  }
}

/**
 * Process identity and launch-only settings. The query enables permission-mode
 * changes at launch; setPermissionMode selects the actual policy, and
 * applyFlagSettings toggles configured hooks without changing this key.
 */
export function sessionKey(ctx: SessionContext): string {
  return JSON.stringify({
    cwd: ctx.thread.cwd,
    generation: ctx.thread.sessionGeneration ?? 0,
    resumeAt: ctx.resumeAt ?? null,
    accountId: ctx.account.id,
    env: ctx.accountEnv,
    protection: ctx.protectedExecution?.fingerprint ?? null,
  });
}

/**
 * The core runs inside a Claude Code session on this machine and the CLI
 * refuses to nest: the child must not inherit the session's own markers.
 * The account's variables are set on purpose and are kept.
 */
export function childEnv(accountEnv: Record<string, string>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env['CLAUDECODE'];
  delete env['CLAUDE_PID'];
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDE_CODE_')) delete env[key];
  }
  return { ...env, ...accountEnv };
}

/** The account's CLI environment with the conversation's context mode. */
export function cliEnv(ctx: SessionContext): Record<string, string | undefined> {
  const mode = ctx.thread.contextMode ?? null;
  const env = agentEnv(ctx.accountEnv, ctx.toolSummaries === true, ctx.shortAnswers === true);
  return mode === null ? env : {
    ...env,
    [CONTEXT_ENV]: mode.label,
    [CONTEXT_GUIDES_ENV]: mode.guides ? undefined : '0',
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: mode.instructions ? undefined : '1',
  };
}

/** The CLI flag that picks what the API returns of the model's reasoning: `summarized` or `omitted`. */
export const THINKING_DISPLAY_FLAG = 'thinking-display';

/**
 * What makes the CLI write a `tool_use_summary` line after each batch of tool
 * calls ("Read rules.md and data.txt"). Off by default in a CLI driven through
 * the SDK. Each line is one small request to Haiku (`source=tool_use_summary_generation`
 * in the CLI's debug log, 2.1.299), billed to the account the session runs on.
 */
export const TOOL_SUMMARIES_ENV = 'CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES';

/**
 * What turns off the CLI's "the user hasn't heard from you in a while" note,
 * which it slips into a long silent turn to ask for a progress line. `0` is
 * read as off (CLI 2.1.303). Boite's short answers ask for the opposite, so
 * the two would pull against each other on every long turn.
 */
export const SILENT_TURN_REMINDER_ENV = 'CLAUDE_CODE_SILENT_TURN_REMINDER';

/**
 * The environment of a conversation's CLI: `childEnv`, plus the tool summaries
 * the timeline labels its calls with when the owner turned them on
 * (`Settings.toolSummaries`), without them a run reads as its counted calls,
 * and the CLI's progress reminder off while short answers are on.
 */
export function agentEnv(accountEnv: Record<string, string>, toolSummaries = false, shortAnswers = false): Record<string, string | undefined> {
  return {
    ...childEnv(accountEnv),
    ...(toolSummaries ? { [TOOL_SUMMARIES_ENV]: '1' } : {}),
    ...(shortAnswers ? { [SILENT_TURN_REMINDER_ENV]: '0' } : {}),
  };
}
