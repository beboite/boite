<script lang="ts">
  import { BROWSER_PROFILES_MAX, checkSettingsPatch, DEFAULT_BROWSER_PROFILE, type BrowserProfile } from '@boite/contracts';
  import { tick } from 'svelte';
  import InfoTip from './InfoTip.svelte';
  import Menu from './Menu.svelte';
  import { canCopySignIns, copySignIns } from '../lib/browser-cookies';
  import { workspace } from '../lib/workspace.svelte';
  import { browserBridge } from '../lib/browser-bridge';
  import { browserProfiles, newProfileId } from '../lib/browser-profiles.svelte';
  import { confirm } from '../lib/confirm.svelte';
  import { rightPanel } from '../lib/right-panel.svelte';
  import { fill, strings } from '../lib/strings';

  /**
   * The built-in browser's profiles on this computer: add, rename, delete, and
   * the one new tabs open in. `default` is the session tabs had before there
   * were profiles and cannot go; a private tab is chosen per tab, never here.
   */
  const s = $derived(strings.browserProfiles);
  const uid = $props.id();

  let draft = $state('');
  let renaming = $state<string | null>(null);
  let renamed = $state('');
  let problem = $state('');
  let busy = $state(false);
  let field = $state<HTMLInputElement | undefined>(undefined);
  let notice = $state('');

  /** The machines whose agent browser the owner may hand sign-ins to: connected, with full control. */
  let targets = $derived(canCopySignIns() ? workspace.machines.filter((machine) => machine.store.owner && machine.store.connection === 'ready') : []);

  /** The profile's cookies go to the agent browser of the machine picked, which makes the profile if it has none. */
  async function copy(profile: BrowserProfile, machineId: string): Promise<void> {
    const machine = targets.find((one) => one.id === machineId);
    if (!machine) return;
    busy = true;
    problem = '';
    notice = '';
    try {
      const count = await copySignIns({ id: profile.id, name: profile.name }, machine.store);
      notice = count ? fill(s.copied, { count: String(count), name: profile.name, machine: machine.label }) : fill(s.copiedNone, { name: profile.name });
    } catch (error) {
      problem = fill(s.copyFailed, { reason: error instanceof Error ? error.message : String(error) });
    } finally { busy = false; }
  }

  let rows = $derived([{ id: DEFAULT_BROWSER_PROFILE, name: s.default }, ...browserProfiles.list]);
  let ready = $derived(browserProfiles.source?.settings != null);

  /** The list as the core would store it, or why not. */
  function checked(profiles: BrowserProfile[]): BrowserProfile[] | null {
    const result = checkSettingsPatch({ browserProfiles: profiles });
    if (!result.ok) {
      problem = profiles.length > BROWSER_PROFILES_MAX ? fill(s.tooMany, { count: String(BROWSER_PROFILES_MAX) }) : s.invalidName;
      return null;
    }
    problem = '';
    return result.patch.browserProfiles ?? profiles;
  }

  async function save(profiles: BrowserProfile[], defaultId?: string): Promise<boolean> {
    busy = true;
    try { return await browserProfiles.save(profiles, defaultId); } finally { busy = false; }
  }

  async function add(event: Event): Promise<void> {
    event.preventDefault();
    const next = checked([...browserProfiles.list, { id: newProfileId(), name: draft }]);
    if (next && (await save(next))) draft = '';
  }

  async function startRename(profile: BrowserProfile): Promise<void> {
    renaming = profile.id;
    renamed = profile.name;
    problem = '';
    await tick();
    field?.select();
  }

  async function rename(event: Event): Promise<void> {
    event.preventDefault();
    const id = renaming;
    const next = checked(browserProfiles.list.map((profile) => (profile.id === id ? { ...profile, name: renamed } : profile)));
    if (next && (await save(next))) renaming = null;
  }

  function renameKey(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    renaming = null;
    problem = '';
  }

  /**
   * Its tabs close first, then the shell erases what the profile kept, then the
   * list forgets it. A profile the shell could not erase is still removed from
   * the list, and the reason is shown.
   */
  async function remove(profile: BrowserProfile): Promise<void> {
    const sure = await confirm.ask({
      title: fill(s.deleteTitle, { name: profile.name }),
      body: s.deleteBody,
      confirmLabel: s.delete,
      cancelLabel: strings.common.cancel,
      danger: true
    });
    if (!sure) return;
    busy = true;
    problem = '';
    rightPanel.closeProfile(profile.id);
    let failure = '';
    try { await browserBridge.deleteProfile?.(profile.id); } catch (error) { failure = error instanceof Error ? error.message : String(error); }
    const saved = await save(browserProfiles.list.filter((one) => one.id !== profile.id));
    if (saved && failure) problem = fill(s.deleteFailed, { reason: failure });
  }
