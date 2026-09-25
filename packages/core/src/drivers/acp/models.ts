/**
 * What an agent says about its models, read off a `session/new` answer: the
 * protocol's `models` list, or the `model` and `thought_level` config options.
 */
import type { SessionConfigOption, SessionConfigOptionCategory } from '@agentclientprotocol/sdk';
import type { ModelInfo, ProviderDescriptor } from '@boite/contracts';
import { grokEffortOf } from '../grok.ts';
import { isGrok } from './protocol.ts';

/**
 * The model id a descriptor carries when it has no model list of its own
 * (OpenCode's shipped one does): the agent keeps whatever it is configured
 * with, so no `session/set_config_option` goes out and nothing is warned about.
 */
export const AGENT_OWN_MODEL = 'default';

/**
 * The model list a `session/new` may answer with, beside or instead of its
 * `configOptions`. It is the protocol's own shape, but the SDK's generated
 * `NewSessionResponse` does not carry it yet, so it is read off the raw answer
 * and every field is checked rather than trusted.
 */
interface AgentModel {
  modelId: string;
  name: string | null;
  meta: unknown;
}

export interface AgentModels {
  currentModelId: string | null;
  available: AgentModel[];
}

export function plainObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** `session/new`'s `models`, or null when the agent sent none Boite can read. */
export function agentModelsOf(created: unknown): AgentModels | null {
  const models = plainObject(plainObject(created)?.['models']);
  if (models === null) return null;
  const listed = models['availableModels'];
  if (!Array.isArray(listed)) return null;

  const available: AgentModel[] = [];
  for (const entry of listed) {
    const model = plainObject(entry);
    if (model === null) continue;
    const modelId = nonEmptyString(model['modelId']);
    if (modelId === null) continue;
    available.push({ modelId, name: nonEmptyString(model['name']), meta: model['_meta'] });
  }
  if (available.length === 0) return null;
  return { currentModelId: nonEmptyString(models['currentModelId']), available };
}

/** The values of a select option, groups flattened, in the order the agent listed them. */
function selectChoices(option: SessionConfigOption): { value: string; name: string }[] {
  if (option.type !== 'select') return [];
  const choices: { value: string; name: string }[] = [];
  for (const entry of option.options) {
    if ('group' in entry) choices.push(...entry.options.map((choice) => ({ value: choice.value, name: choice.name })));
    else choices.push({ value: entry.value, name: entry.name });
  }
  return choices;
}

export function selectValues(option: SessionConfigOption): string[] {
  return selectChoices(option).map((choice) => choice.value);
}

export function categoryOption(
  options: SessionConfigOption[] | null,
  category: SessionConfigOptionCategory,
): SessionConfigOption | null {
  if (options === null) return null;
  return options.find((entry) => entry.category === category && entry.type === 'select') ?? null;
}

/** `thought_level` is one scale for the whole session, so every model carries it. */
export function effortFrom(option: SessionConfigOption | null): ModelInfo['effort'] | null {
  if (option === null) return null;
  const choices = selectChoices(option);
  if (choices.length === 0) return null;
  const levels = choices.map((choice) => ({ id: choice.value, label: choice.name }));
  const current = option.type === 'select' ? String(option.currentValue) : '';
  const fallback = levels.some((level) => level.id === current) ? current : (levels[0]?.id ?? '');
  return { levels, default: fallback };
}

/**
 * What a `session/new` said about models, as a model list. An agent that
 * answers with the protocol's `models.availableModels` is read there, an agent
 * that answers with a `model` config option is read there, and one that answers
 * with neither leaves the descriptor's models standing.
 */
export function modelsFrom(
  provider: ProviderDescriptor,
  options: SessionConfigOption[] | null,
  listed: AgentModels | null,
): ModelInfo[] {
  if (listed !== null) return modelsFromList(provider, listed);
  return modelsFromConfig(provider, options);
}

/**
 * `models.availableModels` as a model list. The descriptor's `default` stays
 * first, without an effort scale: it means the agent keeps its own model, and
 * the effort of a model nobody named is nobody's to pick. Under the `grok`
 * quirk each model carries the scale out of its own `_meta`, which is the one
 * place a per-model scale is written in this protocol.
 */
function modelsFromList(provider: ProviderDescriptor, listed: AgentModels): ModelInfo[] {
  const grok = isGrok(provider);
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  const own = provider.models.find((model) => model.id === AGENT_OWN_MODEL);
  if (own !== undefined) {
    models.push({ id: AGENT_OWN_MODEL, name: own.name, default: false });
    seen.add(AGENT_OWN_MODEL);
  }
  for (const entry of listed.available) {
    if (seen.has(entry.modelId)) continue;
    seen.add(entry.modelId);
    const effort = grok ? grokEffortOf(entry.meta) : null;
    models.push({
      id: entry.modelId,
      name: entry.name ?? entry.modelId,
      default: entry.modelId === listed.currentModelId,
      ...(effort === null ? {} : { effort }),
    });
  }
  return models;
}

/**
 * The `configOptions` of a `session/new` as a model list. The descriptor's
 * `default` model stays first so the user can always hand the choice back to
 * the agent; the agent's own values follow in its order, the current one
 * flagged. No `model` option means the agent has nothing to say: the
 * descriptor's models stand.
 */
function modelsFromConfig(provider: ProviderDescriptor, options: SessionConfigOption[] | null): ModelInfo[] {
  const option = categoryOption(options, 'model');
  if (option === null) return provider.models;
  const effort = effortFrom(categoryOption(options, 'thought_level'));
  const current = option.type === 'select' ? String(option.currentValue) : '';
  const withEffort = (model: ModelInfo): ModelInfo => (effort === null || model.id !== current ? model : { ...model, effort });

  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  const own = provider.models.find((model) => model.id === AGENT_OWN_MODEL);
  if (own !== undefined) {
    models.push(withEffort({ id: AGENT_OWN_MODEL, name: own.name, default: false }));
    seen.add(AGENT_OWN_MODEL);
  }
  for (const choice of selectChoices(option)) {
    if (seen.has(choice.value)) continue;
    seen.add(choice.value);
    models.push(withEffort({ id: choice.value, name: choice.name, default: choice.value === current }));
  }
  return models;
}
