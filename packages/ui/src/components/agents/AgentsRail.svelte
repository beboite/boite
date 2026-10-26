<script lang="ts">
  import type { Component } from 'svelte';
  import { Bot, Brain, FilePen, FileText, Globe, Hourglass, Layers, MessageCircleQuestionMark, Moon, PenLine, Play, Plus, RotateCw, Search, Settings2, SquareTerminal, TriangleAlert, Wrench, X } from '@lucide/svelte';
  import type { AgentStatus, ThreadSummary } from '@boite/contracts';
  import { agentRows, agentsFilter, liveActivity, previewOf, waitingOn, type ActivityKind, type AgentMood, type AgentRowData, type AgentsView } from '../../lib/agents.svelte';
  import { strings } from '../../lib/strings';
  import { workspace, type Machine } from '../../lib/workspace.svelte';
  import RailFrame from '../RailFrame.svelte';
  import RailHead from '../RailHead.svelte';
  import MachineStatus from '../MachineStatus.svelte';
  import AgentAvatar from './AgentAvatar.svelte';
  import AgentRow from './AgentRow.svelte';
  import { minuteClock } from '../../lib/clock.svelte';

  /**
   * The agents, listed the way a messenger lists its chats in the thread
   * list's own frame and head (`RailFrame`, `RailHead`): one card of rows,
   * each with its robot by state, its name, what it does this second or the
   * last thing it said, the missed answers or the time, and its next wake.
   * Like the thread list, it holds every connected machine's agents, newest
   * first, each row with its machine's icon once there are two; the foot's
   * machine button narrows it to one.
   */
  type MachineAgents = { machine: Machine; view: AgentsView };
  let { view, lists, filter, active, onopen, oncreate, onengine, engine = false }: {
    /** The page's machine: the one a new agent and the engine settings belong to. */
    view: AgentsView;
    /** Each listed machine's agents, the page's own first. */
    lists: MachineAgents[];
    /** The machine the list is narrowed to, null for all. */
    filter: string | null;
    /** The agent whose thread is open, on the page's machine. */
    active: string | null;
    onopen: (machine: Machine, agentId: string) => void;
    oncreate: () => void;
    onengine: () => void;
    /** The engine settings are what the card shows. */
    engine?: boolean;
  } = $props();

  const labels = $derived(strings.agents);
  let query = $state('');
  let searching = $state(false);
  const now = $derived(minuteClock.now);

  const multi = $derived(workspace.machinesOr(view.store).length > 1);
  const needle = $derived(query.trim().toLowerCase());
  const rows = $derived(lists
    .flatMap(list => agentRows(list.view.snapshot).filter(row => !needle || row.profile.name.toLowerCase().includes(needle)).map(row => ({ ...list, row })))
    .sort((a, b) => b.row.at - a.row.at || a.row.profile.name.localeCompare(b.row.profile.name)));
  /** A search also reaches what the list leaves out: archived agents. */
  const found = $derived(needle ? lists.flatMap(({ machine, view: owner }) =>
    (owner.snapshot?.profiles ?? []).filter(a => a.status === 'archived' && a.name.toLowerCase().includes(needle)).map(profile => ({ machine, profile }))) : []);

  /** The thread's row, live between two snapshots, when this client holds it. */
  function threadOf(machine: Machine, status: AgentStatus | null): ThreadSummary | null {
    return status?.threadId ? machine.store.threads.find(t => t.id === status.threadId) ?? null : null;
  }
  type Tone = 'idle' | 'working' | 'queued' | 'waiting' | 'error' | 'asleep';
  /** How the row stands: its thread's row first, the snapshot's status else. Paused, by itself or with every bot, it sleeps between the turns you start. */
  function toneOf(row: AgentRowData, thread: ThreadSummary | null, asking: boolean): Tone {
    if (thread?.status === 'running') return asking ? 'waiting' : 'working';
    if (thread?.status === 'queued') return 'queued';
    if (thread?.status === 'waiting' || asking) return 'waiting';
    const state = row.status?.state;
    if (state === 'working') return 'working';
    if (state === 'queued') return 'queued';
    if (state === 'waiting') return 'waiting';
    if (state === 'error' || row.status?.problem) return 'error';
    return row.profile.status === 'paused' || state === 'paused' ? 'asleep' : 'idle';
  }
  /** The glyph of each kind of step, the way the timeline draws its calls. */
  const GLYPHS: Record<ActivityKind, Component<{ size?: number; strokeWidth?: number }>> = {
    command: SquareTerminal, edit: FilePen, write: FilePen, read: FileText, search: Search, fetch: Globe, web: Globe, agent: Bot, other: Wrench,
    sleep: Hourglass, thinking: Brain, compacting: Layers, starting: Play, retrying: RotateCw, provider: Hourglass, writing: PenLine,
  };
  /**
   * What the row says under the name, with its glyph: the step it is on while
   * it works, the question it waits on, why it failed, that it sleeps, else
   * the last thing it said; a new agent shows what it is for.
   */
  function lineOf(machine: Machine, row: AgentRowData, thread: ThreadSummary | null, tone: Tone): { text: string; icon?: Component<{ size?: number; strokeWidth?: number }> } {
    if (tone === 'asleep') return { text: labels.state.paused, icon: Moon };
    if (tone === 'working') {
      const step = liveActivity(row.status, thread);
      return { text: step?.text ?? labels.state.working, icon: GLYPHS[step?.kind ?? 'thinking'] };
    }
    if (tone === 'queued') return { text: labels.state.queued, icon: Hourglass };
    if (tone === 'waiting') return { text: waitingOn(machine.store, row.status?.threadId) ?? labels.state.waiting, icon: MessageCircleQuestionMark };
    if (tone === 'error') return { text: row.status?.problem ?? labels.state.error, icon: TriangleAlert };
    return { text: row.status?.last ? previewOf(row.status.last.text) : row.profile.domain };
  }
  /** What the ring says: the tone, with answers not read yet over a rest. */
  function moodOf(tone: Tone, unread: number): AgentMood {
    return tone === 'idle' && unread > 0 ? 'unread' : tone;
  }
  function earliest(a: number | null | undefined, b: number | null | undefined): number | null {
    return a == null ? b ?? null : b == null ? a : Math.min(a, b);
  }
  /** Narrowing to another machine moves the page there, so a new agent is created where the list shows. */
  function narrow(id: string | null) {
    agentsFilter.machine = id;
    const target = id ? workspace.machines.find(m => m.id === id) : undefined;
    if (target && target.store !== view.store) void workspace.select(target.store).then(() => target.store.showAgents());
  }
  let searchToggle = $state<HTMLButtonElement>();
  /** The field unmounts under the focus: it goes back to the button that opened it. */
  function closeSearch() { searching = false; query = ''; searchToggle?.focus(); }
