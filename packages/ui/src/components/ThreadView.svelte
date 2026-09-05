<script lang="ts">
  import { strings } from '../lib/strings';
  import type { Store, ThreadTab } from '../lib/store.svelte';
  import Composer from './Composer.svelte';
  import MessageList from './MessageList.svelte';
  import StatusPill from './StatusPill.svelte';
  import TraceTable from './TraceTable.svelte';

  let { store }: { store: Store } = $props();

  const tabs: { id: ThreadTab; label: string }[] = [
    { id: 'chat', label: strings.thread.chat },
    { id: 'trace', label: strings.thread.trace }
  ];

  async function select(tab: ThreadTab) {
    store.tab = tab;
    if (tab === 'trace') await store.refreshTrace();
  }
</script>

{#if !store.openThread}
  <div class="none">
    <h1>{strings.thread.none}</h1>
    <p class="muted">{strings.thread.noneBody}</p>
  </div>
{:else}
  {@const thread = store.openThread}
  <section class="thread">
    <header>
      <h1>{thread.title}</h1>
      <StatusPill status={thread.status} />
      <span class="mono muted cwd" title={thread.cwd}>{thread.cwd}</span>
      <span class="muted model">{thread.model ?? strings.thread.noModel}</span>
    </header>

    <div class="tabs" role="tablist">
      {#each tabs as tab (tab.id)}
        <button
          class="quiet"
          role="tab"
          aria-selected={store.tab === tab.id}
          class:active={store.tab === tab.id}
          onclick={() => void select(tab.id)}
        >
          {tab.label}
        </button>
      {/each}
    </div>

    {#if store.tab === 'chat'}
      <MessageList {store} threadId={thread.id} messages={thread.messages} />
      <Composer {store} {thread} />
    {:else}
      <div class="scroll">
        <TraceTable records={store.trace} capability={store.core?.trace ?? null} />
      </div>
    {/if}
  </section>
{/if}

<style>
  .none {
    padding: 40px;
    text-align: center;
    color: var(--muted);
  }

  .thread {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  header {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 7px 14px;
    border-bottom: 1px solid var(--border);
    background: var(--panel);
  }

  .cwd,
  .model {
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cwd {
    margin-left: auto;
    max-width: 40%;
  }

  .tabs {
    display: flex;
    gap: 2px;
    padding: 4px 12px 0;
    border-bottom: 1px solid var(--border);
    background: var(--panel);
  }

  .tabs button {
    border-radius: var(--radius) var(--radius) 0 0;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
  }

  .tabs .active {
    border-bottom-color: var(--accent);
    color: var(--text);
  }

  .scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
</style>
