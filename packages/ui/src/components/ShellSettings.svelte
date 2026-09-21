<script lang="ts">
  import { onMount } from 'svelte';
  import { strings } from '../lib/i18n.svelte';
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

<section class="card" data-testid="shell-settings">
  <label class="switch-row">
    <span class="text">{strings.settings.closeToTray}<span class="hint">{strings.settings.closeToTrayHint}</span></span>
    <input type="checkbox" role="switch" data-testid="close-to-tray" checked={enabled} disabled={!ready} onchange={(event) => void update(event.currentTarget.checked)} />
  </label>
  {#if error}<p role="alert">{error}</p>{/if}
</section>
<style>
  p { margin-top: 12px; color: var(--color-danger); }
</style>
