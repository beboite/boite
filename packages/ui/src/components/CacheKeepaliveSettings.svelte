<script lang="ts">
  import { untrack } from 'svelte';
  import { Clock } from '@lucide/svelte';
  import { CACHE_KEEPALIVE_HOURS } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import SyncMark from './SyncMark.svelte';
  import InfoTip from './InfoTip.svelte';

  /**
   * The `cacheKeepalive` setting: while a conversation waits on its agents,
   * the core pings its prompt cache for at most so many hours
   * (`docs/prompt-cache.md`, "Keeping the cache warm").
   */
  let { store }: { store: Store } = $props();
  const uid = $props.id();

  let rule = $derived(store.settings?.cacheKeepalive ?? null);
  /** The field as typed, kept while the setting is off so switching it back on restores it. */
  let hours = $state<number | null | undefined>(CACHE_KEEPALIVE_HOURS.default);
  let dirty = $state(false);
  $effect(() => {
    const next = rule?.hours ?? null;
    untrack(() => { if (!dirty && next !== null) hours = next; });
  });
  let valid = $derived(typeof hours === 'number' && Number.isInteger(hours) && hours >= CACHE_KEEPALIVE_HOURS.min && hours <= CACHE_KEEPALIVE_HOURS.max);

  /** A switch saves when it flips; a refusal puts it back. */
  let saving = $state(false);
  async function save(on: boolean, input?: HTMLInputElement) {
    saving = true;
    const ok = await store.saveSettings({ cacheKeepalive: on ? { hours: valid ? hours as number : CACHE_KEEPALIVE_HOURS.default } : null }).finally(() => { saving = false; });
    if (!ok && input) input.checked = !input.checked;
    return ok;
  }
  async function saveHours() {
    if (!rule || !valid) return;
    if (await save(true)) dirty = false;
  }
</script>

<!-- The core's own behaviour on the owner's machine, so a paired device does not see it. -->
{#if store.owner}
  <section class="card" id="settings-cache-keepalive" data-testid="cache-keepalive-settings">
    <label for="{uid}-on" class="master">
      <span class="words">
        <h2 class="ui-label-box"><span class="ui-label" id="{uid}-on-name">{strings.settings.cacheKeepalive}</span><InfoTip topic={strings.settings.cacheKeepalive} text={strings.settings.cacheKeepaliveHint} /><SyncMark {store} key="cacheKeepalive" /></h2>
      </span>
      <input id="{uid}-on" aria-labelledby="{uid}-on-name" type="checkbox" role="switch" data-testid="cache-keepalive-on"
        checked={rule !== null} disabled={!store.settings || saving} onchange={(event) => void save(event.currentTarget.checked, event.currentTarget)} />
    </label>

    {#if rule}
      <div class="option">
        <span class="icon"><Clock size={18} strokeWidth={1.75} /></span>
        <label for="{uid}-hours" class="name"><span class="ui-label">{strings.settings.cacheKeepaliveHours}</span><InfoTip topic={strings.settings.cacheKeepaliveHours} text={strings.settings.cacheKeepaliveHoursHint} /></label>
        <span class="field">
          <input id="{uid}-hours" type="number" inputmode="numeric" min={CACHE_KEEPALIVE_HOURS.min} max={CACHE_KEEPALIVE_HOURS.max} step="1"
            data-testid="cache-keepalive-hours" aria-invalid={!valid}
            aria-describedby={valid ? undefined : `${uid}-hours-error`} disabled={saving} bind:value={hours}
            oninput={() => { dirty = true; }} onchange={() => void saveHours()} />
          <span class="unit ui-label">{strings.settings.cacheKeepaliveUnit}</span>
        </span>
        {#if !valid}
          <span class="field-error" id="{uid}-hours-error" data-testid="cache-keepalive-hours-error">{fill(strings.settings.numberRange, { min: String(CACHE_KEEPALIVE_HOURS.min), max: String(CACHE_KEEPALIVE_HOURS.max) })}</span>
        {/if}
      </div>
    {/if}
  </section>
{/if}

<style>
  .master { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; cursor: pointer; }
  .master .words { display: grid; gap: 6px; flex: 1; min-width: 0; }
  .card .master h2 { margin: 0; }
  .option { display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; align-items: center; column-gap: 14px; row-gap: 4px; margin-top: 16px; padding: 14px 16px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface-2); }
  .icon { display: grid; place-items: center; width: 34px; height: 34px; border-radius: var(--radius-sm); background: var(--color-surface); border: 1px solid var(--color-border); color: var(--color-accent); }
  .name { display: flex; align-items: center; gap: 4px 8px; color: var(--color-foreground); font-size: var(--text-base); font-weight: 500; }
  .field { display: flex; align-items: center; gap: 8px; }
  input[type='number'] { width: 72px; text-align: right; }
  input[aria-invalid='true'] { border-color: var(--color-danger); }
  .unit { color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .field-error { grid-column: 2 / -1; color: var(--color-danger); font-size: var(--text-sm); }
</style>
