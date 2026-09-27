import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { HookOutcome, MessagePart } from '@boite/contracts';
import type { HookReport } from '../../hooks.ts';

type HookResponse = Extract<SDKMessage, { type: 'system'; subtype: 'hook_response' }>;

/**
 * What the CLI says when a hook ended the turn (CLI 2.1.267): the event, the
 * command in brackets, the hook's own reason, then the prompt it refused.
 */
const ENDED_BY_HOOK = /^(\w+) operation blocked by hook:\s*(?:\[[^\n]*\]:\s*)?([\s\S]*?)(?:\n\nOriginal prompt:[\s\S]*)?$/;
const MESSAGE_MAX = 500;

/**
 * A `hook_response` as the ledger counts it. Exit code 2, or a JSON answer
 * that denies or blocks, is a block; `continue: false` stops the turn; any
 * other error or a cancelled hook failed. What the hook said is its reason
 * when it gave one, else its stderr, else its output.
 */
export function hookReport(message: HookResponse): HookReport {
  const decision = decisionOf(message.stdout);
  let outcome: HookOutcome = 'ok';
  let reason: string | null = null;
  if (message.outcome === 'cancelled') {
    outcome = 'failed';
    reason = 'cancelled before it answered';
  } else if (message.exit_code === 2) {
    outcome = 'blocked';
  } else if (message.outcome === 'error') {
    outcome = 'failed';
  } else if (decision !== null) {
    outcome = decision.outcome;
    reason = decision.reason;
  }
  if (outcome === 'ok') return { event: message.hook_event, name: message.hook_name, outcome, message: null };
  const said = reason ?? (message.stderr.trim() || message.output.trim());
  return { event: message.hook_event, name: message.hook_name, outcome, message: said.length === 0 ? null : said };
}

/**
 * The `informational` message that says a hook ended the turn, drawn in the
 * thread: without it a refused prompt leaves an empty turn. The command is
 * left out, the reason kept.
 */
export function hookEndPart(content: string): Extract<MessagePart, { type: 'hook' }> {
  const matched = ENDED_BY_HOOK.exec(content.trim());
  const event = matched?.[1] ?? 'Stop';
  const reason = (matched?.[2] ?? content).trim();
  return {
    type: 'hook',
    event,
    outcome: event === 'UserPromptSubmit' ? 'blocked' : 'stopped',
    message: reason.slice(0, MESSAGE_MAX),
  };
}

function decisionOf(stdout: string): { outcome: 'blocked' | 'stopped'; reason: string | null } | null {
  const text = stdout.trim();
  if (!text.startsWith('{')) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  const said = (value: unknown): string | null => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null);
  if (parsed['continue'] === false) return { outcome: 'stopped', reason: said(parsed['stopReason']) };
  if (parsed['decision'] === 'block') return { outcome: 'blocked', reason: said(parsed['reason']) };
  const specific = parsed['hookSpecificOutput'];
  if (typeof specific === 'object' && specific !== null) {
    const out = specific as Record<string, unknown>;
    if (out['permissionDecision'] === 'deny') return { outcome: 'blocked', reason: said(out['permissionDecisionReason']) };
    const decision = out['decision'];
    if (typeof decision === 'object' && decision !== null && (decision as Record<string, unknown>)['behavior'] === 'deny') {
      return { outcome: 'blocked', reason: said((decision as Record<string, unknown>)['message']) };
    }
  }
  return null;
}
