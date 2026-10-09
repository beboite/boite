/*
 * Work the companion hands to another agent (`[[task: project | instruction]]`):
 * which project the agent's words name, and what a new thread there runs on.
 * The thread takes what the main window's composer opens on for a new prompt
 * (`Models.defaultChoice`): the remembered agent and account, the default model
 * and effort set in Settings, the remembered permission mode. Pure, so it is
 * tested without a core.
 */
import { providerEnabled, subscriptionProxyOf, type Account, type ModelInfo, type PermissionMode, type Project, type ProviderSummary, type Settings } from '@boite/contracts';
import { fallbackModelDefault, INITIAL_MODEL_DEFAULTS, resolveModelDefault, type ModelDefaults } from '../model-defaults';
import type { ComposerPrefs } from '../prefs';

/** A project's name with case, accents, spaces and punctuation left out. */
export function folded(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** The projects a task may go to: the user's own, not the drafts nor the archived. */
export const taskProjects = (projects: Project[]): Project[] => projects.filter((project) => project.kind !== 'drafts' && !project.archived);

function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = row;
  }
  return previous[b.length]!;
}

/** A typo or two in a name, more in a long one. */
const tolerance = (length: number) => Math.min(3, Math.max(1, Math.floor(length / 4)));
/** A prefix or a part shorter than this names too many projects to count. */
const PART_MIN = 3;
const NEAR_MAX = 3;

export type Resolved = { project: Project } | { near: string[] };

/**
 * The project a name means: the same name with case and accents aside, else
 * the only one it begins or is part of, else the only closest one within a
 * typo or two. When none is sure, the names near it, none when nothing is.
 */
export function resolveProject(name: string, projects: Project[]): Resolved {
  const open = taskProjects(projects);
  const wanted = folded(name);
  const keyed = open.map((project) => ({ project, key: folded(project.name) }));
  const only = (matches: typeof keyed): Resolved | null => (matches.length === 1 ? { project: matches[0]!.project } : null);
  if (!wanted) return { near: [] };
  const exact = keyed.filter((entry) => entry.key === wanted);
  if (exact.length > 0) return { project: exact[0]!.project };
  const long = wanted.length >= PART_MIN;
  const sure =
    (long ? only(keyed.filter((entry) => entry.key.startsWith(wanted))) : null) ??
    (long ? only(keyed.filter((entry) => entry.key.includes(wanted))) : null);
  if (sure) return sure;
  const scored = keyed.map((entry) => ({ ...entry, score: distance(wanted, entry.key) })).sort((a, b) => a.score - b.score);
  const best = scored[0];
  if (best && best.score <= tolerance(wanted.length) && scored[1]?.score !== best.score) return { project: best.project };
  const near = scored.filter((entry) => entry.score <= tolerance(wanted.length) + 2 || entry.key.includes(wanted) || (long && wanted.includes(entry.key)));
  return { near: near.slice(0, NEAR_MAX).map((entry) => entry.project.name) };
}

/** What a new thread runs on. */
export interface ThreadChoice {
  providerId: string;
  accountId: string;
  model: string | null;
  effort: string | null;
  speed: string | null;
  permissionMode: PermissionMode;
}

/**
 * The accounts the composer offers for an agent: behind the subscription proxy,
 * the first local one, signed in through the gateway (`Accounts.accountsOf`).
 */
function accountsOf(provider: ProviderSummary, accounts: Account[], settings: Settings | null): Account[] {
  const own = accounts.filter((account) => account.providerId === provider.id);
  return own.length > 0 && subscriptionProxyOf(settings, provider) ? [{ ...own[0]!, status: 'ok' }] : own;
}

/** The models the composer knows before it asks the agent: none yet for the Claude SDK. */
const modelsOf = (provider: ProviderSummary): ModelInfo[] => (provider.protocol === 'claude-sdk' ? [] : provider.models);

function defaultModel(provider: ProviderSummary, defaults: ModelDefaults): string | null {
  return defaults[provider.id]?.model ?? INITIAL_MODEL_DEFAULTS[provider.id]?.model ?? resolveModelDefault(provider.id, modelsOf(provider), defaults)?.model ?? null;
}

function defaultEffort(provider: ProviderSummary, model: string | null, defaults: ModelDefaults): string | null {
  const offered = modelsOf(provider);
  const configured = defaults[provider.id] ?? INITIAL_MODEL_DEFAULTS[provider.id];
  if (configured?.model === model && (!offered.some((entry) => entry.id === model) || provider.protocol === 'claude-sdk')) return configured.effort;
  const preferred = configured && configured === defaults[provider.id] ? resolveModelDefault(provider.id, offered, defaults) : fallbackModelDefault(provider.id, offered);
  return preferred?.model === model ? preferred.effort : offered.find((entry) => entry.id === model)?.effort?.default ?? null;
}

/**
 * What the main window's composer opens a new prompt on (`Models.defaultChoice`):
 * the remembered agent when it is on and here, else the first agent on with an
 * account; the remembered account, else the first signed in. Null when no
 * agent has an account.
 */
export function newThreadChoice(providers: ProviderSummary[], accounts: Account[], settings: Settings | null, prefs: ComposerPrefs, defaults: ModelDefaults): ThreadChoice | null {
  const offered = providers.filter((provider) => providerEnabled(provider));
  const remembered = prefs.providerId ? offered.find((provider) => provider.id === prefs.providerId) : undefined;
  const has = (provider: ProviderSummary) => accountsOf(provider, accounts, settings).length > 0;
  const provider = (remembered?.available ? remembered : undefined) ?? offered.find((entry) => entry.available && has(entry)) ?? offered.find(has);
  if (!provider) return null;
  const own = accountsOf(provider, accounts, settings);
  const account = own.find((entry) => entry.id === prefs.accountId) ?? own.find((entry) => entry.status === 'ok') ?? own[0];
  if (!account) return null;
  const model = defaultModel(provider, defaults);
  const speeds = modelsOf(provider).find((entry) => entry.id === model)?.speeds;
  return {
    providerId: provider.id,
    accountId: account.id,
    model,
    effort: defaultEffort(provider, model, defaults),
    speed: speeds?.some((option) => option.id === prefs.speed) ? (prefs.speed ?? null) : null,
    permissionMode: prefs.permissionMode
  };
}
