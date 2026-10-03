<script lang="ts">
  import InfoTip from './InfoTip.svelte';
  import { onMount } from 'svelte';
  import { strings } from '../lib/strings';

  const uid = $props.id();
  let enabled = $state(false);
  let ready = $state(false);
  let error = $state('');
  async function update(value?: boolean) {
    ready = false;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      enabled = await invoke<boolean>('close_behavior', value === undefined ? {} : { enabled: value });
      error = '';
    } catch (cause) { error = String(cause); }
    finally { ready = true; }
  }
  onMount(() => { void update(); });
</script>

<!-- A row of General's App card, not a card of its own: one switch does not need a frame. -->
<label for="{uid}-close-to-tray" class="switch-row" data-testid="shell-settings">
  <span class="text ui-label-box"><span class="ui-label" id="{uid}-close-to-tray-name">{strings.settings.closeToTray}</span><InfoTip topic={strings.settings.closeToTray} text={strings.settings.closeToTrayHint} /></span>
  <input id="{uid}-close-to-tray" aria-labelledby="{uid}-close-to-tray-name" type="checkbox" role="switch" data-testid="close-to-tray" checked={enabled} disabled={!ready} onchange={(event) => void update(event.currentTarget.checked)} />
</label>
{#if error}<p class="error" role="alert">{error}</p>{/if}
<style>
  .error { margin: 0 0 12px; color: var(--color-danger); font-size: var(--text-sm); }
</style>
