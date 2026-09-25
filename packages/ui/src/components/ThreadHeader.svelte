<script lang="ts">
  import { ArrowLeft, ChevronDown, GitBranch, PanelRight, SquareTerminal, UsersRound } from '@lucide/svelte';
  import { focusOnMount } from '../lib/actions';
  import { contextMenu } from '../lib/context-menu.svelte';
  import { separator, type MenuItem } from '../lib/menu';
  import { strings } from '../lib/strings';
  import { projectName } from '../lib/format';
  import type { Store } from '../lib/store.svelte';
  import ContextControl from './ContextControl.svelte';
  import Menu from './Menu.svelte';
  import StatusMark from './StatusMark.svelte';
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

  /** The title's actions: a right-click on a desktop, a tap on the title on a phone. */
  let titleItems = $derived.by((): MenuItem[] => {
    if (!thread) return [];
    const retitling = store.retitling.includes(thread.id);
    return [
      { id: 'rename', label: strings.sidebar.rename },
      { id: 'retitle', label: retitling ? strings.sidebar.retitling : strings.sidebar.retitle, disabled: retitling },
      { id: 'pin', label: thread.pinned ? strings.sidebar.unpin : strings.sidebar.pin },
      { id: 'copy', label: strings.sidebar.copyPath, hint: thread.cwd },
      separator(),
      { id: 'archive', label: strings.sidebar.archive, danger: true }
    ];
  });

  let agentsOn = $derived(store.panelOpen && store.panel.active?.kind === 'agents');

  /**
   * A phone's header has room for the title or for every toggle, not both: the
   * Agents and Terminal toggles move into the title's sheet there, ticked when on.
   */
  let phoneItems = $derived.by((): MenuItem[] => {
    if (!thread) return [];
    const toggles: MenuItem[] = [{ id: 'agents', label: strings.delegation.heading, active: agentsOn }];
    if (store.owner) toggles.push({ id: 'terminal', label: strings.terminal.title, active: store.terminalShown(thread.id) });
    return [...toggles, separator('sep-toggles'), ...titleItems];
  });

  function titleAction(action: string) {
    const open = store.openThread;
    if (!open) return;
    if (action === 'agents') store.panel.toggleKind('agents');
    else if (action === 'terminal') store.toggleTerminal();
    else if (action === 'rename') beginRename();
    else if (action === 'retitle') void store.retitle(open.id);
    else if (action === 'pin') void store.pin(open.id, !open.pinned);
    else if (action === 'copy') void store.copy(open.cwd);
    else if (action === 'archive') void store.archive(open.id);
  }

  function openTitleMenu(event: MouseEvent) {
    if (store.openThread) contextMenu.open(event, titleItems, titleAction);
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
          <!-- A phone has no right-click: the title opens the same actions as a sheet. -->
          <span class="title-menu">
            <Menu items={phoneItems} onpick={titleAction} label={strings.sidebar.threadMenu} placement="bottom" variant="text" testid="thread-menu-trigger">
              <span class="title-text">{thread.title}</span><ChevronDown size={14} />
            </Menu>
          </span>
        {/if}
      {:else}
        <span class="draft-mark"></span>
        <span class="title draft" data-testid="thread-title">{strings.sidebar.draft}</span>
      {/if}

      <span class="spacer"></span>

      <!-- A draft names its project in the heading below, so the chip would say it twice. -->
      {#if project && thread}
        <span class="chip path" title={project.path}>{projectName(project)}</span>
      {/if}
      {#if thread?.parentThreadId}
        <button type="button" class="chip parent" data-testid="delegation-back-parent" onclick={() => void store.open(thread!.parentThreadId!)}>
          <ArrowLeft size={13} strokeWidth={1.75} />
          {strings.delegation.parent}
        </button>
      {/if}
      {#if thread?.branch}
        <span class="chip path branch mono" title="{strings.thread.branchHint}: {thread.cwd}" data-testid="thread-branch">
          <GitBranch size={13} strokeWidth={1.75} />
          {thread.branch}
        </span>
      {/if}
      {#if thread}<ContextControl {store} />{/if}
      {#if thread}
        <button
          type="button"
          class="ghost trace in-title-menu"
          class:on={agentsOn}
          title={strings.delegation.panelHint}
          aria-label={strings.delegation.heading}
          aria-pressed={agentsOn}
          data-testid="agents-toggle"
          onclick={() => store.panel.toggleKind('agents')}
        >
          <UsersRound size={16} strokeWidth={1.75} />
          <span class="label">{strings.delegation.heading}</span>
        </button>
      {/if}
      <!-- Every surface of the panel reads something only the owner may ask
           for, so the button is not in a paired device's header at all. The
           shell is the same: a phone reaches it by this button, not by Ctrl+J. -->
      {#if thread && store.owner}
        {@const terminalKey = store.keyLabel('terminal')}
        <button
          type="button"
          class="ghost trace in-title-menu"
          class:on={store.terminalShown(thread.id)}
          title={terminalKey ? `${strings.thread.terminalHint} (${terminalKey})` : strings.thread.terminalHint}
          aria-label={strings.thread.terminalHint}
          aria-pressed={store.terminalShown(thread.id)}
          data-testid="terminal-toggle"
          onclick={() => store.toggleTerminal()}
        >
          <SquareTerminal size={16} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          class="ghost trace"
          class:on={store.panelOpen}
          title={strings.thread.panelHint}
          aria-label={strings.thread.panel}
          aria-pressed={store.panelOpen}
          data-testid="panel-toggle"
          onclick={() => store.togglePanel()}
        >
          <PanelRight size={16} strokeWidth={1.75} />
          <span class="label">{strings.thread.panel}</span>
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
  .parent { gap: 4px; cursor: pointer; }

  .on {
    background: var(--color-active);
    color: var(--color-foreground);
  }


  .title { min-width: 0; }
  .title-menu { display: none; }
  @media (max-width: 720px) {
    /* The title is what tells one conversation from another: the buttons give
       up their words for it, and keep a finger-sized square. */
    .thread-header { gap: 4px; }
    .path { display: none; }
    .trace { padding: 0; min-width: var(--touch-target); justify-content: center; }
    .trace .label { display: none; }
    /* The title's sheet holds these on a phone. */
    .in-title-menu { display: none; }
    .rename { width: 100%; }
    /* The thread's title button gives way to its menu; a draft's label has no menu and stays. */
    .title:not(.draft) { display: none; }
    .title.draft { max-width: none; }
    .title-menu { display: flex; min-width: 0; flex: 0 1 auto; margin-left: -6px; }
    .title-menu :global(.menu) { min-width: 0; max-width: 100%; }
    .title-menu :global(.trigger) { min-width: 0; max-width: 100%; min-height: var(--touch-target); font-weight: 600; color: var(--color-foreground); }
    .title-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .title-menu :global(.trigger svg) { flex: none; color: var(--color-muted-foreground); }
  }
</style>
