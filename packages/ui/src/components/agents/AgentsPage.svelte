<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import { ArrowLeft, Bot } from '@lucide/svelte';
  import { AgentsView, agentOfThread, agentRows, agentsFilter, firstDeskVisit, lastOpenedAgent, openAgent, rememberAgent, statusOf, type AgentFocus } from '../../lib/agents.svelte';
  import { agentDirectory } from '../../lib/agent-directory.svelte';
  import { mobileOverlay } from '../../lib/mobile-history';
  import { mobileChrome } from '../../lib/mobile-chrome.svelte';
  import type { AgentPane } from '../../lib/store/layout.svelte';
  import type { Store } from '../../lib/store.svelte';
  import { fill, strings } from '../../lib/strings';
  import { workspace, type Machine } from '../../lib/workspace.svelte';
  import ChatView from '../ChatView.svelte';
  import AgentsRail from './AgentsRail.svelte';
  import AgentHeader from './AgentHeader.svelte';
  import AgentSheet from './AgentSheet.svelte';
  import AgentEditor from './AgentEditor.svelte';
  import AgentEngineSettings from './AgentEngineSettings.svelte';
  import './agents.css';

  /**
   * The Agents page is the chat with the agents list for its column: an
   * agent's conversation is its own thread, opened on the machine that owns
   * it and drawn by the ordinary chat view with the ordinary composer, under
   * the agent's header. The right panel beside it is that thread's, drawn by
   * the app like any thread's. The card shows a form instead while a new agent
   * is written, and the engine settings when asked.
   *
   * A phone shows the list, then the conversation full screen with a back
   * arrow to the list.
   */
  let { store }: { store: Store } = $props();
  const view = AgentsView.of(untrack(() => store));
  const narrow = new MediaQuery('(max-width: 720px)');
  const labels = $derived(strings.agents);
  let focus = $state<AgentFocus | null>(null);
  let pane = $state<AgentPane | null>(null);
  /** A phone went back to the list: the thread stays open behind it. */
  let listShown = $state(false);
  /** The pane a link asked for, opened once its agent's thread is on screen. */
  let wanted: { agentId: string; pane: AgentPane } | null = null;

  /**
   * The list shows every connected machine's agents, the way the thread list
   * shows every machine's threads. The page itself works on one machine at a
   * time: a row of another opens that machine. A filter holds only while the
   * page is on the machine it names.
   */
  const machines = $derived(workspace.machinesOr(store));
  const here = $derived(machines.find(m => m.store === store) ?? null);
  const filter = $derived(here && agentsFilter.machine === here.id ? here.id : null);
  const others = $derived(filter ? [] : machines.filter(m => m.store !== store).map(machine => ({ machine, view: AgentsView.of(machine.store) })));
  const lists = $derived([...(here ? [{ machine: here, view }] : []), ...others]);
  const snapshot = $derived(view.snapshot);
  const rows = $derived(agentRows(snapshot));
  const elsewhere = $derived(others.some(o => agentRows(o.view.snapshot).length > 0));

  /** The agent thread on screen: an ordinary thread left open from the chat is not drawn here. */
  const thread = $derived(store.openThread?.agentSessionId ? store.openThread : null);
  const directory = $derived(agentDirectory(store));
  const threadId = $derived(thread?.id ?? null);
  const agent = $derived(thread ? agentOfThread(snapshot, thread.id) ?? directory.ownerOf(thread) : null);
  /** The open agent's id: every snapshot brings a new profile object, the id moves only when another agent opens. */
  const agentId = $derived(agent?.id ?? null);
  const status = $derived(agent ? statusOf(snapshot, agent.id) : null);
  /** The conversation of an archived agent reads, and takes nothing more. */
  const locked = $derived(agent?.status === 'archived' ? labels.archivedNotice : null);
  const detail = $derived(!!focus || (!!thread && !listShown));

  onMount(() => { view.start(); return () => view.pause(); });
  // The other machines' snapshots load while their rows are listed.
  $effect(() => {
    const shown = others.map(o => o.view);
    untrack(() => { for (const other of shown) other.start(); });
    return () => { for (const other of shown) other.pause(); };
  });
  // The snapshot carries the open agent's desk only.
  $effect(() => { const id = agentId; untrack(() => view.showDesk(id)); });
  // The directory names the agent of a thread the snapshot does not list yet, a new one.
  $effect(() => { const target = directory; return untrack(() => target.watch()); });
  // A reconnect reads the snapshot again; the first visit already asked in `start`.
  let wasReady = untrack(() => store.connection === 'ready');
  $effect(() => {
    const ready = store.connection === 'ready';
    if (ready && !wasReady) void view.refresh();
    wasReady = ready;
  });
  // The agent on screen is the one this machine reopens next time; a new thread brings the conversation back on a phone.
  $effect(() => {
    const id = agentId;
    void threadId;
    untrack(() => {
      if (id) rememberAgent(store, id);
      listShown = false;
      pane = wanted && wanted.agentId === id ? wanted.pane : null;
      if (wanted?.agentId === id) wanted = null;
    });
  });
  // The first time an agent opens on a wide window, its desk opens beside the conversation.
  // A panel already in use keeps the visit unspent: the desk opens the next time it is free.
  $effect(() => {
    const id = agentId;
    if (!id || !threadId || narrow.current) return;
    untrack(() => { if (!store.panel.isOpen && store.panel.surfaces.length === 0 && firstDeskVisit(id)) store.panel.open('desk'); });
  });
  /** The desktop's default agent was opened, or gave way to one named on the way in. */
  let tried = false;
  /** The default agent could not be opened: the card offers a retry instead of loading. */
  let openFailed = $state(false);
  // A link from elsewhere (a thread an agent runs, a settings card) names the agent to open.
  $effect(() => {
    const target = store.agentsTarget;
    if (!target) return;
    untrack(() => {
      store.agentsTarget = null;
      // The named agent is this visit's choice: the default below gives way to it.
      tried = true;
      focus = null;
      listShown = false;
      if (target.agentId === agent?.id && thread) { pane = target.pane ?? null; return; }
      wanted = target.pane ? { agentId: target.agentId, pane: target.pane } : null;
      void openAgent(store, target.agentId);
    });
  });
  /**
   * A desktop always has a conversation in the card: the agent shown last on
   * this machine, else the one that spoke last. Asked once per visit, so an
   * agent that cannot be opened leaves the card alone.
   */
  $effect(() => {
    if (narrow.current || focus || thread || !snapshot || !rows.length || store.agentsTarget || tried) return;
    tried = true;
    untrack(openDefault);
  });
  function openDefault() {
    openFailed = false;
    const last = lastOpenedAgent(store);
    void openAgent(store, rows.some(r => r.profile.id === last) ? last! : rows[0]!.profile.id).then(opened => { if (!opened) openFailed = true; });
  }
  // On a phone the open conversation hides the list; the root carries it as a class, as `.app:has(...)` would restyle every node.
  $effect(() => {
    const root = document.documentElement;
    root.classList.toggle('agents-detail-open', detail);
    return () => root.classList.remove('agents-detail-open');
  });
  // On a phone every level past the list holds one history entry: Back steps out of it.
  $effect(() => { if (narrow.current && detail) return mobileOverlay(back); });
  // An agent's page on a phone is pushed over the list, as a thread is: the bottom bar steps aside.
  $effect(() => {
    if (!narrow.current || !detail) return;
    mobileChrome.detail = true;
    return () => { mobileChrome.detail = false; };
  });

  function open(machine: Machine, agentId: string) {
    // Read now: the page, and the row's values with it, is drawn again for the other machine.
    const target = machine.store;
    if (target !== store) { void workspace.select(target).then(() => target.showAgents(agentId)); return; }
    focus = null; pane = null; listShown = false;
    if (agentId === agent?.id && thread) return;
    void openAgent(store, agentId);
  }
  /** One step out: a form, then the conversation, then the list. */
  function back() {
    if (focus) focus = null;
    else listShown = true;
  }
