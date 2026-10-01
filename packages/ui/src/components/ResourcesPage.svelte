<script lang="ts">
  import InfoTip from './InfoTip.svelte';
  import { untrack } from 'svelte';
  import type { ThreadId } from '@boite/contracts';
  import { bytes, duration } from '../lib/format';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import StatusMark from './StatusMark.svelte';

  let { store }: { store: Store } = $props();
  const uid = $props.id();

  let cpuCap = $state(untrack(() => store.settings?.agentCpuCapPercent ?? 75));
  let memoryCap = $state(untrack(() => store.settings?.threadMemoryCapMb ?? 0));
  let memoryBudget = $state(untrack(() => store.settings?.agentMemoryBudgetPercent ?? 60));
  let memoryReserve = $state(untrack(() => store.settings?.memoryReserveMb ?? 0));
  const resources = $derived([...store.resources].sort((a, b) => b.load.memoryBytes - a.load.memoryBytes));
  const memoryEnabled = $derived(store.settings?.memoryProtection !== false);
  let confirming = $state<ThreadId | null>(null);

  async function kill(threadId: ThreadId) {
    confirming = null;
    await store.killTree(threadId);
  }

  // A task manager is live: while the page is open and seen, it reads again
  // every two seconds, and each read ticks the durations with it.
  const POLL_MS = 2000;
  $effect(() => {
    if (store.connection !== 'ready') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === 'visible') await store.refreshResources();
      if (!stopped) timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, POLL_MS);
    return () => { stopped = true; clearTimeout(timer); };
  });
  const cpu = (percent: number) => `${Math.round(percent)} %`;
</script>

