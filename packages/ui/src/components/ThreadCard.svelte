<script lang="ts">
  import { untrack } from 'svelte';
  import { Ellipsis, Folder, GitPullRequest, Pin } from '@lucide/svelte';
  import type { Project, ThreadSummary } from '@boite/contracts';
  import type { Machine } from '../lib/workspace.svelte';
  import { workspace } from '../lib/workspace.svelte';
  import { contextMenu } from '../lib/context-menu.svelte';
  import { separator } from '../lib/menu';
  import { focusOnMount } from '../lib/actions';
  import { strings } from '../lib/strings';
  import { ago } from '../lib/format';
  import MachineIcon from './MachineIcon.svelte';
  import StatusMark from './StatusMark.svelte';
  import LoadGauge from './LoadGauge.svelte';
  let { machine, project, thread, now }: { machine: Machine; project: Project; thread: ThreadSummary; now: number } =
    $props();
  let owner = $derived(machine.store);
  let open = $derived(workspace.active === owner && owner.openThread?.id === thread.id);
  let renaming = $state(false);
  let title = $state('');
  let pullRequest = $state<ThreadSummary['pullRequest']>(null);

  let prLoading = $state(false);
  async function refreshPr() {
    if (!owner.client || prLoading) return;
    prLoading = true;
    try {
      pullRequest = await owner.client.call('threads.pullRequest', { threadId: thread.id });
    } catch (error) {
      owner.error = error instanceof Error ? error.message : String(error);
    } finally {
      prLoading = false;
    }
  }
  $effect(() => {
    if (owner.connection === 'ready') untrack(() => void refreshPr());
  });
  function rename() {
    title = thread.title;
    renaming = true;
  }
  async function save() {
    if (!renaming) return;
    renaming = false;
    await owner.rename(thread.id, title);
  }
  function menu(event: MouseEvent) {
    contextMenu.open(
      event,
      [
        { id: 'open', label: strings.sidebar.open, disabled: open },
        { id: 'rename', label: strings.sidebar.rename },
        {
          id: 'retitle',
          label: owner.retitling.includes(thread.id) ? strings.sidebar.retitling : strings.sidebar.retitle,
          disabled: owner.retitling.includes(thread.id)
        },
        { id: 'pin', label: thread.pinned ? strings.sidebar.unpin : strings.sidebar.pin },
        { id: 'pr', label: strings.machines.refreshPr, disabled: prLoading },
        separator(),
        { id: 'archive', label: strings.sidebar.archive, danger: true }
      ],
      (action) => {
        if (action === 'open') void workspace.select(owner, thread.id);
        if (action === 'rename') rename();
        if (action === 'retitle') void owner.retitle(thread.id);
        if (action === 'pin') void owner.pin(thread.id, !thread.pinned);
        if (action === 'pr') void refreshPr();
        if (action === 'archive') void owner.archive(thread.id);
      }
    );
  }
</script>

{#if renaming}
  <input
    class="rename"
    data-testid="thread-rename"
    bind:value={title}
    use:focusOnMount
    onblur={() => void save()}
    onkeydown={(event) => {
      if (event.key === 'Enter') void save();
      if (event.key === 'Escape') renaming = false;
    }}
  />
{:else}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="thread" class:open class:unread={thread.unread} class:pinned={thread.pinned} oncontextmenu={menu}>
    <button
      type="button"
      class="ghost row"
      data-testid="thread-row"
      data-thread-id={thread.id}
      data-machine-id={machine.id}
      data-status={thread.status}
      data-pinned={thread.pinned ? 'true' : undefined}
      title={thread.title}
      onclick={() => void workspace.select(owner, thread.id)}
      ondblclick={rename}
    >
      <span class="headline"
        ><StatusMark status={thread.status} unread={thread.unread} />
        <span class="title">{thread.title}</span>
        {#if thread.load}<LoadGauge load={thread.load} />{/if}
        {#if thread.pinned}<Pin size={12} />{/if}
        <span class="when">{ago(thread.lastUserMessageAt ?? thread.createdAt, now)}</span>
      </span>
    </button>
    <div class="metadata">
      <span class="project-name" title={project.path}><Folder size={12} /><span>{project.name}</span></span>
      {#if pullRequest}
        <a class="pr-link" data-testid="thread-pr" href={pullRequest.url} target="_blank" rel="noopener noreferrer"
          title={pullRequest.url} aria-label={`#${pullRequest.number}`}><GitPullRequest size={12} />#{pullRequest.number}</a>
      {/if}
      <span class="machine" class:offline={owner.connection !== 'ready'}
        title={`${machine.label} · ${strings.connection[owner.connection]}`} aria-label={machine.label}>
        <MachineIcon icon={machine.icon} os={owner.core?.os} />
      </span>
    </div>
    <button
      type="button"
      class="ghost small icon actions"
      data-testid="thread-menu"
      aria-label={strings.sidebar.threadMenu}
      title={strings.sidebar.threadMenu}
      onclick={menu}><Ellipsis size={15} /></button
    >
  </div>
{/if}

<style>
  .thread {
    position: relative;
    border-radius: var(--radius-md);
    transition: background var(--dur-2) var(--ease-out-quint);
  }
  .thread:hover {
    background: var(--color-hover);
  }
  .thread.open {
    background: var(--color-active);
  }
  .row {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    width: 100%;
    height: auto;
    min-height: calc(var(--row) + 22px);
    padding: 9px 10px 28px;
    gap: 7px;
    background: transparent;
  }
  .row:hover:not(:disabled) {
    background: transparent;
  }
  .row:active:not(:disabled) {
    transform: none;
  }
  .headline {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .title {
    flex: 1;
    min-width: 0;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-foreground);
    font-weight: 400;
  }
  .unread .title {
    font-weight: 600;
  }
  .when {
    font-size: var(--text-xs);
    color: var(--color-subtle);
    font-variant-numeric: tabular-nums;
  }
  .metadata {
    display: flex;
    align-items: center;
    gap: 9px;
    position: absolute;
    bottom: 9px;
    left: 28px;
    right: 10px;
    pointer-events: none;
    min-width: 0;
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
  }
  .metadata > span {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }
  .metadata span span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .metadata :global(svg) {
    flex: none;
  }
  .pr-link {
    display: flex;
    flex: none;
    gap: 4px;
    align-items: center;
    pointer-events: auto;
    font-size: var(--text-xs);
    color: var(--color-success);
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .project-name {
    flex: 1;
  }
  .machine {
    flex: none;
    pointer-events: auto;
  }
  .machine.offline {
    color: var(--color-danger);
  }
  .actions {
    position: absolute;
    right: 5px;
    top: 5px;
    opacity: 0;
    background: var(--color-surface-2);
  }
  .thread:hover .actions,
  .thread:focus-within .actions {
    opacity: 1;
  }
  .thread:hover .when,
  .thread:focus-within .when {
    opacity: 0;
  }
  .rename {
    width: 100%;
    height: calc(var(--row) + 22px);
  }
  @media (max-width: 720px) {
    .actions {
      opacity: 1;
    }
    .when {
      margin-right: 22px;
    }
  }
</style>
