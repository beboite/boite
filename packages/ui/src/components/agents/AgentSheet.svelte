<script lang="ts">
  import { untrack } from 'svelte';
  import { X } from '@lucide/svelte';
  import type { AgentProfile } from '@boite/contracts';
  import type { AgentsView } from '../../lib/agents.svelte';
  import { Closing } from '../../lib/closing.svelte';
  import type { AgentPane } from '../../lib/store/layout.svelte';
  import { fill, strings } from '../../lib/strings';
  import AgentEditor from './AgentEditor.svelte';
  import AgentRuntimeSettings from './AgentRuntimeSettings.svelte';
  import AgentRoutines from './AgentRoutines.svelte';
  import AgentBrainEditor from './AgentBrainEditor.svelte';

  /**
   * An agent's settings or its brain, as a sheet over its conversation: the
   * chat stays where it was underneath, and Escape or the cross puts it back.
   * Settings hold who it is, what it does on its own (routines) and how it
   * runs; the brain is MEMORY.md and AGENTS.md.
   */
  let { view, agent, pane, onclose }: { view: AgentsView; agent: AgentProfile; pane: AgentPane | null; onclose: () => void } = $props();
  const labels = $derived(strings.agents);
  const sheet = new Closing();
  /** What the sheet shows while it plays its exit: the pane it had. */
  let shown = $state<AgentPane>('settings');
  $effect(() => {
    const next = pane;
    untrack(() => { if (next) { shown = next; sheet.show(); } else sheet.hide(); });
  });
  let body = $state<HTMLElement>();
  $effect(() => { if (sheet.open) body?.focus({ preventScroll: true }); });
  function onkeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    onclose();
  }
</script>

{#if sheet.shown}
  <div class="agent-sheet" class:closing={sheet.closing} use:sheet.attach onanimationend={sheet.end} role="dialog" aria-label={shown === 'brain' ? labels.brain : labels.settings} tabindex="-1" bind:this={body} {onkeydown} data-testid="agent-sheet">
    <header class="agent-sheet-head">
      <h2>{fill(shown === 'brain' ? labels.brainOf : labels.settingsOf, { name: agent.name })}</h2>
      <button type="button" class="ghost icon" aria-label={strings.common.close} title={strings.common.close} onclick={onclose} data-testid="agent-sheet-close"><X size={16} strokeWidth={1.75} /></button>
    </header>
    <div class="agent-sheet-body">
      {#key `${agent.id}:${shown}`}
        {#if shown === 'brain'}
          <AgentBrainEditor {view} agentId={agent.id} />
        {:else}
          <AgentEditor {view} record={agent} embedded ondone={() => {}} oncancel={() => {}} />
          <AgentRoutines {view} agentId={agent.id} />
          <AgentRuntimeSettings {view} {agent} />
        {/if}
      {/key}
    </div>
  </div>
{/if}
