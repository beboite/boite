<script lang="ts">
  import { X } from '@lucide/svelte';
  import { checkSettingsPatch, WINDOW_CAPTURE_EXCLUDED } from '@boite/contracts';
  import InfoTip from './InfoTip.svelte';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  /**
   * Apps no agent captures, even with the owner's permission (docs/windows.md):
   * the built-in password managers and sign-in screen, then the owner's own
   * list (`windowCaptureExclusions`), saved as soon as it changes.
   */
  let { store }: { store: Store } = $props();
  const s = strings.windows.settings;
  const uid = $props.id();

  /** The built-in list, each app once: `keepassxc` and `keepassxc.exe` are one app. */
  const always = [...new Set(WINDOW_CAPTURE_EXCLUDED.map((name) => name.replace(/\.exe$/i, '')))].join(', ');
  const saved = $derived(store.settings?.windowCaptureExclusions ?? []);
  let draft = $state(''), busy = $state(false), invalid = $state(false);

  async function save(next: string[]): Promise<boolean> {
    if (!checkSettingsPatch({ windowCaptureExclusions: next }).ok) { invalid = true; return false; }
    busy = true;
    const ok = await store.saveSettings({ windowCaptureExclusions: next });
    busy = false;
    return ok;
  }

  async function add(event: SubmitEvent) {
    event.preventDefault();
    const name = draft.trim();
    if (!name) return;
    if (saved.some((entry) => entry.toLowerCase() === name.toLowerCase())) { draft = ''; return; }
    if (await save([...saved, name])) draft = '';
  }
</script>

{#if store.owner}
  <section class="card" id="settings-window-exclusions" data-testid="window-exclusions">
    <h2 class="ui-label-box"><span class="ui-label">{s.exclusionsHeading}</span><InfoTip topic={s.exclusionsHeading} text={s.exclusionsIntro} /></h2>
    <p class="muted" data-testid="window-exclusions-always">{fill(s.always, { list: always })}</p>
    {#if saved.length === 0}
      <p class="muted" data-testid="window-exclusions-none">{s.none}</p>
    {:else}
      <ul>
        {#each saved as name (name)}
          <li data-testid="window-exclusion">
            <span class="name" title={name}>{name}</span>
            <button type="button" class="ghost icon" data-testid="window-exclusion-remove" disabled={busy || !store.settings} aria-label={fill(s.removeExclusion, { name })} title={fill(s.removeExclusion, { name })} onclick={() => void save(saved.filter((entry) => entry !== name))}><X size={15} /></button>
          </li>
        {/each}
      </ul>
    {/if}
    <form class="add" onsubmit={add}>
      <input id="{uid}-name" type="text" bind:value={draft} oninput={() => { invalid = false; }} aria-label={s.addLabel} aria-invalid={invalid} placeholder={s.placeholder} spellcheck="false" autocomplete="off" disabled={!store.settings} data-testid="window-exclusion-input" />
      <button type="submit" disabled={busy || !store.settings || !draft.trim()} data-testid="window-exclusion-add"><span class="ui-label">{s.add}</span></button>
    </form>
    {#if invalid}<p class="error" role="status">{strings.settings.autosave.invalid}</p>{/if}
  </section>
{/if}

<style>
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  li {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: var(--row);
    padding: 2px 2px 2px 10px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }
  .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); font-size: var(--text-sm); }
  .icon { flex: none; min-width: var(--control); min-height: var(--control); justify-content: center; }
  .add { display: flex; gap: 8px; margin-top: 8px; }
  .add input { flex: 1; min-width: 0; }
  .add button { flex: none; }
  .error { margin: 4px 0 0; font-size: var(--text-sm); color: var(--color-danger); }
  @media (pointer: coarse) { .icon { min-width: var(--touch-target); min-height: var(--touch-target); } }
</style>
