<script lang="ts">
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import LoadGauge from './LoadGauge.svelte';
  import NewThreadForm from './NewThreadForm.svelte';
  import StatusPill from './StatusPill.svelte';

  let { store }: { store: Store } = $props();

  let creating = $state(false);
</script>

<aside>
  <div class="head">
    <button class="new" onclick={() => (creating = !creating)}>
      {strings.sidebar.newThread}
    </button>
  </div>

  <div class="scroll">
    {#if creating}
      <NewThreadForm {store} done={() => (creating = false)} />
    {/if}

    {#if store.projects.length === 0}
      <p class="empty">{strings.sidebar.noProjects}</p>
    {/if}

    {#each store.projects as project (project.id)}
      {@const threads = store.threadsOf(project.id)}
      {@const collapsed = store.isCollapsed(project.id)}
      <section>
        <button
          class="quiet project"
          aria-expanded={!collapsed}
          title={project.path}
          onclick={() => store.toggleProject(project.id)}
        >
          <span class="caret" class:collapsed>&rsaquo;</span>
          <span class="name">{project.name}</span>
          <span class="count">{threads.length}</span>
        </button>

        {#if !collapsed}
          {#if threads.length === 0}
            <p class="empty small">{strings.sidebar.noThreads}</p>
          {/if}
          <ul>
            {#each threads as thread (thread.id)}
              <li>
                <button
                  class="quiet thread"
                  class:open={store.openThread?.id === thread.id}
                  onclick={() => void store.open(thread.id)}
                >
                  {#if thread.unread}
                    <span class="dot" title={strings.sidebar.unread}></span>
                  {/if}
                  <span class="title">{thread.title}</span>
                  {#if thread.load}
                    <LoadGauge load={thread.load} />
                  {/if}
                  <StatusPill status={thread.status} />
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/each}
  </div>
</aside>

<style>
  aside {
    width: var(--sidebar);
    flex: none;
    border-right: 1px solid var(--border);
    background: var(--panel);
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .head {
    padding: 6px;
    border-bottom: 1px solid var(--border);
  }

  .new {
    width: 100%;
    border-color: var(--accent);
    color: var(--accent);
    background: transparent;
  }

  .new:hover {
    background: var(--accent-soft);
  }

  .scroll {
    overflow: auto;
    padding: 6px;
    flex: 1;
    min-height: 0;
  }

  .project {
    display: flex;
    align-items: center;
    gap: 5px;
    width: 100%;
    padding: 2px 4px;
    font-weight: 600;
  }

  .caret {
    display: inline-block;
    transform: rotate(90deg);
    transition: transform 80ms linear;
    color: var(--muted);
  }

  .caret.collapsed {
    transform: none;
  }

  .name {
    flex: 1;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .count {
    color: var(--muted);
    font-weight: 400;
    font-size: 11px;
  }

  ul {
    list-style: none;
    margin: 0 0 6px;
    padding: 0 0 0 10px;
  }

  .thread {
    display: flex;
    align-items: center;
    gap: 5px;
    width: 100%;
    min-height: var(--row);
    padding: 2px 4px;
    text-align: left;
  }

  .thread.open {
    background: var(--accent-soft);
    color: var(--text);
  }

  .title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    flex: none;
  }

  .small {
    padding: 2px 10px;
    font-size: 11px;
  }
</style>
