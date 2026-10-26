import type { AgentProfile, AgentRuntimeConfig } from './agents.ts';
import type { QuestionAnswer, QuestionOption, RequestId, ThreadId } from './index.ts';
import { SETTING_REASON_MAX, sameSetting } from './setting-requests.ts';

/*
 * A thread, or a persistent agent about itself or another bot, asking the user
 * to change one of a bot's settings: rename it, rewrite its instructions,
 * pause it, entrust it a project, run it on another model, give it a daily
 * budget. The same flow as a settings card (setting-requests.ts): a card asked
 * without stopping, whose Apply is the owner's (`agents.settings.apply`). The
 * core settles the card once the value moves, from the card or from the
 * agent's own settings, and the outcome reaches the thread that asked as a
 * message, the way a `boite ask` answer does.
 */

/** The settings a card may propose, each drawn where the agent's settings show it. */
export const AGENT_SETTING_KEYS = ['name', 'domain', 'instructions', 'avatar', 'status', 'projects', 'model', 'effort', 'autoMemory', 'subagents', 'dailyBudget'] as const;
export type AgentSettingKey = (typeof AGENT_SETTING_KEYS)[number];

export function isAgentSettingKey(key: unknown): key is AgentSettingKey {
  return typeof key === 'string' && (AGENT_SETTING_KEYS as readonly string[]).includes(key);
}

/** The bounds `agents.profile.save` puts on a bot's name, domain, instructions and avatar. */
export const AGENT_NAME_MAX = 100;
export const AGENT_DOMAIN_MAX = 500;
export const AGENT_INSTRUCTIONS_MAX = 32000;
export const AGENT_AVATAR_MAX = 40;
export const AGENT_STATUSES = ['active', 'paused', 'archived'] as const;
/**
 * A robot as the Bots page stores it: `bot:<family>.<shape>.<color>.<eyes>.<top>.<mouth>.<cheeks>.<gear>`,
 * or the four parts a code had before parts were shared across families (ui/src/lib/robots.ts).
 */
const ROBOT_CODE = /^bot:[a-d](\.\d{1,2}){4}((\.\d{1,2}){3})?$/;

/** The most projects one agent holds, as `agents.profile.save` allows. */
export const AGENT_PROJECTS_MAX = 50;
/** The bounds `agents.runtime.configure` puts on `dailyBudgetUsd`, in API-equivalent dollars; null is no cap. */
export const AGENT_DAILY_BUDGET = { min: 0.01, max: 10_000 } as const;

/** What an agent setting card carries beside the question's text, which is the reason. */
export interface AgentSettingAsk {
  agentId: string;
  /** The agent's name when the card was asked: a thread has no agents snapshot to read it from. */
  agentName: string;
  key: AgentSettingKey;
  /** The proposed value: text, a status, project ids sorted, a model id, an effort or null, a boolean, dollars a day or null. */
  value: unknown;
  /** The value when the card was asked. It settles once the setting leaves it. */
  previous: unknown;
  /**
   * For `projects`, the names of the projects of other machines the card
   * names (`<core-id>/<project-id>` to `<machine>/<name>`), as the asking
   * core knew them: the client lists only its own machine's projects.
   */
  labels?: Record<string, string>;
}

/** One choice a setting offers, as `agents.settings.read` lists it. */
export interface AgentSettingChoice { id: string; label: string }

/** One agent setting with its value now and, for a pick, what it may become. */
export interface AgentSettingReading {
  key: AgentSettingKey;
  value: unknown;
  choices?: AgentSettingChoice[];
}

export interface AgentSettingsReading {
  agentId: string;
  agentName: string;
  settings: AgentSettingReading[];
}

/** `agent` names the agent by id or name; omitted, it is the agent whose conversation the thread is. */
export interface AgentSettingsReadParams { threadId: ThreadId; agent?: string }

/**
 * A change of one key. `projects` takes a list of project names or ids, which
 * replaces the agent's, or `{ add, remove }`, which edits it.
 */
