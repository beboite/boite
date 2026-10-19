<script lang="ts">
  import { errorText } from '../../lib/errors';
  import type { AgentsSnapshot } from '@boite/contracts';
  import type { AgentsView } from '../../lib/agents.svelte';
  import { Autosave, TYPING_MS, whole } from '../../lib/autosave.svelte';
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
  /** The number being typed is out of range: nothing is sent until it is back. */
  let typedInvalid = $state(false);
  const save = new Autosave(async () => {
    const sent = draft;
    if (!sent) return;
    await view.save('agents.limits.set', () => sent);
    if (draft === sent) draft = null;
  }, () => typedInvalid ? strings.settings.autosave.invalid : null);
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
    <span class="text ui-label">{labels.concurrency}</span>
    <input class="agent-number" type="number" min="1" max="8" step="1" required value={limits.backgroundConcurrency} oninput={event => { const value = event.currentTarget.valueAsNumber; typedInvalid = !whole(value, 1, 8); if (!typedInvalid) draft = { ...limits, backgroundConcurrency: value }; save.change('', TYPING_MS); }} onchange={() => void save.flush()} />
  </label>
  <label class="switch-row">
    <span class="text ui-label">{labels.paused}</span>
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
