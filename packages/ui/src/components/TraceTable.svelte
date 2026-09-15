<script lang="ts">
  import { ChevronRight } from '@lucide/svelte';
  import type { ProcessRecord, TraceCapability } from '@boite/contracts';
  import { bytes, millis } from '../lib/format';
  import { strings } from '../lib/strings';
  let { records, capability }: { records: ProcessRecord[]; capability: TraceCapability | null } = $props();
  let now = $state(Date.now());
  let live = $derived(records.some(record => record.exitedAt === null));
  $effect(() => {
    if (!live) return;
    const timer = setInterval(() => { now = Date.now(); }, 1000);
    return () => clearInterval(timer);
  });
  let ordered = $derived([...records].sort((a, b) => Number(b.exitedAt === null) - Number(a.exitedAt === null) || b.startedAt - a.startedAt));
  function name(exe: string) { return exe.split(/[\\/]/).pop() ?? exe; }
</script>

<div class="trace">
  {#if capability}
    <details class="capability" data-testid="trace-note">
      <summary>{capability.mode === 'events' ? strings.trace.exact : strings.trace.limited}</summary>
      <p>{capability.os} / {capability.mode}: {capability.note}</p>
    </details>
  {/if}
  {#if records.length === 0}
    <p class="empty" data-testid="trace-empty">{strings.trace.empty}</p>
  {:else}
    <div class="processes" data-testid="trace-table">
      {#each ordered as record (`${record.pid}-${record.startedAt}`)}
        <details class="process" class:live={record.exitedAt === null} data-testid="trace-row" data-pid={record.pid}>
          <summary>
            <div class="headline">
              <ChevronRight size={14} />
              <span class="exe" data-exe={record.exe} title={`${record.exe}\npid ${record.pid}`}>{name(record.exe)}</span>
              <span class="status" class:failed={record.exitedAt !== null && record.exitCode !== null && record.exitCode !== 0}>
                {record.exitedAt === null ? strings.trace.live : record.exitCode === 0 ? strings.trace.finished : record.exitCode === null ? strings.common.unknown : `${strings.trace.exit} ${record.exitCode}`}
              </span>
            </div>
            <div class="metrics">
              <span>{strings.trace.duration} <b>{millis((record.exitedAt ?? now) - record.startedAt)}</b></span>
              <span>{strings.trace.memory} <b>{bytes(record.peakMemoryBytes)}</b></span>
            </div>
          </summary>
          <div class="details">
            <dl>
              <div><dt>{strings.trace.pid}</dt><dd>{record.pid}</dd></div>
              <div><dt>{strings.trace.parent}</dt><dd>{record.parentPid ?? strings.common.unknown}</dd></div>
              <div><dt>{strings.trace.cpuTime}</dt><dd>{millis(record.cpuMs)}</dd></div>
              <div><dt>{strings.trace.io}</dt><dd data-testid="trace-io">{bytes(record.ioBytes)}</dd></div>
            </dl>
            <p class="command mono">{record.commandLine ?? record.exe}</p>
            {#if record.commandLine}<p class="path mono">{record.exe}</p>{/if}
          </div>
        </details>
      {/each}
    </div>
  {/if}
</div>

<style>
  .trace { padding: 8px 12px 16px; }
  .capability { color: var(--color-muted-foreground); font-size: var(--text-xs); margin-bottom: 12px; }
  .capability summary { cursor: pointer; padding: 4px 0; }
  .capability p { margin-top: 6px; font-size: var(--text-sm); }
  .process { border-bottom: 1px solid var(--color-border); }
  .process > summary { list-style: none; cursor: pointer; padding: 12px 0; }
  .process > summary::-webkit-details-marker { display: none; }
  .headline { display: flex; align-items: center; gap: 7px; }
  .headline :global(svg) { flex: none; color: var(--color-subtle); transition: transform var(--dur-2); }
  .process[open] .headline :global(svg) { transform: rotate(90deg); }
  .exe { flex: 1; min-width: 0; overflow-wrap: anywhere; font-weight: 500; font-size: var(--text-sm); }
  .status { flex: none; color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .live .status { color: var(--color-live); }
  .status.failed { color: var(--color-danger); }
  .metrics { display: flex; flex-wrap: wrap; gap: 6px 16px; padding: 6px 0 0 21px; color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .metrics b { margin-left: 4px; font-weight: 400; color: var(--color-foreground); font-variant-numeric: tabular-nums; }
  .details { padding: 0 0 12px 21px; }
  dl { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 0 0 10px; font-size: var(--text-xs); }
  dt { color: var(--color-muted-foreground); }
  dd { margin: 2px 0 0; font-variant-numeric: tabular-nums; }
  .command { padding: 8px; border-radius: var(--radius-sm); background: var(--color-background); font-size: var(--text-sm); white-space: pre-wrap; overflow-wrap: anywhere; }
  .path { margin-top: 6px; font-size: var(--text-xs); color: var(--color-muted-foreground); overflow-wrap: anywhere; }
</style>
