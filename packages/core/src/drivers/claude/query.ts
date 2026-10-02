import type { EffortLevel, Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ImageAttachment, PermissionMode } from '@boite/contracts';
import type { SessionContext } from '../types.ts';

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
  permissionMode: Exclude<PermissionMode, 'yolo'>;
  disableHooks: boolean;
}

/** What this turn asks the running query to be, whatever the last one asked for. */
export function liveSetup(thread: { model: string | null; effort: string | null; permissionMode: PermissionMode }): LiveSetup {
  const effort = thread.effort;
  return {
    model: thread.model,
    effortLevel: effort !== null && SDK_EFFORTS.includes(effort) ? (effort as EffortLevel) : null,
    permissionMode: thread.permissionMode === 'yolo' ? 'bypassPermissions' : thread.permissionMode,
    disableHooks: thread.permissionMode === 'yolo',
  };
}

/**
 * The user messages of a warm session, in order. The SDK reads this once and
 * answers every message with its own `result`, so one generator carries every
 * turn of the thread until the session ends.
 */
export class PromptQueue {
  private readonly items: SDKUserMessage[] = [];
  private notify: (() => void) | null = null;
  private ended = false;

  push(text: string, attachments: ImageAttachment[]): void {
    const content =
      attachments.length === 0
        ? text
        : [
            { type: 'text', text },
            ...attachments.map((attachment) => ({
              type: 'image',
              source: { type: 'base64', media_type: attachment.mimeType, data: attachment.data },
            })),
          ];
    this.items.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    } as SDKUserMessage);
    this.wake();
  }

  end(): void {
    this.ended = true;
    this.wake();
  }

  async *stream(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = this.items.shift();
      if (next !== undefined) {
        yield next;
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
    speed: ctx.thread.speed ?? null,
  });
}

/**
 * The core runs inside a Claude Code session on this machine and the CLI
 * refuses to nest: the child must not inherit the session's own markers.
 */
export function childEnv(accountEnv: Record<string, string>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, ...accountEnv };
  delete env['CLAUDECODE'];
  delete env['CLAUDE_PID'];
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDE_CODE_')) delete env[key];
  }
  return env;
}
