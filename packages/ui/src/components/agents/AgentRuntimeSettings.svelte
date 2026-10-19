<script lang="ts">
  import { errorText } from '../../lib/errors';
  import { secureId } from '../../lib/secure-id';
  import { onMount } from 'svelte';
  import { X } from '@lucide/svelte';
  import type { AgentProfile, AgentRuntimeConfig, AgentSelection, DelegationProfile } from '@boite/contracts';
  import { sameSelection, type AgentsView } from '../../lib/agents.svelte';
  import { Autosave, typed } from '../../lib/autosave.svelte';
  import type { PickPatch } from '../../lib/store.svelte';
  import { strings } from '../../lib/strings';
  import ModelPicker from '../ModelPicker.svelte';
  import EffortSlider from '../EffortSlider.svelte';
  import Menu from '../Menu.svelte';
  import SaveStatus from '../SaveStatus.svelte';

  let { view, agent }: { view: AgentsView; agent: AgentProfile } = $props();
  let config = $state<AgentRuntimeConfig | null>(null);
  let form = $state<HTMLFormElement>();
  /** The route and revision this card last read or saved, to tell its own revisions from another writer's. */
  let base: { selection: AgentSelection; revision: number } | null = null;
  const labels = $derived(strings.agents);
  const PERMISSIONS = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'yolo', 'dontAsk'] as const;
  const permissionLabels = $derived<Record<AgentSelection['permissionMode'], string>>({ default: labels.ask, acceptEdits: labels.edits, plan: labels.plan, bypassPermissions: labels.full, yolo: strings.permissionMode.yolo, dontAsk: labels.deny });
  const effort = $derived(config ? view.store.modelOf(config.defaultRoute)?.effort : undefined);
  // Saving never disables the form: a field being typed in keeps its focus.
  const locked = $derived(!view.store.owner);
  const save = new Autosave(write, () => form?.checkValidity() === false ? strings.settings.autosave.invalid : null);
  onMount(() => {
    const revision = agent.revision;
    void view.call('agents.runtime.get', { agentId: agent.id }).then(value => {
      if (value) base = { selection: value.defaultRoute, revision };
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
      config.defaultRoute = { ...config.defaultRoute, ...patch };
      // The core refuses a default outside the allowed list; picking a new default allows it.
      const d = config.defaultRoute;
      if (d.model && !config.allowedRoutes.some(r => r.providerId === d.providerId && r.accountId === d.accountId && r.model === d.model)) {
        config.allowedRoutes.push({ id: secureId(), name: view.store.modelOf(d)?.name ?? d.model, providerId: d.providerId, accountId: d.accountId, model: d.model, effort: d.effort });
      }
      save.change('default');
    } catch (error) { view.error = errorText(error); }
  }
  /**
   * Sends the whole card as it is now. The editor beside it moves the agent's
   * revision too: while the agent's route is still the one this card last saw,
   * the newest revision is used; a route another writer changed keeps the old
   * revision, so the core refuses the save rather than write over it.
   */
  async function write() {
    if (!config || !base) return;
    const sent = $state.snapshot(config) as AgentRuntimeConfig;
    const saved = await view.save('agents.runtime.configure', () => {
      const latest = view.snapshot?.profiles.find(p => p.id === agent.id);
      const expectedRevision = latest && base && sameSelection(latest.selection, base.selection) ? latest.revision : base!.revision;
      return { agentId: agent.id, expectedRevision, config: sent };
    });
    base = { selection: saved.selection, revision: saved.revision };
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
  <form class="agents-form" data-testid="agent-runtime" bind:this={form} onsubmit={e => { e.preventDefault(); void save.flush(); }}>
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
      <!-- Missing on configurations saved before it existed: on. -->
      <label class="switch-row"><span class="text">{labels.autoMemory}<span class="hint">{labels.autoMemoryHint}</span></span><input type="checkbox" role="switch" checked={config.autoMemory !== false} onchange={event => { if (config) { config.autoMemory = event.currentTarget.checked; save.change('engine'); } }} data-testid="agent-auto-memory" /></label>
      <div class="agent-columns">
        <label class="agent-field">{labels.compactEvery}<input type="number" min="2" max="100" step="1" bind:value={config.compactAfterTurns} required {...typed(save, 'engine')} /></label>
        <label class="agent-field">{labels.runMinutes}<input type="number" min="1" max="120" step="1" bind:value={config.maxRunMinutes} required {...typed(save, 'engine')} /></label>
      </div>
    </fieldset>

  </form>
{/if}
