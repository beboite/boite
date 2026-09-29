<script lang="ts">
  import type { MemoryEvent } from '@boite/contracts';
  import { strings } from '../lib/strings';
  import { bytes } from '../lib/format';
  import { TriangleAlert } from '@lucide/svelte';

  let { event }: { event: MemoryEvent } = $props();
  const text = $derived(event.kind === 'killed' ? strings.resources.killReason[event.reason](bytes(event.limitBytes)) : event.kind === 'thread-cap' ? strings.resources.threadCap : event.kind === 'budget' ? strings.resources.budget : strings.resources.states[event.state]);
</script>

<div class="memory-row" data-testid="memory-row" data-kind={event.kind}>
  <span class="icon" aria-hidden="true"><TriangleAlert size={16} /></span>
  <div class="content">
    {#if event.kind === 'killed'}
      <div class="heading"><span class="title">{strings.resources.killTitle}</span></div>
      <p>{text}</p>
      <div class="details">
        <span class="process">{event.exe?.split(/[\\/]/).pop() ?? strings.resources.unknown}</span>
        {#if event.bytes !== undefined}<span class="size">{bytes(event.bytes)}</span>{/if}
      </div>
    {:else}<p>{text}</p>{/if}
  </div>
</div>

<style>
  .memory-row { display: flex; align-items: flex-start; gap: 12px; padding: 14px 16px; border: 1px solid color-mix(in oklch, var(--color-live) 20%, var(--color-border)); border-radius: var(--radius-lg); background: color-mix(in oklch, var(--color-live) 4%, var(--color-background)); font-size: var(--text-sm); line-height: 1.5; overflow-wrap: anywhere; }
  .icon { display: flex; align-items: center; justify-content: center; flex: 0 0 28px; height: 28px; border-radius: var(--radius-md); background: color-mix(in oklch, var(--color-live) 10%, transparent); color: var(--color-live); }
  .content { min-width: 0; }
  .heading { min-height: 24px; display: flex; align-items: center; }
  .title { color: var(--color-foreground); font-weight: 600; }
  p { margin: 0; color: var(--color-muted-foreground); }
  .details { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 10px; margin-top: 8px; font-size: var(--text-xs); }
  .process { padding: 2px 6px; border-radius: var(--radius-sm); background: var(--color-surface-2); color: var(--color-foreground); font-family: var(--font-mono); }
  .size { color: var(--color-muted-foreground); font-variant-numeric: tabular-nums; }
  @media (max-width: 720px) { .memory-row { padding: 12px; gap: 10px; } }
</style>
