<script lang="ts">
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
  <h2>{strings.settings.modelDefaults}</h2>
  <p class="hint">{strings.settings.modelDefaultsHint}</p>
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
  .card { display: flex; flex-direction: column; gap: 12px; padding: 18px; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface); box-shadow: var(--shadow-e1); }
  h2 { margin: 0; font-size: var(--text-base); font-weight: 600; }
  .hint { margin: 0; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .default-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: var(--row); flex-wrap: wrap; }
  .provider { font-size: var(--text-base); }
  .controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .pending-effort { color: var(--color-muted-foreground); font-size: var(--text-sm); text-transform: capitalize; padding: 2px 8px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); }
</style>
