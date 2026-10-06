<script lang="ts">
  import InfoTip from './InfoTip.svelte';
  import { onMount } from 'svelte';
  import { strings } from '../lib/strings';

  const uid = $props.id();

  /** One switch the shell owns: its command reads the value, or sets it and answers what holds. */
  function shellSwitch(command: string) {
    const state = $state({ enabled: false, ready: false, error: '' });
    async function update(value?: boolean) {
      state.ready = false;
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        state.enabled = await invoke<boolean>(command, value === undefined ? {} : { enabled: value });
        state.error = '';
      } catch (cause) { state.error = String(cause); }
      finally { state.ready = true; }
    }
    return { state, update };
  }

  const tray = shellSwitch('close_behavior');
  const login = shellSwitch('launch_at_login');
  onMount(() => { void tray.update(); void login.update(); });
</script>

<!-- Rows of General's App card, not a card of their own: two switches do not need a frame. -->
<label for="{uid}-close-to-tray" class="switch-row" data-testid="shell-settings">
  <span class="text ui-label-box"><span class="ui-label" id="{uid}-close-to-tray-name">{strings.settings.closeToTray}</span><InfoTip topic={strings.settings.closeToTray} text={strings.settings.closeToTrayHint} /></span>
  <input id="{uid}-close-to-tray" aria-labelledby="{uid}-close-to-tray-name" type="checkbox" role="switch" data-testid="close-to-tray" checked={tray.state.enabled} disabled={!tray.state.ready} onchange={(event) => void tray.update(event.currentTarget.checked)} />
</label>
{#if tray.state.error}<p class="error" role="alert">{tray.state.error}</p>{/if}
<label for="{uid}-launch-at-login" class="switch-row">
  <span class="text ui-label-box"><span class="ui-label" id="{uid}-launch-at-login-name">{strings.settings.launchAtLogin}</span><InfoTip topic={strings.settings.launchAtLogin} text={strings.settings.launchAtLoginHint} /></span>
  <input id="{uid}-launch-at-login" aria-labelledby="{uid}-launch-at-login-name" type="checkbox" role="switch" data-testid="launch-at-login" checked={login.state.enabled} disabled={!login.state.ready} onchange={(event) => void login.update(event.currentTarget.checked)} />
</label>
{#if login.state.error}<p class="error" role="alert">{login.state.error}</p>{/if}
<style>
  .error { margin: 0 0 12px; color: var(--color-danger); font-size: var(--text-sm); }
</style>
