<script lang="ts">
  import { onMount } from 'svelte';
  import { X } from '@lucide/svelte';
  import type { AgentProfile, AgentRuntimeConfig, AgentSelection, DelegationProfile } from '@boite/contracts';
  import type { AgentsView } from '../../lib/agents.svelte';
  import type { PickPatch } from '../../lib/store.svelte';
  import { strings } from '../../lib/strings';
  import ModelPicker from '../ModelPicker.svelte';
  import EffortSlider from '../EffortSlider.svelte';
  import Menu from '../Menu.svelte';

  let { view, agent }: { view: AgentsView; agent: AgentProfile } = $props();
  let config = $state<AgentRuntimeConfig | null>(null);
  const labels = $derived(strings.agents);
  const PERMISSIONS = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk'] as const;
  const permissionLabels = $derived<Record<AgentSelection['permissionMode'], string>>({ default: labels.ask, acceptEdits: labels.edits, plan: labels.plan, bypassPermissions: labels.full, dontAsk: labels.deny });
  const effort = $derived(config ? view.store.modelOf(config.defaultRoute)?.effort : undefined);
  const locked = $derived(!view.store.owner || view.pending);
  onMount(() => { void view.call('agents.runtime.get', { agentId: agent.id }).then(value => { config = value; }); });

  function add(child: boolean) {
    if (!config) return;
    const route: DelegationProfile = { ...config.defaultRoute, id: crypto.randomUUID(), name: child ? labels.subagents : labels.model, model: config.defaultRoute.model! };
    if (child) config.subagents.profiles.push(route); else config.allowedRoutes.push(route);
  }
  function remove(child: boolean, id: string) {
    if (!config) return;
    if (child) config.subagents.profiles = config.subagents.profiles.filter(r => r.id !== id);
    else config.allowedRoutes = config.allowedRoutes.filter(r => r.id !== id);
  }
  function repick(child: boolean, route: DelegationProfile, patch: PickPatch) {
    if (!config) return;
    const list = child ? config.subagents.profiles : config.allowedRoutes;
    const i = list.findIndex(r => r.id === route.id);
    list[i] = { ...route, effort: null, ...patch, model: patch.model ?? route.model };
  }
  async function save() {
    if (!config) return;
    // The core refuses a default outside the allowed list; picking a new default allows it.
    const d = config.defaultRoute;
    if (d.model && !config.allowedRoutes.some(r => r.providerId === d.providerId && r.accountId === d.accountId && r.model === d.model)) {
      config.allowedRoutes.push({ id: crypto.randomUUID(), name: view.store.modelOf(d)?.name ?? d.model, providerId: d.providerId, accountId: d.accountId, model: d.model, effort: d.effort });
    }
    await view.call('agents.runtime.configure', { agentId: agent.id, expectedRevision: agent.revision, config });
  }
</script>

{#snippet routes(child: boolean)}
  {#each (child ? config!.subagents.profiles : config!.allowedRoutes) as route (route.id)}
    <div class="agent-route">
      <ModelPicker store={view.store} choice={{ ...route, permissionMode: config!.defaultRoute.permissionMode }} onpick={patch => repick(child, route, patch)} />
      <input aria-label={labels.name} bind:value={route.name} required maxlength="80" />
      <button type="button" class="ghost icon" aria-label={labels.removeRoute} title={labels.removeRoute} onclick={() => remove(child, route.id)}><X size={14} /></button>
    </div>
  {/each}
  <button type="button" class="small agent-add" onclick={() => add(child)}>{labels.addModel}</button>
{/snippet}

{#if config}
  <form class="agents-form" data-testid="agent-runtime" onsubmit={e => { e.preventDefault(); void save(); }}>
    <fieldset class="card" disabled={locked}>
      <h2>{labels.defaultModel}</h2>
      <p class="hint">{labels.identityHint}</p>
      <div class="agent-inline">
        <ModelPicker store={view.store} choice={config.defaultRoute} onpick={patch => { if (config) config.defaultRoute = { ...config.defaultRoute, effort: null, ...patch }; }} />
        {#if effort?.levels.length}<EffortSlider levels={effort.levels} active={config.defaultRoute.effort ?? effort.default} onpick={id => { if (config) config.defaultRoute.effort = id; }} />{/if}
        <Menu placement="bottom" label={labels.permissions} items={PERMISSIONS.map(id => ({ id, label: permissionLabels[id], active: config?.defaultRoute.permissionMode === id }))} onpick={id => { if (config) config.defaultRoute.permissionMode = id as AgentSelection['permissionMode']; }}>{permissionLabels[config.defaultRoute.permissionMode]}</Menu>
      </div>
      {#if view.store.providerOf(config.defaultRoute.providerId)?.capabilities.approvals === false}<p class="hint">{labels.noApprovals}</p>{/if}
    </fieldset>

    <fieldset class="card" disabled={locked}>
      <h2>{labels.allowedModels}</h2>
      <p class="hint">{labels.runtimeHint}</p>
      {@render routes(false)}
    </fieldset>

    <fieldset class="card" disabled={locked}>
      <h2>{labels.subagents}</h2>
      <label class="switch-row"><span class="text">{labels.enableSubagents}</span><input type="checkbox" role="switch" bind:checked={config.subagents.enabled} /></label>
      {#if config.subagents.enabled}
        <label class="switch-row"><span class="text">{labels.paused}</span><input type="checkbox" role="switch" bind:checked={config.subagents.paused} /></label>
        {@render routes(true)}
        <div class="agent-columns">
          <label class="agent-field">{labels.maxSubagents}<input type="number" min="1" max="8" bind:value={config.subagents.maxAgents} required /></label>
          <label class="agent-field">{labels.concurrency}<input type="number" min="1" max="8" bind:value={config.subagents.maxConcurrent} required /></label>
          <label class="agent-field">{labels.maxTurns}<input type="number" min="1" max="100" bind:value={config.subagents.maxTurns} required /></label>
        </div>
      {/if}
    </fieldset>

    <fieldset class="card" disabled={locked}>
      <h2>{labels.engine}</h2>
      <div class="agent-columns">
        <label class="agent-field">{labels.compactEvery}<input type="number" min="2" max="100" bind:value={config.compactAfterTurns} required /></label>
        <label class="agent-field">{labels.runMinutes}<input type="number" min="1" max="120" bind:value={config.maxRunMinutes} required /></label>
      </div>
    </fieldset>

    {#if view.store.owner}<div class="agent-form-actions"><button class="primary" disabled={view.pending} data-testid="agent-runtime-save">{labels.save}</button></div>{/if}
  </form>
{/if}
