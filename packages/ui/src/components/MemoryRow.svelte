<script lang="ts">
  import type { MemoryEvent } from '@boite/contracts';
  import { strings } from '../lib/strings';
  import { bytes } from '../lib/format';

  let { event }: { event: MemoryEvent } = $props();
  const text = $derived(event.kind === 'killed' ? strings.resources.killed[event.reason](event.exe?.split(/[\\/]/).pop() ?? strings.resources.unknown, bytes(event.bytes), bytes(event.limitBytes)) : event.kind === 'thread-cap' ? strings.resources.threadCap : event.kind === 'budget' ? strings.resources.budget : strings.resources.states[event.state]);
</script>

<div class="memory-row" data-testid="memory-row" data-kind={event.kind}>
  <span>{text}</span>
</div>

<style>
  .memory-row { border-left: 2px solid var(--color-live); padding: 6px 12px; color: var(--color-muted-foreground); font-size: var(--text-sm); line-height: 1.5; overflow-wrap: anywhere; }
</style>
