<script lang="ts">
  import { Activity, PanelLeft } from '@lucide/svelte';
  import { focusOnMount } from '../lib/actions';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import Composer from './Composer.svelte';
  import MessageList from './MessageList.svelte';
  import StatusMark from './StatusMark.svelte';

  let { store }: { store: Store } = $props();

  let renaming = $state(false);
  let renameText = $state('');

  function beginRename() {
    const thread = store.openThread;
    if (!thread) return;
    renameText = thread.title;
    renaming = true;
  }

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

  let thread = $derived(store.openThread);
  let project = $derived(store.openProject);
</script>

{#if !thread && !store.draft}
  <div class="none">
    <h1>{strings.thread.none}</h1>
    <p class="muted">{strings.thread.noneBody}</p>
  </div>
{:else}
  <section class="chat" data-testid="chat">
    <header>
      <button
        type="button"
        class="ghost icon drawer"
        aria-label={strings.sidebar.expand}
        onclick={() => (store.sidebarOpen = !store.sidebarOpen)}
      >
        <PanelLeft size={16} strokeWidth={1.75} />
      </button>

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
          <button type="button" class="ghost title" data-testid="thread-title" title={strings.sidebar.rename} onclick={beginRename}>
            {thread.title}
          </button>
        {/if}
        <span class="status subtle" data-testid="thread-status-label">{strings.threadStatus[thread.status]}</span>
      {:else}
        <span class="draft-mark"></span>
        <span class="title draft" data-testid="thread-title">{strings.sidebar.draft}</span>
      {/if}

      <span class="spacer"></span>

      {#if project}
        <span class="chip path mono" title={project.path}>{project.name}</span>
      {/if}
      {#if thread}
        <button
          type="button"
          class="ghost icon"
          class:on={store.panelOpen}
          title={strings.thread.traceHint}
          aria-label={strings.thread.trace}
          aria-pressed={store.panelOpen}
          data-testid="tab-trace"
          onclick={() => store.togglePanel()}
        >
          <Activity size={16} strokeWidth={1.75} />
        </button>
      {/if}
    </header>

    {#if thread}
      <MessageList {store} threadId={thread.id} messages={thread.messages} />
    {:else}
      <div class="draft-body" data-testid="draft-empty">
        <p class="muted">{strings.thread.draftHint}</p>
      </div>
    {/if}

    <Composer {store} />
  </section>
{/if}

<style>
  .none {
    margin: auto;
    padding: 40px;
    text-align: center;
    color: var(--color-muted-foreground);
  }

  .none h1 {
    color: var(--color-foreground);
    margin-bottom: 4px;
  }

  .chat {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  header {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 44px;
    padding: 0 12px 0 14px;
    border-bottom: 1px solid var(--color-border);
    flex: none;
  }

  .drawer {
    display: none;
  }

  .title {
    height: 28px;
    padding: 0 6px;
    margin-left: -6px;
    font-weight: 600;
    color: var(--color-foreground);
    max-width: 50%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: block;
    line-height: 28px;
  }

  .title.draft {
    color: var(--color-muted-foreground);
    font-weight: 500;
  }

  .rename {
    height: 28px;
    width: min(420px, 50%);
    font-weight: 600;
  }

  .status {
    font-size: var(--text-xs);
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
    font-size: var(--text-xs);
  }

  .on {
    background: var(--color-surface-3);
    color: var(--color-foreground);
  }

  .draft-body {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    text-align: center;
  }

  @media (max-width: 720px) {
    .drawer {
      display: inline-flex;
    }

    .path {
      display: none;
    }
  }
</style>
