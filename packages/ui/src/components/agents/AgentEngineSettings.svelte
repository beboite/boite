<script lang="ts">
  import { errorText } from '../../lib/errors';
  import type { AgentsSnapshot } from '@boite/contracts';
  import type { AgentsView } from '../../lib/agents.svelte';
  import { Autosave } from '../../lib/autosave.svelte';
  import { confirm } from '../../lib/confirm.svelte';
  import { strings } from '../../lib/strings';
  import AgentAccountAccess from './AgentAccountAccess.svelte';
  import AgentBrainRoot from './AgentBrainRoot.svelte';
  import SaveStatus from '../SaveStatus.svelte';

  let { view }: { view: AgentsView } = $props();
  const labels = $derived(strings.agents);
  /** Changes not yet saved; the controls show them, and a refused save leaves them beside its error. */
  let draft = $state<AgentsSnapshot['limits'] | null>(null);
  const limits = $derived(draft ?? view.snapshot!.limits);
  const save = new Autosave(async () => {
    const sent = draft;
    if (!sent) return;
    await view.save('agents.limits.set', () => sent);
    if (draft === sent) draft = null;
  });
  function set(patch: Partial<AgentsSnapshot['limits']>) { draft = { ...limits, ...patch }; save.change(); }

  async function stopEngine() {
    if (!await confirm.ask({ title: labels.stopEngine, body: labels.stopEngineBody, confirmLabel: labels.stopEngine, cancelLabel: strings.common.cancel, danger: true })) return;
    try { await view.store.client?.call('core.shutdown', {}); view.store.client?.close(); }
    catch (error) { view.error = errorText(error); }
  }
</script>

<section class="card" data-testid="agents-engine-settings">
  <h2>{labels.engine}<SaveStatus {save} /></h2>
  <p class="hint">{labels.engineHint}</p>
  <label class="switch-row">
    <span class="text">{labels.pauseWakes}<span class="hint">{labels.pauseWakesHint}</span></span>
    <input type="checkbox" role="switch" checked={limits.paused} onchange={event => set({ paused: event.currentTarget.checked })} />
  </label>
</section>

<AgentAccountAccess {view} />

<AgentBrainRoot {view} />

<section class="card">
  <h2>{labels.dangerZone}</h2>
  <p class="hint">{labels.dangerHint}</p>
  <button type="button" class="danger" onclick={() => void stopEngine()}><span class="ui-label">{labels.stopEngine}</span></button>
</section>
