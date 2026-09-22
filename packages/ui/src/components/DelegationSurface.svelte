<script lang="ts">
  import { ArrowLeft, Pause, Play, Plus, Send, Square, Trash2, UsersRound } from '@lucide/svelte';
  import { onDestroy } from 'svelte';
  import { DEFAULT_DELEGATION_CONFIG, type DelegationConfig, type DelegationProfile } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';
  import type { Choice, PickPatch, Store } from '../lib/store.svelte';
  import { formatTokens } from '../lib/tokens';
  import EffortSlider from './EffortSlider.svelte';
  import DelegationTranscript from './DelegationTranscript.svelte';
  import ModelPicker from './ModelPicker.svelte';
  import ProviderLogo from './ProviderLogo.svelte';
  import StatusMark from './StatusMark.svelte';
  import AgentElapsed from './AgentElapsed.svelte';
  import { agentProgress } from '../lib/delegation-progress';

  let { store }: { store: Store } = $props();
  let task = $state('');
  let selectedProfileId = $state<string | null>(null);
  let message = $state('');
  let sending = $state(false);
  let launching = $state(false);
  let delivery = $state('');

  let view = $derived(store.delegation);
  let config = $derived(view?.config ?? DEFAULT_DELEGATION_CONFIG);
  let selected = $derived(view?.agents.find(agent => agent.thread.id === store.delegationSelectedAgentId) ?? null);
  let selectedProfile = $derived(config.profiles.find(profile => profile.id === selectedProfileId) ?? config.profiles[0] ?? null);
  let selectedLetters = $derived(selected ? view?.messages.filter(letter => letter.from.threadId === selected.thread.id || letter.to.threadId === selected.thread.id) ?? [] : []);
  let totalTokens = $derived(view ? view.usage.inputTokens + view.usage.outputTokens + view.usage.cacheReadTokens + view.usage.cacheWriteTokens : 0);

  $effect(() => {
    const threadId = store.openThread?.id;
    task = '';
    selectedProfileId = null;
    if (threadId) void store.loadDelegation(threadId);
  });
  $effect(() => {
    store.delegationSelectedAgentId;
    message = '';
    delivery = '';
  });
  onDestroy(() => { void store.selectDelegatedAgent(null); });

  function save(patch: Partial<DelegationConfig>): void {
    if (!store.owner) return;
    void store.configureDelegation({ ...config, ...patch });
  }

  function addProfile(): void {
    const choice = store.defaultChoice();
    if (!choice?.model) return;
    const count = config.profiles.length + 1;
    const profile: DelegationProfile = {
      id: `agent-${Date.now().toString(36)}`,
      name: fill(strings.delegation.profileName, { count: String(count) }),
      providerId: choice.providerId,
      accountId: choice.accountId,
      model: choice.model,
      effort: choice.effort
    };
    selectedProfileId = profile.id;
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

  async function launch(): Promise<void> {
    if (!selectedProfile || !task.trim() || launching) return;
    launching = true;
    const agent = await store.spawnDelegatedAgent(selectedProfile.id, task);
    launching = false;
    if (!agent) return;
    task = '';
    await store.selectDelegatedAgent(agent.thread.id);
  }

  async function steer(): Promise<void> {
    if (!selected || !message.trim() || sending) return;
    const recipient = selected.thread.id;
    sending = true;
    const sent = await store.messageDelegatedAgent(recipient, message);
    sending = false;
    if (!sent || store.delegationSelectedAgentId !== recipient) return;
    message = '';
    delivery = strings.delegation.queuedDelivery;
  }

  async function openChild(): Promise<void> {
    if (!selected) return;
    const id = selected.thread.id;
    await store.selectDelegatedAgent(null);
    await store.open(id);
  }
</script>

<section class="delegation" data-testid="delegation-surface">
  <header class="surface-head">
    <div>
      <h2><UsersRound size={17} strokeWidth={1.75} />{strings.delegation.heading}</h2>
      <p>{strings.delegation.intro}</p>
    </div>
    {#if view}
      <div class="usage" title={strings.delegation.usage}>
        <strong>{view.agents.length}/{config.maxAgents}</strong> {strings.delegation.agentsShort}
        <span>·</span>
        <strong>{view.turnsUsed}/{config.maxTurns}</strong> {strings.delegation.turnsShort}
        <span>·</span>
        <strong>{formatTokens(totalTokens)}</strong> {strings.units.tokens}
      </div>
    {/if}
  </header>

  {#if store.delegationLoading && !view}
    <p class="empty">{strings.delegation.loading}</p>
  {:else if view}
    {#if store.owner}
      <details class="settings" data-testid="delegation-settings">
        <summary>{strings.delegation.configure}</summary>
        <div class="settings-body">
          <label class="switch-row">
            <span><strong>{strings.delegation.enabled}</strong><small>{strings.delegation.enabledHint}</small></span>
            <input type="checkbox" role="switch" checked={config.enabled} disabled={store.delegationSaving || config.profiles.length === 0} onchange={(event) => save({ enabled: event.currentTarget.checked, paused: false })} />
          </label>

          <div class="profiles-head">
            <div><strong>{strings.delegation.profiles}</strong><small>{strings.delegation.profilesHint}</small></div>
            <button type="button" class="quiet small" data-testid="delegation-add-profile" disabled={store.delegationSaving} onclick={addProfile}><Plus size={14} />{strings.delegation.addProfile}</button>
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
                <button type="button" class="ghost small icon" aria-label={strings.delegation.removeProfile} onclick={() => save({ profiles: config.profiles.filter(entry => entry.id !== profile.id), ...(config.profiles.length === 1 ? { enabled: false } : {}) })}><Trash2 size={14} /></button>
              </div>
            {/each}
          </div>

          <div class="limits">
            <label>{strings.delegation.maxAgents}<input type="number" min="1" max="8" value={config.maxAgents} onchange={(event) => save({ maxAgents: event.currentTarget.valueAsNumber, maxConcurrent: Math.min(config.maxConcurrent, event.currentTarget.valueAsNumber) })} /></label>
            <label>{strings.delegation.maxConcurrent}<input type="number" min="1" max="8" value={config.maxConcurrent} onchange={(event) => save({ maxConcurrent: event.currentTarget.valueAsNumber })} /></label>
            <label>{strings.delegation.maxTurns}<input type="number" min="1" max="100" value={config.maxTurns} onchange={(event) => save({ maxTurns: event.currentTarget.valueAsNumber })} /></label>
            <label>{strings.delegation.maxMinutes}<input type="number" min="1" max="120" value={config.maxMinutes} onchange={(event) => save({ maxMinutes: event.currentTarget.valueAsNumber })} /></label>
          </div>
          {#if config.enabled}
            <button type="button" class="quiet pause" onclick={() => save({ paused: !config.paused })}>
              {#if config.paused}<Play size={14} />{strings.delegation.resume}{:else}<Pause size={14} />{strings.delegation.pause}{/if}
            </button>
          {/if}
        </div>
      </details>
    {:else}
      <p class="notice">{strings.delegation.ownerOnly}</p>
    {/if}

    {#if store.owner && config.enabled && !config.paused && !selected}
      <details class="launch-section" open={view.agents.length === 0}>
        <summary>{strings.delegation.launch}</summary>
      <div class="launch" data-testid="delegation-launch">
        <div class="profile-picks" role="radiogroup" aria-label={strings.delegation.profileLabel}>
          {#each config.profiles as profile (profile.id)}
            <button type="button" class="chip" class:chosen={selectedProfile?.id === profile.id} role="radio" aria-checked={selectedProfile?.id === profile.id} onclick={() => (selectedProfileId = profile.id)}>
              <ProviderLogo providerId={profile.providerId} size={14} />{profile.name}
            </button>
          {/each}
        </div>
        <textarea rows="2" maxlength="12000" bind:value={task} placeholder={strings.delegation.taskPlaceholder} data-testid="delegation-task"></textarea>
        <button type="button" class="primary" disabled={!task.trim() || !selectedProfile || launching || view.agents.length >= config.maxAgents} data-testid="delegation-spawn" onclick={() => void launch()}><Plus size={14} />{launching ? strings.delegation.launching : strings.delegation.launch}</button>
      </div>
      </details>
    {/if}

    {#if view.turnsUsed >= config.maxTurns}
      <p class="limit" role="status" data-testid="delegation-limit-reached">{strings.delegation.limitReached}</p>
    {/if}

    <div class="team" class:detail={selected !== null}>
      <div class="members" aria-label={strings.delegation.team}>
        {#if view.agents.length === 0}
          <p class="empty">{strings.delegation.empty}</p>
        {:else}
          {#each view.agents as agent (agent.thread.id)}
            {@const progress = agentProgress(agent)}
            <button type="button" class="member" class:selected={selected?.thread.id === agent.thread.id} data-testid="delegation-member" data-agent-id={agent.thread.id} onclick={() => void store.selectDelegatedAgent(agent.thread.id)}>
              <StatusMark status={agent.thread.status} />
              <span class="member-main"><strong>{agent.thread.title}</strong><small>{store.providerOf(agent.thread.providerId)?.name ?? agent.thread.providerId} · {agent.thread.model ?? strings.thread.defaultModel}</small></span>
              <span class="status">{progress.status === 'done' ? strings.delegation.doneStatus : progress.status === 'stopped' ? strings.delegation.stoppedStatus : strings.threadStatus[agent.thread.status]}</span>
              <span class="task">{agent.task}</span>
              <span class="member-usage"><AgentElapsed startedAt={progress.startedAt} finishedAt={progress.finishedAt} active={progress.active} /></span>
              {#if agent.lastTurn?.usage}<span class="member-usage">{formatTokens(agent.lastTurn.usage.inputTokens + agent.lastTurn.usage.outputTokens + agent.lastTurn.usage.cacheReadTokens + agent.lastTurn.usage.cacheWriteTokens)} {strings.units.tokens}</span>{/if}
              {#if agent.result}<span class="result">{agent.result}</span>{/if}
            </button>
          {/each}
        {/if}
        {#if view.agents.some(agent => ['queued', 'running', 'waiting'].includes(agent.thread.status))}
          <button type="button" class="quiet stop-all" data-testid="delegation-stop-all" onclick={() => void store.stopDelegatedAgent()}><Square size={12} fill="currentColor" />{strings.delegation.stopAll}</button>
        {/if}
      </div>

      {#if selected}
        <article class="detail-pane" data-testid="delegation-detail">
          <header>
            <button type="button" class="ghost small icon back" aria-label={strings.delegation.backToTeam} onclick={() => void store.selectDelegatedAgent(null)}><ArrowLeft size={15} /></button>
            <div><strong>{selected.thread.title}</strong><small>{selected.task}</small></div>
            <button type="button" class="quiet small" data-testid="delegation-open-thread" onclick={() => void openChild()}>{strings.delegation.openThread}</button>
            {#if ['queued', 'running', 'waiting'].includes(selected.thread.status)}<button type="button" class="danger small" onclick={() => void store.stopDelegatedAgent(selected.thread.id)}><Square size={11} fill="currentColor" />{strings.delegation.stop}</button>{/if}
          </header>
          {#if store.delegationThread}
            <div class="transcript"><DelegationTranscript messages={store.delegationThread.messages} /></div>
          {:else}
            <p class="empty">{strings.delegation.loadingTranscript}</p>
          {/if}
          {#if selectedLetters.length > 0}
            <div class="letters">
              {#each selectedLetters.slice(-4) as letter (letter.id)}
                <p><strong>{letter.from.threadId === view.rootThreadId ? strings.delegation.parent : selected.thread.title}:</strong> {letter.text}<span>{strings.coordination.bubbleStatus[letter.status]}</span></p>
              {/each}
            </div>
          {/if}
          <form class="steer" onsubmit={(event) => { event.preventDefault(); void steer(); }}>
            <input bind:value={message} maxlength="4000" placeholder={strings.delegation.messagePlaceholder} oninput={() => (delivery = '')} data-testid="delegation-message" />
            <button type="submit" class="primary icon" aria-label={strings.delegation.send} disabled={!message.trim() || sending}><Send size={15} /></button>
          </form>
          {#if delivery}<p class="delivery" role="status">{delivery}</p>{/if}
        </article>
      {/if}
    </div>
  {/if}

  {#if store.delegationError}<p class="error" role="alert">{store.delegationError}</p>{/if}
</section>

<style>
  .delegation { container-type: inline-size; height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
  .surface-head { flex: none; padding: 14px 16px 12px; display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--color-border); }
  .surface-head h2 { display: flex; align-items: center; gap: 7px; font-size: var(--text-md); }
  .surface-head p { margin: 3px 0 0; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .usage { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 2px 5px; color: var(--color-muted-foreground); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  .usage strong { color: var(--color-foreground); }
  .settings { flex: none; border-bottom: 1px solid var(--color-border); }
  .settings > summary { padding: 10px 16px; cursor: pointer; color: var(--color-muted-foreground); font-size: var(--text-sm); font-weight: 600; }
  .settings-body { max-height: min(52dvh, 520px); padding: 0 16px 14px; overflow-y: auto; }
  .switch-row { min-height: var(--control-lg); display: flex; align-items: center; gap: 14px; }
  .switch-row > span { flex: 1; }
  .switch-row strong, .switch-row small, .profiles-head strong, .profiles-head small { display: block; }
  .switch-row small, .profiles-head small { color: var(--color-muted-foreground); font-size: var(--text-xs); font-weight: 400; }
  input[role='switch'] { appearance: none; position: relative; width: 40px; height: 24px; min-height: 24px; padding: 0; border-radius: 999px; background: var(--color-surface-3); }
  input[role='switch']::after { content: ''; position: absolute; width: 16px; height: 16px; top: 3px; left: 3px; border-radius: 50%; background: var(--color-muted-foreground); transition: transform var(--dur-2) var(--ease-out-quint); }
  input[role='switch']:checked { background: var(--color-foreground); }
  input[role='switch']:checked::after { transform: translateX(16px); background: var(--color-background); }
  .profiles-head { margin-top: 12px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .profiles { margin-top: 7px; display: grid; gap: 5px; }
  .profile { display: grid; grid-template-columns: minmax(90px, .8fr) minmax(140px, 1fr) auto var(--control-sm); gap: 6px; align-items: center; }
  .profile > input { min-width: 0; }
  .limits { margin-top: 12px; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
  .limits label { display: grid; gap: 4px; color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .limits input { width: 100%; min-width: 0; font-variant-numeric: tabular-nums; }
  .pause { margin-top: 10px; }
  .launch { flex: none; padding: 10px 16px; display: grid; grid-template-columns: 1fr auto; gap: 7px; border-bottom: 1px solid var(--color-border); }
  .launch-section { flex: none; }
  .launch-section > summary { padding: 10px 16px; cursor: pointer; color: var(--color-muted-foreground); font-size: var(--text-sm); border-bottom: 1px solid var(--color-border); }
  .profile-picks { grid-column: 1 / -1; display: flex; gap: 5px; overflow-x: auto; }
  .profile-picks .chosen { background: var(--color-active); color: var(--color-foreground); }
  .launch textarea { resize: vertical; min-height: 52px; }
  .launch .primary { height: auto; }
  .team { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr; }
  .team.detail { grid-template-columns: minmax(160px, .42fr) minmax(0, 1fr); }
  .members { min-height: 0; padding: 8px; overflow-y: auto; }
  .team.detail .members { border-right: 1px solid var(--color-border); }
  .member { width: 100%; height: auto; padding: 9px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 2px 7px; border: 1px solid transparent; border-radius: var(--radius-md); background: transparent; text-align: left; }
  .member:hover, .member.selected { background: var(--color-hover); border-color: var(--color-border); }
  .member-main strong, .member-main small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .member-main strong { font-size: var(--text-sm); }
  .member-main small, .status, .member-usage { color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .task, .result { grid-column: 2 / -1; font-size: var(--text-xs); line-height: 1.4; display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; }
  .task { color: var(--color-muted-foreground); line-clamp: 2; -webkit-line-clamp: 2; }
  .result { margin-top: 3px; padding: 5px 7px; line-clamp: 4; -webkit-line-clamp: 4; border-left: 2px solid var(--color-edge); background: var(--color-surface-2); white-space: pre-wrap; }
  .member-usage { grid-column: 2 / -1; }
  .stop-all { margin: 8px; }
  .detail-pane { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  .detail-pane > header { flex: none; min-height: 48px; padding: 7px 9px; display: flex; align-items: center; gap: 7px; border-bottom: 1px solid var(--color-border); }
  .detail-pane > header > div { flex: 1; min-width: 0; }
  .detail-pane > header strong, .detail-pane > header small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .detail-pane > header small { color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .back { display: none; }
  .transcript { flex: 1; min-height: 0; display: flex; overflow: hidden; }
  .letters { flex: none; max-height: 112px; padding: 7px 10px; overflow-y: auto; border-top: 1px solid var(--color-border); background: var(--color-surface-2); }
  .letters p { margin: 0; font-size: var(--text-xs); line-height: 1.45; }
  .letters p + p { margin-top: 5px; }
  .letters span { margin-left: 5px; color: var(--color-muted-foreground); }
  .steer { flex: none; padding: 8px; display: flex; gap: 6px; border-top: 1px solid var(--color-border); }
  .steer input { flex: 1; min-width: 0; }
  .delivery { flex: none; margin: -4px 10px 7px; color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .empty, .notice, .error { margin: 12px 16px; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .notice { padding: 8px 10px; border-left: 2px solid var(--color-edge); background: var(--color-surface-2); }
  .limit { flex: none; margin: 8px 16px; padding: 8px 10px; border-left: 2px solid var(--color-live); background: var(--color-surface-2); color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .error { color: var(--color-danger); }
  @container (max-width: 520px) {
    .surface-head { display: block; }
    .usage { margin-top: 6px; justify-content: flex-start; }
    .profile { grid-template-columns: minmax(0, 1fr) auto; }
    .profile > :global(.picker) { grid-column: 1 / -1; }
    .limits { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .launch { grid-template-columns: 1fr; }
    .launch textarea { min-height: 64px; }
    .launch .primary { min-height: var(--control); }
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
