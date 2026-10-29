<script lang="ts">
  import ContextModeBadge from './ContextModeBadge.svelte';
  import MachineIcon from './MachineIcon.svelte';
  import { Pause, Play, Plus, RotateCcw, Settings, Square, Trash2, UsersRound, Workflow } from '@lucide/svelte';
  import { DEFAULT_DELEGATION_CONFIG, threadActive, threadBusy, type DelegationConfig, type DelegationProfile } from '@boite/contracts';
  import type { BoundPanel, Surface } from '../lib/right-panel.svelte';
  import { fill, strings } from '../lib/strings';
  import type { Choice, PickPatch, Store } from '../lib/store.svelte';
  import { effortName, formatTokens, providerName } from '../lib/format';
  import { totalTokens } from '../lib/usage';
  import { modelLogoId, modelMakerName } from '../lib/provider-logos';
  import { isLive, runProgress } from '../lib/workflow-view';
  import EffortSlider from './EffortSlider.svelte';
  import ModelPicker from './ModelPicker.svelte';
  import ProviderLogo from './ProviderLogo.svelte';
  import StatusMark from './StatusMark.svelte';
  import { threadTone, workflowTone } from '../lib/thread-state';
  import Elapsed from './Elapsed.svelte';
  import NativeAgents from './NativeAgents.svelte';
  import WorkflowRunPane from './WorkflowRunPane.svelte';
  import { agentProgress } from '../lib/delegation-progress';
  import { machineName, workspace, type Machine } from '../lib/workspace.svelte';

  /**
   * What this conversation handed out: its workflow runs, its subagents and the
   * provider's own. A run opens its graph here; a subagent opens in the chat,
   * whose header names the parent above it. Nothing is launched from here; the
   * agent does that.
   */
  let { store, surface, panel }: { store: Store; surface: Surface; panel: BoundPanel } = $props();
  let settings = $state(false);

  let view = $derived(store.delegation);
  let config = $derived(view?.config ?? DEFAULT_DELEGATION_CONFIG);
  let openThreadId = $derived(store.openThread?.id ?? null);
  let runs = $derived(openThreadId ? store.workflowsOf(openThreadId) : []);
  let run = $derived(runs.find(entry => entry.id === surface.runId) ?? null);
  let agents = $derived(view?.agents ?? []);
  let native = $derived((view?.nativeAgents ?? []).filter(agent => agent.source !== 'process'));
  let processes = $derived((view?.nativeAgents ?? []).filter(agent => agent.source === 'process'));
  let liveAgents = $derived(agents.filter(agent => agentProgress(agent).active));
  /** Finished subagents, the most recent first: the one that just reported is the one to read. */
  let doneAgents = $derived(agents.filter(agent => !agentProgress(agent).active).sort((a, b) => endOf(b) - endOf(a)));
  let liveRuns = $derived(runs.filter(isLive));
  let doneRuns = $derived(runs.filter(entry => !isLive(entry)));
  let busy = $derived(agents.some(agent => threadBusy(agent.thread)) || runs.some(isLive));
  /** The interrupted subagents a Resume was just sent to: the button stays off until the core answers. */
  let resuming = $state(new Set<string>());

  $effect(() => {
    const threadId = openThreadId;
    settings = false;
    if (!threadId) return;
    void store.loadDelegation(threadId);
    void store.loadWorkflows(threadId);
  });

  function showRun(runId: string | undefined): void {
    panel.update(surface.id, { runId });
  }

  function save(patch: Partial<DelegationConfig>): void {
    if (!store.owner) return;
    void store.configureDelegation({ ...config, ...patch });
  }

  function addProfile(): void {
    const choice = store.defaultChoice();
    if (!choice?.model) return;
    const profile: DelegationProfile = {
      id: `agent-${Date.now().toString(36)}`,
      name: fill(strings.delegation.profileName, { count: String(config.profiles.length + 1) }),
      providerId: choice.providerId,
      accountId: choice.accountId,
      model: choice.model,
      effort: choice.effort
    };
    save({ profiles: [...config.profiles, profile] });
  }

  function patchProfile(profile: DelegationProfile, patch: Partial<DelegationProfile>): void {
    save({ profiles: config.profiles.map(entry => entry.id === profile.id ? { ...entry, ...patch } : entry) });
  }

  function profileChoice(profile: DelegationProfile): Choice {
    return { providerId: profile.providerId, accountId: profile.accountId, model: profile.model, effort: profile.effort, permissionMode: 'default', speed: null };
  }

  function pickProfile(profile: DelegationProfile, patch: PickPatch): void {
    const providerId = patch.providerId ?? profile.providerId;
    const accountId = patch.accountId ?? profile.accountId;
    const provider = store.providerOf(providerId);
    const model = patch.model ?? (providerId === profile.providerId ? profile.model : provider ? store.defaultModelOf(provider, accountId) : profile.model);
    if (!model) return;
    patchProfile(profile, { providerId, accountId, model, effort: patch.effort ?? store.defaultEffortOf(providerId, accountId, model) });
  }

  type Agent = (typeof agents)[number];

  function endOf(agent: Agent): number {
    const progress = agentProgress(agent);
    return progress.finishedAt ?? progress.startedAt;
  }

  /**
   * Harness, model and reasoning level, the way the composer's picker names
   * them. The row shows the model's own mark, labelled with its maker, and the
   * model's name; the harness stays in the route's tooltip.
   */
  function routeOf(agent: Agent) {
    const thread = agent.thread;
    const model = store.modelOf({ providerId: thread.providerId, accountId: thread.accountId, model: thread.model, effort: thread.effort, permissionMode: 'default', speed: null });
    const provider = providerName(store, thread.providerId);
    const name = model?.name ?? thread.model ?? strings.thread.defaultModel;
    const effort = thread.effort ? effortName(model, thread.effort) : null;
    const logo = modelLogoId(thread.providerId, thread.model ?? model?.id);
    return { provider, maker: modelMakerName(logo, thread.providerId) ?? provider, name, effort, logo, label: [provider, name, effort].filter(Boolean).join(' · ') };
  }

  function tokensOf(agent: Agent): number | null {
    const usage = agent.lastTurn?.usage;
    return usage ? totalTokens(usage) : null;
  }

  /** Completed goes without saying under Finished; a stop, a failure or an interruption does not. */
  function outcomeOf(agent: Agent): string | null {
    const status = agentProgress(agent).status;
    return status === 'stopped' ? strings.delegation.stoppedStatus : status === 'error' ? strings.delegation.failedStatus
      : status === 'interrupted' ? strings.delegation.interruptedStatus : status === 'background' ? strings.delegation.waitingStatus : null;
  }

  /** At work in its turn, or waiting on its own background work: the mark shows it running either way. */
  function markOf(agent: Agent) {
    return threadActive(agent.thread.status) ? threadTone(agent.thread.status) : { tone: 'running' as const, label: strings.delegation.waitingStatus };
  }

  /** Sends an interrupted subagent the note that wakes it, once: its next turn clears the interruption. */
  async function resume(agent: Agent): Promise<void> {
    const wait = agent.thread.backgroundWait;
    if (wait?.state !== 'interrupted' || resuming.has(agent.thread.id)) return;
    resuming = new Set([...resuming, agent.thread.id]);
    try {
      await store.messageDelegatedAgent(agent.thread.id, fill(strings.delegation.resumeAgentText, { what: wait.for, reason: strings.sidebar.state.interruption[wait.reason] }));
    } finally {
      resuming = new Set([...resuming].filter(id => id !== agent.thread.id));
    }
  }

  /**
   * A subagent on another machine of the group: that machine as this window
   * lists it, and its Store once connected here. Thread ids collide between
   * machines, so such a child opens only on its own machine's Store, never on
   * this one. Null for a child here.
   */
  function remoteOf(agent: Agent): { name: string; machine: Machine | null; store: Store | null } | null {
    if (!agent.machine) return null;
    const machine = workspace.machineOf(agent.machine.coreId);
    return { name: machine ? machineName(machine) : agent.machine.name, machine, store: machine?.store.connection === 'ready' ? machine.store : null };
  }

  /** A subagent reads like any conversation: it opens in the chat, not in this panel, on the machine that runs it. */
  function openChild(agent: Agent): void {
    const there = remoteOf(agent);
    if (!there) void store.open(agent.thread.id);
    else if (there.store) void workspace.select(there.store, agent.thread.id);
  }
