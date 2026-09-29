<script lang="ts">
  import { ChevronDown, FolderOpen } from '@lucide/svelte';
  import { checkSettingsPatch, type WorktreeStorage } from '@boite/contracts';
  import Menu from './Menu.svelte';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  let { store }: { store: Store } = $props();
  const uid = $props.id();
  const s = strings.settings.worktrees;
  type Draft = { mode: 'project' | 'shared'; directory: string };
  let draft = $state<{ owner: Store; value: Draft } | null>(null);
  let busy = $state(false);
  let error = $state('');
  let saved = $derived<WorktreeStorage>(store.settings?.worktreeStorage ?? { mode: 'project', directory: null });
  let current = $derived<Draft>(draft?.owner === store ? draft.value : { mode: saved.mode, directory: saved.directory ?? '' });
  let changed = $derived(current.mode !== saved.mode || current.directory.trim() !== (saved.directory ?? ''));
  let items = $derived([
    { id: 'project', label: s.storageProject, active: current.mode === 'project' },
    { id: 'shared', label: s.storageShared, active: current.mode === 'shared' }
  ]);

  function edit(patch: Partial<Draft>) {
    draft = { owner: store, value: { ...current, ...patch } };
    error = '';
  }

  async function save() {
    if (busy) return;
    const owner = store;
    const submitted = current;
    const worktreeStorage = { mode: current.mode, directory: current.directory.trim() || null } as WorktreeStorage;
    if (!checkSettingsPatch({ worktreeStorage }).ok) { error = s.storageInvalid; return; }
    busy = true;
    try {
      const ok = await owner.saveSettings({ worktreeStorage });
      if (store !== owner) return;
      if (ok && current === submitted) draft = null;
      error = ok ? '' : s.storageSaveFailed;
    } finally { busy = false; }
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
      if (store === owner) error = cause instanceof Error ? cause.message : String(cause);
    } finally { busy = false; }
  }
</script>

<form data-testid="worktree-storage" onsubmit={event => { event.preventDefault(); void save(); }}>
  <fieldset disabled={busy || !store.settings || store.connection !== 'ready'}>
  <div class="switch-row">
    <span>{s.storage}</span>
    <Menu {items} label={s.storage} placement="bottom" align="end" testid="worktree-storage-mode"
      onpick={id => edit({ mode: id as Draft['mode'] })}>
      {current.mode === 'project' ? s.storageProject : s.storageShared}<ChevronDown size={13} />
    </Menu>
  </div>
  {#if current.mode === 'project'}
    <p class="hint">{s.storageProjectHint} <code>.boite/worktrees</code></p>
  {:else}
    <label for="{uid}-directory">{s.storageDirectory}</label>
    <div class="directory">
      <input id="{uid}-directory" data-testid="worktree-storage-directory" type="text" value={current.directory}
        oninput={event => edit({ directory: event.currentTarget.value })} disabled={busy}
        placeholder={s.storagePlaceholder} spellcheck="false" autocomplete="off" />
      {#if store.pickerAvailable}
        <button type="button" class="icon" aria-label={s.storageBrowse} title={s.storageBrowse} disabled={busy} onclick={() => void browse()}><FolderOpen size={16} /></button>
      {/if}
    </div>
    <p class="hint">{s.storageSharedHint}</p>
  {/if}
  <p class="hint">{s.storageNewOnly}</p>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <button type="submit" data-testid="worktree-storage-save" disabled={busy || !store.settings || !changed || store.connection !== 'ready'}>{strings.settings.save}</button>
  </fieldset>
</form>

<style>
  form { margin-bottom: 20px; padding-bottom: 20px; border-bottom: 1px solid var(--color-border); }
  fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
  .switch-row { flex-wrap: wrap; gap: 8px; }
  label { display: block; font-size: var(--text-sm); margin: 12px 0 6px; }
  .directory { display: flex; gap: 8px; }
  input { flex: 1; min-width: 0; width: 100%; font-family: var(--font-mono); }
  .hint { margin: 8px 0 12px; font-size: var(--text-sm); color: var(--color-muted-foreground); line-height: 1.5; }
  .error { color: var(--color-danger); overflow-wrap: anywhere; }
</style>
