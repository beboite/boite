<script lang="ts">
  import { Check } from '@lucide/svelte';
  import type { Autosave } from '../lib/autosave.svelte';
  import { strings } from '../lib/strings';

  /**
   * What became of the last change of a form that saves by itself, at the right
   * of a card title. With `at`, only the card that changed last shows it.
   */
  let { save, at }: { save: Autosave; at?: string } = $props();
  const t = $derived(strings.settings.autosave);
  const shown = $derived(save.state !== 'idle' && (at === undefined || save.at === at));
</script>

{#if shown}
  <span class="save-status" data-state={save.state} data-testid="save-status" role={save.state === 'error' ? 'alert' : 'status'}>
    {#if save.state === 'waiting' || save.state === 'saving'}
      {t.saving}
    {:else if save.state === 'saved'}
      <Check size={12} aria-hidden="true" />{t.saved}
    {:else if save.state === 'invalid'}
      <span class="reason" title={save.error}>{save.error || t.invalid}</span>
    {:else}
      <span class="reason" title={save.error}>{save.error ? `${t.failed}: ${save.error}` : t.failed}</span>
      <button type="button" class="quiet small" onclick={() => void save.retry()}>{t.retry}</button>
    {/if}
  </span>
{/if}
