/**
 * Closed public vocabulary, shared by the host and the untrusted-input relay.
 * Families instead of a frozen list, so a new release of a known family is
 * counted without a Boite update. Every suffix comes from a fixed word list:
 * custom aliases, paths, endpoints and fine-tuned IDs cannot match.
 */
const MODEL_FAMILIES = [
  /^claude-(opus|sonnet|haiku|fable)-\d+(-\d+)?$/,
  /^claude-\d+(-\d+)?-(opus|sonnet|haiku)$/,
  /^(opus|sonnet|haiku|fable|opusplan)$/,
  /^gpt-\d+(\.\d+)?(-(mini|nano|pro|codex|max|spark|sol|terra|luna|astra|chat|latest))*$/,
  /^o\d(-(mini|pro))?$/,
  /^gemini-\d+(\.\d+)?-(pro|flash|flash-lite)(-preview)?$/,
  /^grok-code-fast-\d+$/,
  /^grok-\d+(\.\d+)?(-(fast|mini|heavy|code|reasoning))*$/,
  /^deepseek-(chat|reasoner|v\d+(\.\d+)?)$/,
  /^glm-\d+(\.\d+)?$/,
  /^kimi-k\d+(\.\d+)?$/,
];

/**
 * Reduces a selected model to its public name, or `other`. Boite stores
 * selections as `<provider>/<model>` and OpenCode as `<provider>/<vendor>/<model>`:
 * only the last segment is ever considered, so a prefix never leaves the host.
 */
export function publicModel(value: unknown): string {
  if (value === null || value === undefined || value === '' || value === 'default') return 'default';
  if (typeof value !== 'string') return 'other';
  // Antigravity puts the effort in the model ID (`gemini-3.8-flash-high`,
  // `claude-opus-4-6-thinking`); the effort is reported on its own field.
  const name = value.toLowerCase().split('/').at(-1)!.replace(/\[1m\]$/, '').replace(/-\d{8}$/, '').replace(/-(minimal|low|medium|high|thinking)$/, '');
  return name.length <= 40 && MODEL_FAMILIES.some((family) => family.test(name)) ? name : 'other';
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
    effort: fields.effort == null ? 'default' : choice(fields.effort, ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultrathink']),
    speed: fields.speed == null ? 'default' : choice(fields.speed, ['default', 'standard', 'fast']),
    permission_mode: choice(fields.permission_mode ?? 'default', ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'yolo', 'dontAsk']),
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

/** A delegated call carries only its public selection, never task or thread data. */
export function subagentDetails(fields: Record<string, unknown>): Pick<EnhancedDetails, 'model' | 'effort' | 'speed'> {
  const { model, effort, speed } = enhancedDetails(fields);
  return { model, effort, speed };
}

/**
 * The host's OS release as the OS itself names it ("Windows 11 Pro 26200",
 * "macOS 15.1", "ubuntu 24.04"). The host builds it from fixed system fields;
 * the relay only bounds its shape, so a modified client cannot smuggle a path,
 * an address or a long string through it.
 */
export function publicOsVersion(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return typeof value === 'string' && /^[A-Za-z][\w .+()-]{0,47}$/.test(value) ? value : 'other';
}
