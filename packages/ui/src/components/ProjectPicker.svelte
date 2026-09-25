<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { ArrowUp, ChevronDown, ChevronRight, Folder, FolderOpen, Monitor, X } from '@lucide/svelte';
  import { Closing } from '../lib/closing.svelte';
  import { mobileOverlay } from '../lib/mobile-history';
  import { workspace } from '../lib/workspace.svelte';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import Menu from './Menu.svelte';
  let { store }: { store: Store } = $props();
  const overlay = new Closing();
  let card = $state<HTMLDivElement>();
  let input = $state<HTMLInputElement>();
  let path = $state('');
  let parent = $state<string | null>(null);
  let directories = $state<{ name: string; path: string }[]>([]);
  let busy = $state(false);
  let error = $state('');
  let revision = 0;
  let previous: HTMLElement | null = null;
  let target = $state<Store>();
  const selected = $derived(target ?? store);
  const available = $derived(workspace.machines.length ? workspace.machines : [{ id: 'current', label: strings.connection.local, store }]);
  const machineName = $derived(available.find(m => m.store === selected)?.label ?? strings.connection.local);
  const machines = $derived([
    ...available.map(m => ({ id: m.id, label: m.label, active: m.store === selected })),
    { id: 'manage', label: strings.connection.manage }
  ]);
  $effect(() => {
    if (!store.projectPickerOpen) { overlay.hide(); return; }
    target = store;
    previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    overlay.show();
    void untrack(() => browse());
    void tick().then(() => input?.focus({ preventScroll: true }));
  });

  async function browse(target?: string) {
    const current = ++revision;
    busy = true;
    error = '';
    try {
      const result = await selected.browseProjects(target);
      if (current !== revision) return;
      path = result.path; parent = result.parent; directories = result.directories;
    } catch (failure) {
      if (current === revision) error = failure instanceof Error ? failure.message : String(failure);
    } finally { if (current === revision) busy = false; }
  }
  $effect(() => { if (overlay.open) return mobileOverlay(close); });
  function close() {
    ++revision;
    store.projectPickerOpen = false;
    previous?.focus({ preventScroll: true });
  }
  async function machine(id: string) {
    if (id === 'manage') { close(); store.showSettings('machines'); return; }
    const next = available.find(m => m.id === id)?.store;
    if (!next || next === selected) return;
    ++revision; target = next; busy = true; error = ''; directories = []; path = ''; parent = null;
    if (next.connection !== 'ready') { busy = false; error = strings.connection.unavailable; return; }
    if (!next.owner) { busy = false; error = strings.firstRun.deviceBody; return; }
    await browse();
  }  async function open() {
    if (busy || !path.trim()) return;
    busy = true;
    const project = await selected.addProject(path.trim());
    busy = false;
    if (project) { close(); await workspace.select(selected, undefined, project.id); } else error = selected.error ?? strings.connection.unavailable;
  }
  async function native() {
    busy = true;
    const project = await selected.pickProject();
    busy = false;
    if (project) { close(); await workspace.select(selected, undefined, project.id); }
  }
  function keydown(event: KeyboardEvent) {
    if (!store.projectPickerOpen) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key !== 'Tab') return;
    const stops = Array.from(card?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? []);
    const first = stops[0]; const last = stops.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
</script>

<svelte:window onkeydown={keydown} />
{#if overlay.shown}
  <div class="scrim" class:closing={overlay.closing} use:overlay.attach onanimationend={overlay.end} role="presentation" onclick={e => { if (e.target === e.currentTarget) close(); }}>
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="project-picker-title" tabindex="-1" bind:this={card} data-testid="project-picker">
      <header><h2 id="project-picker-title">{strings.firstRun.heading}</h2><button type="button" class="ghost icon" aria-label={strings.common.cancel} onclick={close}><X size={16} /></button></header>
      <div class="body">
        <div class="field-label">{strings.connection.machine}</div>
        <Menu items={machines} onpick={id => void machine(id)} label={strings.connection.machine} placement="bottom" testid="project-machine"><Monitor size={15} />{machineName}<ChevronDown size={13} /></Menu>
        <label for="project-folder">{strings.connection.folder}</label>
        <form onsubmit={e => { e.preventDefault(); void browse(path); }} data-testid="add-project-form">
          <input id="project-folder" data-testid="project-path" bind:this={input} bind:value={path} spellcheck="false" autocomplete="off" placeholder={strings.firstRun.pathPlaceholder} />
          <button type="submit" class="ghost icon" disabled={busy || !path.trim()} aria-label={strings.connection.browse} title={strings.connection.browse}><ChevronRight size={16} /></button>
          {#if selected.pickerAvailable}<button type="button" class="ghost icon" data-testid="pick-project" disabled={busy} aria-label={strings.connection.nativeBrowse} title={strings.connection.nativeBrowse} onclick={() => void native()}><FolderOpen size={17} /></button>{/if}
        </form>
        <div class="folders" aria-busy={busy}>
          {#if parent}<button type="button" class="ghost folder" disabled={busy} onclick={() => void browse(parent!)}><ArrowUp size={15} />{strings.connection.parent}</button>{/if}
          {#each directories as directory (directory.path)}<button type="button" class="ghost folder" disabled={busy} onclick={() => void browse(directory.path)}><Folder size={15} /><span>{directory.name}</span><ChevronRight size={13} /></button>{/each}
          {#if !busy && directories.length === 0 && !error}<p class="muted">{strings.connection.emptyFolder}</p>{/if}
        </div>
        {#if error}<p class="error" role="alert">{error}</p>{/if}
      </div>
      <footer><button type="button" class="ghost" data-testid="project-cancel" onclick={close}>{strings.common.cancel}</button><button type="button" class="primary" data-testid="project-add" disabled={busy || !path.trim() || !selected.owner || selected.connection !== 'ready'} onclick={() => void open()}><FolderOpen size={15} />{strings.firstRun.add}</button></footer>
    </div>
  </div>
{/if}

<style>
  .scrim { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; padding: 16px; background: var(--color-scrim); backdrop-filter: blur(4px); animation: fade var(--dur-2) var(--ease-out-quint); }
  .scrim.closing { animation-name: fade-out; pointer-events: none; }
  .dialog { width: min(480px, 100%); max-height: calc(100dvh - 32px); overflow-y: auto; background: var(--color-surface); border: 1px solid var(--color-edge); border-radius: var(--radius-lg); box-shadow: var(--shadow-e3); }
  header, footer { display: flex; align-items: center; gap: 8px; padding: 12px 16px; }
  header { justify-content: space-between; border-bottom: 1px solid var(--color-border); }
  h2 { font-size: var(--text-md); font-weight: 600; }
  .body { padding: 16px; }
  .field-label, label { display: block; margin-bottom: 8px; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  label { margin-top: 20px; }
  form { display: flex; gap: 6px; }
  input { width: 100%; min-width: 0; font-family: var(--font-mono); font-size: var(--text-sm); }
  form button { height: var(--input); flex: none; }
  .folders { margin-top: 12px; height: 220px; overflow-y: auto; border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 4px; }
  .folder { width: 100%; justify-content: flex-start; gap: 10px; height: var(--row); font-weight: 400; }
  .folder span { flex: 1; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .folders p { padding: 12px; font-size: var(--text-sm); }
  .error { color: var(--color-danger); font-size: var(--text-sm); overflow-wrap: anywhere; margin-top: 12px; }
  footer { justify-content: flex-end; border-top: 1px solid var(--color-border); }
  @media (max-width: 720px) { .folders { height: 180px; } }
</style>
