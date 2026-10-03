<script lang="ts">
  import { ArrowLeft, Pause, Play, Plus, Settings, Square, Trash2, UsersRound, Workflow } from '@lucide/svelte';
  import { onDestroy } from 'svelte';
  import { DEFAULT_DELEGATION_CONFIG, type DelegationConfig, type DelegationProfile } from '@boite/contracts';
  import type { BoundPanel, Surface } from '../lib/right-panel.svelte';
  import { fill, strings } from '../lib/strings';
  import type { Choice, PickPatch, Store } from '../lib/store.svelte';
  import { formatTokens } from '../lib/tokens';
  import { isLive, runProgress } from '../lib/workflow-view';
  import EffortSlider from './EffortSlider.svelte';
  import DelegationTranscript from './DelegationTranscript.svelte';
  import ModelPicker from './ModelPicker.svelte';
  import StatusMark from './StatusMark.svelte';
  import AgentElapsed from './AgentElapsed.svelte';
  import NativeAgents from './NativeAgents.svelte';
  import WorkflowMark from './WorkflowMark.svelte';
  import WorkflowRunPane from './WorkflowRunPane.svelte';
  import { agentProgress } from '../lib/delegation-progress';

  /**
   * What this conversation handed out: its workflow runs, its subagents and the
   * provider's own. A run opens its graph, a subagent its conversation. Nothing
   * is launched from here; the agent does that.
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
  let selected = $derived(agents.find(agent => agent.thread.id === store.delegationSelectedAgentId) ?? null);
  let busy = $derived(agents.some(agent => ['queued', 'running', 'waiting'].includes(agent.thread.status)) || runs.some(isLive));

  $effect(() => {
    const threadId = openThreadId;
    settings = false;
    if (!threadId) return;
    void store.loadDelegation(threadId);
    void store.loadWorkflows(threadId);
  });
  onDestroy(() => { void store.selectDelegatedAgent(null); });

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

  async function openChild(): Promise<void> {
    if (!selected) return;
    const id = selected.thread.id;
    await store.selectDelegatedAgent(null);
    await store.open(id);
  }
</script>

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
          <span><strong>{strings.delegation.enabled}</strong></span>
          <input type="checkbox" role="switch" checked={config.enabled} disabled={store.delegationSaving} onchange={(event) => save({ enabled: event.currentTarget.checked, paused: false })} />
        </label>

        <div class="profiles-head">
          <strong class="ui-label">{strings.delegation.profiles}</strong>
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
                <EffortSlider levels={model.effort.levels} active={profile.effort ?? model.effort.default} onpick={(effort) => patchProfile(profile, { effort })} />
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
      <div class="team" class:detail={selected !== null}>
        <div class="members" aria-label={strings.delegation.heading}>
          {#each runs as entry (entry.id)}
            {@const progress = runProgress(entry)}
            <button type="button" class="member" data-testid="delegation-run" data-run-id={entry.id} onclick={() => showRun(entry.id)}>
              <WorkflowMark status={entry.status} run />
              <span class="member-main"><strong class="workflow-name"><Workflow size={13} strokeWidth={1.75} /><span class="ui-label">{entry.name}</span></strong></span>
              <span class="status ui-label">{strings.workflow.status[entry.status]}</span>
              <span class="member-usage">{fill(strings.workflow.steps, { done: String(progress.done), total: String(progress.total) })} · <AgentElapsed startedAt={entry.createdAt} finishedAt={entry.finishedAt} active={entry.status === 'running'} /></span>
            </button>
          {/each}
          {#each agents as agent (agent.thread.id)}
            {@const progress = agentProgress(agent)}
            <button type="button" class="member" class:selected={selected?.thread.id === agent.thread.id} data-testid="delegation-member" data-agent-id={agent.thread.id} onclick={() => void store.selectDelegatedAgent(agent.thread.id)}>
              <StatusMark status={agent.thread.status} />
              <span class="member-main"><strong>{agent.thread.title}</strong><small>{store.providerOf(agent.thread.providerId)?.name ?? agent.thread.providerId} · {agent.thread.model ?? strings.thread.defaultModel}</small></span>
              <span class="status ui-label">{progress.status === 'done' ? strings.delegation.doneStatus : progress.status === 'stopped' ? strings.delegation.stoppedStatus : strings.threadStatus[agent.thread.status]}</span>
              <span class="task">{agent.task}</span>
              <span class="member-usage"><AgentElapsed startedAt={progress.startedAt} finishedAt={progress.finishedAt} active={progress.active} />{#if agent.lastTurn?.usage} · {formatTokens(agent.lastTurn.usage.inputTokens + agent.lastTurn.usage.outputTokens + agent.lastTurn.usage.cacheReadTokens + agent.lastTurn.usage.cacheWriteTokens)} {strings.units.tokens}{/if}</span>
              {#if agent.result}<span class="result">{agent.result}</span>{/if}
            </button>
          {/each}
        </div>

        {#if selected}
          <article class="detail-pane" data-testid="delegation-detail">
            <header>
              <button type="button" class="ghost small icon back" aria-label={strings.delegation.backToTeam} onclick={() => void store.selectDelegatedAgent(null)}><ArrowLeft size={15} /></button>
              <div><strong>{selected.thread.title}</strong><small>{selected.task}</small></div>
              <button type="button" class="quiet small" data-testid="delegation-open-thread" onclick={() => void openChild()}><span class="ui-label">{strings.delegation.openThread}</span></button>
              {#if ['queued', 'running', 'waiting'].includes(selected.thread.status)}<button type="button" class="danger small" onclick={() => void store.stopDelegatedAgent(selected.thread.id)}><Square size={11} fill="currentColor" /><span class="ui-label">{strings.delegation.stop}</span></button>{/if}
            </header>
            {#if store.delegationThread}
              <div class="transcript"><DelegationTranscript messages={store.delegationThread.messages} /></div>
            {/if}
          </article>
        {/if}
      </div>
      {#if !selected && native.length}<NativeAgents agents={native} />{/if}
      {#if !selected && processes.length}<NativeAgents agents={processes} source="process" />{/if}
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
  .member-usage { grid-column: 2 / -1; display: flex; flex-wrap: wrap; gap: 0 4px; font-variant-numeric: tabular-nums; }
  .error { margin: 12px 16px; color: var(--color-danger); font-size: var(--text-sm); }
  .team:not(.detail) { flex: none; }
  .switch-row { min-height: var(--control-lg); display: flex; align-items: center; gap: 14px; }
  .switch-row > span { flex: 1; }
  input[role='switch'] { appearance: none; position: relative; width: 40px; height: 24px; min-height: 24px; padding: 0; border-radius: 999px; background: var(--color-surface-3); }
  input[role='switch']::after { content: ''; position: absolute; width: 16px; height: 16px; top: 3px; left: 3px; border-radius: 50%; background: var(--color-muted-foreground); transition: transform var(--dur-2) var(--ease-out-quint); }
  input[role='switch']:checked { background: var(--color-foreground); }
  input[role='switch']:checked::after { transform: translateX(16px); background: var(--color-background); }
  .profiles { margin-top: 7px; display: grid; gap: 5px; }
  .profile { display: grid; grid-template-columns: minmax(90px, .8fr) minmax(140px, 1fr) auto var(--control-sm); gap: 6px; align-items: center; }
  .profile > input { min-width: 0; }
  .pause { margin-top: 10px; }
  .team { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr; }
  .team.detail { grid-template-columns: minmax(160px, .42fr) minmax(0, 1fr); }
  .members { min-height: 0; padding: 8px; overflow-y: auto; }
  .team.detail .members { border-right: 1px solid var(--color-border); }
  .member { width: 100%; height: auto; padding: 9px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 2px 7px; border: 1px solid transparent; border-radius: var(--radius-md); background: transparent; text-align: left; }
  .member:hover, .member.selected { background: var(--color-hover); border-color: var(--color-border); }
  .member-main strong, .member-main small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .member-main strong { font-size: var(--text-sm); }
  .member-main .workflow-name { display: flex; align-items: center; gap: 5px; }
  .workflow-name :global(svg) { flex: none; }
  .workflow-name .ui-label { overflow: hidden; text-overflow: ellipsis; }
  .member-main small, .status, .member-usage { color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .task, .result { grid-column: 2 / -1; font-size: var(--text-xs); line-height: 1.4; display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; }
  .task { color: var(--color-muted-foreground); line-clamp: 2; -webkit-line-clamp: 2; }
  .result { margin-top: 3px; padding: 5px 7px; line-clamp: 4; -webkit-line-clamp: 4; border-left: 2px solid var(--color-edge); background: var(--color-surface-2); white-space: pre-wrap; }
  .detail-pane { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  .detail-pane > header { flex: none; min-height: 48px; padding: 7px 9px; display: flex; align-items: center; gap: 7px; border-bottom: 1px solid var(--color-border); }
  .detail-pane > header > div { flex: 1; min-width: 0; }
  .detail-pane > header strong, .detail-pane > header small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .detail-pane > header small { color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .back { display: none; }
  .transcript { flex: 1; min-height: 0; display: flex; overflow: hidden; }
  @container (max-width: 520px) {
    .profile { grid-template-columns: minmax(0, 1fr) auto; }
    .profile > :global(.picker) { grid-column: 1 / -1; }
    .team.detail { grid-template-columns: 1fr; }
    .team.detail .members { display: none; }
    .back { display: inline-flex; }
    .detail-pane > header { display: grid; grid-template-columns: var(--control-sm) minmax(0, 1fr) auto; }
    .detail-pane > header > div { grid-column: 2 / -1; }
    .detail-pane > header > .quiet:not(.back) { grid-column: 2; justify-self: start; }
    .detail-pane > header > .danger { grid-column: 3; }
  }
  @media (prefers-reduced-motion: reduce) { input[role='switch']::after { transition: none; } }
</style>
