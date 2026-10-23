<script lang="ts">
  import { Plus, Search, Settings2, X } from '@lucide/svelte';
  import type { AgentStatus, ThreadSummary } from '@boite/contracts';
  import { agentRows, agentsFilter, faceOf, liveStep, previewOf, type AgentRowData, type AgentsView } from '../../lib/agents.svelte';
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
  /** How the row stands: its thread's row first, the snapshot's status else. */
  function toneOf(row: AgentRowData, thread: ThreadSummary | null): 'idle' | 'working' | 'waiting' | 'error' {
    if (row.profile.status === 'paused') return 'idle';
    if (thread?.status === 'running' || thread?.status === 'queued') return 'working';
    if (thread?.status === 'waiting') return 'waiting';
    const state = row.status?.state;
    if (state === 'working' || state === 'queued') return 'working';
    if (state === 'waiting') return 'waiting';
    return state === 'error' || row.status?.problem ? 'error' : 'idle';
  }
  /** What it does this second, what it waits on, else the last thing it said; a new agent shows what it is for. */
  function detailOf(row: AgentRowData, thread: ThreadSummary | null, tone: ReturnType<typeof toneOf>): string {
    if (row.profile.status === 'paused') return labels.state.paused;
    if (tone === 'working') return liveStep(row.status, thread) ?? labels.state.working;
    if (tone === 'waiting') return labels.state.waiting;
    if (tone === 'error') return row.status?.problem ?? labels.state.error;
    return row.status?.last ? previewOf(row.status.last.text) : row.profile.domain;
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
        {@const tone = toneOf(row, thread)}
        <AgentRow title={row.profile.name} open={owner === view && active === row.profile.id} unread={row.status?.unread ?? 0} away={machine.store.connection !== 'ready'}
          at={row.status?.last?.at ?? 0} {now} {tone} detail={detailOf(row, thread, tone)}
          wake={tone === 'idle' && row.profile.status === 'active' && row.status?.nextWake ? row.status.nextWake : null}
          machine={multi ? machine : undefined} testid="agent-entry-{row.profile.id}" onclick={() => onopen(machine, row.profile.id)}>
          {#snippet picture()}<AgentAvatar kind="profile" id={row.profile.id} name={row.profile.name} avatar={row.profile.avatar} status={faceOf(tone === 'working' ? 'working' : tone === 'waiting' ? 'waiting' : 'idle')} size={30} ring />{/snippet}
        </AgentRow>
      {/each}
    </section>
  {/if}
  {#if found.length}
    <section class="agents-card">
      {#each found as entry (JSON.stringify([entry.machine.id, entry.profile.id]))}
        <AgentRow title={entry.profile.name} at={0} {now} detail={labels.state.archived} machine={multi ? entry.machine : undefined} testid="agent-entry-{entry.profile.id}" onclick={() => onopen(entry.machine, entry.profile.id)}>
          {#snippet picture()}<AgentAvatar kind="profile" id={entry.profile.id} name={entry.profile.name} avatar={entry.profile.avatar} size={30} />{/snippet}
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
