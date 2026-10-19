<script lang="ts">
  import { errorText } from '../lib/errors';
  import { ChevronDown, FolderOpen } from '@lucide/svelte';
  import { checkSettingsPatch, type WorktreeStorage } from '@boite/contracts';
  import Menu from './Menu.svelte';
  import InfoTip from './InfoTip.svelte';
  import SaveStatus from './SaveStatus.svelte';
  import { Autosave, TYPING_MS } from '../lib/autosave.svelte';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  let { store }: { store: Store } = $props();
  const uid = $props.id();
  const s = strings.settings.worktrees;
  type Draft = { mode: 'project' | 'shared'; directory: string };
  let draft = $state<{ owner: Store; value: Draft } | null>(null);
  let busy = $state(false);
  let error = $state('');
  /** What a save sends: the mode, and the folder only while one is typed. */
  const patch = () => ({ worktreeStorage: { mode: current.mode, directory: current.directory.trim() || null } as WorktreeStorage });
  const save = new Autosave(write, () => checkSettingsPatch(patch()).ok ? null : s.storageInvalid);
  $effect(() => () => void save.flush());
  let saved = $derived<WorktreeStorage>(store.settings?.worktreeStorage ?? { mode: 'project', directory: null });
  let current = $derived<Draft>(draft?.owner === store ? draft.value : { mode: saved.mode, directory: saved.directory ?? '' });
  let items = $derived([
    { id: 'project', label: s.storageProject, active: current.mode === 'project' },
    { id: 'shared', label: s.storageShared, active: current.mode === 'shared' }
  ]);

  /** A change saves by itself: a folder being typed waits for a pause, a picked mode or folder saves now. */
  function edit(value: Partial<Draft>, delay = 0) {
    draft = { owner: store, value: { ...current, ...value } };
    error = '';
    save.change('', delay);
  }

  async function write() {
    const owner = store;
    const submitted = current;
    const ok = await owner.saveSettings(patch());
    if (store !== owner) return;
    if (ok && current === submitted) draft = null;
    if (!ok) throw new Error(s.storageSaveFailed);
  }

  async function browse() {
    const owner = store;
    const client = owner.client;
    busy = true;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({ directory: true, multiple: false, defaultPath: current.directory || undefined });
      if (store === owner && owner.client === client && typeof picked === 'string') edit({ directory: picked });
    } catch (cause) {
      if (store === owner) error = errorText(cause);
    } finally { busy = false; }
  }
</script>

<form data-testid="worktree-storage" onsubmit={event => { event.preventDefault(); void save.flush(); }}>
  <fieldset disabled={busy || !store.settings || store.connection !== 'ready'}>
  <div class="switch-row">
    <span class="ui-label-box"><span class="ui-label">{s.storage}</span><InfoTip topic={s.storage} text={`${current.mode === 'project' ? `${s.storageProjectHint} .boite/worktrees` : s.storageSharedHint} ${s.storageNewOnly}`} /></span>
    <SaveStatus {save} />
    <Menu {items} label={s.storage} placement="bottom" align="end" testid="worktree-storage-mode"
      onpick={id => edit({ mode: id as Draft['mode'] })}>
      <span class="ui-label">{current.mode === 'project' ? s.storageProject : s.storageShared}</span><ChevronDown size={13} />
    </Menu>
  </div>
  {#if current.mode === 'shared'}
    <label for="{uid}-directory">{s.storageDirectory}</label>
    <div class="directory">
      <input id="{uid}-directory" data-testid="worktree-storage-directory" type="text" value={current.directory}
        oninput={event => edit({ directory: event.currentTarget.value }, TYPING_MS)} onchange={() => void save.flush()} disabled={busy}
        placeholder={s.storagePlaceholder} spellcheck="false" autocomplete="off" />
      {#if store.pickerAvailable}
        <button type="button" class="icon" aria-label={s.storageBrowse} title={s.storageBrowse} disabled={busy} onclick={() => void browse()}><FolderOpen size={16} /></button>
      {/if}
    </div>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  </fieldset>
</form>

<style>
  form { margin-bottom: 20px; padding-bottom: 20px; border-bottom: 1px solid var(--color-border); }
  fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
  .switch-row { flex-wrap: wrap; gap: 8px; }
  label { display: block; font-size: var(--text-sm); margin: 12px 0 6px; }
  .directory { display: flex; gap: 8px; }
  input { flex: 1; min-width: 0; width: 100%; font-family: var(--font-mono); }
  .error { color: var(--color-danger); overflow-wrap: anywhere; }
</style>
