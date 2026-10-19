<script lang="ts">
  import { errorText } from '../../lib/errors';
  import { secureId } from '../../lib/secure-id';
  import { onMount, untrack } from 'svelte';
  import { Dices, Palette } from '@lucide/svelte';
  import type { AgentEntities, AgentProfile, AgentGroup, AgentTeam, AgentMission, AgentSelection as ExecutionSelection, RpcParams, RpcResult } from '@boite/contracts';
  import { Autosave, TYPING_MS } from '../../lib/autosave.svelte';
  import { fill, strings } from '../../lib/strings';
  import { confirm } from '../../lib/confirm.svelte';
  import type { AgentEntryKind, AgentsView, AgentSelection } from '../../lib/agents.svelte';
  import type { Store } from '../../lib/store.svelte';
  import type { MenuItem } from '../../lib/menu';
  import { workspace } from '../../lib/workspace.svelte';
  import ModelPicker from '../ModelPicker.svelte';
  import EffortSlider from '../EffortSlider.svelte';
  import Menu from '../Menu.svelte';
  import InfoTip from '../InfoTip.svelte';
  import SaveStatus from '../SaveStatus.svelte';
  import { encodeRobot, robotOf, seededRobot } from '../../lib/robots';
  import AgentAvatar from './AgentAvatar.svelte';
  import RobotPicker from './RobotPicker.svelte';

  /**
   * Creates a record with its Create button, or edits one in its Settings tab (`embedded`), where
   * every change saves by itself. An agent's model, effort and permissions are edited beside it in
   * `AgentRuntimeSettings`, which owns the allowed routes.
   * A mission started from a conversation arrives with that conversation's members and team (`preset`).
   */
  let { view, kind, record = null, embedded = false, preset, heading, ondone, oncancel }: {
    view: AgentsView;
    kind: AgentEntryKind;
    record?: AgentEntities[AgentEntryKind] | null;
    embedded?: boolean;
    preset?: { memberIds: string[]; teamId: string | null };
    /** The embedded card's title, when it is not the record's identity. */
    heading?: string;
    ondone: (selection: AgentSelection) => void;
    oncancel: () => void;
  } = $props();
  const initial = untrack(() => ({ kind, record, preset }));
  const profile = initial.kind === 'profile' ? initial.record as AgentProfile | null : null;
  const group = initial.kind === 'group' ? initial.record as AgentGroup | null : null;
  const team = initial.kind === 'team' ? initial.record as AgentTeam | null : null;
  const mission = initial.kind === 'mission' ? initial.record as AgentMission | null : null;
  /** A new agent starts on the first available account of the machine it will run on, with that account's default model. */
  function defaultSelection(on: Store, permissionMode: ExecutionSelection['permissionMode'] = 'default'): ExecutionSelection {
    const account = on.accounts.find(a => on.providerOf(a.providerId)?.available);
    const models = account ? on.modelsOf(account.providerId, account.id) : [];
    return { providerId: account?.providerId ?? '', accountId: account?.id ?? '', model: models.find(m => m.default)?.id ?? models[0]?.id ?? null, effort: null, permissionMode };
  }
  const TOOLS = ['messages', 'missions', 'memory', 'artifacts', 'decisions', 'routines'] as const;
  const PERMISSIONS = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'yolo', 'dontAsk'] as const;

  let name = $state(profile?.name ?? group?.name ?? team?.name ?? mission?.title ?? '');
  let domain = $state(profile?.domain ?? '');
  let instructions = $state(profile?.instructions ?? '');
  let description = $state(team?.description ?? '');
  /**
   * The machine a new agent lives on. Agents belong to one core: its accounts, memory and planned
   * tasks stay there. It starts as the machine this page shows; another one creates the agent on
   * that core and then opens it there.
   */
  let host = $state<Store>(untrack(() => view.store));
  let moving = $state(false);
  let selection = $state<ExecutionSelection>({ ...(profile?.selection ?? untrack(() => defaultSelection(view.store))) });
  let tools = $state<string[]>(profile?.tools ?? [...TOOLS]);
  /** A new agent gets a robot of its own at once; an existing one shows the robot it wears. */
  let robot = $state(robotOf(profile?.id ?? '', profile?.avatar ?? '') ?? seededRobot(profile?.id ?? secureId()));
  let robotTouched = $state(!profile);
  let dressing = $state(false);
  let status = $state(profile?.status ?? 'active');
  let saving = $state(false);
  let memberIds = $state(group?.memberIds ?? team?.members.map(m => m.agentId) ?? mission?.agentIds ?? initial.preset?.memberIds ?? []);
  let responsibilities = $state<Record<string, string>>(Object.fromEntries(team?.members.map(m => [m.agentId, m.responsibility]) ?? []));
  let mode = $state(group?.mode ?? 'mentions');
  let maxTurns = $state(group?.maxTurns ?? mission?.maxTurns ?? 6);
  let perAgent = $state(group?.maxTurnsPerAgent ?? 2);
  let paused = $state(group?.paused ?? team?.paused ?? false);
  let groupId = $state(team?.groupId ?? null);
  let teamId = $state(mission?.teamId ?? initial.preset?.teamId ?? null);
  let projectId = $state(mission?.projectId ?? null);
  /** A team's projects, or the projects the owner entrusts to an agent. */
  let projectIds = $state(team?.projectIds ?? profile?.projectIds ?? []);
  const projectKey = (ids: readonly string[] | undefined) => JSON.stringify([...(ids ?? [])].sort());
  /** The agent's projects this form last read: what tells an edit here from a change made elsewhere. */
  let projectsRead = projectKey(profile?.projectIds);
  let revisionRead = profile?.revision ?? 0;
  let objective = $state(mission?.objective ?? '');
  let expectedResult = $state(mission?.expectedResult ?? '');
  let minutes = $state((mission?.maxDurationMs ?? 600000) / 60000);
  let tokens = $state<number | null>(mission?.maxTokens ?? null);
  let resourceIds = $state(mission?.resourceIds ?? []);

  const labels = $derived(strings.agents);
  const creating = !initial.record;
  const resourceOptions = $derived(view.snapshot?.resources.filter(r => r.scope.kind === 'mission' && r.scope.id === mission?.id || r.scope.kind === 'team' && r.scope.id === teamId || r.scope.kind === 'project' && r.scope.id === projectId) ?? []);
  const agentOptions = $derived(view.snapshot?.profiles.filter(a => a.status !== 'archived' && (!teamId || kind !== 'mission' || view.snapshot?.teams.find(t => t.id === teamId)?.members.some(m => m.agentId === a.id))) ?? []);
  const permissionLabels = $derived<Record<ExecutionSelection['permissionMode'], string>>({ default: labels.ask, acceptEdits: labels.edits, plan: labels.plan, bypassPermissions: labels.full, yolo: strings.permissionMode.yolo, dontAsk: labels.deny });
  const provider = $derived(host.providerOf(selection.providerId));
  const effort = $derived(host.modelOf(selection)?.effort);
  const hostMachine = $derived(workspace.machines.find(m => m.store === host));
  const hostItems = $derived<MenuItem[]>(workspace.machines.map(m => {
    const offline = m.store.connection !== 'ready';
    const usable = !offline && m.store.owner;
    return { id: m.id, label: m.label, active: m.store === host, disabled: !usable, ...(usable ? {} : { hint: offline ? labels.machineOffline : labels.machineNotOwner }) };
  }));
  const busy = $derived(view.pending || moving || saving);
  /** The projects an agent may be entrusted: those of the machine it lives on, the drafts aside. */
  const entrustable = $derived(host.projects.filter(p => p.id !== host.draftsProject?.id));

  function pickHost(id: string) {
    const next = workspace.machines.find(m => m.id === id)?.store;
    if (!next || next === host) return;
    host = next;
    selection = defaultSelection(next, selection.permissionMode);
    // Projects are a machine's own: another core knows none of this one's.
    projectIds = [];
  }

  /** Creates the agent on another machine's core, then shows it there. */
  async function createOn(target: Store, value: RpcParams<'agents.profile.save'>['value']) {
    if (moving) return;
    moving = true; view.error = '';
    let created: AgentProfile;
    try {
      if (!target.client || target.connection !== 'ready') throw new Error(fill(strings.agents.machineUnreachable, { name: workspace.machines.find(m => m.store === target)?.label ?? strings.machines.local }));
      created = await target.client.call('agents.profile.save', { value: $state.snapshot(value) as typeof value });
    } catch (error) {
      view.error = errorText(error);
      moving = false;
      return;
    }
    // Showing the other machine replaces this page, form and all: nothing here is touched after it.
    await workspace.select(target);
    target.showAgents(created.id);
  }

  /**
   * An agent's projects change outside this form too: a card in a thread
   * applied, or the snapshot this page drew first was older. The form follows
   * while its own projects are untouched, and keeps an edit in progress.
   */
  $effect(() => {
    if (kind !== 'profile') return;
    const latest = stored() as AgentProfile | undefined;
    if (!latest) return;
    const next = projectKey(latest.projectIds);
    untrack(() => {
      if (latest.revision <= revisionRead) return;
      revisionRead = latest.revision;
      if (next === projectsRead) return;
      if (projectKey(projectIds) === projectsRead) projectIds = [...(latest.projectIds ?? [])];
      projectsRead = next;
    });
  });

  function toggle(values: string[], id: string): string[] { return values.includes(id) ? values.filter(v => v !== id) : [...values, id]; }

  type Saving = 'agents.profile.save' | 'agents.group.save' | 'agents.team.save' | 'agents.mission.save';
  type Send = <M extends Saving>(method: M, params: () => RpcParams<M>) => Promise<RpcResult<M> | null>;
  let form = $state<HTMLFormElement>();
  /** The record as the core last returned it to this form. */
  let base = initial.record;
  const autosave = new Autosave(write, () => form?.checkValidity() === false || !name.trim() ? strings.settings.autosave.invalid : null);
  // Leaving the tab sends a change still waiting for a typing pause.
  onMount(() => () => { if (!creating) void autosave.flush(); });

  /** An edit to an existing record: a typed field waits for a pause, anything else saves now. */
  function edited(delay = 0) { if (!creating) autosave.change('', delay); }
  function typing(event: Event) {
    const field = event.target as HTMLInputElement;
    if (field.type !== 'checkbox' && field.type !== 'radio') edited(TYPING_MS);
  }
  function committed(event: Event) {
    const field = event.target as HTMLInputElement;
    if (field.type === 'checkbox' || field.type === 'radio') edited(); else if (!creating) void autosave.flush();
  }
  /** Archiving stops the agent: it still asks, and only a confirmed archive is saved. */
  async function pickStatus(next: AgentProfile['status']) {
    const existing = stored() as AgentProfile | undefined;
    if (existing && next === 'archived' && status !== 'archived' && !await confirm.ask({
      title: fill(labels.archiveTitle, { name: existing.name }),
      body: labels.archiveBody,
      confirmLabel: labels.archive,
      cancelLabel: strings.common.cancel,
      danger: true,
      requiredText: existing.name,
      inputLabel: labels.archiveName,
    })) return;
    status = next;
    edited();
  }

  function stored(): AgentEntities[AgentEntryKind] | undefined {
    const snapshot = view.snapshot, id = initial.record?.id;
    if (!snapshot || !id) return undefined;
    const list: AgentEntities[AgentEntryKind][] = kind === 'profile' ? snapshot.profiles : kind === 'group' ? snapshot.groups : kind === 'team' ? snapshot.teams : snapshot.missions;
    return list.find(r => r.id === id);
  }

  /**
   * The record's save, its params built when `send` runs them. A profile's Settings tab saves beside
   * the runtime card, which may have moved the revision and the model since this form last saved:
   * keep the current route and revision, but only while every field this form edits is unchanged.
   * Anything else keeps the revision it read, so a stale form is refused rather than written over
   * newer values.
   */
  function save(send: Send): Promise<AgentEntities[AgentEntryKind] | null> {
    const fields = (r: AgentProfile) => JSON.stringify([r.name, r.domain, r.instructions, r.avatar, r.status, r.tools]);
    const read = () => {
      const latest = stored();
      // Projects this form followed from elsewhere count as read, not as a stale copy.
      const projects = (r: AgentProfile) => projectKey(r.projectIds) === projectsRead || projectKey(r.projectIds) === projectKey((base as AgentProfile).projectIds);
      const rebase = kind === 'profile' && !!latest && !!base && fields(latest as AgentProfile) === fields(base as AgentProfile) && projects(latest as AgentProfile);
      return { latest, rebase, version: base ? { id: base.id, expectedRevision: (rebase ? latest! : base).revision } : {} };
    };
    if (kind === 'profile') return send('agents.profile.save', () => {
      const { latest, rebase, version } = read();
      // Cores from before 2026-10-16 refuse a profile without `accountIntegration`; newer ones ignore it.
      const legacy = { accountIntegration: (profile as { accountIntegration?: string } | undefined)?.accountIntegration ?? 'provider' };
      return { ...version, value: { ...legacy, name, domain, instructions, avatar: robotTouched ? encodeRobot(robot) : profile?.avatar ?? '', selection: creating || !rebase ? selection : (latest as AgentProfile).selection, status, tools, projectIds } };
    });
    if (kind === 'group') return send('agents.group.save', () => ({ ...read().version, value: { name, memberIds, mode, maxTurns, maxTurnsPerAgent: perAgent, paused } }));
    if (kind === 'team') return send('agents.team.save', () => ({ ...read().version, value: { name, description, members: memberIds.map(agentId => ({ agentId, responsibility: responsibilities[agentId] ?? '' })), groupId, projectIds, paused } }));
    return send('agents.mission.save', () => { const { latest, version } = read(); return { ...version, value: { title: name, objective, expectedResult, agentIds: memberIds, teamId, projectId, status: (latest as AgentMission | undefined)?.status ?? mission?.status ?? 'open', maxTurns, maxDurationMs: Math.round(minutes * 60000), maxTokens: tokens || null, resourceIds: resourceIds.filter(id => resourceOptions.some(r => r.id === id)) } }; });
  }
  async function create() {
    if (busy) return;
    saving = true;
    try {
      let result: AgentEntities[AgentEntryKind] | null;
      if (kind === 'profile' && host !== view.store) {
        const legacy = { accountIntegration: 'provider' };
        return await createOn(host, { ...legacy, name, domain, instructions, avatar: robotTouched ? encodeRobot(robot) : '', selection, status, tools, projectIds });
      }
      result = await save((method, params) => view.call(method, params()));
      if (result) ondone({ kind, id: result.id });
    } finally { saving = false; }
  }
  async function write() {
    const result = await save((method, params) => view.save(method, params));
    if (result) base = result;
  }
