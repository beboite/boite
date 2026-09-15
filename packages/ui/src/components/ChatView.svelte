<script lang="ts">
  import { Activity, ChevronDown, GitBranch, PanelLeft } from '@lucide/svelte';
  import type { ProjectId } from '@boite/contracts';
  import { focusOnMount } from '../lib/actions';
  import { contextMenu } from '../lib/context-menu.svelte';
  import { separator, type MenuItem } from '../lib/menu';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import ContextControl from './ContextControl.svelte';
  import Composer from './Composer.svelte';
  import Menu from './Menu.svelte';
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

  /** The drawer on a phone, the folded sidebar on a desktop. */
  function toggleSidebar() {
    if (window.matchMedia('(max-width: 720px)').matches) store.sidebarOpen = !store.sidebarOpen;
    else store.toggleSidebar();
  }

  let thread = $derived(store.openThread);
  let project = $derived(store.openProject);
  let draftChoice = $derived(store.defaultChoice());
  let draftModel = $derived(store.modelOf(draftChoice));
  let draftProvider = $derived(draftChoice ? store.providerOf(draftChoice.providerId) : null);
  let draftEffort = $derived(draftChoice?.effort ?? draftModel?.effort?.default ?? null);
  let effortLabel = $derived(draftModel?.effort?.levels.find((level) => level.id === draftEffort)?.label ?? draftEffort);
  let modelLabel = $derived(draftModel?.name ?? draftChoice?.model ?? draftProvider?.name ?? '');

  /** Every project, the draft's own marked: what the heading's dropdown lists. */
  let projectItems = $derived<MenuItem[]>(
    store.projects.map((entry) => ({
      id: entry.id,
      label: entry.name,
      hint: entry.path,
      active: entry.id === store.draft?.projectId
    }))
  );

  function pickProject(id: string) {
    store.setDraftProject(id as ProjectId);
  }
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
        class:shown={store.sidebarCollapsed}
        title="{strings.sidebar.expand}{store.keyHint('sidebar')}"
        aria-label={strings.sidebar.expand}
        data-testid="sidebar-toggle"
        onclick={toggleSidebar}
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
        <span class="chip path mono" title={project.path}>{project.name}</span>
      {/if}
      {#if thread?.branch}
        <span class="chip path branch mono" title="{strings.thread.branchHint}: {thread.cwd}" data-testid="thread-branch">
          <GitBranch size={12} strokeWidth={1.75} />
          {thread.branch}
        </span>
      {/if}
      {#if thread}<ContextControl {store} />{/if}
      <!-- `trace.get` is the owner's, so the button that opens the trace surface
           is not in the device's header at all. -->
      {#if thread && store.owner}
        <button
          type="button"
          class="ghost trace"
          class:on={store.panelOpen}
          title={strings.thread.traceHint}
          aria-pressed={store.panelOpen}
          data-testid="tab-trace"
          onclick={() => store.togglePanel()}
        >
          <Activity size={16} strokeWidth={1.75} />
          {strings.thread.trace}
        </button>
      {/if}
    </header>

    {#if thread}
      <!-- One timeline per thread: the heights it measured and the ids that
           already played the rise belong to that thread alone, and kept across
           a switch they grew for every message the page had ever shown. -->
      {#key thread.id}
        <MessageList {store} threadId={thread.id} messages={thread.messages} />
      {/key}
    {:else}
      <div class="draft-body" data-testid="draft-empty">
        <h1 class="start" data-testid="draft-sentence">
          <span>{strings.thread.start}</span>
          {#if store.draft?.worktree}<span>{strings.thread.inWorktree}</span>{/if}
          {#if draftChoice}<span>{strings.thread.draftMode[draftChoice.permissionMode]}</span>{/if}
          <span>{strings.thread.inProject}</span>
          <!-- It opens upward, into the empty half of the column: under the
               heading it would land on the composer. -->
          <Menu
            items={projectItems}
            onpick={pickProject}
            variant="text"
            label={strings.thread.changeProject}
            testid="draft-project"
          >
            &quot;{project?.name ?? ''}&quot;
            <ChevronDown size={14} strokeWidth={2} />
          </Menu>
          {#if draftChoice}
            <span>{strings.thread.using} {modelLabel}</span>
            {#if effortLabel}<span>{fill(strings.thread.onEffort, { effort: effortLabel })}</span>{/if}
          {/if}
        </h1>
      </div>
    {/if}

    <Composer {store} centered={!thread} />

    <!-- The draft's heading and composer are one block in the middle of the
         column: the body above and this tail below share the free space. -->
    {#if !thread}
      <div class="draft-tail"></div>
    {/if}
  </section>
{/if}

<style>
  .none {
    margin: auto;
    padding: 40px;
    text-align: center;
    color: var(--color-muted-foreground);
    animation: rise var(--dur-3) var(--ease-out-quint);
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
    margin-left: -6px;
  }

  .drawer.shown {
    display: inline-flex;
  }

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

  .branch {
    color: var(--color-foreground);
  }

  .trace {
    flex: none;
    padding: 0 10px 0 8px;
  }

  .on {
    background: var(--color-active);
    color: var(--color-foreground);
  }

  /* Zero basis on both halves, so the heading sits exactly as far below the
     top as the composer sits above the bottom: one centred block. */
  .draft-body {
    flex: 1 1 0;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    padding: 24px 20px 16px;
    animation: rise var(--dur-3) var(--ease-out-quint);
  }

  .draft-tail {
    flex: 1 1 0;
    min-height: 0;
  }

  .start {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: 2px 5px;
    width: 100%;
    max-width: var(--content);
    font-size: var(--text-lg);
    font-weight: 600;
    color: var(--color-foreground);
    text-align: center;
    line-height: 1.6;
  }

  @media (max-width: 720px) {
    .drawer {
      display: inline-flex;
    }

    .path {
      display: none;
    }

    .draft-body {
      padding: 16px 10px;
    }
  }
</style>
