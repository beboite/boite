<script lang="ts">
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import LoadGauge from './LoadGauge.svelte';
  import NewThreadForm from './NewThreadForm.svelte';
  import StatusPill from './StatusPill.svelte';

  let { store }: { store: Store } = $props();

  let creating = $state(false);
  let addingProject = $state(false);
  let projectPath = $state('');

  async function addProject(event: SubmitEvent) {
    event.preventDefault();
    const path = projectPath.trim();
    if (path.length === 0) return;
    const project = await store.addProject(path);
    if (!project) return;
    projectPath = '';
    addingProject = false;
  }
</script>

<aside data-testid="sidebar">
  <div class="head">
    <button class="new" data-testid="new-thread" onclick={() => (creating = !creating)}>
      {strings.sidebar.newThread}
    </button>
    <button
      class="quiet add"
      data-testid="add-project"
      onclick={() => (addingProject = !addingProject)}
    >
      {strings.sidebar.addProject}
    </button>
  </div>

  <div class="scroll">
    {#if addingProject}
      <form onsubmit={addProject} data-testid="add-project-form">
        <label>
          <span>{strings.sidebar.projectPath}</span>
          <input
            data-testid="project-path"
            bind:value={projectPath}
            placeholder={strings.sidebar.projectPathPlaceholder}
          />
        </label>
        <div class="actions">
          <button
            type="submit"
            class="primary"
            data-testid="project-add"
            disabled={projectPath.trim().length === 0}
          >
            {strings.sidebar.addProjectSubmit}
          </button>
          <button type="button" class="quiet" onclick={() => (addingProject = false)}>
            {strings.newThread.cancel}
          </button>
        </div>
      </form>
    {/if}

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
          data-testid="project-row"
          data-project-id={project.id}
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
                  data-testid="thread-row"
                  data-thread-id={thread.id}
                  data-status={thread.status}
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
    display: flex;
    gap: 6px;
    padding: 6px;
    border-bottom: 1px solid var(--border);
  }

  .new {
    flex: 1;
    border-color: var(--accent);
    color: var(--accent);
    background: transparent;
  }

  .new:hover {
    background: var(--accent-soft);
  }

  .add {
    flex: none;
  }

  form {
    display: grid;
    gap: 6px;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--panel);
    margin-bottom: 8px;
  }

  form input {
    width: 100%;
  }

  .actions {
    display: flex;
    gap: 6px;
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
