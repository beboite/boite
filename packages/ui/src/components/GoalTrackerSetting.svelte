<script lang="ts">
  import { ChevronDown } from '@lucide/svelte';
  import { defaultTrackerModel, providerEnabled, trackerEffort, type ModelInfo } from '@boite/contracts';
  import InfoTip from './InfoTip.svelte';
  import Menu from './Menu.svelte';
  import { separator, type MenuItem } from '../lib/menu';
  import { DEFAULT_MODEL_NAMES } from '../lib/model-defaults';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  /**
   * The model that keeps every `/goal2` checklist on this machine, and its
   * reasoning level. Automatic is Opus at medium or Sol at high; a pick names
   * any model a signed-in agent here lists. A small model is offered like any
   * other but never chosen by itself. Opening Settings starts no agent to ask.
   */
  let { store }: { store: Store } = $props();

  const AUTO = 'auto';
  const idOf = (providerId: string, model: string): string => JSON.stringify([providerId, model]);

  let chosen = $derived(store.settings?.goalTracker ?? null);
  /** Per provider that is on, here and signed in: what Automatic would take first, then the rest it lists. */
  let groups = $derived(
    store.providers.filter((provider) => providerEnabled(provider) && provider.available).flatMap((provider) => {
      const account = store.accountsOf(provider.id).find((entry) => entry.status === 'ok');
      if (!account) return [];
      const offered = store.modelsOf(provider.id, account.id).filter((model) => model.id !== 'default');
      const listed = offered.filter((model) => model.legacy !== true);
      const suggested = defaultTrackerModel(provider.protocol, offered)?.model ?? null;
      const named = (id: string): ModelInfo => offered.find((model) => model.id === id) ?? { id, name: DEFAULT_MODEL_NAMES[id] ?? id };
      const ids = [suggested, chosen?.providerId === provider.id ? chosen.model : null, ...listed.map((model) => model.id)];
      const models = [...new Set(ids.filter((id): id is string => id !== null))].map(named);
      return models.length ? [{ provider, suggested, models }] : [];
    })
  );
  let items = $derived<MenuItem[]>([
    { id: AUTO, label: strings.settings.goalTrackerAuto, hint: strings.settings.goalTrackerAutoHint, active: chosen === null },
    ...groups.flatMap(({ provider, suggested, models }) => [
      separator(`sep-${provider.id}`),
      ...models.map((model) => ({
        id: idOf(provider.id, model.id),
        label: model.name,
        hint: model.id === suggested ? `${provider.shortName} · ${strings.settings.goalTrackerAuto}` : provider.shortName,
        active: chosen?.providerId === provider.id && chosen.model === model.id
      }))
    ])
  ]);
  let model = $derived(chosen ? groups.find((group) => group.provider.id === chosen.providerId)?.models.find((entry) => entry.id === chosen.model) ?? null : null);
  let current = $derived(chosen === null ? strings.settings.goalTrackerAuto : (model?.name ?? chosen.model));
  let levels = $derived(model?.effort?.levels ?? []);
  let efforts = $derived<MenuItem[]>(levels.map((level) => ({ id: level.id, label: level.label, active: chosen?.effort === level.id })));
  let effort = $derived(levels.find((level) => level.id === chosen?.effort)?.label ?? chosen?.effort ?? strings.settings.goalTrackerEffortDefault);

  function pick(id: string) {
    if (id === AUTO) {
      void store.saveSettings({ goalTracker: null });
      return;
    }
    const [providerId, modelId] = JSON.parse(id) as [string, string];
    const picked = groups.find((group) => group.provider.id === providerId)?.models.find((entry) => entry.id === modelId);
    // A new model starts on the level Automatic would give its family, else its own default.
    void store.saveSettings({ goalTracker: { providerId, model: modelId, effort: picked ? trackerEffort(picked) : null } });
  }

  function pickEffort(id: string) {
    if (chosen) void store.saveSettings({ goalTracker: { ...chosen, effort: id } });
  }
</script>

<div class="switch-row" data-testid="goal-tracker">
  <span class="text ui-label-box">
    <span class="ui-label">{strings.settings.goalTrackerModel}</span><InfoTip topic={strings.settings.goalTrackerModel} text={strings.settings.goalTrackerModelHint} />
  </span>
  <span class="controls">
    <Menu {items} onpick={pick} label={strings.settings.goalTrackerModel} placement="bottom" align="end" testid="goal-tracker-model">
      <span class="current ui-label">{current}</span><ChevronDown size={13} />
    </Menu>
    {#if efforts.length > 0}
      <Menu items={efforts} onpick={pickEffort} label={strings.settings.goalTrackerEffort} placement="bottom" align="end" testid="goal-tracker-effort">
        <span class="current ui-label">{effort}</span><ChevronDown size={13} />
      </Menu>
    {/if}
  </span>
</div>

<style>
  .controls {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .current {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 22ch;
  }
</style>