</script>

<section class="card" id="settings-browser-profiles" data-testid="browser-profiles-card">
  <h2>{s.heading}<InfoTip topic={s.heading} text={s.hint} /></h2>
  <ul>
    {#each rows as profile (profile.id)}
      {@const builtIn = profile.id === DEFAULT_BROWSER_PROFILE}
      {@const isDefault = profile.id === browserProfiles.defaultId}
      <li data-testid="browser-profile-row" data-profile={profile.id}>
        {#if renaming === profile.id}
          <form class="rename" onsubmit={rename}>
            <input bind:this={field} bind:value={renamed} aria-label={fill(s.renameLabel, { name: profile.name })} maxlength="40" data-testid="browser-profile-rename-input" onkeydown={renameKey} />
            <button type="submit" class="small" disabled={busy}>{strings.settings.save}</button>
          </form>
        {:else}
          <span class="what">
            <span class="name">{profile.name}</span>
            {#if isDefault}<span class="flag" data-testid="browser-profile-default">{s.isDefault}</span>{/if}
          </span>
          {#if targets.length}
            <Menu items={targets.map((machine) => ({ id: machine.id, label: machine.label }))} onpick={(id) => void copy(profile, id)} label={fill(s.copySignInsHint, { name: profile.name })} variant="ghost" testid="browser-profile-copy"><span class="ui-label">{s.copySignIns}</span></Menu>
          {/if}
          {#if !isDefault}
            <button type="button" class="small ghost" data-testid="browser-profile-make-default" disabled={busy || !ready} onclick={() => void save(browserProfiles.list, profile.id)}>{s.makeDefault}</button>
          {/if}
          {#if !builtIn}
            <button type="button" class="small ghost" data-testid="browser-profile-rename" disabled={busy || !ready} onclick={() => void startRename(profile)}>{s.rename}</button>
            <button type="button" class="small ghost danger" data-testid="browser-profile-delete" disabled={busy || !ready} onclick={() => void remove(profile)}>{s.delete}</button>
          {/if}
        {/if}
      </li>
    {/each}
  </ul>
  <form class="add" onsubmit={add}>
    <input id="{uid}-name" bind:value={draft} aria-label={s.addLabel} placeholder={s.addPlaceholder} maxlength="40" data-testid="browser-profile-name" />
    <button type="submit" disabled={busy || !ready || draft.trim() === ''} data-testid="browser-profile-add">{s.add}</button>
  </form>
  {#if problem}<p class="problem" role="alert" data-testid="browser-profile-error">{problem}</p>{/if}
  {#if notice}<p class="notice" role="status" data-testid="browser-profile-notice">{notice}</p>{/if}
</section>

<style>
  ul { list-style: none; margin: 0 0 12px; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    min-height: var(--row);
    padding: 4px 4px 4px 10px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }
  /* On a narrow screen the buttons go under the name rather than over it. */
  .what { flex: 1 1 8em; min-width: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
  .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-sm); }
  .flag { font-size: var(--text-xs); color: var(--color-subtle); }
  li button { flex: none; }
  .danger { color: var(--color-danger); }
  form { display: flex; gap: 8px; align-items: center; margin: 0; }
  .rename { flex: 1; min-width: 0; }
  form input { flex: 1; min-width: 0; }
  .problem { margin: 8px 0 0; color: var(--color-danger); font-size: var(--text-sm); }
  .notice { margin: 8px 0 0; color: var(--color-subtle); font-size: var(--text-sm); }
</style>
