<script lang="ts">
  import type { MachineResourceSnapshot } from '@boite/contracts';
  import { RpcErrorCode } from '@boite/contracts';
  import { untrack } from 'svelte';
  import { RpcFailure } from '../lib/client';
  import { bytes } from '../lib/format';
  import { strings } from '../lib/strings';
  import { machineName, type Machine } from '../lib/workspace.svelte';
  import MachineIcon from './MachineIcon.svelte';

  /**
   * One machine of the task manager: its CPU and GPU over the last minute, its
   * memory with Boite's share, and the free space of each fixed disk. It reads
   * its own machine's core every two seconds while the page is visible, and
   * hands each reading up so the page can add the machines together.
   */
  let { machine, selected, onselect, onreading }: {
    machine: Machine;
    selected: boolean;
    onselect: () => void;
    onreading: (reading: MachineResourceSnapshot | null) => void;
  } = $props();

  const POINTS = 30;
  let reading = $state.raw<MachineResourceSnapshot | null>(null);
  let cpuHistory = $state.raw<number[]>([]);
  let gpuHistory = $state.raw<number[]>([]);
  let failure = $state<'unsupported' | 'failed' | null>(null);

  const store = $derived(machine.store);
  const agents = $derived(store.threads.filter(thread => (thread.load?.processes ?? 0) > 0).length);
  const gpu = $derived(reading?.gpus?.[0] ?? null);
  const used = $derived(reading && reading.memory.availableBytes !== null ? reading.memory.totalBytes - reading.memory.availableBytes : null);
  const details = $derived([reading?.osLabel, reading?.cpu.model, ...(reading?.gpus ?? []).map(row => row.name)].filter(Boolean).join(' · '));
  const share = (part: number, whole: number) => whole > 0 ? `${Math.min(100, Math.max(0, part / whole * 100)).toFixed(1)}%` : '0%';
  const pct = (value: number | null | undefined) => value === null || value === undefined ? strings.resources.unknown : `${Math.round(value)}%`;

  /** A line and its shaded area under it, in a 100 by 24 box the SVG stretches. */
  function spark(values: number[]): { line: string; area: string } {
    if (values.length < 2) return { line: '', area: '' };
    const step = 100 / (POINTS - 1);
    const start = (POINTS - values.length) * step;
    const points = values.map((value, index) => `${(start + index * step).toFixed(1)} ${(23 - Math.min(100, value) / 100 * 22).toFixed(1)}`);
    const line = `M${points.join(' L')}`;
    return { line, area: `${line} L100 24 L${start.toFixed(1)} 24 Z` };
  }
  const cpuSpark = $derived(spark(cpuHistory));
  const gpuSpark = $derived(spark(gpuHistory));

  $effect(() => {
    const client = store.client;
    const ready = store.connection === 'ready';
    reading = null; cpuHistory = []; gpuHistory = []; failure = null;
    // The parent's callback is not what this reading depends on.
    untrack(() => onreading(null));
    if (!client || !ready) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = () => !stopped && store.client === client;
    const read = async () => {
      clearTimeout(timer);
      if (!current() || document.visibilityState !== 'visible') return;
      try {
        const next = await client.call('resources.machine', {});
        if (!current()) return;
        reading = next; failure = null;
        if (next.cpu.percent !== null) cpuHistory = [...cpuHistory, next.cpu.percent].slice(-POINTS);
        const load = next.gpus?.[0]?.percent;
        if (load !== null && load !== undefined) gpuHistory = [...gpuHistory, load].slice(-POINTS);
        onreading(next);
      } catch (reason) {
        if (!current()) return;
        // An older core has no such method: it says so once and is not asked again.
        if (reason instanceof RpcFailure && reason.code === RpcErrorCode.MethodNotFound) { failure = 'unsupported'; onreading(null); return; }
        failure = 'failed';
      }
      if (current() && document.visibilityState === 'visible') timer = setTimeout(read, 2000);
    };
    const visibility = () => { clearTimeout(timer); if (document.visibilityState === 'visible' && failure !== 'unsupported') void read(); };
    document.addEventListener('visibilitychange', visibility);
    void read();
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); };
  });
</script>

