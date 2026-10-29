<script lang="ts">
  import { isThisPC, machineName, workspace, type Machine } from '../lib/workspace.svelte';
  import { errorText } from '../lib/errors';
  import { ArrowDown, ArrowUp, ChevronDown, Cpu, Gpu, HardDrive, MemoryStick, Network, Search } from '@lucide/svelte';
  import type { AgentResourceSnapshot, AgentResourceUsage, MachineResourceSnapshot, ResourceByteUsage } from '@boite/contracts';
  import { RpcErrorCode } from '@boite/contracts';
  import { RpcFailure } from '../lib/client';
  import { bytes, count, tenth } from '../lib/format';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import InfoTip from './InfoTip.svelte';
  import MachineCard from './MachineCard.svelte';
  import Menu from './Menu.svelte';
  import ProviderLogo from './ProviderLogo.svelte';
  import StatusMark from './StatusMark.svelte';
  import { threadTone } from '../lib/thread-state';

  let { store, onopenthread }: { store: Store; onopenthread?: () => void } = $props();
  // This PC first. The agents listed are those of the machine picked, at first
  // the one the page was opened for; another store prop forgets the choice.
  const machines = $derived([...workspace.machinesOr(store)].sort((a, b) => Number(isThisPC(b)) - Number(isThisPC(a))));
  let picked = $derived.by<string | null>(() => { void store; return null; });
  const selected = $derived<Machine>(machines.find(m => m.id === picked) ?? machines.find(m => m.store === store) ?? { id: 'local', label: strings.machines.local, store });
  const owner = $derived(selected.store);
  let readings = $state<Record<string, MachineResourceSnapshot | null>>({});
  const read = $derived(machines.flatMap(m => readings[m.id] ?? []));
  // A machine that reads only its total (macOS) is left out of both sides, not counted as idle.
  const memoryUsed = $derived(read.reduce((sum, row) => row.memory.availableBytes === null ? sum : { used: sum.used + row.memory.totalBytes - row.memory.availableBytes, total: sum.total + row.memory.totalBytes }, { used: 0, total: 0 }));
  const busy = $derived(machines.reduce((sum, m) => sum + m.store.threads.filter(thread => (thread.load?.processes ?? 0) > 0).length, 0));
  const online = $derived(machines.filter(m => m.store.connection === 'ready').length);
  // Windows names each agent's GPU share; elsewhere the column is left out rather than shown empty.
  const agentGpu = $derived(readings[selected.id]?.agentGpu ?? null);
  const gpuShare = $derived(new Map((agentGpu ?? []).map(row => [row.threadId, row.percent])));
  let snapshot = $state.raw<AgentResourceSnapshot | null>(null);
  let error = $state<string | null>(null);
  let unsupported = $state(false);
  let query = $state('');
  let sort = $state<'memory' | 'cpu' | 'gpu' | 'disk' | 'network'>('memory');
  let confirming = $state<string | null>(null);
  let stopping = $state<string | null>(null);
  let retry = $state(0);
  let readRevision = 0;
  let visit = 0;
  const cpu = (value: number) => `${tenth(value)}%`;
  const available = (row: AgentResourceUsage, metric: 'cpu' | 'memory') => row.loadAvailable?.[metric] === true;
  const rate = (usage: ResourceByteUsage) => usage.readBytesPerSecond === null && usage.writeBytesPerSecond === null ? -1 : (usage.readBytesPerSecond ?? 0) + (usage.writeBytesPerSecond ?? 0);
  const value = (row: AgentResourceUsage) => sort === 'memory' ? available(row, 'memory') ? row.load.memoryBytes : -1 : sort === 'cpu' ? available(row, 'cpu') ? row.load.cpuPercent : -1 : sort === 'gpu' ? agentGpu ? gpuShare.get(row.threadId) ?? -1 : available(row, 'memory') ? row.load.memoryBytes : -1 : rate(row[sort]);
  const rows = $derived((snapshot?.agents ?? []).filter(row => `${row.title} ${row.providerId} ${row.model ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).sort((a, b) => value(b) - value(a) || a.title.localeCompare(b.title)));
  const total = $derived((snapshot?.agents ?? []).reduce((sum, row) => ({ cpu: sum.cpu + (available(row, 'cpu') ? row.load.cpuPercent : 0), memory: sum.memory + (available(row, 'memory') ? row.load.memoryBytes : 0), cpuCount: sum.cpuCount + Number(available(row, 'cpu')), memoryCount: sum.memoryCount + Number(available(row, 'memory')) }), { cpu: 0, memory: 0, cpuCount: 0, memoryCount: 0 }));
  const speed = (value: number | null) => value === null ? strings.resources.unknown : `${bytes(Math.round(value))}/${strings.units.seconds}`;
  const hint = (usage: ResourceByteUsage) => usage.coverage === 'unavailable' ? strings.taskManager.unavailableHint : usage.source === 'linux-tcp-info' ? strings.taskManager.tcpHint : strings.taskManager.diskHint;

  $effect(() => {
    retry;
    const client = owner.client;
    const ready = owner.connection === 'ready';
    snapshot = null;
    error = null;
    unsupported = false;
    confirming = null;
    stopping = null;
    if (!client || !ready) return;
    const generation = ++visit;
    let stopped = false;
    let busy = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = () => !stopped && owner.client === client;
    const read = async () => {
      if (!current() || busy || document.visibilityState !== 'visible') return;
      clearTimeout(timer);
      busy = true;
      const revision = ++readRevision;
      try {
        const result = await client.call('resources.usage', { watch: true });
        if (current() && revision === readRevision) { snapshot = result; error = null; }
      } catch (reason) {
        if (current() && revision === readRevision) {
          unsupported = reason instanceof RpcFailure && reason.code === RpcErrorCode.MethodNotFound;
          error = unsupported ? strings.taskManager.unsupported : errorText(reason);
        }
      } finally {
        busy = false;
        if (current() && !unsupported && document.visibilityState === 'visible') timer = setTimeout(read, 2000);
      }
    };
    const visibility = () => {
      clearTimeout(timer);
      if (document.visibilityState === 'visible') { if (!unsupported) void read(); }
      else { ++readRevision; void client.call('resources.usage', { watch: false }).catch(() => undefined); }
    };
    document.addEventListener('visibilitychange', visibility);
    void read();
    return () => {
      stopped = true;
      if (visit === generation) ++visit;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibility);
      void client.call('resources.usage', { watch: false }).catch(() => undefined);
    };
  });

  async function stop(threadId: string): Promise<void> {
    const client = owner.client;
    if (!client || !owner.owner || stopping) return;
    const generation = visit;
    confirming = null;
    stopping = threadId;
    ++readRevision;
    try {
      await client.call('resources.killTree', { threadId });
      if (visit !== generation || owner.client !== client || document.visibilityState !== 'visible') return;
      const revision = ++readRevision;
      const result = await client.call('resources.usage', { watch: true });
      if (visit === generation && owner.client === client && revision === readRevision) snapshot = result;
    } catch (reason) {
      if (visit === generation && owner.client === client) error = errorText(reason);
    } finally { if (visit === generation && owner.client === client) stopping = null; }
  }
</script>

<div class="page task-manager" data-testid="task-manager">
  <header><div><h1>{strings.taskManager.title}</h1><p class="hint">{strings.taskManager.scope}</p></div></header>
  <div class="overview card" data-testid="task-manager-overview">
    <div><span>{strings.taskManager.machines}</span><strong>{count(machines.length)}</strong><small>{strings.taskManager.online(online, machines.length)}</small></div>
    <div><span>{strings.taskManager.agents}</span><strong>{count(busy)}</strong></div>
    <div><span>{strings.taskManager.memoryInUse}</span><strong>{memoryUsed.total > 0 ? strings.taskManager.machine.of(bytes(memoryUsed.used), bytes(memoryUsed.total)) : strings.resources.unknown}</strong></div>
    <span class="live" class:paused={owner.connection !== 'ready' || !!error || !snapshot}><span aria-hidden="true"></span><span class="ui-label">{owner.connection !== 'ready' ? strings.taskManager.disconnected : error ? strings.taskManager.paused : !snapshot ? strings.taskManager.loading : strings.taskManager.live}</span></span>
  </div>
  <div class="machines">
    {#each machines as machine (machine.id)}
      <MachineCard {machine} selected={machine === selected} onselect={() => (picked = machine.id)} onreading={reading => (readings[machine.id] = reading)} />
    {/each}
  </div>
  <div class="heading">
    <h2>{strings.taskManager.agentsOn(machineName(selected))}</h2>
    {#if snapshot?.agents.length}
      <small>
        <span>{strings.trace.cpu} {total.cpuCount ? cpu(total.cpu) : strings.resources.unknown}{#if total.cpuCount > 0 && total.cpuCount < snapshot.agents.length}<InfoTip topic={strings.trace.cpu} text={strings.taskManager.partialHint} />{/if}</span>
        <span>{strings.resources.memory} {total.memoryCount ? bytes(total.memory) : strings.resources.unknown}{#if total.memoryCount > 0 && total.memoryCount < snapshot.agents.length}<InfoTip topic={strings.resources.memory} text={strings.taskManager.partialHint} />{/if}</span>
      </small>
    {/if}
  </div>
  <div class="toolbar">
    <label class="search"><Search size={16} /><input type="search" bind:value={query} placeholder={strings.taskManager.search} aria-label={strings.taskManager.search} data-testid="task-manager-search" /></label>
    <Menu items={(agentGpu ? ['memory', 'cpu', 'gpu', 'disk', 'network'] as const : ['memory', 'cpu', 'disk', 'network'] as const).map(id => ({ id, label: strings.taskManager.sort[id], active: sort === id }))} onpick={id => (sort = id as typeof sort)} label={strings.taskManager.sortBy} placement="bottom" testid="task-manager-sort"><span class="ui-label">{strings.taskManager.sort[sort === 'gpu' && !agentGpu ? 'memory' : sort]}</span><ChevronDown size={13} /></Menu>
  </div>
  {#if error}
    <div class="notice" role="status" data-testid="task-manager-error"><span class="ui-label">{error}</span><button class="quiet" onclick={() => retry++}><span class="ui-label">{strings.common.refresh}</span></button></div>
  {:else if owner.connection !== 'ready'}
    <p class="hint" role="status">{strings.taskManager.disconnected}</p>
  {:else if !snapshot}
    <p class="hint" role="status">{strings.taskManager.loading}</p>
  {/if}
  {#if snapshot && rows.length === 0}
    <p class="empty" data-testid="task-manager-empty">{query.trim() ? strings.taskManager.noMatches : strings.resources.empty}</p>
  {/if}
  {#each rows as entry (entry.threadId)}
    <section class="card agent" data-testid="task-manager-agent" data-thread-id={entry.threadId}>
      <div class="identity">
        <ProviderLogo providerId={entry.providerId} size={20} />
        <button class="quiet title" onclick={() => { const from = owner; onopenthread?.(); void workspace.select(from, entry.threadId); }}><span class="ui-label">{entry.title}</span><small>{owner.providers.find(row => row.id === entry.providerId)?.name ?? entry.providerId}{entry.model ? ` · ${entry.model}` : ''}</small></button>
        <StatusMark {...threadTone(entry.status)} />
        <span class="status ui-label">{strings.threadStatus[entry.status]}</span>
      </div>
      <dl class="metrics" class:gpu={agentGpu !== null}>
        <div><dt><Cpu size={14} /><span class="ui-label">{strings.trace.cpu}</span></dt><dd data-testid="task-manager-cpu">{available(entry, 'cpu') ? cpu(entry.load.cpuPercent) : strings.resources.unknown}</dd></div>
        {#if agentGpu}
          {@const share = gpuShare.get(entry.threadId)}
          <div><dt><Gpu size={14} /><span class="ui-label">{strings.taskManager.machine.gpu}</span><InfoTip topic={strings.taskManager.machine.gpu} text={strings.taskManager.gpuHint} /></dt><dd data-testid="task-manager-gpu">{share === undefined ? strings.resources.unknown : cpu(share)}</dd></div>
        {/if}
        <div><dt><MemoryStick size={14} /><span class="ui-label">{strings.resources.memory}</span></dt><dd data-testid="task-manager-memory">{available(entry, 'memory') ? bytes(entry.load.memoryBytes) : strings.resources.unknown}</dd></div>
        {#each ['disk', 'network'] as kind}
          {@const usage = entry[kind as 'disk' | 'network']}
          <div class="transfer" data-testid="task-manager-{kind}">
            <dt class="ui-label-box">{#if kind === 'disk'}<HardDrive size={14} />{:else}<Network size={14} />{/if}<span class="ui-label">{kind === 'disk' ? strings.taskManager.disk : strings.taskManager.network}</span><InfoTip topic={kind === 'disk' ? strings.taskManager.disk : strings.taskManager.network} text={hint(usage)} /></dt>
            <dd>{#if usage.coverage === 'unavailable'}<span class="unavailable">{strings.resources.unknown}</span>{:else}<span title={kind === 'disk' ? strings.taskManager.read : strings.taskManager.download}><ArrowDown size={12} /><span class="ui-label">{speed(usage.readBytesPerSecond)}</span></span><span title={kind === 'disk' ? strings.taskManager.write : strings.taskManager.upload}><ArrowUp size={12} /><span class="ui-label">{speed(usage.writeBytesPerSecond)}</span></span>{/if}</dd>
            {#if usage.readBytes !== null && usage.writeBytes !== null}<small>{strings.taskManager.observed}: {bytes(usage.readBytes + usage.writeBytes)}</small>{/if}
          </div>
        {/each}
      </dl>
      {#if owner.owner}
        <div class="actions">
          {#if confirming === entry.threadId}
            <span class="ui-label">{strings.taskManager.stopConfirm}</span><button class="danger" disabled={!!stopping} onclick={() => void stop(entry.threadId)}><span class="ui-label">{strings.taskManager.stop}</span></button><button class="quiet" onclick={() => confirming = null}><span class="ui-label">{strings.common.cancel}</span></button>
          {:else}
            <button class="quiet" disabled={!!stopping} onclick={() => confirming = entry.threadId}><span class="ui-label">{stopping === entry.threadId ? strings.taskManager.stopping : strings.taskManager.stop}</span></button>
          {/if}
        </div>
      {/if}
    </section>
  {/each}
</div>

<style>
  header p { margin: 6px 0 0; }
  .overview { display: flex; align-items: center; gap: 24px; padding: 16px; margin-bottom: 16px; }
  .overview > div { display: grid; gap: 4px; align-self: start; }
  .machines { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .heading { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 16px; margin-bottom: 12px; }
  .heading h2 { margin: 0; font-size: var(--text-base); font-weight: 600; }
  .heading small { display: flex; gap: 12px; }
  .heading small > span { display: flex; align-items: center; gap: 4px; font-variant-numeric: tabular-nums; }
  .overview strong { font-size: var(--text-lg); font-weight: 600; font-variant-numeric: tabular-nums; }
  .overview span, .overview small, dt, small, .status { color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .live { display: flex; align-items: center; gap: 6px; margin-left: auto; }
  .live > span[aria-hidden] { width: 6px; height: 6px; border-radius: 50%; background: var(--color-success); }
  .live.paused > span[aria-hidden] { background: var(--color-muted-foreground); }
  .toolbar { display: flex; gap: 12px; align-items: center; max-width: var(--settings-width); margin-bottom: 16px; }
  .search { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; padding: 0 12px; border: 1px solid var(--color-edge); border-radius: var(--radius-md); }
  .search input { width: 100%; min-width: 0; border: 0; background: transparent; padding: 10px 0; }
  .agent { margin-bottom: 12px; padding: 16px; }
  .identity { display: flex; align-items: center; gap: 10px; }
  .title { min-width: 0; flex: 1; display: grid; justify-content: stretch; justify-items: start; gap: 4px; padding: 0; text-align: left; }
  .title > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
  .title small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; margin: 16px 0 0; }
  .metrics.gpu { grid-template-columns: repeat(5, minmax(0, 1fr)); }
  /* As tall as the info tip Disk and Network carry, so all four labels and values share a line. */
  dt { display: flex; align-items: center; gap: 6px; min-height: 18px; }
  dd { margin: 6px 0 0; font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
  .transfer dd { display: grid; gap: 4px; }
  .transfer dd > span { display: flex; align-items: center; gap: 4px; }
  .transfer small { display: block; margin-top: 6px; }
  .unavailable { font-size: var(--text-xs); color: var(--color-muted-foreground); }
  .actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 14px; font-size: var(--text-sm); }
  .notice { display: flex; align-items: center; gap: 12px; padding: 12px; margin-bottom: 16px; font-size: var(--text-sm); color: var(--color-danger); }
  @media (max-width: 720px) { .metrics, .metrics.gpu { grid-template-columns: repeat(2, minmax(0, 1fr)); } .machines { grid-template-columns: minmax(0, 1fr); } .overview { gap: 16px; flex-wrap: wrap; } .live { width: 100%; margin-left: 0; } .status { display: none; } }
</style>
