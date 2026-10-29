<script lang="ts">
  import { ArrowLeft, Brain, Ellipsis, Archive, Pause, Play, LampDesk, Settings2, TriangleAlert } from '@lucide/svelte';
  import type { AgentProfile, AgentStatus, ThreadSummary } from '@boite/contracts';
  import { moodOf, liveState, liveStep, waitingOn, type AgentsView } from '../../lib/agents.svelte';
  import { confirm } from '../../lib/confirm.svelte';
  import { dateTime } from '../../lib/schedule';
  import type { AgentPane } from '../../lib/store/layout.svelte';
  import type { Store } from '../../lib/store.svelte';
  import { fill, strings } from '../../lib/strings';
  import { minuteClock } from '../../lib/clock.svelte';
  import Menu from '../Menu.svelte';
  import Elapsed from '../Elapsed.svelte';
  import AgentAvatar from './AgentAvatar.svelte';

  /**
   * The top of an agent's conversation: its robot in its ring (breathing
   * while it works), its name and one live line that says what it does this
   * second (the step its turn is on, with the time it has run), what it waits
   * on, or when it next wakes. Beside it the
   * desk toggle and a menu with its settings, its brain, pause and archive. A
   * problem that keeps it from running shows under it with the way to fix it.
   */
  let { store, view, agent, status, thread, onpane, onback }: {
    store: Store;
    view: AgentsView;
    agent: AgentProfile;
    status: AgentStatus | null;
    /** Its thread as the list holds it, live between two snapshots. */
    thread: ThreadSummary | null;
    onpane: (pane: AgentPane) => void;
    /** A phone's way back to the list. */
    onback?: () => void;
  } = $props();

  const labels = $derived(strings.agents);
  const now = $derived(minuteClock.now);
  /** What it waits on: the question it asked, else the permission it needs. */
  const pending = $derived(waitingOn(store, thread?.id));
  const state = $derived(liveState(agent, status, thread, !!pending));
  const step = $derived(liveStep(status, thread));
  const since = $derived(thread?.status === 'running' ? thread.runningSince ?? thread.progress?.since ?? null : null);
  /** The desk is a surface of its thread's panel: pressed while the panel shows it. */
  const deskOpen = $derived(store.panelOpen && store.panel.active?.kind === 'desk');

  const menuItems = $derived([
    { id: 'settings', label: labels.settings, glyph: Settings2 },
    { id: 'brain', label: labels.brain, glyph: Brain },
    ...(store.owner && agent.status !== 'archived' ? [
      agent.status === 'paused' ? { id: 'resume', label: labels.resume, glyph: Play } : { id: 'pause', label: labels.pause, glyph: Pause },
      { id: 'archive', label: labels.archive, glyph: Archive, danger: true },
    ] : []),
  ]);

  async function setStatus(next: AgentProfile['status']) {
    const latest = view.snapshot?.profiles.find(p => p.id === agent.id) ?? agent;
    const { id, revision, createdAt: _created, updatedAt: _updated, ...value } = latest;
    await view.call('agents.profile.save', { id, expectedRevision: revision, value: { ...value, status: next } });
  }
  async function pick(id: string) {
    if (id === 'settings' || id === 'brain') onpane(id);
    else if (id === 'pause') await setStatus('paused');
    else if (id === 'resume') await setStatus('active');
    else if (id === 'archive' && await confirm.ask({
      title: fill(labels.archiveTitle, { name: agent.name }),
      body: labels.archiveBody,
      confirmLabel: labels.archive,
      cancelLabel: strings.common.cancel,
      danger: true,
      requiredText: agent.name,
      inputLabel: labels.archiveName,
    })) await setStatus('archived');
  }
</script>

<header class="agent-head" data-state={state} data-testid="agent-header">
  {#if onback}
    <button type="button" class="ghost icon agent-mobile-back" aria-label={labels.list} title={labels.list} onclick={onback} data-testid="agent-back"><ArrowLeft size={18} strokeWidth={1.75} /></button>
  {/if}
  <button type="button" class="ghost agent-head-identity" onclick={() => onpane('settings')} aria-label={fill(labels.settingsOf, { name: agent.name })}>
    <span class="agent-head-robot"><AgentAvatar kind="profile" id={agent.id} name={agent.name} avatar={agent.avatar} mood={moodOf(state)} size={36} ring /></span>
    <span class="agent-head-text">
      <strong>{agent.name}</strong>
      <span class="agent-live" data-state={state} aria-live="polite" data-testid="agent-live">
        {#if state === 'working'}
          <span class="agent-live-text">{step ?? labels.state.working}</span>
          {#if since !== null}<span class="agent-live-time">· <Elapsed startedAt={since} finishedAt={null} active /></span>{/if}
        {:else if state === 'queued'}
          <span class="agent-live-text">{labels.state.queued}</span>
        {:else if state === 'waiting'}
          <span class="agent-live-text">{pending ? fill(labels.waitingOn, { what: pending }) : labels.state.waiting}</span>
        {:else if state === 'error'}
          <span class="agent-live-text">{labels.state.error}</span>
        {:else if state === 'paused' || state === 'archived'}
          <span class="agent-live-text">{labels.state[state]}</span>
        {:else if status?.nextWake}
          <span class="agent-live-text">{fill(labels.nextWake, { name: status.nextWake.label, when: dateTime(status.nextWake.at, now) })}</span>
        {:else}
          <span class="agent-live-text">{agent.domain || labels.state.idle}</span>
        {/if}
      </span>
    </span>
  </button>
  <nav class="agent-head-actions" aria-label={agent.name}>
    <button type="button" class="ghost icon" class:active={deskOpen} aria-pressed={deskOpen} title={labels.desk} aria-label={labels.desk} onclick={() => store.panel.toggleKind('desk')} data-testid="agent-desk-toggle"><LampDesk size={17} strokeWidth={1.75} /></button>
    <Menu placement="bottom" align="end" variant="ghost" label={labels.more} testid="agent-menu" items={menuItems} onpick={id => void pick(id)}>
      <Ellipsis size={18} strokeWidth={1.75} />
    </Menu>
  </nav>
</header>
{#if status?.problem && agent.status !== 'archived'}
  <div class="agent-problem" role="alert" data-testid="agent-problem">
    <TriangleAlert size={15} strokeWidth={1.75} />
    <span>{status.problem}</span>
    {#if store.owner}<button type="button" class="small" onclick={() => onpane('settings')}>{labels.fix}</button>{/if}
  </div>
{/if}
