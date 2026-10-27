import type { HookCallback, Options, Query, SDKControlGetContextUsageResponse, Settings } from '@anthropic-ai/claude-agent-sdk';
import { messageOf } from '../../errors.ts';
import { PromptQueue, type QueryFn } from './query.ts';

/** Accepted window bounds in Claude Code's native `autoCompactWindow` setting. */
const MIN_WINDOW = 100_000;
const MAX_WINDOW = 1_000_000;

type OpenQuery = { query: Query; prompts: PromptQueue };

/**
 * What every compaction asks of its summary: Boite's `/compact`, the CLI's
 * own at its threshold and the user's. The summary rides in every call until
 * the next compaction: 20k characters, about 8k tokens, at the median over a
 * week of Claude sessions (`bun scripts/token-audit.ts`, 2026-10-27), some
 * 3,300 words. The CLI attaches the files read last after it, so their code
 * need not be in it.
 */
export const COMPACT_FOCUS = 'Keep the summary short, under 2,000 words: the user\'s requests and corrections, decisions and their reasons, the current state and the next step, and the paths, identifiers, commands and numbers still needed. Leave out code and tool output that the files hold, and finished steps that need no follow-up.';

/**
 * Claude Code 2.1.310 adds a PreCompact hook's `systemMessage` to the summary
 * prompt's "Additional Instructions", after any the `/compact` command gave.
 * A callback still runs under `disableAllHooks` and emits no hook event, so
 * it never reaches the user's hook ledger (probed offline, 2026-10-27).
 */
export const compactFocus: HookCallback = async () => ({ systemMessage: COMPACT_FOCUS });

/**
 * Claude Code 2.1.310 accepts the live flag but leaves appState.autoCompactWindow
 * unchanged. Measure locally without a prompt, then open the real query with
 * launch settings and verify its exact threshold before releasing any prompt.
 * Summary usage never calls the provider's token-count API.
 */
export async function openWithCompaction(
  create: QueryFn,
  options: Options,
  tokens: number | null,
  cancelled: () => boolean,
  warn: (reason: string) => void,
  initialPrompts?: PromptQueue,
): Promise<OpenQuery | null> {
  if (tokens === null) {
    if (cancelled()) return null;
    const prompts = initialPrompts ?? new PromptQueue();
    return { prompts, query: create({ prompt: prompts.stream(), options }) };
  }
  const open = (settings?: Settings, probe = false): OpenQuery => {
    const prompts = new PromptQueue();
    return { prompts, query: create({ prompt: prompts.stream(), options: {
      ...options,
      ...(probe ? {
        // A measurement runs no user hook or MCP process and writes no session.
        persistSession: false, tools: [], strictMcpConfig: true, mcpServers: {}, hooks: {},
        resume: undefined, resumeSessionAt: undefined, forkSession: false, continue: false,
      } : {}),
      settings: { ...(typeof options.settings === 'object' ? options.settings : {}), ...settings,
        ...(probe ? { disableAllHooks: true } : {}),
      },
    } }) };
  };
  let active: OpenQuery | null = null;
  const close = (): void => {
    active?.prompts.end();
    active?.query.close();
    active = null;
  };
  try {
    active = open({ autoCompactEnabled: true }, true);
    const usage = await active.query.getContextUsage({ detail: 'summary' });
    const window = windowFor(usage, tokens);
    close();
    if (cancelled()) return null;
    active = open({ autoCompactWindow: window, autoCompactEnabled: true });
    const applied = await active.query.getContextUsage({ detail: 'summary' });
    if (!applied.isAutoCompactEnabled || applied.autoCompactThreshold !== tokens) {
      throw new Error(`the CLI reports ${applied.autoCompactThreshold ?? 'no'} tokens instead of ${tokens}`);
    }
    if (cancelled()) { close(); return null; }
    return active;
  } catch (error) {
    // Never leave a guessed or clamped policy active. A fresh unmodified query
    // preserves the user's files, model policy and native defaults.
    close();
    if (cancelled()) return null;
    warn(`claude: native compaction cannot use the exact ${tokens}-token threshold (${messageOf(error)}); keeping the native policy and between-turn fallback`);
    return open();
  }
}

function windowFor(usage: SDKControlGetContextUsageResponse, tokens: number): number {
  const threshold = usage.autoCompactThreshold;
  if (!usage.isAutoCompactEnabled || typeof threshold !== 'number' || !Number.isSafeInteger(threshold) || !Number.isSafeInteger(usage.rawMaxTokens)
    || threshold <= 0 || usage.rawMaxTokens < threshold) throw new Error('the CLI did not report a usable native threshold and window');
  const window = tokens + usage.rawMaxTokens - threshold;
  if (!Number.isSafeInteger(window) || window < MIN_WINDOW || window > MAX_WINDOW) {
    throw new Error(`the required native window ${window} is outside ${MIN_WINDOW}..${MAX_WINDOW}`);
  }
  return window;
}
