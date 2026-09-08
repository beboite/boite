/**
 * Grok CLI's dialect of ACP. Two things need fixing and no more:
 *
 * - The reasoning effort of a model. `session/new` answers with the protocol's
 *   own `models.availableModels`, which the ACP driver reads for every agent
 *   that sends it; what is Grok's alone sits in each model's `_meta`.
 *   `reasoningEfforts` is that model's own ordered scale (`xhigh, high, medium,
 *   low` on Grok 4.6, three levels on Grok 4.5) with the agent's pick flagged
 *   `default: true`, and `reasoningEffort` repeats that pick as a plain string.
 *   The pair goes back as one `session/set_model { sessionId, modelId, _meta: {
 *   reasoningEffort } }`, never as a `session/set_config_option`: Grok answers
 *   that method with method-not-found.
 * - The permission mode. Grok advertises no `availableModes`, so
 *   `session/set_mode` has nothing to match and the mode goes on the command
 *   line instead, which is also where T3 Code puts it. `--permission-mode` is a
 *   global option and belongs before the `agent` subcommand, `--always-approve`
 *   is an option of `agent` and belongs after it. A mode is therefore fixed for
 *   the life of the process, like Codex's approval pair, so it joins the
 *   session key and changing it drops the process.
 */
import type { EffortLevel, ModelInfo, PermissionMode } from '@boite/contracts';

/** What the CLI takes as `--permission-mode`; every other Boite mode has its own flag. */
const PERMISSION_MODE_FLAG: Partial<Record<PermissionMode, string>> = {
  default: 'default',
  acceptEdits: 'acceptEdits',
  plan: 'plan',
};

/** Grok's own subcommand, the argument the mode options are placed around. */
const AGENT_SUBCOMMAND = 'agent';

/**
 * The descriptor's launch line with the thread's permission mode spliced in.
 * `--permission-mode <mode>` goes before `agent` because the CLI takes it as a
 * global option; `bypassPermissions` and `dontAsk` become `--always-approve`,
 * which is an option of `agent` and goes after it. Anything the descriptor put
 * before the subcommand stays where it is, which is what lets a test point the
 * same line at a fixture. A line naming no `agent` subcommand is left alone.
 */
export function grokLaunchArgs(declared: readonly string[], mode: PermissionMode): string[] {
  const at = declared.indexOf(AGENT_SUBCOMMAND);
  if (at < 0) return [...declared];
  const before = declared.slice(0, at);
  const after = declared.slice(at + 1);
  const flag = PERMISSION_MODE_FLAG[mode];
  if (flag !== undefined) return [...before, '--permission-mode', flag, AGENT_SUBCOMMAND, ...after];
  return [...before, AGENT_SUBCOMMAND, '--always-approve', ...after];
}

/** One entry of a model's `_meta.reasoningEfforts`, as Grok 1.0.13 writes it. */
interface GrokEffort {
  id?: unknown;
  label?: unknown;
  description?: unknown;
  default?: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The effort a model is on right now, out of its `_meta.reasoningEffort`. It is
 * what a `session/set_model` is compared against: a session already on the
 * wanted model and the wanted effort needs no call.
 */
export function grokReasoningEffortOf(meta: unknown): string | null {
  return isPlainObject(meta) ? stringOf(meta['reasoningEffort']) : null;
}

/**
 * A model's effort scale out of its `_meta`, or null when the agent offers
 * none. The levels keep the agent's order; the default is the entry flagged
 * `default: true`, then `_meta.reasoningEffort` when it names a level, then the
 * first level, so the picker always has one to show.
 */
export function grokEffortOf(meta: unknown): ModelInfo['effort'] | null {
  if (!isPlainObject(meta)) return null;
  const listed = meta['reasoningEfforts'];
  if (!Array.isArray(listed)) return null;

  const levels: EffortLevel[] = [];
  let flagged: string | null = null;
  for (const entry of listed as GrokEffort[]) {
    if (!isPlainObject(entry)) continue;
    const id = stringOf(entry.id);
    if (id === null || levels.some((level) => level.id === id)) continue;
    const description = stringOf(entry.description);
    levels.push({
      id,
      label: stringOf(entry.label) ?? id,
      ...(description === null ? {} : { description }),
    });
    if (entry.default === true && flagged === null) flagged = id;
  }
  if (levels.length === 0) return null;

  const current = stringOf(meta['reasoningEffort']);
  const fallback = current !== null && levels.some((level) => level.id === current) ? current : (levels[0] as EffortLevel).id;
  return { levels, default: flagged ?? fallback };
}