export interface AgentSettingRequestParams { threadId: ThreadId; agent?: string; key: string; value: unknown; reason: string }

/** Apply a card, with `value` when the user changed the proposal on it (unticked a project). Owner only. */
export interface AgentSettingApplyParams { threadId: ThreadId; questionId: RequestId; value?: unknown }

type Checked<T> = { ok: true; value: T } | { ok: false; message: string };

/** What the core or the in-memory client knows to check a proposal against. */
export interface AgentSettingContext {
  profile: AgentProfile;
  config: AgentRuntimeConfig;
  /**
   * The projects an agent may be entrusted: not drafts. Those of the other
   * machines of the group come as `<core-id>/<project-id>`, labelled
   * `<machine>/<name>`.
   */
  projects: readonly AgentSettingChoice[];
  /** The bots not archived: a name is taken while another of them holds it. */
  bots: readonly Pick<AgentProfile, 'id' | 'name'>[];
  /** The model as `agents.profile.save` would keep it, the agent's policy included. */
  model: (model: string) => Checked<string>;
  effort: (effort: string | null) => Checked<string | null>;
}

/** The value a setting has now; projects sorted, so two lists compare by their ids. */
export function agentSettingValue(profile: AgentProfile, config: AgentRuntimeConfig, key: AgentSettingKey): unknown {
  switch (key) {
    case 'name':
    case 'domain':
    case 'instructions':
    case 'avatar':
    case 'status': return profile[key];
    case 'projects': return [...(profile.projectIds ?? [])].sort();
    case 'model': return profile.selection.model;
    case 'effort': return profile.selection.effort;
    case 'autoMemory': return config.autoMemory !== false;
    case 'subagents': return config.subagents.enabled;
    case 'dailyBudget': return config.dailyBudgetUsd ?? null;
  }
}

/** Project names or ids as ids, sorted: a list replaces `current`, `{ add, remove }` edits it. */
export function agentProjectIds(raw: unknown, current: readonly string[], projects: readonly AgentSettingChoice[]): Checked<string[]> {
  const resolve = (name: unknown): Checked<string> => {
    if (typeof name !== 'string' || name.trim().length === 0) return { ok: false, message: 'projects: expected project names or ids' };
    const wanted = name.trim();
    const byId = projects.find(p => p.id === wanted);
    if (byId !== undefined) return { ok: true, value: byId.id };
    const named = projects.filter(p => p.label.toLowerCase() === wanted.toLowerCase());
    if (named.length === 1) return { ok: true, value: named[0]!.id };
    if (named.length > 1) return { ok: false, message: `projects: ${named.length} projects are named ${JSON.stringify(wanted)}; name it by id: ${named.map(p => p.id).join(', ')}` };
    return { ok: false, message: `projects: no project ${JSON.stringify(wanted)}; the projects are ${projects.map(p => p.label).join(', ') || 'none yet'}` };
  };
  const all = (names: unknown): Checked<string[]> => {
    if (!Array.isArray(names)) return { ok: false, message: 'projects: expected a list of project names' };
    const out: string[] = [];
    for (const name of names) {
      const id = resolve(name);
      if (!id.ok) return id;
      out.push(id.value);
    }
    return { ok: true, value: out };
  };
  let next: string[];
  if (Array.isArray(raw)) {
    const listed = all(raw);
    if (!listed.ok) return listed;
    next = listed.value;
  } else if (raw !== null && typeof raw === 'object') {
    const { add = [], remove = [] } = raw as { add?: unknown; remove?: unknown };
    const added = all(add), removed = all(remove);
    if (!added.ok) return added;
    if (!removed.ok) return removed;
    next = [...current, ...added.value].filter(id => !removed.value.includes(id));
  } else {
    return { ok: false, message: 'projects: expected a list of project names, or { add, remove }' };
  }
  const unique = [...new Set(next)].sort();
  if (unique.length > AGENT_PROJECTS_MAX) return { ok: false, message: `projects: an agent holds at most ${AGENT_PROJECTS_MAX} projects` };
  return { ok: true, value: unique };
}