<button class="machine card" class:selected aria-pressed={selected} aria-label={strings.taskManager.machine.show(machineName(machine))} data-testid="task-manager-machine" data-machine-id={machine.id} onclick={onselect}>
  <span class="head">
    <span class="icon"><MachineIcon icon={machine.icon} os={store.core?.os} size={18} /></span>
    <span class="name"><span class="ui-label">{machineName(machine)}</span>{#if details}<small>{details}</small>{/if}</span>
    {#if store.connection === 'ready'}<span class="count ui-label">{strings.taskManager.machine.agentCount(agents)}</span>{/if}
  </span>
  {#if reading}
    <span class="metric" data-testid="task-manager-machine-cpu">
      <span class="line"><span>{strings.taskManager.machine.cpu}</span><b>{pct(reading.cpu.percent)}</b></span>
      <svg class="spark cpu" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true"><path class="area" d={cpuSpark.area} /><path d={cpuSpark.line} /></svg>
    </span>
    <span class="metric" data-testid="task-manager-machine-gpu">
      {#if gpu}
        <span class="line"><span>{strings.taskManager.machine.gpu}{#if gpu.memoryUsedBytes !== null && gpu.memoryTotalBytes !== null}<small>{strings.taskManager.machine.vram(bytes(gpu.memoryUsedBytes), bytes(gpu.memoryTotalBytes))}</small>{/if}</span><b>{pct(gpu.percent)}</b></span>
        {#if gpu.percent !== null}<svg class="spark gpu" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true"><path class="area" d={gpuSpark.area} /><path d={gpuSpark.line} /></svg>{/if}
      {:else}
        <span class="line"><span>{strings.taskManager.machine.gpu}</span><small class="none">{reading.gpus === null ? strings.taskManager.machine.gpuUnmeasured : strings.taskManager.machine.noGpu}</small></span>
      {/if}
    </span>
    <span class="metric" data-testid="task-manager-machine-memory">
      <span class="line"><span>{strings.taskManager.machine.memory}<small>{strings.taskManager.machine.boite(bytes(reading.memory.agentBytes))}</small></span><b>{used === null ? bytes(reading.memory.totalBytes) : strings.taskManager.machine.of(bytes(used), bytes(reading.memory.totalBytes))}</b></span>
      <span class="track"><span class="boite" style:width={share(reading.memory.agentBytes, reading.memory.totalBytes)}></span>{#if used !== null}<span class="rest" style:width={share(Math.max(0, used - reading.memory.agentBytes), reading.memory.totalBytes)}></span>{/if}</span>
    </span>
    <span class="metric" data-testid="task-manager-machine-storage">
      <span class="line"><span>{strings.taskManager.machine.storage}</span></span>
      {#each reading.volumes as volume (volume.name)}
        {@const low = volume.freeBytes < volume.totalBytes * 0.1}
        <span class="volume" title={low ? strings.taskManager.machine.lowSpace : undefined}><span class="ui-label">{volume.name}</span><span class="track"><span class="disk" class:low style:width={share(volume.totalBytes - volume.freeBytes, volume.totalBytes)}></span></span><span class="free" class:low>{strings.taskManager.machine.free(bytes(volume.freeBytes))}</span></span>
      {:else}
        <small class="none">{strings.taskManager.machine.noVolumes}</small>
      {/each}
    </span>
  {:else}
    <span class="state hint">{store.connection !== 'ready' ? (store.connection === 'closed' ? strings.taskManager.machine.offline : strings.taskManager.machine.connecting) : failure === 'unsupported' ? strings.taskManager.machine.unsupported : failure === 'failed' ? strings.taskManager.machine.failed : strings.taskManager.machine.reading}</span>
  {/if}
</button>

<style>
  /* A button for the keyboard and screen readers, a card to the eye: none of a control's fixed height, centring or single line. */
  .machine { display: grid; align-content: start; justify-content: stretch; gap: 12px; min-width: 0; height: auto; padding: 12px; text-align: left; color: inherit; font: inherit; font-weight: 400; white-space: normal; cursor: pointer; transition: border-color var(--dur-2) var(--ease-out-quint); }
  .machine:hover:not(:disabled) { border-color: var(--color-edge); background: var(--color-surface); }
  .machine.selected { border-color: var(--color-accent); }
  .machine:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
  .head { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .icon { display: flex; flex: none; color: var(--color-muted-foreground); }
  .name { display: grid; flex: 1; min-width: 0; gap: 2px; }
  .name > span { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  small, .count, .state, .volume, .line > span { color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .name small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .count { flex: none; }
  .metric { display: grid; gap: 4px; min-width: 0; }
  .line { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; min-width: 0; }
  .line > span { display: flex; gap: 6px; min-width: 0; overflow: hidden; white-space: nowrap; }
  .line small { overflow: hidden; text-overflow: ellipsis; }
  .line b { flex: none; font-size: var(--text-sm); font-weight: 500; font-variant-numeric: tabular-nums; }
  .none { color: var(--color-subtle); }
  .spark { display: block; width: 100%; height: 24px; }
  .spark path { fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
  .spark .area { stroke: none; opacity: 0.14; }
  .spark.cpu path { stroke: var(--series-1); }
  .spark.cpu .area { fill: var(--series-1); }
  .spark.gpu path { stroke: var(--series-2); }
  .spark.gpu .area { fill: var(--series-2); }
  .track { display: flex; height: 6px; overflow: hidden; border-radius: var(--radius-sm); background: var(--color-surface-3); }
  .track > span { height: 100%; transition: width var(--dur-2) var(--ease-out-quint); }
  .boite { background: var(--series-3); }
  .rest { background: color-mix(in oklch, var(--series-3) 40%, transparent); }
  .disk { background: var(--series-4); }
  .disk.low { background: var(--color-danger); }
  .volume { display: grid; grid-template-columns: minmax(28px, auto) minmax(0, 1fr) auto; align-items: center; gap: 8px; }
  .free { font-variant-numeric: tabular-nums; color: var(--color-foreground); }
  .free.low { color: var(--color-danger); }
  .state { padding: 8px 0; }
  @media (prefers-reduced-motion: reduce) { .track > span { transition: none; } }
</style>
