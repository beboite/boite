<script lang="ts">
  import { untrack } from 'svelte';
  import type { ThreadId } from '@boite/contracts';
  import { bytes, duration, millis, time } from '../lib/format';
  import { strings } from '../lib/i18n.svelte';
  import type { Store } from '../lib/store.svelte';
  import StatusMark from './StatusMark.svelte';

  let { store }: { store: Store } = $props();

  let cpu = $state(untrack(() => store.settings?.agentCpuCapPercent ?? 75));
  let memory = $state(untrack(() => store.settings?.threadMemoryCapMb ?? 0));
  let confirming = $state<ThreadId | null>(null);

  async function kill(threadId: ThreadId) {
    confirming = null;
    await store.killTree(threadId);
  }
</script>

<div class="page" data-testid="resources-page">
  <header>
    <div>
      <h1>{strings.settings.tabs.resources}</h1>
      <p>{strings.protection.intro}</p>
    </div>
  </header>

  <section class="card" id="settings-quiet">
    <h2>{strings.protection.quiet}</h2>
    <label class="switch-row">
      <span class="text">{strings.settings.focusGuard}<span class="hint">{strings.settings.focusGuardHint}</span></span>
      <input type="checkbox" role="switch" data-testid="setting-focus-guard" checked={store.settings?.focusGuard ?? true} onchange={(event) => void store.saveSettings({focusGuard: event.currentTarget.checked})} />
    </label>
    <label class="switch-row">
      <span class="text">{strings.settings.muteAgents}<span class="hint">{strings.settings.muteAgentsHint}</span></span>
      <input type="checkbox" role="switch" data-testid="setting-mute-agents" checked={store.settings?.muteAgents ?? true} onchange={(event) => void store.saveSettings({muteAgents: event.currentTarget.checked})} />
    </label>
    <p class="hint">{strings.protection.windows}</p>
  </section>
  <section class="card" id="settings-limits">
    <h2>{strings.protection.limits}</h2>
    <form onsubmit={(event) => { event.preventDefault(); void store.saveSettings({agentCpuCapPercent: cpu, threadMemoryCapMb: memory}); }}>
      <label><span>{strings.settings.agentCpuCapPercent}</span><input type="number" min="0" max="100" required bind:value={cpu} /></label>
      <label><span>{strings.settings.threadMemoryCapMb}</span><input type="number" min="0" max="65536" required bind:value={memory} /></label>
      <button type="submit" class="primary">{strings.settings.save}</button>
    </form>
  </section>
  <div class="group-heading" id="settings-tasks">
    <h2>{strings.protection.tasks}</h2>
    <button class="quiet" onclick={() => void store.refreshResources()}>{strings.common.refresh}</button>
  </div>

  {#if store.resources.length === 0}
    <p class="empty">{strings.resources.empty}</p>
  {/if}

  {#each store.resources as entry (entry.threadId)}
    <section class="card flush" data-testid="resource-row" data-thread-id={entry.threadId}>
      <div class="head">
        <button class="quiet title" onclick={() => void store.open(entry.threadId)}>
          {entry.title}
        </button>
        <StatusMark status={entry.status} />
        <span class="muted totals">
          {entry.totals.processes}
          {strings.resources.processes} / {millis(entry.totals.cpuMs)} / {bytes(
            entry.totals.peakMemoryBytes
          )}
        </span>
        {#if confirming === entry.threadId}
          <span class="confirm">{strings.resources.killConfirm}</span>
          <button class="danger" onclick={() => void kill(entry.threadId)}>
            {strings.resources.killConfirmYes}
          </button>
          <button class="quiet" onclick={() => (confirming = null)}>
            {strings.resources.killConfirmNo}
          </button>
        {:else}
          <button
            class="danger"
            disabled={entry.live.length === 0}
            onclick={() => (confirming = entry.threadId)}
          >
            {strings.resources.killTree}
          </button>
        {/if}
      </div>

      {#if entry.live.length > 0}
        <div class="process-table"><table>
          <thead>
            <tr>
              <th>{strings.trace.exe}</th>
              <th>{strings.trace.pid}</th>
              <th>{strings.trace.started}</th>
              <th>{strings.trace.duration}</th>
              <th>{strings.trace.cpu}</th>
              <th>{strings.trace.memory}</th>
            </tr>
          </thead>
          <tbody>
            {#each entry.live as record (record.pid)}
              <tr>
                <td class="mono" title={record.commandLine ?? record.exe}>{record.exe.split(/[\\/]/).pop()}</td>
                <td class="mono">{record.pid}</td>
                <td class="mono">{time(record.startedAt)}</td>
                <td class="mono">{duration(record.startedAt, record.exitedAt)}</td>
                <td class="mono">{millis(record.cpuMs)}</td>
                <td class="mono">{bytes(record.peakMemoryBytes)}</td>
              </tr>
            {/each}
          </tbody>
        </table></div>
      {/if}
    </section>
  {/each}
</div>

<style>
  form { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; align-items: end; }
  form button { justify-self: start; }
  td:not(:first-child), th:not(:first-child) { text-align: right; font-variant-numeric: tabular-nums; }
  .process-table { overflow-x: auto; }
  @media (max-width: 720px) { form { grid-template-columns: 1fr; } .head { flex-wrap: wrap; } .totals { margin-left: 0; } }

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

  .totals {
    margin-left: auto;
    font-size: var(--text-sm);
  }

  .confirm {
    color: var(--color-danger);
    font-size: var(--text-sm);
  }

  /* A row under the pointer fills, the way every other list here answers. */
  tbody tr:hover td {
    background: var(--color-surface-2);
  }
</style>
