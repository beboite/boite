<script lang="ts">
  import { errorText } from '../../lib/errors';
  import { secureId } from '../../lib/secure-id';
  import { onMount } from 'svelte';
  import { X } from '@lucide/svelte';
  import type { AgentProfile, AgentRuntimeConfig, AgentSelection, DelegationProfile } from '@boite/contracts';
  import type { AgentsView } from '../../lib/agents.svelte';
  import { Autosave, TYPING_MS, typed } from '../../lib/autosave.svelte';
  import type { PickPatch } from '../../lib/store.svelte';
  import { strings } from '../../lib/strings';
  import ModelPicker from '../ModelPicker.svelte';
  import EffortSlider from '../EffortSlider.svelte';
  import Menu from '../Menu.svelte';
  import SaveStatus from '../SaveStatus.svelte';

  let { view, agent }: { view: AgentsView; agent: AgentProfile } = $props();
  let config = $state<AgentRuntimeConfig | null>(null);
  /**
   * What each field's next change is measured against: the value it showed
   * when it was edited, and the revision of the agent that holds it. `behind`
   * marks a base older than that revision for some field, so the next save
   * reads the core and merges instead of writing on the revision blindly.
   */
  let base: { config: AgentRuntimeConfig; revision: number; behind: boolean } | null = null;
  const FIELDS = ['defaultRoute', 'allowedRoutes', 'subagents', 'autoMemory', 'eventWakes', 'dailyBudgetUsd'] as const;
  /** Equal values whatever the order of their keys: the core writes a route's keys in its own order. */
  const canon = (value: unknown) => JSON.stringify(value, (_key, v: unknown) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
  const same = (a: unknown, b: unknown) => canon(a) === canon(b);
  /**
   * A configuration as the core stores it, so this card's copy and the core's
   * compare equal: a route takes the default's permission mode on the core,
   * names are trimmed, a missing effort is none, a missing auto memory is on.
   */
  function shape(value: AgentRuntimeConfig): AgentRuntimeConfig {
    const route = <R extends { name?: string; effort?: string | null }>(r: R) => {
      const { permissionMode: _mode, ...rest } = r as R & { permissionMode?: unknown };
      return { ...rest, ...(r.name === undefined ? {} : { name: r.name.trim() }), effort: r.effort ?? null };
    };
    return { ...value, defaultRoute: { ...value.defaultRoute, effort: value.defaultRoute.effort ?? null }, allowedRoutes: value.allowedRoutes.map(route), subagents: { ...value.subagents, profiles: value.subagents.profiles.map(route) }, autoMemory: value.autoMemory !== false, eventWakes: value.eventWakes === true, dailyBudgetUsd: value.dailyBudgetUsd ?? null } as AgentRuntimeConfig;
  }
  /** Read from the data, not the form: a card leaving the page has no form left to ask. */
  function problem(): string | null {
    if (!config) return null;
    // The core's own limit: a name it already holds may be longer than the field lets anyone type.
    const names = [...config.allowedRoutes, ...config.subagents.profiles].every(route => route.name.trim() && route.name.length <= 100);
    const budget = config.dailyBudgetUsd ?? null;
    return names && (budget === null || Number.isFinite(budget) && budget > 0) ? null : strings.settings.autosave.invalid;
  }
  const labels = $derived(strings.agents);
  const PERMISSIONS = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'yolo', 'dontAsk'] as const;
  const permissionLabels = $derived<Record<AgentSelection['permissionMode'], string>>({ default: labels.ask, acceptEdits: labels.edits, plan: labels.plan, bypassPermissions: labels.full, yolo: strings.permissionMode.yolo, dontAsk: labels.deny });
  const effort = $derived(config ? view.store.modelOf(config.defaultRoute)?.effort : undefined);
  // Saving never disables the form: a field being typed in keeps its focus.
  const locked = $derived(!view.store.owner);
  const save = new Autosave(write, problem);
  onMount(() => {
    const revision = agent.revision;
    void view.call('agents.runtime.get', { agentId: agent.id }).then(value => {
      if (value) base = { config: $state.snapshot(value) as AgentRuntimeConfig, revision, behind: false };
      config = value;
    });
    // Leaving the tab sends a change still waiting for a typing pause.
    return () => void save.flush();
  });

  function add(child: boolean) {
    if (!config) return;
    try {
      const route: DelegationProfile = { ...config.defaultRoute, id: secureId(), name: child ? labels.subagents : labels.model, model: config.defaultRoute.model! };
      if (child) config.subagents.profiles.push(route); else config.allowedRoutes.push(route);
      save.change(child ? 'subagents' : 'allowed');
    } catch (error) { view.error = errorText(error); }
  }
  function remove(child: boolean, id: string) {
    if (!config) return;
    if (child) config.subagents.profiles = config.subagents.profiles.filter(r => r.id !== id);
    else config.allowedRoutes = config.allowedRoutes.filter(r => r.id !== id);
    save.change(child ? 'subagents' : 'allowed');
  }
  function repick(child: boolean, route: DelegationProfile, patch: PickPatch) {
    if (!config) return;
    const list = child ? config.subagents.profiles : config.allowedRoutes;
    const i = list.findIndex(r => r.id === route.id);
    list[i] = { ...route, effort: null, ...patch, model: patch.model ?? route.model };
    save.change(child ? 'subagents' : 'allowed');
  }
  function pickDefault(patch: Partial<AgentSelection>) {
    if (!config) return;
    try {
      const previous = config.defaultRoute;
      config.defaultRoute = { ...config.defaultRoute, ...patch };
      // The core refuses a default outside the allowed list; picking a new default allows it.
      const d = config.defaultRoute;
      // Replacing a missing provider or account also repairs its allowed route;
      // keeping that removed route would make the whole configuration fail validation.
      const missing = !view.store.providerOf(previous.providerId) || !view.store.accounts.some(a => a.id === previous.accountId);
      if (missing && d.model && (d.providerId !== previous.providerId || d.accountId !== previous.accountId)) {
        const model = d.model;
        config.allowedRoutes = config.allowedRoutes.map(route => {
          const replaced = route.providerId === previous.providerId && route.accountId === previous.accountId && route.model === previous.model;
          return replaced ? { ...route, ...d, model } : route;
        }).filter(route => view.store.providerOf(route.providerId) && view.store.accounts.some(a => a.id === route.accountId));
      }
      if (d.model && !config.allowedRoutes.some(r => r.providerId === d.providerId && r.accountId === d.accountId && r.model === d.model)) {
        config.allowedRoutes.push({ id: secureId(), name: view.store.modelOf(d)?.name ?? d.model, providerId: d.providerId, accountId: d.accountId, model: d.model, effort: d.effort });
      }
      save.change('default');
    } catch (error) { view.error = errorText(error); }
  }
  /**
   * Sends the card as it is now. Another save may have moved the agent since
   * this card's base, the identity card beside it or another window: each
   * field this card left alone then takes the stored value, and a field both
   * changed differently is a conflict the card reports rather than overwrites.
   * The base is always what this card sent with the revision that save
   * returned, never a later read that could hold someone else's write.
   */
  async function write() {
    if (!config || !base) return;
    const sent = $state.snapshot(config) as AgentRuntimeConfig;
    let sending = sent;
    const saved = await view.save('agents.runtime.configure', async () => {
      const known = base!;
      const latest = view.snapshot?.profiles.find(p => p.id === agent.id);
      sending = sent;
      if (!latest || latest.revision === known.revision && !known.behind) return { agentId: agent.id, expectedRevision: known.revision, config: sent };
      const stored = await view.store.client!.call('agents.runtime.get', { agentId: agent.id });
      const [mine, theirs, was] = [shape(sent), shape(stored), shape(known.config)];
      const merged: Record<string, unknown> = { ...sent };
      for (const key of FIELDS) {
        const changed = !same(mine[key], was[key]), moved = !same(theirs[key], was[key]);
        if (changed && moved && !same(mine[key], theirs[key])) throw new Error(strings.settings.autosave.conflict);
        if (!changed) merged[key] = stored[key];
      }
      sending = merged as unknown as AgentRuntimeConfig;
      // A write newer than the snapshot's revision makes the core refuse this one: nothing is overwritten.
      return { agentId: agent.id, expectedRevision: latest.revision, config: sending };
    });
    // A field nobody touched since this save left shows what was saved, another writer's value included.
    // A field edited meanwhile was edited from what it showed, the value sent: that stays its base, and
    // when the save adopted another value there, the next save merges and reports the conflict.
    const next: Record<string, unknown> = { ...sending };
    let behind = false;
    if (config) for (const key of FIELDS) {
      if (same(config[key], sent[key])) { if (sending !== sent) (config as unknown as Record<string, unknown>)[key] = sending[key]; continue; }
      next[key] = sent[key];
      if (!same(shape(sending)[key], shape(sent)[key])) behind = true;
    }
    base = { config: next as unknown as AgentRuntimeConfig, revision: saved.revision, behind };
  }
