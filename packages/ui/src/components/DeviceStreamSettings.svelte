<script lang="ts">
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import InfoTip from './InfoTip.svelte';

  /**
   * The `deviceStream` setting: the Device panel plays a plugged-in Android
   * phone through scrcpy instead of screenshots (`docs/devices.md`, "Live stream").
   * It stays on its machine: the group's settings do not carry it.
   */
  let { store }: { store: Store } = $props();
  const uid = $props.id();

  /** A switch saves when it flips; a refusal puts it back. */
  let saving = $state(false);
  async function save(input: HTMLInputElement) {
    saving = true;
    const ok = await store.saveSettings({ deviceStream: input.checked }).finally(() => { saving = false; });
    if (!ok) input.checked = !input.checked;
  }
</script>

<!-- The core starts the stream on its own machine, so only the owner turns it on; an agent asks through a settings card. -->
{#if store.owner}
  <section class="card" id="settings-device-stream" data-testid="device-stream-settings">
    <label for="{uid}-on" class="master">
      <span class="words">
        <h2 class="ui-label-box"><span class="ui-label" id="{uid}-on-name">{strings.settings.deviceStream}</span><InfoTip topic={strings.settings.deviceStream} text={strings.settings.deviceStreamHint} /></h2>
      </span>
      <input id="{uid}-on" aria-labelledby="{uid}-on-name" type="checkbox" role="switch" data-testid="device-stream-on"
        checked={store.settings?.deviceStream === true} disabled={!store.settings || saving} onchange={(event) => void save(event.currentTarget)} />
    </label>
  </section>
{/if}

<style>
  .master { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; cursor: pointer; }
  .master .words { display: grid; gap: 6px; flex: 1; min-width: 0; }
  .card .master h2 { margin: 0; }
</style>
