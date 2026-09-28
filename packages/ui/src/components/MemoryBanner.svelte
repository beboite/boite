<script lang="ts">
  import type { MemoryState } from '@boite/contracts';
  import { strings } from '../lib/strings';

  let { state, stopped = false, machine }: { state: MemoryState | null; stopped?: boolean; machine?: string } = $props();
</script>

{#if state && state !== 'ok'}
  <article class="memory-notice" data-testid="memory-banner" data-state={state} role="status">
    {#if machine}<span class="machine">{strings.resources.onMachine(machine)}</span>{/if}
    <p>{state === 'tight' ? strings.resources.tight : stopped ? strings.resources.stopped : strings.resources.critical}</p>
  </article>
{/if}

<style>
  .memory-notice { pointer-events: auto; padding: 12px; border: 1px solid var(--color-live); border-radius: var(--radius-lg); background: var(--color-surface-2); box-shadow: var(--shadow-e3); font-size: var(--text-sm); }
  .memory-notice[data-state="critical"] { border-color: var(--color-danger); }
  .machine { color: var(--color-muted-foreground); font-size: var(--text-xs); }
  p { margin: 0; line-height: 1.5; overflow-wrap: anywhere; }
</style>
