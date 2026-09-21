<script lang="ts">
  import { untrack } from 'svelte';
  import type { AgentEntities, AgentProfile, AgentGroup, AgentTeam, AgentMission, AgentSelection as ExecutionSelection } from '@boite/contracts';
  import { strings } from '../../lib/strings';
  import type { AgentEntryKind, AgentsView, AgentSelection } from '../../lib/agents.svelte';
  import ModelPicker from '../ModelPicker.svelte';
  import EffortSlider from '../EffortSlider.svelte';
  import Menu from '../Menu.svelte';

  let { view, kind, record = null, ondone, oncancel }: { view: AgentsView; kind: AgentEntryKind; record?: AgentEntities[AgentEntryKind] | null; ondone: (selection: AgentSelection) => void; oncancel: () => void } = $props();
  const initial = untrack(() => ({ kind, record }));
  const profile = initial.kind === 'profile' ? initial.record as AgentProfile | null : null;
  const group = initial.kind === 'group' ? initial.record as AgentGroup | null : null;
  const team = initial.kind === 'team' ? initial.record as AgentTeam | null : null;
  const mission = initial.kind === 'mission' ? initial.record as AgentMission | null : null;
  const defaultAccount = untrack(() => view.store.accounts.find(a => view.store.providerOf(a.providerId)?.available));
  let name = $state(profile?.name ?? group?.name ?? team?.name ?? mission?.title ?? '');
  let domain = $state(profile?.domain ?? '');
  let instructions = $state(profile?.instructions ?? '');
  let description = $state(team?.description ?? '');
  let selection = $state<ExecutionSelection>({ ...(profile?.selection ?? { providerId: defaultAccount?.providerId ?? '', accountId: defaultAccount?.id ?? '', model: null, effort: null, permissionMode: 'default' }) });
  let tools = $state(profile?.tools ?? ['messages', 'missions', 'memory', 'artifacts', 'decisions']);
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
  let tokens = $state(mission?.maxTokens?.toString() ?? '');
  let resourceIds = $state(mission?.resourceIds ?? []);
  const resourceOptions = $derived(view.snapshot?.resources.filter(r => r.scope.kind === 'mission' && r.scope.id === mission?.id || r.scope.kind === 'team' && r.scope.id === teamId || r.scope.kind === 'project' && r.scope.id === projectId) ?? []);
  const labels = $derived(strings.agents);
  const agentOptions = $derived(view.snapshot?.profiles.filter(a => a.status !== 'archived' && (!teamId || kind !== 'mission' || view.snapshot?.teams.find(t => t.id === teamId)?.members.some(m => m.agentId === a.id))) ?? []);
  function toggle(values: string[], id: string): string[] { return values.includes(id) ? values.filter(v => v !== id) : [...values, id]; }
  async function save() {
    const version = initial.record ? { id: initial.record.id, expectedRevision: initial.record.revision } : {};
    let result: AgentEntities[AgentEntryKind] | null = null;
    if (kind === 'profile') result = await view.call('agents.profile.save', { ...version, value: { name, domain, instructions, avatar: profile?.avatar ?? '', selection, status, tools, accountIntegration } });
    if (kind === 'group') result = await view.call('agents.group.save', { ...version, value: { name, memberIds, mode, maxTurns, maxTurnsPerAgent: perAgent, paused } });
    if (kind === 'team') result = await view.call('agents.team.save', { ...version, value: { name, description, members: memberIds.map(agentId => ({ agentId, responsibility: responsibilities[agentId] ?? '' })), groupId, projectIds, paused } });
    if (kind === 'mission') result = await view.call('agents.mission.save', { ...version, value: { title: name, objective, expectedResult, agentIds: memberIds, teamId, projectId, status: mission?.status ?? 'open', maxTurns, maxDurationMs: Math.round(minutes * 60000), maxTokens: tokens.trim() ? Number(tokens) : null, resourceIds: resourceIds.filter(id => resourceOptions.some(r => r.id === id)) } });
    if (result) ondone({ kind, id: result.id });
  }
</script>

