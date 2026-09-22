<script lang="ts">
  import { GitBranch, PanelRight } from '@lucide/svelte';
  import { focusOnMount } from '../lib/actions';
  import { contextMenu } from '../lib/context-menu.svelte';
  import { separator } from '../lib/menu';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import ContextControl from './ContextControl.svelte';
  import StatusMark from './StatusMark.svelte';
  import ProposalComparison from './ProposalComparison.svelte';
  import { experimentOn } from '../lib/experiments.svelte';
  let { store }: { store: Store } = $props();
  let thread = $derived(store.openThread);
  let project = $derived(store.openProject);
  let renaming = $state(false);
  let renameText = $state('');

  function beginRename() {
    const thread = store.openThread;
    if (!thread) return;
    renameText = thread.title;
    renaming = true;
  }

  // The palette asks for a rename from outside this header.
  $effect(() => {
    if (!store.renameRequested) return;
    store.renameRequested = false;
    beginRename();
  });

  async function commitRename() {
    const thread = store.openThread;
    renaming = false;
    if (thread) await store.rename(thread.id, renameText);
  }

  function onRenameKey(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      void commitRename();
    } else if (event.key === 'Escape') {
      renaming = false;
    }
  }

  function openTitleMenu(event: MouseEvent) {
    const open = store.openThread;
    if (!open) return;
    contextMenu.open(
      event,
      [
        { id: 'rename', label: strings.sidebar.rename },
        {
          id: 'retitle',
          label: store.retitling.includes(open.id) ? strings.sidebar.retitling : strings.sidebar.retitle,
          disabled: store.retitling.includes(open.id)
        },
        { id: 'copy', label: strings.sidebar.copyPath, hint: open.cwd },
        separator(),
        { id: 'archive', label: strings.sidebar.archive, danger: true }
      ],
      (action) => {
        if (action === 'rename') beginRename();
        else if (action === 'retitle') void store.retitle(open.id);
        else if (action === 'copy') void store.copy(open.cwd);
        else if (action === 'archive') void store.archive(open.id);
      }
    );
  }

</script>

<div class="thread-header" data-testid="thread-header">
      {#if thread}
        <StatusMark status={thread.status} testid="thread-status" />
        {#if renaming}
          <input
            class="rename"
            bind:value={renameText}
            onkeydown={onRenameKey}
            onblur={() => void commitRename()}
            placeholder={strings.thread.renamePlaceholder}
            data-testid="thread-rename-input"
            use:focusOnMount
          />
        {:else}
          <button
            type="button"
            class="ghost title"
            data-testid="thread-title"
            title={strings.sidebar.rename}
            onclick={beginRename}
            oncontextmenu={openTitleMenu}
          >
            {thread.title}
          </button>
        {/if}
      {:else}
        <span class="draft-mark"></span>
        <span class="title draft" data-testid="thread-title">{strings.sidebar.draft}</span>
      {/if}

      <span class="spacer"></span>

      <!-- A draft names its project in the heading below, so the chip would say it twice. -->
      {#if project && thread}
        <span class="chip path" title={project.path}>{project.name}</span>
      {/if}
      {#if thread?.branch}
        <span class="chip path branch mono" title="{strings.thread.branchHint}: {thread.cwd}" data-testid="thread-branch">
          <GitBranch size={13} strokeWidth={1.75} />
          {thread.branch}
        </span>
      {/if}
      {#if thread}<ContextControl {store} />{/if}
      {#if project && store.owner && experimentOn('proposal-comparison')}
        {#key store}<ProposalComparison {store} />{/key}
      {/if}
      <!-- Every surface of the panel reads something only the owner may ask
           for, so the button is not in a paired device's header at all. -->
      {#if thread && store.owner}
        <button
          type="button"
          class="ghost trace"
          class:on={store.panelOpen}
          title={strings.thread.panelHint}
          aria-pressed={store.panelOpen}
          data-testid="panel-toggle"
          onclick={() => store.togglePanel()}
        >
          <PanelRight size={16} strokeWidth={1.75} />
          {strings.thread.panel}
        </button>
      {/if}
</div>

<style>
  .thread-header { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; height: 100%; }
  .title {
    height: var(--control);
    padding: 0 6px;
    margin-left: -6px;
    font-weight: 600;
    color: var(--color-foreground);
    max-width: 50%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: block;
    line-height: var(--control);
  }

  .title.draft {
    color: var(--color-muted-foreground);
    font-weight: 500;
  }

  .rename {
    height: var(--control);
    width: min(420px, 50%);
    font-weight: 600;
  }

  .draft-mark {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    border: 1.5px dashed var(--color-muted-foreground);
    flex: none;
  }

  .spacer {
    flex: 1;
  }

  .path {
    max-width: 240px;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: var(--text-sm);
  }

  .trace {
    flex: none;
    padding: 0 10px 0 8px;
  }

  .on {
    background: var(--color-active);
    color: var(--color-foreground);
  }


  .title { min-width: 0; }
  @media (max-width: 720px) { .path { display: none; } .trace { padding: 0 6px; } }
</style>
