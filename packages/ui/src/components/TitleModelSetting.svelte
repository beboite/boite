<script lang="ts">
  import { ChevronDown } from '@lucide/svelte';
  import { defaultTitleModel, providerEnabled, type ModelInfo, type TitleModel } from '@boite/contracts';
  import InfoTip from './InfoTip.svelte';
  import Menu from './Menu.svelte';
  import { separator, type MenuItem } from '../lib/menu';
  import { DEFAULT_MODEL_NAMES } from '../lib/model-defaults';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  /**
   * The model thread titles are written with. Automatic is each thread's own
   * agent on its small model; a pick sends every title to that one model. The
   * list is what each provider already offers here: opening Settings starts
   * no agent to ask.
   */
  let { store }: { store: Store } = $props();

  const AUTO = 'auto';
  const idOf = (choice: TitleModel): string => JSON.stringify([choice.providerId, choice.model]);

  let chosen = $derived(store.settings?.titleModel ?? null);
  /** A provider that writes titles, is turned on, is here and has an account signed in. */
  let writers = $derived(
    store.providers.filter((provider) => providerEnabled(provider)).flatMap((provider) => {
      const account = store.accountsOf(provider.id).find((entry) => entry.status === 'ok');
      return provider.titles === true && provider.available && account ? [{ provider, account }] : [];
    })
  );
  /** Per provider: its small default first, then the rest it lists, and the current pick even when unlisted. */
  let groups = $derived(
    writers.map(({ provider, account }) => {
      const offered = store.modelsOf(provider.id, account.id).filter((model) => model.id !== 'default');
      const listed = offered.filter((model) => model.legacy !== true);
      // The newest small model, even one the picker folds away as legacy.
      const small = defaultTitleModel(provider, offered);
      const named = (id: string): ModelInfo => offered.find((model) => model.id === id) ?? { id, name: DEFAULT_MODEL_NAMES[id] ?? id };
      const ids = [small, chosen?.providerId === provider.id ? chosen.model : null, ...listed.map((model) => model.id)];
      const models = [...new Set(ids.filter((id): id is string => id !== null))].map(named);
      return { provider, small, models };
    })
  );
  let items = $derived<MenuItem[]>([
    { id: AUTO, label: strings.settings.titleModelAuto, hint: strings.settings.titleModelAutoHint, active: chosen === null },
    ...groups.flatMap(({ provider, small, models }) => [
      separator(`sep-${provider.id}`),
      ...models.map((model) => ({
        id: idOf({ providerId: provider.id, model: model.id }),
        label: model.name,
        hint: model.id === small ? `${provider.shortName} · ${strings.settings.titleModelSmall}` : provider.shortName,
        active: chosen?.providerId === provider.id && chosen.model === model.id
      }))
    ])
  ]);
  let current = $derived(
    chosen === null
      ? strings.settings.titleModelAuto
      : (groups.find((group) => group.provider.id === chosen.providerId)?.models.find((model) => model.id === chosen.model)?.name ?? chosen.model)
  );

  function pick(id: string) {
    if (id === AUTO) {
      void store.saveSettings({ titleModel: null });
      return;
    }
    const [providerId, model] = JSON.parse(id) as [string, string];
    void store.saveSettings({ titleModel: { providerId, model } });
  }
</script>

<div class="switch-row">
  <span class="text ui-label-box">
    <span class="ui-label">{strings.settings.titleModel}</span><InfoTip topic={strings.settings.titleModel} text={strings.settings.titleModelHint} />
  </span>
  <Menu {items} onpick={pick} label={strings.settings.titleModel} placement="bottom" align="end" testid="setting-title-model">
    <span class="current ui-label">{current}</span><ChevronDown size={13} />
  </Menu>
</div>

<style>
  .current {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 22ch;
  }
</style>