</script>

<RailFrame store={view.store} kind="agents-rail" label={labels.heading}>
  {#snippet head()}
    <RailHead store={view.store} current="agents">
      {#snippet actions()}
        <button type="button" class="ghost icon small" bind:this={searchToggle} class:active={searching} aria-pressed={searching} title={labels.search} aria-label={labels.search} onclick={() => (searching ? closeSearch() : (searching = true))} data-testid="agents-search-toggle"><Search size={16} /></button>
        {#if view.store.owner}
          <button type="button" class="ghost icon small" title={labels.newAgent} aria-label={labels.newAgent} onclick={oncreate} data-testid="agents-create"><Plus size={16} /></button>
        {/if}
      {/snippet}
    </RailHead>
  {/snippet}

  {#snippet subhead()}
    {#if searching}
      <label class="agents-search"><Search size={14} strokeWidth={1.75} />
        <!-- svelte-ignore a11y_autofocus -->
        <input type="search" bind:value={query} aria-label={labels.search} placeholder={labels.search} autofocus onkeydown={e => { if (e.key === 'Escape') closeSearch(); }} />
        <button type="button" class="ghost icon small" aria-label={strings.common.close} onclick={closeSearch}><X size={13} /></button>
      </label>
    {/if}
  {/snippet}

  {#if rows.length}
    <section class="agents-card" aria-label={labels.heading}>
      {#each rows as { machine, view: owner, row } (JSON.stringify([machine.id, row.profile.id]))}
        {@const thread = threadOf(machine, row.status)}
        {@const tone = toneOf(row, thread, !!waitingOn(machine.store, row.status?.threadId))}
        {@const line = lineOf(machine, row, thread, tone)}
        {@const unread = row.status?.unread ?? 0}
        <AgentRow title={row.profile.name} open={owner === view && active === row.profile.id} {unread} away={machine.store.connection !== 'ready'}
          at={row.status?.last?.at ?? 0} {now} tone={tone === 'queued' ? 'idle' : tone} detail={line.text} icon={line.icon}
          since={tone === 'working' ? earliest(thread?.requestSince, thread?.runningSince) : null}
          wake={tone === 'idle' && row.profile.status === 'active' && row.status?.nextWake ? row.status.nextWake : null}
          machine={multi ? machine : undefined} testid="agent-entry-{row.profile.id}" onclick={() => onopen(machine, row.profile.id)}>
          {#snippet picture()}<AgentAvatar kind="profile" id={row.profile.id} name={row.profile.name} avatar={row.profile.avatar} mood={moodOf(tone, unread)} size={34} ring />{/snippet}
        </AgentRow>
      {/each}
    </section>
  {/if}
  {#if found.length}
    <section class="agents-card">
      {#each found as entry (JSON.stringify([entry.machine.id, entry.profile.id]))}
        <AgentRow title={entry.profile.name} at={0} {now} detail={labels.state.archived} machine={multi ? entry.machine : undefined} testid="agent-entry-{entry.profile.id}" onclick={() => onopen(entry.machine, entry.profile.id)}>
          {#snippet picture()}<AgentAvatar kind="profile" id={entry.profile.id} name={entry.profile.name} avatar={entry.profile.avatar} size={34} />{/snippet}
          {#snippet aside()}{/snippet}
        </AgentRow>
      {/each}
    </section>
  {/if}
  {#if needle && !rows.length && !found.length}<p class="agent-empty">{labels.noMatch}</p>{/if}

  {#snippet lead()}
    <!-- The thread list's machine button: every machine, or one. -->
    <MachineStatus store={view.store} {filter} onfilter={narrow} testid="agents-machine" />
  {/snippet}

  {#snippet foot()}
    {#if view.store.owner}<button type="button" class="ghost icon" class:active={engine} title={labels.engineSettings} aria-label={labels.engineSettings} onclick={onengine} data-testid="agents-engine"><Settings2 size={16} /></button>{/if}
  {/snippet}
</RailFrame>
