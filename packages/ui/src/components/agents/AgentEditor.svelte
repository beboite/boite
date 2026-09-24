<script lang="ts">
  import { untrack } from 'svelte';
  import type { AgentEntities, AgentProfile, AgentGroup, AgentTeam, AgentMission, AgentSelection as ExecutionSelection } from '@boite/contracts';
  import { strings } from '../../lib/strings';
  import type { AgentEntryKind, AgentsView, AgentSelection } from '../../lib/agents.svelte';
  import ModelPicker from '../ModelPicker.svelte';
  import EffortSlider from '../EffortSlider.svelte';
  import Menu from '../Menu.svelte';

  /**
   * Creates a record, or edits one in its Settings tab (`embedded`). An agent's model, effort and
   * permissions are edited beside it in `AgentRuntimeSettings`, which owns the allowed routes.
   */
  let { view, kind, record = null, embedded = false, ondone, oncancel }: {
    view: AgentsView;
    kind: AgentEntryKind;
    record?: AgentEntities[AgentEntryKind] | null;
    embedded?: boolean;
    ondone: (selection: AgentSelection) => void;
    oncancel: () => void;
  } = $props();
  const initial = untrack(() => ({ kind, record }));
  const profile = initial.kind === 'profile' ? initial.record as AgentProfile | null : null;
  const group = initial.kind === 'group' ? initial.record as AgentGroup | null : null;
  const team = initial.kind === 'team' ? initial.record as AgentTeam | null : null;
  const mission = initial.kind === 'mission' ? initial.record as AgentMission | null : null;
  const defaultAccount = untrack(() => view.store.accounts.find(a => view.store.providerOf(a.providerId)?.available));
  const defaultModels = untrack(() => defaultAccount ? view.store.modelsOf(defaultAccount.providerId, defaultAccount.id) : []);
  const TOOLS = ['messages', 'missions', 'memory', 'artifacts', 'decisions', 'routines'] as const;
  const PERMISSIONS = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk'] as const;

  let name = $state(profile?.name ?? group?.name ?? team?.name ?? mission?.title ?? '');
  let domain = $state(profile?.domain ?? '');
  let instructions = $state(profile?.instructions ?? '');
  let description = $state(team?.description ?? '');
  let selection = $state<ExecutionSelection>({ ...(profile?.selection ?? { providerId: defaultAccount?.providerId ?? '', accountId: defaultAccount?.id ?? '', model: defaultModels.find(m => m.default)?.id ?? defaultModels[0]?.id ?? null, effort: null, permissionMode: 'default' }) });
  let tools = $state<string[]>(profile?.tools ?? [...TOOLS]);
  let status = $state(profile?.status ?? 'active');
  let accountIntegration = $state(profile?.accountIntegration ?? 'provider');
  let memberIds = $state(group?.memberIds ?? team?.members.map(m => m.agentId) ?? mission?.agentIds ?? []);
  let responsibilities = $state<Record<string, string>>(Object.fromEntries(team?.members.map(m => [m.agentId, m.responsibility]) ?? []));
  let mode = $state(group?.mode ?? 'mentions');
  let maxTurns = $state(group?.maxTurns ?? mission?.maxTurns ?? 6);
  let perAgent = $state(group?.maxTurnsPerAgent ?? 2);
  let paused = $state(group?.paused ?? team?.paused ?? false);
  let groupId = $state(team?.groupId ?? null);
  let teamId = $state(mission?.teamId ?? null);
  let projectId = $state(mission?.projectId ?? null);
  let projectIds = $state(team?.projectIds ?? []);
  let objective = $state(mission?.objective ?? '');
  let expectedResult = $state(mission?.expectedResult ?? '');
  let minutes = $state((mission?.maxDurationMs ?? 600000) / 60000);
  let tokens = $state<number | null>(mission?.maxTokens ?? null);
  let resourceIds = $state(mission?.resourceIds ?? []);

  const labels = $derived(strings.agents);
  const creating = !initial.record;
  const resourceOptions = $derived(view.snapshot?.resources.filter(r => r.scope.kind === 'mission' && r.scope.id === mission?.id || r.scope.kind === 'team' && r.scope.id === teamId || r.scope.kind === 'project' && r.scope.id === projectId) ?? []);
  const agentOptions = $derived(view.snapshot?.profiles.filter(a => a.status !== 'archived' && (!teamId || kind !== 'mission' || view.snapshot?.teams.find(t => t.id === teamId)?.members.some(m => m.agentId === a.id))) ?? []);
  const permissionLabels = $derived<Record<ExecutionSelection['permissionMode'], string>>({ default: labels.ask, acceptEdits: labels.edits, plan: labels.plan, bypassPermissions: labels.full, dontAsk: labels.deny });
  const provider = $derived(view.store.providerOf(selection.providerId));
  const effort = $derived(view.store.modelOf(selection)?.effort);

  function toggle(values: string[], id: string): string[] { return values.includes(id) ? values.filter(v => v !== id) : [...values, id]; }

  function stored(): AgentEntities[AgentEntryKind] | undefined {
    const snapshot = view.snapshot, id = initial.record?.id;
    if (!snapshot || !id) return undefined;
    const list: AgentEntities[AgentEntryKind][] = kind === 'profile' ? snapshot.profiles : kind === 'group' ? snapshot.groups : kind === 'team' ? snapshot.teams : snapshot.missions;
    return list.find(r => r.id === id);
  }

  async function save() {
    // A profile's Settings tab saves beside the runtime card, which may have moved the revision and
    // the model since this form opened: keep the current route and revision, but only while every
    // field this form edits is unchanged. Anything else keeps the revision it read, so a stale
    // form is refused rather than written over newer values.
    const latest = stored();
    const edited = (r: AgentProfile) => JSON.stringify([r.name, r.domain, r.instructions, r.status, r.tools, r.accountIntegration]);
    const rebase = kind === 'profile' && latest && profile && edited(latest as AgentProfile) === edited(profile);
    const version = initial.record ? { id: initial.record.id, expectedRevision: (rebase ? latest : initial.record).revision } : {};
    let result: AgentEntities[AgentEntryKind] | null = null;
    if (kind === 'profile') result = await view.call('agents.profile.save', { ...version, value: { name, domain, instructions, avatar: profile?.avatar ?? '', selection: creating || !rebase ? selection : (latest as AgentProfile).selection, status, tools, accountIntegration } });
    if (kind === 'group') result = await view.call('agents.group.save', { ...version, value: { name, memberIds, mode, maxTurns, maxTurnsPerAgent: perAgent, paused } });
    if (kind === 'team') result = await view.call('agents.team.save', { ...version, value: { name, description, members: memberIds.map(agentId => ({ agentId, responsibility: responsibilities[agentId] ?? '' })), groupId, projectIds, paused } });
    if (kind === 'mission') result = await view.call('agents.mission.save', { ...version, value: { title: name, objective, expectedResult, agentIds: memberIds, teamId, projectId, status: (latest as AgentMission | undefined)?.status ?? mission?.status ?? 'open', maxTurns, maxDurationMs: Math.round(minutes * 60000), maxTokens: tokens || null, resourceIds: resourceIds.filter(id => resourceOptions.some(r => r.id === id)) } });
    if (result) ondone({ kind, id: result.id });
  }
