<script lang="ts">
  import { tick } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import { ArrowLeft, ChevronDown, FolderInput, GitBranch, Network, PanelRight, SquareTerminal } from '@lucide/svelte';
  import { focusOnMount } from '../lib/actions';
  import { contextMenu } from '../lib/context-menu.svelte';
  import { archiveThread } from '../lib/archive';
  import { canDeleteThread, deleteThread } from '../lib/thread-removal';
  import { moveItems, pendingLine, pickMoveItem } from '../lib/thread-move.svelte';
  import { separator, type MenuItem } from '../lib/menu';
  import { strings } from '../lib/strings';
  import { work } from '../lib/work-prefs.svelte';
  import { controlMenu } from '../lib/controls';
  import type { Store } from '../lib/store.svelte';
  import Menu from './Menu.svelte';
  import CoordinationDialog from './CoordinationDialog.svelte';
  import RemoteBrowser from './RemoteBrowser.svelte';
  let { store }: { store: Store } = $props();
  let thread = $derived(store.openThread);
  const mobile = new MediaQuery('(max-width: 720px)');
  let renaming = $state(false);
  let renameText = $state('');
  let coordinationThreadId = $state<string | null>(null);
  $effect(() => {
    if (thread?.id !== coordinationThreadId) coordinationThreadId = null;
  });

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

  let titleButton = $state<HTMLButtonElement | undefined>(undefined);

  /** Enter and Escape give the keyboard back to the title, never to the page, where Escape stops the turn. */
  async function onRenameKey(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      void commitRename();
    } else if (event.key === 'Escape') {
      renaming = false;
    } else return;
    await tick();
    titleButton?.focus({ preventScroll: true });
  }

  /** The title's actions: a right-click on a desktop, a tap on the title on a phone. */
  let titleItems = $derived.by((): MenuItem[] => {
    if (!thread) return [];
    const retitling = store.retitling.includes(thread.id);
    return [
      { id: 'rename', label: strings.sidebar.rename },
      { id: 'retitle', label: retitling ? strings.sidebar.retitling : strings.sidebar.retitle, disabled: retitling },
      { id: 'pin', label: thread.pinned ? strings.sidebar.unpin : strings.sidebar.pin },
      { id: 'copy', label: strings.sidebar.copyPath, title: thread.cwd },
      ...(!thread.agentSessionId ? [{ id: 'coordination', label: strings.coordination.heading, glyph: Network }] : []),
      // A phone has no Ctrl+F: this sheet is its way to the find bar.
      { id: 'find', label: strings.keyboard.commands.find },
      ...(thread.parentThreadId || thread.projectId === null ? [] : moveItems(store, thread)),
      separator(),
      { id: 'archive', label: strings.sidebar.archive },
      ...(canDeleteThread(store, thread) ? [{ id: 'delete', label: strings.sidebar.delete, danger: true }] : [])
    ];
  });

  let agentsOn = $derived(store.panelOpen && store.panel.active?.kind === 'agents');


  /**
   * A phone's header has room for the title or for every toggle, not both: the
   * Agents and Terminal toggles move into the title's sheet there, ticked when on.
   */
  let phoneItems = $derived.by((): MenuItem[] => {
    if (!thread) return [];
    const toggles: MenuItem[] = [];
    toggles.push({ id: 'agents', label: strings.delegation.heading, active: agentsOn });
    if (store.owner && work.shows('header.terminal')) toggles.push({ id: 'terminal', label: strings.terminal.title, active: store.terminalShown(thread.id) });
    return toggles.length ? [...toggles, separator('sep-toggles'), ...titleItems] : titleItems;
  });

  function titleAction(action: string) {
    const open = store.openThread;
    if (!open) return;
    if (action === 'coordination') coordinationThreadId = open.id;
    else if (action === 'agents') store.panel.toggleKind('agents');
    else if (action === 'terminal') store.toggleTerminal();
    else if (action === 'rename') beginRename();
    else if (action === 'retitle') void store.retitle(open.id);
    else if (action === 'pin') void store.pin(open.id, !open.pinned);
    else if (action === 'copy') void store.copy(open.cwd);
    else if (action === 'find') {
      store.findOpen = true;
      store.findRequest += 1;
    }
    // From a phone's sheet the picker hangs under the title; from a right-click, where that menu stood.
    else if (pickMoveItem(store, open, action, document.querySelector<HTMLElement>('[data-testid="thread-menu-trigger"]'))) return;
    else if (action === 'archive') void archiveThread(store, open.id);
    else if (action === 'delete') void deleteThread(store, open);
  }

  // Subagents has no header button: the title's menu and the side panel open it.
  let desktopItems = $derived([{ id: 'agents', label: strings.delegation.heading, active: agentsOn }, separator('sep-team'), ...titleItems]);

  function openTitleMenu(event: MouseEvent) {
    if (!store.openThread) return;
    contextMenu.open(event, desktopItems, titleAction);
  }

</script>