/** A bot's name, trimmed, unless another bot holds it. */
function agentName(raw: unknown, ctx: AgentSettingContext): Checked<string> {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name.length === 0 || name.length > AGENT_NAME_MAX) return { ok: false, message: `name: expected text of 1 to ${AGENT_NAME_MAX} characters` };
  const taken = ctx.bots.find(bot => bot.id !== ctx.profile.id && bot.name.trim().toLowerCase() === name.toLowerCase());
  return taken === undefined ? { ok: true, value: name } : { ok: false, message: `name: another bot is named ${JSON.stringify(taken.name)} (${taken.id})` };
}

function agentText(raw: unknown, key: 'domain' | 'instructions', max: number): Checked<string> {
  const value = typeof raw === 'string' ? raw.trim() : undefined;
  return value === undefined || value.length > max ? { ok: false, message: `${key}: expected text of at most ${max} characters` } : { ok: true, value };
}

/** Empty draws the robot its id picks; else a robot code, or one or two characters (an emoji, letters) the picture shows as text. */
function agentAvatar(raw: unknown): Checked<string> {
  const value = typeof raw === 'string' ? raw.trim() : undefined;
  const short = value !== undefined && value.length <= AGENT_AVATAR_MAX && [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].length <= 2;
  return value !== undefined && (short || ROBOT_CODE.test(value)) ? { ok: true, value } : { ok: false, message: 'avatar: expected one or two characters (an emoji, letters), a robot code such as bot:d.1.2.3.4.1.1.0, or "" for the robot its id draws' };
}

/** A proposed value as the agent's settings would store it, or why it cannot be. */
export function normalizeAgentSetting(key: AgentSettingKey, raw: unknown, ctx: AgentSettingContext): Checked<unknown> {
  switch (key) {
    case 'name': return agentName(raw, ctx);
    case 'domain': return agentText(raw, key, AGENT_DOMAIN_MAX);
    case 'instructions': return agentText(raw, key, AGENT_INSTRUCTIONS_MAX);
    case 'avatar': return agentAvatar(raw);
    case 'status':
      return typeof raw === 'string' && (AGENT_STATUSES as readonly string[]).includes(raw.trim()) ? { ok: true, value: raw.trim() } : { ok: false, message: `status: expected ${AGENT_STATUSES.join(', ')}` };
    case 'projects': return agentProjectIds(raw, ctx.profile.projectIds ?? [], ctx.projects);
    case 'model': return typeof raw === 'string' && raw.trim() ? ctx.model(raw.trim()) : { ok: false, message: 'model: expected a model id' };
    case 'effort': return raw === null || typeof raw === 'string' ? ctx.effort(raw === null ? null : raw.trim() || null) : { ok: false, message: 'effort: expected a reasoning level or null' };
    case 'autoMemory':
    case 'subagents': return typeof raw === 'boolean' ? { ok: true, value: raw } : { ok: false, message: `${key}: expected true or false` };
    case 'dailyBudget':
      return raw === null || (typeof raw === 'number' && Number.isFinite(raw) && raw >= AGENT_DAILY_BUDGET.min && raw <= AGENT_DAILY_BUDGET.max)
        ? { ok: true, value: raw === null ? null : Math.round(raw * 100) / 100 }
        : { ok: false, message: `dailyBudget: expected dollars a day from ${AGENT_DAILY_BUDGET.min} to ${AGENT_DAILY_BUDGET.max}, or null for no cap` };
  }
}

export type AgentSettingRequestCheck =
  | { ok: true; reason: string; setting: AgentSettingAsk; options: QuestionOption[] }
  | { ok: false; message: string; data: Record<string, unknown> };

/**
 * `agents.settings.request` checked, by the core and the in-memory client
 * alike. `open` lists the agent setting cards the thread already has open,
 * one per agent and key at most.
 */
