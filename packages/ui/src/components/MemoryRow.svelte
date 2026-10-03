<script lang="ts">
  import type { MemoryEvent } from '@boite/contracts';
  import { strings } from '../lib/strings';
  import { bytes } from '../lib/format';
  import { TriangleAlert } from '@lucide/svelte';

  let { event, events = [event], onconfigure }: { event: MemoryEvent; events?: MemoryEvent[]; onconfigure?: () => void } = $props();
  const text = $derived(event.kind === 'killed' ? strings.resources.killReason[event.reason](bytes(event.limitBytes)) : event.kind === 'thread-cap' ? strings.resources.threadCap : event.kind === 'budget' ? strings.resources.budget : strings.resources.states[event.state]);
</script>

<div class="memory-row" data-testid="memory-row" data-kind={event.kind}>
  <span class="icon" aria-hidden="true"><TriangleAlert size={16} /></span>
  <div class="content">
    {#if event.kind === 'killed'}
      <div class="heading"><span class="title ui-label">{events.length > 1 ? strings.resources.killCount(events.length) : strings.resources.killTitle}</span></div>
      <p>{text}</p>
      {#if events.length > 1}
        <details class="process-list">
          <summary>{strings.resources.stoppedProcesses(events.length)}</summary>
          {#each events as stopped}
            <div class="details"><span class="process">{stopped.exe?.split(/[\\/]/).pop() ?? strings.resources.unknown}</span>{#if stopped.bytes !== undefined}<span class="size">{bytes(stopped.bytes)}</span>{/if}</div>
          {/each}
        </details>
      {:else}
        <div class="details"><span class="process">{event.exe?.split(/[\\/]/).pop() ?? strings.resources.unknown}</span>{#if event.bytes !== undefined}<span class="size">{bytes(event.bytes)}</span>{/if}</div>
      {/if}
    {:else}<p>{text}</p>{/if}
    {#if onconfigure}<button type="button" class="quiet small configure" onclick={onconfigure}><span class="ui-label">{strings.resources.memorySettings}</span></button>{/if}
  </div>
</div>

<style>
  .memory-row { display: flex; align-items: flex-start; gap: 8px; padding: 8px 12px; border-left: 2px solid var(--color-live); border-radius: var(--radius-sm); background: color-mix(in oklch, var(--color-live) 4%, var(--color-background)); font-size: var(--text-xs); line-height: 1.5; overflow-wrap: anywhere; }
  .icon { display: flex; flex: 0 0 16px; padding-top: 2px; color: var(--color-live); }
  .content { min-width: 0; flex: 1; }
  .heading { display: flex; align-items: center; }
  .title { color: var(--color-foreground); font-weight: 600; }
  p { margin: 0; color: var(--color-muted-foreground); }
  .details { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; margin-top: 4px; font-size: var(--text-xs); }
  summary { cursor: pointer; color: var(--color-muted-foreground); padding: 6px 0; }
  .configure { margin-top: 4px; color: var(--color-muted-foreground); }
  .process { padding: 2px 6px; border-radius: var(--radius-sm); background: var(--color-surface-2); color: var(--color-foreground); font-family: var(--font-mono); }
  .size { color: var(--color-muted-foreground); font-variant-numeric: tabular-nums; }
  @media (max-width: 720px) { summary, .configure { min-height: 44px; } }
</style>
