<script lang="ts">
  import { tick } from 'svelte';
  import type { Account } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { strings } from '../lib/strings';

  let { store, account }: { store: Store; account: Account } = $props();
  let editing = $state(false);
  let label = $state('');
  let saving = $state(false);
  let trigger = $state<HTMLButtonElement>();

  function focus(input: HTMLInputElement) { input.focus(); input.select(); }
  async function close() { editing = false; await tick(); trigger?.focus(); }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (saving || !label.trim()) return;
    saving = true;
    try { if (await store.renameAccount(account.id, label)) await close(); }
    finally { saving = false; }
  }
</script>

{#if editing}
  <form onsubmit={event => void save(event)}>
    <input use:focus aria-label={strings.providerSettings.accountName} data-testid="account-name" maxlength="100" bind:value={label} disabled={saving} onkeydown={event => {
      if (event.key === 'Escape' && !saving) { event.preventDefault(); event.stopPropagation(); void close(); }
    }} />
    <div class="actions">
      <button type="submit" class="small" data-testid="account-save" disabled={saving || !label.trim()}>{strings.providerSettings.save}</button>
      <button type="button" class="quiet small" data-testid="account-cancel" disabled={saving} onclick={() => void close()}>{strings.common.cancel}</button>
    </div>
  </form>
{:else}
  <button type="button" class="quiet small" bind:this={trigger} data-testid="account-rename" onclick={() => { label = account.label; editing = true; }}>{strings.providerSettings.rename}</button>
{/if}

<style>
  form { display: flex; flex-wrap: wrap; gap: 8px; padding-bottom: 8px; }
  input { flex: 1; min-width: 0; width: 100%; }
  .actions { display: flex; gap: 4px; }
</style>
