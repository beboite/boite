import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SessionContext } from '../types.ts';

type Diagnosable = Pick<SessionContext, 'diagnostic'>;

/**
 * What the Claude CLI says about itself that a developer needs and the
 * conversation does not show: the version and model it started with, each
 * API retry with its status and delay, rate limit changes, a model fallback,
 * an API error code and a failed result. Never message content.
 */
export function noteClaudeMessage(ctx: Diagnosable, message: SDKMessage, sessionStartedAt: number | null): void {
  const note = ctx.diagnostic;
  if (note === undefined) return;
  if (message.type === 'system') {
    const system = message as { subtype?: string } & Record<string, unknown>;
    if (system.subtype === 'init') {
      // The CLI sends init again after a flag change; only the first one after a spawn is its start.
      if (sessionStartedAt === null) {
        note('debug', `Claude Code sent init again, model ${String(system.model ?? 'unknown')}, permission mode ${String(system.permissionMode ?? 'unknown')}`, { event: 'driver.session.reinit', data: { model: str(system.model), permissionMode: str(system.permissionMode) } });
        return;
      }
      const ready = Date.now() - sessionStartedAt;
      note('info', `Claude Code ${String(system.claude_code_version ?? 'unknown')} ready in ${ready} ms with model ${String(system.model ?? 'unknown')}, permission mode ${String(system.permissionMode ?? 'unknown')}`, {
        event: 'driver.session.ready', durationMs: ready,
        data: { version: str(system.claude_code_version), model: str(system.model), permissionMode: str(system.permissionMode), tools: Array.isArray(system.tools) ? system.tools.length : null, mcpServers: Array.isArray(system.mcp_servers) ? system.mcp_servers.length : null, apiKeySource: str(system.apiKeySource) },
      });
    } else if (system.subtype === 'api_retry') {
      const status = typeof system.error_status === 'number' ? system.error_status : null;
      const data = { status, error: str(system.error), attempt: num(system.attempt), maxRetries: num(system.max_retries), retryAfterMs: num(system.retry_delay_ms) };
      note('warn', `Claude API request failed (${status === null ? 'no HTTP response' : `HTTP ${status}`}, ${data.error ?? 'no error text'}); retry ${data.attempt ?? '?'} of ${data.maxRetries ?? '?'} in ${data.retryAfterMs ?? '?'} ms`, { event: 'driver.api.retry', data });
    } else if (system.subtype === 'model_refusal_fallback') {
      const data = { from: str(system.original_model), to: str(system.fallback_model), direction: str(system.direction), scope: str(system.scope) ?? 'session' };
      note('warn', `Claude fell back from ${data.from ?? 'unknown'} to ${data.to ?? 'unknown'} after a refusal (${data.direction ?? 'unknown'}, scope ${data.scope})`, { event: 'driver.model.fallback', data });
    }
    return;
  }
  if (message.type === 'rate_limit_event') {
    // A shape the SDK types do not promise must not throw inside the receive loop.
    const info = message.rate_limit_info as typeof message.rate_limit_info | undefined | null;
    if (info === undefined || info === null || info.status === 'allowed') return;
    const resets = isoTime(info.resetsAt);
    const span = str(info.rateLimitType);
    const utilization = num(info.utilization);
    note(info.status === 'rejected' ? 'warn' : 'info', `Claude rate limit ${info.status === 'rejected' ? 'reached' : 'warning'}${span ? ` on the ${span} window` : ''}${utilization !== null ? `, ${Math.round(utilization * 100)}% used` : ''}${resets ? `, resets ${resets}` : ''}`, {
      event: 'driver.rate-limit',
      data: { status: str(info.status), window: span, utilization, resetsAt: resets, overage: str(info.overageStatus), overageDisabled: str(info.overageDisabledReason) },
    });
    return;
  }
  if (message.type === 'assistant' && message.error !== undefined && message.parent_tool_use_id === null) {
    const error = str(message.error) ?? 'of an unknown kind';
    note('warn', `Claude answered with API error ${error}`, { event: 'driver.api.error', data: { error } });
    return;
  }
  if (message.type === 'result' && (message.subtype !== 'success' || message.is_error)) {
    // A subtype the SDK types do not know yet may carry no list: this runs inside the receive loop.
    const errors = (message as { errors?: unknown }).errors;
    // Every field is the SDK's: one it reshapes logs as null, never as undefined or [object Object].
    const result = message as unknown as Record<string, unknown>;
    const subtype = str(result.subtype) ?? 'unknown';
    const isError = result.is_error === true;
    const numTurns = num(result.num_turns);
    const apiMs = num(result.duration_api_ms);
    const durationMs = num(result.duration_ms);
    note('warn', `Claude ended the turn with result ${subtype}${isError ? ' marked as an error' : ''} after ${numTurns ?? '?'} model turns, ${apiMs ?? '?'} ms of API time`, {
      event: 'driver.result.error', ...(durationMs === null ? {} : { durationMs }),
      data: { subtype, isError, numTurns, apiMs, errors: Array.isArray(errors) ? errors.length : 0, stopReason: str(result.stop_reason) },
    });
  }
}

/** A reset time in seconds or milliseconds as ISO text; null for anything a Date cannot hold, which would throw. */
export function isoTime(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const date = new Date(value * (value < 1e12 ? 1000 : 1));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function str(value: unknown): string | null { return typeof value === 'string' ? value : null; }
function num(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
