<script lang="ts">
  import { FolderX } from '@lucide/svelte';
  import type { Project } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { confirmRemoveProject } from '../lib/project-menu';
  import { fill, strings } from '../lib/strings';

  /*
   * Above the composer of a project whose folder was deleted, moved or renamed
   * outside Boite. The core refuses a new thread or a turn there; this says so
   * before the send, and offers the two ways out as buttons a phone can reach.
   */
  let { store, project }: { store: Store; project: Project } = $props();
  let checking = $state(false);

  async function check() {
    checking = true;
    try { await store.refreshProjects(); } finally { checking = false; }
  }
</script>

<article class="folder-gone" data-testid="folder-gone" role="status">
  <span class="mark"><FolderX size={16} aria-hidden="true" /></span>
  <div class="text">
    <strong>{strings.sidebar.projectMissing}</strong>
    <p>{fill(strings.sidebar.projectMissingBody, { path: project.path })}</p>
  </div>
  <div class="actions">
    <button type="button" class="ghost small" data-testid="folder-gone-check" disabled={checking} onclick={check}>{strings.sidebar.projectMissingCheck}</button>
    {#if store.owner}<button type="button" class="ghost small danger" data-testid="folder-gone-remove" onclick={() => confirmRemoveProject(store, project)}>{strings.sidebar.removeProject}</button>{/if}
  </div>
</article>

<style>
  .folder-gone {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 10px;
    /* The composer's own column, so the notice sits on it rather than across the pane. */
    flex: none;
    box-sizing: border-box;
    width: min(calc(100% - 40px), var(--content));
    margin: 0 auto;
    padding: 10px 12px;
    border: 1px solid var(--color-danger);
    border-radius: var(--radius-lg);
    background: var(--color-surface-2);
    font-size: var(--text-sm);
  }
  .mark { display: flex; flex: none; padding-top: 2px; color: var(--color-danger); }
  .text { flex: 1 1 240px; min-width: 0; }
  p { margin: 2px 0 0; color: var(--color-muted-foreground); line-height: 1.5; overflow-wrap: anywhere; }
  .actions { display: flex; flex: none; flex-wrap: wrap; gap: 6px; margin-left: auto; }
  @media (max-width: 720px) { .folder-gone { width: calc(100% - 20px); } }
</style>