</script>

<AgentsRail {view} {lists} {filter} active={focus ? null : agent?.id ?? null} engine={focus?.kind === 'engine'}
  onopen={open} oncreate={() => { focus = { kind: 'new' }; }} onengine={() => { focus = focus?.kind === 'engine' ? null : { kind: 'engine' }; }} />

<main class="agents-main" class:open={detail} data-testid="agents-page">
  <div class="agents-card framed" class:chat={!focus && !!thread}>
    {#if view.error || view.loadError}
      <div class="agent-error" role="alert">{view.error || view.loadError}<button type="button" class="ghost small" onclick={() => { view.error = ''; void view.refresh(); }}>{labels.retry}</button></div>
    {/if}
    {#if snapshot && store.connection !== 'ready'}<p class="agent-error" role="status">{labels.stale}</p>{/if}

    {#if focus}
      <header class="agents-detail-head">
        <button type="button" class="ghost icon agent-mobile-back" aria-label={labels.backToChat} title={labels.backToChat} onclick={back}><ArrowLeft size={18} strokeWidth={1.75} /></button>
        <h2 class="agents-detail-heading">{focus.kind === 'new' ? labels.newAgent : labels.engineSettings}</h2>
      </header>
      <div class="agents-body">
        {#if focus.kind === 'new'}
          <AgentEditor {view} ondone={created => { focus = null; void openAgent(store, created.id); }} oncancel={() => { focus = null; }} />
        {:else}
          <AgentEngineSettings {view} />
        {/if}
      </div>
    {:else if thread && agent}
      <AgentHeader {store} {view} {agent} {status} {thread} onpane={next => { pane = pane === next ? null : next; }} onback={narrow.current ? back : undefined} />
      <div class="agents-chat">
        <ChatView {store} {locked} />
      </div>
      <AgentSheet {view} {agent} {pane} onclose={() => { pane = null; }} />
    {:else if thread}
      <!-- A thread the snapshot does not name yet, a moment after the agent was created. -->
      <div class="agents-chat"><ChatView {store} /></div>
    {:else if !snapshot}
      <p class="agent-empty">{view.loadError ? labels.offline : strings.app.loading}</p>
    {:else if !rows.length}
      <div class="agent-welcome" data-testid="agents-empty">
        <Bot size={32} strokeWidth={1.5} />
        <p>{elsewhere && here ? fill(labels.noAgentsOn, { machine: here.label }) : labels.noAgents}</p>
        <p class="hint">{labels.welcomeHint}</p>
        {#if store.owner}<button type="button" class="primary" onclick={() => { focus = { kind: 'new' }; }} data-testid="agents-first">{labels.createAgent}</button>{/if}
      </div>
    {:else if openFailed}
      <div class="agent-error" role="alert">{labels.openFailed}<button type="button" class="ghost small" onclick={openDefault} data-testid="agents-open-retry">{labels.retry}</button></div>
    {:else}
      <p class="agent-empty">{strings.app.loading}</p>
    {/if}
  </div>
</main>