</script>

{#snippet routes(child: boolean)}
  {#each (child ? config!.subagents.profiles : config!.allowedRoutes) as route (route.id)}
    <div class="agent-route">
      <ModelPicker store={view.store} choice={{ ...route, permissionMode: config!.defaultRoute.permissionMode }} onpick={patch => repick(child, route, patch)} />
      <input aria-label={labels.name} bind:value={route.name} required maxlength="80" {...typed(save, child ? 'subagents' : 'allowed')} />
      <button type="button" class="ghost icon" aria-label={labels.removeRoute} title={labels.removeRoute} onclick={() => remove(child, route.id)}><X size={14} /></button>
    </div>
  {/each}
  <button type="button" class="small agent-add" onclick={() => add(child)}><span class="ui-label">{labels.addModel}</span></button>
{/snippet}

{#if config}
  <form class="agents-form" data-testid="agent-runtime" onsubmit={e => { e.preventDefault(); void save.flush(); }}>
    <fieldset class="card" disabled={locked}>
      <h2>{labels.defaultModel}<SaveStatus {save} at="default" /></h2>
      <p class="hint">{labels.identityHint}</p>
      <div class="agent-inline">
        <ModelPicker store={view.store} choice={config.defaultRoute} onpick={patch => pickDefault({ effort: null, ...patch })} />
        {#if effort?.levels.length}<EffortSlider levels={effort.levels} active={config.defaultRoute.effort ?? effort.default ?? null} onpick={id => pickDefault({ effort: id })} />{/if}
        <Menu placement="bottom" label={labels.permissions} items={PERMISSIONS.map(id => ({ id, label: permissionLabels[id], active: config?.defaultRoute.permissionMode === id }))} onpick={id => pickDefault({ permissionMode: id as AgentSelection['permissionMode'] })}><span class="ui-label">{permissionLabels[config.defaultRoute.permissionMode]}</span></Menu>
      </div>
      {#if view.store.providerOf(config.defaultRoute.providerId)?.capabilities.approvals === false}<p class="hint">{labels.noApprovals}</p>{/if}
    </fieldset>

    <fieldset class="card" disabled={locked}>
      <h2>{labels.allowedModels}<SaveStatus {save} at="allowed" /></h2>
      <p class="hint">{labels.runtimeHint}</p>
      {@render routes(false)}
    </fieldset>

    <fieldset class="card" disabled={locked}>
      <h2>{labels.subagents}<SaveStatus {save} at="subagents" /></h2>
      <label class="switch-row"><span class="text ui-label">{labels.enableSubagents}</span><input type="checkbox" role="switch" bind:checked={config.subagents.enabled} onchange={() => save.change('subagents')} /></label>
      {#if config.subagents.enabled}
        <label class="switch-row"><span class="text ui-label">{labels.paused}</span><input type="checkbox" role="switch" bind:checked={config.subagents.paused} onchange={() => save.change('subagents')} /></label>
        {@render routes(true)}
      {/if}
    </fieldset>

    <fieldset class="card" disabled={locked}>
      <h2>{labels.engine}<SaveStatus {save} at="engine" /></h2>
      <label class="switch-row"><span class="text">{labels.eventWakes}<span class="hint">{labels.eventWakesHint}</span></span><input type="checkbox" role="switch" checked={config.eventWakes === true} onchange={event => { if (config) { config.eventWakes = event.currentTarget.checked; save.change('engine'); } }} data-testid="agent-event-wakes" /></label>
      <!-- Missing on configurations saved before it existed: on. -->
      <label class="switch-row"><span class="text">{labels.autoMemory}<span class="hint">{labels.autoMemoryHint}</span></span><input type="checkbox" role="switch" checked={config.autoMemory !== false} onchange={event => { if (config) { config.autoMemory = event.currentTarget.checked; save.change('engine'); } }} data-testid="agent-auto-memory" /></label>
      <!-- Blank is no cap: the user's own messages always run, only its wakes stop for the day. -->
      <label class="agent-field">{labels.dailyBudget}<span class="hint">{labels.dailyBudgetHint}</span>
        <input class="agent-number" type="number" min="0.01" step="0.01" placeholder={labels.noBudget} value={config.dailyBudgetUsd ?? ''}
          oninput={event => { if (config) { const value = event.currentTarget.valueAsNumber; config.dailyBudgetUsd = Number.isNaN(value) ? null : value; save.change('engine', TYPING_MS); } }}
          onchange={() => void save.flush()} data-testid="agent-daily-budget" /></label>
    </fieldset>

  </form>
{/if}
