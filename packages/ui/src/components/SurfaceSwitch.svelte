<script lang="ts">
  import { Bot, MessagesSquare } from '@lucide/svelte';
  import { experimentOn } from '../lib/experiments.svelte';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  /**
   * The switch at the top of the sidebar and of the Agents rail: the thread
   * list or the Agents page. With the Agents experiment off there is only one
   * place to be, so the switch is not drawn at all.
   */
  let { store, current, prefix = '' }: { store: Store; current: 'threads' | 'agents'; prefix?: string } = $props();
</script>

{#if experimentOn('resident-agents')}
  <div class="surface-switch" role="group" aria-label={strings.sidebar.surface}>
    <button type="button" class="ghost small view" class:chosen={current === 'threads'} aria-pressed={current === 'threads'} data-testid={`${prefix}view-threads`}
      onclick={() => { if (current !== 'threads') store.showChat(); }}>
      <MessagesSquare size={13} /><span class="ui-label">{strings.sidebar.threads}</span>
    </button>
    <button type="button" class="ghost small view" class:chosen={current === 'agents'} aria-pressed={current === 'agents'} data-testid={`${prefix}view-agents`}
      onclick={() => { if (current !== 'agents') store.showAgents(); }}>
      <Bot size={14} /><span class="ui-label">{strings.sidebar.agents}</span>
    </button>
  </div>
{/if}

<style>
  .surface-switch { container-type: inline-size; display: flex; align-items: center; gap: 2px; padding: 3px; border-radius: var(--radius-md); background: var(--color-edge); }
  .view { flex: 1; min-width: 0; padding-inline: 5px; color: var(--color-muted-foreground); }
  .chosen { background: var(--color-active); color: var(--color-foreground); }
  @container (max-width: 220px) {
    .view :global(svg) { display: none; }
  }
</style>
