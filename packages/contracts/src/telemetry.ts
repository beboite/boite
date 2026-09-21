/** Closed public vocabulary, shared by the host and the untrusted-input relay. */
const MODELS = new Set([
  'gpt-6-astra', 'gpt-6-sol', 'gpt-6-terra', 'gpt-6-luna',
  'gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5',
  'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.3-codex-spark',
  'gpt-5.2', 'gpt-5.2-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini',
  'gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-4.1', 'gpt-4o', 'o3', 'o4-mini',
  'claude-fable-5-1', 'claude-fable-5', 'claude-opus-5', 'claude-sonnet-5',
  'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-5', 'claude-sonnet-4-5',
  'claude-haiku-4-5', 'claude-opus-4-1', 'claude-sonnet-4', 'claude-opus-4',
  'gemini-3.1-pro', 'gemini-3-pro', 'gemini-3-flash', 'gemini-2.5-pro', 'gemini-2.5-flash',
  'grok-4', 'grok-4-fast', 'grok-code-fast-1', 'deepseek-chat', 'deepseek-reasoner',
]);

/** Unknown aliases, local filenames, endpoints and fine-tuned IDs never leave the host. */
export function publicModel(value: unknown): string {
  if (value === null || value === undefined || value === '' || value === 'default') return 'default';
  if (typeof value !== 'string') return 'other';
  const name = value.toLowerCase().replace(/^(openai|anthropic|google|x-ai|deepseek)\//, '').replace(/-\d{8}$/, '').replace(/\[1m\]$/, '');
  return MODELS.has(name) ? name : 'other';
}

function choice(value: unknown, values: readonly string[]): string {
  return typeof value === 'string' && values.includes(value) ? value : 'other';
}

export interface EnhancedDetails {
  model?: string; effort?: string; speed?: string; permission_mode?: string;
  operation?: string; queue_ms?: number;
  input_tokens?: number; output_tokens?: number; cache_read_tokens?: number; cache_write_tokens?: number;
}

/** Called only for enhanced turn events, never for basic counters. No free-text output. */
export function enhancedDetails(fields: Record<string, unknown>): EnhancedDetails {
  const result: EnhancedDetails = {
    model: publicModel(fields.model),
    effort: fields.effort == null ? 'default' : choice(fields.effort, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultrathink']),
    speed: fields.speed == null ? 'default' : choice(fields.speed, ['standard', 'fast']),
    permission_mode: choice(fields.permission_mode, ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk']),
    operation: choice(fields.operation, ['prompt', 'compact']),
  };
  if (typeof fields.queue_ms === 'number' && Number.isFinite(fields.queue_ms) && fields.queue_ms >= 0) result.queue_ms = Math.min(604800000, Math.round(fields.queue_ms));
  for (const key of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'] as const) {
    const value = fields[key];
    // Rounded to 100 tokens; missing usage stays missing rather than reporting zero.
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) result[key] = Math.min(10000000, Math.round(value / 100) * 100);
  }
  return result;
}
