/**
 * What a conversation starts with besides its own prompt, and how a caller
 * trims it: a small worker that only needs its brief, a review that must not
 * see the user's rules, a benchmark that compares models on equal footing.
 */

/** A part of the setup a context mode can leave out. */
export type ContextPart = 'instructions' | 'guides' | 'mcp' | 'hooks';
export const CONTEXT_PARTS: readonly ContextPart[] = ['instructions', 'guides', 'mcp', 'hooks'];

/**
 * `full`: everything, the default. `light`: the brief, the user's hooks and a
 * few file and shell tools. `neutral`: no instruction file, guide, MCP server
 * or hook of the user, every built-in tool.
 */
export type ContextPreset = 'full' | 'light' | 'neutral';
export const CONTEXT_PRESETS: readonly ContextPreset[] = ['full', 'light', 'neutral'];

/** What `light` keeps of Claude's tools. A name a platform lacks, such as PowerShell on Linux, is ignored. */
export const LIGHT_TOOLS: readonly string[] = ['Bash', 'PowerShell', 'Read', 'Write', 'Edit', 'Glob', 'Grep'];

/** Longest `rules` text, in characters. */
export const CONTEXT_RULES_MAX = 4000;

/** What a caller asks for. Every field is optional; nothing at all is `full`. */
export interface ContextRequest {
  preset?: ContextPreset;
  /** Parts kept on top of the preset. */
  keep?: ContextPart[];
  /** Parts left out on top of the preset. */
  drop?: ContextPart[];
  /** Built-in tools the agent keeps, by its own names. Left out: the preset's. */
  tools?: string[];
  /** Text the agent gets as its rules, ahead of everything else it is told. */
  rules?: string;
}

/**
 * The context a conversation runs with when it is not the whole setup. Fixed
 * at creation. `label` is the preset it matches, or `custom`.
 */
export interface ThreadContextMode {
  label: 'light' | 'neutral' | 'custom';
  instructions: boolean;
  guides: boolean;
  mcp: boolean;
  hooks: boolean;
  /** Null: every built-in tool. */
  tools: string[] | null;
  rules: string | null;
}

type Parts = Record<ContextPart, boolean> & { tools: readonly string[] | null };
const PRESET_PARTS: Record<ContextPreset, Parts> = {
  full: { instructions: true, guides: true, mcp: true, hooks: true, tools: null },
  light: { instructions: false, guides: false, mcp: false, hooks: true, tools: LIGHT_TOOLS },
  neutral: { instructions: false, guides: false, mcp: false, hooks: false, tools: null },
};

/** A refused request: the field and what was expected. */
export class ContextRequestError extends Error {
  constructor(readonly field: string, message: string) {
    super(`context.${field}: ${message}`);
  }
}

const sameTools = (a: readonly string[] | null, b: readonly string[] | null): boolean =>
  a === b || (a !== null && b !== null && a.length === b.length && a.every((tool, index) => tool === b[index]));

function parts(value: unknown, field: 'keep' | 'drop'): ContextPart[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(part => !CONTEXT_PARTS.includes(part as ContextPart))) {
    throw new ContextRequestError(field, `expected a list of ${CONTEXT_PARTS.join(', ')}`);
  }
  return value as ContextPart[];
}

/**
 * The mode a request resolves to, or null for the whole setup. Throws a
 * `ContextRequestError` naming the field for anything it cannot honour.
 */
