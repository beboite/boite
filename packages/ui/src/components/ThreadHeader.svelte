<script lang="ts">
  import AgentAvatar from './agents/AgentAvatar.svelte';
  import { openResident, residentOfThread } from '../lib/resident';
  import { agentDirectory } from '../lib/agent-directory.svelte';
  import { entrust } from '../lib/thread-entrust';
  import { tick } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import { ChevronDown, FolderInput, GitBranch, GitPullRequest, Network, PanelRight, Search, SquareTerminal, UsersRound, VenetianMask } from '@lucide/svelte';
  import { focusOnMount } from '../lib/actions';
  import { contextMenu } from '../lib/context-menu.svelte';
  import { pendingLine } from '../lib/thread-move.svelte';
  import { pickThreadAction, threadMenuItems } from '../lib/thread-menu';
  import { separator, type MenuItem } from '../lib/menu';
  import { fill, strings } from '../lib/strings';
  import { work } from '../lib/work-prefs.svelte';
  import { controlMenu } from '../lib/controls';
  import type { Store } from '../lib/store.svelte';
  import Menu from './Menu.svelte';
  import { watchStatus } from '../lib/pull-request-watch';
  import ContextModeBadge from './ContextModeBadge.svelte';
  import CoordinationDialog from './CoordinationDialog.svelte';
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

  let agentsOn = $derived(store.panelOpen && store.panel.active?.kind === 'agents');
  let tools = $derived.by((): MenuItem[] => {
    if (!thread) return [];
    return [
      // A phone has no Ctrl+F: this sheet is its way to the find bar.
      { id: 'find', label: strings.keyboard.commands.find, glyph: Search },
      { id: 'agents', label: strings.delegation.heading, glyph: UsersRound, active: agentsOn },
      ...(!thread.agentSessionId ? [{ id: 'coordination', label: strings.coordination.heading, glyph: Network }] : [])
    ];
  });
  let desktopItems = $derived(thread ? threadMenuItems(store, thread, { tools }) : []);

  /** Children delegated from this thread, at work or done: the phone offers Subagents only then. */
  let delegated = $derived(!!thread && (store.subagents(thread.id) !== null || store.threads.some(row => row.parentThreadId === thread!.id)));
  /**
   * A phone's header is the title and this one menu: the panel, ticked when
   * open, then the thread's own actions. The terminal, the coordination and
   * what only the desktop does with a thread stay there.
   */
  let phoneItems = $derived.by((): MenuItem[] => {
    if (!thread) return [];
    return [
      { id: 'panel', label: strings.thread.panelMenu, glyph: PanelRight, active: store.panelOpen },
      separator('sep-panel'),
      ...threadMenuItems(store, thread, { phone: true, tools: [
        { id: 'find', label: strings.keyboard.commands.find, glyph: Search },
        ...(delegated || agentsOn ? [{ id: 'agents', label: strings.delegation.heading, glyph: UsersRound, active: agentsOn }] : [])
      ] })
    ];
  });

  function titleAction(action: string) {
    const open = store.openThread;
    if (!open) return;
    if (action === 'coordination') coordinationThreadId = open.id;
    else if (action === 'panel') store.togglePanel();
    else if (action === 'agents') store.panel.toggleKind('agents');
    else if (action === 'find') {
      store.findOpen = true;
      store.findRequest += 1;
    }
    // From a phone's sheet the pickers hang under the title; from a right-click, where that menu stood.
    else pickThreadAction(store, open, action, { rename: beginRename, anchor: () => document.querySelector<HTMLElement>('[data-testid="thread-menu-trigger"]') });
  }

  function openTitleMenu(event: MouseEvent) {
    if (!store.openThread) return;
    contextMenu.open(event, desktopItems, titleAction);
  }

  function carrierMenu(anchor: HTMLElement) {
    const held = carrier, open = store.openThread;
    if (!held || !open) return;
    const rect = anchor.getBoundingClientRect();
    contextMenu.show({ x: rect.left, y: rect.bottom }, [
      { id: 'open', label: fill(strings.agents.openAgent, { name: held.agent.name }) },
      ...(store.owner ? [{ id: 'back', label: strings.agents.takeBack }] : [])
    ], id => { if (id === 'open') store.showAgents(held.agent.id); else void entrust(store, open.id, null); }, anchor);
  }
  /** The agent this thread was entrusted to, if any. */
  let carrier = $derived(thread ? agentDirectory(store).entrustmentOf(thread.id) : null);
  /** A subagent's header starts with the conversation that started it: "parent / subagent". */
  let parentTitle = $derived(thread?.parentThreadId ? store.threads.find(entry => entry.id === thread!.parentThreadId)?.title ?? strings.delegation.parent : null);
  /** The agent the owner entrusted this thread's project to, when the thread itself is not entrusted. */
  let resident = $derived(thread ? residentOfThread(store, thread) : null);