</script>

{#snippet actions()}
  <div class="agent-form-actions">
    <button class="primary" type="submit" disabled={view.pending || !name.trim() || kind === 'profile' && creating && (!selection.accountId || !selection.model)} data-testid="agent-save">{creating ? labels.createAction : labels.save}</button>
    {#if creating}<button type="button" class="ghost" onclick={oncancel}>{labels.cancel}</button>{/if}
  </div>
{/snippet}

{#snippet kebacc()}
  <label class="switch-row"><span class="text">{labels.kebacc}<span class="hint">{view.snapshot?.limits.kebaccExperiment ? labels.kebaccHint : labels.experimentOff}</span></span><input type="checkbox" role="switch" disabled={!view.snapshot?.limits.kebaccExperiment} checked={accountIntegration === 'kebacc-experiment'} onchange={e => { accountIntegration = e.currentTarget.checked ? 'kebacc-experiment' : 'provider'; }} /></label>
{/snippet}

{#snippet members()}
  <fieldset class="agent-field">
    <legend>{kind === 'mission' ? labels.missionMembers : labels.members}</legend>
    {#if agentOptions.length}
      <div class="agent-checks">
        {#each agentOptions as agent (agent.id)}
          <label class="agent-chip-check"><input type="checkbox" checked={memberIds.includes(agent.id)} onchange={() => { memberIds = toggle(memberIds, agent.id); }} />{agent.name}</label>
        {/each}
      </div>
    {:else}<p class="hint">{labels.noMembers}</p>{/if}
  </fieldset>
{/snippet}

<form class="agents-form" onsubmit={event => { event.preventDefault(); void save(); }} data-testid="agent-editor">
  {#if creating}
    <header class="agents-page-head">
      <h2>{labels.newTitle[kind]}</h2>
      <p>{labels.kindHints[kind]}</p>
    </header>
  {/if}

  <section class="card">
    {#if embedded}<h2>{labels.identity}</h2>{/if}
    <label class="agent-field">{labels.name}<input required maxlength="200" bind:value={name} data-testid="agent-name" /></label>

    {#if kind === 'profile'}
      <label class="agent-field">{labels.domain}<input bind:value={domain} maxlength="500" placeholder={labels.rolePlaceholder} /></label>
      <label class="agent-field">{labels.instructions}<textarea bind:value={instructions} rows="5" maxlength="32000"></textarea></label>
      {#if embedded}
        <div class="agent-field"><span>{labels.status}</span>
          <Menu placement="bottom" label={labels.status} items={(['active', 'paused', 'archived'] as const).map(id => ({ id, label: labels[id], active: status === id }))} onpick={id => { status = id as AgentProfile['status']; }}>{labels[status]}</Menu>
        </div>
      {/if}
    {:else if kind === 'group'}
      {@render members()}
      <div class="agent-field"><span>{labels.mode}</span>
        <Menu placement="bottom" label={labels.mode} items={(['mentions', 'round', 'autonomous'] as const).map(id => ({ id, label: labels[id], active: mode === id }))} onpick={id => { mode = id as AgentGroup['mode']; }}>{labels[mode]}</Menu>
        <p class="hint">{labels.modeHint}</p>
      </div>
    {:else if kind === 'team'}
      <label class="agent-field">{labels.description}<textarea bind:value={description} rows="2"></textarea></label>
      {@render members()}
      {#each memberIds as id (id)}
        <label class="agent-field">{view.snapshot?.profiles.find(a => a.id === id)?.name} · {labels.responsibility}<input bind:value={responsibilities[id]} /></label>
      {/each}
    {:else}
      <label class="agent-field">{labels.objective}<textarea required bind:value={objective} rows="4" maxlength="32000"></textarea></label>
      <label class="agent-field">{labels.expectedResult}<textarea bind:value={expectedResult} rows="2" maxlength="8000"></textarea></label>
      <div class="agent-field"><span>{labels.team}</span>
        <Menu placement="bottom" label={labels.team} items={[{ id: '', label: labels.noTeam }, ...(view.snapshot?.teams.map(t => ({ id: t.id, label: t.name })) ?? [])]} onpick={id => { teamId = id || null; memberIds = memberIds.filter(a => !id || view.snapshot?.teams.find(t => t.id === id)?.members.some(m => m.agentId === a)); }}>{view.snapshot?.teams.find(t => t.id === teamId)?.name ?? labels.noTeam}</Menu>
      </div>
      {@render members()}
    {/if}

  {#if kind === 'profile' && embedded}
      <fieldset class="agent-field"><legend>{labels.tools}</legend>
        <div class="agent-checks">{#each TOOLS as tool (tool)}<label class="agent-chip-check"><input type="checkbox" checked={tools.includes(tool)} onchange={() => { tools = toggle(tools, tool); }} />{labels[tool]}</label>{/each}</div>
      </fieldset>
      {#if provider?.protocol === 'agy'}{@render kebacc()}{/if}
    {/if}
    {#if embedded && kind === 'profile'}{@render actions()}{/if}
  </section>

  {#if kind === 'profile' && creating}
    <section class="card">
      <h2>{labels.model}</h2>
      <p class="hint">{labels.identityHint}</p>
      {#if selection.accountId}
        <div class="agent-inline">
          <ModelPicker store={view.store} choice={selection} onpick={patch => { selection = { ...selection, effort: null, ...patch }; }} />
          {#if effort?.levels.length}<EffortSlider levels={effort.levels} active={selection.effort ?? effort.default} onpick={id => { selection.effort = id; }} />{/if}
          <Menu placement="bottom" label={labels.permissions} items={PERMISSIONS.map(id => ({ id, label: permissionLabels[id], active: selection.permissionMode === id }))} onpick={id => { selection.permissionMode = id as ExecutionSelection['permissionMode']; }}>{permissionLabels[selection.permissionMode]}</Menu>
        </div>
        {#if provider?.capabilities.approvals === false}<p class="hint">{labels.noApprovals}</p>{/if}
      {:else}<p class="hint">{labels.noAccount}</p>{/if}
    </section>
  {/if}

  {#if !(embedded && kind === 'profile')}
  <details class="card agent-more">
    <summary>{labels.advanced}</summary>
    {#if kind === 'profile'}
      <fieldset class="agent-field"><legend>{labels.tools}</legend>
        <div class="agent-checks">{#each TOOLS as tool (tool)}<label class="agent-chip-check"><input type="checkbox" checked={tools.includes(tool)} onchange={() => { tools = toggle(tools, tool); }} />{labels[tool]}</label>{/each}</div>
      </fieldset>
      {#if provider?.protocol === 'agy'}{@render kebacc()}{/if}
    {:else if kind === 'group'}
      <div class="agent-columns"><label class="agent-field">{labels.maxTurns}<input type="number" min="1" max="100" required bind:value={maxTurns} /></label><label class="agent-field">{labels.perAgent}<input type="number" min="1" max="20" required bind:value={perAgent} /></label></div>
    {:else if kind === 'team'}
      <div class="agent-field"><span>{labels.group}</span>
        <Menu placement="bottom" label={labels.group} items={[{ id: '', label: labels.noGroup }, ...(view.snapshot?.groups.map(g => ({ id: g.id, label: g.name })) ?? [])]} onpick={id => { groupId = id || null; }}>{view.snapshot?.groups.find(g => g.id === groupId)?.name ?? labels.noGroup}</Menu>
      </div>
      {#if view.store.projects.length}
        <fieldset class="agent-field"><legend>{labels.project}</legend><div class="agent-checks">{#each view.store.projects as project (project.id)}<label class="agent-chip-check"><input type="checkbox" checked={projectIds.includes(project.id)} onchange={() => { projectIds = toggle(projectIds, project.id); }} />{project.name}</label>{/each}</div></fieldset>
      {/if}
    {:else}
      <div class="agent-field"><span>{labels.project}</span>
        <Menu placement="bottom" label={labels.project} items={[{ id: '', label: labels.noProject }, ...view.store.projects.map(p => ({ id: p.id, label: p.name }))]} onpick={id => { projectId = id || null; }}>{view.store.projects.find(p => p.id === projectId)?.name ?? labels.noProject}</Menu>
      </div>
      <div class="agent-columns">
        <label class="agent-field">{labels.maxTurns}<input required type="number" min="1" max="1000" bind:value={maxTurns} /></label>
        <label class="agent-field">{labels.minutes}<input required type="number" min="1" max="1440" bind:value={minutes} /></label>
        <label class="agent-field">{labels.tokens}<input type="number" min="1" step="1" bind:value={tokens} /></label>
      </div>
      {#if resourceOptions.length}<fieldset class="agent-field"><legend>{labels.resources}</legend><div class="agent-checks">{#each resourceOptions as resource (resource.id)}<label class="agent-chip-check"><input type="checkbox" checked={resourceIds.includes(resource.id)} onchange={() => { resourceIds = toggle(resourceIds, resource.id); }} />{resource.name} · {labels[resource.access]}</label>{/each}</div></fieldset>{/if}
    {/if}
    {#if kind === 'group' || kind === 'team'}
      <label class="switch-row"><span class="text">{labels.paused}</span><input type="checkbox" role="switch" bind:checked={paused} /></label>
    {/if}
  </details>
  {/if}

  {#if !embedded || kind !== 'profile'}{@render actions()}{/if}
</form>
