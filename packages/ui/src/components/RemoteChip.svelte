<script lang="ts">
  import { Globe } from '@lucide/svelte';
  import { fill, strings } from '../lib/strings';

  /**
   * Beside an agent that wrote from a contact's Boite: the name this owner gave
   * the contact, set by this core from its own list and never by the sender.
   * Dashed, so it never reads as one of this owner's own agents.
   */
  let { name }: { name: string } = $props();
  const label = $derived(fill(strings.agentMessages.remote, { name }));
</script>

<span class="remote" title={label} aria-label={label} data-testid="agent-remote-chip"><Globe size={11} strokeWidth={2} aria-hidden="true" /><span class="name">{name}</span></span>

<style>
  .remote {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    max-width: 16ch;
    padding: 0 6px;
    border: 1px dashed color-mix(in oklch, var(--color-accent) 60%, transparent);
    border-radius: var(--radius-full);
    color: var(--color-accent);
    font-size: var(--text-xs);
    font-weight: 600;
    line-height: 16px;
  }
  .remote :global(svg) { flex: none; }
  .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
