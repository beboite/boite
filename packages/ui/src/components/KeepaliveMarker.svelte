<script lang="ts">
  import { Timer } from '@lucide/svelte';
  import type { Turn } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';

  /**
   * Boite's pings of the prompt cache while the thread waits on its agents:
   * one quiet line for a run of them, never a message of the conversation.
   */
  let { turn, count = 1 }: { turn: Turn; count?: number } = $props();
  let running = $derived(turn.status === 'queued' || turn.status === 'running');
  let label = $derived(running ? strings.chat.keepaliveRunning : count > 1 ? fill(strings.chat.keepaliveMany, { count: String(count) }) : strings.chat.keepalive);
</script>

<p class="keepalive" data-testid="keepalive-marker" data-status={turn.status} data-count={count}>
  <Timer size={13} strokeWidth={1.75} aria-hidden="true" /><span class="ui-label">{label}</span>
</p>

<style>
  .keepalive {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    margin: 2px 0;
    color: var(--color-muted-foreground);
    font-size: var(--text-xs);
    opacity: 0.8;
  }
</style>
