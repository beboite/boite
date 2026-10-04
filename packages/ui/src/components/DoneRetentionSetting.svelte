<script lang="ts">
  import { untrack } from 'svelte';
  import { DEFAULT_THREAD_DONE_RETENTION_DAYS } from '@boite/contracts';
  import InfoTip from './InfoTip.svelte';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  let { store }: { store: Store } = $props();
  const uid = $props.id();
  let days = $state<number | undefined>(DEFAULT_THREAD_DONE_RETENTION_DAYS);
  let dirty = $state(false);
  let saving = $state(false);
  const valid = $derived(typeof days === 'number' && Number.isInteger(days) && days >= 0 && days <= 3650);
  $effect(() => {
    const saved = store.settings?.threadDoneRetentionDays ?? DEFAULT_THREAD_DONE_RETENTION_DAYS;
    untrack(() => { if (!dirty) days = saved; });
  });

  async function save(): Promise<void> {
    if (!valid || saving) return;
    const submitted = days!;
    saving = true;
    try {
      if (await store.saveSettings({ threadDoneRetentionDays: submitted }) && days === submitted) dirty = false;
    } finally { saving = false; }
  }
</script>

{#if store.owner}
  <form onsubmit={event => { event.preventDefault(); void save(); }}>
    <label class="ui-label-box" for="{uid}-days">
      <span class="ui-label">{strings.settings.archived.doneRetentionLabel}</span>
      <InfoTip topic={strings.settings.archived.doneRetentionLabel} text={strings.settings.archived.doneRetentionHint} />
    </label>
    <div class="actions">
      <input id="{uid}-days" type="number" min="0" max="3650" step="1" bind:value={days}
        oninput={() => { dirty = true; }} aria-invalid={!valid} aria-describedby={valid ? undefined : `${uid}-error`}
        data-testid="done-retention-days" />
      <button type="submit" disabled={!valid || !dirty || saving || !store.settings || store.connection !== 'ready'}
        data-testid="done-retention-save"><span class="ui-label">{strings.settings.save}</span></button>
    </div>
    {#if !valid}<p id="{uid}-error" class="field-error" role="alert">{strings.settings.deleted.retentionError}</p>{/if}
  </form>
{/if}

<style>
  form { margin-bottom: 16px; }
  label { display: flex; align-items: center; gap: 6px; font-size: var(--text-sm); margin-bottom: 6px; }
  .actions { display: flex; align-items: center; gap: 8px; }
  input { width: 100px; }
  p { margin: 6px 0 0; }
</style>
