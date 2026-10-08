<script lang="ts">
  import type { MemoryEvent } from '@boite/contracts';
  import { strings } from '../lib/strings';
  import { bytes } from '../lib/format';
  import { ChevronDown, Settings2, TriangleAlert } from '@lucide/svelte';

  let { event, events = [event], onconfigure }: { event: MemoryEvent; events?: MemoryEvent[]; onconfigure?: () => void } = $props();
  const text = $derived(event.kind === 'killed' ? strings.resources.killReason[event.reason](bytes(event.limitBytes)) : event.kind === 'thread-cap' ? strings.resources.threadCap : event.kind === 'budget' ? strings.resources.budget : event.kind === 'throttled' ? strings.resources.throttled(bytes(event.limitBytes)) : strings.resources.states[event.state]);
</script>

<div class="memory-row" data-testid="memory-row" data-kind={event.kind}>
  <span class="warning-icon" aria-hidden="true"><TriangleAlert size={16} /></span>
  <div class="content">
    {#if event.kind === 'killed'}
      <div class="heading"><span class="title ui-label">{events.length > 1 ? strings.resources.killCount(events.length) : strings.resources.killTitle}</span></div>
      <p>{text}</p>
    {:else}<p>{text}</p>{/if}
    {#if event.kind === 'killed' || onconfigure}
      <div class="footer">
        {#if event.kind === 'killed'}
          {#if events.length > 1}
            <details class="process-list">
              <summary><span class="chevron" aria-hidden="true"><ChevronDown size={14} /></span><span>{strings.resources.stoppedProcesses(events.length)}</span></summary>
              <div class="processes">
                {#each events as stopped}
                  <div class="details"><span class="process">{stopped.exe?.split(/[\\/]/).pop() ?? strings.resources.unknown}</span>{#if stopped.bytes !== undefined}<span class="size">{bytes(stopped.bytes)}</span>{/if}</div>
                {/each}
              </div>
            </details>
          {:else}
            <div class="details"><span class="process">{event.exe?.split(/[\\/]/).pop() ?? strings.resources.unknown}</span>{#if event.bytes !== undefined}<span class="size">{bytes(event.bytes)}</span>{/if}</div>
          {/if}
        {/if}
        {#if onconfigure}<button type="button" class="small configure" onclick={onconfigure}><Settings2 size={14} aria-hidden="true" /><span class="ui-label">{strings.resources.memorySettings}</span></button>{/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .memory-row { display: flex; align-items: flex-start; gap: 12px; max-width: 640px; padding: 14px; border: 1px solid var(--color-edge); border-radius: var(--radius-lg); background: var(--color-surface); font-size: var(--text-sm); line-height: 1.5; overflow-wrap: anywhere; }
  .warning-icon { display: flex; align-items: center; justify-content: center; flex: 0 0 30px; height: 30px; border-radius: var(--radius-md); background: color-mix(in oklch, var(--color-live) 12%, transparent); color: var(--color-live); }
  .content { min-width: 0; flex: 1; }
  .heading { display: flex; align-items: center; min-height: 20px; margin-bottom: 4px; }
  .title { color: var(--color-foreground); font-weight: 600; }
  p { margin: 0; color: var(--color-muted-foreground); }
  .footer { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 8px 16px; margin-top: 12px; }
  .details { display: flex; flex: 1; flex-wrap: wrap; align-items: center; gap: 4px 10px; min-width: 0; min-height: var(--control-sm); font-size: var(--text-xs); }
  .process-list { flex: 1; min-width: 0; }
  summary { display: flex; align-items: center; gap: 6px; min-height: var(--control-sm); border-radius: var(--radius-sm); cursor: pointer; color: var(--color-muted-foreground); list-style: none; }
  summary::-webkit-details-marker { display: none; }
  summary:hover { color: var(--color-foreground); }
  .chevron { display: flex; flex-shrink: 0; transform: rotate(-90deg); }
  details[open] .chevron { transform: rotate(0); }
  .processes { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--color-border); }
  .configure { display: inline-flex; align-items: center; justify-content: center; gap: 6px; margin-left: auto; color: var(--color-muted-foreground); }
  .process { min-width: 0; padding: 3px 7px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-surface-2); color: var(--color-foreground); font-family: var(--font-mono); }
  .size { color: var(--color-muted-foreground); font-variant-numeric: tabular-nums; }
  @media (max-width: 720px) {
    .memory-row { gap: 10px; padding: 12px; }
    .footer { gap: 8px; }
    .footer > .details, .process-list { flex-basis: 100%; }
    summary, .configure { min-height: var(--touch-target); }
    .configure { margin-left: 0; }
  }
</style>
