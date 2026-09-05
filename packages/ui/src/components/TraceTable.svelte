<script lang="ts">
  import type { ProcessRecord, TraceCapability } from '@boite/contracts';
  import { bytes, duration, millis, time } from '../lib/format';
  import { strings } from '../lib/strings';

  let {
    records,
    capability
  }: { records: ProcessRecord[]; capability: TraceCapability | null } = $props();
</script>

<div class="trace">
  {#if capability}
    <p class="note">
      <span class="mode mono">{capability.os} / {capability.mode}</span>
      {capability.note}
    </p>
  {/if}

  {#if records.length === 0}
    <p class="empty">{strings.trace.empty}</p>
  {:else}
    <table>
      <thead>
        <tr>
          <th>{strings.trace.exe}</th>
          <th>{strings.trace.pid}</th>
          <th>{strings.trace.started}</th>
          <th>{strings.trace.duration}</th>
          <th>{strings.trace.cpu}</th>
          <th>{strings.trace.memory}</th>
          <th>{strings.trace.exit}</th>
        </tr>
      </thead>
      <tbody>
        {#each records as record (record.pid)}
          <tr class:live={record.exitedAt === null}>
            <td class="mono exe" title={record.commandLine ?? record.exe}>{record.exe}</td>
            <td class="mono">{record.pid}</td>
            <td class="mono">{time(record.startedAt)}</td>
            <td class="mono">{duration(record.startedAt, record.exitedAt)}</td>
            <td class="mono">{millis(record.cpuMs)}</td>
            <td class="mono">{bytes(record.peakMemoryBytes)}</td>
            <td class="mono">
              {#if record.exitedAt === null}
                <span class="running">{strings.trace.live}</span>
              {:else}
                {record.exitCode ?? strings.common.unknown}
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .trace {
    padding: 10px 14px;
    overflow: auto;
    height: 100%;
  }

  .note {
    margin: 0 0 10px;
    color: var(--muted);
    border-left: 2px solid var(--border-strong);
    padding-left: 8px;
  }

  .mode {
    color: var(--accent);
    margin-right: 6px;
  }

  .exe {
    max-width: 320px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .running {
    color: var(--ok);
  }

  tr.live td {
    background: var(--panel-alt);
  }
</style>
