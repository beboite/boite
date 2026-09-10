<script lang="ts">
  import { onMount } from 'svelte';
  import { strings } from '../lib/strings';
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
  <label>
    <span>{strings.settings.closeToTray}<small>{strings.settings.closeToTrayHint}</small></span>
    <input type="checkbox" role="switch" data-testid="close-to-tray" checked={enabled} disabled={!ready} onchange={(event) => void update(event.currentTarget.checked)} />
  </label>
  {#if error}<p role="alert">{error}</p>{/if}
</section>
<style>
  label { display: flex; align-items: center; gap: 20px; justify-content: space-between; }
  small { display: block; color: var(--color-muted-foreground); font-size: var(--text-sm); margin-top: 4px; }
  p { color: var(--color-danger); }
</style>