<div class="thread-header" data-testid="thread-header" data-status={thread?.status}>
      {#if thread}
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
            bind:this={titleButton}
            data-testid="thread-title"
            title={strings.sidebar.rename}
            onclick={beginRename}
            oncontextmenu={openTitleMenu}
          >
            {thread.title}
          </button>
          <!-- A small chevron exposes thread actions; on phones it also holds the title. -->
          <span class="title-menu">
            <Menu items={mobile.current ? phoneItems : desktopItems} onpick={titleAction} label={strings.sidebar.threadMenu} placement="bottom" variant="text" testid="thread-menu-trigger">
              <span class="title-text">{thread.title}</span><ChevronDown size={14} />
            </Menu>
          </span>
        {/if}
        {@const pending = pendingLine(thread)}
        {#if pending}
          <!-- A move asked for while the turn runs. A phone keeps only the mark; its sidebar row carries the words. -->
          <span class="pending" data-testid="thread-pending" title={pending} aria-label={pending}>
            <FolderInput size={13} strokeWidth={1.75} /><span class="pending-text">{pending}</span>
          </span>
        {/if}
      {:else}
        <span class="draft-mark"></span>
        <span class="title draft" data-testid="thread-title">{strings.sidebar.draft}</span>
      {/if}

      <span class="spacer"></span>
      {#if thread}{#key store.threadKey(thread.id)}<RemoteBrowser {store} threadId={thread.id} />{/key}{/if}

      {#if thread?.parentThreadId}
        <button type="button" class="chip parent" data-testid="delegation-back-parent" onclick={() => void store.open(thread!.parentThreadId!)}>
          <ArrowLeft size={13} strokeWidth={1.75} />
          {strings.delegation.parent}
        </button>
      {/if}
      {#if thread?.branch && work.shows('header.branch')}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <span class="chip path branch mono" title="{thread.branch}: {strings.thread.branchHint}: {thread.cwd}" data-testid="thread-branch" oncontextmenu={(event) => controlMenu(event, store, 'header.branch')}>
          <GitBranch size={13} strokeWidth={1.75} />
          <span class="branch-name">{thread.branch}</span>
        </span>
      {/if}
      <!-- The shell is the owner's: a phone reaches it by this button, not by Ctrl+J. -->
      {#if thread && store.owner}
        {@const terminalKey = store.keyLabel('terminal')}
        {#if work.shows('header.terminal')}
        <button
          type="button"
          class="ghost trace in-title-menu"
          class:on={store.terminalShown(thread.id)}
          title={terminalKey ? `${strings.thread.terminalHint} (${terminalKey})` : strings.thread.terminalHint}
          aria-label={strings.thread.terminalHint}
          aria-pressed={store.terminalShown(thread.id)}
          data-testid="terminal-toggle"
          onclick={() => store.toggleTerminal()}
          oncontextmenu={(event) => controlMenu(event, store, 'header.terminal')}
        >
          <SquareTerminal size={16} strokeWidth={1.75} />
        </button>
        {/if}
      {/if}
      <!-- A paired device opens the panel too: the Agents and Workflows surfaces are
           its to follow, and the panel's menu offers only what available() allows. -->
      {#if thread}
        <button
          type="button"
          class="ghost icon"
          class:on={store.panelOpen}
          title={`${strings.thread.panelHint}${store.keyHint('panel')}`}
          aria-label={strings.thread.panelHint}
          aria-pressed={store.panelOpen}
          data-testid="panel-toggle"
          onclick={() => store.togglePanel()}
        >
          <PanelRight size={16} strokeWidth={1.75} />
        </button>
      {/if}
</div>

{#if coordinationThreadId && thread?.id === coordinationThreadId}
  <CoordinationDialog {store} threadId={coordinationThreadId} onclose={() => coordinationThreadId = null} />
{/if}

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
    flex: 0 1 auto;
    min-width: 0;
    max-width: min(240px, 35%);
    font-size: var(--text-sm);
  }

  .branch-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .branch :global(svg) { flex: none; }

  .trace {
    flex: none;
    padding: 0 10px 0 8px;
  }
  .parent { gap: 4px; cursor: pointer; }

  .on {
    background: var(--color-active);
    color: var(--color-foreground);
  }


  .pending {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: 0 1 auto;
    min-width: 0;
    font-size: var(--text-sm);
    color: var(--color-accent);
  }
  .pending :global(svg) { flex: none; }
  .pending-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .title { min-width: 0; }
  .title-menu { display: flex; flex: none; }
  .title-text { display: none; }
  @media (max-width: 720px) {
    /* The title is what tells one conversation from another: the buttons give
       up their words for it, and keep a finger-sized square. */
    .thread-header { gap: 4px; }
    .path { display: none; }
    .pending { flex: none; min-width: var(--touch-target); justify-content: center; }
    .pending-text { display: none; }
    .trace { padding: 0; min-width: var(--touch-target); justify-content: center; }
    /* The title's sheet holds these on a phone. */
    .in-title-menu { display: none; }
    .rename { width: 100%; }
    /* The thread's title button gives way to its menu; a draft's label has no menu and stays. */
    .title:not(.draft) { display: none; }
    .title.draft { max-width: none; }
    .title-menu { display: flex; min-width: 0; flex: 0 1 auto; margin-left: -6px; }
    .title-menu :global(.menu) { min-width: 0; max-width: 100%; }
    .title-menu :global(.trigger) { min-width: 0; max-width: 100%; min-height: var(--touch-target); font-weight: 600; color: var(--color-foreground); }
    .title-text { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .title-menu :global(.trigger svg) { flex: none; color: var(--color-muted-foreground); }
  }
</style>