</script>

{#snippet actions()}
  <div class="agent-form-actions">
    <button class="primary" type="submit" disabled={busy || !name.trim() || kind === 'profile' && (!selection.accountId || !selection.model)} data-testid="agent-save"><span class="ui-label">{labels.createAction}</span></button>
    <button type="button" class="ghost" onclick={oncancel}><span class="ui-label">{strings.common.cancel}</span></button>
  </div>
{/snippet}

{#snippet members()}
  <fieldset class="agent-field">
    <legend>{kind === 'mission' ? labels.missionMembers : labels.members}</legend>
    {#if agentOptions.length}
      <div class="agent-checks">
        {#each agentOptions as agent (agent.id)}
          <label class="agent-chip-check"><input type="checkbox" checked={memberIds.includes(agent.id)} onchange={() => { memberIds = toggle(memberIds, agent.id); }} /><span class="ui-label">{agent.name}</span></label>
        {/each}
      </div>
    {:else}<p class="hint">{labels.noMembers}</p>{/if}
  </fieldset>
{/snippet}

<form class="agents-form" bind:this={form} onsubmit={event => { event.preventDefault(); if (creating) void create(); else void autosave.flush(); }} oninput={typing} onchange={committed} data-testid="agent-editor">
  <section class="card">
    {#if embedded}<h2>{heading ?? labels.identity}{#if !creating}<SaveStatus save={autosave} />{/if}</h2>{/if}
    {#if kind === 'profile'}
      <!-- The robot and the name read as one identity: the picture beside the field that names it. -->
      <div class="agent-identity">
        <div class="agent-portrait">
          <AgentAvatar kind="profile" id={profile?.id ?? ''} {name} avatar={robotTouched ? encodeRobot(robot) : profile?.avatar ?? ''} size={72} />
          <div class="agent-portrait-tools">
            <button type="button" class="ghost icon small" title={labels.robot.shuffle} aria-label={labels.robot.shuffle} onclick={() => { robot = seededRobot(secureId(), robot.family); robotTouched = true; edited(); }} data-testid="robot-shuffle"><Dices size={15} strokeWidth={1.75} /></button>
            <button type="button" class="ghost icon small" class:active={dressing} aria-pressed={dressing} title={labels.robot.customize} aria-label={labels.robot.customize} onclick={() => { dressing = !dressing; }} data-testid="robot-customize"><Palette size={15} strokeWidth={1.75} /></button>
          </div>
        </div>
        <label class="agent-field agent-identity-name">{labels.name}<input required maxlength="200" bind:value={name} placeholder={labels.namePlaceholder} data-testid="agent-name" /></label>
      </div>
      {#if dressing}
        <div class="agent-dressing">
          <RobotPicker {robot} onpick={next => { robot = next; robotTouched = true; edited(); }} />
          <button type="button" class="ghost small agent-add" onclick={() => { dressing = false; }}>{labels.robot.done}</button>
        </div>
      {/if}
    {:else}
      <label class="agent-field">{labels.name}<input required maxlength="200" bind:value={name} data-testid="agent-name" /></label>
    {/if}

    {#if kind === 'profile'}
      {#if embedded}<label class="agent-field">{labels.domain}<input bind:value={domain} maxlength="500" placeholder={labels.rolePlaceholder} /></label>{/if}
      <label class="agent-field"><span>{creating ? labels.whatItDoes : labels.instructions}{#if creating}<span class="hint">{labels.whatItDoesHint}</span>{/if}</span><textarea bind:value={instructions} rows="4" maxlength="32000" placeholder={labels.instructionsPlaceholder} data-testid="agent-instructions"></textarea></label>
      <!-- The projects it looks after: it follows their threads, starts new ones and answers for them. -->
      <fieldset class="agent-field" data-testid="agent-projects">
        <legend>{labels.projects}</legend>
        {#if entrustable.length}
          <div class="agent-checks">
            {#each entrustable as project (project.id)}
              <label class="agent-chip-check"><input type="checkbox" checked={projectIds.includes(project.id)} onchange={() => { projectIds = toggle(projectIds, project.id); }} data-testid="agent-project-{project.id}" /><span class="ui-label">{project.name}</span></label>
            {/each}
          </div>
          <p class="hint agent-projects-hint">{labels.projectsHint}</p>
        {:else}<p class="hint">{labels.noProjects}</p>{/if}
      </fieldset>
      {#if embedded}
        <div class="agent-field"><span>{labels.status}</span>
          <Menu placement="bottom" label={labels.status} items={(['active', 'paused', 'archived'] as const).map(id => ({ id, label: labels[id], active: status === id }))} onpick={id => void pickStatus(id as AgentProfile['status'])}><span class="ui-label">{labels[status]}</span></Menu>
        </div>
      {/if}
    {:else if kind === 'group'}
      {@render members()}
      <div class="agent-field"><span class="agent-label ui-label-box"><span class="ui-label">{labels.mode}</span><InfoTip topic={labels.mode} text={labels.modeHint} /></span>
        <Menu placement="bottom" label={labels.mode} items={(['mentions', 'round', 'autonomous'] as const).map(id => ({ id, label: labels[id], active: mode === id }))} onpick={id => { mode = id as AgentGroup['mode']; edited(); }}><span class="ui-label">{labels[mode]}</span></Menu>
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
        <Menu placement="bottom" label={labels.team} items={[{ id: '', label: labels.noTeam }, ...(view.snapshot?.teams.map(t => ({ id: t.id, label: t.name })) ?? [])]} onpick={id => { teamId = id || null; memberIds = memberIds.filter(a => !id || view.snapshot?.teams.find(t => t.id === id)?.members.some(m => m.agentId === a)); edited(); }}><span class="ui-label">{view.snapshot?.teams.find(t => t.id === teamId)?.name ?? labels.noTeam}</span></Menu>
      </div>
      {@render members()}
    {/if}

  {#if kind === 'profile' && embedded}
      <fieldset class="agent-field"><legend>{labels.tools}</legend>
        <div class="agent-checks">{#each TOOLS as tool (tool)}<label class="agent-chip-check"><input type="checkbox" checked={tools.includes(tool)} onchange={() => { tools = toggle(tools, tool); }} /><span class="ui-label">{labels[tool]}</span></label>{/each}</div>
      </fieldset>
    {/if}
  </section>

  {#if kind === 'profile' && creating}
    <section class="card" data-testid="agent-runtime">
      <h2>{labels.runsHeading}</h2>
      <p class="hint">{labels.runsHint}</p>
      <div class="agent-rows">
        <div class="agent-row-field">
          <span class="agent-row-label">{labels.machine}</span>
          <div class="agent-row-value">
            {#if workspace.machines.length > 1}
              <Menu placement="bottom" label={labels.machine} items={hostItems} onpick={pickHost} testid="agent-machine">
                <span class="ui-label">{hostMachine?.label ?? strings.machines.local}</span>
              </Menu>
            {:else}
              <span class="agent-machine" data-testid="agent-machine">{hostMachine?.label ?? strings.machines.local}</span>
            {/if}
          </div>
        </div>
        {#if selection.accountId}
          <div class="agent-row-field">
            <span class="agent-row-label">{labels.modelLabel}</span>
            <div class="agent-row-value">
              <div class="agent-inline">
                {#key host}<ModelPicker store={host} choice={selection} onpick={patch => { selection = { ...selection, effort: null, ...patch }; }} />{/key}
                {#if effort?.levels.length}<EffortSlider levels={effort.levels} active={selection.effort ?? effort.default ?? null} onpick={id => { selection.effort = id; }} />{/if}
              </div>
              <span class="hint">{labels.identityHint}</span>
            </div>
          </div>
          <div class="agent-row-field">
            <span class="agent-row-label">{labels.permissions}</span>
            <div class="agent-row-value">
              <Menu placement="bottom" label={labels.permissions} items={PERMISSIONS.map(id => ({ id, label: permissionLabels[id], active: selection.permissionMode === id }))} onpick={id => { selection.permissionMode = id as ExecutionSelection['permissionMode']; }}><span class="ui-label">{permissionLabels[selection.permissionMode]}</span></Menu>
              {#if provider?.capabilities.approvals === false}<span class="hint">{labels.noApprovals}</span>{/if}
            </div>
          </div>
        {:else}<p class="hint">{labels.noAccount}</p>{/if}
      </div>
    </section>
  {/if}

  {#if !(embedded && kind === 'profile')}
  <details class="card agent-more">
    <summary>{labels.advanced}</summary>
    {#if kind === 'profile'}
      <label class="agent-field">{labels.domain}<input bind:value={domain} maxlength="500" placeholder={labels.rolePlaceholder} /></label>
      <fieldset class="agent-field"><legend>{labels.tools}</legend>
        <div class="agent-checks">{#each TOOLS as tool (tool)}<label class="agent-chip-check"><input type="checkbox" checked={tools.includes(tool)} onchange={() => { tools = toggle(tools, tool); }} /><span class="ui-label">{labels[tool]}</span></label>{/each}</div>
      </fieldset>
    {:else if kind === 'group'}
      <div class="agent-columns"><label class="agent-field">{labels.maxTurns}<input type="number" min="1" max="100" required bind:value={maxTurns} /></label><label class="agent-field">{labels.perAgent}<input type="number" min="1" max="20" required bind:value={perAgent} /></label></div>
    {:else if kind === 'team'}
      <div class="agent-field"><span>{labels.group}</span>
        <Menu placement="bottom" label={labels.group} items={[{ id: '', label: labels.noGroup }, ...(view.snapshot?.groups.map(g => ({ id: g.id, label: g.name })) ?? [])]} onpick={id => { groupId = id || null; edited(); }}><span class="ui-label">{view.snapshot?.groups.find(g => g.id === groupId)?.name ?? labels.noGroup}</span></Menu>
      </div>
      {#if view.store.projects.length}
        <fieldset class="agent-field"><legend>{labels.project}</legend><div class="agent-checks">{#each view.store.projects as project (project.id)}<label class="agent-chip-check"><input type="checkbox" checked={projectIds.includes(project.id)} onchange={() => { projectIds = toggle(projectIds, project.id); }} /><span class="ui-label">{project.name}</span></label>{/each}</div></fieldset>
      {/if}
    {:else}
      <div class="agent-field"><span>{labels.project}</span>
        <Menu placement="bottom" label={labels.project} items={[{ id: '', label: labels.noProject }, ...view.store.projects.map(p => ({ id: p.id, label: p.name }))]} onpick={id => { projectId = id || null; edited(); }}><span class="ui-label">{view.store.projects.find(p => p.id === projectId)?.name ?? labels.noProject}</span></Menu>
      </div>
      <div class="agent-columns">
        <label class="agent-field">{labels.maxTurns}<input required type="number" min="1" max="1000" bind:value={maxTurns} /></label>
        <label class="agent-field">{labels.minutes}<input required type="number" min="1" max="1440" bind:value={minutes} /></label>
        <label class="agent-field">{labels.tokens}<input type="number" min="1" step="1" bind:value={tokens} /></label>
      </div>
      {#if resourceOptions.length}<fieldset class="agent-field"><legend>{labels.resources}</legend><div class="agent-checks">{#each resourceOptions as resource (resource.id)}<label class="agent-chip-check"><input type="checkbox" checked={resourceIds.includes(resource.id)} onchange={() => { resourceIds = toggle(resourceIds, resource.id); }} /><span class="ui-label">{resource.name} · {labels[resource.access]}</span></label>{/each}</div></fieldset>{/if}
    {/if}
    {#if kind === 'group' || kind === 'team'}
      <label class="switch-row"><span class="text ui-label">{labels.paused}</span><input type="checkbox" role="switch" bind:checked={paused} /></label>
    {/if}
  </details>
  {/if}

  {#if creating}{@render actions()}{/if}
</form>
