import type { AgentProfile, AgentSelection } from './agents.ts';
import type { ThreadId } from './index.ts';
import { AGENT_DOMAIN_MAX, AGENT_INSTRUCTIONS_MAX, AGENT_NAME_MAX, agentProjectIds, type AgentSettingChoice } from './agent-setting-requests.ts';

/*
 * A thread creating a bot the user asked for (`agents.create`): it checks the
 * name, the route and the projects, then makes the bot as the Bots page does,
 * with no card in between. Changing a bot afterwards stays the owner's
 * (`agents.settings.request` draws a card).
 */

/** A bot as `agents.create` will save it. */
export interface AgentCreation {
  name: string;
  domain: string;
  instructions: string;
  /** The route it runs on: the calling thread's own unless the call named a model. */
  selection: AgentSelection;
  /** The projects it is entrusted, ids sorted. */
  projectIds: string[];
}

/**
 * `model` as `boite delegate` reads it (`claude/claude-opus-5-5`, `opus`);
 * omitted, the calling thread's own route. `effort` omitted is the model's
 * default. `projects` are project names or ids.
 */
export interface AgentCreateParams {
  threadId: ThreadId;
  name: string;
  domain?: string;
  instructions?: string;
  model?: string;
  effort?: string;
  projects?: string[];
}

/** The bot made, and its own conversation once it has one: `boite threads send` writes to it. */
export interface AgentCreateResult {
  agent: AgentProfile;
  threadId: ThreadId | null;
}

type Checked<T> = { ok: true; value: T } | { ok: false; message: string };

/** What the core or the in-memory client knows to check a new bot against. */
export interface AgentCreateContext {
  /** The bots not archived: a name is taken while one of them holds it. */
  bots: readonly Pick<AgentProfile, 'id' | 'name'>[];
  /** The projects a bot may be entrusted: not drafts. */
  projects: readonly AgentSettingChoice[];
  /** The route a model and a level name, as `boite delegate` resolves them. */
  route: (model: string | undefined, effort: string | undefined) => Checked<AgentSelection>;
}

export type AgentCreateCheck =
  | { ok: true; value: AgentCreation }
  | { ok: false; message: string; data: Record<string, unknown> };

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** `agents.create` checked, by the core and the in-memory client alike. */
export function checkAgentCreate(params: Omit<AgentCreateParams, 'threadId'>, ctx: AgentCreateContext): AgentCreateCheck {
  const name = typeof params.name === 'string' ? params.name.trim() : '';
  if (name.length === 0 || name.length > AGENT_NAME_MAX) return { ok: false, message: `name must hold 1 to ${AGENT_NAME_MAX} characters`, data: { field: 'name' } };
  const taken = ctx.bots.find(bot => sameName(bot.name, name));
  if (taken !== undefined) return { ok: false, message: `a bot named ${JSON.stringify(taken.name)} already exists (${taken.id}); boite settings bot --bot ${JSON.stringify(taken.name)} reads its settings`, data: { field: 'name' } };
  const text = (value: unknown, field: string, max: number): Checked<string> => {
    if (value === undefined) return { ok: true, value: '' };
    const trimmed = typeof value === 'string' ? value.trim() : undefined;
    if (trimmed === undefined || trimmed.length > max) return { ok: false, message: `${field}: expected text of at most ${max} characters` };
    return { ok: true, value: trimmed };
  };
  const domain = text(params.domain, 'domain', AGENT_DOMAIN_MAX);
  if (!domain.ok) return { ok: false, message: domain.message, data: { field: 'domain' } };
  const instructions = text(params.instructions, 'instructions', AGENT_INSTRUCTIONS_MAX);
  if (!instructions.ok) return { ok: false, message: instructions.message, data: { field: 'instructions' } };
  const projectIds = agentProjectIds(params.projects ?? [], [], ctx.projects);
  if (!projectIds.ok) return { ok: false, message: projectIds.message, data: { field: 'projects' } };
  // Omitted or blank picks the default; anything but text is refused, not read as omitted.
  for (const field of ['model', 'effort'] as const) {
    if (params[field] !== undefined && typeof params[field] !== 'string') return { ok: false, message: `${field}: expected a ${field} name`, data: { field } };
  }
  const optional = (value: string | undefined) => value?.trim() || undefined;
  const route = ctx.route(optional(params.model), optional(params.effort));
  if (!route.ok) return { ok: false, message: route.message, data: { field: 'model' } };
  return { ok: true, value: { name, domain: domain.value, instructions: instructions.value, selection: route.value, projectIds: projectIds.value } };
}
