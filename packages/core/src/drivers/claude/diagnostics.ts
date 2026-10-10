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
      const ready = sessionStartedAt === null ? null : Date.now() - sessionStartedAt;
      note('info', `Claude Code ${String(system.claude_code_version ?? 'unknown')} ready${ready === null ? '' : ` in ${ready} ms`} with model ${String(system.model ?? 'unknown')}, permission mode ${String(system.permissionMode ?? 'unknown')}`, {
        event: 'driver.session.ready', ...(ready === null ? {} : { durationMs: ready }),
        data: { version: str(system.claude_code_version), model: str(system.model), permissionMode: str(system.permissionMode), tools: Array.isArray(system.tools) ? system.tools.length : null, mcpServers: Array.isArray(system.mcp_servers) ? system.mcp_servers.length : null, apiKeySource: str(system.apiKeySource) },
      });
    } else if (system.subtype === 'api_retry') {
      const status = typeof system.error_status === 'number' ? system.error_status : null;
      note('warn', `Claude API request failed (${status === null ? 'no HTTP response' : `HTTP ${status}`}, ${String(system.error)}); retry ${String(system.attempt)} of ${String(system.max_retries)} in ${String(system.retry_delay_ms)} ms`, {
        event: 'driver.api.retry',
        data: { status, error: str(system.error), attempt: num(system.attempt), maxRetries: num(system.max_retries), retryAfterMs: num(system.retry_delay_ms) },
      });
    } else if (system.subtype === 'model_refusal_fallback') {
      note('warn', `Claude fell back from ${String(system.original_model)} to ${String(system.fallback_model)} after a refusal (${String(system.direction)}, scope ${String(system.scope ?? 'session')})`, {
        event: 'driver.model.fallback', data: { from: str(system.original_model), to: str(system.fallback_model), direction: str(system.direction), scope: str(system.scope) ?? 'session' },
      });
    }
    return;
  }
  if (message.type === 'rate_limit_event') {
    const info = message.rate_limit_info;
    if (info.status === 'allowed') return;
    const resets = typeof info.resetsAt === 'number' ? new Date(info.resetsAt * (info.resetsAt < 1e12 ? 1000 : 1)).toISOString() : null;
    note(info.status === 'rejected' ? 'warn' : 'info', `Claude rate limit ${info.status === 'rejected' ? 'reached' : 'warning'}${info.rateLimitType ? ` on the ${info.rateLimitType} window` : ''}${typeof info.utilization === 'number' ? `, ${Math.round(info.utilization * 100)}% used` : ''}${resets ? `, resets ${resets}` : ''}`, {
      event: 'driver.rate-limit',
      data: { status: info.status, window: info.rateLimitType ?? null, utilization: info.utilization ?? null, resetsAt: resets, overage: info.overageStatus ?? null, overageDisabled: info.overageDisabledReason ?? null },
    });
    return;
  }
  if (message.type === 'assistant' && message.error !== undefined && message.parent_tool_use_id === null) {
    note('warn', `Claude answered with API error ${message.error}`, { event: 'driver.api.error', data: { error: message.error } });
    return;
  }
  if (message.type === 'result' && (message.subtype !== 'success' || message.is_error)) {
    note('warn', `Claude ended the turn with result ${message.subtype}${message.is_error ? ' marked as an error' : ''} after ${message.num_turns} model turns, ${message.duration_api_ms} ms of API time`, {
      event: 'driver.result.error', durationMs: message.duration_ms,
      data: { subtype: message.subtype, isError: message.is_error, numTurns: message.num_turns, apiMs: message.duration_api_ms, errors: message.subtype === 'success' ? 0 : message.errors.length, stopReason: message.stop_reason ?? null },
    });
  }
}

function str(value: unknown): string | null { return typeof value === 'string' ? value : null; }
function num(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
