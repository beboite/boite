<script lang="ts">
  import { errorText } from '../../lib/errors';
  import { ArrowUp, Folder, FolderOpen } from '@lucide/svelte';
  import type { RpcResult } from '@boite/contracts';
  import type { AgentsView } from '../../lib/agents.svelte';
  import { strings } from '../../lib/strings';

  /**
   * The folder every agent's brain lives under on this core. Changing it moves
   * every brain there; the core refuses a folder that already holds files and
   * says which, and that sentence shows here. The core may be another machine:
   * the shell's own dialog only when this window sits on it, otherwise the
   * folders the core lists, the way a project is added on a remote core.
   */
  let { view }: { view: AgentsView } = $props();
  const labels = $derived(strings.agents);
  const root = $derived(view.snapshot?.brainRoot ?? null);
  let editing = $state(false);
  let path = $state('');
  let folders = $state.raw<RpcResult<'projects.browse'> | null>(null);
  let browsing = $state(false);
  let refusal = $state('');
  const busy = $derived(view.pending || browsing);

  function edit() {
    editing = !editing;
    path = root?.custom ? root.path : '';
    folders = null; refusal = '';
  }

  async function browse(target?: string) {
    const store = view.store;
    if (busy) return;
    if (!target && store.pickerAvailable) return native();
    browsing = true; refusal = '';
    try { folders = await store.browseProjects(target || undefined); }
    catch (error) { refusal = errorText(error); }
    finally { browsing = false; }
  }

  async function native() {
    const client = view.store.client;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({ directory: true, multiple: false, defaultPath: path.trim() || undefined });
      // A dialog left open across a reconnection names a folder of the core it was opened for.
      if (client !== view.store.client) return;
      if (typeof picked === 'string' && picked.length > 0) path = picked;
    } catch (error) { refusal = errorText(error); }
  }

  async function move(next: string | null) {
    refusal = '';
    const result = await view.call('agents.brain.root', { path: next });
    if (result) { editing = false; folders = null; return; }
    // The core's own sentence, beside the folder it is about rather than over the page.
    refusal = view.error; view.error = '';
  }
</script>

{#if root && view.store.owner}
  <section class="card" data-testid="agents-brain-root">
    <h2>{labels.brainFolder}</h2>
    <p class="hint">{labels.brainFolderHint}</p>
    <div class="agent-brain-root">
      <Folder size={16} strokeWidth={1.75} />
      <span class="agent-brain-root-path">
        <code data-testid="agents-brain-root-path">{root.path}</code>
        {#if !root.custom}<span class="hint">{labels.brainDefault}</span>{/if}
      </span>
      <span class="agent-brain-root-actions">
        <button type="button" class="ghost small" aria-expanded={editing} disabled={busy} onclick={edit} data-testid="agents-brain-root-change"><span class="ui-label">{editing ? strings.common.cancel : labels.brainChange}</span></button>
        {#if root.custom}<button type="button" class="ghost small" disabled={busy} onclick={() => void move(null)} data-testid="agents-brain-root-default"><span class="ui-label">{labels.brainUseDefault}</span></button>{/if}
      </span>
    </div>
    {#if editing}
      <form class="agent-brain-root-form" onsubmit={event => { event.preventDefault(); if (path.trim()) void move(path.trim()); }}>
        <div class="agent-field">
          <label for="agents-brain-root-input">{labels.brainPath}</label>
          <div class="agent-inline">
            <input id="agents-brain-root-input" bind:value={path} spellcheck="false" autocomplete="off" disabled={busy} data-testid="agents-brain-root-input" />
            <button type="button" disabled={busy} onclick={() => void browse(path.trim() || undefined)} data-testid="agents-brain-root-browse"><FolderOpen size={15} strokeWidth={1.75} /><span class="ui-label">{labels.brainBrowse}</span></button>
          </div>
        </div>
        {#if folders}
          <div class="agent-brain-folders" data-testid="agents-brain-root-folders">
            <code>{folders.path}</code>
            {#if folders.parent}<button type="button" class="ghost small" disabled={busy} onclick={() => void browse(folders!.parent!)}><ArrowUp size={14} /><span class="ui-label">{labels.brainParent}</span></button>{/if}
            {#each folders.directories as directory (directory.path)}<button type="button" class="ghost small" disabled={busy} onclick={() => void browse(directory.path)}><Folder size={14} /><span class="ui-label">{directory.name}</span></button>{/each}
            <button type="button" class="small" disabled={busy} onclick={() => { path = folders!.path; folders = null; }}><span class="ui-label">{labels.brainUseFolder}</span></button>
          </div>
        {/if}
        <div class="agent-form-actions"><button class="primary" disabled={busy || !path.trim()} data-testid="agents-brain-root-save"><span class="ui-label">{labels.brainMove}</span></button></div>
      </form>
    {/if}
    {#if refusal}<p class="agent-error" role="alert" data-testid="agents-brain-root-error">{refusal}</p>{/if}
  </section>
{/if}