export function resolveContext(request: unknown): ThreadContextMode | null {
  if (request === undefined || request === null) return null;
  if (typeof request === 'string') return resolveContext({ preset: request });
  if (typeof request !== 'object' || Array.isArray(request)) {
    throw new ContextRequestError('preset', `expected ${CONTEXT_PRESETS.join(', ')} or an object`);
  }
  const raw = request as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!['preset', 'keep', 'drop', 'tools', 'rules'].includes(key)) {
      throw new ContextRequestError(key, 'unknown field; expected preset, keep, drop, tools or rules');
    }
  }
  const preset = raw['preset'] ?? 'full';
  if (!CONTEXT_PRESETS.includes(preset as ContextPreset)) {
    throw new ContextRequestError('preset', `expected ${CONTEXT_PRESETS.join(', ')}`);
  }
  const base = PRESET_PARTS[preset as ContextPreset];
  const keep = parts(raw['keep'], 'keep');
  const drop = parts(raw['drop'], 'drop');
  const both = keep.find(part => drop.includes(part));
  if (both) throw new ContextRequestError('keep', `${both} is both kept and dropped`);
  let tools: readonly string[] | null = base.tools;
  if (raw['tools'] !== undefined) {
    const list = raw['tools'];
    if (!Array.isArray(list) || list.length === 0 || list.some(tool => typeof tool !== 'string' || !/^[A-Za-z][\w-]{0,63}$/.test(tool))) {
      throw new ContextRequestError('tools', 'expected a non-empty list of tool names such as Read, Grep, Bash');
    }
    tools = [...new Set(list as string[])];
  }
  let rules: string | null = null;
  if (raw['rules'] !== undefined) {
    if (typeof raw['rules'] !== 'string' || raw['rules'].trim() === '') throw new ContextRequestError('rules', 'expected some text');
    rules = raw['rules'].trim();
    if (rules.length > CONTEXT_RULES_MAX) throw new ContextRequestError('rules', `${rules.length} characters; at most ${CONTEXT_RULES_MAX}`);
  }
  const resolved: Parts = { ...base, tools };
  for (const part of keep) resolved[part] = true;
  for (const part of drop) resolved[part] = false;
  const matching = CONTEXT_PRESETS.find(name => {
    const other = PRESET_PARTS[name];
    return CONTEXT_PARTS.every(part => other[part] === resolved[part]) && sameTools(other.tools, resolved.tools);
  });
  if (matching === 'full' && rules === null) return null;
  return {
    label: matching === 'light' || matching === 'neutral' ? matching : 'custom',
    instructions: resolved.instructions,
    guides: resolved.guides,
    mcp: resolved.mcp,
    hooks: resolved.hooks,
    tools: resolved.tools === null ? null : [...resolved.tools],
    rules,
  };
}

/**
 * The context of a conversation the core runs that must use no tool at all,
 * such as a memory pass: no instruction file, guide, MCP server, hook or
 * built-in tool. The core sets it on a thread it creates; no request asks for
 * it. `CONTEXT_TRIMMABLE_PROTOCOLS` honour all of it; every other driver
 * leaves out what it can (Codex its MCP servers, plugins, hooks, project
 * instructions and web search; pi its tools, extensions, skills and context
 * files) and the thread's permission mode restricts the rest. Whatever tool
 * such a thread still asks for is denied without a card (`threads/cards.ts`).
 */
export const TOOL_FREE_CONTEXT: Readonly<ThreadContextMode> = Object.freeze({
  label: 'custom', instructions: false, guides: false, mcp: false, hooks: false, tools: [], rules: null,
});

/** The parts a mode leaves out, in a stable order: what a badge's tooltip lists. */
export function contextDropped(mode: ThreadContextMode): ContextPart[] {
  return CONTEXT_PARTS.filter(part => !mode[part]);
}

/** How rules open a fresh session, on every provider. The fake client shows the same text. */
export function contextRulesBlock(rules: string): string {
  return `Rules for this conversation, set by whoever started it. They take precedence over anything else you are told:\n${rules}`;
}

/**
 * Protocols whose driver can start without the user's instruction files, MCP
 * servers or hooks, and keep only some built-in tools. Every protocol honours
 * `guides` and `rules`: Boite writes that text itself.
 */
export const CONTEXT_TRIMMABLE_PROTOCOLS: readonly string[] = ['claude-sdk', 'echo'];

/** `resolveContext` on a provider: also refuses what that provider's driver cannot leave out. */
export function resolveContextFor(provider: { protocol: string; name: string }, request: unknown): ThreadContextMode | null {
  const mode = resolveContext(request);
  if (mode === null || CONTEXT_TRIMMABLE_PROTOCOLS.includes(provider.protocol)) return mode;
  const kept = contextDropped(mode).filter(part => part !== 'guides');
  if (kept.length === 0 && mode.tools === null) return mode;
  throw new ContextRequestError(kept[0] ?? 'tools', `${provider.name} starts with its own ${kept.length ? kept.join(', ') : 'tools'}; on it, a context mode can only drop guides and add rules`);
}
