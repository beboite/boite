<script lang="ts">
  import type { ThreadId } from '@boite/contracts';
  import { bytes, duration, millis, time } from '../lib/format';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import StatusMark from './StatusMark.svelte';

  let { store }: { store: Store } = $props();

  let confirming = $state<ThreadId | null>(null);

  async function kill(threadId: ThreadId) {
    confirming = null;
    await store.killTree(threadId);
  }
</script>

<div class="page" data-testid="resources-page">
  <header>
    <h1>{strings.resources.heading}</h1>
    <button class="quiet" onclick={() => void store.refreshResources()}>
      {strings.common.refresh}
    </button>
  </header>

  {#if store.resources.length === 0}
    <p class="empty">{strings.resources.empty}</p>
  {/if}

  {#each store.resources as entry (entry.threadId)}
    <section class="card" data-testid="resource-row" data-thread-id={entry.threadId}>
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
        <table>
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
                <td class="mono" title={record.commandLine ?? record.exe}>{record.exe}</td>
                <td class="mono">{record.pid}</td>
                <td class="mono">{time(record.startedAt)}</td>
                <td class="mono">{duration(record.startedAt, record.exitedAt)}</td>
                <td class="mono">{millis(record.cpuMs)}</td>
                <td class="mono">{bytes(record.peakMemoryBytes)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </section>
  {/each}
</div>

<style>
  section {
    margin-bottom: 10px;
    overflow: hidden;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 8px;
    border-bottom: 1px solid var(--border);
    background: var(--panel-alt);
  }

  .title {
    font-weight: 600;
    padding: 0;
  }

  .totals {
    margin-left: auto;
    font-size: 11px;
  }

  .confirm {
    color: var(--danger);
    font-size: 11px;
  }
</style>
