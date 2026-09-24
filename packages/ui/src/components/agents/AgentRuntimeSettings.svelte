<script lang="ts">
  import { onMount } from 'svelte';
  import type { AgentProfile, AgentRuntimeConfig, DelegationProfile } from '@boite/contracts';
  import type { AgentsView } from '../../lib/agents.svelte';
  import { strings } from '../../lib/strings';
  import ModelPicker from '../ModelPicker.svelte';
  let { view, agent }: { view: AgentsView; agent: AgentProfile } = $props();
  let config = $state<AgentRuntimeConfig | null>(null);
  const labels = $derived(strings.agents);
  onMount(() => { void view.call('agents.runtime.get', { agentId: agent.id }).then(value => { config = value; }); });
  function add(child: boolean) {
    if (!config) return;
    const route: DelegationProfile = { ...config.defaultRoute, id: crypto.randomUUID(), name: child ? labels.subagents : labels.model, model: config.defaultRoute.model! };
    if (child) config.subagents.profiles.push(route); else config.allowedRoutes.push(route);
  }
  async function save() {
    if (!config) return;
    await view.call('agents.runtime.configure', { agentId: agent.id, expectedRevision: agent.revision, config });
  }
</script>
{#if config}
  <form class="agents-form" data-testid="agent-runtime" onsubmit={e => { e.preventDefault(); void save(); }}>
    <p class="muted">{labels.runtimeHint}</p>
    <fieldset disabled={!view.store.owner || view.pending}>
      <legend>{labels.defaultModel}</legend>
      <ModelPicker store={view.store} choice={config.defaultRoute} onpick={patch => { if (config) config.defaultRoute = { ...config.defaultRoute, effort: null, ...patch }; }} />
    </fieldset>
    {#each [false, true] as child (child)}
      <fieldset disabled={!view.store.owner || view.pending}>
        <legend>{child ? labels.subagents : labels.allowedModels}</legend>
        {#if child}<label class="agent-check"><input type="checkbox" bind:checked={config.subagents.enabled} />{labels.enableSubagents}</label><label class="agent-check"><input type="checkbox" bind:checked={config.subagents.paused} />{labels.paused}</label>{/if}
        {#each (child ? config.subagents.profiles : config.allowedRoutes) as route (route.id)}
          <div class="agent-record">
            <label>{labels.name}<input bind:value={route.name} required maxlength="80" /></label>
            <ModelPicker store={view.store} choice={{ ...route, permissionMode: config.defaultRoute.permissionMode }} onpick={patch => { if (!config) return; const list = child ? config.subagents.profiles : config.allowedRoutes; const i = list.findIndex(r => r.id === route.id); list[i] = { ...route, effort: null, ...patch, model: patch.model ?? route.model }; }} />
            <button type="button" class="ghost small" onclick={() => { if (!config) return; if (child) config.subagents.profiles = config.subagents.profiles.filter(r => r.id !== route.id); else config.allowedRoutes = config.allowedRoutes.filter(r => r.id !== route.id); }}>{labels.removeRoute}</button>
          </div>
        {/each}
        <button type="button" class="small" onclick={() => add(child)}>{labels.addModel}</button>
      </fieldset>
    {/each}
    <fieldset disabled={!view.store.owner || view.pending}>
      <legend>{labels.engine}</legend>
      <div class="agent-columns">
        <label>{labels.compactEvery}<input type="number" min="2" max="100" bind:value={config.compactAfterTurns} required /></label>
        <label>{labels.runMinutes}<input type="number" min="1" max="120" bind:value={config.maxRunMinutes} required /></label>
      </div>
      <div class="agent-columns">
        <label>{labels.maxSubagents}<input type="number" min="1" max="8" bind:value={config.subagents.maxAgents} required /></label>
        <label>{labels.concurrency}<input type="number" min="1" max="8" bind:value={config.subagents.maxConcurrent} required /></label>
        <label>{labels.maxTurns}<input type="number" min="1" max="100" bind:value={config.subagents.maxTurns} required /></label>
      </div>
    </fieldset>
    {#if view.store.owner}<button class="primary" disabled={view.pending} data-testid="agent-runtime-save">{labels.save}</button>{/if}
  </form>
{/if}
