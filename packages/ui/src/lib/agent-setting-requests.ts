/**
 * What an agent setting card says: the setting's name and its value as a
 * person reads it, project names and model names included. The card is
 * `components/AgentSettingCard.svelte`; the checks it shares with the core are
 * in `packages/contracts/src/agent-setting-requests.ts`.
 */
import type { AgentSettingAsk, AgentSettingKey, ProviderSummary } from '@boite/contracts';
import { fill, strings } from './strings';

/** What the card reads names from: the owning machine's projects and providers. */
export interface AgentSettingNames {
  projects: readonly { id: string; name: string }[];
  providers: readonly ProviderSummary[];
}

export function agentSettingLabel(key: AgentSettingKey): string {
  return strings.agentSettingRequest.keys[key] ?? key;
}

export function projectName(id: string, names: AgentSettingNames): string {
  return names.projects.find((project) => project.id === id)?.name ?? id;
}

/** `On`, `30 min`, `Claude Opus 5.5`, `High`, `boite, notes`. */
export function agentSettingValueText(key: AgentSettingKey, value: unknown, names: AgentSettingNames): string {
  const words = strings.agentSettingRequest;
  if (key === 'projects') {
    const ids = Array.isArray(value) ? value.map(String) : [];
    return ids.length === 0 ? words.noProjects : ids.map((id) => projectName(id, names)).join(', ');
  }
  if (key === 'effort' && (value === null || value === undefined)) return words.defaultEffort;
  if (value === null || value === undefined) return words.none;
  if (typeof value === 'boolean') return value ? words.on : words.off;
  if (key === 'maxRunMinutes' && typeof value === 'number') return fill(words.minutes, { count: String(value) });
  if (key === 'model' && typeof value === 'string') {
    for (const provider of names.providers) {
      const model = provider.models.find((entry) => entry.id === value);
      if (model) return model.name;
    }
    return value;
  }
  if (key === 'effort' && typeof value === 'string') {
    for (const provider of names.providers) {
      for (const model of provider.models) {
        const level = model.effort?.levels.find((entry) => entry.id === value);
        if (level) return level.label;
      }
    }
    return value;
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** The projects a `projects` card adds and removes, each in the order the proposal lists them. */
export function projectsDelta(setting: Pick<AgentSettingAsk, 'value' | 'previous'>): { added: string[]; removed: string[] } {
  const before = Array.isArray(setting.previous) ? setting.previous.map(String) : [];
  const after = Array.isArray(setting.value) ? setting.value.map(String) : [];
  return { added: after.filter((id) => !before.includes(id)), removed: before.filter((id) => !after.includes(id)) };
}

/**
 * The projects list Apply sends once the user unticked some rows: an unticked
 * addition stays out, an unticked removal stays in. Sorted, as the core keeps it.
 */
export function editedProjects(setting: Pick<AgentSettingAsk, 'value' | 'previous'>, unticked: ReadonlySet<string>): string[] {
  const before = Array.isArray(setting.previous) ? setting.previous.map(String) : [];
  const { added, removed } = projectsDelta(setting);
  const kept = before.filter((id) => !removed.includes(id) || unticked.has(id));
  return [...new Set([...kept, ...added.filter((id) => !unticked.has(id))])].sort();
}