export function checkAgentSettingRequest(params: Pick<AgentSettingRequestParams, 'key' | 'value' | 'reason'>, ctx: AgentSettingContext, open: readonly AgentSettingAsk[]): AgentSettingRequestCheck {
  const reason = typeof params.reason === 'string' ? params.reason.trim() : '';
  if (reason.length === 0 || reason.length > SETTING_REASON_MAX) return { ok: false, message: `reason must hold 1 to ${SETTING_REASON_MAX} characters`, data: { field: 'reason' } };
  if (!isAgentSettingKey(params.key)) return { ok: false, message: `${String(params.key)} is not an agent setting a card may change; the keys are ${AGENT_SETTING_KEYS.join(', ')}`, data: { field: 'key', expected: AGENT_SETTING_KEYS } };
  const key = params.key;
  if (params.value === undefined) return { ok: false, message: 'a change needs a value', data: { field: 'value' } };
  const normalized = normalizeAgentSetting(key, params.value, ctx);
  if (!normalized.ok) return { ok: false, message: normalized.message, data: { field: 'value', key } };
  const previous = agentSettingValue(ctx.profile, ctx.config, key);
  if (sameSetting(normalized.value, previous)) return { ok: false, message: `${ctx.profile.name}'s ${key} is already ${capped(JSON.stringify(previous))}`, data: { field: 'value', key } };
  if (open.some(card => card.agentId === ctx.profile.id && card.key === key)) return { ok: false, message: `a card asking about ${ctx.profile.name}'s ${key} is already open in this thread`, data: { field: 'key', key } };
  const remote = key === 'projects' ? [...new Set([...(normalized.value as string[]), ...(previous as string[])])].filter(id => id.includes('/')) : [];
  const labels = Object.fromEntries(remote.map(id => [id, ctx.projects.find(project => project.id === id)?.label ?? id]));
  return {
    ok: true, reason, setting: { agentId: ctx.profile.id, agentName: ctx.profile.name, key, value: normalized.value, previous, ...(remote.length ? { labels } : {}) },
    // Applied is never an answer: the core says it when the value moves.
    options: [{ id: 'refuse', label: 'Refuse' }],
  };
}

/**
 * The answer a card settles with once the agent's setting left the value it
 * was asked from, or null while it holds it. A removed or archived agent
 * closes it unanswered: `close`, unless the card asked to archive it.
 */
export function settledAgentSetting(setting: AgentSettingAsk, profile: AgentProfile | null, config: AgentRuntimeConfig | null): QuestionAnswer | 'close' | null {
  // A card asked about a key this core no longer has (`maxRunMinutes`) closes unanswered.
  if (profile === null || !isAgentSettingKey(setting.key)) return 'close';
  const archiving = setting.key === 'status' && setting.value === 'archived';
  if (!archiving && (config === null || profile.status === 'archived')) return 'close';
  const now = archiving ? profile.status : agentSettingValue(profile, config!, setting.key);
  if (sameSetting(now, setting.previous)) return null;
  return { optionIds: [sameSetting(now, setting.value) ? 'applied' : 'changed'], value: now };
}

/** The longest value a refusal or an outcome quotes: a bot's instructions run to thousands of characters. */
const SHOWN_MAX = 200;
const capped = (text: string) => (text.length > SHOWN_MAX ? `${text.slice(0, SHOWN_MAX - 1)}… (${text.length} characters)` : text);

/** What the asking thread reads once its card settles; `show` writes a value, project names included. */
export function agentSettingAnswerText(setting: AgentSettingAsk, answer: QuestionAnswer, write: (value: unknown) => string = value => JSON.stringify(value ?? null)): string {
  const show = (value: unknown) => capped(write(value));
  const what = `${setting.agentName}'s ${setting.key}`;
  const plural = setting.key === 'projects' || setting.key === 'instructions';
  const outcome = answer.optionIds[0];
  if (outcome === 'applied') return `applied: ${what} ${plural ? 'are' : 'is'} now ${show(answer.value)}`;
  if (outcome === 'changed') return `changed: the user set ${what} to ${show(answer.value)}, not ${show(setting.value)}`;
  return `refused: ${what} ${plural ? 'stay' : 'stays'} ${show(setting.previous)}`;
}
