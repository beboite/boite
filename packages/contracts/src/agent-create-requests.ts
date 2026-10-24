import type { AgentProfile, AgentSelection } from './agents.ts';
import type { QuestionAnswer, QuestionOption, ThreadId } from './index.ts';
import { agentProjectIds, type AgentSettingChoice } from './agent-setting-requests.ts';
import { SETTING_REASON_MAX } from './setting-requests.ts';

/*
 * A thread asking the user to create a bot: a card with the name, the route
 * and the projects it would start with, asked without stopping. Creating a bot
 * is the owner's (`agents.profile.save`), so Apply is too
 * (`agents.settings.apply`, as for an agent setting card). The card settles
 * once a bot of that name exists, from Apply or from the Agents page, and the
 * thread reads the new bot's id in its answer.
 */

/** The bounds `agents.profile.save` puts on a bot's name, domain and instructions. */
export const AGENT_NAME_MAX = 100;
export const AGENT_DOMAIN_MAX = 500;
export const AGENT_INSTRUCTIONS_MAX = 32000;

/** What a bot creation card carries beside the question's text, which is the reason. */
export interface AgentCreateAsk {
  name: string;
  domain: string;
  instructions: string;
  /** The route it would run on: the asking thread's own unless the request named a model. */
  selection: AgentSelection;
  /** The projects it would be entrusted, ids sorted. */
  projectIds: string[];
}

/**
 * `model` as `boite delegate` reads it (`claude/claude-opus-5-5`, `opus`);
 * omitted, the asking thread's own route. `effort` omitted is the model's
 * default. `projects` are project names or ids.
 */
export interface AgentCreateRequestParams {
  threadId: ThreadId;
  name: string;
  domain?: string;
  instructions?: string;
  model?: string;
  effort?: string;
  projects?: string[];
  reason: string;
}

type Checked<T> = { ok: true; value: T } | { ok: false; message: string };

/** What the core or the in-memory client knows to check a proposed bot against. */
export interface AgentCreateContext {
  /** The bots not archived: a name is taken while one of them holds it. */
  bots: readonly Pick<AgentProfile, 'id' | 'name'>[];
  /** The projects a bot may be entrusted: not drafts. */
  projects: readonly AgentSettingChoice[];
  /** The route a model and a level name, as `boite delegate` resolves them. */
  route: (model: string | undefined, effort: string | undefined) => Checked<AgentSelection>;
}

export type AgentCreateRequestCheck =
  | { ok: true; reason: string; create: AgentCreateAsk; options: QuestionOption[] }
  | { ok: false; message: string; data: Record<string, unknown> };

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * `agents.settings.create` checked, by the core and the in-memory client alike.
 * `open` lists the creation cards already open on the thread: one per name.
 */
export function checkAgentCreateRequest(params: Omit<AgentCreateRequestParams, 'threadId'>, ctx: AgentCreateContext, open: readonly AgentCreateAsk[]): AgentCreateRequestCheck {
  const reason = typeof params.reason === 'string' ? params.reason.trim() : '';
  if (reason.length === 0 || reason.length > SETTING_REASON_MAX) return { ok: false, message: `reason must hold 1 to ${SETTING_REASON_MAX} characters`, data: { field: 'reason' } };
  const name = typeof params.name === 'string' ? params.name.trim() : '';
  if (name.length === 0 || name.length > AGENT_NAME_MAX) return { ok: false, message: `name must hold 1 to ${AGENT_NAME_MAX} characters`, data: { field: 'name' } };
  const taken = ctx.bots.find(bot => sameName(bot.name, name));
  if (taken !== undefined) return { ok: false, message: `a bot named ${JSON.stringify(taken.name)} already exists (${taken.id}); boite settings bot --bot ${JSON.stringify(taken.name)} reads its settings`, data: { field: 'name' } };
  if (open.some(card => sameName(card.name, name))) return { ok: false, message: `a card proposing a bot named ${JSON.stringify(name)} is already open in this thread`, data: { field: 'name' } };
  const text = (value: unknown, field: string, max: number): Checked<string> => {
    if (value === undefined) return { ok: true, value: '' };
    if (typeof value !== 'string' || value.length > max) return { ok: false, message: `${field}: expected text of at most ${max} characters` };
    return { ok: true, value: value.trim() };
  };
  const domain = text(params.domain, 'domain', AGENT_DOMAIN_MAX);
  if (!domain.ok) return { ok: false, message: domain.message, data: { field: 'domain' } };
  const instructions = text(params.instructions, 'instructions', AGENT_INSTRUCTIONS_MAX);
  if (!instructions.ok) return { ok: false, message: instructions.message, data: { field: 'instructions' } };
  const projectIds = agentProjectIds(params.projects ?? [], [], ctx.projects);
  if (!projectIds.ok) return { ok: false, message: projectIds.message, data: { field: 'projects' } };
  const optional = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  const route = ctx.route(optional(params.model), optional(params.effort));
  if (!route.ok) return { ok: false, message: route.message, data: { field: 'model' } };
  return {
    ok: true, reason, create: { name, domain: domain.value, instructions: instructions.value, selection: route.value, projectIds: projectIds.value },
    // Created is never an answer: the core says it once the bot exists.
    options: [{ id: 'refuse', label: 'Refuse' }],
  };
}

/**
 * The answer a card settles with once a bot of its name exists, its id as the
 * value, or null while none does.
 */
export function settledAgentCreate(create: AgentCreateAsk, bots: readonly Pick<AgentProfile, 'id' | 'name'>[]): QuestionAnswer | null {
  const bot = bots.find(entry => sameName(entry.name, create.name));
  return bot === undefined ? null : { optionIds: ['created'], value: bot.id };
}

/** What the asking thread reads once its card settles; `threadId` is the new bot's conversation, when known. */
export function agentCreateAnswerText(create: AgentCreateAsk, answer: QuestionAnswer, threadId: string | null = null): string {
  if (answer.optionIds[0] !== 'created') return `refused: no bot ${create.name} was created`;
  const name = JSON.stringify(create.name);
  return [
    `created: the bot ${create.name} (${String(answer.value)}) exists and introduces itself in its own conversation.`,
    ...(threadId === null ? [] : [`Its conversation is thread ${threadId}: boite threads send ${threadId} <text> writes to it.`]),
    `boite settings bot --bot ${name} reads its settings; boite settings bot request <key> <value> --bot ${name} --why <text> proposes a change.`,
  ].join('\n');
}