<form class="agents-form" onsubmit={event => { event.preventDefault(); void save(); }} data-testid="agent-editor">
  <div class="agent-section-heading"><h2>{record ? labels.edit : labels.create} {labels[kind === 'profile' ? 'profiles' : kind === 'group' ? 'groups' : kind === 'team' ? 'teams' : 'missions']}</h2><button type="button" class="ghost" onclick={oncancel}>{labels.cancel}</button></div>
  <label>{labels.name}<input required maxlength="200" bind:value={name} data-testid="agent-name" /></label>
  {#if kind === 'profile'}
    <p class="muted">{labels.identityHint}</p>
    <label>{labels.domain}<input bind:value={domain} maxlength="500" /></label>
    <label>{labels.instructions}<textarea bind:value={instructions} rows="6" maxlength="32000"></textarea></label>
    <div class="agent-field"><span>{labels.model}</span>
      {#if selection.accountId}<ModelPicker store={view.store} choice={selection} onpick={patch => { selection = { ...selection, effort: null, ...patch }; }} />{:else}<p class="muted">{labels.noAccount}</p>{/if}
    </div>
    {@const effort = view.store.modelOf(selection)?.effort}
    {#if effort?.levels.length}<EffortSlider levels={effort.levels} active={selection.effort ?? effort.default} onpick={id => { selection.effort = id; }} />{/if}
    <Menu placement="bottom" label={labels.permissions} items={(['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk'] as const).map((id, i) => ({ id, label: [labels.ask, labels.edits, labels.plan, labels.full, labels.deny][i]!, active: selection.permissionMode === id }))} onpick={id => { selection.permissionMode = id as ExecutionSelection['permissionMode']; }}>
      {labels.permissions}: {({ default: labels.ask, acceptEdits: labels.edits, plan: labels.plan, bypassPermissions: labels.full, dontAsk: labels.deny })[selection.permissionMode]}
    </Menu>
    {#if view.store.providerOf(selection.providerId)?.capabilities.approvals === false}<p class="muted">{labels.noApprovals}</p>{/if}
    <fieldset><legend>{labels.tools}</legend><div class="agent-checks">{#each ['messages', 'missions', 'memory', 'artifacts', 'decisions'] as tool (tool)}<label><input type="checkbox" checked={tools.includes(tool)} onchange={() => { tools = toggle(tools, tool); }} />{labels[tool as 'messages']}</label>{/each}</div></fieldset>
    <Menu placement="bottom" label={labels.activity} items={(['active', 'paused', 'archived'] as const).map(id => ({ id, label: labels[id], active: status === id }))} onpick={id => { status = id as AgentProfile['status']; }}>{labels[status]}</Menu>
    {#if view.store.providerOf(selection.providerId)?.protocol === 'agy'}
      <label class="agent-check"><input type="checkbox" disabled={!view.snapshot?.limits.kebaccExperiment} checked={accountIntegration === 'kebacc-experiment'} onchange={e => { accountIntegration = e.currentTarget.checked ? 'kebacc-experiment' : 'provider'; }} />{labels.kebacc}</label><p class="muted">{labels.kebaccHint}</p>
    {/if}
  {:else}
    {#if kind === 'mission'}
      <Menu placement="bottom" label={labels.team} items={[{ id: '', label: labels.noTeam }, ...(view.snapshot?.teams.map(t => ({ id: t.id, label: t.name })) ?? [])]} onpick={id => { teamId = id || null; memberIds = memberIds.filter(a => !id || view.snapshot?.teams.find(t => t.id === id)?.members.some(m => m.agentId === a)); }}>{view.snapshot?.teams.find(t => t.id === teamId)?.name ?? labels.noTeam}</Menu>
    {/if}
    <fieldset><legend>{labels.members}</legend><div class="agent-checks">{#each agentOptions as agent (agent.id)}<label><input type="checkbox" checked={memberIds.includes(agent.id)} onchange={() => { memberIds = toggle(memberIds, agent.id); }} />{agent.name}</label>{/each}</div></fieldset>
    {#if kind === 'group'}
      <Menu placement="bottom" label={labels.mode} items={(['mentions', 'round', 'autonomous'] as const).map(id => ({ id, label: labels[id], active: mode === id }))} onpick={id => { mode = id as AgentGroup['mode']; }}>{labels[mode]}</Menu>
      <p class="muted">{labels.modeHint}</p>
      <div class="agent-columns"><label>{labels.maxTurns}<input type="number" min="1" max="100" required bind:value={maxTurns} /></label><label>{labels.perAgent}<input type="number" min="1" max="20" required bind:value={perAgent} /></label></div>
    {:else if kind === 'team'}
      <label>{labels.description}<textarea bind:value={description} rows="3"></textarea></label>
      {#each memberIds as id (id)}<label>{view.snapshot?.profiles.find(a => a.id === id)?.name} · {labels.responsibility}<input bind:value={responsibilities[id]} /></label>{/each}
      <Menu placement="bottom" label={labels.group} items={[{ id: '', label: labels.noGroup }, ...(view.snapshot?.groups.map(g => ({ id: g.id, label: g.name })) ?? [])]} onpick={id => { groupId = id || null; }}>{view.snapshot?.groups.find(g => g.id === groupId)?.name ?? labels.noGroup}</Menu>
      <fieldset><legend>{labels.project}</legend><div class="agent-checks">{#each view.store.projects as project (project.id)}<label><input type="checkbox" checked={projectIds.includes(project.id)} onchange={() => { projectIds = toggle(projectIds, project.id); }} />{project.name}</label>{/each}</div></fieldset>
    {:else}
      <label>{labels.objective}<textarea required bind:value={objective} rows="4" maxlength="32000"></textarea></label>
      <label>{labels.expectedResult}<textarea bind:value={expectedResult} rows="2" maxlength="8000"></textarea></label>
      <Menu placement="bottom" label={labels.project} items={[{ id: '', label: labels.noProject }, ...view.store.projects.map(p => ({ id: p.id, label: p.name }))]} onpick={id => { projectId = id || null; }}>{view.store.projects.find(p => p.id === projectId)?.name ?? labels.noProject}</Menu>
      <div class="agent-columns"><label>{labels.maxTurns}<input required type="number" min="1" max="1000" bind:value={maxTurns} /></label><label>{labels.minutes}<input required type="number" min="1" max="1440" bind:value={minutes} /></label></div>
      <label>{labels.tokens}<input inputmode="numeric" bind:value={tokens} /></label>
      {#if resourceOptions.length}<fieldset><legend>{labels.resources}</legend><div class="agent-checks">{#each resourceOptions as resource (resource.id)}<label><input type="checkbox" checked={resourceIds.includes(resource.id)} onchange={() => { resourceIds = toggle(resourceIds, resource.id); }} />{resource.name} · {labels[resource.access]}</label>{/each}</div></fieldset>{/if}
    {/if}
    {#if kind !== 'mission'}<label class="agent-check"><input type="checkbox" bind:checked={paused} />{labels.paused}</label>{/if}
  {/if}
  <button class="primary" type="submit" disabled={view.pending || !name.trim() || kind === 'profile' && !selection.accountId} data-testid="agent-save">{labels.save}</button>
</form>