</script>

{#snippet runRow(entry: (typeof runs)[number])}
  {@const progress = runProgress(entry)}
  <button type="button" class="member" data-testid="delegation-run" data-run-id={entry.id} onclick={() => showRun(entry.id)}>
    <span class="avatar run"><Workflow size={16} strokeWidth={1.75} /><StatusMark {...workflowTone(entry.status, true)} corner /></span>
    <span class="member-main">
      <strong class="title"><span class="ui-label">{entry.name}</span></strong>
      <span class="route"><span class="ui-label">{fill(strings.workflow.steps, { done: String(progress.done), total: String(progress.total) })}</span></span>
    </span>
    <span class="meta">
      {#if !isLive(entry)}<span class="outcome ui-label" data-status={entry.status}>{strings.workflow.status[entry.status]}</span>{/if}
      <Elapsed startedAt={entry.createdAt} finishedAt={entry.finishedAt} active={entry.status === 'running'} />
    </span>
  </button>
{/snippet}

{#snippet member(agent: Agent)}
  {@const progress = agentProgress(agent)}
  {@const route = routeOf(agent)}
  {@const tokens = tokensOf(agent)}
  {@const outcome = outcomeOf(agent)}
  {@const wait = agent.thread.backgroundWait ?? null}
  {@const there = remoteOf(agent)}
  {@const away = there && !there.store ? fill(strings.delegation.machineAway, { machine: there.name }) : null}
  <button type="button" class="member" class:away={away !== null} data-testid="delegation-member" data-agent-id={agent.thread.id} data-status={progress.status}
    data-preload-thread={away === null ? agent.thread.id : undefined} data-machine-id={there?.store ? there.machine!.id : undefined}
    aria-disabled={away === null ? undefined : 'true'} title={away ?? undefined} onclick={() => openChild(agent)}>
    <span class="avatar" role="img" aria-label={route.maker} title={route.maker}>
      <ProviderLogo providerId={route.logo} size={20} />
      {#if progress.active}<StatusMark {...markOf(agent)} corner />{/if}
    </span>
    <span class="member-main">
      <strong class="title"><span class="ui-label">{agent.thread.title}</span></strong>
      <span class="route" data-testid="delegation-member-route" title={route.label}>
        <span class="model ui-label">{route.name}</span>{#if route.effort}<span class="effort ui-label">{route.effort}</span>{/if}
        {#if agent.thread.contextMode}<ContextModeBadge mode={agent.thread.contextMode} compact testid="delegation-member-context" />{/if}
        {#if there}<span class="machine" title={fill(strings.delegation.runsOn, { machine: there.name })}><MachineIcon icon={there.machine?.icon} os={there.machine?.store.core?.os} size={12} /><span class="ui-label" data-testid="delegation-member-machine">{there.name}</span></span>{/if}
      </span>
    </span>
    <span class="meta">
      {#if outcome}<span class="outcome ui-label" data-status={progress.status}>{outcome}</span>{/if}
      <Elapsed startedAt={progress.startedAt} finishedAt={progress.finishedAt} active={progress.active} />
      {#if tokens !== null}<span class="tokens ui-label">{formatTokens(tokens)} {strings.units.tokens}</span>{/if}
    </span>
    {#if wait?.state === 'waiting'}
      <span class="note" data-testid="delegation-member-wait"><span class="ui-label">{fill(strings.sidebar.state.awaiting, { what: wait.for })}</span><Elapsed startedAt={wait.since} finishedAt={null} active /></span>
    {:else if wait?.state === 'interrupted'}
      <span class="note interrupted" data-testid="delegation-member-wait"><span class="ui-label">{fill(strings.sidebar.state.interruptedBy, { what: wait.for, reason: strings.sidebar.state.interruption[wait.reason] })}</span></span>
    {/if}
    {#if away}<span class="note away-note" data-testid="delegation-member-away"><span class="ui-label">{away}</span></span>{/if}
    {#if agent.result}<span class="result"><span>{agent.result}</span></span>{/if}
  </button>
  {#if wait?.state === 'interrupted'}
    <div class="resume-row">
      <button type="button" class="quiet small" data-testid="delegation-resume" title={strings.delegation.resumeAgentHint} disabled={resuming.has(agent.thread.id)} onclick={() => void resume(agent)}><RotateCcw size={12} /><span class="ui-label">{strings.delegation.resumeAgent}</span></button>
    </div>
  {/if}
{/snippet}

<section class="delegation" data-testid="delegation-surface">
  {#if run}
    <WorkflowRunPane {store} {run} onback={() => showRun(undefined)} />
  {:else}
    <header class="surface-head">
      <h2><UsersRound size={17} strokeWidth={1.75} /><span class="ui-label">{strings.delegation.heading}</span></h2>
      {#if view && (!config.enabled || config.paused)}<span class="state ui-label-box" data-testid="delegation-state"><span class="ui-label">{config.enabled ? strings.delegation.paused : strings.delegation.off}</span></span>{/if}
      <span class="spacer"></span>
      {#if busy}
        <button type="button" class="quiet small" data-testid="delegation-stop-all" onclick={() => void store.stopDelegatedAgent()}><Square size={11} fill="currentColor" /><span class="ui-label">{strings.delegation.stopAll}</span></button>
      {/if}
      {#if store.owner && view}
        <button type="button" class="ghost small icon" class:on={settings} aria-label={strings.delegation.configure} title={strings.delegation.configure} aria-pressed={settings} data-testid="delegation-settings-toggle" onclick={() => (settings = !settings)}><Settings size={15} strokeWidth={1.75} /></button>
      {/if}
    </header>

    {#if settings && view && store.owner}
      <div class="settings" data-testid="delegation-settings">
        <label class="switch-row">
          <span><strong>{strings.delegation.enabled}</strong><small>{strings.delegation.enabledHint}</small></span>
          <input type="checkbox" role="switch" checked={config.enabled} disabled={store.delegationSaving} onchange={(event) => save({ enabled: event.currentTarget.checked, paused: false })} />
        </label>
        {#if config.enabled}
          <label class="switch-row">
            <span><strong>{strings.delegation.anyModel}</strong><small>{strings.delegation.anyModelHint}</small></span>
            <input type="checkbox" role="switch" data-testid="delegation-any-model" checked={config.anyModel !== false} disabled={store.delegationSaving} onchange={(event) => save({ anyModel: event.currentTarget.checked })} />
          </label>
        {/if}

        <div class="profiles-head">
          <span><strong class="ui-label">{strings.delegation.profiles}</strong><small>{strings.delegation.profilesHint}</small></span>
          <button type="button" class="quiet small" data-testid="delegation-add-profile" disabled={store.delegationSaving} onclick={addProfile}><Plus size={14} /><span class="ui-label">{strings.delegation.addProfile}</span></button>
        </div>
        <div class="profiles">
          {#each config.profiles as profile (profile.id)}
            {@const choice = profileChoice(profile)}
            {@const model = store.modelOf(choice)}
            <div class="profile" data-testid="delegation-profile">
              <input aria-label={strings.delegation.profileLabel} value={profile.name} maxlength="80" onchange={(event) => patchProfile(profile, { name: event.currentTarget.value })} />
              <ModelPicker {store} {choice} onpick={(patch) => pickProfile(profile, patch)} disabled={store.delegationSaving} />
              {#if model?.effort?.levels.length}
                <EffortSlider levels={model.effort.levels} active={profile.effort ?? model.effort.default ?? null} onpick={(effort) => patchProfile(profile, { effort })} />
              {/if}
              <button type="button" class="ghost small icon" aria-label={strings.delegation.removeProfile} onclick={() => save({ profiles: config.profiles.filter(entry => entry.id !== profile.id)})}><Trash2 size={14} /></button>
            </div>
          {/each}
        </div>

        {#if config.enabled}
          <button type="button" class="quiet pause" onclick={() => save({ paused: !config.paused })}>
            {#if config.paused}<Play size={14} /><span class="ui-label">{strings.delegation.resume}</span>{:else}<Pause size={14} /><span class="ui-label">{strings.delegation.pause}</span>{/if}
          </button>
        {/if}
      </div>
    {:else if view}
      <div class="team">
        <div class="members" aria-label={strings.delegation.heading}>
          {#if liveRuns.length || liveAgents.length}
            <section class="group" data-testid="delegation-active">
              <h3 class="group-head"><span class="ui-label">{strings.delegation.activeSection}</span><span class="count">{liveRuns.length + liveAgents.length}</span></h3>
              {#each liveRuns as entry (entry.id)}{@render runRow(entry)}{/each}
              {#each liveAgents as agent (agent.thread.id)}{@render member(agent)}{/each}
            </section>
          {/if}
          {#if doneRuns.length || doneAgents.length}
            <section class="group" data-testid="delegation-finished">
              <h3 class="group-head"><span class="ui-label">{strings.delegation.finishedSection}</span><span class="count">{doneRuns.length + doneAgents.length}</span></h3>
              {#each doneRuns as entry (entry.id)}{@render runRow(entry)}{/each}
              {#each doneAgents as agent (agent.thread.id)}{@render member(agent)}{/each}
            </section>
          {/if}
        </div>

      </div>
      {#if !agents.length && !runs.length && !native.length && !processes.length}<p class="empty" data-testid="delegation-empty">{config.enabled ? strings.delegation.empty : strings.delegation.enabledHint}</p>{/if}
      {#if native.length}<NativeAgents agents={native} />{/if}
      {#if processes.length}<NativeAgents agents={processes} source="process" />{/if}
    {/if}

    {#if store.delegationError}<p class="error" role="alert">{store.delegationError}</p>{/if}
    {#if store.workflowsError}<p class="error" role="alert">{store.workflowsError}</p>{/if}
  {/if}
</section>

<style>
  .delegation { container-type: inline-size; height: 100%; min-height: 0; display: flex; flex-direction: column; overflow-y: auto; }
  .surface-head { flex: none; min-height: 44px; padding: 6px 10px 6px 16px; display: flex; align-items: center; gap: 8px; border-bottom: 1px solid var(--color-border); }
  .surface-head h2 { display: flex; align-items: center; gap: 7px; font-size: var(--text-md); }
  .surface-head .on { background: var(--color-active); color: var(--color-foreground); }
  .state { padding: 1px 7px; border-radius: 999px; background: var(--color-surface-3); color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .spacer { flex: 1; }
  .settings { flex: none; padding: 4px 16px 14px; }
  .profiles-head { margin-top: 12px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .error { margin: 12px 16px; color: var(--color-danger); font-size: var(--text-sm); }
  .switch-row { min-height: var(--control-lg); padding: 6px 0; display: flex; align-items: center; gap: 14px; }
  .switch-row > span, .profiles-head > span { flex: 1; min-width: 0; }
  .switch-row small, .profiles-head small { display: block; margin-top: 2px; color: var(--color-muted-foreground); font-size: var(--text-xs); line-height: 1.4; font-weight: normal; }
  .empty { margin: 16px; color: var(--color-muted-foreground); font-size: var(--text-sm); line-height: 1.5; }
  .profiles { margin-top: 7px; display: grid; gap: 5px; }
  .profile { display: grid; grid-template-columns: minmax(90px, .8fr) minmax(140px, 1fr) auto var(--control-sm); gap: 6px; align-items: center; }
  .profile > input { min-width: 0; }
  .pause { margin-top: 10px; }
  .team { flex: none; display: grid; grid-template-columns: 1fr; }
  .members { min-height: 0; padding: 4px 8px 10px; overflow-y: auto; }
  .group + .group { margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--color-border); }
  .group-head { padding: 10px 9px 6px; display: flex; align-items: center; gap: 6px; color: var(--color-muted-foreground); font-size: var(--text-xs); font-weight: 600; }
  .group-head .count { padding: 1px 6px; border-radius: 999px; background: var(--color-surface-3); font-variant-numeric: tabular-nums; font-weight: 500; }
  .member { width: 100%; height: auto; padding: 10px 9px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: start; gap: 0 10px; border: 1px solid transparent; border-radius: var(--radius-md); background: transparent; text-align: left; }
  .member + .member { margin-top: 2px; }
  .member:hover { background: var(--color-hover); border-color: var(--color-border); }
  /* On a machine this window is not connected to: it reads, it does not open. */
  .member.away { cursor: default; }
  .member.away:hover { background: transparent; border-color: transparent; }
  .avatar { --ring: var(--color-background); position: relative; width: 30px; height: 30px; display: grid; place-items: center; border-radius: var(--radius-md); background: var(--color-surface-2); border: 1px solid var(--color-border); }
  .avatar.run { color: var(--color-muted-foreground); }
  .member-main { min-width: 0; display: grid; gap: 6px; padding-top: 1px; }
  .title { min-width: 0; font-size: var(--text-sm); font-weight: 600; }
  .title .ui-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .route { min-width: 0; display: flex; align-items: center; gap: 6px; color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .model { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-foreground); font-weight: 500; }
  .effort { flex: none; padding: 3px 6px; border-radius: var(--radius-sm); background: var(--color-surface-3); color: var(--color-muted-foreground); }
  /* The machine of the group that runs it, beside the model it runs on. */
  .machine { flex: 0 1 auto; min-width: 0; max-width: 16ch; padding: 2px 6px; display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); color: var(--color-muted-foreground); }
  .machine :global(svg) { flex: none; }
  .machine > .ui-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { display: grid; justify-items: end; gap: 6px; padding-top: 2px; color: var(--color-muted-foreground); font-size: var(--text-xs); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .outcome { font-weight: 500; }
  .outcome[data-status='error'], .outcome[data-status='failed'], .outcome[data-status='interrupted'] { color: var(--color-danger); }
  .outcome[data-status='background'] { color: var(--color-accent); }
  /* What a subagent at rest waits on, or what ended without waking it. */
  .note { grid-column: 2 / -1; margin-top: 8px; display: flex; align-items: baseline; gap: 6px; min-width: 0; color: var(--color-accent); font-size: var(--text-xs); }
  .note > .ui-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .note.interrupted { color: var(--color-danger); }
  .note.interrupted > .ui-label { white-space: normal; }
  /* Why the row does not open: a tooltip with a pointer, written out where there is no hover. */
  .note.away-note { display: none; color: var(--color-muted-foreground); }
  .note.away-note > .ui-label { white-space: normal; }
  @media (max-width: 720px), (hover: none) { .note.away-note { display: flex; } }
  .resume-row { padding: 0 9px 6px 49px; }
  .result { grid-column: 2 / -1; margin-top: 8px; padding: 6px 9px; border-radius: var(--radius-sm); background: var(--color-surface-2); color: color-mix(in srgb, var(--color-foreground) 82%, transparent); font-size: var(--text-xs); line-height: 1.45; }
  .result > span { display: -webkit-box; -webkit-box-orient: vertical; line-clamp: 3; -webkit-line-clamp: 3; overflow: hidden; white-space: pre-wrap; overflow-wrap: anywhere; }
  @container (max-width: 520px) {
    .profile { grid-template-columns: minmax(0, 1fr) auto; }
    .profile > :global(.picker) { grid-column: 1 / -1; }
  }
</style>