</script>

<div class="thread-header" data-testid="thread-header" data-status={thread?.status}>
      {#if thread}
        {#if thread.parentThreadId}
          {@const parentId = thread.parentThreadId}
          <button type="button" class="ghost crumb" data-testid="delegation-back-parent" data-preload-thread={parentId} title={strings.delegation.parent} onclick={() => void store.open(parentId)}>
            <span class="ui-label">{parentTitle}</span>
          </button>
          <span class="crumb-sep" aria-hidden="true">/</span>
        {/if}
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
            title={strings.common.rename}
            onclick={beginRename}
            oncontextmenu={openTitleMenu}
          >
            <span class="ui-label">{thread.title}</span>
          </button>
          <!-- A small chevron exposes thread actions; on phones it also holds the title. -->
          <span class="title-menu">
            <Menu items={mobile.current ? phoneItems : desktopItems} onpick={titleAction} label={strings.sidebar.threadMenu} placement="bottom" variant="text" testid="thread-menu-trigger">
              <span class="title-text ui-label">{thread.title}</span><ChevronDown size={14} />
            </Menu>
          </span>
        {/if}
        {@const pending = pendingLine(thread)}
        {#if pending}
          <!-- A move asked for while the turn runs. A phone keeps only the mark; its sidebar row carries the words. -->
          <span class="pending" data-testid="thread-pending" title={pending} aria-label={pending}>
            <FolderInput size={13} strokeWidth={1.75} /><span class="pending-text ui-label">{pending}</span>
          </span>
        {/if}
      {:else}
        <span class="draft-mark"></span>
        <span class="title draft" data-testid="thread-title"><span class="ui-label">{strings.sidebar.draft}</span></span>
      {/if}

      <span class="spacer"></span>

      <!-- Incognito is chosen before the first send, in the drafts only. -->
      {#if !thread && store.draftInDrafts}
        {@const on = store.draft?.incognito === true}
        <button
          type="button"
          class="ghost trace"
          class:on
          title={on ? strings.drafts.incognitoStop : strings.drafts.incognitoStart}
          aria-label={strings.drafts.incognito}
          aria-pressed={on}
          data-testid="draft-incognito"
          onclick={() => store.setDraftIncognito(!on)}
        >
          <VenetianMask size={16} strokeWidth={1.75} />
          <span class="label">{strings.drafts.incognito}</span>
        </button>
      {:else if thread?.incognito}
        <span class="chip incognito" title={strings.drafts.incognitoOn} aria-label={strings.drafts.incognitoOn} data-testid="thread-incognito">
          <VenetianMask size={13} strokeWidth={1.75} />
          <span class="label">{strings.drafts.incognito}</span>
        </span>
      {/if}

      {#if thread?.contextMode}
        <span class="context-chip"><ContextModeBadge mode={thread.contextMode} testid="thread-context-mode" /></span>
      {/if}

      {#if carrier}
        <!-- The agent this thread was entrusted to: its menu opens the agent or takes the thread back. -->
        <button type="button" class="chip entrusted" title={fill(strings.agents.entrustedTo, { name: carrier.agent.name })} data-testid="thread-entrusted-chip"
          onclick={(event) => carrierMenu(event.currentTarget)}>
          <AgentAvatar kind="profile" id={carrier.agent.id} name={carrier.agent.name} avatar={carrier.agent.avatar} size={16} />
          <span class="chip-name ui-label">{fill(strings.agents.entrustedTo, { name: carrier.agent.name })}</span>
        </button>
      {/if}
      {#if resident}
        <!-- The agent that looks after this thread's project: a click opens its conversation. -->
        <button type="button" class="chip resident" title={fill(strings.resident.lookedAfterBy, { name: resident.name })}
          aria-label={fill(strings.resident.lookedAfterBy, { name: resident.name })} data-testid="thread-resident-chip" data-agent-id={resident.id}
          onclick={() => openResident(store, resident!.id)}>
          <AgentAvatar kind="profile" id={resident.id} name={resident.name} avatar={resident.avatar} size={16} />
          <span class="chip-name ui-label">{fill(strings.resident.lookedAfterBy, { name: resident.name })}</span>
        </button>
      {/if}
      {#if thread && (thread.pullRequestWatches?.length ?? 0) > 0}
        {@const watches = thread.pullRequestWatches ?? []}
        <!-- What a watch saw and its Stop, on a phone too: a paired phone has no Tasks panel. -->
        <span class="watch-chip" data-testid="thread-watches">
          <Menu
            items={watches.map((watch): MenuItem => ({ id: watch.url, label: fill(strings.tasks.stopWatchOf, { number: String(watch.number) }), hint: watchStatus(watch), title: watch.url, glyph: GitPullRequest }))}
            onpick={(url) => void store.unwatchPullRequest(thread.id, url)}
            label={strings.tasks.watchSection}
            placement="bottom"
            testid="thread-watches-trigger"
          >
            <GitPullRequest size={13} strokeWidth={1.75} /><span class="ui-label">{watches.map((watch) => `#${watch.number}`).join(' ')}</span>
          </Menu>
        </span>
      {/if}
      {#if thread?.branch && work.shows('header.branch')}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <span class="chip path branch mono" title="{thread.branch}: {strings.thread.branchHint}: {thread.cwd}" data-testid="thread-branch" oncontextmenu={(event) => controlMenu(event, store, 'header.branch')}>
          <GitBranch size={13} strokeWidth={1.75} />
          <span class="branch-name ui-label">{thread.branch}</span>
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
          class="ghost icon in-title-menu"
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
    display: flex;
    align-items: center;
  }

  .title > .ui-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

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

  .resident { flex: 0 1 auto; min-width: 0; max-width: 220px; gap: 6px; padding-left: 4px; border-color: color-mix(in oklch, var(--color-resident) 45%, transparent); background: var(--color-resident-soft); color: var(--color-resident); cursor: pointer; }
  .entrusted { flex: 0 1 auto; min-width: 0; max-width: 220px; gap: 6px; padding-left: 4px; border-color: color-mix(in oklch, var(--color-accent) 40%, transparent); background: var(--color-accent-soft); color: var(--color-accent); cursor: pointer; }
  .chip-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .branch-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .branch :global(svg) { flex: none; }
  .watch-chip { flex: none; display: inline-flex; color: var(--color-accent); }
  .watch-chip :global(svg) { flex: none; }

  .trace {
    flex: none;
    padding: 0 10px 0 8px;
  }
  /* The parent's title, muted, then a slash: the subagent's own title reads last, in full weight. */
  .crumb {
    flex: 0 1 auto;
    min-width: 0;
    max-width: 30%;
    height: var(--control);
    padding: 0 6px;
    margin-left: -6px;
    color: var(--color-muted-foreground);
    font-weight: 500;
  }
  .crumb > .ui-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .crumb:hover { color: var(--color-foreground); }
  .crumb-sep { flex: none; margin: 0 -4px; color: var(--color-subtle); }
  .crumb-sep + .title { margin-left: 0; }
  .incognito { gap: 4px; flex: none; }
  .context-chip { display: contents; }

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
    .trace .label, .incognito .label, .context-chip :global(.label) { display: none; }
    .context-chip :global(.chip) { min-width: var(--touch-target); justify-content: center; }
    .resident { flex: none; padding: 0; min-width: var(--touch-target); justify-content: center; }
    .resident .chip-name { display: none; }
    /* The title's sheet holds these on a phone. */
    .in-title-menu { display: none; }
    .rename { width: 100%; }
    /* The thread's title button gives way to its menu; a draft's label has no menu and stays. */
    .title:not(.draft) { display: none; }
    .title.draft { max-width: none; }
    .draft-mark { margin: 0 4px 0 6px; }
    .title-menu { display: flex; min-width: 0; flex: 0 1 auto; margin-left: -6px; }
    .title-menu :global(.menu) { min-width: 0; max-width: 100%; }
    .title-menu :global(.trigger) { min-width: 0; max-width: 100%; min-height: var(--touch-target); font-weight: 600; color: var(--color-foreground); }
    .title-text { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .title-menu :global(.trigger svg) { flex: none; color: var(--color-muted-foreground); }
    .crumb { min-height: var(--touch-target); }
    .crumb-sep { margin: 0; }
    .crumb-sep ~ .title-menu { margin-left: 0; }
  }
</style>
