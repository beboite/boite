<script lang="ts">
  import { errorText } from '../../lib/errors';
  import { secureId } from '../../lib/secure-id';
  import { onMount, untrack } from 'svelte';
  import { Dices, Palette } from '@lucide/svelte';
  import type { AgentProfile, AgentSelection as ExecutionSelection, RpcParams } from '@boite/contracts';
  import { Autosave, TYPING_MS } from '../../lib/autosave.svelte';
  import { fill, strings } from '../../lib/strings';
  import { confirm } from '../../lib/confirm.svelte';
  import { openAgent, type AgentsView } from '../../lib/agents.svelte';
  import type { Store } from '../../lib/store.svelte';
  import type { MenuItem } from '../../lib/menu';
  import { workspace } from '../../lib/workspace.svelte';
  import ModelPicker from '../ModelPicker.svelte';
  import EffortSlider from '../EffortSlider.svelte';
  import Menu from '../Menu.svelte';
  import SaveStatus from '../SaveStatus.svelte';
  import { encodeRobot, robotOf, seededRobot, shuffledRobot } from '../../lib/robots';
  import AgentAvatar from './AgentAvatar.svelte';
  import RobotPicker from './RobotPicker.svelte';

  /**
   * Creates an agent with its Create button, or edits one in its settings (`embedded`), where
   * every change saves by itself. An agent's model, effort and permissions are edited beside it in
   * `AgentRuntimeSettings`, which owns the allowed routes.
   */
  let { view, record = null, embedded = false, ondone, oncancel }: {
    view: AgentsView;
    record?: AgentProfile | null;
    embedded?: boolean;
    ondone: (agent: AgentProfile) => void;
    oncancel: () => void;
  } = $props();
  const initial = untrack(() => ({ record }));
  const profile = initial.record;
  /**
   * A new bot starts on the first available account of the machine it will run on, with that account's default model,
   * free to act: full access, the mode a thread calls Auto. The owner may still pick another.
   */
  function defaultSelection(on: Store, permissionMode: ExecutionSelection['permissionMode'] = 'bypassPermissions'): ExecutionSelection {
    const account = on.accounts.find(a => on.providerOf(a.providerId)?.available);
    const models = account ? on.modelsOf(account.providerId, account.id) : [];
    return { providerId: account?.providerId ?? '', accountId: account?.id ?? '', model: models.find(m => m.default)?.id ?? models[0]?.id ?? null, effort: null, permissionMode };
  }
  const PERMISSIONS = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'yolo', 'dontAsk'] as const;

  let name = $state(profile?.name ?? '');
  let domain = $state(profile?.domain ?? '');
  let instructions = $state(profile?.instructions ?? '');
  /**
   * The machine a new agent lives on. Agents belong to one core: its accounts, memory and planned
   * tasks stay there. It starts as the machine this page shows; another one creates the agent on
   * that core and then opens it there.
   */
  let host = $state<Store>(untrack(() => view.store));
  let moving = $state(false);
  let selection = $state<ExecutionSelection>({ ...(profile?.selection ?? untrack(() => defaultSelection(view.store))) });
  /** A new agent gets a robot of its own at once; an existing one shows the robot it wears. */
  let robot = $state(robotOf(profile?.id ?? '', profile?.avatar ?? '') ?? seededRobot(profile?.id ?? secureId()));
  let robotTouched = $state(!profile);
  let dressing = $state(false);
  let status = $state(profile?.status ?? 'active');
  let saving = $state(false);
  /** The projects the owner entrusts to the agent. */
  let projectIds = $state(profile?.projectIds ?? []);
  const projectKey = (ids: readonly string[] | undefined) => JSON.stringify([...(ids ?? [])].sort());
  /** The agent's projects this form last read: what tells an edit here from a change made elsewhere. */
  let projectsRead = projectKey(profile?.projectIds);
  let revisionRead = profile?.revision ?? 0;

  const labels = $derived(strings.agents);
  const creating = !initial.record;
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
    target.showAgents();
    await openAgent(target, created.id);
  }

  /**
   * An agent's projects change outside this form too: a card in a thread
   * applied, or the snapshot this page drew first was older. The form follows
   * while its own projects are untouched, and keeps an edit in progress.
   */
  $effect(() => {
    const latest = stored();
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

  type Send = (params: () => RpcParams<'agents.profile.save'>) => Promise<AgentProfile | null>;
  /** The record as the core last returned it to this form. */
  let base = initial.record;
  /** The fields' own bounds, read from the data: a form leaving the page flushes after its inputs are gone. */
  function problem(): string | null {
    return name.trim() ? null : strings.settings.autosave.invalid;
  }
  const autosave = new Autosave(write, problem);
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
    const existing = stored();
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

  function stored(): AgentProfile | undefined {
    const id = initial.record?.id;
    return id ? view.snapshot?.profiles.find(r => r.id === id) : undefined;
  }

  /**
   * The record's save, its params built when `send` runs them. A profile's Settings tab saves beside
   * the runtime card, which may have moved the revision and the model since this form last saved:
   * keep the current route and revision, but only while every field this form edits is unchanged.
   * Anything else keeps the revision it read, so a stale form is refused rather than written over
   * newer values.
   */
  function save(send: Send): Promise<AgentProfile | null> {
    const fields = (r: AgentProfile) => JSON.stringify([r.name, r.domain, r.instructions, r.avatar, r.status]);
    return send(() => {
      const latest = stored();
      // Projects this form followed from elsewhere count as read, not as a stale copy.
      const projects = (r: AgentProfile) => projectKey(r.projectIds) === projectsRead || projectKey(r.projectIds) === projectKey(base?.projectIds);
      const rebase = !!latest && !!base && fields(latest) === fields(base) && projects(latest);
      const version = base ? { id: base.id, expectedRevision: (rebase ? latest! : base).revision } : {};
      return { ...version, value: { name, domain, instructions, avatar: robotTouched ? encodeRobot(robot) : profile?.avatar ?? '', selection: creating || !rebase ? selection : latest!.selection, status, projectIds } };
    });
  }
  async function create() {
    if (busy) return;
    saving = true;
    try {
      if (host !== view.store) return await createOn(host, { name, domain, instructions, avatar: robotTouched ? encodeRobot(robot) : '', selection, status, projectIds });
      const result = await save(params => view.call('agents.profile.save', params()));
      if (result) ondone(result);
    } finally { saving = false; }
  }
  async function write() {
    const result = await save(params => view.save('agents.profile.save', params));
    if (result) base = result;
  }
</script>

{#snippet actions()}
  <div class="agent-form-actions">
    <button class="primary" type="submit" disabled={busy || !name.trim() || !selection.accountId || !selection.model} data-testid="agent-save"><span class="ui-label">{labels.createAction}</span></button>
    <button type="button" class="ghost" onclick={oncancel}><span class="ui-label">{strings.common.cancel}</span></button>
  </div>
{/snippet}

<form class="agents-form" onsubmit={event => { event.preventDefault(); if (creating) void create(); else void autosave.flush(); }} oninput={typing} onchange={committed} data-testid="agent-editor">
  <section class="card">
    {#if embedded}<h2>{labels.identity}{#if !creating}<SaveStatus save={autosave} />{/if}</h2>{/if}
    <!-- The robot and the name read as one identity: the picture beside the field that names it. -->
    <div class="agent-identity">
      <div class="agent-portrait">
        <AgentAvatar kind="profile" id={profile?.id ?? ''} {name} avatar={robotTouched ? encodeRobot(robot) : profile?.avatar ?? ''} size={72} />
        <div class="agent-portrait-tools">
          <button type="button" class="ghost icon small" title={labels.robot.shuffle} aria-label={labels.robot.shuffle} onclick={() => { robot = shuffledRobot(secureId(), robot.family); robotTouched = true; edited(); }} data-testid="robot-shuffle"><Dices size={15} strokeWidth={1.75} /></button>
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
  </section>

  {#if creating}
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

    <details class="card agent-more">
      <summary>{labels.advanced}</summary>
      <label class="agent-field">{labels.domain}<input bind:value={domain} maxlength="500" placeholder={labels.rolePlaceholder} /></label>
    </details>

    {@render actions()}
  {/if}
</form>
