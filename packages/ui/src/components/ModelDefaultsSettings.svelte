<script lang="ts">
  import InfoTip from './InfoTip.svelte';
  import ModelPicker from './ModelPicker.svelte';
  import EffortSlider from './EffortSlider.svelte';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  let { store }: { store: Store } = $props();
  const rows = $derived(store.providers.filter((provider) => provider.id !== 'echo').flatMap((provider) => {
    const account = store.accountsOf(provider.id).find((entry) => entry.status === 'ok') ?? store.accountsOf(provider.id)[0];
    if (!account) return [];
    const model = store.defaultModelOf(provider, account.id);
    const info = store.modelsOf(provider.id, account.id).find((entry) => entry.id === model);
    return [{ provider, account, info, choice: { providerId: provider.id, accountId: account.id,
      model, effort: store.defaultEffortOf(provider.id, account.id, model), permissionMode: 'default' as const } }];
  }));
</script>

<section class="card" data-testid="model-defaults-settings">
  <h2>{strings.settings.modelDefaults}<InfoTip topic={strings.settings.modelDefaults} text={strings.settings.modelDefaultsHint} /></h2>
  {#each rows as row (row.provider.id)}
    <div class="default-row" data-default-provider={row.provider.id}>
      <span class="provider">{row.provider.name}</span>
      <div class="controls">
        <ModelPicker {store} choice={row.choice} locked onpick={(patch) => {
          if (patch.model) store.setModelDefault(row.provider.id, row.account.id, patch.model,
            store.defaultEffortOf(row.provider.id, row.account.id, patch.model));
        }} />
        {#if row.info?.effort?.levels.length}
          <EffortSlider levels={row.info.effort.levels} active={row.choice.effort}
            onpick={(effort) => row.choice.model && store.setModelDefault(row.provider.id, row.account.id, row.choice.model, effort)} />
        {:else if row.choice.effort}
          <span class="pending-effort">{row.choice.effort}</span>
        {/if}
      </div>
    </div>
  {/each}
</section>

<style>
  /* Rows like the switch rows of the other cards: a rule between them, the
     provider on the left, its model and effort on the right. */
  .default-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: var(--row); padding: 10px 0; flex-wrap: wrap; }
  .default-row + .default-row { border-top: 1px solid var(--color-border); }
  .default-row:last-child { padding-bottom: 0; }
  .provider { font-size: var(--text-base); font-weight: 500; }
  .controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .pending-effort { color: var(--color-muted-foreground); font-size: var(--text-sm); text-transform: capitalize; padding: 2px 8px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); }
</style>
