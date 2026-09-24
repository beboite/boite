<script lang="ts">
  import type { AgentsView } from '../../lib/agents.svelte';
  import { confirm } from '../../lib/confirm.svelte';
  import { strings } from '../../lib/strings';
  import AgentAccountAccess from './AgentAccountAccess.svelte';

  let { view }: { view: AgentsView } = $props();
  const labels = $derived(strings.agents);
  const limits = $derived(view.snapshot!.limits);

  async function stopEngine() {
    if (!await confirm.ask({ title: labels.stopEngine, body: labels.stopEngineBody, confirmLabel: labels.stopEngine, cancelLabel: labels.cancel, danger: true })) return;
    try { await view.store.client?.call('core.shutdown', {}); view.store.client?.close(); }
    catch (error) { view.error = error instanceof Error ? error.message : String(error); }
  }
</script>

<header class="agents-page-head">
  <h2>{labels.engineSettings}</h2>
  <p>{labels.engineSettingsHint}</p>
</header>

<section class="card" data-testid="agents-engine-settings">
  <h2>{labels.engine}</h2>
  <p class="hint">{labels.engineHint}</p>
  <label class="switch-row">
    <span class="text">{labels.concurrency}</span>
    <input class="agent-number" type="number" min="1" max="8" disabled={view.pending} value={limits.backgroundConcurrency} onchange={event => { void view.call('agents.limits.set', { ...limits, backgroundConcurrency: Number(event.currentTarget.value) }); }} />
  </label>
  <label class="switch-row">
    <span class="text">{labels.paused}</span>
    <input type="checkbox" role="switch" disabled={view.pending} checked={limits.paused} onchange={event => { void view.call('agents.limits.set', { ...limits, paused: event.currentTarget.checked }); }} />
  </label>
  <label class="switch-row">
    <span class="text">{labels.kebacc}<span class="hint">{labels.kebaccHint}</span></span>
    <input type="checkbox" role="switch" disabled={view.pending} checked={limits.kebaccExperiment} onchange={event => { void view.call('agents.limits.set', { ...limits, kebaccExperiment: event.currentTarget.checked }); }} />
  </label>
</section>

<AgentAccountAccess {view} />

<section class="card">
  <h2>{labels.dangerZone}</h2>
  <p class="hint">{labels.dangerHint}</p>
  <button type="button" class="danger" onclick={() => void stopEngine()}>{labels.stopEngine}</button>
</section>
