<script lang="ts">
  import { errorText } from '../lib/errors';
  import { BROWSER_PROFILES_MAX, checkSettingsPatch, DEFAULT_BROWSER_PROFILE, type BrowserProfile } from '@boite/contracts';
  import { tick } from 'svelte';
  import InfoTip from './InfoTip.svelte';
  import BrowserUserAgent from './BrowserUserAgent.svelte';
  import Menu from './Menu.svelte';
  import { canCopySignIns, copySignIns } from '../lib/browser-cookies';
  import { workspace } from '../lib/workspace.svelte';
  import { browserBridge } from '../lib/browser-bridge';
  import { browserProfiles, newProfileId } from '../lib/browser-profiles.svelte';
  import { confirm } from '../lib/confirm.svelte';
  import { rightPanel } from '../lib/right-panel.svelte';
  import { fill, strings } from '../lib/strings';

  /**
   * The built-in browser on this computer and its profiles: add, rename,
   * delete, the one new tabs open in, and a copy of a profile's sign-ins to
   * the agent browser of a machine.
   * `default` is the session tabs had before there were profiles and cannot
   * go; a private tab is chosen per tab, never here.
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
      problem = fill(s.copyFailed, { reason: errorText(error) });
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

  async function save(change: (profiles: BrowserProfile[]) => BrowserProfile[] | null, defaultId?: string): Promise<boolean> {
    busy = true;
    try { return await browserProfiles.save(change, defaultId); } finally { busy = false; }
  }

  async function add(event: Event): Promise<void> {
    event.preventDefault();
    const profile = { id: newProfileId(), name: draft };
    if (await save(profiles => checked([...profiles, profile]))) draft = '';
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
    const name = renamed;
    if (await save(profiles => checked(profiles.map(profile => profile.id === id ? { ...profile, name } : profile)))) renaming = null;
  }

  function renameKey(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    renaming = null;
    problem = '';
  }

  /**
   * Its tabs close first, then the shell erases what the profile kept, then the
   * list forgets it. If erasure is unavailable or fails, the entry stays and
   * the reason is shown.
   */
  async function remove(profile: BrowserProfile): Promise<void> {
    const erase = browserBridge.deleteProfile?.bind(browserBridge);
    if (!erase) { problem = s.deleteUnavailable; return; }
    const sure = await confirm.ask({
      title: fill(s.deleteTitle, { name: profile.name }),
      body: s.deleteBody,
      confirmLabel: strings.common.delete,
      cancelLabel: strings.common.cancel,
      danger: true
    });
    if (!sure) return;
    busy = true;
    problem = '';
    rightPanel.closeProfile(profile.id);
    try {
      await erase(profile.id);
      await save(profiles => profiles.filter(one => one.id !== profile.id));
    } catch (error) {
      problem = fill(s.deleteFailed, { reason: errorText(error) });
    } finally { busy = false; }
  }
</script>

<section class="card" id="settings-browser-profiles" data-testid="browser-profiles-card">
  <h2>{s.card}</h2>
  <h3 class="ui-label-box"><span class="ui-label">{s.heading}</span><InfoTip topic={s.heading} text={s.hint} /></h3>
  <ul>
    {#each rows as profile (profile.id)}
      {@const builtIn = profile.id === DEFAULT_BROWSER_PROFILE}
      {@const isDefault = profile.id === browserProfiles.defaultId}
      <li data-testid="browser-profile-row" data-profile={profile.id}>
        {#if renaming === profile.id}
          <form class="rename" onsubmit={rename}>
            <input bind:this={field} bind:value={renamed} aria-label={fill(s.renameLabel, { name: profile.name })} maxlength="40" data-testid="browser-profile-rename-input" onkeydown={renameKey} />
            <button type="submit" class="small" disabled={busy}>{strings.common.save}</button>
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
            <button type="button" class="small ghost" data-testid="browser-profile-make-default" disabled={busy || !ready} onclick={() => void save(profiles => profiles, profile.id)}>{s.makeDefault}</button>
          {/if}
          {#if !builtIn}
            <button type="button" class="small ghost" data-testid="browser-profile-rename" disabled={busy || !ready} onclick={() => void startRename(profile)}>{strings.common.rename}</button>
            <button type="button" class="small ghost danger" data-testid="browser-profile-delete" disabled={busy || !ready} onclick={() => void remove(profile)}>{strings.common.delete}</button>
            <BrowserUserAgent {profile} disabled={busy || !ready} />
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
  h3 { margin: 4px 0 10px; font-size: var(--text-sm); font-weight: 500; color: var(--color-muted-foreground); }
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
  /* The copy menu's ghost trigger is a square icon button by default; this one
     carries words, so it sizes like the row's other small ghost buttons. */
  li :global(.menu) { flex: none; max-width: 100%; }
  li :global(.menu .trigger.ghost) { width: auto; max-width: 100%; padding: 0 8px; font-size: var(--text-sm); }
  li :global(.menu .trigger .ui-label) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .danger { color: var(--color-danger); }
  form { display: flex; gap: 8px; align-items: center; margin: 0; }
  .rename { flex: 1; min-width: 0; }
  form input { flex: 1; min-width: 0; }
  .problem { margin: 8px 0 0; color: var(--color-danger); font-size: var(--text-sm); }
  .notice { margin: 8px 0 0; color: var(--color-subtle); font-size: var(--text-sm); }
</style>