<div class="page" data-testid="resources-page">
  <header>
    <div>
      <h1>{strings.settings.tabs.resources}</h1>
    </div>
  </header>

  <section class="card" id="settings-quiet">
    <h2>{strings.protection.quiet}<InfoTip topic={strings.protection.quiet} text={strings.protection.windows} /></h2>
    <label for="{uid}-focus-guard" class="switch-row">
      <span class="text"><span id="{uid}-focus-guard-name">{strings.settings.focusGuard}</span></span>
      <input id="{uid}-focus-guard" aria-labelledby="{uid}-focus-guard-name" type="checkbox" role="switch" data-testid="setting-focus-guard" checked={store.settings?.focusGuard ?? true} onchange={(event) => void store.saveSettings({focusGuard: event.currentTarget.checked})} />
    </label>
    <label for="{uid}-mute-agents" class="switch-row">
      <span class="text"><span id="{uid}-mute-agents-name">{strings.settings.muteAgents}</span></span>
      <input id="{uid}-mute-agents" aria-labelledby="{uid}-mute-agents-name" type="checkbox" role="switch" data-testid="setting-mute-agents" checked={store.settings?.muteAgents ?? true} onchange={(event) => void store.saveSettings({muteAgents: event.currentTarget.checked})} />
    </label>
    <label for="{uid}-reap-orphans" class="switch-row">
      <span class="text"><span id="{uid}-reap-orphans-name">{strings.settings.reapOrphans}</span><InfoTip topic={strings.settings.reapOrphans} text={strings.settings.reapOrphansHint} /></span>
      <input id="{uid}-reap-orphans" aria-labelledby="{uid}-reap-orphans-name" type="checkbox" role="switch" data-testid="setting-reap-orphans" checked={store.settings?.reapOrphans ?? true} onchange={(event) => void store.saveSettings({reapOrphans: event.currentTarget.checked})} />
    </label>
  </section>
  <section class="card" id="settings-limits">
    <h2>{strings.protection.limits}</h2>
    <label for="{uid}-memory-protection" class="switch-row">
      <span class="text"><span id="{uid}-memory-protection-name">{strings.settings.memoryProtection}</span><InfoTip topic={strings.settings.memoryProtection} text={strings.settings.memoryProtectionHint} /></span>
      <input id="{uid}-memory-protection" aria-labelledby="{uid}-memory-protection-name" type="checkbox" role="switch" data-testid="setting-memory-protection" checked={memoryEnabled} onchange={async (event) => {
        const input = event.currentTarget;
        if (!await store.saveSettings({ memoryProtection: input.checked })) input.checked = memoryEnabled;
      }} />
    </label>
    <form onsubmit={(event) => { event.preventDefault(); void store.saveSettings({agentCpuCapPercent: cpuCap, ...(memoryEnabled ? {agentMemoryBudgetPercent: memoryBudget, threadMemoryCapMb: memoryCap, memoryReserveMb: memoryReserve} : {})}); }}>
      <label><span class="name">{strings.settings.agentCpuCapPercent}<InfoTip topic={strings.settings.agentCpuCapPercent} text={strings.settings.agentCpuCapHint} /></span><input type="number" min="0" max="100" required bind:value={cpuCap} /></label>
      <label><span class="name">{strings.settings.agentMemoryBudgetPercent}<InfoTip topic={strings.settings.agentMemoryBudgetPercent} text={strings.settings.agentMemoryBudgetHint} /></span><input disabled={!memoryEnabled} aria-label={strings.settings.agentMemoryBudgetPercent} data-testid="memory-budget" type="number" min="10" max="90" step="1" required bind:value={memoryBudget} />
        {#if memoryEnabled && store.memory}<span class="hint" data-testid="memory-budget-resolved">{strings.resources.resolved(store.memory.limits.budgetMb)}</span>{/if}
      </label>
      <label><span class="name">{strings.settings.threadMemoryCapMb}<InfoTip topic={strings.settings.threadMemoryCapMb} text={strings.settings.threadMemoryCapHint} /></span><input disabled={!memoryEnabled} aria-label={strings.settings.threadMemoryCapMb} data-testid="memory-cap" type="number" min="0" required bind:value={memoryCap} />
        {#if memoryEnabled && memoryCap === 0 && store.memory}<span class="hint" data-testid="memory-cap-auto">{strings.resources.auto(store.memory.limits.threadMemoryCapMb)}</span>{/if}
      </label>
      <label><span class="name">{strings.settings.memoryReserveMb}<InfoTip topic={strings.settings.memoryReserveMb} text={strings.settings.memoryReserveHint} /></span><input disabled={!memoryEnabled} aria-label={strings.settings.memoryReserveMb} data-testid="memory-reserve" type="number" min="0" required bind:value={memoryReserve} />
        {#if memoryEnabled && memoryReserve === 0 && store.memory}<span class="hint" data-testid="memory-reserve-auto">{strings.resources.auto(store.memory.limits.memoryReserveMb)}</span>{/if}
      </label>
      <button type="submit" class="primary">{strings.settings.save}</button>
    </form>
  </section>
  <section class="card" data-testid="memory-status">
    <h2>{strings.resources.memory}</h2>
    {#if store.memory}
      <dl class="memory-reading">
        <div><dt>{strings.resources.agents}</dt><dd>{bytes(store.memory.agentBytes)}{#if memoryEnabled}{' / '}{bytes(store.memory.limits.budgetMb * 1048576)}{/if}</dd></div>
        <div><dt>{strings.resources.available}</dt><dd>{store.memory.availableBytes === null ? strings.resources.unknown : bytes(store.memory.availableBytes)}{#if memoryEnabled}{' / '}{bytes(store.memory.limits.memoryReserveMb * 1048576)}{/if}</dd></div>
        <div><dt>{strings.resources.state}</dt><dd data-state={memoryEnabled ? store.memoryState : 'ok'}>{memoryEnabled ? strings.resources.states[store.memoryState ?? store.memory.state] : strings.resources.protectionOff}</dd></div>
      </dl>
    {:else}<p class="hint">{strings.resources.unknown}</p>{/if}
  </section>
  <div class="group-heading" id="settings-tasks">
    <h2 class="tasks-heading">{strings.protection.tasks}<span class="live-dot" aria-hidden="true"></span></h2>
  </div>

  {#if store.resources.length === 0}
    <p class="empty" data-testid="resources-empty">{strings.resources.empty}</p>
  {/if}

  {#each resources as entry (entry.threadId)}
    <section class="card flush" data-testid="resource-row" data-thread-id={entry.threadId}>
      <div class="head">
        <StatusMark status={entry.status} />
        <button class="quiet title" onclick={() => void store.open(entry.threadId)}>{entry.title}</button>
        <span class="load" data-testid="resource-load">
          <span>{entry.load.processes} {strings.resources.processes}</span>
          <span>{cpu(entry.load.cpuPercent)}</span>
          <span>{bytes(entry.load.memoryBytes)}</span>
        </span>
        {#if confirming === entry.threadId}
          <span class="confirm">{strings.resources.killConfirm}</span>
          <button class="danger" onclick={() => void kill(entry.threadId)}>{strings.resources.killConfirmYes}</button>
          <button class="quiet" onclick={() => (confirming = null)}>{strings.resources.killConfirmNo}</button>
        {:else}
          <button class="danger" onclick={() => (confirming = entry.threadId)}>{strings.resources.killTree}</button>
        {/if}
      </div>
      <div class="process-table"><table>
        <thead>
          <tr>
            <th>{strings.trace.exe}</th>
            <th>{strings.trace.pid}</th>
            <th>{strings.trace.duration}</th>
          </tr>
        </thead>
        <tbody>
          {#each entry.live as record (record.pid)}
            <tr>
              <td class="mono" title={record.commandLine ?? record.exe}>{record.exe.split(/[\\/]/).pop()}</td>
              <td class="mono">{record.pid}</td>
              <td class="mono">{duration(record.startedAt, null)}</td>
            </tr>
          {/each}
        </tbody>
      </table></div>
    </section>
  {/each}
</div>

<style>
  .memory-reading { display: flex; flex-wrap: wrap; gap: 16px 32px; margin: 0; font-size: var(--text-sm); }
  dt { color: var(--color-muted-foreground); }
  dd { margin: 6px 0 0; font-variant-numeric: tabular-nums; }
  dd[data-state="critical"] { color: var(--color-danger); }
  form { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; align-items: start; }
  form button { justify-self: start; }
  form label { display: grid; gap: 6px; justify-items: start; }
  form .name { display: inline-flex; align-items: center; font-size: var(--text-sm); color: var(--color-muted-foreground); }
  td:not(:first-child), th:not(:first-child) { text-align: right; font-variant-numeric: tabular-nums; }
  .process-table { overflow-x: auto; }
  @media (max-width: 720px) { form { grid-template-columns: 1fr; } .head { flex-wrap: wrap; } .load { margin-left: 0; flex-basis: 100%; order: 3; } }

  section {
    margin-bottom: 10px;
    overflow: hidden;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px 8px 12px;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-surface-2);
  }

  .title {
    font-weight: 600;
    padding: 0;
  }

  .title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .load {
    margin-left: auto;
    display: flex;
    gap: 12px;
    color: var(--color-muted-foreground);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  /* The heading's dot says the list below is read live. */
  .tasks-heading {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .live-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--color-success);
    animation: pulse 2s var(--ease-out-quint) infinite;
  }

  @keyframes pulse { 50% { opacity: 0.35; } }
  @media (prefers-reduced-motion: reduce) { .live-dot { animation: none; } }

  .confirm {
    color: var(--color-danger);
    font-size: var(--text-sm);
  }

  /* A row under the pointer fills, the way every other list here answers. */
  tbody tr:hover td {
    background: var(--color-surface-2);
  }
</style>
